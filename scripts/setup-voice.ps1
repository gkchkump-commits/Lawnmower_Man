<#
.SYNOPSIS
  Lawnmower Man - set up the local GPU voice server (Windows PowerShell 5.1+ / PowerShell 7).

.DESCRIPTION
  Creates voice\.venv with Python 3.12 (3.11 works), installs faster-whisper + Kokoro with the
  CUDA wheels that support RTX 50-series (Blackwell, sm_120):
    * CTranslate2 >= 4.7 + the nvidia-cublas-cu12 (12.9) wheel for speech recognition,
    * onnxruntime-gpu >= 1.27 (CUDA 13 build with native sm_120 kernels) + CUDA 13 runtime,
      cuBLAS and cuDNN wheels for the Kokoro voice,
  verifies CUDA, downloads the models and runs a smoke test. Safe to re-run; no admin needed.
  Nothing is installed system-wide and no CUDA Toolkit is required - only the NVIDIA driver
  (R570+ for RTX 50-series; R580+ so the voice can use CUDA 13).

  Run from a PowerShell prompt in the repository (or the app's resources) folder:
    powershell -ExecutionPolicy Bypass -File scripts\setup-voice.ps1
    powershell -ExecutionPolicy Bypass -File scripts\setup-voice.ps1 -Cpu

  Installed app (resources\app.asar next to resources\voice): the installer replaces the install
  folder on every update, so the venv goes to %LOCALAPPDATA%\LawnmowerMan\voice\.venv and the
  models to %LOCALAPPDATA%\LawnmowerMan\voice\models instead (the app looks there).
  Quit Lawnmower Man before re-running this script: the running voice server locks venv files.

.PARAMETER Cpu
  CPU-only install (no NVIDIA downloads).
.PARAMETER NoModels
  Do not download models now (they download on first use instead).
.PARAMETER TorchTts
  Also install the optional PyTorch Kokoro backend (torch cu128 from download.pytorch.org, ~3 GB).
.PARAMETER Misaki
  Also install misaki, Kokoro's English G2P (pulls spaCy).
.PARAMETER Python
  Python interpreter to build the venv with (default: py -3.12, then python3.12 / python, then 3.11).
.PARAMETER Recreate
  Delete and rebuild the venv.
.PARAMETER SttModel
  Whisper model to pre-download and smoke-test (default large-v3-turbo).
.PARAMETER ModelsDir
  Model cache directory (default voice\models - or %LOCALAPPDATA%\LawnmowerMan\voice\models for an
  installed app - or $env:LAWNMOWER_VOICE_MODELS). The choice is recorded in the venv, so the app
  and later re-runs of this script use it too.
.PARAMETER SkipSmoke
  Skip the final load-and-run smoke test.
.PARAMETER PauseAtEnd
  Wait for Enter before the window closes (the app opens this script in its own console).
.PARAMETER StatusFile
  Write the result as JSON to this file when done ({ok, error, voiceHome, venv, python, ...});
  the app watches it to start the new voice server as soon as the setup has finished.
.PARAMETER CheckOnly
  Only report where the voice would be installed (and which Python would be used), then exit.
  Changes nothing; used by the app's packaged smoke test.
.PARAMETER Yes
  Answer yes to questions (install Python 3.12 with winget when it is missing).
#>
[CmdletBinding()]
param(
  [switch]$Cpu,
  [switch]$NoModels,
  [switch]$TorchTts,
  [switch]$Misaki,
  [string]$Python = '',
  [switch]$Recreate,
  [string]$SttModel = 'large-v3-turbo',
  [string]$ModelsDir = '',
  [switch]$SkipSmoke,
  [switch]$PauseAtEnd,
  [string]$StatusFile = '',
  [switch]$CheckOnly,
  [switch]$Yes
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$OnWindows = $true
if (Test-Path variable:IsWindows) { $OnWindows = [bool]$IsWindows }

try { $Host.UI.RawUI.WindowTitle = 'Lawnmower Man - local voice setup' } catch { }

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir
$VoiceDir = Join-Path $Root 'voice'
# Installed app: resources\app.asar sits next to resources\voice. The installer deletes the whole
# install folder on every update/uninstall (and Program Files is not writable), so the venv, the
# models and a writable copy of the package (pip writes build metadata next to it) go to a
# per-user folder. Must match electron/voice-sidecar.js packagedVoiceHome().
$Packaged = Test-Path -LiteralPath (Join-Path $Root 'app.asar')
if ($Packaged) {
  $base = $env:LOCALAPPDATA
  if (-not $base) { $base = Join-Path (Join-Path $HOME 'AppData') 'Local' }
  $VoiceHome = Join-Path (Join-Path $base 'LawnmowerMan') 'voice'
  $Venv = Join-Path $VoiceHome '.venv'
  $PkgDir = Join-Path $VoiceHome 'src'
} else {
  $VoiceHome = $VoiceDir
  $Venv = Join-Path $VoiceDir '.venv'
  $PkgDir = $VoiceDir
}
# The models folder the app should use is recorded here (read by lawnmower_voice.config).
$Pointer = Join-Path $Venv 'lawnmower-models-dir.txt'
if ($OnWindows) { $VenvPy = Join-Path (Join-Path $Venv 'Scripts') 'python.exe' } else { $VenvPy = Join-Path (Join-Path $Venv 'bin') 'python' }
$OrtGpuSpec = 'onnxruntime-gpu[cuda,cudnn]>=1.27,<2'
$OrtGpuPlain = 'onnxruntime-gpu>=1.27,<2'
$TorchIndexGpu = 'https://download.pytorch.org/whl/cu128'
$TorchIndexCpu = 'https://download.pytorch.org/whl/cpu'
if (-not $ModelsDir -and $env:LAWNMOWER_VOICE_MODELS) { $ModelsDir = $env:LAWNMOWER_VOICE_MODELS }
if (-not $ModelsDir -and (Test-Path -LiteralPath $Pointer)) {
  # chosen on an earlier run (-ModelsDir); keep using it
  $ModelsDir = ([System.IO.File]::ReadAllText($Pointer)).Trim()
}
if (-not $ModelsDir -and $Packaged) { $ModelsDir = Join-Path $VoiceHome 'models' }

function Write-Step([string]$Text) { Write-Host ''; Write-Host ('==> ' + $Text) -ForegroundColor Cyan }
function Write-Warn([string]$Text) { Write-Host ('WARNING: ' + $Text) -ForegroundColor Yellow }

# Can we ask the user something? (not when input is piped, e.g. tests or CI)
function Test-CanAsk {
  try { if ([Console]::IsInputRedirected) { return $false } } catch { return $false }
  return [Environment]::UserInteractive
}

# Yes/no question; the default answer is yes (Enter). -Yes answers yes without asking.
function Read-YesNo([string]$Question) {
  if ($Yes) { Write-Host ($Question + ' [Y/n] y (-Yes)'); return $true }
  if (-not (Test-CanAsk)) { return $false }
  $answer = Read-Host ($Question + ' [Y/n]')
  if ($null -eq $answer) { return $false }
  $a = $answer.Trim().ToLowerInvariant()
  return ($a -eq '' -or $a -eq 'y' -or $a -eq 'yes')
}

# Result for the app (and for -CheckOnly): one JSON object, UTF-8 without BOM.
$script:Result = [ordered]@{ ok = $false; check = [bool]$CheckOnly; cpu = [bool]$Cpu; packaged = $Packaged; voiceHome = $VoiceHome; venv = $Venv; python = ''; error = '' }
function Write-Status {
  if (-not $StatusFile) { return }
  try {
    $script:Result['finishedAt'] = (Get-Date).ToUniversalTime().ToString('o')
    $json = $script:Result | ConvertTo-Json -Compress
    $dir = Split-Path -Parent $StatusFile
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    [System.IO.File]::WriteAllText($StatusFile, $json, (New-Object System.Text.UTF8Encoding $false))
  } catch {
    Write-Warn ('Could not write the status file {0}: {1}' -f $StatusFile, $_.Exception.Message)
  }
}

# End the script: report to the app, keep the window open if asked, exit with the code.
function Exit-Setup([int]$Code) {
  Write-Status
  if ($PauseAtEnd -and (Test-CanAsk)) {
    Write-Host ''
    if ($Code -eq 0) { Write-Host 'Lawnmower Man starts the local voice by itself now.' -ForegroundColor Green }
    [void](Read-Host 'Press Enter to close this window')
  }
  exit $Code
}

# Run a native command; throw if it fails. Simple function on purpose: arguments such as "-m"
# must reach the program untouched (an advanced function would try to bind them).
function Invoke-Checked {
  $exe = $args[0]
  $rest = @()
  if ($args.Count -gt 1) { $rest = $args[1..($args.Count - 1)] }
  & $exe @rest
  if ($LASTEXITCODE -ne 0) { throw ('Command failed (exit {0}): {1} {2}' -f $LASTEXITCODE, $exe, ($rest -join ' ')) }
}

# Version and real path of a Python interpreter, or $null (also for the Microsoft Store stub).
function Get-PyInfo([string]$Exe, [string[]]$PreArgs) {
  if (-not (Get-Command $Exe -ErrorAction SilentlyContinue)) { return $null }
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $code = "import sys; print('%d.%d|%s' % (sys.version_info[0], sys.version_info[1], sys.executable))"
    $out = & $Exe @PreArgs -c $code 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $out) { return $null }
    $line = ([string](@($out)[-1])).Trim()
    $parts = $line.Split('|', 2)
    if ($parts.Count -ne 2) { return $null }
    return [pscustomobject]@{ Version = $parts[0]; Path = $parts[1] }
  } catch {
    return $null
  } finally {
    $ErrorActionPreference = $old
  }
}

function Find-Python {
  if ($Python) {
    $info = Get-PyInfo $Python @()
    if (-not $info) { throw ("'{0}' is not a working Python interpreter." -f $Python) }
    return $info
  }
  $candidates = @(
    @('py', @('-3.12')), @('python3.12', @()), @('python', @()), @('python3', @()),
    @('py', @('-3.11')), @('python3.11', @()), @('py', @('-3.10')), @('python3.10', @())
  )
  # Per-user installs even when PATH is stale (winget just installed one, and this window still
  # has the old PATH): winget --scope user / python.org "just me" (Programs\Python\Python312),
  # and the Python install manager (Python\pythoncore-3.12-64).
  if ($OnWindows -and $env:LOCALAPPDATA) {
    foreach ($v in @('3.12', '3.11')) {
      foreach ($rel in @(('Programs\Python\Python{0}\python.exe' -f $v.Replace('.', '')), ('Python\pythoncore-{0}-64\python.exe' -f $v))) {
        $exe = Join-Path $env:LOCALAPPDATA $rel
        if (Test-Path -LiteralPath $exe) { $candidates += , @($exe, @()) }
      }
    }
  }
  $found = @{}
  foreach ($c in $candidates) {
    $info = Get-PyInfo $c[0] $c[1]
    if ($info -and -not $found.ContainsKey($info.Version)) { $found[$info.Version] = $info }
    if ($found.ContainsKey('3.12')) { break }
  }
  foreach ($v in @('3.12', '3.11', '3.10')) { if ($found.ContainsKey($v)) { return $found[$v] } }
  return $null
}

# Re-read PATH from the registry (an installer just changed it; this window still has the old one).
function Update-PathFromRegistry {
  $parts = @()
  foreach ($scope in @('Machine', 'User')) {
    $v = [Environment]::GetEnvironmentVariable('Path', $scope)
    if ($v) { $parts += $v.Split(';') }
  }
  $have = @{}
  $merged = @()
  foreach ($d in (@(([string]$env:Path).Split(';')) + $parts)) {
    if (-not $d) { continue }
    $k = $d.TrimEnd([char]92).ToLowerInvariant()
    if ($have.ContainsKey($k)) { continue }
    $have[$k] = $true
    $merged += $d
  }
  $env:Path = $merged -join ';'
}

# Python 3.12 is missing: offer to install it with winget (per user, no admin), else explain.
function Install-Python {
  if (-not $OnWindows) { return $null }
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $winget) {
    Write-Host ''
    Write-Host 'Python 3.12 is needed, and winget (App Installer) is not available on this PC to install it.' -ForegroundColor Yellow
    Write-Host '  Download Python 3.12 from https://www.python.org/downloads/windows/'
    Write-Host '  (tick "Add python.exe to PATH" in the installer), then run this setup again.'
    return $null
  }
  Write-Host ''
  Write-Host 'Python 3.12 was not found. It can be installed now with winget, for this user only (no admin):'
  Write-Host '    winget install -e --id Python.Python.3.12 --scope user'
  Write-Host '  (this accepts the winget source and Python license agreements)'
  if (-not (Read-YesNo 'Install Python 3.12 now?')) {
    Write-Host 'Not installing Python. Install Python 3.12 (winget or https://www.python.org/downloads/windows/), then run this setup again.'
    return $null
  }
  Write-Step 'Installing Python 3.12 with winget'
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  & $winget.Source install -e --id Python.Python.3.12 --scope user --accept-package-agreements --accept-source-agreements
  $code = $LASTEXITCODE
  $ErrorActionPreference = $old
  if ($code -ne 0) { Write-Warn ('winget exited with code {0}; checking whether Python is usable anyway.' -f $code) }
  Update-PathFromRegistry
  return (Find-Python)
}

# Clean up a folder argument: Windows PowerShell 5.1 turns  -ModelsDir 'D:\AI Models\'  into
# D:\AI Models"  (a trailing backslash escapes the closing quote), so drop trailing quotes and
# separators, then make it absolute (relative to the current PowerShell location).
function Get-CleanDir([string]$Dir) {
  $d = $Dir.Trim().Trim('"').Trim()
  $t = $d.TrimEnd([char[]]@([char]92, [char]47))
  if ($t -match '^[A-Za-z]:$') { $t = $t + [string][char]92 }
  if ($t) { $d = $t }
  if (-not $d) { return '' }
  return $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($d)
}

# A running voice server (the app) has DLLs and .pyd files of the venv loaded: deleting or
# upgrading them fails halfway and leaves a broken venv. Refuse before touching anything.
function Assert-VoiceNotRunning {
  if (-not $OnWindows -or -not (Test-Path -LiteralPath $Venv)) { return }
  $procs = @()
  try {
    $prefix = (Resolve-Path -LiteralPath $Venv).ProviderPath.TrimEnd([char]92) + [string][char]92
    $procs = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | Where-Object {
        $_.ProcessId -ne $PID -and (
          ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) -or
          ($_.CommandLine -and $_.CommandLine -match 'lawnmower_voice(?![.](doctor|download))'))
      })
  } catch {
    return # no CIM (e.g. restricted shell): nothing to check with
  }
  if ($procs.Count -gt 0) {
    $ids = ($procs | ForEach-Object { $_.ProcessId }) -join ', '
    throw ("The voice server is running (process {0}) and uses files in {1}.`n  Quit Lawnmower Man (tray > Quit), then run this script again." -f $ids, $Venv)
  }
}

# Replace the venv without ever leaving a half-deleted one: move it aside first (fails cleanly
# if something still uses it), then delete the old copy.
function Remove-Venv {
  Assert-VoiceNotRunning
  $leaf = '{0}.old-{1}' -f (Split-Path -Leaf $Venv), (Get-Date -Format 'yyyyMMddHHmmss')
  $aside = Join-Path (Split-Path -Parent $Venv) $leaf
  try {
    Rename-Item -LiteralPath $Venv -NewName $leaf -ErrorAction Stop
  } catch {
    throw ("Could not replace the venv at {0} ({1}).`n  Quit Lawnmower Man (tray > Quit), then run this script again." -f $Venv, $_.Exception.Message)
  }
  try {
    Remove-Item -Recurse -Force -LiteralPath $aside -ErrorAction Stop
  } catch {
    Write-Warn ('Could not delete the old venv {0} ({1}); delete it later.' -f $aside, $_.Exception.Message)
  }
}

function Get-LastJson($Lines) {
  $json = $null
  foreach ($l in @($Lines)) { $s = [string]$l; if ($s.TrimStart().StartsWith('{')) { $json = $s } }
  if (-not $json) { return $null }
  return ($json | ConvertFrom-Json)
}

try {
  if (-not (Test-Path -LiteralPath (Join-Path $VoiceDir 'pyproject.toml'))) { throw ("voice\pyproject.toml not found next to this script ({0})." -f $VoiceDir) }
  if ($ModelsDir) { $ModelsDir = Get-CleanDir $ModelsDir }
  if ($Packaged) { Write-Host ('Installed app detected: voice files go to {0}' -f $VoiceHome) }

  if ($CheckOnly) {
    $found = Find-Python
    if ($found) { $script:Result['python'] = $found.Path }
    Write-Host ('Voice folder: {0}' -f $VoiceHome)
    Write-Host ('Venv:         {0}' -f $Venv)
    $pyText = 'not found'; if ($found) { $pyText = ('{0} (Python {1})' -f $found.Path, $found.Version) }
    Write-Host ('Python:       {0}' -f $pyText)
    $script:Result['ok'] = $true
    Exit-Setup 0
  }

  # -------------------------------------------------------------------------------------------
  Write-Step 'Looking for Python 3.12'
  $py = Find-Python
  if (-not $py) { $py = Install-Python }
  if (-not $py) {
    $script:Result['error'] = 'python-missing'
    throw ("Python 3.12 was not found. Install it, then re-run this script:`n" +
      "    winget install -e --id Python.Python.3.12 --scope user`n" +
      "  or download it from https://www.python.org/downloads/windows/ (tick 'Add python.exe to PATH').`n" +
      "  The 'python' command that opens the Microsoft Store does not count.")
  }
  $script:Result['python'] = $py.Path
  switch ($py.Version) {
    '3.12' { }
    '3.11' { Write-Warn ('Using Python 3.11 ({0}). It works; 3.12 is recommended.' -f $py.Path) }
    '3.10' { Write-Warn ('Using Python 3.10 ({0}): the GPU build of onnxruntime needs >= 3.11, so the voice (TTS) will run on the CPU. Install Python 3.12 for full GPU support.' -f $py.Path) }
    default { throw ('Python {0} at {1} is not supported (need 3.10-3.12; 3.12 recommended).' -f $py.Version, $py.Path) }
  }
  Write-Host ('Using {0} (Python {1})' -f $py.Path, $py.Version)

  if ($OnWindows) {
    $sys32 = Join-Path $env:WINDIR 'System32'
    if (-not (Test-Path (Join-Path $sys32 'msvcp140.dll')) -or -not (Test-Path (Join-Path $sys32 'vcruntime140_1.dll'))) {
      Write-Warn 'The Microsoft Visual C++ Redistributable (x64) seems to be missing; CTranslate2/onnxruntime need it.'
      Write-Warn '  Install: winget install -e --id Microsoft.VCRedist.2015+.x64   (or https://aka.ms/vs/17/release/vc_redist.x64.exe)'
    }
  }

  # -------------------------------------------------------------------------------------------
  Write-Step ('Preparing the virtual environment ({0})' -f $Venv)
  if (Test-Path -LiteralPath $Venv) {
    Assert-VoiceNotRunning
    $have = $null
    if (Test-Path -LiteralPath $VenvPy) { $have = Get-PyInfo $VenvPy @() }
    if ($Recreate -or -not $have -or $have.Version -ne $py.Version) {
      $hv = 'broken'
      if ($have) { $hv = $have.Version }
      Write-Host ('Removing the existing venv (Python {0}; want {1})' -f $hv, $py.Version)
      Remove-Venv
    } else {
      Write-Host ('Reusing the existing venv (Python {0})' -f $have.Version)
    }
  }
  if (-not (Test-Path -LiteralPath $VenvPy)) {
    $venvParent = Split-Path -Parent $Venv
    if (-not (Test-Path -LiteralPath $venvParent)) { New-Item -ItemType Directory -Force -Path $venvParent | Out-Null }
    Invoke-Checked $py.Path -m venv $Venv
  }
  if ($ModelsDir) {
    # where the app's voice server finds the models (no BOM: Python reads it as UTF-8)
    [System.IO.File]::WriteAllText($Pointer, $ModelsDir, (New-Object System.Text.UTF8Encoding $false))
    Write-Host ('Models folder: {0}' -f $ModelsDir)
  }
  Invoke-Checked $VenvPy -m pip install --upgrade --disable-pip-version-check pip setuptools wheel

  if ($Packaged) {
    # pip writes build metadata next to the package: install from a writable copy
    if (Test-Path -LiteralPath $PkgDir) { Remove-Item -Recurse -Force -LiteralPath $PkgDir }
    New-Item -ItemType Directory -Force -Path $PkgDir | Out-Null
    Get-ChildItem -LiteralPath $VoiceDir -Force | Copy-Item -Recurse -Force -Destination $PkgDir
  }

  if ($OnWindows) {
    try {
      $drive = (Get-Item -LiteralPath (Split-Path -Parent $Venv)).PSDrive
      if ($drive -and $drive.Free -and $drive.Free -lt 8GB) {
        Write-Warn ('Only {0:N1} GB free on drive {1}:; the GPU install needs ~5 GB plus ~2.5 GB of models.' -f ($drive.Free / 1GB), $drive.Name)
      }
    } catch { }
  }

  # -------------------------------------------------------------------------------------------
  if ($Cpu) {
    Write-Step 'Installing the CPU voice stack'
    Invoke-Checked $VenvPy -m pip install --disable-pip-version-check -e ('{0}[cpu]' -f $PkgDir)
    $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    & $VenvPy -m pip show onnxruntime-gpu *> $null
    $hasGpuOrt = ($LASTEXITCODE -eq 0)
    $ErrorActionPreference = $old
    if ($hasGpuOrt) {
      Invoke-Checked $VenvPy -m pip uninstall -y onnxruntime-gpu onnxruntime
      Invoke-Checked $VenvPy -m pip install --disable-pip-version-check --force-reinstall --no-deps 'onnxruntime>=1.20'
    }
  }
  if (-not $Cpu -and $OnWindows -and -not (Get-Command nvidia-smi -ErrorAction SilentlyContinue)) {
    Write-Warn 'nvidia-smi not found: no NVIDIA GPU driver is installed (R570+ for RTX 50-series, R580+ for GPU text-to-speech).'
    if (Read-YesNo 'Install the CPU version instead (smaller; no NVIDIA downloads)?') {
      $Cpu = $true
      $script:Result['cpu'] = $true
      Write-Step 'Installing the CPU voice stack'
      Invoke-Checked $VenvPy -m pip install --disable-pip-version-check -e ('{0}[cpu]' -f $PkgDir)
    }
  }
  if (-not $Cpu) {
    Write-Step 'Installing the NVIDIA GPU voice stack (CUDA 12.8+/13 wheels for RTX 50-series; several GB)'
    if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
      $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
      & nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader
      $ErrorActionPreference = $old
    } else {
      Write-Warn 'nvidia-smi not found: is the NVIDIA driver installed? (R570+ for RTX 50-series, R580+ for GPU text-to-speech)'
    }
    Invoke-Checked $VenvPy -m pip install --disable-pip-version-check -e ('{0}[gpu]' -f $PkgDir)
    if ($py.Version -ne '3.10') {
      # kokoro-onnx and faster-whisper depend on the CPU 'onnxruntime' wheel, which shares the
      # 'onnxruntime' folder with onnxruntime-gpu. Remove both, then reinstall the GPU wheel.
      Write-Step 'Making onnxruntime-gpu the only onnxruntime'
      $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
      & $VenvPy -m pip uninstall -y onnxruntime onnxruntime-gpu *> $null
      $ErrorActionPreference = $old
      Invoke-Checked $VenvPy -m pip install --disable-pip-version-check --force-reinstall --no-deps $OrtGpuPlain
      Invoke-Checked $VenvPy -m pip install --disable-pip-version-check $OrtGpuSpec
    }
  }

  if ($Misaki) {
    Write-Step 'Installing misaki (English G2P)'
    Invoke-Checked $VenvPy -m pip install --disable-pip-version-check -e ('{0}[misaki]' -f $PkgDir)
  }

  if ($TorchTts) {
    $idx = $TorchIndexGpu
    if ($Cpu) { $idx = $TorchIndexCpu }
    Write-Step ('Installing PyTorch from {0} and the kokoro package (optional backend)' -f $idx)
    Invoke-Checked $VenvPy -m pip install --disable-pip-version-check torch --index-url $idx
    Invoke-Checked $VenvPy -m pip install --disable-pip-version-check -e ('{0}[torch]' -f $PkgDir)
  }

  # -------------------------------------------------------------------------------------------
  Write-Step 'Checking the installation'
  $device = 'auto'
  if ($Cpu) { $device = 'cpu' }
  $doctorOut = & $VenvPy -m lawnmower_voice.doctor --device $device --human
  if ($LASTEXITCODE -ne 0) { throw 'The voice package does not import. See the messages above.' }
  $report = Get-LastJson $doctorOut

  $modelArgs = @()
  if ($ModelsDir) { $modelArgs = @('--models-dir', $ModelsDir) }
  $modelsOk = $true
  if (-not $NoModels) {
    Write-Step ('Downloading models (Whisper {0} + base.en fallback, Kokoro-82M); first time only' -f $SttModel)
    $dlArgs = @('-m', 'lawnmower_voice.download', '--stt-model', $SttModel) + $modelArgs
    & $VenvPy @dlArgs | Out-Null
    if ($LASTEXITCODE -ne 0) {
      $modelsOk = $false
      Write-Warn 'Some models could not be downloaded (see above). They will be fetched on first use; re-run this script to retry.'
    }
  }

  $smoke = $null
  if (-not $NoModels -and -not $SkipSmoke -and $modelsOk) {
    Write-Step 'Smoke test: loading both engines and running one request each (first GPU run compiles kernels; can take a minute)'
    $smokeArgs = @('-m', 'lawnmower_voice.doctor', '--smoke', '--device', $device, '--human', '--stt-model', $SttModel) + $modelArgs
    $smokeOut = & $VenvPy @smokeArgs
    if ($LASTEXITCODE -ne 0) { Write-Warn 'Smoke test failed to run.' } else { $smoke = Get-LastJson $smokeOut }
  }

  # -------------------------------------------------------------------------------------------
  Write-Step 'Summary'
  if ($report) {
    $s = $report.summary
    $gpuName = 'none detected'
    if ($s.gpu) { $gpuName = $s.gpu }
    Write-Host ('  Python:         {0} ({1})' -f $report.python, $report.executable)
    Write-Host ('  GPU:            {0}' -f $gpuName)
    if (-not $Cpu) {
      $sttTxt = 'NOT available (CPU fallback)'; if ($s.sttGpuReady) { $sttTxt = 'ready' }
      $ttsTxt = 'NOT available (CPU fallback)'; if ($s.ttsGpuReady) { $ttsTxt = 'ready' }
      Write-Host ('  STT on GPU:     {0}  [CTranslate2]' -f $sttTxt)
      Write-Host ('  TTS on GPU:     {0}  [onnxruntime CUDA]' -f $ttsTxt)
    }
    if ($smoke) {
      foreach ($k in @('stt', 'tts')) {
        $r = $smoke.smoke.$k
        if ($r.ok) {
          $ct = ''
          if ($r.status.PSObject.Properties.Name -contains 'computeType') { $ct = $r.status.computeType }
          Write-Host ('  {0} smoke test: OK on {1} {2}  (load {3} ms, run {4} ms)' -f $k.ToUpper(), $r.status.device, $ct, $r.loadMs, $r.runMs)
        } else {
          Write-Host ('  {0} smoke test: FAILED - {1}' -f $k.ToUpper(), $r.error) -ForegroundColor Yellow
        }
      }
    }
    foreach ($w in @($s.warnings)) { if ($w) { Write-Warn $w } }
  }
  Write-Host ''
  Write-Host 'Done. The app starts the voice server automatically (or use tray > Restart voice).'
  Write-Host ('Manual run:   "{0}" -m lawnmower_voice --port 8765 --token test --preload' -f $VenvPy)
  Write-Host ('Fake engines: "{0}" -m lawnmower_voice --fake' -f $VenvPy)
  Write-Host ('Diagnostics:  "{0}" -m lawnmower_voice.doctor --smoke --human' -f $VenvPy)
  $script:Result['ok'] = $true
  $script:Result['cpu'] = [bool]$Cpu
  Exit-Setup 0
} catch {
  Write-Host ''
  Write-Host ('ERROR: ' + $_.Exception.Message) -ForegroundColor Red
  if (-not $script:Result['error']) { $script:Result['error'] = $_.Exception.Message }
  Exit-Setup 1
}
