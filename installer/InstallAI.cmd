@echo off
setlocal
chcp 65001 >nul
set "AI_CORE_DIR=%LOCALAPPDATA%\Programs\IntelligentWarehouse"
if defined MATERIALS_INSTALL_DIR set "AI_CORE_DIR=%MATERIALS_INSTALL_DIR%"
if not "%~1"=="" set "AI_CORE_DIR=%~1"
if not exist "%AI_CORE_DIR%\runtime\python.exe" (
  echo 请先安装智能仓储核心程序，再运行此AI安装入口。
  echo 自定义安装目录可拖到此文件上，或作为第一个参数传入。
  pause
  exit /b 1
)
if not exist "%~dp0IntelligentWarehouse-AI-4B-Optional.zip" (
  "%AI_CORE_DIR%\runtime\python.exe" "%~dp0JoinAI.py"
  if errorlevel 1 (
    echo 请将AI的part01、part02和JoinAI.py下载到此文件夹后重试。
    pause
    exit /b 1
  )
)
"%AI_CORE_DIR%\runtime\python.exe" "%AI_CORE_DIR%\tools\install_ai.py" --archive "%~dp0IntelligentWarehouse-AI-4B-Optional.zip" --target "%AI_CORE_DIR%"
if errorlevel 1 (
  echo AI安装未完成，现有仓储数据和模型保持不变。
  echo 如提示微软运行库缺失，请安装官方 Visual C++ x64 运行库后重试。
  pause
  exit /b 1
)
echo AI辅助识别已安装。请关闭并重新启动智能仓储系统。
echo 没有独立显卡也可运行；AI仅提出建议，入库仍需人工确认。
pause
