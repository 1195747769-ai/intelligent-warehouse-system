"""Install the optional offline model without touching warehouse data."""
import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import tempfile
import uuid
import zipfile
from pathlib import Path, PurePosixPath

MODEL='qwen3-4b-q4_k_m.gguf'
MODEL_BYTES=2497280480
MODEL_SHA256='3e4cb14174460404e7a233e531675303b2fbf7749c02f91864fe311ab6344e4f'
ROOT_FILES={MODEL,'qwen3-template.jinja','installation.json','MODEL-LICENSE.txt'}
CPU_FILES={'llama-server.exe','llama-server-impl.dll','llama-common.dll','llama.dll','ggml.dll','ggml-base.dll','ggml-cpu-x64.dll','libomp.dll','mtmd.dll'}
VC_FILES={'msvcp140.dll','vcruntime140.dll','vcruntime140_1.dll'}
LIBRARY_FILES=CPU_FILES|VC_FILES|{'ggml-rpc.dll','ggml-vulkan.dll','vulkan-1.dll'}
CPU_BACKENDS={'alderlake','cannonlake','cascadelake','cooperlake','haswell','icelake','ivybridge','piledriver','sandybridge','sapphirerapids','skylakex','sse42','x64','zen4'}


def package_files(archive):
    """Reject paths before extraction; only the model and its native runtime are allowed."""
    files={}
    entries=archive.infolist()
    if len(entries)>150: raise ValueError('AI包文件过多 / Too many archive entries')
    for info in entries:
        name=info.filename
        parts=name.rstrip('/').split('/')
        if '\\' in name or any(part in ('','.','..') or ':' in part or part.endswith((' ','.')) for part in parts):
            raise ValueError('AI包包含不安全路径 / Unsafe archive path')
        mode=info.external_attr>>16
        if stat.S_ISLNK(mode) or info.flag_bits&1 or info.compress_type not in (zipfile.ZIP_STORED,zipfile.ZIP_DEFLATED):
            raise ValueError('AI包不支持链接、加密或特殊压缩文件 / Links, encrypted entries and unsupported compression are not allowed')
        if info.is_dir():
            if tuple(parts) not in (('local-ai',),('local-ai','runtime'),('local-ai','runtime-vulkan')):
                raise ValueError('AI包包含未允许目录 / Directory is not allowed')
            continue
        if len(parts)==2 and parts[0]=='local-ai':
            allowed=parts[1] in ROOT_FILES
        elif len(parts)==3 and parts[0]=='local-ai' and parts[1] in ('runtime','runtime-vulkan'):
            base=parts[2]
            backend=re.fullmatch(r'ggml-cpu-([a-z0-9]+)\.dll',base.casefold())
            binary=base.casefold() in LIBRARY_FILES or backend and backend[1] in CPU_BACKENDS
            allowed=binary or re.fullmatch(r'LICENSE(?:-[A-Za-z0-9_-]+)?(?:\.txt)?',base,re.I)
            if binary: name='/'.join(parts[:-1]+[base.casefold()])
        else: allowed=False
        limit=MODEL_BYTES if parts[-1]==MODEL else 1024*1024 if len(parts)==2 else 128*1024*1024
        if not allowed or name.casefold() in files or info.file_size<1 or info.file_size>limit:
            raise ValueError('AI包包含未允许、重复或过大文件 / File is not allowed, duplicated or too large')
        files[name.casefold()]=(name,info)
    required={('local-ai/'+name).casefold() for name in ROOT_FILES}|{'local-ai/runtime/'+name for name in CPU_FILES}
    if not required.issubset(files):
        raise ValueError('AI包不完整，必须包含CPU运行库、模型和许可证 / Incomplete AI package')
    if any(name.startswith('local-ai/runtime-vulkan/') for name,_ in files.values()):
        gpu={'local-ai/runtime-vulkan/'+name for name in CPU_FILES|{'ggml-vulkan.dll'}}
        if not gpu.issubset(files):
            raise ValueError('AI显卡运行库不完整 / Incomplete GPU runtime')
    return [entry for entry in files.values()]


def system_vc_available():
    if os.name!='nt': return False
    import ctypes
    try:
        system=Path(os.environ.get('WINDIR','C:/Windows'))/'System32'
        for name in VC_FILES: ctypes.WinDLL(str(system/name))
        return True
    except OSError: return False


def install_ai(archive_path,target):
    target=Path(target).resolve()
    if not (target/'server.py').is_file() or not (target/'local_ai.py').is_file():
        raise ValueError('请先安装智能仓储核心程序，再安装AI包 / Install the core application first')
    destination=target/'local-ai'
    if destination.resolve()!=destination or destination.is_symlink():
        raise ValueError('AI目标目录不能是链接 / AI destination must not be a link')
    with zipfile.ZipFile(archive_path) as archive:
        files=package_files(archive)
        bundled={name.casefold() for name,_ in files}
        runtimes={'runtime'}|({'runtime-vulkan'} if any('runtime-vulkan/' in name for name in bundled) else set())
        app_local=all({'local-ai/'+runtime+'/'+name for name in VC_FILES}.issubset(bundled) for runtime in runtimes)
        if not app_local and not system_vc_available():
            raise ValueError('AI需要微软 Visual C++ x64 运行库，请先从官方地址安装后重试： https://aka.ms/vc14/vc_redist.x64.exe 。核心仓储可继续离线使用，原模型未覆盖。')
        metadata=json.loads(archive.read('local-ai/installation.json'))
        if not isinstance(metadata,dict) or metadata.get('model_file')!=MODEL or metadata.get('model_bytes')!=MODEL_BYTES or metadata.get('model_digest')!='sha256:'+MODEL_SHA256:
            raise ValueError('AI包型号或摘要不匹配 / Model metadata does not match')
        expanded=sum(info.file_size for _,info in files)
        if shutil.disk_usage(target).free<expanded+64*1024*1024:
            raise ValueError('安装AI所需磁盘空间不足，请至少预留3GB / Insufficient free disk space; allow at least 3 GB')
        with tempfile.TemporaryDirectory(prefix='.local-ai-install-',dir=target) as temporary:
            stage=Path(temporary)
            model_hash=hashlib.sha256()
            for name,info in files:
                output=stage.joinpath(*PurePosixPath(name).parts)
                output.parent.mkdir(parents=True,exist_ok=True)
                with archive.open(info) as source,output.open('wb') as writer:
                    while block:=source.read(1024*1024):
                        writer.write(block)
                        if name=='local-ai/'+MODEL: model_hash.update(block)
            model=stage/'local-ai'/MODEL
            if model.stat().st_size!=MODEL_BYTES or model_hash.hexdigest()!=MODEL_SHA256:
                raise ValueError('AI模型校验失败，原模型未覆盖 / Model verification failed; existing model was preserved')
            backup=target/('.local-ai-previous-'+uuid.uuid4().hex[:12]) if destination.exists() else None
            if backup: destination.rename(backup)
            try: (stage/'local-ai').rename(destination)
            except OSError:
                if backup: backup.rename(destination)
                raise
    return {'installed':str(destination),'previous':str(backup) if backup else None,'model_sha256':MODEL_SHA256}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive',required=True,type=Path)
    parser.add_argument('--target',type=Path,default=Path(__file__).resolve().parents[1])
    args=parser.parse_args()
    try: result=install_ai(args.archive,args.target)
    except (OSError,ValueError,KeyError,zipfile.BadZipFile) as error:
        parser.exit(1,'AI安装未完成：'+str(error)+'\n')
    print(json.dumps(result,ensure_ascii=False))


if __name__=='__main__': main()
