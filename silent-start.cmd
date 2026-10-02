@echo off
setlocal DisableDelayedExpansion
cd /d "%~dp0"
if not exist "%~dp0.run" mkdir "%~dp0.run" >nul 2>&1

call "%~dp0_find-python.cmd" >nul 2>&1
if not defined PYCMD (
  >"%~dp0.run\launcher-start.log" echo Python 3.11 or newer was not found.
  exit /b 1
)

%PYCMD% "%~dp0desktop_launcher.py" %* >"%~dp0.run\launcher-wrapper.log" 2>&1
exit /b %ERRORLEVEL%
