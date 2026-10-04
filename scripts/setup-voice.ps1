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
  Write the result as JSON to this file when done ({ok, error, errorTail, log, voiceHome, venv,
  python, ...}); the app watches it to start the new voice server as soon as the setup has finished.
  On a failure, error is the failed step plus the last lines of its output (pip prints its reason
  there), errorTail the same lines as a list, and log the full log of the run.
.PARAMETER CheckOnly
  Only report where the voice would be installed (and which Python would be used), then exit.
  Changes nothing; used by the app's packaged smoke test.
.PARAMETER Yes
  Answer yes to questions (install Python 3.12 with winget when it is missing).
.NOTES
  Every run (except -CheckOnly) writes its full output - each command, everything pip printed,
  the step headers and the summary - to <voice folder>\setup.log (setup.prev.log keeps the run
  before). That is the file to send when the setup fails.
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

# The switches this run was started with, for the log ("-Cpu -PauseAtEnd -StatusFile C:\...").
$FlagText = (@(foreach ($kv in $PSBoundParameters.GetEnumerator()) {
      if ($kv.Value -is [System.Management.Automation.SwitchParameter] -or $kv.Value -is [bool]) {
        if ([bool]$kv.Value) { '-' + $kv.Key }
      } else {
        '-{0} {1}' -f $kv.Key, $kv.Value
      }
    }) -join ' ')
if (-not $FlagText) { $FlagText = '(none)' }

# Python children (venv, pip, the doctor): UTF-8 output whatever the console code page is (a
# cp1252/cp437 console cannot encode every path or package message: pip would crash on it), and
# unbuffered, so their output shows up line by line while it is also written to the log. Run from
# a user's own PowerShell window (.\scripts\setup-voice.ps1) this is that session's process, so
# Exit-Setup puts the previous values back.
$script:PrevPythonEnv = @{}
foreach ($n in @('PYTHONUTF8', 'PYTHONIOENCODING', 'PYTHONUNBUFFERED', 'PIP_RETRIES', 'PIP_TIMEOUT')) { $script:PrevPythonEnv[$n] = [Environment]::GetEnvironmentVariable($n) }
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONUNBUFFERED = '1'
# The NVIDIA wheels are hundreds of MB: let pip ride out a slow or flaky connection (pip's own
# defaults are 5 retries and a 15 s timeout). A user's own values win.
if (-not $env:PIP_RETRIES) { $env:PIP_RETRIES = '10' }
if (-not $env:PIP_TIMEOUT) { $env:PIP_TIMEOUT = '60' }
$Utf8NoBom = New-Object System.Text.UTF8Encoding $false

$ScriptPath = $MyInvocation.MyCommand.Path
$ScriptDir = Split-Path -Parent $ScriptPath
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
# The full output of every run (the app's "Open setup log"; the previous run is kept as
# setup.prev.log). Must match electron/main.js (setup log path).
$SetupLog = Join-Path $VoiceHome 'setup.log'
$SetupLogPrev = Join-Path $VoiceHome 'setup.prev.log'
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

# --- setup log ---------------------------------------------------------------------------------
# One UTF-8 (no BOM) file per run, written line by line and shared for reading, so it can be
# opened while the setup runs and is complete up to the last line if the window is closed.
$script:LogWriter = $null

# Append one line to the setup log (no console output). Never fails the setup.
function Write-Log([string]$Text) {
  if ($null -eq $script:LogWriter) { return }
  try { $script:LogWriter.WriteLine($Text) } catch { }
}

# Console line that also goes to the log.
function Write-Info([string]$Text, [string]$Color = '') {
  if ($Color) { Write-Host $Text -ForegroundColor $Color } else { Write-Host $Text }
  Write-Log $Text
}

function Write-Step([string]$Text) { Write-Host ''; Write-Host ('==> ' + $Text) -ForegroundColor Cyan; Write-Log ''; Write-Log ('==> ' + $Text) }
function Write-Warn([string]$Text) { Write-Host ('WARNING: ' + $Text) -ForegroundColor Yellow; Write-Log ('WARNING: ' + $Text) }

# Start the log of this run: keep the previous one as setup.prev.log, write a header with what is
# needed to make sense of it (when, which script, which shell and Python, which switches).
function Start-SetupLog($PyInfo) {
  try {
    if (-not (Test-Path -LiteralPath $VoiceHome)) { New-Item -ItemType Directory -Force -Path $VoiceHome | Out-Null }
    if (Test-Path -LiteralPath $SetupLog) {
      try {
        if (Test-Path -LiteralPath $SetupLogPrev) { Remove-Item -LiteralPath $SetupLogPrev -Force -ErrorAction Stop }
        [System.IO.File]::Move($SetupLog, $SetupLogPrev)
      } catch { } # could not rotate (e.g. open in an editor that locks it): append to it instead
    }
    $fs = New-Object System.IO.FileStream($SetupLog, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
    $w = New-Object System.IO.StreamWriter($fs, $Utf8NoBom)
    $w.AutoFlush = $true
    $script:LogWriter = $w
  } catch {
    $script:LogWriter = $null
    Write-Warn ('Could not write the setup log {0}: {1}' -f $SetupLog, $_.Exception.Message)
    return
  }
  $script:Result['log'] = $SetupLog
  $version = '?'
  try {
    $m = [regex]::Match([System.IO.File]::ReadAllText((Join-Path $VoiceDir 'pyproject.toml')), '(?m)^version\s*=\s*"([^"]+)"')
    if ($m.Success) { $version = $m.Groups[1].Value }
  } catch { }
  $hash = ''
  try { $hash = ', sha256 ' + (Get-FileHash -LiteralPath $ScriptPath -Algorithm SHA256).Hash.Substring(0, 12).ToLowerInvariant() } catch { }
  $shell = 'PowerShell {0}' -f $PSVersionTable.PSVersion
  if ($PSVersionTable.ContainsKey('PSEdition')) { $shell += (' ({0})' -f $PSVersionTable.PSEdition) }
  $now = Get-Date
  $pyText = 'not found yet'
  if ($PyInfo) { $pyText = '{0} (Python {1})' -f $PyInfo.Path, $PyInfo.Version }
  if ($Python) { $pyText += (' [-Python {0}]' -f $Python) }
  $where = 'repository'
  if ($Packaged) { $where = 'installed app' }
  $models = 'default'
  if ($ModelsDir) { $models = $ModelsDir }
  Write-Log '=== Lawnmower Man - local voice setup ==='
  Write-Log ('Started:  {0} (UTC {1})' -f $now.ToString('yyyy-MM-dd HH:mm:ss zzz'), $now.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))
  Write-Log ('Script:   {0} (lawnmower-voice {1}{2})' -f $ScriptPath, $version, $hash)
  Write-Log ('Shell:    {0} on {1}' -f $shell, [Environment]::OSVersion.VersionString)
  Write-Log ('Flags:    {0}' -f $FlagText)
  Write-Log ('Python:   {0}' -f $pyText)
  Write-Log ('Voice:    {0} ({1})' -f $VoiceHome, $where)
  Write-Log ('Venv:     {0}' -f $Venv)
  Write-Log ('Models:   {0}' -f $models)
  Write-Log ('Log:      {0} (previous run: {1})' -f $SetupLog, $SetupLogPrev)
}

function Stop-SetupLog {
  if ($null -eq $script:LogWriter) { return }
  try { $script:LogWriter.Dispose() } catch { }
  $script:LogWriter = $null
}

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
# error: the message (for a failed command: the command, then the last lines of its output);
# errorTail: those lines as a list; log: the setup log of this run ('' when there is none).
$script:Result = [ordered]@{ ok = $false; check = [bool]$CheckOnly; cpu = [bool]$Cpu; packaged = $Packaged; voiceHome = $VoiceHome; venv = $Venv; python = ''; error = ''; errorTail = @(); log = '' }
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
  $outcome = 'OK'
  if ($Code -ne 0) { $outcome = 'FAILED' }
  Write-Log ''
  Write-Log ('Finished: {0} (exit {1}) at {2}' -f $outcome, $Code, (Get-Date).ToString('yyyy-MM-dd HH:mm:ss zzz'))
  try { Write-Log ('Status:   ' + ($script:Result | ConvertTo-Json -Compress)) } catch { }
  Stop-SetupLog
  # no Python runs after this: the caller's session gets its environment back (a variable that was
  # not set is removed; [Environment]::SetEnvironmentVariable would get '' from PowerShell for $null)
  foreach ($n in @($script:PrevPythonEnv.Keys)) {
    $v = $script:PrevPythonEnv[$n]
    try {
      if ($null -eq $v) { Remove-Item -LiteralPath ('Env:' + $n) -ErrorAction SilentlyContinue } else { Set-Item -LiteralPath ('Env:' + $n) -Value $v }
    } catch { }
  }
  if ($PauseAtEnd -and (Test-CanAsk)) {
    Write-Host ''
    if ($Code -eq 0) { Write-Host 'Lawnmower Man starts the local voice by itself now.' -ForegroundColor Green }
    [void](Read-Host 'Press Enter to close this window')
  }
  exit $Code
}

# How many non-empty output lines of a failed command go into the error (pip prints its reason,
# "ERROR: ...", in the last few).
$TailLines = 20

# Run a native command with its output shown live AND appended to the setup log. Returns
# { Code; Started; Out (stdout lines); Tail (last non-empty output lines); Text (the command) }.
#   -NoEcho        log only (nothing on the console)
#   -NoEchoStdout  stdout (e.g. a JSON report) only to the log and Out; stderr is shown
# Windows PowerShell 5.1: "2>&1" turns every stderr line into an ErrorRecord, and with
# $ErrorActionPreference = 'Stop' the first one (pip writes warnings to stderr) would throw
# NativeCommandError - so the preference is 'Continue' around the call, and records are turned
# back into their text with "$_". PowerShell reads the output line by line (a carriage return,
# as in progress output, also ends a line); empty lines are shown and logged but do not count for
# the tail. ANSI escape sequences (colours, erase line) are removed. $LASTEXITCODE is the native
# command's (ForEach-Object does not change it).
function Invoke-Logged([string]$Exe, [object[]]$ArgList = @(), [switch]$NoEcho, [switch]$NoEchoStdout) {
  $argv = @($ArgList | ForEach-Object { [string]$_ })
  $text = ('{0} {1}' -f $Exe, ($argv -join ' ')).Trim()
  $tail = New-Object 'System.Collections.Generic.List[string]'
  $out = New-Object 'System.Collections.Generic.List[string]'
  $code = 0
  $started = $true
  Write-Log ('> ' + $text)
  $timer = [System.Diagnostics.Stopwatch]::StartNew()
  $prevEnc = $null
  try { $prevEnc = [Console]::OutputEncoding; [Console]::OutputEncoding = $Utf8NoBom } catch { $prevEnc = $null }
  $oldEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $Exe @argv 2>&1 | ForEach-Object {
      $isErr = $_ -is [System.Management.Automation.ErrorRecord]
      $line = ("$_" -replace '\x1b\[[0-9;?]*[ -/]*[@-~]', '').TrimEnd()
      Write-Log $line
      if (-not $isErr) { $out.Add($line) }
      if (-not $NoEcho -and -not ($NoEchoStdout -and -not $isErr)) {
        if ($line -match '^\s*ERROR\b') { Write-Host $line -ForegroundColor Red }
        elseif ($line -match '^\s*WARNING\b') { Write-Host $line -ForegroundColor Yellow }
        else { Write-Host $line }
      }
      if ($line.Trim()) {
        $short = $line
        if ($short.Length -gt 400) { $short = $short.Substring(0, 400) + '...' }
        $tail.Add($short)
        if ($tail.Count -gt $TailLines) { $tail.RemoveAt(0) }
      }
    }
    $code = $LASTEXITCODE
    if ($null -eq $code) { $code = 0 }
  } catch {
    # the program could not be started at all (not found, not executable)
    $code = -1
    $started = $false
    $tail.Add($_.Exception.Message)
    Write-Log $_.Exception.Message
  } finally {
    $ErrorActionPreference = $oldEap
    if ($prevEnc) { try { [Console]::OutputEncoding = $prevEnc } catch { } }
  }
  Write-Log ('(exit {0}, {1:N0} s)' -f $code, $timer.Elapsed.TotalSeconds)
  return [pscustomobject]@{ Code = $code; Started = $started; Out = $out.ToArray(); Tail = $tail.ToArray(); Text = $text }
}

# The error for a failed step: one summary line, then the last lines of the command's output (also
# reported to the app as errorTail).
function Get-FailureMessage([string]$Summary, $Run) {
  $lines = @($Run.Tail)
  $script:Result['errorTail'] = $lines
  if ($lines.Count -eq 0) { return $Summary }
  return ($Summary + "`n" + ($lines -join "`n"))
}

# Run a native command (logged, see Invoke-Logged); throw if it fails. Simple function on purpose:
# arguments such as "-m" must reach the program untouched (an advanced function would try to bind them).
function Invoke-Checked {
  $exe = $args[0]
  $rest = @()
  if ($args.Count -gt 1) { $rest = @($args[1..($args.Count - 1)]) }
  $run = Invoke-Logged -Exe $exe -ArgList $rest
  if ($run.Code -ne 0) {
    $what = 'exit {0}' -f $run.Code
    if (-not $run.Started) { $what = 'could not start' }
    throw (Get-FailureMessage ('Command failed ({0}): {1}' -f $what, $run.Text) $run)
  }
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
  Write-Log ('winget install Python.Python.3.12: exit {0}' -f $code)
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

  if ($CheckOnly) {
    # changes nothing (no log either)
    if ($Packaged) { Write-Host ('Installed app detected: voice files go to {0}' -f $VoiceHome) }
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
  # A bad -Python fails the run only once the log has started (the log is what gets sent).
  $py = $null
  $pyError = $null
  try { $py = Find-Python } catch { $pyError = $_ }
  Start-SetupLog $py
  if ($Packaged) { Write-Info ('Installed app detected: voice files go to {0}' -f $VoiceHome) }
  if ($script:Result['log']) { Write-Info ('Setup log: {0}' -f $SetupLog) }
  Write-Step 'Looking for Python 3.12'
  if ($pyError) { throw $pyError }
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
  Write-Info ('Using {0} (Python {1})' -f $py.Path, $py.Version)

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
      Write-Info ('Removing the existing venv (Python {0}; want {1})' -f $hv, $py.Version)
      Remove-Venv
    } else {
      Write-Info ('Reusing the existing venv (Python {0})' -f $have.Version)
    }
  }
  if (-not (Test-Path -LiteralPath $VenvPy)) {
    $venvParent = Split-Path -Parent $Venv
    if (-not (Test-Path -LiteralPath $venvParent)) { New-Item -ItemType Directory -Force -Path $venvParent | Out-Null }
    Invoke-Checked $py.Path -m venv $Venv
  }
  if ($ModelsDir) {
    # where the app's voice server finds the models (no BOM: Python reads it as UTF-8)
    [System.IO.File]::WriteAllText($Pointer, $ModelsDir, $Utf8NoBom)
    Write-Info ('Models folder: {0}' -f $ModelsDir)
  }
  Invoke-Checked $VenvPy -m pip install --upgrade --disable-pip-version-check pip setuptools wheel

  if ($Packaged) {
    # pip writes build metadata next to the package: install from a writable copy
    if (Test-Path -LiteralPath $PkgDir) { Remove-Item -Recurse -Force -LiteralPath $PkgDir }
    New-Item -ItemType Directory -Force -Path $PkgDir | Out-Null
    Get-ChildItem -LiteralPath $VoiceDir -Force | Copy-Item -Recurse -Force -Destination $PkgDir
    Write-Log ('Copied the voice package to {0}' -f $PkgDir)
  }

  if ($OnWindows) {
    $drive = $null
    try { $drive = (Get-Item -LiteralPath (Split-Path -Parent $Venv)).PSDrive } catch { }
    if ($drive -and $drive.Free) {
      Write-Log ('Free space on drive {0}: {1:N1} GB' -f $drive.Name, ($drive.Free / 1GB))
      # Refuse to start when the packages cannot fit (pip running out of space half-way leaves a
      # half-installed venv); the GPU stack is ~5 GB, the CPU one ~1.5 GB. Models (~2.5 GB) only
      # warn: they may go to another drive (-ModelsDir) and download on first use otherwise.
      $gpuPlanned = (-not $Cpu) -and [bool](Get-Command nvidia-smi -ErrorAction SilentlyContinue)
      $needGB = 1.5
      if ($gpuPlanned) { $needGB = 5.5 }
      if ($drive.Free -lt ($needGB * 1GB)) {
        throw ('Not enough free disk space: {0:N1} GB free on drive {1}:, about {2:N1} GB needed for the voice packages. Free up some space, then run the setup again.' -f ($drive.Free / 1GB), $drive.Name, $needGB)
      }
      if ($drive.Free -lt (($needGB + 2.5) * 1GB)) {
        Write-Warn ('Only {0:N1} GB free on drive {1}:; the voice packages need ~{2:N1} GB plus ~2.5 GB of models.' -f ($drive.Free / 1GB), $drive.Name, $needGB)
      }
    }
  }

  # -------------------------------------------------------------------------------------------
  if ($Cpu) {
    Write-Step 'Installing the CPU voice stack'
    Invoke-Checked $VenvPy -m pip install --disable-pip-version-check -e ('{0}[cpu]' -f $PkgDir)
    $show = Invoke-Logged -Exe $VenvPy -ArgList @('-m', 'pip', 'show', 'onnxruntime-gpu') -NoEcho
    if ($show.Code -eq 0) {
      Invoke-Checked $VenvPy -m pip uninstall -y onnxruntime-gpu onnxruntime
      Invoke-Checked $VenvPy -m pip install --disable-pip-version-check --force-reinstall --no-deps 'onnxruntime>=1.20'
    }
  }
  if (-not $Cpu -and $OnWindows -and -not (Get-Command nvidia-smi -ErrorAction SilentlyContinue)) {
    Write-Warn 'nvidia-smi not found: no NVIDIA GPU driver is installed (R570+ for RTX 50-series, R580+ for GPU text-to-speech).'
    $toCpu = Read-YesNo 'Install the CPU version instead (smaller; no NVIDIA downloads)?'
    Write-Log ('Install the CPU version instead? {0}' -f $(if ($toCpu) { 'yes' } else { 'no' }))
    if ($toCpu) {
      $Cpu = $true
      $script:Result['cpu'] = $true
      Write-Step 'Installing the CPU voice stack'
      Invoke-Checked $VenvPy -m pip install --disable-pip-version-check -e ('{0}[cpu]' -f $PkgDir)
    }
  }
  if (-not $Cpu) {
    Write-Step 'Installing the NVIDIA GPU voice stack (CUDA 12.8+/13 wheels for RTX 50-series; several GB)'
    if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
      [void](Invoke-Logged -Exe 'nvidia-smi' -ArgList @('--query-gpu=name,driver_version,memory.total', '--format=csv,noheader'))
    } else {
      Write-Warn 'nvidia-smi not found: is the NVIDIA driver installed? (R570+ for RTX 50-series, R580+ for GPU text-to-speech)'
    }
    try {
      Invoke-Checked $VenvPy -m pip install --disable-pip-version-check -e ('{0}[gpu]' -f $PkgDir)
    } catch {
      # A dropped download of one of the big wheels is the usual one-off failure; pip keeps what
      # it already fetched in its cache, so a second attempt is quick. A real error fails again.
      Write-Warn ('The GPU install failed; trying once more (already downloaded files are reused): {0}' -f (($_.Exception.Message -split "`r?`n")[0]))
      Invoke-Checked $VenvPy -m pip install --disable-pip-version-check -e ('{0}[gpu]' -f $PkgDir)
    }
    if ($py.Version -ne '3.10') {
      # kokoro-onnx and faster-whisper depend on the CPU 'onnxruntime' wheel, which shares the
      # 'onnxruntime' folder with onnxruntime-gpu. Remove both, then reinstall the GPU wheel.
      Write-Step 'Making onnxruntime-gpu the only onnxruntime'
      [void](Invoke-Logged -Exe $VenvPy -ArgList @('-m', 'pip', 'uninstall', '-y', 'onnxruntime', 'onnxruntime-gpu') -NoEcho)
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
  # stdout is the JSON report (logged, not shown); the human-readable report goes to stderr
  $doctor = Invoke-Logged -Exe $VenvPy -ArgList @('-m', 'lawnmower_voice.doctor', '--device', $device, '--human') -NoEchoStdout
  if ($doctor.Code -ne 0) { throw (Get-FailureMessage ('The voice package does not import (lawnmower_voice.doctor: exit {0}).' -f $doctor.Code) $doctor) }
  $report = Get-LastJson $doctor.Out

  $modelArgs = @()
  if ($ModelsDir) { $modelArgs = @('--models-dir', $ModelsDir) }
  $modelsOk = $true
  if (-not $NoModels) {
    Write-Step ('Downloading models (Whisper {0} + base.en fallback, Kokoro-82M); first time only' -f $SttModel)
    $dlArgs = @('-m', 'lawnmower_voice.download', '--stt-model', $SttModel) + $modelArgs
    # stderr (the download progress bars) goes straight to the console; the JSON result to the log
    Write-Log ('> {0} {1}' -f $VenvPy, ($dlArgs -join ' '))
    $dlOut = & $VenvPy @dlArgs
    $dlCode = $LASTEXITCODE
    foreach ($l in @($dlOut)) { Write-Log ([string]$l) }
    Write-Log ('(exit {0})' -f $dlCode)
    if ($dlCode -ne 0) {
      $modelsOk = $false
      Write-Warn 'Some models could not be downloaded (see above). They will be fetched on first use; re-run this script to retry.'
    }
  }

  $smoke = $null
  if (-not $NoModels -and -not $SkipSmoke -and $modelsOk) {
    Write-Step 'Smoke test: loading both engines and running one request each (first GPU run compiles kernels; can take a minute)'
    $smokeArgs = @('-m', 'lawnmower_voice.doctor', '--smoke', '--device', $device, '--human', '--stt-model', $SttModel) + $modelArgs
    $smokeRun = Invoke-Logged -Exe $VenvPy -ArgList $smokeArgs -NoEchoStdout
    if ($smokeRun.Code -ne 0) { Write-Warn 'Smoke test failed to run.' } else { $smoke = Get-LastJson $smokeRun.Out }
  }

  # -------------------------------------------------------------------------------------------
  Write-Step 'Summary'
  if ($report) {
    $s = $report.summary
    $gpuName = 'none detected'
    if ($s.gpu) { $gpuName = $s.gpu }
    Write-Info ('  Python:         {0} ({1})' -f $report.python, $report.executable)
    Write-Info ('  GPU:            {0}' -f $gpuName)
    if (-not $Cpu) {
      $sttTxt = 'NOT available (CPU fallback)'; if ($s.sttGpuReady) { $sttTxt = 'ready' }
      $ttsTxt = 'NOT available (CPU fallback)'; if ($s.ttsGpuReady) { $ttsTxt = 'ready' }
      Write-Info ('  STT on GPU:     {0}  [CTranslate2]' -f $sttTxt)
      Write-Info ('  TTS on GPU:     {0}  [onnxruntime CUDA]' -f $ttsTxt)
    }
    if ($smoke) {
      foreach ($k in @('stt', 'tts')) {
        $r = $smoke.smoke.$k
        if ($r.ok) {
          $ct = ''
          if ($r.status.PSObject.Properties.Name -contains 'computeType') { $ct = $r.status.computeType }
          Write-Info ('  {0} smoke test: OK on {1} {2}  (load {3} ms, run {4} ms)' -f $k.ToUpper(), $r.status.device, $ct, $r.loadMs, $r.runMs)
        } else {
          Write-Info ('  {0} smoke test: FAILED - {1}' -f $k.ToUpper(), $r.error) 'Yellow'
        }
      }
    }
    foreach ($w in @($s.warnings)) { if ($w) { Write-Warn $w } }
  }
  Write-Info ''
  Write-Info 'Done. The app starts the voice server automatically (or use tray > Restart voice).'
  Write-Info ('Manual run:   "{0}" -m lawnmower_voice --port 8765 --token test --preload' -f $VenvPy)
  Write-Info ('Fake engines: "{0}" -m lawnmower_voice --fake' -f $VenvPy)
  Write-Info ('Diagnostics:  "{0}" -m lawnmower_voice.doctor --smoke --human' -f $VenvPy)
  if ($script:Result['log']) { Write-Info ('Setup log:    {0}' -f $SetupLog) }
  $script:Result['ok'] = $true
  $script:Result['cpu'] = [bool]$Cpu
  Exit-Setup 0
} catch {
  $msg = $_.Exception.Message
  Write-Host ''
  Write-Host ('ERROR: ' + $msg) -ForegroundColor Red
  Write-Log ''
  Write-Log ('ERROR: ' + $msg)
  if ($script:Result['log']) {
    Write-Host ''
    Write-Host ('The full output is in {0}' -f $SetupLog)
    Write-Host '  (Settings > Voice > "Open setup log" in Lawnmower Man). Send that file when you report the problem.'
  }
  if (-not $script:Result['error']) { $script:Result['error'] = $msg }
  Exit-Setup 1
}
