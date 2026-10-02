@echo off
rem ============================================================
rem  Intelligent Warehouse System - one-click launcher
rem  Double-click this file to open the control menu.
rem
rem  All user-facing text is printed by launcher.py so that
rem  Chinese characters render correctly. Keep this file
rem  ASCII-only: cmd.exe mis-parses UTF-8 multi-byte characters.
rem ============================================================
chcp 65001 >nul
setlocal DisableDelayedExpansion
cd /d "%~dp0"

call "%~dp0_find-python.cmd"

if not defined PYCMD (
  echo.
  echo   [ERROR] The bundled runtime is missing or damaged.
  echo   Run the offline setup package again to repair it.
  echo.
  pause
  endlocal & exit /b 1
)

%PYCMD% "%~dp0launcher.py" %*
set "RC=%errorlevel%"

if not "%RC%"=="0" (
  echo.
  echo   The launcher exited with code %RC%.
  echo   Open the menu and choose [8] to run a self-check.
  echo.
  pause
)

endlocal & exit /b %RC%
