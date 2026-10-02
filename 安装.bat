@echo off
rem ============================================================
rem  Intelligent Warehouse System - installer
rem
rem  Copies the program into the user's program folder and creates
rem  desktop / start-menu shortcuts, so the recipient only has to
rem  double-click this file once.
rem
rem  ASCII only on purpose: cmd.exe mis-parses UTF-8 multi-byte
rem  characters in batch files.
rem ============================================================
chcp 65001 >nul
setlocal DisableDelayedExpansion
cd /d "%~dp0"

if not exist "%~dp0installer\Install.ps1" (
  echo.
  echo   [ERROR] The offline package is incomplete.
  echo   Extract the entire package, including installer, and try again.
  echo   No separate Python installation is needed.
  echo.
  pause
  endlocal & exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer\Install.ps1" -SourceDir "%CD%" -Interactive %*
set "RC=%errorlevel%"

if not "%RC%"=="0" (
  echo.
  echo   Installation failed with exit code %RC%.
  echo.
  pause
)

endlocal & exit /b %RC%
