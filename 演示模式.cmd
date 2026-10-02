@echo off
cd /d "%~dp0"
set "MATERIALS_DATA=%~dp0demo-data"
set "MATERIALS_PORT=8766"
set "MATERIALS_DEMO_MODE=1"
if exist "%~dp0runtime\pythonw.exe" (
  start "" "%~dp0runtime\pythonw.exe" "%~dp0tools\prepare_inbound_demo.py" --serve
  exit /b
)
if exist "%~dp0.venv\Scripts\python.exe" (
  "%~dp0.venv\Scripts\python.exe" "%~dp0tools\prepare_inbound_demo.py" --serve
  exit /b
)
python "%~dp0tools\prepare_inbound_demo.py" --serve
