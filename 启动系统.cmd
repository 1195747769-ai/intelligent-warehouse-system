@echo off
rem ============================================================
rem  Compatibility entry: start the app directly, no menu.
rem  For stop / restart / status / log / backup, use the
rem  control-menu launcher instead.
rem  The original script was backed up as the .bak file.
rem  ASCII only on purpose (see _find-python.cmd).
rem ============================================================
chcp 65001 >nul
setlocal DisableDelayedExpansion
cd /d "%~dp0"

if exist "%~dp0runtime\pythonw.exe" (
  start "" "%~dp0runtime\pythonw.exe" "%~dp0desktop_launcher.py" %*
  exit /b 0
)
call "%~dp0_find-python.cmd"

if not defined PYCMD (
  echo.
  echo   [ERROR] The bundled runtime is missing or damaged.
  echo   Run the offline setup package again to repair it.
  echo.
  pause
  endlocal & exit /b 1
)

%PYCMD% "%~dp0desktop_launcher.py" %*
set "RC=%errorlevel%"

if not "%RC%"=="0" (
  echo.
  echo   Start failed with code %RC%.
  echo   Run the control-menu launcher and choose [8] for a self-check.
  echo.
  pause
)

endlocal & exit /b %RC%
