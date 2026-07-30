@echo off
setlocal EnableExtensions
set "SCRIPT_DIR=%~dp0"
where bash >nul 2>nul
if errorlevel 1 (
  echo Missing required command: bash 1>&2
  exit /b 1
)
rem Pass through --require-env/--require-remote-env arguments to the bash helper.
bash "%SCRIPT_DIR%doctor.sh" %*
exit /b %ERRORLEVEL%
