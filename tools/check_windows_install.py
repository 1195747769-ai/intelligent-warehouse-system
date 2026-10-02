"""Real, isolated Windows install/upgrade checks. Never uses the daily database."""
from pathlib import Path
import argparse, base64, hashlib, json, os, socket, subprocess, sys, tempfile, time, urllib.request, uuid, zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from tools.build_windows_installer import stage_release, write_payload_zip

SCRIPT = ROOT / 'installer/Install.ps1'
RUNTIME = Path(os.environ['LOCALAPPDATA']) / 'Programs/IntelligentWarehouse/runtime'

def run_install(payload, target):
    return subprocess.run(['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(SCRIPT),
                           '-InstallDir', str(target), '-PayloadZip', str(payload), '-SkipShortcuts',
                           '-SkipRegistration', '-NoLaunch'], capture_output=True, text=True, encoding='utf-8',
                          errors='replace', timeout=180)

def request(base, path, payload=None, token=None):
    data=json.dumps(payload).encode() if payload is not None else None
    req=urllib.request.Request(base+path,data=data,headers={'Content-Type':'application/json','X-Local-Token':token or ''})
    with urllib.request.urlopen(req, timeout=8) as response: return json.load(response)

def check(setup=None, ai=None, normal=False):
    assert SCRIPT.is_file(), 'Installer has not been implemented'
    with tempfile.TemporaryDirectory(prefix='warehouse-install-check-') as tmp:
        base=Path(tmp)
        stage_release(ROOT, base/'package', RUNTIME)
        payload=write_payload_zip(base/'package', base/'payload.zip')
        target=base/"仓储 演示 ' 路径"
        if setup:
            env={**os.environ,'MATERIALS_INSTALL_DIR':str(target),'MATERIALS_INSTALL_QUIET':'1',
                 'MATERIALS_INSTALL_NO_LAUNCH':'1','MATERIALS_INSTALL_SKIP_SHORTCUTS':'1','MATERIALS_INSTALL_SKIP_REGISTRATION':'1'}
            result=subprocess.run([str(setup),*(() if normal else ('/Q',))],env=env,capture_output=True,text=True,errors='replace',timeout=180)
            # IExpress may return before the extracted installation child has finished.
            deadline=time.monotonic()+160
            while not (target/'release-manifest.json').is_file() and time.monotonic()<deadline: time.sleep(.2)
        else: result=run_install(payload,target)
        assert result.returncode==0, result.stderr+result.stdout
        assert not (target/'data').exists(), 'Fresh package must not import personal stock'
        with socket.socket() as port_socket:
            port_socket.bind(('127.0.0.1',0)); port=port_socket.getsockname()[1]
        env={**os.environ,'PATH':str(Path(os.environ['WINDIR'])/'System32'), 'MATERIALS_PORT':str(port),
             'MATERIALS_DATA':str(target/'data'),'PYTHONIOENCODING':'utf-8'}
        process=subprocess.Popen([str(target/'runtime/python.exe'),str(target/'server.py')],cwd=target,
                                 env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
                                 creationflags=subprocess.CREATE_NO_WINDOW)
        try:
            url=f'http://127.0.0.1:{port}'
            deadline=time.monotonic()+25
            while True:
                try: state=request(url,'/api/state'); break
                except Exception:
                    assert process.poll() is None, 'Installed server exited'
                    if time.monotonic()>deadline: raise
                    time.sleep(.2)
            assert not state['stock'] and not state['documents']
            assert state['version']==json.loads((target/'release-manifest.json').read_text(encoding='utf-8'))['version']
            token=state['token']
            csv='物资编码,物资名称,规格型号,单位,数量,批次,箱号,仓库,库位,库存状态\nCHECK-M1,安装检查物资,M12,个,5,B100,C01,主仓库,A1,AVAILABLE\n'
            receipt=request(url,'/api/import',{'kind':'IN','filename':'check.csv','content':base64.b64encode(csv.encode()).decode(),
                'operator':'CHECK','party':'CHECK','purpose':'isolated install check','external_ref':'CHECK-IN','request_key':str(uuid.uuid4())},token)
            received=request(url,'/api/state')['stock'][0]
            assert received['qty']==5 and received['spec']=='M12' and received['batch']=='B100'
            issue=request(url,'/api/post',{'kind':'OUT','operator':'CHECK','party':'CHECK','purpose':'isolated install check',
                'external_ref':'CHECK-OUT','request_key':str(uuid.uuid4()),'lines':[{'stock_id':received['id'],'qty':2,'remark':'安装检查备注'}]},token)
            assert request(url,'/api/state')['stock'][0]['qty']==3
            assert request(url,'/api/document?id='+str(issue['id']))['lines'][0]['remark']=='安装检查备注'
            (target/'backups').mkdir(); (target/'backups/keep.txt').write_text('retained',encoding='utf-8')
            (target/'local-ai').mkdir(); (target/'local-ai/keep.txt').write_text('retained model',encoding='utf-8')
            before=hashlib.sha256((target/'data/materials.db').read_bytes()).hexdigest()
            result=run_install(payload,target)  # Running app upgrade stops only its owned server.
            assert result.returncode==0, result.stderr+result.stdout
            process.wait(timeout=15)
            assert hashlib.sha256((target/'data/materials.db').read_bytes()).hexdigest()==before
            assert (target/'backups/keep.txt').read_text()=='retained'
            assert (target/'local-ai/keep.txt').read_text()=='retained model'
        finally:
            if process.poll() is None: process.terminate(); process.wait(timeout=10)
        old_server=(target/'server.py').read_bytes()
        # Foreign use of private Python must be refused, even when server.py appears as a data argument.
        foreign=base/'other_tool.py'; foreign.write_text('import time; time.sleep(180)',encoding='utf-8')
        other=subprocess.Popen([str(target/'runtime/python.exe'),str(foreign),str(target/'server.py')],creationflags=subprocess.CREATE_NO_WINDOW)
        try:
            result=run_install(payload,target)
            assert result.returncode!=0 and other.poll() is None and (target/'server.py').read_bytes()==old_server
        finally: other.terminate(); other.wait(timeout=10)
        # A legacy system-Python instance of this exact app may be stopped during upgrade.
        legacy=subprocess.Popen([str(RUNTIME/'python.exe'),str(target/'server.py')],cwd=target,env=env,
                                stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=subprocess.CREATE_NO_WINDOW)
        try:
            time.sleep(1)
            assert legacy.poll() is None
            result=run_install(payload,target)
            assert result.returncode==0,result.stderr+result.stdout
            legacy.wait(timeout=15)
        finally:
            if legacy.poll() is None: legacy.terminate(); legacy.wait(timeout=10)
        for unsafe in ('../escaped.txt','data/materials.db','runtime:evil.txt','runtime/../data/secret.txt'):
            bad=base/'bad.zip'
            with zipfile.ZipFile(bad,'w') as archive: archive.writestr(unsafe,'unsafe')
            result=run_install(bad,target)
            assert result.returncode!=0, 'Unsafe payload accepted: '+unsafe
            assert (target/'server.py').read_bytes()==old_server
        corrupt=base/'corrupt.zip'
        with zipfile.ZipFile(payload) as source, zipfile.ZipFile(corrupt,'w',zipfile.ZIP_DEFLATED) as destination:
            for info in source.infolist(): destination.writestr(info.filename,b'corrupt' if info.filename=='server.py' else source.read(info))
        result=run_install(corrupt,target)
        assert result.returncode!=0 and (target/'server.py').read_bytes()==old_server
        if ai:
            result=subprocess.run([str(target/'runtime/python.exe'),str(target/'tools/install_ai.py'),
                                   '--archive',str(ai),'--target',str(target)],capture_output=True,text=True,
                                  encoding='utf-8',errors='replace',timeout=120,env={**os.environ,'PYTHONIOENCODING':'utf-8'})
            assert result.returncode==0,result.stderr+result.stdout
            imported=json.loads(result.stdout)
            assert imported['model_sha256']=='3e4cb14174460404e7a233e531675303b2fbf7749c02f91864fe311ab6344e4f'
            assert (Path(imported['previous'])/'keep.txt').read_text()=='retained model'
            assert hashlib.sha256((target/'data/materials.db').read_bytes()).hexdigest()==before
        result=subprocess.run(['powershell.exe','-NoProfile','-ExecutionPolicy','Bypass','-File',
                               str(target/'installer/Uninstall.ps1'),'-InstallDir',str(target),'-Quiet'],
                              capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=90)
        assert result.returncode==0,result.stderr+result.stdout
        assert not (target/'server.py').exists() and not (target/'runtime').exists()
        assert hashlib.sha256((target/'data/materials.db').read_bytes()).hexdigest()==before
        assert (target/'backups/keep.txt').is_file()
        assert (target/'local-ai'/('qwen3-4b-q4_k_m.gguf' if ai else 'keep.txt')).is_file()
        assert not (base/'escaped.txt').exists()
    print('PASS: offline runtime, Chinese path, fresh receipt/issue/remark, live/legacy upgrade, foreign-process safety, corrupt/path rejection, uninstall and retained data.')

if __name__=='__main__':
    parser=argparse.ArgumentParser(); parser.add_argument('--setup',type=Path); parser.add_argument('--ai',type=Path); parser.add_argument('--setup-normal',action='store_true'); args=parser.parse_args(); check(args.setup,args.ai,args.setup_normal)
