@echo off
setlocal EnableExtensions
set "SCRIPT_DIR=%~dp0"
where bash >nul 2>nul
if errorlevel 1 (
  echo Missing required command: bash 1>&2
  exit /b 1
)
bash "%SCRIPT_DIR%cleanup-worktree.sh" %*
exit /b %ERRORLEVEL%
