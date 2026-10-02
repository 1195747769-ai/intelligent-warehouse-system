"""Build the separate 4B AI download; inventory data and the old 0.6B model are excluded."""
import argparse
import hashlib
import json
import re
import sys
import tempfile
import zipfile
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
import install_ai

PACKAGE='IntelligentWarehouse-AI-4B-Optional.zip'


def build_package(source,out,llama_license=None):
    source=Path(source).resolve(); out=Path(out).resolve()
    model=source/install_ai.MODEL
    if not model.is_file() or model.stat().st_size!=install_ai.MODEL_BYTES:
        raise ValueError('4B模型不存在或大小不符 / Missing or incorrect 4B model')
    metadata=json.loads((source/'installation.json').read_text(encoding='utf-8'))
    if not isinstance(metadata,dict) or metadata.get('model_file')!=install_ai.MODEL or metadata.get('model_digest')!='sha256:'+install_ai.MODEL_SHA256:
        raise ValueError('模型元数据不匹配 / Model metadata does not match')
    metadata.update(model_bytes=install_ai.MODEL_BYTES,package=PACKAGE,cpu_fallback=True,gpu_device='auto')
    files={'local-ai/qwen3-template.jinja':source/'qwen3-template.jinja',
           'local-ai/MODEL-LICENSE.txt':source/'MODEL-LICENSE.txt'}
    llama_license=Path(llama_license) if llama_license else next((path for path in (source/'runtime'/'LICENSE-LLAMA.txt',source/'LICENSE-LLAMA.txt') if path.is_file()),None)
    if llama_license is None: raise ValueError('请提供官方MIT许可 --llama-license / Provide the llama.cpp MIT license')
    for runtime in ('runtime','runtime-vulkan'):
        folder=source/runtime
        if runtime=='runtime-vulkan' and not folder.exists(): continue
        available={path.name.casefold():path for path in folder.iterdir() if path.is_file()}
        required=install_ai.CPU_FILES|({'ggml-vulkan.dll'} if runtime=='runtime-vulkan' else set())
        if not required.issubset(available): raise ValueError('运行库不完整 / Incomplete runtime: '+runtime)
        for name,path in available.items():
            backend=re.fullmatch(r'ggml-cpu-([a-z0-9]+)\.dll',name)
            if name in install_ai.LIBRARY_FILES-install_ai.VC_FILES or backend and backend[1] in install_ai.CPU_BACKENDS:
                files['local-ai/'+runtime+'/'+name]=path
            elif re.fullmatch(r'LICENSE(?:-[A-Za-z0-9_-]+)?(?:\.txt)?',path.name,re.I):
                files['local-ai/'+runtime+'/'+path.name]=path
        files['local-ai/'+runtime+'/LICENSE-LLAMA.txt']=llama_license
    if any(not path.is_file() or path.stat().st_size<1 for path in files.values()):
        raise ValueError('运行库、模板或许可文件不存在 / A runtime, template or license file is missing')
    out.mkdir(parents=True,exist_ok=True)
    final=out/PACKAGE
    with tempfile.TemporaryDirectory(prefix='.ai-package-',dir=out) as temporary:
        staged=Path(temporary)/PACKAGE
        model_hash=hashlib.sha256()
        with zipfile.ZipFile(staged,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=1) as archive:
            for name,path in sorted(files.items()): archive.write(path,name)
            archive.writestr('local-ai/installation.json',json.dumps(metadata,ensure_ascii=False,indent=2))
            info=zipfile.ZipInfo.from_file(model,'local-ai/'+install_ai.MODEL)
            info.compress_type=zipfile.ZIP_STORED
            with model.open('rb') as reader,archive.open(info,'w',force_zip64=True) as writer:
                while block:=reader.read(1024*1024):
                    model_hash.update(block); writer.write(block)
        if model_hash.hexdigest()!=install_ai.MODEL_SHA256:
            raise ValueError('4B模型摘要不符，现有安装包未替换 / Model digest mismatch; existing package was preserved')
        with zipfile.ZipFile(staged) as archive: entries=install_ai.package_files(archive)
        archive_hash=hashlib.sha256()
        with staged.open('rb') as reader:
            while block:=reader.read(1024*1024): archive_hash.update(block)
        staged.replace(final)
    return {'archive':str(final),'bytes':final.stat().st_size,'sha256':archive_hash.hexdigest(),
            'model_sha256':model_hash.hexdigest(),'files':len(entries)}


def check():
    """Small local fixture: correct selection, case folding, digest rejection and atomic output."""
    from unittest.mock import patch
    with tempfile.TemporaryDirectory(prefix='warehouse-ai-package-check-') as temporary:
        root=Path(temporary); source=root/'local-ai'; source.mkdir()
        model=b'fake-4b-model'; digest=hashlib.sha256(model).hexdigest()
        (source/install_ai.MODEL).write_bytes(model)
        (source/'qwen3-0.6b-q4_k_m.gguf').write_bytes(b'excluded old model')
        (source/'qwen3-template.jinja').write_text('template',encoding='utf-8')
        (source/'MODEL-LICENSE.txt').write_text('model license',encoding='utf-8')
        (source/'installation.json').write_text(json.dumps({'model_file':install_ai.MODEL,'model_digest':'sha256:'+digest}),encoding='utf-8')
        for runtime in ('runtime','runtime-vulkan'):
            folder=source/runtime; folder.mkdir()
            for name in install_ai.CPU_FILES|{'ggml-cpu-zen4.dll','LICENSE-LLVM-OpenMP'}: (folder/name).write_bytes(b'runtime')
            (folder/'llama-cli.exe').write_bytes(b'excluded cli')
        (source/'runtime-vulkan'/'ggml-vulkan.dll').write_bytes(b'vulkan')
        llama_license=root/'llama-license.txt'; llama_license.write_text('MIT',encoding='utf-8')
        out=root/'release'
        with patch.object(install_ai,'MODEL_BYTES',len(model)),patch.object(install_ai,'MODEL_SHA256',digest):
            result=build_package(source,out,llama_license)
            final=Path(result['archive']); original=final.read_bytes()
            with zipfile.ZipFile(final) as archive:
                names=archive.namelist()
                assert not any('0.6b' in name or 'llama-cli' in name for name in names)
                assert archive.getinfo('local-ai/'+install_ai.MODEL).compress_type==zipfile.ZIP_STORED
                assert archive.getinfo('local-ai/installation.json').compress_type==zipfile.ZIP_DEFLATED
                assert not any(name.rsplit('/',1)[-1].casefold() in install_ai.VC_FILES for name in names)
                assert archive.read('local-ai/'+install_ai.MODEL)==model
            (source/install_ai.MODEL).write_bytes(model[::-1])
            try: build_package(source,out,llama_license)
            except ValueError: pass
            else: raise AssertionError('Incorrect model digest was accepted')
            assert final.read_bytes()==original
    print('PASS: AI package whitelist, CPU/GPU runtimes, licenses, stored model and atomic digest rejection')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check',action='store_true')
    parser.add_argument('--source',type=Path)
    parser.add_argument('--out',type=Path)
    parser.add_argument('--llama-license',type=Path)
    args=parser.parse_args()
    if args.check: check(); return
    if not all((args.source,args.out)):
        parser.error('required: --source --out')
    try: result=build_package(args.source,args.out,args.llama_license)
    except (OSError,ValueError,zipfile.BadZipFile) as error: parser.exit(1,str(error)+'\n')
    print(json.dumps(result,ensure_ascii=False))


if __name__=='__main__': main()
