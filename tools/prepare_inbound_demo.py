"""Start a separate, explicitly fictional demonstration ledger. Never reset existing data."""
import argparse
import json
import os
import sys
import urllib.request
import webbrowser
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]


def demo_directory(root):
    return Path(root)/'demo-data'


def prepare(root=ROOT):
    destination=demo_directory(root).resolve()
    if destination == (Path(root)/'data').resolve(): raise ValueError('演示目录不能指向正式数据库')
    os.environ['MATERIALS_DATA']=str(destination)
    os.environ['MATERIALS_DEMO_MODE']='1'
    os.environ['MATERIALS_PORT']='8766'
    sys.path.insert(0,str(ROOT))
    import server as app
    app.DATA=destination
    if (destination/'materials.db').exists(): return app
    if destination.exists() and any(destination.iterdir()): raise ValueError('演示目录已有文件，已保留，请人工检查')
    app.init()
    rows=[
        dict(code='DEMO-ONLY-CABLE',name='演示电缆',spec='4×16',qty='120',unit='米',box='DEMO-B01'),
        dict(code='DEMO-ONLY-BOLT',name='演示螺栓',spec='M12',qty='100',unit='套',box='DEMO-B02'),
        dict(code='DEMO-ONLY-SEAL',name='演示密封圈',spec='',qty='8',unit='个',box='DEMO-B03'),
    ]
    p=dict(kind='IN',inputs=[dict(source='manual',role='packing_detail',rows=rows)],operator='演示库管',party='虚构示范厂家',
           arrival_date='2026-09-30',segment_required=True,external_ref='DEMO-ONLY-INIT',request_key='demo-only-seed-v1',
           defaults=dict(package='A1',batch='DEMO-ONLY-初始批次',warehouse='演示仓库',bin='演示区01',state='AVAILABLE'))
    result=app.preview_post(p)
    if result['errors']: raise ValueError('\n'.join(result['errors']))
    p['recognition_id']=result['recognition_id']
    app.import_post(p)
    return app


def main():
    args=argparse.ArgumentParser(description=__doc__)
    args.add_argument('--serve',action='store_true')
    args.add_argument('--no-browser',action='store_true')
    options=args.parse_args()
    app=prepare()
    if not options.serve:
        print('演示数据已就绪：'+str(app.DATA));return
    url='http://127.0.0.1:8766/warehouse'
    try:
        server=app.ThreadingHTTPServer(('127.0.0.1',8766),app.Handler)
    except OSError:
        with urllib.request.urlopen('http://127.0.0.1:8766/api/state',timeout=3) as response:
            if not json.load(response).get('demo_mode'): raise ValueError('8766端口已被其他服务使用')
        if not options.no_browser: webbrowser.open(url)
        return
    if not options.no_browser: webbrowser.open(url)
    server.serve_forever()


if __name__=='__main__': main()
