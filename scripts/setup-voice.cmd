@echo off
rem Lawnmower Man - double-clickable wrapper for setup-voice.ps1 (passes all arguments through).
rem   setup-voice.cmd            GPU install + models
rem   setup-voice.cmd -Cpu       CPU-only install
setlocal
where pwsh >nul 2>nul
if %ERRORLEVEL%==0 (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-voice.ps1" %*
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-voice.ps1" %*
)
set RC=%ERRORLEVEL%
if "%~1"=="" pause
exit /b %RC%
