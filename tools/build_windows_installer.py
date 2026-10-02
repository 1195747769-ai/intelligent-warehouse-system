"""Build the offline Windows installer and portable ZIP using the existing runtime."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from launcher import INSTALL_DIRS, INSTALL_FILES, _app_version

EXTRA_FILES = ('installer/Install.ps1', 'installer/Uninstall.ps1', 'tools/install_ai.py')
REQUIRED = ('server.py', 'intake.py', 'local_ai.py', 'launcher.py', 'desktop_launcher.py',
            'requirements.txt', 'LICENSE', '安装.bat', 'static/index.html', 'static/app.js',
            'static/style.css', 'static/tokens.css', 'static/univer-preview.js', *EXTRA_FILES)
PRIVATE = {'data', 'demo-data', 'backups', '.run', '.venv', 'local-ai', '__pycache__'}


def sha256(path: Path) -> str:
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def validate_runtime(source: Path) -> tuple[int, int, int]:
    """Reject missing, old, non-Windows or non-64-bit Python builds."""
    executable = Path(source) / "python.exe"
    if not executable.is_file():
        raise ValueError(f"Standalone runtime is missing python.exe: {source}")
    probe = (
        "import struct,sys; v=sys.version_info; "
        "print(f'{v.major}.{v.minor}.{v.micro}|{struct.calcsize(\"P\")*8}|{sys.platform}')"
    )
    try:
        result = subprocess.run(
            [str(executable), "-I", "-c", probe],
            capture_output=True,
            text=True,
            timeout=20,
            check=True,
        )
        version_text, bits_text, platform = result.stdout.strip().split("|")
        version = tuple(int(part) for part in version_text.split("."))
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired, ValueError) as exc:
        raise ValueError(f"Cannot run standalone python.exe at {source}: {exc}") from exc
    if len(version) != 3 or version < (3, 11, 0) or bits_text != "64" or platform != "win32":
        raise ValueError(f"Need Windows x64 Python 3.11+, found {result.stdout.strip()}")
    return version  # type: ignore[return-value]


def stage_release(project_root: Path, stage: Path, runtime_source: Path) -> Path:
    """Copy only distributable app files and a relocated, import-tested runtime."""
    project_root, stage, runtime_source = map(Path, (project_root, stage, runtime_source))
    validate_runtime(runtime_source)
    for required in dict.fromkeys((*REQUIRED, *INSTALL_FILES)):
        if not (project_root / required).is_file():
            raise ValueError(f"Release is missing {required}")
    if stage.exists() and any(stage.iterdir()):
        raise ValueError('Release staging directory must be empty')
    stage.mkdir(parents=True, exist_ok=True)
    for base in [*(project_root / name for name in INSTALL_DIRS if name != 'runtime'), runtime_source]:
        if not base.is_dir(): continue
        for path in (base, *base.rglob('*')):
            if '__pycache__' in path.parts or path.suffix == '.pyc': continue
            relative = path.relative_to(base).parts if path != base else ()
            if path.is_symlink() or getattr(path.lstat(), 'st_file_attributes', 0) & 0x400 or any(part.casefold() in PRIVATE for part in relative):
                raise ValueError(f'Linked or private source file: {path}')
    for name in dict.fromkeys((*INSTALL_FILES, '安装.bat', *EXTRA_FILES)):
        source = project_root / name
        if source.is_file():
            (stage / name).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, stage / name)
    for name in INSTALL_DIRS:
        if name == 'runtime': continue  # The explicit runtime_source is the only interpreter shipped.
        source = project_root / name
        if source.is_dir():
            shutil.copytree(
                source, stage / name, dirs_exist_ok=True,
                ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
            )

    target_runtime = stage / "runtime"
    shutil.copytree(
        runtime_source, target_runtime, dirs_exist_ok=True,
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
    )
    licenses = stage / "licenses"
    licenses.mkdir(exist_ok=True)
    shutil.copy2(target_runtime / "LICENSE.txt", licenses / "Python-LICENSE.txt")
    site = target_runtime / "Lib" / "site-packages"
    for name in ('et_xmlfile', 'openpyxl', 'xlrd'):
        distributions = list(site.glob(name + '-*.dist-info'))
        if len(distributions) != 1: raise RuntimeError(f'Need exactly one installed {name} distribution')
        candidates = [distributions[0] / filename for filename in ('LICENSE', 'LICENSE.txt', 'LICENCE.rst')]
        license_file = next((path for path in candidates if path.is_file()), None)
        if not license_file: raise RuntimeError(f'Missing license for {name}')
        shutil.copy2(license_file, licenses / (name + '-' + license_file.name))

    # Test the relocated interpreter, not the developer's installed Python.
    result = subprocess.run(
        [str(target_runtime / "python.exe"), "-I", "-B", "-c", "import sqlite3, ssl, openpyxl, et_xmlfile, xlrd; print('offline runtime ready')"],
        cwd=stage,
        env={**os.environ, "PATH": str(Path(os.environ["WINDIR"]) / "System32")},
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    if result.returncode:
        raise RuntimeError(f"Relocated runtime cannot import app dependencies: {result.stderr.strip()}")
    files = {}
    for path in sorted(stage.rglob('*')):
        if path.is_file():
            relative = path.relative_to(stage).as_posix()
            if path.is_symlink() or any(part.casefold() in PRIVATE for part in Path(relative).parts):
                raise ValueError(f'Private or linked release file: {relative}')
            files[relative] = {'bytes': path.stat().st_size, 'sha256': sha256(path)}
    manifest = {'format': 1, 'version': _app_version(), 'platform': 'Windows 10/11 x64', 'files': files}
    (stage / 'release-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    return stage


def write_payload_zip(stage: Path, destination: Path, top: str = '') -> Path:
    """Keep the application's nested paths inside one IExpress input file."""
    with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as package:
        for path in sorted(Path(stage).rglob("*")):
            if path.is_file():
                relative = path.relative_to(stage).as_posix()
                if any(part in PRIVATE for part in Path(relative).parts): raise ValueError(f'Private file in release: {relative}')
                package.write(path, (top + '/' if top else '') + relative)
    return destination


def build_installer(project_root: Path, output_dir: Path, runtime_source: Path | None = None) -> Path:
    """Build a single-file Windows setup using the system IExpress tool."""
    project_root, output_dir = Path(project_root), Path(output_dir)
    runtime_source = Path(runtime_source or os.environ.get("MATERIALS_RUNTIME_SOURCE") or
                          Path(os.environ.get('LOCALAPPDATA', '')) / 'Programs/IntelligentWarehouse/runtime')
    iexpress = Path(os.environ.get("WINDIR", r"C:\Windows")) / "System32" / "iexpress.exe"
    if not iexpress.is_file():
        raise RuntimeError(f"Windows IExpress is unavailable: {iexpress}")
    for name in ('Install.ps1', 'Uninstall.ps1'):
        if not (project_root / "installer" / name).is_file():
            raise RuntimeError(f"Installer script is missing: installer/{name}")
    output_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="warehouse-iexpress-") as temporary:
        work = Path(temporary)
        try:
            str(work).encode("ascii")
        except UnicodeEncodeError as exc:
            raise RuntimeError("IExpress needs an ASCII build temp path; set TEMP to an ASCII path") from exc
        stage_release(project_root, work / "app", runtime_source)
        inputs = work / "inputs"
        inputs.mkdir()
        write_payload_zip(work / "app", inputs / "payload.zip")
        shutil.copy2(project_root / 'installer/Install.ps1', inputs / 'Install.ps1')
        shutil.copy2(inputs / 'payload.zip', output_dir / f'IntelligentWarehouse-v{_app_version()}-payload.zip')
        write_payload_zip(work / 'app', output_dir / f'IntelligentWarehouse-v{_app_version()}-Windows-x64-Portable.zip', f'IntelligentWarehouse-v{_app_version()}')

        built = work / "IntelligentWarehouse-Setup.exe"
        source_folder = str(inputs) + "\\"
        sed = f"""[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=0
HideExtractAnimation=0
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=%InstallPrompt%
DisplayLicense=%DisplayLicense%
FinishMessage=%FinishMessage%
TargetName=%TargetName%
FriendlyName=%FriendlyName%
AppLaunched=%AppLaunched%
PostInstallCmd=%PostInstallCmd%
AdminQuietInstCmd=%AdminQuietInstCmd%
UserQuietInstCmd=%UserQuietInstCmd%
SourceFiles=SourceFiles
[Strings]
InstallPrompt=
DisplayLicense=
FinishMessage=
TargetName={built}
FriendlyName=Intelligent Warehouse
AppLaunched=cmd.exe /d /c ""%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File Install.ps1 -Interactive"
PostInstallCmd=cmd.exe /d /c exit 0
AdminQuietInstCmd=cmd.exe /d /c ""%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File Install.ps1 -NoLaunch"
UserQuietInstCmd=cmd.exe /d /c ""%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File Install.ps1 -NoLaunch"
FILE0="payload.zip"
FILE1="Install.ps1"
[SourceFiles]
SourceFiles0={source_folder}
[SourceFiles0]
%FILE0%=
%FILE1%=
"""
        sed_path = work / "package.sed"
        sed_path.write_bytes(sed.replace("\n", "\r\n").encode("ascii"))
        result = subprocess.run(
            [str(iexpress), "/N", "/Q", str(sed_path)],
            cwd=work, capture_output=True, text=True, errors="replace", timeout=300, check=False,
        )
        if result.returncode or not built.is_file() or built.stat().st_size < 1_000_000:
            raise RuntimeError(
                f"IExpress build failed (exit {result.returncode}): "
                f"{result.stderr.strip() or result.stdout.strip() or 'setup EXE was not created'}"
            )
        target = output_dir / f'IntelligentWarehouse-v{_app_version()}-Windows-x64-Setup.exe'
        shutil.copy2(built, target)
        artifacts = sorted(output_dir.glob(f'IntelligentWarehouse-v{_app_version()}-*'))
        (output_dir / 'SHA256SUMS.txt').write_text(''.join(sha256(path) + '  ' + path.name + '\n' for path in artifacts if path.is_file()), encoding='utf-8')
        return target


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', type=Path, default=ROOT / 'dist')
    parser.add_argument('--runtime-source', type=Path)
    args = parser.parse_args()
    print(build_installer(ROOT, args.out, args.runtime_source))
