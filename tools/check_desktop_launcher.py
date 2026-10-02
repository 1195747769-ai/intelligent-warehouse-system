"""Isolated Windows startup/package check; never copies a personal ledger."""
import hashlib
import importlib.util
import json
import os
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
INSTALLED = Path(os.environ['LOCALAPPDATA']) / 'Programs' / 'IntelligentWarehouse'


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def main():
    app = load(ROOT / 'launcher.py', 'launcher')
    assert {'local_ai.py', 'desktop_launcher.py', 'intake.py', '安装.bat'} <= set(app.INSTALL_FILES), 'Incomplete release whitelist'
    assert {'runtime', 'static', 'vendor', 'licenses'} <= set(app.INSTALL_DIRS), 'Missing offline runtime/license directories'
    with tempfile.TemporaryDirectory(prefix='warehouse-desktop-') as temporary:
        base = Path(temporary)
        working = base / "仓储 演示 ' 引号"
        working.mkdir()
        for name in app.INSTALL_FILES:
            src = ROOT / name
            assert src.is_file(), f'Missing core release file: {name}'
            destination = working / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, destination)
        for name in app.INSTALL_DIRS:
            source = INSTALLED / name if name in ('runtime', 'licenses') else ROOT / name
            shutil.copytree(source, working / name, ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
        for name in ('data', 'backups', '.run', '.venv', 'demo-data', 'local-ai'):
            (working / name).mkdir(exist_ok=True)
            (working / name / 'PRIVATE.txt').write_text('DO NOT DISTRIBUTE', encoding='utf-8')
        runtime = working / 'runtime' / 'python.exe'
        env = {**os.environ, 'PATH': str(Path(os.environ['WINDIR']) / 'System32'), 'MATERIALS_PYTHON': sys.executable,
               'MATERIALS_DATA': str(base / 'wrong-shared-data'), 'PYTHONDONTWRITEBYTECODE': '1',
               'PYTHONUTF8': '1', 'PYTHONIOENCODING': 'utf-8'}
        command = [str(runtime), str(working / 'launcher.py')]
        selected = subprocess.run([str(runtime), '-c', 'import launcher; print(launcher.ensure_runtime(auto_install=False)[0])'],
                                  cwd=working, env=env, capture_output=True, text=True, encoding='utf-8', timeout=25)
        assert selected.returncode == 0 and selected.stdout.strip() == str(runtime), selected.stdout + selected.stderr
        wrapper = base / 'finder.cmd'
        wrapper.write_text('@echo off\nchcp 65001 >nul\ncall "' + str(working / '_find-python.cmd') + '"\necho %PYCMD%\n', encoding='utf-8')
        found = subprocess.run(['cmd.exe', '/d', '/c', str(wrapper)], cwd=working, env={**env, 'MATERIALS_PYTHON': 'missing'},
                               capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=25)
        assert found.stdout.strip().strip('"') == str(runtime), found.stdout + found.stderr
        output = base / 'release'
        packaged = subprocess.run([*command, 'package', '--out', str(output)], cwd=working, env=env,
                                 capture_output=True, text=True, encoding='utf-8', timeout=90)
        assert packaged.returncode == 0, packaged.stdout + packaged.stderr
        archive = next(output.glob('*.zip'))
        original_hash = hashlib.sha256(archive.read_bytes()).hexdigest()
        with zipfile.ZipFile(archive) as package:
            names = package.namelist()
            assert any(name.endswith('/runtime/pythonw.exe') for name in names)
            assert any(name.endswith('/local_ai.py') for name in names)
            assert not any('/PRIVATE.txt' in name for name in names), 'Personal/test data leaked into package'
            manifest_name = next((name for name in names if name.endswith('/release-manifest.json')), None)
            assert manifest_name, 'Offline ZIP is missing the installer integrity manifest'
            manifest = json.loads(package.read(manifest_name))
            prefix = manifest_name.rsplit('/', 1)[0] + '/'
            assert manifest['format'] == 1 and manifest['platform'] == 'Windows 10/11 x64'
            assert set(manifest['files']) == {name[len(prefix):] for name in names if name != manifest_name}
            for name, recorded in manifest['files'].items():
                content = package.read(prefix + name)
                assert recorded == {'bytes': len(content), 'sha256': hashlib.sha256(content).hexdigest()}, name
            (working / 'release-manifest.json').write_bytes(package.read(manifest_name))
        installed = base / "安装 目录 ' 示例"
        copied = subprocess.run([*command, 'install', '--target', str(installed), '--no-shortcuts'], cwd=working, env=env,
                                capture_output=True, text=True, encoding='utf-8', timeout=180)
        assert copied.returncode == 0 and (installed / 'desktop_launcher.py').is_file(), copied.stdout + copied.stderr
        launcher = load(working / 'launcher.py', 'launcher')
        link = base / "快捷方式 ' 示例.lnk"
        assert launcher._create_shortcut(link, working / 'runtime/pythonw.exe', working, '仓储', '"' + str(working / 'desktop_launcher.py') + '"')
        script = "[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); $s = (New-Object -ComObject WScript.Shell).CreateShortcut('" + str(link).replace("'", "''") + "'); @{target=$s.TargetPath; arguments=$s.Arguments} | ConvertTo-Json"
        shortcut = subprocess.run(['powershell.exe', '-NoProfile', '-Command', script], capture_output=True, text=True, encoding='utf-8', timeout=20)
        actual = json.loads(shortcut.stdout)
        assert Path(actual['target']) == working / 'runtime/pythonw.exe' and 'desktop_launcher.py' in actual['arguments'], actual
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            port = probe.getsockname()[1]
        try:
            desktop_command = [str(working / 'runtime/pythonw.exe'), str(working / 'desktop_launcher.py'), '--port', str(port), '--no-browser']
            started = subprocess.run(desktop_command, cwd=working, env=env, timeout=50)
            assert started.returncode == 0, (working / '.run/launcher-start.log').read_text(encoding='utf-8')
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/state', timeout=5) as response:
                assert response.status == 200
            first_pid = json.loads((working / '.run/server.json').read_text(encoding='utf-8'))['pid']
            assert subprocess.run(desktop_command, cwd=working, env=env, timeout=30).returncode == 0
            assert json.loads((working / '.run/server.json').read_text(encoding='utf-8'))['pid'] == first_pid, 'Duplicate server spawned'
            assert (working / 'data/materials.db').is_file() and not (base / 'wrong-shared-data').exists()
        finally:
            stopped = subprocess.run([*command, 'stop', '--port', str(port)], cwd=working, env=env,
                                     capture_output=True, text=True, encoding='utf-8', timeout=40)
            assert stopped.returncode == 0, stopped.stdout + stopped.stderr
        foreign_script = base / 'other.py'
        foreign_script.write_text('import time; time.sleep(120)', encoding='utf-8')
        foreign = subprocess.Popen([str(runtime), str(foreign_script), str(working/'server.py')], creationflags=subprocess.CREATE_NO_WINDOW)
        try:
            launcher.write_state({'pid':foreign.pid,'spawn_pid':foreign.pid,'port':port})
            assert not launcher.owns_server(foreign.pid)
            assert launcher.do_stop(port)==0 and foreign.poll() is None
        finally:
            foreign.terminate(); foreign.wait(timeout=10)
        # Corrupt private dependencies must fail rather than silently using machine Python.
        private_xlrd = working / 'runtime/Lib/site-packages/xlrd'
        assert private_xlrd.resolve().is_relative_to(base.resolve())
        private_xlrd.rename(private_xlrd.with_name('xlrd-missing'))
        rejected = subprocess.run([*command, 'package', '--out', str(output)], cwd=working, env=env,
                                 capture_output=True, text=True, encoding='utf-8', timeout=30)
        assert rejected.returncode != 0 and hashlib.sha256(archive.read_bytes()).hexdigest() == original_hash
        selected = subprocess.run([str(runtime), '-c', 'import launcher; assert launcher.ensure_runtime(auto_install=False)[0] is None'],
                                  cwd=working, env=env, timeout=25)
        assert selected.returncode == 0, 'Broken private runtime fell back to system Python'
        desktop = load(working / 'desktop_launcher.py', 'desktop_launcher')
        with patch.object(desktop, 'show_error') as dialog:
            assert desktop.main(['--port', str(port), '--no-browser']) != 0
            assert dialog.call_count == 1
        assert '.run' in (working / '.run/launcher-start.log').read_text(encoding='utf-8')
        # A live WAL writer must be backed up through SQLite, without copying a partial database.
        with sqlite3.connect(launcher.DB_FILE) as writer:
            writer.execute('PRAGMA journal_mode=WAL')
            writer.execute('CREATE TABLE backup_check(value TEXT)')
            writer.execute("INSERT INTO backup_check VALUES('committed')"); writer.commit()
            writer.execute("INSERT INTO backup_check VALUES('uncommitted')")
            assert launcher.do_backup()==0
            archive=max(launcher.BACKUP_DIR.glob('materials-backup-*.zip'),key=lambda path:path.stat().st_mtime)
            with zipfile.ZipFile(archive) as saved:
                assert not any(name.endswith(('-wal','-shm','-journal')) for name in saved.namelist())
                saved.extract('data/materials.db',base/'restore')
            with sqlite3.connect(base/'restore/data/materials.db') as restored:
                assert restored.execute('SELECT value FROM backup_check').fetchall()==[('committed',)]
                assert restored.execute('PRAGMA quick_check').fetchone()[0]=='ok'
            writer.rollback()
        writer.close(); restored.close()
    print('PASS: private runtime, Chinese/space/quote paths, offline ZIP, desktop launch, duplicate reuse, failure logging')


if __name__ == '__main__':
    main()
