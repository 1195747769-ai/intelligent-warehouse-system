"""Local materials ledger. Exact quantities, transactional posting, immutable documents."""
import base64, csv, hashlib, hmac, io, json, os, re, secrets, sqlite3, sys, threading, zipfile
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs
import openpyxl

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get('MATERIALS_DATA', ROOT / 'data'))
SCALE = 1000000
STATES = ('AVAILABLE', 'PENDING', 'QUARANTINE', 'SPARE')
TRANSPORT = ('PLANNED', 'DISPATCHED', 'SEA', 'CUSTOMS', 'RELEASED', 'ROAD', 'ARRIVED')
TOKEN = secrets.token_urlsafe(32)
APP_VERSION = '0.1.1'  # keep in sync with CHANGELOG.md

# The project uses a fixed set of equipment packages/sections.  Keep the
# short A-code stable for filtering and documents, while exposing the formal
# Chinese and English names to both local and international users.
SEGMENTS = (
    ('A1', '光伏组件及组件配套材料', 'PV Modules and Module Accessories'),
    ('A2', '单轴跟踪支架及跟踪控制系统', 'Single-Axis Tracker Mounting System and Tracker Control System'),
    ('A3', '光伏组串式逆变器', 'PV String Inverters'),
    ('A4', 'PV箱式变压器及箱变成套设备', 'PV Box-Type Transformers and Packaged Substation Equipment'),
    ('A5', 'BESS储能区设备', 'BESS Area Equipment'),
    ('A6', '高低压配电及动力控制设备', 'HV/LV Power Distribution and Power Control Equipment'),
    ('A7', '综合自动化系统', 'Integrated Automation System'),
    ('A8', '光伏及BESS区域辅助变压器', 'Auxiliary Transformers for PV and BESS Areas'),
    ('A9', '直流及UPS系统', 'DC and UPS Systems'),
    ('A10', '光伏专用缆', 'PV Cables'),
    ('A11', '全站电力、控制、通信光缆及附件', 'Plant-Wide Power, Control and Fiber-Optic Communication Cables and Accessories'),
    ('A12', 'HPC/PPC、AGC/AVC及并网控制系统', 'HPC/PPC, AGC/AVC and Grid-Connection Control Systems'),
    ('A13', '全站SCADA及数据管理系统', 'Plant-Wide SCADA and Data Management System'),
    ('A14', '气象站', 'Meteorological Station'),
    ('A15', '132kV主变压器', '132 kV Main Transformers'),
    ('A16', '无功补偿装置', 'Reactive Power Compensation Equipment'),
)
SEGMENT_CODES = {code for code, _, _ in SEGMENTS}
SEGMENT_NAMES = {code: {'zh': zh, 'en': en} for code, zh, en in SEGMENTS}

def now(): return datetime.now(timezone.utc).isoformat(timespec='seconds')
def clean(v): return str(v if v is not None else '').strip()
def required(v, label, max_len=250):
    s = clean(v)
    if not s or len(s) > max_len: raise ValueError('必填或过长 / Required or too long: ' + label)
    return s
def units(v, positive=True):
    try: d = Decimal(clean(v))
    except InvalidOperation: raise ValueError('数量格式错误 / Invalid quantity')
    if not d.is_finite() or (positive and d <= 0) or abs(d) > Decimal('1000000000') or d*SCALE != (d*SCALE).to_integral_value():
        raise ValueError('数量须为正数且最多六位小数 / Positive quantity, maximum six decimal places')
    return int(d*SCALE)
def number(v): return float(Decimal(v)/SCALE)
def parse_box_contents(text):
    """Read simple one-item-per-line contents from a box remark.

    These are child details for display and traceability. They do not create
    independent stock balances; the parent carton line remains the quantity
    that is posted to inventory.
    """
    result=[]
    for raw in clean(text).splitlines():
        line=raw.strip().strip('（）()[]【】,，;；')
        if not line: continue
        m=re.match(r'^(.*?)(\d+(?:\.\d+)?)\s*(件|个|套|箱|台|根|米|块|卷|包|只|把|组|张|支|颗|枚|片|对|批|吨|kg|KG|m|M)\s*[）)]?$',line,re.I)
        if not m: continue
        desc=clean(m.group(1)).strip('：: -')
        if not desc: continue
        code_match=re.search(r'(?<![A-Za-z0-9])([A-Z]{2,}[A-Z0-9]*(?:-[A-Z0-9]+)+)',desc)
        code=code_match.group(1) if code_match else ''
        name=clean(desc.replace(code,' ')).strip(' -') if code else desc
        result.append({'name':name,'qty':m.group(2),'unit':m.group(3),'code':code,'raw':line})
    return result
def legacy_device_code(raw):
    s=clean(raw)
    aliases={'光伏组件':'组件','组件':'组件','支架':'支架','电池':'电池','电池舱':'电池舱','储能':'储能','PCS':'PCS','箱变':'箱变','变压器':'变压器','汇流箱':'汇流箱','逆变器':'逆变器','电缆':'电缆','轨道机器人':'轨道机器人','轮式机器人':'轮式机器人','无人机':'无人机','无人机机场':'无人机机场','水浸传感器':'水浸传感器','摄像头':'摄像头'}
    label=aliases.get(s,s)
    label=re.sub(r'[\\/:*?"<>|]+','',label)
    label=re.sub(r'\s+','',label)
    return label[:40] or '设备'

def generated_batch(p):
    # New UI batches are deliberately short (B01, B02...).  Keep the old
    # device/date form only for legacy direct API callers that still send the
    # deprecated batch_device field; no new receipt can create that form.
    seq=clean(p.get('batch_number') or p.get('batchNumber') or '1')
    try: seq=f'{max(1,int(seq)):02d}'[-2:]
    except (TypeError,ValueError): seq='01'
    legacy_device=clean(p.get('batch_device') or p.get('batchDevice') or p.get('device_type'))
    if legacy_device and not p.get('segment_required'):
        raw_date=clean(p.get('arrival_date') or p.get('batch_date'))
        digits=''.join(ch for ch in raw_date if ch.isdigit())
        yymmdd=(digits[2:8] if len(digits)>=8 else datetime.now().strftime('%y%m%d'))
        return f"{legacy_device_code(legacy_device)}-{yymmdd}-{seq}"
    return f'B{seq}'
class ClosingConnection(sqlite3.Connection):
    def __exit__(self, *args):
        try: return super().__exit__(*args)
        finally: self.close()

def connect():
    DATA.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(DATA/'materials.db', timeout=20, factory=ClosingConnection)
    c.row_factory = sqlite3.Row
    c.execute('PRAGMA foreign_keys=ON')
    c.execute('PRAGMA journal_mode=WAL')
    return c
def init():
    with connect() as c:
        c.executescript('''
CREATE TABLE IF NOT EXISTS items(code TEXT PRIMARY KEY, name TEXT NOT NULL, spec TEXT NOT NULL, unit TEXT NOT NULL, package TEXT NOT NULL, attribute TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS documents(id INTEGER PRIMARY KEY, number TEXT UNIQUE NOT NULL, kind TEXT NOT NULL, external_ref TEXT NOT NULL, operator TEXT NOT NULL, party TEXT NOT NULL, purpose TEXT NOT NULL, created TEXT NOT NULL, arrival_date TEXT NOT NULL DEFAULT '', request_key TEXT UNIQUE NOT NULL, file_hash TEXT, source_path TEXT, reversed_by INTEGER, reverse_of INTEGER UNIQUE);
CREATE UNIQUE INDEX IF NOT EXISTS unique_import_file ON documents(file_hash) WHERE file_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS unique_business_ref ON documents(kind,external_ref) WHERE kind IN ('IN','BASELINE');
CREATE TABLE IF NOT EXISTS lines(id INTEGER PRIMARY KEY, doc_id INTEGER NOT NULL REFERENCES documents(id), code TEXT NOT NULL, name TEXT NOT NULL, spec TEXT NOT NULL, unit TEXT NOT NULL, batch TEXT NOT NULL, box TEXT NOT NULL DEFAULT '', warehouse TEXT NOT NULL, bin TEXT NOT NULL, state TEXT NOT NULL, qty INTEGER NOT NULL, attribute TEXT NOT NULL DEFAULT '', contents TEXT NOT NULL DEFAULT '', source_row INTEGER);
CREATE TABLE IF NOT EXISTS stock(id INTEGER PRIMARY KEY, code TEXT NOT NULL REFERENCES items(code), batch TEXT NOT NULL, box TEXT NOT NULL DEFAULT '', warehouse TEXT NOT NULL, bin TEXT NOT NULL, state TEXT NOT NULL, qty INTEGER NOT NULL CHECK(qty>=0), contents TEXT NOT NULL DEFAULT '', UNIQUE(code,batch,box,warehouse,bin,state));
CREATE TABLE IF NOT EXISTS movements(id INTEGER PRIMARY KEY, doc_id INTEGER NOT NULL REFERENCES documents(id), stock_id INTEGER NOT NULL REFERENCES stock(id), delta INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS design(code TEXT PRIMARY KEY REFERENCES items(code), qty INTEGER NOT NULL CHECK(qty>=0));
CREATE TABLE IF NOT EXISTS changes(id INTEGER PRIMARY KEY, code TEXT NOT NULL REFERENCES design(code), delta INTEGER NOT NULL, reason TEXT NOT NULL, operator TEXT NOT NULL, created TEXT NOT NULL, request_key TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS batches(code TEXT PRIMARY KEY, supplier TEXT NOT NULL, status TEXT NOT NULL, updated TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, batch TEXT NOT NULL, old_status TEXT, new_status TEXT, operator TEXT NOT NULL, note TEXT NOT NULL, created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS admin_actions(id INTEGER PRIMARY KEY, action TEXT NOT NULL, document_id INTEGER NOT NULL, document_number TEXT NOT NULL, reason TEXT NOT NULL, operator TEXT NOT NULL, created TEXT NOT NULL);
''')
        for table,column,definition in [('items','attribute','TEXT NOT NULL DEFAULT \'\''),('documents','arrival_date','TEXT NOT NULL DEFAULT \'\''),('lines','box','TEXT NOT NULL DEFAULT \'\''),('lines','attribute','TEXT NOT NULL DEFAULT \'\''),('lines','contents','TEXT NOT NULL DEFAULT \'\''),('stock','box','TEXT NOT NULL DEFAULT \'\''),('stock','contents','TEXT NOT NULL DEFAULT \'\'')]:
            cols={row['name'] for row in c.execute(f'PRAGMA table_info({table})').fetchall()}
            if column not in cols: c.execute(f'ALTER TABLE {table} ADD COLUMN {column} {definition}')
        # Older trial databases used a stock key without the box number.  A
        # simple ALTER cannot change that UNIQUE constraint, so rebuild the
        # table in place while preserving existing balances and foreign-key
        # names.  This keeps two boxes of the same item as separate positions
        # after an upgrade instead of silently merging them.
        stock_sql=c.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='stock'").fetchone()['sql'] or ''
        compact=''.join(stock_sql.lower().split())
        if 'unique(code,batch,box,warehouse,bin,state)' not in compact:
            c.commit()
            c.execute('PRAGMA foreign_keys=OFF')
            c.execute('''CREATE TABLE stock_new(id INTEGER PRIMARY KEY, code TEXT NOT NULL REFERENCES items(code), batch TEXT NOT NULL, box TEXT NOT NULL DEFAULT '', warehouse TEXT NOT NULL, bin TEXT NOT NULL, state TEXT NOT NULL, qty INTEGER NOT NULL CHECK(qty>=0), contents TEXT NOT NULL DEFAULT '', UNIQUE(code,batch,box,warehouse,bin,state))''')
            c.execute('''INSERT INTO stock_new(id,code,batch,box,warehouse,bin,state,qty,contents)
                         SELECT id,code,batch,COALESCE(box,''),warehouse,bin,state,qty,COALESCE(contents,'') FROM stock''')
            c.execute('DROP TABLE stock')
            c.execute('ALTER TABLE stock_new RENAME TO stock')
            c.execute('PRAGMA foreign_keys=ON')
        # Upgrade earlier trial imports: turn preserved long remarks into
        # structured child details without changing the parent stock quantity.
        for row in c.execute("SELECT s.id,s.contents,i.attribute FROM stock s JOIN items i ON i.code=s.code WHERE COALESCE(i.attribute,'')<>''").fetchall():
            child=parse_box_contents(row['attribute'])
            if child: c.execute('UPDATE stock SET contents=? WHERE id=?',(json.dumps(child,ensure_ascii=False),row['id']))
        for row in c.execute("SELECT l.id,l.contents,l.attribute FROM lines l WHERE COALESCE(l.attribute,'')<>''").fetchall():
            child=parse_box_contents(row['attribute'])
            if child: c.execute('UPDATE lines SET contents=? WHERE id=?',(json.dumps(child,ensure_ascii=False),row['id']))
        # A previous trial could leave item-master rows behind after its only
        # receipt was removed.  Remove only truly orphaned zero-balance items;
        # design baselines, changes, other lines and non-zero stock preserve
        # their item records.
        for row in c.execute('SELECT code FROM items').fetchall():
            cleanup_orphan_item(c,row['code'])

ALIASES = {
'code':['物资编码','材料编码','设备编码','物料编码','编码','料号','code','itemcode','materialcode','sku','partnumber'],
 'name':['物资名称','材料名称','设备名称','品名','名称','零件名称','货物名称','name','description','itemname','product'],
 'spec':['规格型号','规格','型号','零件图号','图号','spec','specification','model'],
 'unit':['单位','计量单位','unit','uom'],
 'qty':['数量','入库数量','实收数量','设计数量','总量','quantity','qty','receivedquantity'],
 'warehouse':['仓库','库房','warehouse'], 'bin':['库位','货位','位置','bin','location','binlocation'],
 'batch':['批次','发运批次','批次号','合同批次','batch','lot','lotnumber'], 'box':['箱号','箱编号','箱件号','箱号/箱件号','装箱编号','装箱单号','箱单号','box','carton','cartonno'], 'package':['合同','合同号','合同编号','合同名称','设备包','设计项','标段','项目号','项目名称','package'], 'attribute':['设备属性','厂家属性','装配描述','装配说明','备注','说明','attribute','attributes','remarks','notes'],
 'state':['质量状态','库存状态','state','status']}
def norm(v): return ''.join(ch for ch in clean(v).lower() if ch.isalnum())
def contract_numbers(rows):
    found=[]
    for row in rows:
        for value in row:
            text=clean(value)
            if not text: continue
            match=re.search(r'(?:合同编号|合同号|合同)\s*[:：]?\s*([A-Za-z0-9][A-Za-z0-9._/-]*)',text)
            if match and match.group(1) not in found: found.append(match.group(1))
    return found

def parse_file(p):
    filename = required(p.get('filename'), '文件名 / Filename')
    try: raw = base64.b64decode(p.get('content',''), validate=True)
    except Exception: raise ValueError('文件编码无效 / Invalid file encoding')
    if not raw or len(raw)>12*1024*1024: raise ValueError('文件为空或超过12MB / Empty file or exceeds 12 MB')
    ext=Path(filename).suffix.lower()
    if ext == '.xlsx':
        try:
            with zipfile.ZipFile(io.BytesIO(raw)) as z:
                if sum(i.file_size for i in z.infolist())>80*1024*1024: raise ValueError('解压文件过大 / Expanded workbook too large')
            # Normal mode is intentional here: manufacturer workbooks often use
            # merged cells for headings and section context. We preserve the
            # source row and never evaluate formulas.
            wb=openpyxl.load_workbook(io.BytesIO(raw), read_only=False, data_only=False)
            sheets=wb.sheetnames
            sheet=p.get('sheet') or sheets[0]
            if sheet not in sheets: raise ValueError('工作表不存在 / Sheet not found')
            # A workbook can contain both a carton-level shipment list and
            # one or more packing-detail sheets.  The shipment list carries
            # carton quantities and must never be posted as receipt lines;
            # receipt posting is intentionally limited to the packing-detail
            # sheet selected by the operator.
            sheet_label=sheet.lower()
            if p.get('kind','IN')=='IN' and ('发货' in sheet_label or 'shipment' in sheet_label):
                raise ValueError('当前工作表是箱级发货清单，仅用于物流和到货核对；请切换到装箱清单_箱内详件入库 / This is a carton-level shipment sheet for logistics reconciliation; select the packing-detail sheet for receipt posting')
            ws=wb[sheet]
            # Contract number is often printed in the cover/header area rather
            # than repeated in every packing-detail row. Read the small cover
            # area of every worksheet so a workbook with一期/二期 sheets can
            # still provide one unambiguous contract default.
            workbook_meta=[]
            for meta_ws in wb.worksheets:
                for row in meta_ws.iter_rows(min_row=1,max_row=min(meta_ws.max_row,25),max_col=min(meta_ws.max_column,40),values_only=True):
                    workbook_meta.append(list(row))
            if ws.max_row and ws.max_row>10002: raise ValueError('最多10000条明细 / Maximum 10000 rows')
            rows=[]
            for row in ws.iter_rows():
                if len(rows)>10001: raise ValueError('行数过多 / Too many rows')
                rows.append([{'formula':True} if cell.data_type=='f' else clean(cell.value) for cell in row[:80]])
            wb.close()
        except ValueError: raise
        except Exception: raise ValueError('无法读取xlsx / Cannot read workbook')
    elif ext=='.csv':
        try: txt=raw.decode('utf-8-sig')
        except UnicodeDecodeError:
            try: txt=raw.decode('gb18030')
            except UnicodeDecodeError: raise ValueError('请另存为UTF-8 CSV / Please save as UTF-8 CSV')
        rows=list(csv.reader(io.StringIO(txt))); sheets=['CSV']; sheet='CSV'; workbook_meta=rows[:25]
        if p.get('kind','IN')=='IN' and any(token in filename.lower() for token in ('发货','shipment','carton')):
            raise ValueError('当前文件是箱级发货清单，仅用于物流和到货核对；请切换到装箱清单_箱内详件入库 / This is a carton-level shipment file for logistics reconciliation; use the packing-detail file for receipt posting')
        if len(rows)>10002: raise ValueError('最多10000条明细 / Maximum 10000 rows')
    else: raise ValueError('支持xlsx和csv；xls请另存 / Use xlsx or csv; convert legacy xls')
    requested=int(p.get('header',0) or 0)
    if requested<0 or requested>len(rows): raise ValueError('表头行无效 / Invalid header row')
    alias_norms={key:{norm(a) for a in aliases} for key,aliases in ALIASES.items()}
    def infer(row):
        out={}
        for key in ALIASES:
            hits=[i for i,h in enumerate(row) if norm(h) in alias_norms[key]]
            # Attributes may legitimately have both an assembly-description
            # column and a remarks column; prefer the descriptive column.
            out[key]=hits[0] if (len(hits)==1 or (key=='attribute' and hits)) else -1
        return out
    # Factory workbooks repeat the same table header on every packing page.
    # Header 0 means automatic detection; an entered header is still honored
    # when it points at a valid table header.
    candidates=[i for i,row in enumerate(rows) if all(infer(row)[k]>=0 for k in ('name','qty','unit'))]
    if requested:
        chosen=[requested-1] if requested-1 in candidates else candidates
    else:
        chosen=candidates
    if not chosen:
        if '发货' in sheet or 'shipment' in sheet.lower() or 'carton' in sheet.lower():
            raise ValueError('当前工作表是箱级发货清单，仅用于物流和到货核对；请切换到装箱清单_箱内详件入库 / This is a carton-level shipment sheet for logistics reconciliation; select the packing-detail sheet for receipt posting')
        if requested and requested-1<len(rows): chosen=[requested-1]
        else: raise ValueError('未找到包含名称、数量、单位的表头 / Could not find a header with name, quantity and unit')
    headers=[clean(x) for x in rows[chosen[0]]]
    header_norms={norm(h) for h in headers if clean(h)}
    # Shipment lists describe cartons and transport parameters.  Packing
    # sheets describe the item rows inside a carton.  Use strong header
    # markers in addition to the worksheet/file name so a generically named
    # worksheet is still routed safely.
    shipment_markers={norm(x) for x in ('包装类型','箱体尺寸','箱尺寸','外形尺寸','长宽高','毛重','净重','箱数','装箱数','包装参数')}
    sheet_kind='shipment' if any(marker in header_norms for marker in shipment_markers) else 'packing'
    if p.get('kind','IN') in ('IN','BASELINE') and sheet_kind=='shipment':
        raise ValueError('当前工作表是箱级发货清单，仅用于物流和到货核对；请切换到装箱清单_箱内详件入库 / This is a carton-level shipment sheet for logistics reconciliation; select the packing-detail sheet for receipt posting')
    inferred=infer(rows[chosen[0]])
    mapping=p.get('mapping') if p.get('mapping') is not None else inferred
    defaults=dict(p.get('defaults',{}) or {})
    detected_contracts=contract_numbers(workbook_meta if ext=='.xlsx' else rows)
    # A selected fixed segment is authoritative for this receipt.  For legacy
    # API callers that do not select a segment, preserve the old cover-number
    # fallback so existing evidence can still be previewed and tested.
    if not clean(defaults.get('package')) and len(detected_contracts)==1 and not p.get('segment_required'):
        defaults['package']=detected_contracts[0]
    if p.get('kind','IN')=='IN':
        # Factory packing sheets normally contain only source facts.  Apply
        # one receipt-wide batch and location default so the administrator
        # does not have to repeat those fields on every row.
        defaults['batch']=clean(defaults.get('batch')) or generated_batch(p)
        defaults['warehouse']=clean(defaults.get('warehouse')) or '主仓库'
        defaults['bin']=clean(defaults.get('bin')) or '待分配'
        defaults['state']=clean(defaults.get('state')) or 'AVAILABLE'
    data=[]; errors=[]; warnings=[]; generated_codes=set(); reused_codes=set(); generated_by_identity={}; skipped_layout=0; merged_rows=0
    selected_segment=clean(defaults.get('package')).upper()
    if p.get('segment_required') and selected_segment not in SEGMENT_CODES:
        errors.append('请选择固定标段 A1-A16 / Select one fixed segment A1-A16')
    existing_identity={}
    with connect() as c:
        for old in c.execute('SELECT code,name,spec,unit,package,attribute FROM items').fetchall():
            identity=tuple(clean(old[k]) for k in ('name','spec','unit','package','attribute'))
            existing_identity.setdefault(identity,[]).append(old['code'])
    for sec,hrow in enumerate(chosen):
        section_mapping=mapping if p.get('mapping') is not None else infer(rows[hrow])
        # A factory box list may expose both “装配描述” and “备注”.  Keep
        # both columns when mapping is automatic so the long contents of a
        # carton remain available for receipt checking and later lookup.
        attribute_columns=[i for i,h in enumerate(rows[hrow]) if norm(h) in alias_norms['attribute']]
        selected_attribute=int(section_mapping.get('attribute',-1))
        if selected_attribute >= 0 and selected_attribute not in attribute_columns:
            attribute_columns.append(selected_attribute)
        end=chosen[sec+1] if sec+1<len(chosen) else len(rows)
        carry={'package':'','box':''}
        for idx in range(hrow+1,end):
            row=rows[idx]
            if not any(clean(x) for x in row): continue
            record={'source_row':idx+1}
            for key in ALIASES:
                col=int(section_mapping.get(key,-1))
                val=row[col] if 0<=col<len(row) else ''
                if isinstance(val,dict): errors.append(f'第{idx+1}行 / Row {idx+1}: 公式须转为值 / Convert formulas to values'); val=''
                # The operator-selected fixed segment applies to the whole
                # workbook.  Factory cover rows often contain a contract
                # number in the same column; that number must not overwrite
                # the selected A1-A16 segment.
                if key=='package' and clean(defaults.get('package')):
                    record[key]=clean(defaults.get('package'))
                else:
                    record[key]=clean(val) or clean(defaults.get(key,''))
            if attribute_columns:
                attrs=[]
                for col in attribute_columns:
                    val=row[col] if 0<=col<len(row) else ''
                    if isinstance(val,dict):
                        errors.append(f'第{idx+1}行 / Row {idx+1}: 公式须转为值 / Convert formulas to values')
                        continue
                    val=clean(val)
                    if val and val not in attrs: attrs.append(val)
                record['attribute']='；'.join(attrs) or clean(defaults.get('attribute',''))
            record['contents']=parse_box_contents(record.get('attribute',''))
            # Excel users often merge the contract or box cell across several
            # detail rows. openpyxl exposes the merged children as blank cells;
            # carry those two identifiers forward within the current page.
            for key in ('package','box'):
                if record[key]: carry[key]=record[key]
                elif carry[key]: record[key]=carry[key]
            # Packing sheets reserve serial-number-only rows and signature
            # rows inside each page. They are layout rows, not material lines.
            if not any(record[k] for k in ('code','name','qty')): continue
            if not record['name'] and not record['code']: continue
            try: amount=units(record['qty'])
            except (ValueError,TypeError) as e:
                # Footers and page metadata can occupy the table columns. A
                # material line is only actionable when its quantity is numeric;
                # retain a warning so the administrator can inspect it.
                skipped_layout += 1
                continue
            if not record['code'] and record['name']:
                # Many factory lists omit a material code. Give each distinct
                # item a readable code. If the same identity was already
                # received in an earlier batch, reuse its code so cross-batch
                # stock and issue searches still refer to one material.
                identity=tuple(record[k] for k in ('name','spec','unit','package','attribute'))
                basis='|'.join(identity)
                if basis not in generated_by_identity:
                    matches=existing_identity.get(identity,[])
                    if len(matches)==1:
                        generated_by_identity[basis]=matches[0]; reused_codes.add(matches[0])
                    else:
                        seq=len(generated_by_identity)+1
                        prefix=clean(defaults.get('batch')) or 'ITEM'
                        generated_by_identity[basis]=f'{prefix}-{seq:03d}'
                record['code']=generated_by_identity[basis]
                if record['code'] not in reused_codes: generated_codes.add(record['code'])
            record['state']=record['state'] or 'AVAILABLE'
            record['state']={'可用':'AVAILABLE','合格':'AVAILABLE','待检':'PENDING','隔离':'QUARANTINE','不合格':'QUARANTINE','备品':'SPARE','预留备品':'SPARE'}.get(record['state'],record['state'].upper())
            try:
                required(record['code'],'code')
                required(record['name'],'name',2000)
                required(record['unit'],'unit')
                record['amount']=amount
                if p.get('kind','IN')=='IN':
                    for key in ('batch','box','warehouse','bin'): required(record[key],key)
                    if record['state'] not in STATES: raise ValueError('库存状态无效 / Invalid stock state')
            except (ValueError,TypeError) as e: errors.append(f'第{idx+1}行 / Row {idx+1}: {e}')
            data.append(record)
    if generated_codes:
        sample=', '.join(sorted(generated_codes)[:5])
        more='…' if len(generated_codes)>5 else ''
        warnings.append(f'有 {len(generated_codes)} 个物资未提供物资编码，已按到货批次生成可追溯编号（示例 {sample}{more}）；请确认前核对 / {len(generated_codes)} items had no source item code; readable batch-sequence codes were generated. Verify before posting.')
    if reused_codes:
        warnings.append(f'有 {len(reused_codes)} 个无厂家编码物资沿用了既有内部编码，便于跨批次合并查询；请确认前核对 / {len(reused_codes)} code-less items reused existing internal codes for cross-batch grouping; verify before posting.')
    if skipped_layout:
        warnings.append(f'自动忽略 {skipped_layout} 行页眉、签字或分页内容 / Ignored {skipped_layout} header, signature or page-layout rows automatically.')
    if len(detected_contracts)==1 and not clean((p.get('defaults') or {}).get('package')):
        warnings.append(f'已从文件封面识别合同编号 {detected_contracts[0]}，并带入全部箱内明细 / Contract number {detected_contracts[0]} was read from the workbook cover and applied to the detail rows.')
    elif len(detected_contracts)>1 and not clean((p.get('defaults') or {}).get('package')):
        warnings.append('文件中识别到多个合同编号，请在入库前选择一个合同/标段 / Multiple contract numbers were found; select the contract/lot before posting.')
    if not data: errors.append('没有物资明细 / No material rows')
    combined={}
    for r in data:
        key=(r['code'],r['batch'],r['box'],r['warehouse'],r['bin'],r['state'])
        old=combined.get(key)
        if old:
            if any(old[k]!=r[k] for k in ('name','spec','unit')):
                errors.append(f"第{r['source_row']}行与第{old['source_row']}行编码信息冲突；请核对名称/规格/单位 / Conflicting item identity")
            old['amount'] += r['amount']; old['qty']=str(number(old['amount'])); merged_rows += 1
        else:
            combined[key]=r
    data=list(combined.values())
    if merged_rows:
        warnings.append(f'已将 {merged_rows} 行相同物资/批次/库位明细合计数量 / Aggregated {merged_rows} repeated item-position rows into their quantities.')
    # A workbook may legitimately contain both a packing-detail sheet and a
    # shipment/carton sheet. Treat each selected worksheet as its own import
    # while retaining the original workbook as the source evidence.
    digest=hashlib.sha256(raw+b'\0'+sheet.encode('utf-8')).hexdigest()
    with connect() as c:
        if c.execute('SELECT 1 FROM documents WHERE file_hash=?',(digest,)).fetchone(): errors.append('此文件已导入 / File already posted')
        for r in data:
            old=c.execute('SELECT * FROM items WHERE code=?',(r['code'],)).fetchone()
            if old and (old['unit']!=r['unit'] or old['spec']!=r['spec'] or old['name']!=r['name']): errors.append(f"{r['code']}: 名称/规格/单位与现有编码不符 / Item identity mismatch")
    return {'headers':headers,'sheets':sheets,'sheet':sheet,'sheet_kind':sheet_kind,'header_row':chosen[0]+1,'mapping':mapping,'rows':data,'errors':list(dict.fromkeys(errors))[:100],'warnings':list(dict.fromkeys(warnings))[:100],'count':len(data),'hash':digest},raw

def newdoc(c,p,kind,file_hash=None,source_path=None,reverse_of=None):
    key=required(p.get('request_key'),'请求编号 / Request key')
    row=c.execute('SELECT id FROM documents WHERE request_key=?',(key,)).fetchone()
    if row: return row['id'],True
    operator=required(p.get('operator'),'经办人 / Operator')
    no=kind+'-'+datetime.now().strftime('%Y%m%d')+'-'+secrets.token_hex(4).upper()
    # A source file and system-generated document number are sufficient for a
    # receipt.  Keep a manually entered delivery note when supplied; otherwise
    # use the unique system number so the operator is not forced to invent a
    # second reference.
    ref=required(clean(p.get('external_ref')) or no,'业务单号 / Reference')
    cur=c.execute('INSERT INTO documents(number,kind,external_ref,operator,party,purpose,created,arrival_date,request_key,file_hash,source_path,reverse_of) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',(no,kind,ref,operator,clean(p.get('party')),clean(p.get('purpose')),now(),clean(p.get('arrival_date')),key,file_hash,source_path,reverse_of))
    return cur.lastrowid,False

def item(c,r):
    old=c.execute('SELECT * FROM items WHERE code=?',(r['code'],)).fetchone()
    if old:
        if any(old[k]!=r[k] for k in ('name','spec','unit')): raise ValueError('同编码名称/规格/单位冲突 / Item identity conflict')
    else: c.execute('INSERT INTO items(code,name,spec,unit,package,attribute) VALUES(?,?,?,?,?,?)',tuple(r.get(k,'') for k in ('code','name','spec','unit','package','attribute')))
def position(c,code,batch,box,warehouse,bin,state,contents=None):
    encoded=json.dumps(contents or [],ensure_ascii=False)
    c.execute('INSERT OR IGNORE INTO stock(code,batch,box,warehouse,bin,state,qty,contents) VALUES(?,?,?,?,?,?,0,?)',(code,batch,box,warehouse,bin,state,encoded))
    row=c.execute('SELECT * FROM stock WHERE code=? AND batch=? AND box=? AND warehouse=? AND bin=? AND state=?',(code,batch,box,warehouse,bin,state)).fetchone()
    if contents and not clean(row['contents']):
        c.execute('UPDATE stock SET contents=? WHERE id=?',(encoded,row['id']))
        row=c.execute('SELECT * FROM stock WHERE id=?',(row['id'],)).fetchone()
    return row
def movement(c,doc,sid,delta):
    cur=c.execute('UPDATE stock SET qty=qty+? WHERE id=? AND qty+?>=0',(delta,sid,delta))
    if cur.rowcount!=1: raise ValueError('库存不足，操作未生效 / Insufficient stock; nothing posted')
    c.execute('INSERT INTO movements(doc_id,stock_id,delta) VALUES(?,?,?)',(doc,sid,delta))
def line(c,doc,r,qty):
    c.execute('INSERT INTO lines(doc_id,code,name,spec,unit,batch,box,warehouse,bin,state,qty,attribute,contents,source_row) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',(doc,*(r.get(k,'') for k in ('code','name','spec','unit','batch','box','warehouse','bin','state')),qty,r.get('attribute',''),json.dumps(r.get('contents',[]),ensure_ascii=False) if not isinstance(r.get('contents',''),str) else r.get('contents',''),r.get('source_row')))

def current_design_qty(c,code):
    row=c.execute('SELECT qty FROM design WHERE code=?',(code,)).fetchone()
    if not row: return None
    change=c.execute('SELECT COALESCE(SUM(delta),0) FROM changes WHERE code=?',(code,)).fetchone()[0]
    return int(row['qty'])+int(change or 0)

def validate_receipt_limits(c,rows):
    """Prevent a confirmed receipt from exceeding a known design quantity.

    A missing design baseline remains allowed for the current arrival-only
    workflow; once a baseline exists, non-spare receipts cannot exceed it.
    This check happens before the document is created so the transaction
    remains all-or-nothing.
    """
    incoming={}
    for row in rows:
        if row.get('state')=='SPARE': continue
        incoming[row['code']]=incoming.get(row['code'],0)+int(row.get('amount',0))
    for code,amount in incoming.items():
        limit=current_design_qty(c,code)
        if limit is None: continue
        received=c.execute("SELECT COALESCE(SUM(l.qty),0) FROM lines l JOIN documents d ON l.doc_id=d.id WHERE l.code=? AND d.kind='IN' AND d.reversed_by IS NULL AND l.state!='SPARE'",(code,)).fetchone()[0]
        if int(received or 0)+amount>limit:
            raise ValueError(f'{code}: 入库数量将超过合同/设计数量（已有 {number(received)}，本次 {number(amount)}，上限 {number(limit)}） / Receipt would exceed contract/design quantity (received {number(received)}, this receipt {number(amount)}, limit {number(limit)})')

def import_post(p):
    result,raw=parse_file(p)
    kind=p.get('kind','IN')
    if kind not in ('IN','BASELINE'): raise ValueError('无效导入类型 / Invalid import type')
    sheet_label=result['sheet'].lower()
    # Reject a carton-level shipment worksheet before item-identity checks.
    # This keeps the operator-facing message about choosing the packing-detail
    # sheet even when the same workbook was already used for a receipt.
    if result['sheet']=='CSV': sheet_label=f"{sheet_label} {p.get('filename','')}".lower()
    if kind=='IN' and ('发货' in sheet_label or 'shipment' in sheet_label or 'carton' in sheet_label):
        raise ValueError('发货清单是箱级物流核对表，请选择装箱清单办理入库 / Shipment list is for carton-level logistics reconciliation; select the packing-detail sheet for receipt posting')
    with connect() as c:
        c.execute('BEGIN IMMEDIATE')
        prior=c.execute('SELECT id FROM documents WHERE request_key=?',(p.get('request_key'),)).fetchone()
        if prior: return {'id':prior['id']}
        if result['errors']: raise ValueError('\n'.join(result['errors'][:12]))
        if kind=='IN': validate_receipt_limits(c,result['rows'])
        path='sources/'+result['hash']+Path(p['filename']).suffix.lower()
        doc,_=newdoc(c,{**p,'arrival_date':p.get('arrival_date') or p.get('batch_date') or ''},kind,result['hash'],path)
        for r in result['rows']:
            item(c,r)
            if kind=='BASELINE':
                if c.execute('SELECT 1 FROM design WHERE code=?',(r['code'],)).fetchone(): raise ValueError('设计量已锁定，请使用设计变更 / Baseline locked; use change record')
                c.execute('INSERT INTO design VALUES(?,?)',(r['code'],r['amount']))
            else:
                s=position(c,r['code'],r['batch'],r['box'],r['warehouse'],r['bin'],r['state'],r.get('contents'))
                movement(c,doc,s['id'],r['amount'])
                c.execute('INSERT OR IGNORE INTO batches VALUES(?,?,?,?)',(r['batch'],clean(p.get('party')),'ARRIVED',now()))
            line(c,doc,r,r['amount'])
        dest=DATA/path; dest.parent.mkdir(exist_ok=True)
        if not dest.exists(): dest.write_bytes(raw)
    return {'id':doc}

def stock_post(p):
    kind=p.get('kind','OUT')
    if kind not in ('OUT','HANDOVER','MOVE','STATE'): raise ValueError('业务类型无效 / Invalid transaction')
    required(p.get('party'),'领用/接收单位 / Receiving party')
    required(p.get('purpose'),'用途/原因 / Purpose')
    rows=p.get('lines',[])
    if not rows or len(rows)>100: raise ValueError('选择1至100条物资 / Select 1–100 lines')
    with connect() as c:
        c.execute('BEGIN IMMEDIATE')
        doc,exists=newdoc(c,p,kind)
        if exists: return {'id':doc}
        for r in rows:
            s=c.execute('SELECT s.*,i.name,i.spec,i.unit FROM stock s JOIN items i ON i.code=s.code WHERE s.id=?',(int(r['stock_id']),)).fetchone()
            if not s: raise ValueError('库位记录不存在 / Position not found')
            s=dict(s); q=units(r['qty'])
            if kind=='OUT' and s['state']!='AVAILABLE': raise ValueError('仅可用库存可领用 / Only available stock may be issued')
            if kind=='HANDOVER' and s['state']!='SPARE': raise ValueError('请先预留备品 / Reserve spares before handover')
            movement(c,doc,s['id'],-q); line(c,doc,s,-q)
            if kind in ('MOVE','STATE'):
                state=p.get('state') if kind=='STATE' else s['state']
                if state not in STATES: raise ValueError('状态无效 / Invalid state')
                wh=required(p.get('warehouse'),'仓库 / Warehouse') if kind=='MOVE' else s['warehouse']
                loc=required(p.get('bin'),'库位 / Bin') if kind=='MOVE' else s['bin']
                target=position(c,s['code'],s['batch'],s['box'],wh,loc,state)
                if target['id']==s['id']: raise ValueError('目标与原记录相同 / Same destination')
                movement(c,doc,target['id'],q)
                line(c,doc,dict(s,warehouse=wh,bin=loc,state=state),q)
    return {'id':doc}

def reverse(p):
    with connect() as c:
        c.execute('BEGIN IMMEDIATE')
        old=c.execute('SELECT * FROM documents WHERE id=?',(int(p['id']),)).fetchone()
        if not old or old['kind'] in ('BASELINE','REV') or old['reversed_by']: raise ValueError('此单不可冲销 / Cannot reverse this document')
        required(p.get('purpose'),'冲销原因 / Reversal reason')
        doc,exists=newdoc(c,p,'REV',reverse_of=old['id'])
        if exists: return {'id':doc}
        for m in c.execute('SELECT * FROM movements WHERE doc_id=? ORDER BY delta ASC',(old['id'],)).fetchall(): movement(c,doc,m['stock_id'],-m['delta'])
        for r in c.execute('SELECT * FROM lines WHERE doc_id=?',(old['id'],)).fetchall(): line(c,doc,dict(r),-r['qty'])
        c.execute('UPDATE documents SET reversed_by=? WHERE id=?',(doc,old['id']))
    return {'id':doc}

def admin_password_path():
    return DATA/'admin_password.sha256'

def admin_password_configured():
    if clean(os.environ.get('MATERIALS_ADMIN_PASSWORD')):
        return True
    try:
        return bool(clean(admin_password_path().read_text(encoding='utf-8')))
    except (FileNotFoundError, OSError):
        return False

def verify_admin_password(value):
    supplied=clean(value)
    if not supplied: raise ValueError('请输入管理员密码 / Enter the administrator password')
    configured=clean(os.environ.get('MATERIALS_ADMIN_PASSWORD'))
    if configured:
        ok=hmac.compare_digest(supplied,configured)
    else:
        try: expected=clean(admin_password_path().read_text(encoding='utf-8'))
        except (FileNotFoundError, OSError): expected=''
        ok=bool(expected) and hmac.compare_digest(hashlib.sha256(supplied.encode('utf-8')).hexdigest(),expected)
    if not ok: raise ValueError('管理员密码错误 / Incorrect administrator password')

def admin_password_set(p):
    new=required(p.get('new_password'),'新管理员密码 / New administrator password',64)
    if len(new)<6: raise ValueError('管理员密码至少6位 / Administrator password must be at least 6 characters')
    if clean(os.environ.get('MATERIALS_ADMIN_PASSWORD')):
        raise ValueError('密码由本机启动配置管理，请修改启动配置 / Password is managed by local startup configuration')
    if admin_password_configured(): verify_admin_password(p.get('current_password'))
    DATA.mkdir(parents=True,exist_ok=True)
    admin_password_path().write_text(hashlib.sha256(new.encode('utf-8')).hexdigest(),encoding='utf-8')
    return {'ok':True,'configured':True}

def cleanup_orphan_item(c,code):
    # Keep the item master when it is still referenced by another receipt,
    # design baseline/change, or a non-zero stock position.  A mistaken-only
    # import can therefore disappear from the visible materials table after
    # its document is removed without risking a real balance.
    if c.execute('SELECT 1 FROM lines WHERE code=? LIMIT 1',(code,)).fetchone(): return
    if c.execute('SELECT 1 FROM design WHERE code=? LIMIT 1',(code,)).fetchone(): return
    if c.execute('SELECT 1 FROM changes WHERE code=? LIMIT 1',(code,)).fetchone(): return
    if c.execute('SELECT 1 FROM stock WHERE code=? AND qty<>0 LIMIT 1',(code,)).fetchone(): return
    c.execute('DELETE FROM stock WHERE code=? AND NOT EXISTS(SELECT 1 FROM movements WHERE stock_id=stock.id)',(code,))
    c.execute('DELETE FROM items WHERE code=? AND NOT EXISTS(SELECT 1 FROM lines WHERE code=?) AND NOT EXISTS(SELECT 1 FROM stock WHERE code=?)',(code,code,code))

def admin_delete_in_transaction(c,doc_id,reason,operator):
    old=c.execute('SELECT * FROM documents WHERE id=?',(int(doc_id),)).fetchone()
    if not old: raise ValueError('单据不存在 / Document not found')
    if old['kind'] in ('BASELINE','REV') or old['reversed_by']:
        raise ValueError('设计基准单、冲销单或已冲销单不能删除 / Baseline, reversal or already reversed documents cannot be deleted')
    affected_codes={row['code'] for row in c.execute('SELECT code FROM lines WHERE doc_id=?',(old['id'],)).fetchall()}
    movements=c.execute('SELECT * FROM movements WHERE doc_id=? ORDER BY delta DESC,id DESC',(old['id'],)).fetchall()
    # Undo each movement in reverse posting direction.  If a receipt has
    # already been consumed by a later issue, refuse the hard delete and
    # direct the operator to the auditable reversal action instead.
    for m in movements:
        if c.execute('SELECT 1 FROM movements WHERE stock_id=? AND id>? AND doc_id<>? LIMIT 1',(m['stock_id'],m['id'],old['id'])).fetchone():
            raise ValueError('该单据已有后续库存流水，请使用作废/冲销保留流水 / Later stock movements exist; use void/reversal to keep the audit trail')
        cur=c.execute('UPDATE stock SET qty=qty-? WHERE id=? AND qty-?>=0',(m['delta'],m['stock_id'],m['delta']))
        if cur.rowcount!=1:
            raise ValueError('该单据已影响后续库存，请使用作废/冲销保留流水 / Later transactions depend on this document; use void/reversal to keep the audit trail')
    c.execute('INSERT INTO admin_actions(action,document_id,document_number,reason,operator,created) VALUES(?,?,?,?,?,?)',('DELETE',old['id'],old['number'],reason,operator,now()))
    c.execute('DELETE FROM movements WHERE doc_id=?',(old['id'],))
    c.execute('DELETE FROM lines WHERE doc_id=?',(old['id'],))
    c.execute('DELETE FROM documents WHERE id=?',(old['id'],))
    for code in affected_codes: cleanup_orphan_item(c,code)
    return old['number']

def admin_delete(p):
    verify_admin_password(p.get('password'))
    reason=required(p.get('purpose'),'删除原因 / Deletion reason')
    operator=required(p.get('operator'),'管理员 / Administrator')
    with connect() as c:
        c.execute('BEGIN IMMEDIATE')
        deleted=admin_delete_in_transaction(c,p['id'],reason,operator)
    return {'ok':True,'deleted':deleted}

def admin_delete_batch(p):
    verify_admin_password(p.get('password'))
    reason=required(p.get('purpose'),'删除原因 / Deletion reason')
    operator=required(p.get('operator'),'管理员 / Administrator')
    ids=p.get('ids') or []
    if not isinstance(ids,list) or not ids or len(ids)>100: raise ValueError('请选择1至100张单据 / Select 1–100 documents')
    with connect() as c:
        c.execute('BEGIN IMMEDIATE')
        deleted=[admin_delete_in_transaction(c,doc_id,reason,operator) for doc_id in ids]
    return {'ok':True,'deleted':deleted}

def stock_balance_fields(c,stocks):
    """Attach one server-calculated balance summary to every visible stock row."""
    receipt_totals={}
    for row in c.execute("""
        SELECT l.code,l.batch,l.box,i.package,COALESCE(SUM(l.qty),0) total
        FROM lines l
        JOIN documents d ON d.id=l.doc_id
        JOIN items i ON i.code=l.code
        WHERE d.kind='IN' AND d.reversed_by IS NULL
        GROUP BY l.code,l.batch,l.box,i.package
    """):
        receipt_totals[(row['code'],row['batch'],row['box'],row['package'])]=int(row['total'] or 0)
    by_state={}
    for row in c.execute("""
        SELECT s.code,s.batch,s.box,i.package,s.state,COALESCE(SUM(s.qty),0) total
        FROM stock s JOIN items i ON i.code=s.code
        GROUP BY s.code,s.batch,s.box,i.package,s.state
    """):
        key=(row['code'],row['batch'],row['box'],row['package'])
        by_state.setdefault(key,{})[row['state']]=int(row['total'] or 0)
    for row in stocks:
        key=(row['code'],row['batch'],row['box'],row['package'])
        state_totals=by_state.get(key,{})
        row['received_total']=number(receipt_totals[key]) if key in receipt_totals else None
        row['available_qty']=number(state_totals.get('AVAILABLE',0))
        row['pending_qty']=number(state_totals.get('PENDING',0))
        row['quarantine_qty']=number(state_totals.get('QUARANTINE',0))
        row['spare_qty']=number(state_totals.get('SPARE',0))
    return stocks

def reconciliation(c,items):
    """Compare movement totals with stock positions and known design limits."""
    movement_totals={}
    for row in c.execute("""
        SELECT s.code,i.package,COALESCE(SUM(m.delta),0) total
        FROM movements m JOIN stock s ON s.id=m.stock_id JOIN items i ON i.code=s.code
        GROUP BY s.code,i.package
    """):
        movement_totals[(row['code'],row['package'])]=int(row['total'] or 0)
    stock_totals={}
    for row in c.execute("""
        SELECT s.code,i.package,COALESCE(SUM(s.qty),0) total
        FROM stock s JOIN items i ON i.code=s.code
        GROUP BY s.code,i.package
    """):
        stock_totals[(row['code'],row['package'])]=int(row['total'] or 0)
    issues=[]
    for key in sorted(set(movement_totals)|set(stock_totals)):
        movement_total=movement_totals.get(key,0); stock_total=stock_totals.get(key,0)
        if movement_total!=stock_total:
            code,package=key
            name=next((r.get('name','') for r in items if r.get('code')==code),'')
            unit=next((r.get('unit','') for r in items if r.get('code')==code),'')
            issues.append({'kind':'ledger_mismatch','code':code,'name':name,'package':package,'unit':unit,'expected':number(movement_total),'actual':number(stock_total),'difference':number(stock_total-movement_total)})
    for row in items:
        if row.get('current') is None or row.get('received') is None: continue
        if float(row['received'])>float(row['current'])+1e-9:
            issues.append({'kind':'over_contract','code':row['code'],'name':row['name'],'package':row.get('package',''),'unit':row.get('unit',''),'expected':row['current'],'actual':row['received'],'difference':row['received']-row['current']})
    return {'ok':not issues,'issue_count':len(issues),'issues':issues}

def overview():
    with connect() as c:
        stocks=[dict(r) for r in c.execute('SELECT s.*,i.name,i.spec,i.unit,i.package,i.attribute FROM stock s JOIN items i ON i.code=s.code WHERE s.qty>0 ORDER BY s.code,s.warehouse,s.bin')]
        for r in stocks:
            r['qty']=number(r['qty'])
            try: r['contents']=json.loads(r.get('contents') or '[]')
            except (TypeError,ValueError): r['contents']=[]
        stock_balance_fields(c,stocks)
        docs=[dict(r) for r in c.execute('SELECT * FROM documents ORDER BY id DESC')]
        for d in docs: d.pop('file_hash'); d.pop('request_key'); d.pop('source_path')
        items=[]
        for r in c.execute('SELECT i.*,d.qty baseline FROM items i LEFT JOIN design d ON d.code=i.code ORDER BY i.code'):
            r=dict(r); code=r['code']
            change=c.execute('SELECT COALESCE(SUM(delta),0) FROM changes WHERE code=?',(code,)).fetchone()[0]
            r['change']=number(change); r['current']=number(r['baseline']+change) if r['baseline'] is not None else None
            r['baseline']=number(r['baseline']) if r['baseline'] is not None else None
            for name,kinds in [('received',('IN',)),('issued',('OUT',)),('handed',('HANDOVER',))]:
                # Reserved spares are tracked separately from the contract's main
                # design quantity and must not inflate the arrived/remaining view.
                state_filter=" AND l.state!='SPARE'" if name=='received' else ''
                q=c.execute(f'SELECT COALESCE(SUM(l.qty),0) FROM lines l JOIN documents d ON l.doc_id=d.id WHERE l.code=? AND d.kind=? AND d.reversed_by IS NULL{state_filter}',(code,kinds[0])).fetchone()[0]
                r[name]=number(abs(q))
            dates=c.execute("SELECT d.kind,MIN(CASE WHEN d.kind='IN' AND d.arrival_date<>'' THEN d.arrival_date ELSE d.created END) first_date,MAX(CASE WHEN d.kind='IN' AND d.arrival_date<>'' THEN d.arrival_date ELSE d.created END) last_date FROM lines l JOIN documents d ON l.doc_id=d.id WHERE l.code=? AND d.kind IN ('IN','OUT') AND d.reversed_by IS NULL GROUP BY d.kind",(code,)).fetchall()
            for dr in dates:
                prefix='inbound' if dr['kind']=='IN' else 'outbound'
                r[prefix+'_first']=dr['first_date']; r[prefix+'_last']=dr['last_date']
            r.setdefault('inbound_first',''); r.setdefault('inbound_last',''); r.setdefault('outbound_first',''); r.setdefault('outbound_last','')
            r['onhand']=number(c.execute("SELECT COALESCE(SUM(qty),0) FROM stock WHERE code=? AND state!='SPARE'",(code,)).fetchone()[0])
            r['spare']=number(c.execute("SELECT COALESCE(SUM(qty),0) FROM stock WHERE code=? AND state='SPARE'",(code,)).fetchone()[0])
            r['outstanding']=max(0,r['current']-r['received']) if r['current'] is not None else None
            items.append(r)
        contracts={}
        for r in items:
            key=clean(r.get('package')) or '未指定标段'
            g=contracts.setdefault(key,{'code':key,'items':[],'baseline':None,'change':0,'current':None,'received':0,'issued':0,'handed':0,'onhand':0,'spare':0,'outstanding':None,'unit_totals':{},'inbound_first':'','inbound_last':'','outbound_first':'','outbound_last':''})
            g['items'].append(r)
            for k in ('baseline','change','current','received','issued','handed','onhand','spare','outstanding'):
                if r[k] is not None:
                    g[k]=r[k] if g[k] is None else g[k]+r[k]
            unit=r.get('unit') or '—'; totals=g['unit_totals'].setdefault(unit,{'current':None,'received':0,'issued':0,'onhand':0,'spare':0,'outstanding':0})
            for k in ('current','received','issued','onhand','spare','outstanding'):
                if r[k] is not None: totals[k]=r[k] if totals[k] is None else totals[k]+r[k]
            for k in ('inbound_first','inbound_last','outbound_first','outbound_last'):
                val=r.get(k) or ''
                if val and (not g[k] or (k.endswith('_first') and val<g[k]) or (k.endswith('_last') and val>g[k])): g[k]=val
        # Keep the fixed project segments visible on the leadership view even
        # before their first receipt is posted.
        for code, _, _ in SEGMENTS:
            contracts.setdefault(code, {'code':code,'items':[],'baseline':None,'change':0,'current':None,'received':0,'issued':0,'handed':0,'onhand':0,'spare':0,'outstanding':None,'unit_totals':{},'inbound_first':'','inbound_last':'','outbound_first':'','outbound_last':''})
        ledger=[]
        ledger_sql='''
            SELECT m.id AS movement_id, m.delta, d.id AS doc_id, d.number, d.kind,
                   d.external_ref, d.created, d.arrival_date, d.operator, d.party,
                   d.purpose, s.code, i.name, i.spec, i.unit, i.package,
                   s.batch, s.box, s.warehouse, s.bin, s.state
            FROM movements m
            JOIN documents d ON d.id=m.doc_id
            JOIN stock s ON s.id=m.stock_id
            JOIN items i ON i.code=s.code
            ORDER BY m.id DESC
        '''
        for r in c.execute(ledger_sql):
            row=dict(r); row['delta']=number(row['delta']); row['qty']=abs(row['delta'])
            row['direction']='IN' if row['delta']>0 else 'OUT'
            row['date']=row['arrival_date'] or row['created']
            ledger.append(row)
        return {'items':items,'stock':stocks,'documents':docs,'contracts':list(contracts.values()),'ledger':ledger,'reconciliation':reconciliation(c,items),'batches':[dict(r) for r in c.execute('SELECT * FROM batches ORDER BY updated DESC')],'changes':[dict(r) for r in c.execute('SELECT code,delta,reason,operator,created FROM changes ORDER BY id DESC')],'events':[dict(r) for r in c.execute('SELECT * FROM events ORDER BY id DESC LIMIT 100')],'segments':[{'code':code,'zh':zh,'en':en} for code,zh,en in SEGMENTS]}

def doc_detail(doc):
    with connect() as c:
        d=c.execute('SELECT * FROM documents WHERE id=?',(int(doc),)).fetchone()
        if not d: raise ValueError('单据不存在 / Document not found')
        d=dict(d); d.pop('request_key'); d.pop('file_hash')
        d['lines']=[dict(r) for r in c.execute('SELECT * FROM lines WHERE doc_id=?',(doc,))]
        for r in d['lines']:
            try: r['contents']=json.loads(r.get('contents') or '[]')
            except (TypeError,ValueError): r['contents']=[]
        for r in d['lines']: r['qty']=number(r['qty'])
        return d

def change_design(p):
    with connect() as c:
        c.execute('BEGIN IMMEDIATE')
        if c.execute('SELECT 1 FROM changes WHERE request_key=?',(p.get('request_key'),)).fetchone(): return {'ok':True}
        code=required(p.get('code'),'物资编码 / Code'); q=units(p.get('qty'),False)
        if q==0: raise ValueError('变更不能为零 / Change cannot be zero')
        row=c.execute('SELECT qty FROM design WHERE code=?',(code,)).fetchone()
        if not row: raise ValueError('请先导入设计量 / Import baseline first')
        total=row[0]+c.execute('SELECT COALESCE(SUM(delta),0) FROM changes WHERE code=?',(code,)).fetchone()[0]+q
        if total<0: raise ValueError('现行需求不能为负 / Requirement cannot be negative')
        c.execute('INSERT INTO changes(code,delta,reason,operator,created,request_key) VALUES(?,?,?,?,?,?)',(code,q,required(p.get('reason'),'变更依据 / Change basis'),required(p.get('operator'),'经办人 / Operator'),now(),required(p.get('request_key'),'请求编号')))
    return {'ok':True}
def batch_update(p):
    with connect() as c:
        c.execute('BEGIN IMMEDIATE')
        code=required(p.get('code'),'批次 / Batch'); status=p.get('status')
        if status not in TRANSPORT: raise ValueError('运输状态无效 / Invalid transport status')
        old=c.execute('SELECT * FROM batches WHERE code=?',(code,)).fetchone()
        c.execute('INSERT INTO batches VALUES(?,?,?,?) ON CONFLICT(code) DO UPDATE SET status=excluded.status,supplier=excluded.supplier,updated=excluded.updated',(code,clean(p.get('supplier')),status,now()))
        c.execute('INSERT INTO events(batch,old_status,new_status,operator,note,created) VALUES(?,?,?,?,?,?)',(code,old['status'] if old else None,status,required(p.get('operator'),'经办人 / Operator'),clean(p.get('note')),now()))
    return {'ok':True}

class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def send(self,content,status=200,ctype='application/json; charset=utf-8',filename=None):
        if not isinstance(content,bytes): content=json.dumps(content,ensure_ascii=False).encode()
        self.send_response(status); self.send_header('Content-Type',ctype); self.send_header('Cache-Control','no-store'); self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'")
        if filename: self.send_header('Content-Disposition','attachment; filename="'+filename+'"')
        self.send_header('Content-Length',str(len(content))); self.end_headers(); self.wfile.write(content)
    def do_GET(self):
        path=urlparse(self.path).path; query=parse_qs(urlparse(self.path).query)
        if self.headers.get('Host','').split(':')[0] not in ('127.0.0.1','localhost'): return self.send({'error':'Local access only'},403)
        try:
            if path=='/api/state':
                state=dict(overview(),token=TOKEN,version=APP_VERSION)
                state['admin_password_configured']=admin_password_configured()
                return self.send(state)
            if path=='/api/document': return self.send(doc_detail(query['id'][0]))
            if path=='/api/source':
                d=doc_detail(query['id'][0]); rel=d.get('source_path')
                if not rel: raise ValueError('没有来源文件 / No source file')
                return self.send((DATA/rel).read_bytes(),ctype='application/octet-stream',filename='source'+Path(rel).suffix)
            if path=='/api/backup':
                mem=io.BytesIO()
                with connect() as c:
                    tmp=DATA/('backup-'+secrets.token_hex(6)+'.db')
                    dest=sqlite3.connect(tmp); c.backup(dest); dest.close()
                    try:
                        with zipfile.ZipFile(mem,'w',zipfile.ZIP_DEFLATED) as z:
                            z.write(tmp,'materials.db')
                            for f in (DATA/'sources').glob('*'): z.write(f,'sources/'+f.name)
                    finally: tmp.unlink(missing_ok=True)
                return self.send(mem.getvalue(),ctype='application/zip',filename='materials-backup.zip')
            if path=='/api/export':
                state=overview(); out=io.StringIO(); w=csv.writer(out); w.writerow(['Contract / 合同','Code / 编码','Name / 名称','Specification / 规格','Unit / 单位','Attribute / 属性','Batch / 批次','Box / 箱号','Warehouse / 仓库','Bin / 库位','State / 状态','Quantity / 数量','Received total / 累计入库','Available / 当前可用','Pending / 待检','Quarantine / 隔离','Spares / 备品'])
                for r in state['stock']:
                    vals=[r[k] for k in ('package','code','name','spec','unit','attribute','batch','box','warehouse','bin','state','qty','received_total','available_qty','pending_qty','quarantine_qty','spare_qty')]
                    w.writerow(["'"+v if isinstance(v,str) and v.startswith(('=','+','-','@','\t','\r')) else v for v in vals])
                return self.send(('\ufeff'+out.getvalue()).encode(),ctype='text/csv; charset=utf-8',filename='inventory.csv')
            if path=='/api/template':
                return self.send('\ufeff物资编码,物资名称,规格型号,单位,数量,批次,箱号,仓库,库位,库存状态,标段\r\nDEMO-001,模拟支架配件,M12,件,100,B01,C01,主仓库,A区-01,可用,A1\r\n'.encode(),ctype='text/csv; charset=utf-8',filename='sample.csv')
            if path=='/api/supplier-template':
                f=ROOT.parent/'厂家发货与装箱清单固定模板.xlsx'
                if not f.exists(): raise FileNotFoundError('固定模板尚未生成 / Fixed template not found')
                return self.send(f.read_bytes(),ctype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',filename='supplier-material-template.xlsx')
            names={'/':'index.html','/app.js':'app.js','/style.css':'style.css'}
            if path in names:
                mime={'/':'text/html; charset=utf-8','/app.js':'text/javascript; charset=utf-8','/style.css':'text/css; charset=utf-8'}[path]
                return self.send((ROOT/'static'/names[path]).read_bytes(),ctype=mime)
            self.send({'error':'Not found'},404)
        except (ValueError,KeyError,FileNotFoundError) as e: self.send({'error':str(e)},400)
    def do_POST(self):
        if self.headers.get('Host','').split(':')[0] not in ('127.0.0.1','localhost') or self.headers.get('X-Local-Token')!=TOKEN: return self.send({'error':'请刷新页面 / Refresh page'},403)
        origin=self.headers.get('Origin')
        if origin and urlparse(origin).netloc!=self.headers.get('Host'): return self.send({'error':'Origin rejected'},403)
        try:
            length=int(self.headers.get('Content-Length','0'))
            if not 0<length<18*1024*1024: raise ValueError('请求过大 / Request too large')
            p=json.loads(self.rfile.read(length))
            handlers={'/api/preview':lambda p:parse_file(p)[0],'/api/import':import_post,'/api/post':stock_post,'/api/reverse':reverse,'/api/delete':admin_delete,'/api/delete-batch':admin_delete_batch,'/api/admin-password':admin_password_set,'/api/change':change_design,'/api/batch':batch_update}
            fn=handlers.get(urlparse(self.path).path)
            if not fn: return self.send({'error':'Not found'},404)
            self.send(fn(p))
        except sqlite3.IntegrityError: self.send({'error':'重复单号、文件或记录冲突，未重复入账 / Duplicate reference, file or conflicting record; not posted'},409)
        except (ValueError,KeyError,TypeError) as e: self.send({'error':str(e)},400)
        except Exception as e:
            print(type(e).__name__,str(e),file=sys.stderr)
            self.send({'error':'处理失败，未完成操作 / Operation failed'},500)

if __name__=='__main__':
    init(); port=int(os.environ.get('MATERIALS_PORT','8765'))
    print(f'Materials local app: http://127.0.0.1:{port}',flush=True)
    ThreadingHTTPServer(('127.0.0.1',port),Handler).serve_forever()
