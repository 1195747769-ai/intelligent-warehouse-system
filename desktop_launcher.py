"""Console-free desktop entry using the existing local service controller."""
import ctypes
import os
import sys
import traceback
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime
from pathlib import Path

import launcher

ROOT = Path(__file__).resolve().parent
LOG = ROOT / '.run' / 'launcher-start.log'


def show_error(message):
    if os.name == 'nt':
        ctypes.windll.user32.MessageBoxW(None, message, '智能仓储系统 · 启动未完成', 0x10)


def main(argv=None):
    result = 1
    details = ''
    try:
        LOG.parent.mkdir(parents=True, exist_ok=True)
        with LOG.open('a', encoding='utf-8') as output, redirect_stdout(output), redirect_stderr(output):
            print(f'\n===== 桌面启动 {datetime.now():%Y-%m-%d %H:%M:%S} =====')
            try:
                result = launcher.main([str(__file__), 'start', *(sys.argv[1:] if argv is None else argv)])
            except Exception:
                traceback.print_exc()
            if result:
                print(f'启动未完成。请查看日志：{LOG}')
    except OSError as exc:
        details = f'\n无法写入启动日志：{exc}'
    if result:
        show_error(f'系统未能启动。请重新运行安装包修复，或将启动日志提供给维护人员。\n日志位置：{LOG}{details}')
    return result


if __name__ == '__main__':
    sys.exit(main())
