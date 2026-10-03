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
  Delete and rebuild voice\.venv.
.PARAMETER SttModel
  Whisper model to pre-download (default large-v3-turbo).
.PARAMETER ModelsDir
  Model cache directory (default voice\models, or $env:LAWNMOWER_VOICE_MODELS).
.PARAMETER SkipSmoke
  Skip the final load-and-run smoke test.
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
  [switch]$SkipSmoke
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$OnWindows = $true
if (Test-Path variable:IsWindows) { $OnWindows = [bool]$IsWindows }

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir
$VoiceDir = Join-Path $Root 'voice'
$Venv = Join-Path $VoiceDir '.venv'
if ($OnWindows) { $VenvPy = Join-Path (Join-Path $Venv 'Scripts') 'python.exe' } else { $VenvPy = Join-Path (Join-Path $Venv 'bin') 'python' }
$OrtGpuSpec = 'onnxruntime-gpu[cuda,cudnn]>=1.27,<2'
$OrtGpuPlain = 'onnxruntime-gpu>=1.27,<2'
$TorchIndexGpu = 'https://download.pytorch.org/whl/cu128'
$TorchIndexCpu = 'https://download.pytorch.org/whl/cpu'
if (-not $ModelsDir -and $env:LAWNMOWER_VOICE_MODELS) { $ModelsDir = $env:LAWNMOWER_VOICE_MODELS }

function Write-Step([string]$Text) { Write-Host ''; Write-Host ('==> ' + $Text) -ForegroundColor Cyan }
function Write-Warn([string]$Text) { Write-Host ('WARNING: ' + $Text) -ForegroundColor Yellow }

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
  $found = @{}
  foreach ($c in $candidates) {
    $info = Get-PyInfo $c[0] $c[1]
    if ($info -and -not $found.ContainsKey($info.Version)) { $found[$info.Version] = $info }
    if ($found.ContainsKey('3.12')) { break }
  }
  foreach ($v in @('3.12', '3.11', '3.10')) { if ($found.ContainsKey($v)) { return $found[$v] } }
  return $null
}

function Get-LastJson($Lines) {
  $json = $null
  foreach ($l in @($Lines)) { $s = [string]$l; if ($s.TrimStart().StartsWith('{')) { $json = $s } }
  if (-not $json) { return $null }
  return ($json | ConvertFrom-Json)
}

try {
  if (-not (Test-Path (Join-Path $VoiceDir 'pyproject.toml'))) { throw ("voice\pyproject.toml not found next to this script ({0})." -f $VoiceDir) }

  # -------------------------------------------------------------------------------------------
  Write-Step 'Looking for Python 3.12'
  $py = Find-Python
  if (-not $py) {
    throw ("Python 3.12 was not found. Install it, then re-run this script:`n" +
      "    winget install -e --id Python.Python.3.12`n" +
      "  or download it from https://www.python.org/downloads/windows/ (tick 'Add python.exe to PATH').`n" +
      "  The 'python' command that opens the Microsoft Store does not count.")
  }
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
  if (Test-Path $Venv) {
    $have = $null
    if (Test-Path $VenvPy) { $have = Get-PyInfo $VenvPy @() }
    if ($Recreate -or -not $have -or $have.Version -ne $py.Version) {
      $hv = 'broken'
      if ($have) { $hv = $have.Version }
      Write-Host ('Removing the existing venv (Python {0}; want {1})' -f $hv, $py.Version)
      Remove-Item -Recurse -Force $Venv
    } else {
      Write-Host ('Reusing the existing venv (Python {0})' -f $have.Version)
    }
  }
  if (-not (Test-Path $VenvPy)) {
    Invoke-Checked $py.Path -m venv $Venv
  }
  Invoke-Checked $VenvPy -m pip install --upgrade --disable-pip-version-check pip setuptools wheel

  if ($OnWindows) {
    try {
      $drive = (Get-Item $VoiceDir).PSDrive
      if ($drive -and $drive.Free -and $drive.Free -lt 8GB) {
        Write-Warn ('Only {0:N1} GB free on drive {1}:; the GPU install needs ~5 GB plus ~2.5 GB of models.' -f ($drive.Free / 1GB), $drive.Name)
      }
    } catch { }
  }

  # -------------------------------------------------------------------------------------------
  if ($Cpu) {
    Write-Step 'Installing the CPU voice stack'
    Invoke-Checked $VenvPy -m pip install --disable-pip-version-check -e ('{0}[cpu]' -f $VoiceDir)
    $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    & $VenvPy -m pip show onnxruntime-gpu *> $null
    $hasGpuOrt = ($LASTEXITCODE -eq 0)
    $ErrorActionPreference = $old
    if ($hasGpuOrt) {
      Invoke-Checked $VenvPy -m pip uninstall -y onnxruntime-gpu onnxruntime
      Invoke-Checked $VenvPy -m pip install --disable-pip-version-check --force-reinstall --no-deps 'onnxruntime>=1.20'
    }
  } else {
    Write-Step 'Installing the NVIDIA GPU voice stack (CUDA 12.8+/13 wheels for RTX 50-series; several GB)'
    if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
      $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
      & nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader
      $ErrorActionPreference = $old
    } else {
      Write-Warn 'nvidia-smi not found: is the NVIDIA driver installed? (R570+ for RTX 50-series, R580+ for GPU text-to-speech)'
    }
    Invoke-Checked $VenvPy -m pip install --disable-pip-version-check -e ('{0}[gpu]' -f $VoiceDir)
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
    Invoke-Checked $VenvPy -m pip install --disable-pip-version-check -e ('{0}[misaki]' -f $VoiceDir)
  }

  if ($TorchTts) {
    $idx = $TorchIndexGpu
    if ($Cpu) { $idx = $TorchIndexCpu }
    Write-Step ('Installing PyTorch from {0} and the kokoro package (optional backend)' -f $idx)
    Invoke-Checked $VenvPy -m pip install --disable-pip-version-check torch --index-url $idx
    Invoke-Checked $VenvPy -m pip install --disable-pip-version-check -e ('{0}[torch]' -f $VoiceDir)
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
    $smokeArgs = @('-m', 'lawnmower_voice.doctor', '--smoke', '--device', $device, '--human') + $modelArgs
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
  Write-Host 'Done. The app starts the voice server automatically (Settings > Voice, or tray > Restart voice).'
  Write-Host ('Manual run:   "{0}" -m lawnmower_voice --port 8765 --token test --preload' -f $VenvPy)
  Write-Host ('Fake engines: "{0}" -m lawnmower_voice --fake' -f $VenvPy)
  Write-Host ('Diagnostics:  "{0}" -m lawnmower_voice.doctor --smoke --human' -f $VenvPy)
  exit 0
} catch {
  Write-Host ''
  Write-Host ('ERROR: ' + $_.Exception.Message) -ForegroundColor Red
  exit 1
}
