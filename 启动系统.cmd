@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>&1
if %errorlevel%==0 (
  py -3 server.py
  goto :done
)
where python >nul 2>&1
if %errorlevel%==0 (
  python server.py
  goto :done
)
echo 未找到 Python 3，请先安装 Python 3.11 或更高版本。
echo Python 3.11+ is required. Install it and run this file again.
:done
pause
