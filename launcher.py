#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""智能仓储系统 · 一键启动控制器

为什么需要它
------------
本机存在两个坑：
  1. `py` 启动器指向了不存在的路径（D:\\WeGame\\python.exe），直接跑 `py -3` 会失败；
  2. 系统 Python（D:\\WeGame\\Python 3.12）没有安装 openpyxl，而 server.py 顶层就
     `import openpyxl`，所以服务根本起不来。

本控制器绕过这两个坑：自己探测真正可用的 Python，缺依赖时自动建虚拟环境安装，
然后托管服务的启动 / 停止 / 重启 / 状态 / 日志 / 备份。

命令行
------
    python launcher.py              打开控制台菜单
    python launcher.py start        一键启动并打开浏览器
    python launcher.py stop         停止服务
    python launcher.py restart      重启服务
    python launcher.py status       查看运行状态
    python launcher.py doctor       环境自检（Python / 依赖 / 端口）
    python launcher.py open         打开浏览器
    python launcher.py log [N]      查看最近 N 行日志（默认 30）
    python launcher.py backup       备份 data/ 到 backups/

可选参数：--port 8765  --no-browser  --no-venv  --yes
"""
from __future__ import annotations

import json
import base64
import hashlib
import os
import re
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import webbrowser
import zipfile
from datetime import datetime
from contextlib import closing
from pathlib import Path

# ---------------------------------------------------------------- 基本常量

ROOT = Path(__file__).resolve().parent
RUN_DIR = ROOT / ".run"
STATE_FILE = RUN_DIR / "server.json"
LOG_FILE = RUN_DIR / "server.log"
BACKUP_DIR = ROOT / "backups"
VENV_DIR = ROOT / ".venv"
VENV_PY = VENV_DIR / "Scripts" / "python.exe"
BUNDLED_PY = ROOT / "runtime" / "python.exe"
SERVER_PY = ROOT / "server.py"
REQUIREMENTS = ROOT / "requirements.txt"
DATA_DIR = ROOT / "data"
DB_FILE = DATA_DIR / "materials.db"

DEFAULT_PORT = 8765
POWERSHELL = str(Path(os.environ.get('WINDIR', r'C:\Windows')) / 'System32/WindowsPowerShell/v1.0/powershell.exe')
HOST = "127.0.0.1"
APP_NAME = "智能仓储系统"
CTRL_VERSION = "1.0"

MAX_LOG_BYTES = 5 * 1024 * 1024

# Windows 进程创建标志
DETACHED_PROCESS = 0x00000008
CREATE_NEW_PROCESS_GROUP = 0x00000200
CREATE_NO_WINDOW = 0x08000000
_NO_WINDOW = CREATE_NO_WINDOW if os.name == "nt" else 0

# ---------------------------------------------------------------- 终端输出

_COLOR = False


def _enable_vt() -> bool:
    """让 Windows 控制台支持 ANSI 颜色。失败就退回无色，不影响功能。"""
    if os.name != "nt":
        return sys.stdout.isatty()
    try:
        import ctypes

        kernel32 = ctypes.windll.kernel32
        handle = kernel32.GetStdHandle(-11)
        mode = ctypes.c_uint32()
        if not kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
            return False
        return bool(kernel32.SetConsoleMode(handle, mode.value | 0x0004))
    except Exception:
        return False


def _set_console_title(text: str) -> None:
    """由 Python 设置控制台标题，避免批处理里的中文被 cmd 解析错位。"""
    if os.name != "nt":
        return
    try:
        import ctypes

        ctypes.windll.kernel32.SetConsoleTitleW(text)
    except Exception:
        pass


def _init_console() -> None:
    global _COLOR
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    _COLOR = _enable_vt()
    _set_console_title(f"{APP_NAME} · 一键启动控制器")


class C:
    """颜色常量：终端不支持时全部退化为空串。"""

    @staticmethod
    def _w(code: str) -> str:
        return code if _COLOR else ""

    RESET = ""
    BOLD = ""
    DIM = ""
    RED = ""
    GREEN = ""
    YELLOW = ""
    CYAN = ""
    GRAY = ""


def _setup_colors() -> None:
    C.RESET = C._w("\033[0m")
    C.BOLD = C._w("\033[1m")
    C.DIM = C._w("\033[2m")
    C.RED = C._w("\033[31m")
    C.GREEN = C._w("\033[32m")
    C.YELLOW = C._w("\033[33m")
    C.CYAN = C._w("\033[36m")
    C.GRAY = C._w("\033[90m")


def ok(msg: str) -> None:
    print(f"{C.GREEN}  [OK]{C.RESET} {msg}")


def warn(msg: str) -> None:
    print(f"{C.YELLOW}  [! ]{C.RESET} {msg}")


def err(msg: str) -> None:
    print(f"{C.RED}  [X ]{C.RESET} {msg}")


def info(msg: str) -> None:
    print(f"  {msg}")


def rule(char: str = "-", width: int = 62) -> None:
    print(f"{C.GRAY}{char * width}{C.RESET}")


def title(text: str) -> None:
    print(f"{C.BOLD}{C.CYAN}{text}{C.RESET}")


# ---------------------------------------------------------------- 小工具


def _run(cmd, timeout=60, cwd=None):
    """静默执行外部命令，返回 (returncode, stdout+stderr)。"""
    try:
        p = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            cwd=str(cwd) if cwd else None,
            creationflags=_NO_WINDOW,
        )
        return p.returncode, (p.stdout or "") + (p.stderr or "")
    except FileNotFoundError:
        return 127, "command not found"
    except subprocess.TimeoutExpired:
        return 124, "timeout"
    except Exception as exc:  # noqa: BLE001
        return 1, f"{type(exc).__name__}: {exc}"


def human_size(num: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if abs(num) < 1024 or unit == "GB":
            return f"{num:.1f} {unit}" if unit != "B" else f"{int(num)} B"
        num /= 1024
    return f"{num:.1f} GB"


# ---------------------------------------------------------------- 解释器探测

_python_cache: dict = {}

# 已知常见安装位置（按优先级）
_KNOWN_PATHS = [
    Path(r"D:\WeGame\Python 3.12\python.exe"),
    Path(r"C:\Python313\python.exe"),
    Path(r"C:\Python312\python.exe"),
    Path(r"C:\Python311\python.exe"),
]


def _registry_pythons() -> list[Path]:
    """从注册表读取已登记的 Python 安装路径（不依赖外部 reg.exe）。"""
    if os.name != "nt":
        return []
    found: list[Path] = []
    try:
        import winreg
    except Exception:
        return []
    roots = [
        (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Python\PythonCore"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Python\PythonCore"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Python\PythonCore"),
    ]
    for hive, key_path in roots:
        try:
            with winreg.OpenKey(hive, key_path) as core:
                index = 0
                while True:
                    try:
                        version = winreg.EnumKey(core, index)
                    except OSError:
                        break
                    index += 1
                    try:
                        with winreg.OpenKey(core, rf"{version}\InstallPath") as ip:
                            value, _ = winreg.QueryValueEx(ip, None)
                            if value:
                                found.append(Path(value) / "python.exe")
                    except OSError:
                        continue
        except OSError:
            continue
    return found


def _path_pythons() -> list[Path]:
    """扫描 PATH 中名为 python 的可执行文件。"""
    found: list[Path] = []
    for name in ("python.exe", "python3.exe", "python"):
        exe = shutil.which(name)
        if exe:
            found.append(Path(exe))
    return found


def _looks_like_store_stub(exe: Path) -> bool:
    """Windows 应用商店的占位程序：执行会弹出商店，必须排除。"""
    text = str(exe).lower()
    if "windowsapps" in text:
        return True
    if "appinstallerpythonredirector" in text:
        return True
    return False


def probe_python(exe) -> str | None:
    """验证一个解释器是否真的可用，返回版本号字符串或 None。"""
    if not exe:
        return None
    exe = Path(exe)
    if not exe.exists():
        return None
    if _looks_like_store_stub(exe):
        return None
    code = "import sys;print('%d.%d.%d'%sys.version_info[:3])"
    rc, out = _run([str(exe), "-c", code], timeout=25)
    if rc != 0:
        return None
    version = out.strip().splitlines()[0].strip() if out.strip() else ""
    try:
        parts = tuple(int(x) for x in version.split(".")[:2])
    except ValueError:
        return None
    if parts < (3, 8):
        return None
    return version


def candidates() -> list[tuple[str, Path]]:
    """按优先级列出候选解释器：(来源说明, 路径)。"""
    items: list[tuple[str, Path]] = []

    if BUNDLED_PY.is_file():
        items.append(("随包运行环境", BUNDLED_PY))

    if VENV_PY.exists():
        items.append(("项目虚拟环境", VENV_PY))

    env_py = os.environ.get("MATERIALS_PYTHON")
    if env_py:
        items.append(("环境变量 MATERIALS_PYTHON", Path(env_py)))

    if sys.executable:
        items.append(("当前解释器", Path(sys.executable)))

    for path in _registry_pythons():
        items.append(("注册表登记", path))

    for path in _KNOWN_PATHS:
        items.append(("已知安装位置", path))

    for path in _path_pythons():
        items.append(("PATH 查找", path))

    # 去重，保持顺序
    seen: set[str] = set()
    unique: list[tuple[str, Path]] = []
    for source, path in items:
        key = str(path).lower()
        if key in seen:
            continue
        seen.add(key)
        unique.append((source, path))
    return unique


def detect_python(verbose: bool = False) -> str | None:
    """找到第一个可用的 Python 解释器，返回其路径。"""
    if not verbose and _python_cache.get("path"):
        return _python_cache["path"]
    for source, path in candidates():
        version = probe_python(path)
        if verbose:
            mark = f"{C.GREEN}可用 {version}{C.RESET}" if version else f"{C.GRAY}不可用{C.RESET}"
            print(f"    {mark:<22} {source:<22} {path}")
        if version:
            _python_cache["path"] = str(path)
            _python_cache["version"] = version
            _python_cache["source"] = source
            return str(path)
    return None


def py_version(py: str) -> str:
    if _python_cache.get("path") == py and _python_cache.get("version"):
        return _python_cache["version"]
    return probe_python(py) or "未知"


# ---------------------------------------------------------------- 依赖

def has_openpyxl(py: str) -> bool:
    rc, _ = _run([py, "-I", "-B", "-c", "import sqlite3, ssl, openpyxl, xlrd, et_xmlfile"], timeout=25)
    return rc == 0


def _pip_install(py: str, args: list[str], label: str) -> bool:
    """安装依赖。优先使用随包附带的离线 wheel，失败再联网下载。"""
    print(f"  {C.GRAY}正在{label}，首次可能需要 10-60 秒，请稍候…{C.RESET}")
    vendor = ROOT / "vendor"
    if vendor.is_dir() and any(vendor.glob("*.whl")):
        rc, _ = _run(
            [py, "-m", "pip", "install", "--disable-pip-version-check",
             "--no-index", "--find-links", str(vendor), *args],
            timeout=600,
        )
        if rc == 0:
            return True
        print(f"  {C.GRAY}随包依赖未装成功，改用网络下载…{C.RESET}")
    rc, out = _run([py, "-m", "pip", "install", "--disable-pip-version-check", *args],
                   timeout=600)
    if rc == 0:
        return True
    print(f"{C.GRAY}{out.strip()[-1200:]}{C.RESET}")
    return False


def ensure_runtime(use_venv: bool = True, auto_install: bool = True) -> tuple[str | None, str]:
    """确保有一个能跑 server.py 的解释器（含 openpyxl）。返回 (解释器, 说明)。"""
    if BUNDLED_PY.is_file():
        if has_openpyxl(str(BUNDLED_PY)):
            return str(BUNDLED_PY), "随包运行环境"
        return None, "随包运行环境缺少组件或已损坏，请重新运行安装包；不会改用其他 Python"
    if (ROOT / "runtime").exists() or (ROOT / "licenses" / "Python-LICENSE.txt").is_file():
        return None, "随包 Python 文件缺失，请重新运行安装包"
    # 1) 已有虚拟环境且依赖完整
    if VENV_PY.exists():
        if has_openpyxl(str(VENV_PY)):
            return str(VENV_PY), "项目虚拟环境"
        warn("虚拟环境已存在但缺少依赖，尝试补装…")
        if auto_install and _pip_install(str(VENV_PY), ["-r", str(REQUIREMENTS)], "补装依赖"):
            return str(VENV_PY), "项目虚拟环境"

    base = detect_python()
    if not base:
        return None, "未找到可用的 Python 3"

    # 2) 系统解释器已具备依赖
    if has_openpyxl(base):
        return base, f"系统 Python {py_version(base)}"

    if not auto_install:
        return None, f"Python {py_version(base)} 缺少 openpyxl 且未允许自动安装"

    # 3) 建虚拟环境（隔离，不污染系统 Python）
    if use_venv:
        print(f"  检测到 Python {py_version(base)} 缺少 openpyxl。")
        print(f"  {C.GRAY}正在创建项目虚拟环境 .venv（只在本项目内生效，不改动系统环境）…{C.RESET}")
        rc, out = _run([base, "-m", "venv", str(VENV_DIR)], timeout=300)
        if rc == 0 and VENV_PY.exists():
            if _pip_install(str(VENV_PY), ["-r", str(REQUIREMENTS)], "安装依赖"):
                return str(VENV_PY), "项目虚拟环境"
            warn("虚拟环境依赖安装失败，回退到系统 Python 安装。")
        else:
            print(f"{C.GRAY}{out.strip()[-800:]}{C.RESET}")
            warn("虚拟环境创建失败，回退到系统 Python 安装。")

    # 4) 回退：装到当前用户的 site-packages
    if _pip_install(base, ["--user", "-r", str(REQUIREMENTS)], "为用户安装依赖"):
        return base, f"系统 Python {py_version(base)}（用户目录）"

    return None, "依赖安装失败（请检查网络后重试）"


# ---------------------------------------------------------------- 进程 / 端口


def port_owner(port: int) -> int | None:
    """返回正在 LISTEN 该端口的进程号，没有则 None。"""
    rc, out = _run(["netstat", "-ano", "-p", "TCP"], timeout=20)
    if rc != 0:
        return None
    for line in out.splitlines():
        parts = line.split()
        if len(parts) < 5:
            continue
        if parts[0].upper() != "TCP":
            continue
        if parts[3].upper() != "LISTENING":
            continue
        if parts[1].endswith(f":{port}"):
            try:
                return int(parts[4])
            except ValueError:
                continue
    return None


def read_state() -> dict:
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def write_state(data: dict) -> None:
    RUN_DIR.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def clear_state() -> None:
    try:
        STATE_FILE.unlink()
    except OSError:
        pass


def pid_alive(pid: int) -> bool:
    if not pid or pid <= 0:
        return False
    rc, out = _run(["tasklist", "/FI", f"PID eq {pid}", "/NH"], timeout=20)
    if rc != 0:
        return False
    return str(pid) in out


def owns_server(pid: int) -> bool:
    """A recycled PID or a script mentioned as a data argument is not our server."""
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0: return False
    script = ("$ProgressPreference='SilentlyContinue'; $env:PSModulePath=(Join-Path $PSHOME 'Modules')+';'+$env:PSModulePath; "
              "[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); "
              f"Get-CimInstance Win32_Process -Filter 'ProcessId={pid}' | "
              "Select-Object ExecutablePath,CommandLine | ConvertTo-Json -Compress")
    rc, output = _run([POWERSHELL, '-NoProfile', '-EncodedCommand',
                       base64.b64encode(script.encode('utf-16-le')).decode()], timeout=20)
    try:
        process = json.loads(output) if not rc else {}
        exe = process.get('ExecutablePath', '')
        command = process.get('CommandLine', '').replace('/', chr(92))
        if not re.fullmatch(r'python(?:w|3(?:\.\d+)?)?\.exe', Path(exe).name, re.I): return False
        executable, entry = re.escape(exe), re.escape(str(SERVER_PY))
        return bool(re.match(r'^\s*(?:"'+executable+'"|'+executable+r')(?:\s+-(?:B|I|u|E|s|S|O|OO))*\s+(?:"'+entry+'"|'+entry+r')(?:$|\s)',command,re.I))
    except (ValueError, TypeError, AttributeError): return False


def server_status(port: int) -> dict:
    """综合判断服务状态。"""
    owner = port_owner(port)
    state = read_state()
    state_pid = state.get("pid")
    spawn_pid = state.get("spawn_pid")
    alive = bool(state_pid and owns_server(state_pid))
    # 只有端口确实在监听，才算服务运行中。仅凭状态文件里的 PID 会把
    # “服务已崩溃但旧 PID 仍活着”误判为运行中，双击后只会重复打开一个
    # 无法连接的页面，用户只好手动重启。
    # 端口被其他程序占用：不是本控制器启动的服务
    foreign = bool(owner and (owner not in (state_pid, spawn_pid) or not owns_server(owner)))
    pid = owner if owner and not foreign else None
    running = bool(pid)
    return {
        "running": running,
        "pid": pid or (int(state_pid) if alive else None),
        "port": port,
        "url": f"http://{HOST}:{port}/",
        "started_at": state.get("started_at") if (running and not foreign) else None,
        "python": state.get("python"),
        "source": state.get("source") if (running and not foreign) else None,
        "foreign": foreign,
    }


def uptime_text(started_at: str | None) -> str:
    if not started_at:
        return "-"
    try:
        started = datetime.strptime(started_at, "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return "-"
    seconds = int((datetime.now() - started).total_seconds())
    if seconds < 0:
        return "-"
    days, rem = divmod(seconds, 86400)
    hours, rem = divmod(rem, 3600)
    minutes, secs = divmod(rem, 60)
    if days:
        return f"{days} 天 {hours} 小时 {minutes} 分"
    if hours:
        return f"{hours} 小时 {minutes} 分"
    if minutes:
        return f"{minutes} 分 {secs} 秒"
    return f"{secs} 秒"


def wait_port(port: int, timeout: float = 25.0, expect_open: bool = True) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        with socket.socket() as sock:
            sock.settimeout(0.4)
            reachable = sock.connect_ex((HOST, port)) == 0
        if reachable == expect_open:
            return True
        time.sleep(0.25)
    return False


def rotate_log() -> None:
    try:
        if LOG_FILE.exists() and LOG_FILE.stat().st_size > MAX_LOG_BYTES:
            backup = LOG_FILE.with_suffix(".log.1")
            if backup.exists():
                backup.unlink()
            LOG_FILE.rename(backup)
    except OSError:
        pass


def tail_log(lines: int = 30) -> list[str]:
    if not LOG_FILE.exists():
        return []
    try:
        content = LOG_FILE.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    return content.splitlines()[-lines:]


# ---------------------------------------------------------------- 动作


def do_start(port: int = DEFAULT_PORT, open_browser: bool = True,
             use_venv: bool = True, auto_install: bool = True) -> int:
    state = server_status(port)
    if state.get("foreign"):
        err(f"端口 {port} 已被其他程序占用，未启动本系统。")
        info("请关闭占用端口的程序，或用 --port 指定其他端口后重试。")
        return 1
    if state["running"]:
        warn(f"服务已经在运行（PID {state['pid']}）：{state['url']}")
        if open_browser:
            do_open(port)
        return 0

    print(f"  {C.GRAY}[1/3] 检查运行环境…{C.RESET}")
    py, source = ensure_runtime(use_venv=use_venv, auto_install=auto_install)
    if not py:
        err(f"启动失败：{source}")
        info("可运行  python launcher.py doctor  查看详细诊断。")
        return 1
    ok(f"Python {py_version(py)}（{source}）")

    print(f"  {C.GRAY}[2/3] 启动服务…{C.RESET}")
    RUN_DIR.mkdir(parents=True, exist_ok=True)
    rotate_log()

    env = os.environ.copy()
    env["MATERIALS_PORT"] = str(port)
    if BUNDLED_PY.is_file():
        env["MATERIALS_DATA"] = str(DATA_DIR)
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    env["PYTHONUNBUFFERED"] = "1"

    log_handle = open(LOG_FILE, "ab", buffering=0)
    log_handle.write(f"\n===== {datetime.now():%Y-%m-%d %H:%M:%S} 启动 =====\n".encode("utf-8"))
    try:
        proc = subprocess.Popen(
            [py, str(SERVER_PY)],
            cwd=str(ROOT),
            stdin=subprocess.DEVNULL,
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            env=env,
            creationflags=DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0,
        )
    except Exception as exc:  # noqa: BLE001
        err(f"无法启动进程：{exc}")
        return 1
    finally:
        log_handle.close()

    # 进程秒退说明代码层面就失败了（例如依赖缺失），把日志末尾打出来
    time.sleep(1.2)
    if proc.poll() is not None:
        err(f"服务进程启动后立即退出（退出码 {proc.returncode}）。日志末尾：")
        for line in tail_log(12):
            print(f"{C.GRAY}      {line}{C.RESET}")
        clear_state()
        return 1

    if not wait_port(port, timeout=25, expect_open=True):
        err("等待端口就绪超时，服务可能未正常启动。日志末尾：")
        for line in tail_log(12):
            print(f"{C.GRAY}      {line}{C.RESET}")
        clear_state()
        return 1

    # 真正 LISTEN 端口的进程号才是「服务进程」；虚拟环境的启动器可能另有一个父进程
    actual_pid = port_owner(port) or proc.pid
    write_state({
        "pid": actual_pid,
        "spawn_pid": proc.pid,
        "port": port,
        "python": py,
        "source": source,
        "started_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    })

    print(f"  {C.GRAY}[3/3] 就绪检查通过{C.RESET}")
    ok(f"服务已启动（PID {actual_pid}）")
    print(f"  访问地址：{C.BOLD}{C.CYAN}http://{HOST}:{port}/{C.RESET}")
    if open_browser:
        do_open(port)
    return 0


def do_stop(port: int = DEFAULT_PORT) -> int:
    """停止服务。只结束本控制器启动的进程，不碰其他程序。"""
    raw = read_state()
    known: list[int] = []
    for key in ("pid", "spawn_pid"):
        value = raw.get(key)
        if isinstance(value, int) and value > 0 and value not in known:
            known.append(value)

    owner = port_owner(port)
    alive = [pid for pid in known if owns_server(pid)]

    if not alive:
        if owner:
            err(f"端口 {port} 正被其他程序（PID {owner}）占用，本控制器不会强行结束它。")
            info("请先关闭该程序；或换个端口启动：launcher.py start --port 8766")
            clear_state()
            return 1
        warn("服务当前未在运行。")
        clear_state()
        return 0

    for pid in alive:
        print(f"  {C.GRAY}正在停止 PID {pid} …{C.RESET}")
        _run(["taskkill", "/PID", str(pid), "/T", "/F"], timeout=30)

    if wait_port(port, timeout=10, expect_open=False):
        clear_state()
        ok("服务已停止。")
        return 0
    err("端口仍被占用，停止失败。")
    return 1


def do_restart(port: int = DEFAULT_PORT, open_browser: bool = True) -> int:
    do_stop(port)
    time.sleep(0.6)
    return do_start(port=port, open_browser=open_browser)


def do_open(port: int = DEFAULT_PORT) -> int:
    url = f"http://{HOST}:{port}/"
    try:
        webbrowser.open(url)
        ok(f"已在浏览器打开 {url}")
        return 0
    except Exception as exc:  # noqa: BLE001
        warn(f"自动打开失败（{exc}），请手动访问 {url}")
        return 1


def do_backup() -> int:
    if not DATA_DIR.exists():
        err("未找到 data 目录，暂无可备份的数据。")
        return 1
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    target = BACKUP_DIR / f"materials-backup-{stamp}.zip"
    count = 0
    try:
        with tempfile.TemporaryDirectory(prefix='.backup-', dir=BACKUP_DIR) as temporary:
            staged = Path(temporary) / 'backup.zip'
            snapshot = Path(temporary) / 'materials.db'
            if DB_FILE.is_file():
                with closing(sqlite3.connect('file:' + DB_FILE.as_posix() + '?mode=ro', uri=True)) as source, closing(sqlite3.connect(snapshot)) as destination:
                    source.backup(destination)
                    if destination.execute('PRAGMA quick_check').fetchone()[0] != 'ok': raise ValueError('数据库快照校验失败')
            with zipfile.ZipFile(staged, "w", zipfile.ZIP_DEFLATED) as zf:
                if snapshot.is_file(): zf.write(snapshot, 'data/materials.db'); count += 1
                for path in sorted(DATA_DIR.rglob("*")):
                    if not path.is_file() or path.name in ('materials.db','materials.db-wal','materials.db-shm','materials.db-journal'): continue
                    if path.is_symlink() or not path.resolve().is_relative_to(DATA_DIR.resolve()): raise ValueError('备份来源不能是外部链接')
                    zf.write(path, path.relative_to(ROOT)); count += 1
            staged.replace(target)
    except Exception as exc:  # noqa: BLE001
        err(f"备份失败：{exc}")
        return 1
    ok(f"已备份 {count} 个文件 → {target}")
    info(f"大小：{human_size(target.stat().st_size)}")
    return 0


def do_status(port: int = DEFAULT_PORT, brief: bool = False) -> int:
    state = server_status(port)
    if state.get("foreign"):
        dot = f"{C.YELLOW}● 端口被其他程序占用{C.RESET}"
    elif state["running"]:
        dot = f"{C.GREEN}● 运行中{C.RESET}"
    else:
        dot = f"{C.GRAY}○ 未运行{C.RESET}"
    print(f"  服务状态：{dot}")
    if state["running"]:
        print(f"  进程号　：{state['pid']}")
        print(f"  访问地址：{C.CYAN}{state['url']}{C.RESET}")
        if state["started_at"]:
            print(f"  已运行　：{uptime_text(state['started_at'])}")
        if state.get("source"):
            print(f"  运行环境：{state['source']}")
    print(f"  监听端口：{port}（仅本机可访问）")
    if DB_FILE.exists():
        stat = DB_FILE.stat()
        print(f"  数据库　：{human_size(stat.st_size)}"
              f"  最后修改 {datetime.fromtimestamp(stat.st_mtime):%Y-%m-%d %H:%M}")
    else:
        print(f"  数据库　：{C.GRAY}尚未生成（首次入库后出现）{C.RESET}")
    if not brief:
        lines = tail_log(8)
        if lines:
            print(f"\n  {C.GRAY}最近日志：{C.RESET}")
            for line in lines:
                print(f"{C.GRAY}    {line}{C.RESET}")
    return 0


def do_doctor(port: int = DEFAULT_PORT) -> int:
    print()
    title("环境自检")
    rule("=")

    # 1) Python
    print(f"\n{C.BOLD}1. Python 解释器{C.RESET}")
    found = detect_python(verbose=False)
    for source, path in candidates():
        version = probe_python(path)
        if version:
            mark = f"{C.GREEN}可用 {version:<8}{C.RESET}"
        elif _looks_like_store_stub(path):
            mark = f"{C.GRAY}跳过 应用商店占位{C.RESET}"
        else:
            mark = f"{C.RED}不可用        {C.RESET}"
        print(f"    {mark} {source:<20} {path}")
    if found:
        ok(f"将使用：{found}")
    else:
        err("没有找到可用的 Python 3.8+。请先安装 Python 后重试。")

    # 2) 依赖
    print(f"\n{C.BOLD}2. 运行依赖{C.RESET}")
    if VENV_PY.exists():
        ok(f"项目虚拟环境存在：{VENV_DIR}")
        if has_openpyxl(str(VENV_PY)):
            ok("虚拟环境内 openpyxl 已安装")
        else:
            warn("虚拟环境内缺少 openpyxl，启动时会自动补装")
    else:
        info(f"尚无项目虚拟环境（{VENV_DIR.name}），首次启动时自动创建")
    if found and has_openpyxl(found):
        ok(f"当前解释器 openpyxl 已就绪")
    else:
        warn("当前解释器缺少 openpyxl，启动时会自动安装")

    # 3) 端口
    print(f"\n{C.BOLD}3. 端口 {port}{C.RESET}")
    owner = port_owner(port)
    if owner:
        state = server_status(port)
        ok(f"端口被 PID {owner} 占用" + ("（就是本系统，运行中）" if state["running"] else "（可能是其他程序）"))
    else:
        ok("端口空闲，可以启动")

    # 4) 文件
    print(f"\n{C.BOLD}4. 项目文件{C.RESET}")
    for label, path in (("服务端脚本", SERVER_PY), ("依赖清单", REQUIREMENTS),
                        ("前端目录", ROOT / "static"), ("数据目录", DATA_DIR)):
        if path.exists():
            ok(f"{label}：{path.name}")
        else:
            warn(f"{label} 缺失：{path}")

    # 5) py 启动器提示
    print(f"\n{C.BOLD}5. 已知环境问题{C.RESET}")
    rc, out = _run(["py", "-3", "-c", "import sys"], timeout=20)
    if rc != 0:
        warn("系统 py 启动器不可用（指向了不存在的路径），本控制器已自动绕过。")
        info("如需修复：重新安装 Python 时勾选 py launcher，或用本控制器启动即可。")
    else:
        ok("py 启动器可用")

    rule("=")
    print()
    return 0 if found else 1


# ---------------------------------------------------------------- 安装（分发用）

# 安装时复制哪些文件。刻意用白名单：数据、虚拟环境、日志、内部笔记都不会进包。
INSTALL_FILES = [
    "server.py",
    "intake.py",
    "local_ai.py",
    "desktop_launcher.py",
    "tools/prepare_inbound_demo.py",
    "演示模式.cmd",
    "launcher.py",
    "requirements.txt",
    "_find-python.cmd",
    "一键启动控制器.cmd",
    "启动系统.cmd",
    "silent-start.cmd",
    "启动系统.vbs",
    "使用说明.txt",
    "README.md",
    "CHANGELOG.md",
    "宣传文案.md",
    "LICENSE",
    "安装.bat",
    "installer/Install.ps1",
    "installer/Uninstall.ps1",
    "tools/install_ai.py",
]
INSTALL_DIRS = ["runtime", "static", "vendor", "licenses"]


def validate_release(root: Path = ROOT) -> None:
    """Reject incomplete offline releases before installing or creating an archive."""
    root = Path(root)
    required = [*INSTALL_FILES, "runtime/python.exe", "runtime/pythonw.exe", "runtime/LICENSE.txt",
                "licenses/Python-LICENSE.txt", "static/index.html", "static/app.js", "static/style.css",
                "static/tokens.css", "static/univer-preview.js", "static/univer-preview.css", "static/showcase/index.html"]
    missing = [name for name in required if not (root / name).is_file()]
    missing += [name + "/" for name in INSTALL_DIRS if not (root / name).is_dir()]
    if missing:
        raise ValueError("离线安装包缺少必需文件：" + "、".join(missing))
    code = ("import sys,struct,sqlite3,ssl,openpyxl,xlrd,et_xmlfile; "
            "assert sys.platform=='win32' and struct.calcsize('P')==8 and sys.version_info>=(3,11)")
    rc, output = _run([str(root / "runtime/python.exe"), "-I", "-B", "-c", code], timeout=25, cwd=root)
    if rc:
        raise ValueError("随包 Windows x64 运行环境或表格依赖不完整：" + output.strip()[-700:])


def default_install_dir() -> Path:
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    return Path(base) / "Programs" / "IntelligentWarehouse"


def _shell_folder(name: str) -> Path:
    """读取用户 shell 文件夹真实路径（兼容 OneDrive 重定向）。"""
    if os.name == "nt":
        try:
            import winreg

            key_path = r"Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders"
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path) as key:
                value, _ = winreg.QueryValueEx(key, name)
                if value:
                    return Path(value)
        except Exception:
            pass
    if name == "Desktop":
        return Path(os.environ.get("USERPROFILE", str(Path.home()))) / "Desktop"
    appdata = os.environ.get("APPDATA", str(Path.home()))
    return Path(appdata) / "Microsoft" / "Windows" / "Start Menu" / "Programs"


def _create_shortcut(link: Path, target: Path, workdir: Path, description: str,
                     arguments: str = "") -> bool:
    """创建 .lnk 快捷方式。

    PowerShell 脚本以 UTF-16 写入磁盘再执行：直接把中文路径放在命令行上会因
    控制台代码页丢字。
    """
    try:
        link.parent.mkdir(parents=True, exist_ok=True)
    except OSError:
        return False
    quote = lambda value: "'" + str(value).replace("'", "''") + "'"
    script = (
        "$ErrorActionPreference = 'Stop'\n"
        "$ws = New-Object -ComObject WScript.Shell\n"
        f"$lnk = $ws.CreateShortcut({quote(link)})\n"
        f"$lnk.TargetPath = {quote(target)}\n"
        f"$lnk.Arguments = {quote(arguments)}\n"
        f"$lnk.WorkingDirectory = {quote(workdir)}\n"
        f"$lnk.Description = {quote(description)}\n"
        "$lnk.Save()\n"
    )
    RUN_DIR.mkdir(parents=True, exist_ok=True)
    tmp = RUN_DIR / "_shortcut.ps1"
    try:
        tmp.write_text(script, encoding="utf-16")
        rc, _ = _run([POWERSHELL, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(tmp)],
                     timeout=90)
        return rc == 0 and link.exists()
    except Exception:  # noqa: BLE001
        return False
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass


def do_install(target: Path | None = None, shortcuts: bool = True) -> int:
    """Use the same verified, data-preserving installer as Setup and the portable ZIP."""
    target = Path(target).expanduser() if target else default_install_dir()
    if target.resolve() == ROOT.resolve():
        ok("当前目录已经是安装目录；请运行新版 Setup 修复或升级。")
        return 0
    try:
        validate_release()
        if not (ROOT / 'release-manifest.json').is_file():
            raise ValueError("缺少完整发布清单，请使用 Setup 或完整便携 ZIP 安装。")
    except ValueError as exc:
        err(str(exc)); return 1
    command = [POWERSHELL, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
               str(ROOT / 'installer/Install.ps1'), '-SourceDir', str(ROOT),
               '-InstallDir', str(target), '-NoLaunch']
    if not shortcuts: command += ['-SkipShortcuts', '-SkipRegistration']
    rc, output = _run(command, timeout=180, cwd=ROOT)
    if rc: err(output.strip()[-1200:]); return 1
    ok(f"安装完成，数据与备份保存在 {target}")
    return 0


def _app_version() -> str:
    """从 server.py 读取版本号，保证打包版本与实际一致。"""
    try:
        text = SERVER_PY.read_text(encoding="utf-8")
        match = re.search(r"APP_VERSION\s*=\s*['\"]([^'\"]+)['\"]", text)
        if match:
            return match.group(1)
    except Exception:  # noqa: BLE001
        pass
    return "0.0.0"


def do_package(out_dir: Path | None = None) -> int:
    """打包成可以直接发给别人的安装包（ZIP）。

    只收录白名单文件：数据、虚拟环境、日志、内部笔记一律不进包。
    """
    try:
        validate_release()
    except ValueError as exc:
        err(str(exc))
        return 1
    version = _app_version()
    top = f"智能仓储系统-v{version}"
    out_dir = Path(out_dir).expanduser() if out_dir else ROOT.parent
    try:
        out_dir.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        err(f"无法创建输出目录：{exc}")
        return 1
    target = out_dir / f"{top}-安装包.zip"

    if any(out_dir.resolve().is_relative_to((ROOT / name).resolve()) for name in INSTALL_DIRS):
        err("请把安装包输出到程序资源目录之外，避免将安装包打入自身。")
        return 1

    print()
    title(f"打包 {top}")
    rule("=")
    count = 0
    partial = None
    try:
        with tempfile.NamedTemporaryFile(dir=out_dir, prefix="warehouse-package-", suffix=".partial", delete=False) as file:
            partial = Path(file.name)
        with zipfile.ZipFile(partial, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
            paths = [ROOT / name for name in INSTALL_FILES]
            for dirname in INSTALL_DIRS:
                base = ROOT / dirname
                for path in sorted(base.rglob("*")):
                    if not path.is_file() or "__pycache__" in path.parts or path.suffix == ".pyc":
                        continue
                    paths.append(path)
            manifest = {"format": 1, "version": version, "platform": "Windows 10/11 x64", "files": {}}
            excluded = {"data", "demo-data", ".run", "backups", ".venv", "local-ai"}
            for path in paths:
                resolved = path.resolve()
                if not resolved.is_relative_to(ROOT.resolve()) or resolved.relative_to(ROOT.resolve()).parts[0] in excluded:
                    raise ValueError(f"安装包资源指向了程序外或个人数据：{path}")
                name = path.relative_to(ROOT).as_posix()
                content = path.read_bytes()
                zf.writestr(f"{top}/{name}", content)
                manifest['files'][name] = {"bytes": len(content), "sha256": hashlib.sha256(content).hexdigest()}
                count += 1
            zf.writestr(f"{top}/release-manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2).encode('utf-8'))
        partial.replace(target)
    except (OSError, ValueError) as exc:
        err(f"打包失败：{exc}")
        return 1
    finally:
        if partial is not None and partial.exists():
            partial.unlink()

    ok(f"已打包 {count} 个文件")
    print(f"  输出文件：{target}")
    print(f"  大小：{human_size(target.stat().st_size)}")
    print()
    print("  拿到这个压缩包的人：解压 → 双击「安装.bat」→ 桌面出现无命令窗启动图标。")
    print()
    return 0


# ---------------------------------------------------------------- 菜单


def print_header(port: int) -> None:
    state = server_status(port)
    py = _python_cache.get("path") or detect_python()
    version = _python_cache.get("version") or (py_version(py) if py else "-")
    print()
    title(f"  {APP_NAME} · 一键启动控制器  v{CTRL_VERSION}")
    rule("=")
    env_line = f"Python {version}" if py else f"{C.RED}未找到 Python{C.RESET}"
    print(f"  运行环境：{env_line}")
    if state["running"]:
        print(f"  服务状态：{C.GREEN}● 运行中{C.RESET}  PID {state['pid']}  "
              f"{C.CYAN}{state['url']}{C.RESET}")
        print(f"  已运行　：{uptime_text(state['started_at'])}")
    else:
        print(f"  服务状态：{C.GRAY}○ 未运行{C.RESET}  （端口 {port}）")
    rule("-")


MENU = [
    ("1", "启动系统（自动打开浏览器）"),
    ("2", "停止系统"),
    ("3", "重启系统"),
    ("4", "查看运行状态"),
    ("5", "在浏览器打开"),
    ("6", "查看运行日志"),
    ("7", "备份数据（data 目录）"),
    ("8", "环境自检"),
    ("0", "退出"),
]


def menu(port: int) -> int:
    while True:
        print_header(port)
        for key, label in MENU:
            if key == "0":
                rule("-")
            print(f"    {C.BOLD}[{key}]{C.RESET} {label}")
        rule("-")
        try:
            choice = input(f"  请选择：{C.BOLD}").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return 0
        print(C.RESET, end="")
        print()

        if choice == "1":
            do_start(port=port, open_browser=True)
        elif choice == "2":
            do_stop(port)
        elif choice == "3":
            do_restart(port, open_browser=True)
        elif choice == "4":
            do_status(port)
        elif choice == "5":
            do_open(port)
        elif choice == "6":
            lines = tail_log(30)
            if lines:
                title("最近 30 行日志")
                for line in lines:
                    print(f"{C.GRAY}  {line}{C.RESET}")
            else:
                warn("暂无日志。")
        elif choice == "7":
            do_backup()
        elif choice == "8":
            do_doctor(port)
        elif choice in ("0", "q", "exit", "退出"):
            print("  已退出控制器。服务如需关闭，请重新运行后选择「停止系统」。")
            print()
            return 0
        else:
            warn("请输入 0-8 之间的选项。")

        try:
            input(f"\n  {C.GRAY}按回车返回菜单…{C.RESET}")
        except (EOFError, KeyboardInterrupt):
            print()
            return 0


# ---------------------------------------------------------------- 入口


USAGE = """智能仓储系统 · 一键启动控制器

用法：
    python launcher.py [命令] [选项]

命令：
    start      启动服务并打开浏览器（默认会检查环境与依赖）
    stop       停止服务
    restart    重启服务
    status     查看运行状态
    doctor     环境自检（Python / 依赖 / 端口）
    open       在浏览器打开系统
    log [N]    查看最近 N 行日志（默认 30）
    backup     备份 data 目录到 backups/
    install    安装到用户程序目录，并创建桌面和开始菜单快捷方式
    package    打包成可以直接发给别人的安装包（ZIP）
    menu       打开交互式菜单（不带命令时的默认行为）

选项：
    --port <n>      指定端口，默认 8765
    --no-browser    启动后不自动打开浏览器
    --no-venv       不创建虚拟环境，直接把依赖装到当前用户目录
    --target <dir>  install 的安装目录（默认 %LOCALAPPDATA%\\Programs\\IntelligentWarehouse）
    --no-shortcuts  install 时不创建快捷方式
    --out <dir>     package 的输出目录（默认项目上一级目录）
    --yes           自动确认（供脚本调用）
    -h, --help      显示本帮助
"""


def main(argv: list[str]) -> int:
    _init_console()
    _setup_colors()

    args = list(argv[1:])
    port = DEFAULT_PORT
    open_browser = True
    use_venv = True
    target: str | None = None
    shortcuts = True
    out_dir: str | None = None

    # 解析选项
    rest: list[str] = []
    i = 0
    while i < len(args):
        a = args[i]
        if a in ("-h", "--help"):
            print(USAGE)
            return 0
        if a == "--port" and i + 1 < len(args):
            try:
                port = int(args[i + 1])
            except ValueError:
                err("--port 需要是数字")
                return 2
            i += 2
            continue
        if a == "--target" and i + 1 < len(args):
            target = args[i + 1]
            i += 2
            continue
        if a == "--out" and i + 1 < len(args):
            out_dir = args[i + 1]
            i += 2
            continue
        if a == "--no-browser":
            open_browser = False
        elif a == "--no-venv":
            use_venv = False
        elif a == "--no-shortcuts":
            shortcuts = False
        elif a == "--yes":
            pass
        else:
            rest.append(a)
        i += 1

    cmd = rest[0].lower() if rest else "menu"

    if not SERVER_PY.exists():
        err(f"未找到 server.py：{SERVER_PY}")
        return 1

    if cmd in ("menu", "ui", ""):
        return menu(port)
    if cmd == "start":
        print()
        return do_start(port=port, open_browser=open_browser, use_venv=use_venv)
    if cmd == "stop":
        print()
        return do_stop(port)
    if cmd == "restart":
        print()
        return do_restart(port, open_browser=open_browser)
    if cmd == "status":
        print()
        return do_status(port)
    if cmd == "doctor":
        return do_doctor(port)
    if cmd == "open":
        print()
        return do_open(port)
    if cmd == "log":
        n = 30
        if len(rest) > 1:
            try:
                n = int(rest[1])
            except ValueError:
                pass
        lines = tail_log(n)
        if lines:
            for line in lines:
                print(line)
        else:
            warn("暂无日志。")
        return 0
    if cmd == "backup":
        print()
        return do_backup()
    if cmd == "install":
        return do_install(Path(target) if target else None, shortcuts=shortcuts)
    if cmd == "package":
        return do_package(Path(out_dir) if out_dir else None)

    err(f"未知命令：{cmd}")
    print(USAGE)
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except KeyboardInterrupt:
        print("\n已中断。")
        sys.exit(130)
