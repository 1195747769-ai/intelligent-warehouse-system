@echo off
rem ============================================================
rem  Locate a working Python 3 interpreter and set PYCMD.
rem  Shared by the launcher entry scripts in this folder.
rem
rem  Why not just call "py -3"?
rem  On this machine the py launcher points to a non-existent
rem  path (D:\WeGame\python.exe), so it fails silently. Every
rem  candidate below is actually executed before being accepted.
rem
rem  IMPORTANT: keep this file ASCII-only. cmd.exe mis-parses
rem  UTF-8 multi-byte characters in batch files, which corrupts
rem  comment lines and quoted paths.
rem  No setlocal here on purpose: PYCMD must reach the caller.
rem ============================================================

set "PYCMD="

rem ---- 1) private runtime; never silently repair it with machine Python ----
if exist "%~dp0runtime\python.exe" (
  set PYCMD="%~dp0runtime\python.exe"
  exit /b 0
)
if exist "%~dp0runtime" exit /b 1
if exist "%~dp0licenses\Python-LICENSE.txt" exit /b 1

rem ---- 2) developer virtualenv ----
if exist "%~dp0.venv\Scripts\python.exe" (
  "%~dp0.venv\Scripts\python.exe" -c "import sys" >nul 2>&1
  if not errorlevel 1 set PYCMD="%~dp0.venv\Scripts\python.exe"
)

rem ---- 2) py launcher (must be tested, may be broken) ----
if not defined PYCMD (
  py -3 -c "import sys" >nul 2>&1
  if not errorlevel 1 set PYCMD=py -3
)

rem ---- 3) known install locations ----
if not defined PYCMD if exist "D:\WeGame\Python 3.12\python.exe" set PYCMD="D:\WeGame\Python 3.12\python.exe"
if not defined PYCMD if exist "C:\Python313\python.exe" set PYCMD="C:\Python313\python.exe"
if not defined PYCMD if exist "C:\Python312\python.exe" set PYCMD="C:\Python312\python.exe"
if not defined PYCMD if exist "C:\Python311\python.exe" set PYCMD="C:\Python311\python.exe"

rem ---- 4) python from PATH (skip the Microsoft Store stub) ----
if not defined PYCMD (
  for /f "delims=" %%i in ('where python 2^>nul') do (
    if not defined PYCMD (
      echo %%i | findstr /i "WindowsApps" >nul || set PYCMD="%%i"
    )
  )
)

if not defined PYCMD exit /b 1
exit /b 0
