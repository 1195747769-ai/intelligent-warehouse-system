let lang=localStorage.getItem('materials-language')||'zh', page='dashboard', selectedContract='', selectedSegment='', db=null, token='', upload=null, preview=null, importKind='IN', cart=[], deleteSelected=[], action='OUT', posting=false, outKey=crypto.randomUUID(), treeState={query:'',contract:'',batch:'',warehouse:'',state:'',sort:'contract'}, reconnectTimer=null, reconnectAttempt=0, previewRawPage=0, recognitionRowsPage=0, recognitionListOffset=0, recognitionListLoading=false, recognitionListRows=[], recognitionSelected=new Set(), currentRecognition=null;
const $=id=>document.getElementById(id), t=(zh,en)=>lang==='zh'?zh:en;
const APP_VERSION='0.1.36';
let inventoryLayout='list',inventoryPage=0,issueMode='item',intakeExcludedPage=[];
let intakeMode='upload', intakeInputs=[], intakeCorrections={}, intakeEditPage=0, intakeOnlyProblems=false;
let receiptDraft={}, issueDraft={}, intakeFiles={}, manualDraftRows=null;
const receiptDraftFields=['ref','operator','party','default-package','batch-date','batch-number','default-warehouse','default-bin','default-box','default-state','header','sheet','intake-role-main','intake-text-packing_detail','intake-text-arrival_note'];
const issueDraftFields=['out-operator','out-party','out-purpose','out-warehouse','out-bin','out-state','out-search','out-contract'];
function saveBusinessDraft(){
 if(document.querySelector('.intake-entry')){
  for(const id of receiptDraftFields){const el=$(id);if(el)receiptDraft[id]=el.value;}
  for(const slot of ['packing_detail','arrival_note']){const file=$(`intake-file-${slot}`)?.files?.[0];if(file)intakeFiles[slot]=file;}
  if(intakeMode==='manual')manualDraftRows=[...document.querySelectorAll('#intake-manual-rows tr')].map(tr=>Object.fromEntries([...tr.querySelectorAll('[data-manual-field]')].map(el=>[el.dataset.manualField,el.value])));
 }
 if(document.querySelector('#out-operator')){
  for(const id of issueDraftFields){const el=$(id);if(el)issueDraft[id]=el.value;}
  if(issueMode==='item'){
   issueDraft.quantities={};issueDraft.checked={};
   issueGroups().forEach((g,i)=>{const field=document.querySelector(`[data-group-qty="${i}"]`),check=document.querySelector(`[data-group-check="${i}"]`);if(field)issueDraft.quantities[g.key]=field.value;if(check)issueDraft.checked[g.key]=check.checked;});
  }
 }
}
function restoreBusinessDraft(){
 const draft=page==='inbound'?receiptDraft:page==='outbound'?issueDraft:null;
 if(!draft)return;
 for(const id of page==='inbound'?receiptDraftFields:issueDraftFields){const el=$(id);if(el&&Object.hasOwn(draft,id))el.value=draft[id];}
 if(page==='inbound'&&$('batch-preview'))$('batch-preview').textContent=composeBatch()||t('批次序号须为正整数（最多12位）','Enter a positive batch number (maximum 12 digits)');
 if(page==='outbound'){applyBulkFilters();if(issueMode==='item')syncBulkCart();}
}
function clearReceiptDraft(){receiptDraft={};intakeFiles={};manualDraftRows=null;}
const intakeFields={doc_no:'到货单号',box:'箱号',name:'物资名称',spec:'规格型号',drawing:'图号',qty:'数量',unit:'单位',code:'厂家编码',attribute:'备注'};
const intakeKinds={arrival_note:'到货单',packing_detail:'装箱明细',shipment:'发运物流表',material_summary:'物资汇总',document_only:'出厂资料',unknown:'待人工选择'};
function setOnline(ok){const dot=document.querySelector('.side-foot .dot');if(dot)dot.classList.toggle('err',!ok);}
async function boot(){try{await refresh();}catch(e){/* refresh() renders the reconnect view */}}
function scheduleReconnect(){
 clearTimeout(reconnectTimer);
 if(reconnectAttempt>=20)return;
 reconnectTimer=setTimeout(async()=>{
  reconnectAttempt++;
  try{await refresh();reconnectAttempt=0;}
  catch(e){scheduleReconnect();}
 },Math.min(1000+reconnectAttempt*250,4000));
}
function offlineShell(e){
 setOnline(false);
 const v=$('version');if(v)v.textContent=APP_VERSION;
 $('view').innerHTML=`<div class="panel"><div class="empty"><strong>${t('正在等待本地服务','Waiting for the local service')}</strong><p>${t('系统会自动重试连接，不需要重启；如果超过一分钟仍未恢复，再双击 启动系统.cmd。','The system will reconnect automatically; no restart is needed. If it does not recover after one minute, double-click 启动系统.cmd.')}</p><button class="quiet" data-action="retry-connect">${t('立即重试','Retry now')}</button><p class="sub">${esc(e?.message||'')}</p></div></div>`;
 notice(t('正在等待本地服务，系统会自动重试连接。','Waiting for the local service; reconnecting automatically.'),true);
 scheduleReconnect();
}
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=v=>v===null||v===undefined?'—':Number(v).toLocaleString(lang==='zh'?'zh-CN':'en-GB',{maximumFractionDigits:6});
const states={AVAILABLE:['可用','Available'],PENDING:['待检','Pending inspection'],QUARANTINE:['隔离','Quarantine'],SPARE:['预留备品','Reserved spares'],PLANNED:['待发运','Planned'],DISPATCHED:['已发运','Dispatched'],SEA:['海运中','At sea'],CUSTOMS:['清关中','Customs'],RELEASED:['已放行','Released'],ROAD:['陆运中','Road transit'],ARRIVED:['已到场','Arrived'],IN:['入库单','Goods receipt'],OUT:['出库单','Goods issue'],HANDOVER:['备品移交单','Spares handover'],MOVE:['移库单','Bin transfer'],STATE:['库存状态调整单','Stock status change'],REV:['冲销单','Reversal'],BASELINE:['设计基准单','Design baseline']};
const label=k=>states[k]?t(...states[k]):k;
const badge=k=>`<span class="tag ${esc(k)}">${esc(label(k))}</span>`;
const segmentByCode=code=>(db?.segments||[]).find(s=>s.code===code);
const segmentLabel=code=>{const s=segmentByCode(code);return s?`${s.code}｜${lang==='zh'?s.zh:s.en}`:(code||'—');};
const segmentOptions=(selected='')=>`<option value="">${t('请选择标段','Select segment')}</option>`+(db?.segments||[]).map(s=>`<option value="${esc(s.code)}" ${s.code===selected?'selected':''}>${esc(s.code)}｜${esc(lang==='zh'?s.zh:s.en)}</option>`).join('');
const segmentIndex=code=>{const i=(db?.segments||[]).findIndex(s=>s.code===code);return i<0?999:i;};
function stockBalance(row){
 if(row&&row.received_total!==undefined&&row.received_total!==null){
  return {total:Number(row.received_total||0),available:Number(row.available_qty||0)};
 }
 if(db?.ledger_has_more)return null; // ledger is paged: a partial slice cannot be summed
 const key=x=>[x?.code||'',x?.batch||'',x?.box||'',x?.package||''].join('\u001f');
 const rowKey=key(row), docs=new Set((db?.documents||[]).filter(d=>!d.reversed_by).map(d=>Number(d.id)));
 const receipts=(db?.ledger||[]).filter(x=>x.kind==='IN'&&docs.has(Number(x.doc_id))&&key(x)===rowKey);
 if(!receipts.length)return null;
 const total=receipts.reduce((sum,x)=>sum+Math.max(0,Number(x.delta||0)),0);
 const available=(db?.stock||[]).filter(x=>key(x)===rowKey&&x.state==='AVAILABLE').reduce((sum,x)=>sum+Number(x.qty||0),0);
 return {total,available};
}
function stockBalanceText(row){
 const balance=stockBalance(row), unit=esc(row.unit);
 if(!balance)return `${fmt(row.qty)} ${unit}`;
 return `${t('总量','Total')} ${fmt(balance.total)} ${unit} · ${t('剩余','Remaining')} ${fmt(balance.available)} ${unit}`;
}
const fields={code:['物资编码 *','Item code *'],name:['物资名称 *','Item name *'],spec:['规格型号','Specification'],unit:['单位 *','Unit *'],qty:['数量 *','Quantity *'],batch:['到货批次','Arrival batch'],box:['箱号','Box no.'],warehouse:['仓库','Warehouse'],bin:['库位','Bin'],state:['库存状态','Stock status'],package:['标段','Segment'],attribute:['设备属性','Equipment attribute']};
function notice(s,error=false){$('notice').hidden=false;$('notice').className=error?'error':'';$('notice').textContent=s;}
async function api(path,p){let r;try{r=await fetch(path,p?{method:'POST',headers:{'Content-Type':'application/json','X-Local-Token':token},body:JSON.stringify(p)}:{});}catch{throw Error(t('无法连接本地服务，请确认已运行 启动系统.cmd。','Cannot reach the local service. Please run 启动系统.cmd.'));}let data;try{data=await r.json();}catch{throw Error(t('服务响应异常，请刷新重试。','Unexpected server response. Refresh and retry.'));}if(!r.ok)throw Error(data.error||r.statusText);return data;}
async function refresh(render=true){try{db=await api('/api/state');token=db.token;ledgerState.ready=false;itemsState.ready=false;contractState={code:'',ready:false,loading:false,rows:[],total:0,hasMore:false};reconnectAttempt=0;setOnline(true);if($('notice'))$('notice').hidden=true;if(render)draw();}catch(e){setOnline(false);if(render)offlineShell(e);throw e;}}
function options(keys,selected){return keys.map(k=>`<option value="${esc(k)}" ${k===selected?'selected':''}>${esc(label(k))}</option>`).join('');}
function input(id,title,value='',type='text',extra=''){
 const field=id.endsWith('warehouse')?'warehouse':id.endsWith('bin')?'bin':null;
 const vals=field?[...new Set((db?.stock||[]).map(s=>s[field]))]:[];
 const choices=field?`<datalist id="${id}-choices">${vals.map(v=>`<option value="${esc(v)}"></option>`).join('')}</datalist>`:'';
 return `<label>${esc(title)}<input id="${id}" type="${type}" value="${esc(value)}" ${extra} ${field?`list="${id}-choices"`:''}></label>${choices}`;
}
function empty(title,desc){return `<div class="empty"><strong>${title}</strong>${desc}</div>`;}
function table(head,rows){return `<div class="table-wrap"><table><thead><tr>${head.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;}
function draw(){
 disposeUniver('preview-univer');disposeUniver('recognition-univer');
 document.documentElement.lang=lang==='zh'?'zh-CN':'en';document.title=t('智能仓储系统 · 本地试用版','Intelligent Warehouse System · Local Trial');
 const pages=[['dashboard','工作台','Workbench'],['inbound','入库办理','Receipts'],['recognitions','识别归档','Recognition archive'],['outbound','出库办理','Issues'],['inventory','仓库明细','Warehouse detail'],['items','物资总表','Materials table'],['ledger','流水总账','Transaction ledger'],['spares','备品情况','Spares'],['documents','单据查询','Documents'],['delete','删除办理','Admin deletion']];
 const primary=['dashboard','inbound','inventory','outbound','documents'];
 $('nav').innerHTML=pages.filter(p=>primary.includes(p[0])).map((p,i)=>`<button data-page="${p[0]}" class="${(page==='recognitions'?'inbound':['items','spares'].includes(page)?'inventory':page==='delete'?'documents':page)===p[0]?'active':''}"><span>${String(i+1).padStart(2,'0')}</span><span>${t(...({inbound:['入库','Receipts'],inventory:['库存','Stock'],outbound:['出库','Issues'],documents:['单据','Documents']}[p[0]]||p.slice(1)))}</span></button>`).join('');
 $('title').textContent=t(...pages.find(p=>p[0]===page).slice(1));$('brand-name').firstChild.textContent=t('智能仓储系统','Intelligent Warehouse System');$('brand-sub').textContent=t('面向新能源 EPC 的全流程物资管理','End-to-end materials control for renewable EPC');$('mode').textContent=t('单机本地版 · 数据保存在本机','Local edition · Data on this computer');$('mode-note').textContent=t('收发办理 · 库存追溯','Receipts, issues and stock traceability');$('footer').textContent=t('智能仓储系统 · 所有库存变动均有单据依据','Intelligent Warehouse System · Every stock movement has a document');$('project-home').textContent=t('← 返回项目首页','← Back to project home');$('lang').textContent=lang==='zh'?'English':'中文';$('refresh').textContent=t('刷新','Refresh');$('close-modal').textContent=t('关闭','Close');if($('version'))$('version').textContent=db?.version||APP_VERSION;
 $('view').innerHTML=page==='dashboard'?dashboard():page==='inventory'?overview():page==='items'?materialsOverview():page==='inbound'?inbound():page==='recognitions'?recognitionsPage():page==='outbound'?outbound():page==='ledger'?ledgerPage():page==='spares'?sparesPage():page==='delete'?deletePage():documents();
 $('view').insertAdjacentHTML('afterbegin',`<div class="context-actions">${page==='inbound'||page==='recognitions'?'<button class="quiet small" data-page="inbound">办理入库</button><button class="quiet small" data-page="recognitions">入库历史</button>':''}<details><summary>更多业务</summary><div class="actions">${pages.filter(p=>!primary.includes(p[0])).map(p=>`<button class="quiet small" data-page="${p[0]}">${t(p[1],p[2])}</button>`).join('')}</div></details></div>`);
 if(page==='inventory'){simplifyBatchStatus();renderInventoryTree();}
 if(selectedContract&&(page==='inventory'||page==='items'))ensureContractItems(selectedContract);
 if(db?.demo_mode){$('view').insertAdjacentHTML('afterbegin','<div class="demo-banner"><strong>演示模式 · 全部为虚构数据</strong>　演示操作保存在独立演示库。<a href="http://127.0.0.1:8765/warehouse">返回正式仓库</a></div>');$('mode').textContent='演示模式 · 虚构数据';}
 if(page==='inbound'){enhanceBatchForm();ensureDefaultBox();simplifyInboundForm();fixTemplateLink();if(importKind==='IN')for(const id of ['sheet','header'])$(id).closest('label').hidden=true;}
 restoreBusinessDraft();
 if(page==='inbound'&&preview){renderPreview();}
 if(page==='recognitions')loadRecognitionList(false);
}
function fixTemplateLink(){const a=document.querySelector('a[href="/api/template"]');if(a){a.href=importKind==='BASELINE'?'/api/template':'/api/supplier-template';a.textContent=importKind==='BASELINE'?t('下载设计数量示例 CSV','Download baseline CSV'):t('下载简易到货单 / 装箱单模板','Download simple supplier template');}}
function ensureDefaultBox(){const wh=$('default-warehouse');if(wh&&!$('default-box'))wh.closest('label').insertAdjacentHTML('beforebegin',input('default-box',t('默认箱号（表格没有箱号时填写）','Default box no. (only if sheet has none)')));}
function simplifyInboundForm(){
 const grid=document.querySelector('#view .form-grid');if(!grid||grid.querySelector('.advanced-defaults'))return;
 const ids=importKind==='IN'?['ref','party','default-warehouse','default-bin','default-box','default-state','header','sheet']:['default-box','default-state','header'];
 const fields=ids.map(id=>$(id)?.closest('label')).filter(Boolean);if(!fields.length)return;
 const details=document.createElement('details');details.className='advanced-defaults';
 const summary=document.createElement('summary');summary.textContent=t('更多信息：供货单位、仓库、库位、库存状态（可选）','More: supplier, warehouse, bin and stock status (optional)');details.append(summary);
 grid.append(details);fields.forEach(label=>details.append(label));
 const helper=document.createElement('p');helper.className='helper';helper.textContent=t('默认入主仓库，库位待分配，状态为可用。需要修改时展开“更多信息”。','Default: main warehouse, unassigned bin, available stock. Expand More to change.');grid.append(helper);
}
function todayISO(){return new Date().toISOString().slice(0,10);}
function inferDeviceLabel(r){
 const text=[r?.rows?.find(x=>x.box)?.box,r?.rows?.find(x=>x.name)?.name,upload?.filename].filter(Boolean).join(' ');
 const matches=[['无人机机场','无人机机场'],['轨道机器人','轨道机器人'],['轮式机器人','轮式机器人'],['水浸传感器','水浸传感器'],['摄像头','摄像头'],['电池','电池'],['支架','支架'],['组件','组件']];
 return matches.find(([needle])=>text.includes(needle))?.[1]||'设备';
}
function autoFillReceiptDefaults(r){
 if(!r||!$('batch-date'))return;
 if(!$('batch-date').value)$('batch-date').value=todayISO();
 const wh=$('default-warehouse');if(wh&&!wh.value)wh.value='主仓库';
 const bin=$('default-bin');if(bin&&!bin.value)bin.value='待分配';
 const b=$('batch-preview');if(b)b.textContent=composeBatch();
}
function enhanceBatchForm(){
 const old=$('default-batch'); if(!old||$('batch-date'))return;
 const label=old.closest('label');
 if(importKind==='BASELINE'){label.hidden=true;return;}
 label.outerHTML=`<div class="batch-fields"><label>${t('到货日期','Arrival date')}<input id="batch-date" type="date" value="${esc(upload?.batchDate||todayISO())}"></label><label>${t('批次序号','Batch number')}<input id="batch-number" type="number" min="1" value="${esc(upload?.batchNumber||'1')}"></label><div class="batch-preview"><span>${t('到货批次','Arrival batch')}</span><b id="batch-preview">${esc(composeBatch())||t('填写批次序号后生成','Enter a batch number to generate')}</b></div></div>`;
 const b=$('batch-preview');if(b)b.textContent=composeBatch();
 }
function composeBatch(){const field=$('batch-number');const batch=String(field?(field.value||'').trim():(upload?.batchNumber??'1'));if(!/^\d{1,12}$/.test(batch)||Number(batch)<=0)return '';return `B${String(Number(batch)).padStart(2,'0')}`;}
function simplifyBatchStatus(){const panel=[...document.querySelectorAll('#view details')].find(d=>d.querySelector('summary')?.textContent.includes('发运批次'));if(!panel)return;const helper=panel.querySelector('.helper');if(helper)helper.textContent=t('物流状态手动选择并留痕；不会改变库存数量。到货批次只用于入库及追溯；出库使用独立出库单号。','Transport status changes are logged and do not alter quantities. Arrival batch is for receipt traceability; issue uses its own number.');const code=$('batch-code');const label=code?.closest('label');if(label&&label.firstChild)label.firstChild.textContent=t('到货批次号 *','Arrival batch *');panel.querySelectorAll('th').forEach(th=>{if(th.textContent.trim()==='合同批次')th.textContent=t('到货批次','Arrival batch');});}
function dateText(v){return v?v.slice(0,10):'—';}
function dateRange(first,last){if(!first&&!last)return '—';if(first===last)return dateText(first);return `${dateText(first)} ~ ${dateText(last)}`;}
function qtySummary(g,key){const totals=g.unit_totals||{};const vals=Object.entries(totals).map(([unit,v])=>[unit,v[key]]).filter(([,v])=>v!==undefined&&v!==null&&v!==0);return vals.length?vals.map(([unit,v])=>`${fmt(v)} ${esc(unit)}`).join(' / '):'—';}
function pctSummary(g,key){const totals=g.unit_totals||{};const vals=Object.entries(totals).map(([unit,v])=>{const total=Number(v.current||0),value=Number(v[key]||0);return total>0?`${fmt(value/total*100)}% ${esc(unit)}`:'';}).filter(Boolean);return vals.length?vals.join(' / '):t('待设定','Not set');}
function groupRows(rows,key){const groups=new Map();rows.forEach(row=>{const value=key(row)||'—';if(!groups.has(value))groups.set(value,[]);groups.get(value).push(row);});return [...groups].map(([key,rows])=>({key,rows}));}
function unitSummaryRows(rows){const totals={};rows.forEach(row=>{const unit=row.unit||'—';totals[unit]=(totals[unit]||0)+Number(row.qty||0);});return Object.entries(totals).map(([unit,qty])=>`${fmt(qty)} ${esc(unit)}`).join(' / ')||'—';}
function treeSort(groups,level){const sort=treeState.sort;return groups.sort((a,b)=>{if(sort==='qty')return b.rows.reduce((n,r)=>n+Number(r.qty||0),0)-a.rows.reduce((n,r)=>n+Number(r.qty||0),0);if(level==='contract'){const ai=segmentIndex(a.key),bi=segmentIndex(b.key);if(ai!==999||bi!==999)return ai-bi;}return a.key.localeCompare(b.key,'zh-CN');});}
function filteredTreeRows(){const q=(treeState.query||'').trim().toLowerCase();return (db.stock||[]).filter(row=>{const childText=Array.isArray(row.contents)?row.contents.flatMap(child=>Object.values(child)):[];const hay=[...Object.values(row),...childText].join(' ').toLowerCase();return (!q||hay.includes(q))&&(!treeState.contract||row.package===treeState.contract)&&(!treeState.batch||row.batch===treeState.batch)&&(!treeState.warehouse||row.warehouse===treeState.warehouse)&&(!treeState.state||row.state===treeState.state);});}
function treeBoxHtml(box){const rows=[...box.rows].sort((a,b)=>treeState.sort==='item'?`${a.name}${a.code}`.localeCompare(`${b.name}${b.code}`,'zh-CN'):treeState.sort==='qty'?Number(b.qty)-Number(a.qty):`${a.code}`.localeCompare(`${b.code}`,'zh-CN'));const locations=[...new Set(rows.map(row=>row.warehouse+'/'+row.bin))].join(' / ');return `<details class="tree-box"${treeState.query.trim()?' open':''}><summary><span class="tree-title">${esc(box.key)}</span><span class="tree-meta">${rows.length} ${t('项','items')} · ${unitSummaryRows(rows)} · ${esc(locations)}</span></summary><div class="tree-leaves">${rows.map(treeLeaf).join('')}</div></details>`;}
function treeBatchHtml(batch){const boxes=treeSort(groupRows(batch.rows,row=>row.box||'未分配箱号'),'box');return `<details class="tree-batch"${treeState.query.trim()?' open':''}><summary><span class="tree-title">${esc(batch.key)}</span><span class="tree-meta">${boxes.length} ${t('箱','boxes')} · ${unitSummaryRows(batch.rows)}</span></summary><div class="tree-level">${boxes.map(treeBoxHtml).join('')}</div></details>`;}
function treeContractHtml(contract){const batches=treeSort(groupRows(contract.rows,row=>row.batch||'未分配批次'),'batch');return `<details class="tree-contract" open><summary><span class="tree-title">${esc(segmentLabel(contract.key))}</span><span class="tree-meta">${contract.rows.length} ${t('条库存明细','stock lines')} · ${unitSummaryRows(contract.rows)}</span><button class="quiet small tree-contract-open" data-contract="${esc(contract.key)}">${t('单独查看','Open contract')}</button></summary><div class="tree-level">${batches.map(treeBatchHtml).join('')}</div></details>`;}
function inventoryTreeHTML(){const rows=filteredTreeRows();const contracts=treeSort(groupRows(rows,row=>row.package||'未指定标段'),'contract');const opts=(values,current,allLabel)=>`<option value="">${allLabel}</option>${values.map(v=>`<option value="${esc(v)}" ${v===current?'selected':''}>${esc(segmentLabel(v))}</option>`).join('')}`;const values=(key)=>{const current=(db.stock||[]).map(row=>row[key]).filter(Boolean);if(key==='package')current.push(...(db.segments||[]).map(s=>s.code));return [...new Set(current)].sort((a,b)=>key==='package'?(segmentIndex(a)-segmentIndex(b)||a.localeCompare(b,'zh-CN')):a.localeCompare(b,'zh-CN'));};const controls=`<div class="tree-filters"><input id="tree-search" aria-label="${t('搜索库存','Search stock')}" class="search" value="${esc(treeState.query)}" placeholder="${t('搜索名称、规格、箱号或箱内物资','Search name, specification, box or contents')}"><select id="tree-contract" aria-label="${t('筛选标段','Filter segment')}">${opts(values('package'),treeState.contract,t('全部标段','All segments'))}</select><select id="tree-batch" aria-label="${t('筛选批次','Filter batch')}">${opts(values('batch'),treeState.batch,t('全部批次','All batches'))}</select><select id="tree-warehouse" aria-label="${t('筛选仓库','Filter warehouse')}">${opts(values('warehouse'),treeState.warehouse,t('全部仓库','All warehouses'))}</select><select id="tree-state" aria-label="${t('筛选状态','Filter status')}">${opts(values('state'),treeState.state,t('全部状态','All states'))}</select><select id="tree-sort" aria-label="${t('库存排序','Sort stock')}"><option value="contract" ${treeState.sort==='contract'?'selected':''}>${t('按标段排序','Sort by segment')}</option><option value="batch" ${treeState.sort==='batch'?'selected':''}>${t('按批次排序','Sort by batch')}</option><option value="box" ${treeState.sort==='box'?'selected':''}>${t('按箱号排序','Sort by box')}</option><option value="item" ${treeState.sort==='item'?'selected':''}>${t('按物资排序','Sort by item')}</option><option value="qty" ${treeState.sort==='qty'?'selected':''}>${t('按数量排序','Sort by quantity')}</option></select><button class="quiet small" data-tree-toggle="open">${t('全部展开','Expand all')}</button><button class="quiet small" data-tree-toggle="closed">${t('全部收起','Collapse all')}</button></div>`;const filtered=!!(treeState.query.trim()||treeState.contract||treeState.batch||treeState.warehouse||treeState.state);const results=`<div class="tree-results"><span>${filtered?t('筛选到','Matched'):t('当前库存','Current stock')} <strong>${fmt(rows.length)}</strong> ${t('条库存明细','stock lines')} · ${unitSummaryRows(rows)}</span>${filtered?`<button class="quiet small" data-tree-reset="true">${t('清除筛选','Clear filters')}</button>`:''}</div>`;if(!contracts.length)return inventoryModesHTML()+controls+results+empty(t('没有符合条件的库存','No stock matches the filters'),t('调整筛选条件，或先确认一批入库。','Adjust the filters or post a receipt first.'));return inventoryModesHTML()+controls+results+(inventoryLayout==='list'?stockListHTML(rows):`<div class="tree">${contracts.map(treeContractHtml).join('')}</div>`);}
function renderInventoryTree(){const el=$('inventory-tree');if(!el)return;el.innerHTML=inventoryTreeHTML();const stateSelect=$('tree-state');if(stateSelect)[...stateSelect.options].forEach(option=>{if(option.value)option.textContent=label(option.value);});}
function contractIndex(){return `<section class="panel inventory-tree-panel"><div class="panel-top"><div><h2>${t('库存物资','Stock materials')}</h2><p>${t('搜索物资，选择实际箱号和库位加入发料；也可切换按箱查看。','Find materials and add the actual stock position to an issue, or switch to boxes.')}</p></div></div><div id="inventory-tree">${inventoryTreeHTML()}</div></section>`;}
function reconciliationPanel(){
 const audit=db?.reconciliation||{ok:true,issues:[]}, issues=audit.issues||[];
 const issueText=i=>i.kind==='ledger_mismatch'
  ? `${esc(i.code)} · ${t('库存位置与流水差异','Stock and ledger differ')} ${fmt(i.difference)} ${esc(i.unit||'')}`
  : i.kind==='over_contract'
   ? `${esc(i.code)} · ${t('累计入库超过合同/设计数量','Receipts exceed contract/design quantity')} ${fmt(i.difference)} ${esc(i.unit||'')}`
   : `${esc(i.code||'')} · ${t('需要核对','Needs review')}`;
 return `<section class="panel reconciliation-panel"><div class="panel-top"><div><h2>${t('账面核对','Ledger check')}</h2><p>${t('只检查并提示，不会自动修改库存。','Checks and alerts only; nothing is changed automatically.')}</p></div><span class="tag ${audit.ok?'AVAILABLE':'QUARANTINE'}">${audit.ok?t('核对通过','Check passed'):t(`${issues.length} 项异常`,` ${issues.length} issue(s)`)}</span></div>${audit.ok?`<div class="success-box">${t('流水、库存位置和合同数量目前一致。','Movements, stock positions and known contract quantities are consistent.')}</div>`:`<div class="warning-list">${issues.slice(0,8).map(issueText).join('<br>')}${issues.length>8?`<br>${t('其余异常请到流水总账查看。','Open the transaction ledger for the remaining issues.')}`:''}</div>`}</section>`;
}
function unitTotals(rows){const totals={};(rows||[]).forEach(r=>{const unit=r.unit||'—';totals[unit]=(totals[unit]||0)+Number(r.qty||0);});return Object.entries(totals).map(([unit,qty])=>`${fmt(qty)} ${esc(unit)}`).join(' / ')||'—';}
function dashboard(){
 if(selectedContract)return contractPage(selectedContract);
 const validDocs=db.documents.filter(d=>!d.reversed_by), inboundDocs=validDocs.filter(d=>d.kind==='IN'), outboundDocs=validDocs.filter(d=>d.kind==='OUT');
 const held=db.stock.filter(s=>['PENDING','QUARANTINE'].includes(s.state));
 const recent=validDocs.slice(0,6);
 const contractRows=(db.contracts||[]).filter(g=>segmentByCode(g.code)).sort((a,b)=>segmentIndex(a.code)-segmentIndex(b.code));
 const unmappedRows=(db.contracts||[]).filter(g=>!segmentByCode(g.code));
 return `<p class="intro dashboard-intro">${t('先处理待核对的入库资料，再查库存、办理发料。','Review pending receipts, find stock and prepare issues.')}</p>
 <section class="panel workbench-tasks"><h2>今日办理</h2><div class="actions"><button class="quiet" data-page="recognitions">待处理入库 ${fmt(db.recognition_pending||0)} 份</button><button class="quiet" data-page="inbound">＋ 录入到货资料</button><button class="quiet" data-page="inventory">查库存 / 选料</button><button class="quiet" data-page="outbound">确认发料 ${cart.length?`· ${cart.length} 条`:""}</button></div></section><div class="metrics dashboard-metrics">${[[contractRows.length,t('固定标段','Fixed segments'),t('A1-A16','A1-A16')],[db.stock.length,t('库存明细','Stock lines'),t('批次、箱号、库位','Batch, box and bin')],[inboundDocs.length,t('入库单','Receipt documents'),t('确认后自动更新库存','Postings update stock')],[outboundDocs.length,t('出库单','Issue documents'),t('独立单号，来源可追溯','Unique numbers, traceable sources')]].map(m=>`<div class="metric"><small>${m[1]}</small><b>${fmt(m[0])}</b><em>${m[2]}</em></div>`).join('')}</div>
 <div class="dashboard-grid"><section class="panel segment-panel"><div class="panel-top"><div><h2>${t('标段总览','Segment overview')}</h2><p>${t('只突出设计总量、到货率、剩余率和备品；不同单位分别计算百分比。','Show design total, received rate, remaining rate and spares; percentages are calculated separately by unit.')}</p></div><button class="quiet" data-page="inventory">${t('打开仓库明细','Open warehouse detail')}</button></div>${contractRows.length?table([t('标段','Segment'),t('物资明细','Item lines'),t('设计总量','Design total'),t('到货率','Received %'),t('剩余率','Remaining %'),t('备品','Spares'),t('最近入库','Latest receipt'),t('操作','Action')],contractRows.map(g=>`<tr><td><span class="name">${esc(segmentLabel(g.code))}</span></td><td>${fmt(g.item_count||0)}</td><td class="name">${qtySummary(g,'current')}</td><td>${pctSummary(g,'received')}</td><td>${pctSummary(g,'outstanding')}</td><td>${qtySummary(g,'spare')}</td><td>${dateText(g.inbound_last)}</td><td><button class="quiet small" data-contract="${esc(g.code)}">${t('查看标段','Open segment')}</button></td></tr>`)):empty(t('还没有标段库存','No segment stock yet'),t('从入库办理上传第一批到货清单。','Upload the first arrival list from Receipts.'))}${unmappedRows.length?`<div class="warning-list">${t('发现未映射的历史标段记录，请核对后再纳入A1-A16。','Unmapped historical segment records were found. Review them before assigning A1-A16.') } ${unmappedRows.map(g=>`${esc(g.code)}（${fmt(g.item_count||0)} ${t('项','items')}）`).join('；')}</div>`:''}</section>
 <section class="panel attention-panel ${held.length?'has-held':'clear'}"><div class="panel-top"><div><h2>${t('需要关注','Needs attention')}</h2><p>${t('这里仅提示，不会自动修改库存。','Alerts only; nothing is changed automatically.')}</p></div></div>${held.length?`<div class="warning-list">${t(`有 ${held.length} 条库存处于待检或隔离，普通出库已限制。`,` ${held.length} stock lines are pending inspection or quarantined; normal issue is blocked.`)}</div>`:`<div class="success-box">${t('当前没有待检或隔离库存。','No pending or quarantined stock.')}</div>`}<div class="actions"><button class="quiet" data-page="inbound">${t('办理入库','Create receipt')}</button><button class="quiet" data-page="outbound">${t('办理出库','Create issue')}</button><button class="quiet" data-page="ledger">${t('查看流水总账','Open transaction ledger')}</button></div></section></div>
 <section class="panel recent-documents"><div class="panel-top"><div><h2>${t('最近业务单据','Recent documents')}</h2><p>${t('入库和出库均由系统生成单据，补打不会重复计算。','Receipts and issues are system-generated; reprints never repost quantities.')}</p></div><button class="quiet" data-page="documents">${t('全部单据','All documents')}</button></div>${recent.length?table([t('单号 / 时间','Number / Time'),t('类型','Type'),t('业务单号','Reference'),t('经办人','Operator'),t('状态','Status')],recent.map(d=>`<tr><td><span class="code">${esc(d.number)}</span><div class="sub">${esc(d.created)}</div></td><td>${badge(d.kind)}</td><td>${esc(d.external_ref)||'—'}</td><td>${esc(d.operator)}</td><td>${d.reversed_by?t('已冲销','Reversed'):t('已确认','Posted')}</td></tr>`)):empty(t('暂无业务单据','No documents yet'),t('确认入库或出库后会出现在这里。','Confirmed receipts and issues will appear here.'))}</section>
 ${reconciliationPanel()}
 <section class="panel"><div class="panel-top"><div><h2>${t('备品单独查看','Spares are separate')}</h2><p>${t('备品不并入主物资设计量和主库存统计。','Spares are kept separate from main design quantity and stock.')}</p></div><button class="quiet" data-page="spares">${t('打开备品情况','Open spares')}</button></div></section>`;
}

let ledgerState={ready:false,q:'',kind:'',loading:false,rows:[],total:0,hasMore:false};
let ledgerTimer=null;
const LEDGER_PAGE=300;
function ledgerReset(){ledgerState={ready:true,q:'',kind:'',loading:false,rows:db?.ledger||[],total:Number(db?.ledger_total??(db?.ledger||[]).length),hasMore:!!db?.ledger_has_more};}
function ledgerRowHtml(r){
 return `<tr data-ledger-kind="${esc(r.kind)}"><td>${dateText(r.date)}</td><td><button class="quiet small" data-doc="${r.doc_id}">${esc(r.number)}</button></td><td>${badge(r.kind)}</td><td><span class="name">${esc(r.name)}</span><div class="sub">${esc(r.code)}${r.spec?' · '+esc(r.spec):''}</div></td><td class="${r.delta<0?'warning':'name'}">${r.delta>0?'+':''}${fmt(r.delta)} ${esc(r.unit)}</td><td>${esc(segmentLabel(r.package))}<div class="sub">${esc(r.batch)} · ${esc(r.box)||'—'}</div></td><td>${esc(r.warehouse)} / <b>${esc(r.bin)}</b></td><td>${esc(r.operator)}</td></tr>`;
}
function ledgerTableHTML(){
 const rows=ledgerState.rows,shown=rows.length,total=ledgerState.total,filtered=!!(ledgerState.q||ledgerState.kind);
 // 正在请求时不要显示上一个条件的合计数，宁可先说“加载中”。
 const status=ledgerState.loading
  ?t('加载中…','Loading...')
  :filtered
   ?t(`筛选到 ${fmt(total)} 条，已显示 ${fmt(shown)} 条`,'Matched '+fmt(total)+' records, '+fmt(shown)+' shown')
   :t(`流水共 ${fmt(total)} 条，默认显示最近 ${fmt(shown)} 条`,'Ledger holds '+fmt(total)+' records; showing the latest '+fmt(shown));
 if(!rows.length)return `<p class="helper">${status}</p>`+(filtered
  ?empty(t('没有符合条件的流水','No matching transactions'),t('换个关键词或类型再试；搜索覆盖全部流水。','Try another keyword or type. Search covers the whole ledger.'))
  :empty(t('暂无流水','No transactions yet'),t('确认入库或出库后会自动生成。','Transactions appear after a receipt or issue is confirmed.')));
 const more=ledgerState.hasMore
  ?`<div class="ledger-more"><button class="quiet" data-action="ledger-more" ${ledgerState.loading?'disabled':''}>${ledgerState.loading?t('加载中…','Loading...'):t(`加载更早的 ${fmt(Math.min(LEDGER_PAGE,total-shown))} 条`,'Load '+fmt(Math.min(LEDGER_PAGE,total-shown))+' older records')}</button></div>`
  :(filtered?'':`<p class="helper">${t('已显示全部流水。','All transactions are shown.')}</p>`);
 return `<p class="helper">${status}</p>`+table([t('时间','Date'),t('单据号','Document'),t('类型','Type'),t('物资','Item'),t('数量变化','Change'),t('标段 / 批次 / 箱号','Segment / Batch / Box'),t('仓库 / 库位','Warehouse / Bin'),t('经办人','Operator')],rows.map(ledgerRowHtml))+more;
}
async function loadLedger(append){
 if(ledgerState.loading)return;
 ledgerState.loading=true;
 let box=$('ledger-table');if(box)box.innerHTML=ledgerTableHTML();
 try{
  const params=new URLSearchParams({limit:String(LEDGER_PAGE),offset:String(append?ledgerState.rows.length:0)});
  if(ledgerState.q)params.set('q',ledgerState.q);
  if(ledgerState.kind)params.set('kind',ledgerState.kind);
  const res=await api('/api/ledger?'+params.toString());
  ledgerState.rows=append?ledgerState.rows.concat(res.rows||[]):(res.rows||[]);
  ledgerState.total=Number(res.total||0);ledgerState.hasMore=!!res.has_more;
 }catch(e){notice(e.message,true);}
 ledgerState.loading=false;
 box=$('ledger-table');if(box)box.innerHTML=ledgerTableHTML();
}
function scheduleLedgerSearch(){
 clearTimeout(ledgerTimer);
 ledgerTimer=setTimeout(()=>{const el=$('ledger-search');if(!el)return;ledgerState.q=el.value.trim();loadLedger(false);},300);
}
function ledgerPage(){
 if(!ledgerState.ready)ledgerReset();
 const kinds=[['','全部类型','All types'],['IN','只看入库','Receipts only'],['OUT','只看出库','Issues only'],['HANDOVER','只看备品移交','Spares handover only'],['MOVE','只看移库','Bin transfers only'],['STATE','只看状态调整','Status changes only'],['REV','只看更正','Corrections only']];
 return `<p class="intro">${t('流水总账记录每一笔入库、出库和更正，用于追溯；库存总量由这些流水自动计算。','The transaction ledger records every receipt, issue and correction for traceability; stock is calculated from these movements.')}</p>${reconciliationPanel()}<section class="panel"><div class="panel-top"><div><h2>${t('流水总账','Transaction ledger')}</h2><p>${t('搜索和筛选覆盖全部流水（不只当前已显示的记录）。点击单据号可查看完整单据。','Search and filters cover the whole ledger, not just the loaded rows. Click a document number to open the full document.')}</p></div><div class="actions"><input id="ledger-search" class="search" value="${esc(ledgerState.q)}" placeholder="${t('搜索单号、物资、标段、批次、箱号、库位','Search number, item, segment, batch, box or bin')}"><select id="ledger-kind">${kinds.map(([v,zh,en])=>`<option value="${v}" ${ledgerState.kind===v?'selected':''}>${t(zh,en)}</option>`).join('')}</select></div></div><div id="ledger-table">${ledgerTableHTML()}</div></section>`;
}

// The item master is unbounded too, so it follows the ledger's shape: the
// refresh ships one bounded page, and search/load-more go through /api/items.
// Search has to run on the server - filtering only the loaded rows would
// silently miss every match that has not been paged in yet.
let itemsState={ready:false,q:'',package:'',loading:false,rows:[],total:0,hasMore:false,issued:['累计出库','Issued']};
let itemsTimer=null;
const ITEMS_PAGE=300;
function itemsReset(){itemsState={ready:true,q:'',package:'',loading:false,rows:db?.items||[],total:Number(db?.items_total??(db?.items||[]).length),hasMore:!!db?.items_has_more,issued:itemsState.issued};}
function itemsRowHtml(r){
 // Deliberately no data-search attribute: the global client-side filter would
 // then hide/show rows of an incomplete slice and report wrong matches.
 return `<tr data-item-code="${esc(r.code)}"><td><span class="code">${esc(r.code)}</span><br><span class="name">${esc(r.name)}</span><div class="sub">${esc(r.spec)}</div></td><td>${esc(segmentLabel(r.package))}</td><td>${esc(r.unit)}</td><td>${fmt(r.baseline)} / ${fmt(r.change)}</td><td>${fmt(r.current)}</td><td>${fmt(r.received)}</td><td>${fmt(r.issued)}</td><td>${fmt(r.handed)}</td><td class="name">${fmt(r.onhand)}</td><td>${fmt(r.outstanding)}</td></tr>`;
}
function itemsTableHTML(){
 const rows=itemsState.rows,shown=rows.length,total=itemsState.total,filtered=!!(itemsState.q||itemsState.package);
 // While a request is in flight, say so rather than showing the previous
 // filter's total, which would be a wrong number on screen.
 const status=itemsState.loading
  ?t('加载中…','Loading...')
  :filtered
   ?t(`筛选到 ${fmt(total)} 条，已显示 ${fmt(shown)} 条`,'Matched '+fmt(total)+' items, '+fmt(shown)+' shown')
   :t(`物资共 ${fmt(total)} 条，默认显示前 ${fmt(shown)} 条`,'Catalogue holds '+fmt(total)+' items; showing the first '+fmt(shown));
 if(!rows.length)return `<p class="helper">${status}</p>`+(filtered
  ?empty(t('没有符合条件的物资','No matching items'),t('换个关键词或标段再试；搜索覆盖全部物资。','Try another keyword or segment. Search covers the whole catalogue.'))
  :empty(t('从第一批物资开始','Start with your first receipt'),t('打开 Excel 入库，上传物资清单；也可以先导入设计总量。','Open Excel receipt to upload a list, or import the design baseline first.')));
 const more=itemsState.hasMore
  ?`<div class="ledger-more"><button class="quiet" data-action="items-more" ${itemsState.loading?'disabled':''}>${itemsState.loading?t('加载中…','Loading...'):t(`加载后续 ${fmt(Math.min(ITEMS_PAGE,total-shown))} 条`,'Load '+fmt(Math.min(ITEMS_PAGE,total-shown))+' more')}</button></div>`
  :(filtered?'':`<p class="helper">${t('已显示全部物资。','All items are shown.')}</p>`);
 return `<p class="helper">${status}</p>`+table([t('物资 / 规格','Item / Specification'),t('标段','Segment'),t('单位','Unit'),t('设计 / 变更','Baseline / Change'),t('现行需求','Requirement'),t('累计入库','Received'),t(itemsState.issued[0],itemsState.issued[1]),t('已移交','Handed over'),t('在库','On hand'),t('未到货','Outstanding')],rows.map(itemsRowHtml))+more;
}
async function loadItems(append){
 if(itemsState.loading)return;
 itemsState.loading=true;
 let box=$('items-table');if(box)box.innerHTML=itemsTableHTML();
 try{
  const params=new URLSearchParams({limit:String(ITEMS_PAGE),offset:String(append?itemsState.rows.length:0)});
  if(itemsState.q)params.set('q',itemsState.q);
  if(itemsState.package)params.set('package',itemsState.package);
  const res=await api('/api/items?'+params.toString());
  itemsState.rows=append?itemsState.rows.concat(res.rows||[]):(res.rows||[]);
  itemsState.total=Number(res.total||0);itemsState.hasMore=!!res.has_more;
 }catch(e){notice(e.message,true);}
 itemsState.loading=false;
 box=$('items-table');if(box)box.innerHTML=itemsTableHTML();
}
function scheduleItemsSearch(){
 clearTimeout(itemsTimer);
 itemsTimer=setTimeout(()=>{const el=$('items-search');if(!el)return;itemsState.q=el.value.trim();loadItems(false);},300);
}
function itemsSearchBox(){
 return `<input id="items-search" class="search" value="${esc(itemsState.q)}" placeholder="${t('搜索名称、编码、标段、规格','Search name, code, lot or specification')}">`;
}

// The segment page needs the item rows of exactly one segment. They are fetched
// on demand now instead of riding along inside every contract group.
let contractState={code:'',ready:false,loading:false,rows:[],total:0,hasMore:false};
function contractRowHtml(r){
 return `<tr><td><span class="code">${esc(r.code)}</span><br><span class="name">${esc(r.name)}</span></td><td>${esc(r.spec)||'—'} / ${esc(r.unit)}${r.attribute?' · '+esc(r.attribute):''}</td><td>${r.current===null?'—':fmt(r.current)}</td><td>${fmt(r.received)}</td><td>${fmt(r.issued)}</td><td class="name">${fmt(r.onhand)}</td><td>${dateRange(r.inbound_first,r.inbound_last)}</td><td>${dateRange(r.outbound_first,r.outbound_last)}</td></tr>`;
}
function contractItemsTableHTML(){
 const rows=contractState.rows;
 if(!rows.length)return contractState.loading
  ?`<p class="helper">${t('加载中…','Loading...')}</p>`
  :empty(t('该标段暂无物资','No items in this segment'),t('该标段还没有入库记录。','No receipts have been posted for this segment yet.'));
 const more=contractState.hasMore
  ?`<div class="ledger-more"><button class="quiet" data-action="contract-more" ${contractState.loading?'disabled':''}>${contractState.loading?t('加载中…','Loading...'):t(`加载后续 ${fmt(Math.min(ITEMS_PAGE,contractState.total-rows.length))} 条`,'Load '+fmt(Math.min(ITEMS_PAGE,contractState.total-rows.length))+' more')}</button></div>`
  :'';
 return table([t('设备编码 / 名称','Equipment code / name'),t('规格 / 单位','Specification / Unit'),t('标段数量','Segment qty'),t('入库数量','Received'),t('出库数量','Issued'),t('当前库存','On hand'),t('入库日期','Receipt dates'),t('出库日期','Issue dates')],rows.map(contractRowHtml))+more;
}
async function loadContractItems(append){
 const state=contractState,code=state.code;if(!code||state.loading)return;
 state.loading=true;
 let box=$('contract-items');if(box)box.innerHTML=contractItemsTableHTML();
 try{
  const params=new URLSearchParams({limit:String(ITEMS_PAGE),offset:String(append?state.rows.length:0),package:code});
  const res=await api('/api/items?'+params.toString());
  if(contractState!==state)return;
  state.rows=append?state.rows.concat(res.rows||[]):(res.rows||[]);
  state.total=Number(res.total||0);state.hasMore=!!res.has_more;
 }catch(e){if(contractState===state)notice(e.message,true);}
 finally{state.loading=false;}
 if(contractState!==state)return;
 box=$('contract-items');if(box)box.innerHTML=contractItemsTableHTML();
}
function ensureContractItems(code){
 if(contractState.code===code&&contractState.ready)return;
 contractState={code:code,ready:true,loading:false,rows:[],total:0,hasMore:false};
 loadContractItems(false);
}

function sparesPage(){
 const rows=(db.stock||[]).filter(s=>s.state==='SPARE');
 return `<p class="intro">${t('备品单独管理和单独存放，不计入主物资库存和设计量。','Spares are managed and stored separately from main stock and design quantity.')}</p><div class="metrics"><div class="metric"><small>${t('备品库存明细','Spare stock lines')}</small><b>${fmt(rows.length)}</b><em>${t('仅显示预留备品状态','Reserved spares only')}</em></div><div class="metric"><small>${t('备品数量','Spare quantity')}</small><b>${unitTotals(rows)}</b><em>${t('按单位分别统计','Grouped by unit')}</em></div><div class="metric"><small>${t('备品移交单','Spares handovers')}</small><b>${fmt(db.documents.filter(d=>d.kind==='HANDOVER'&&!d.reversed_by).length)}</b><em>${t('独立单据','Separate documents')}</em></div></div><section class="panel"><div class="panel-top"><div><h2>${t('备品明细','Spare detail')}</h2></div><button class="quiet" data-page="outbound">${t('办理备品移交','Handover spares')}</button></div>${rows.length?table([t('物资','Item'),t('批次 / 箱号','Batch / Box'),t('仓库 / 库位','Warehouse / Bin'),t('数量','Quantity'),t('属性','Attribute')],rows.map(s=>`<tr><td><span class="name">${esc(s.name)}</span><div class="sub">${esc(s.code)}${s.spec?' · '+esc(s.spec):''}</div></td><td>${esc(s.batch)} / ${esc(s.box)||'—'}</td><td>${esc(s.warehouse)} / <b>${esc(s.bin)}</b></td><td>${fmt(s.qty)} ${esc(s.unit)}</td><td>${esc(s.attribute)||'—'}</td></tr>`)):empty(t('暂未登记备品','No spares registered'),t('备品确认入库后会单独出现在这里。','Confirmed spare receipts appear here separately.'))}</section>`;
}
function contractPage(code){const g=(db.contracts||[]).find(x=>x.code===code);if(!g){selectedContract='';return overview();}const stock=db.stock.filter(s=>s.package===g.code);return `<p class="intro"><button class="quiet small" data-contract-back="1">← ${t('返回标段列表','Back to segments')}</button></p><div class="panel"><div class="panel-top"><div><div class="eyebrow">SEGMENT</div><h2>${esc(segmentLabel(g.code))}</h2><p>${t('该标段的设备、数量、库存位置和收发日期','Equipment, quantities, stock positions and transaction dates for this segment')}</p></div><span class="tag">${t('单独库存页','Segment inventory')}</span></div><div class="metrics"><div class="metric"><small>${t('标段数量','Segment qty')}</small><b>${qtySummary(g,'current')}</b></div><div class="metric"><small>${t('累计入库','Received')}</small><b>${qtySummary(g,'received')}</b></div><div class="metric"><small>${t('累计出库','Issued')}</small><b>${qtySummary(g,'issued')}</b></div><div class="metric"><small>${t('当前库存','On hand')}</small><b>${qtySummary(g,'onhand')}</b></div></div><div id="contract-items">${contractItemsTableHTML()}</div></div><section class="panel"><div class="panel-top"><h2>${t('该标段库存位置','Stock positions in this segment')}</h2><button class="quiet" data-page="outbound">${t('办理出库','Issue stock')}</button></div>${stock.length?table([t('设备','Equipment'),t('到货批次','Arrival batch'),t('箱号','Box no.'),t('仓库 / 库位','Warehouse / Bin'),t('状态','Status'),t('数量','Quantity')],stock.map(s=>`<tr><td><span class="code">${esc(s.code)}</span><br>${esc(s.name)}</td><td>${esc(s.batch)}</td><td>${esc(s.box)||'—'}</td><td>${esc(s.warehouse)} / <b>${esc(s.bin)}</b></td><td>${badge(s.state)}</td><td>${stockBalanceText(s)}</td></tr>`)):empty(t('该标段暂无在库数量','No on-hand stock for this segment'),t('入库确认后，位置和数量会在这里显示。','Confirmed receipts will appear here with locations and quantities.'))}</section>`;}
function materialsOverview(){
 if(selectedContract)return contractPage(selectedContract);
 if(!itemsState.ready)itemsReset();
 itemsState.issued=['累计出库','Issued'];
 return `<p class="intro">${t('按物资编码查看设计数量、累计入库、出库和当前结余。','Review design quantities, receipts, issues and balances by item code.')}</p>
 <div class="metrics">${[[(db?.item_counts?.total??0),'物资种类','Item types','按物资编码区分','By item code'],[(db?.item_counts?.in_stock??0),'当前有库存物资','Items in stock','至少有一条在库记录','At least one stock position'],[(db?.item_counts?.outstanding??0),'未到货物资','Outstanding items','按设计量与入库量比较','Compared with receipts'],[db.changes.length,'设计变更记录','Design changes','不改变实物库存','Do not change physical stock']].map(m=>`<div class="metric"><small>${t(m[1],m[2])}</small><b>${fmt(m[0])}</b><em>${t(m[3],m[4])}</em></div>`).join('')}</div>
 <section class="panel"><div class="panel-top"><div><h2>${t('物资明细','Item detail')}</h2><p>${t('这是物资层入口；要查箱子和箱内件，请进入“库存总览”。','This is the item-level entry. Open Inventory for boxes and contents.')}</p></div><div class="actions">${itemsSearchBox()}<a class="quiet" href="/api/export">${t('导出物资','Export items')}</a></div></div>
 <div id="items-table">${itemsTableHTML()}</div></section>`;
}
function overview(){
 if(selectedContract)return contractPage(selectedContract);
 if(!itemsState.ready)itemsReset();
 itemsState.issued=['累计领用','Issued'];
 const pending=db.stock.filter(s=>s.state==='PENDING'||s.state==='QUARANTINE').length;
 return `<p class="intro inventory-intro">${t('从设计需求到库存位置，查看每一种物资的当前情况。','Review requirements, receipts, issues and exact storage positions.')}</p>
 <div class="metrics inventory-metrics">${[[(db?.item_counts?.total??0),'物资种类','Item types','按编码区分','By item code'],[db.stock.length,'有库存的货位明细','Stock positions','批次 / 库位 / 状态','Batch / bin / status'],[pending,'待检或隔离明细','Held positions','普通出库已限制','Blocked from normal issue'],[db.documents.filter(d=>d.kind==='OUT'&&!d.reversed_by).length,'有效出库单','Active issue notes','补打不重复扣库','Reprints do not deduct stock']].map(m=>`<div class="metric"><small>${t(m[1],m[2])}</small><b>${fmt(m[0])}</b><em>${t(m[3],m[4])}</em></div>`).join('')}</div>
 ${contractIndex()}
 <details class="secondary-view"><summary>${t('辅助明细：平面台账与库位表','Supporting detail: flat ledger and locations')}</summary>
 <section class="panel"><div class="panel-top"><div><h2>${t('物资台账','Materials ledger')}</h2><p>${t('数量按各自单位显示；厂家明细按固定标段关联。','Quantities retain their own units. Supplier details link through the fixed segments.')}</p></div><div class="actions">${itemsSearchBox()}<a class="quiet" href="/api/export">${t('导出库存','Export stock')}</a></div></div>
 <div id="items-table">${itemsTableHTML()}</div></section>
 <section class="panel"><div class="panel-top"><h2>${t('库存位置','Stock locations')}</h2><button class="quiet" data-page="outbound">${t('办理出库 / 移库','Issue / transfer')}</button></div>${stockTable()}</section></details>
 <section class="panel"><details><summary>${t('发运批次及状态','Shipment batches and status')}</summary><p class="helper">${t('物流状态手动选择并留痕；不会改变库存数量。到货批次使用B01、B02等简短编号。','Transport status changes are logged and do not alter stock quantities. Use short arrival batch codes such as B01 and B02.')}</p><div class="form-grid">${input('batch-code',t('到货批次号 *','Arrival batch *'))}${input('batch-supplier',t('厂家','Supplier'))}<label>${t('物流状态','Transport status')}<select id="batch-status">${options(['PLANNED','DISPATCHED','SEA','CUSTOMS','RELEASED','ROAD','ARRIVED'])}</select></label>${input('batch-operator',t('经办人 *','Operator *'),sessionStorage.getItem('operator')||'')}${input('batch-note',t('备注 / 依据','Note / Reference'))}</div><button data-action="batch-save">${t('保存批次状态','Save batch status')}</button>${db.batches.length?table([t('合同批次','Contract batch'),t('厂家','Supplier'),t('状态','Status'),t('更新时间','Updated')],db.batches.map(b=>`<tr><td>${esc(b.code)}</td><td>${esc(b.supplier)}</td><td>${badge(b.status)}</td><td>${esc(b.updated)}</td></tr>`)):''}<details><summary>${t('状态记录','Status history')}</summary>${table([t('批次','Batch'),t('原状态','Previous'),t('新状态','New'),t('经办人','Operator'),t('备注','Note')],db.events.map(e=>`<tr><td>${esc(e.batch)}</td><td>${esc(label(e.old_status||'—'))}</td><td>${esc(label(e.new_status))}</td><td>${esc(e.operator)}</td><td>${esc(e.note)}</td></tr>`))}</details></details></section>
 <section class="panel"><details><summary>${t('设计基准与变更','Design baseline and changes')}</summary><p class="helper">${t('设计量首次导入后锁定；变更单独记录，不修改实际库存。','The first baseline is locked. Changes are recorded separately and never alter physical stock.')}</p><button class="quiet" data-action="baseline">${t('导入设计总量','Import baseline')}</button><div class="form-grid">${input('change-code',t('物资编码 *','Item code *'))}${input('change-qty',t('变更量（增加为正，减少为负）','Change (+ increase / − decrease)'),'', 'number','step="1"')}${input('change-operator',t('经办人 *','Operator *'),sessionStorage.getItem('operator')||'')}${input('change-reason',t('变更依据及原因 *','Change reference and reason *'))}</div><button data-action="change-save">${t('记录设计变更','Record design change')}</button>${table([t('编码','Code'),t('变更量','Change'),t('依据','Reference'),t('经办人','Operator')],db.changes.map(c=>`<tr><td>${esc(c.code)}</td><td>${fmt(c.delta/1000000)}</td><td>${esc(c.reason)}</td><td>${esc(c.operator)}</td></tr>`))}</details></section>`;
}
function stockTable(){return db.stock.length?table([t('物资 / 标段','Item / Segment'),t('到货批次','Arrival batch'),t('箱号','Box no.'),t('仓库 / 库位','Warehouse / Bin'),t('状态','Status'),t('数量','Quantity')],db.stock.map(s=>`<tr data-search="${esc(Object.values(s).join(' ').toLowerCase())}"><td><span class="code">${esc(s.code)}</span><br>${esc(s.name)}<div class="sub">${esc(segmentLabel(s.package))}${s.attribute?' · '+esc(s.attribute):''}</div></td><td>${esc(s.batch)}</td><td>${esc(s.box)||'—'}</td><td>${esc(s.warehouse)} / <b>${esc(s.bin)}</b></td><td>${badge(s.state)}</td><td>${stockBalanceText(s)}</td></tr>`)):empty(t('暂无库存','No stock yet'),t('确认入库后，这里显示具体位置及数量。','Confirmed receipts appear here with quantities and locations.'));}
function inbound(){return `<p class="intro">${importKind==='BASELINE'?t('首次确认合同/设计数量；不会增加库存。','Confirm the contract/design baseline once; stock is unchanged.'):t('上传、粘贴或手动填写到货信息，核对后确认入库。','Upload, paste or enter arrival details, then review and confirm.')}</p><section class="panel intake-entry"><div class="panel-top"><div><div class="step-label">01 / ${t('录入到货信息','ARRIVAL INFORMATION')}</div><h2>${importKind==='BASELINE'?t('导入设计总量','Import design baseline'):t('到货单与装箱单','Arrival and packing lists')}</h2></div><a class="quiet" href="/api/template">${t('下载填写示例 CSV','Download sample CSV')}</a></div>
 <div class="success-box">${importKind==='BASELINE'?t('设计总量只录入一次并锁定；后续变化使用设计变更记录。','The design baseline is entered once and locked; later changes use a separate change record.'):t('原有厂家清单也可以使用。先识别，缺项由人工补充，确认后才改变库存。','Existing supplier formats are accepted. Review missing fields before stock is posted.')}</div>
 ${importKind==='IN'?intakeEntryHTML():`<div class="upload-box"><label>上传 .xlsx 或 .csv<input type="file" id="file" accept=".xlsx,.csv"></label><div id="filename" class="helper">${esc(upload?.filename||'')}</div></div>`}
 <div class="form-grid">${input('ref',t('业务单号（可留空自动生成）','Business reference (optional; auto-generated if blank)'),upload?.ref||'')}${input('operator',t('经办人 *','Operator *'),sessionStorage.getItem('operator')||'')}${input('party',t('厂家 / 供货单位','Supplier'))}<label>${t('标段 *','Segment *')}<select id="default-package" required>${segmentOptions(selectedSegment||upload?.segment||'')}</select></label>${input('default-batch',t('到货批次（自动生成）','Arrival batch (generated)'))}${input('default-warehouse',t('入库仓库','Receipt warehouse'),'主仓库')}${input('default-bin',t('入库库位','Receipt bin'),'待分配')}<label>${t('库存状态','Stock status')}<select id="default-state">${options(['AVAILABLE','PENDING','QUARANTINE','SPARE'],'AVAILABLE')}</select></label>${input('header',t('表头所在行（0=自动识别）','Header row (0 = auto detect)'),0,'number','min="0" max="100"')}<label>${t('工作表','Worksheet')}<select id="sheet">${preview?preview.sheets.map(s=>`<option ${s===preview.sheet?'selected':''}>${esc(s)}</option>`).join(''):`<option value="">${t('自动选择首张表','First worksheet')}</option>`}</select></label></div>
 <button data-action="inspect">${t('识别并预览','Read and preview')}</button><span class="helper"> ${t('仅预览，尚不入账','Preview only; no stock change')}</span></section><section id="preview"></section>`;}
function payload(){selectedSegment=$('default-package')?.value||selectedSegment;if(upload){upload.batchDate=$('batch-date')?.value||'';upload.batchNumber=$('batch-number')?.value.trim()||'1';upload.segment=selectedSegment;}return {...upload,kind:importKind,segment_required:true,arrival_date:$('batch-date')?.value||'',header:$('header').value,sheet:$('sheet').value,external_ref:$('ref').value,operator:$('operator').value,party:$('party').value,defaults:{package:selectedSegment,batch:composeBatch(),box:$('default-box')?.value||'',warehouse:$('default-warehouse').value,bin:$('default-bin').value,state:$('default-state').value}};}
function eligible(){return db.stock.filter(s=>action==='OUT'?s.state==='AVAILABLE':action==='HANDOVER'?s.state==='SPARE':true);}
function issueGroups(){
 const groups=new Map();
 eligible().forEach(s=>{
   const key=[s.code,s.name,s.spec,s.unit,s.package,s.attribute].map(v=>v||'').join('\u001f');
   if(!groups.has(key))groups.set(key,{key,code:s.code,name:s.name,spec:s.spec,unit:s.unit,package:s.package,attribute:s.attribute,rows:[],available:0});
   const g=groups.get(key);g.rows.push(s);g.available+=Number(s.qty||0);
 });
 return [...groups.values()].sort((a,b)=>`${a.package||''}${a.code||''}${a.name||''}`.localeCompare(`${b.package||''}${b.code||''}${b.name||''}`,'zh-CN'));
}
function applyBulkFilters(){
 const q=($('out-search')?.value||'').trim().toLowerCase(), pack=$('out-contract')?.value||'';
 document.querySelectorAll('[data-out-group]').forEach(row=>{const hay=(row.dataset.search||'').toLowerCase();row.hidden=!!((q&&!hay.includes(q))||(pack&&row.dataset.package!==pack));});
 const state=$('bulk-issue-state'), visible=[...document.querySelectorAll('[data-out-group]')].filter(row=>!row.hidden).length;
 if(state&&visible>1)state.textContent=t(`当前筛选匹配 ${visible} 项，请按物资编码、规格和属性确认；不同编码不会合并。`,`This filter matches ${visible} items. Confirm the item code, specification and attribute; different codes are never merged.`);
 if(state&&visible===1)state.textContent=t('当前筛选只匹配1项，可直接填写本次数量。','This filter matches one item. Enter the issue quantity directly.');
}
function bulkIssueHTML(){
 const groups=issueGroups(), packages=[...new Set(groups.map(g=>g.package).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'zh-CN'));
 if(!groups.length)return empty(t('没有可出库的可用库存','No available stock to issue'),t('待检、隔离和已出库库存不会出现在普通出库列表中。','Pending, quarantined and already issued stock are excluded from normal issues.'));
 const rows=groups.map((g,i)=>`<tr data-out-group="${i}" data-package="${esc(g.package||'')}" data-search="${esc([g.code,g.name,g.spec,g.package,g.attribute].filter(Boolean).join(' '))}"><td><input type="checkbox" data-group-check="${i}" ${(issueDraft.checked?.[g.key]??(groupCartQty(g)>0))?'checked':''} aria-label="${t('选择','Select')} ${esc(g.name||g.code)}"></td><td><span class="code">${esc(g.code)}</span><br><span class="name">${esc(g.name)}</span>${g.spec?`<div class="sub">${esc(g.spec)}</div>`:''}${g.attribute?`<div class="sub">${esc(g.attribute)}</div>`:''}</td><td>${esc(segmentLabel(g.package))}</td><td>${fmt(g.available)} ${esc(g.unit)}</td><td>${g.rows.length} ${t('个库位','locations')}</td><td><input type="number" min="0" max="${esc(g.available)}" step="1" data-group-qty="${i}" value="${esc(issueDraft.quantities?.[g.key]??(groupCartQty(g)||''))}" placeholder="0" aria-label="${t('本次数量','Issue quantity')} ${i+1}"></td></tr>`);
 return `<div class="bulk-toolbar"><input id="out-search" class="search" placeholder="${t('搜索物资、编码、规格','Search item, code or specification')}"><select id="out-contract"><option value="">${t('全部标段','All segments')}</option>${packages.map(v=>`<option value="${esc(v)}">${esc(segmentLabel(v))}</option>`).join('')}</select><button class="quiet small" data-out-bulk="all">${t('全选可见','Select visible')}</button><button class="quiet small" data-out-bulk="clear">${t('清空选择','Clear')}</button></div>${table([t('选择','Select'),t('物资','Material'),t('标段','Segment'),t('可用总量','Available total'),t('库位数','Locations'),t('本次数量','Issue qty')],rows)}`;
}
function addSelectedGroups(){
 const groups=issueGroups(), selected=[...document.querySelectorAll('[data-group-check]')].filter(cb=>cb.checked);
 if(!selected.length)throw Error(t('请先勾选要出库的物资','Select at least one material first'));
 selected.forEach(cb=>{
   const i=Number(cb.dataset.groupCheck), g=groups[i], qty=Number(document.querySelector(`[data-group-qty="${i}"]`)?.value||0);
   if(!(qty>0))throw Error(t(`请输入 ${g.name||g.code} 的本次数量`,`Enter an issue quantity for ${g.name||g.code}`));
   if(qty>g.available+1e-9)throw Error(t(`${g.name||g.code} 出库量超过可用总量`,`Issue quantity exceeds available total for ${g.name||g.code}`));
 });
 syncBulkCart();
}
function syncBulkCart(){
 if(issueMode!=='item')return;
 const groups=issueGroups(), next=[];let invalid=false, included=0;
 groups.forEach((g,i)=>{
   const field=document.querySelector(`[data-group-qty="${i}"]`), check=document.querySelector(`[data-group-check="${i}"]`), qty=Number(field?.value||0), selected=!!check?.checked;
   field?.classList.toggle('invalid',selected&&(!(qty>0)||qty>g.available+1e-9));
   if(!selected)return;
   if(!(qty>0)||qty>g.available+1e-9){invalid=true;return;}
   included++;
   const ids=new Set(g.rows.map(s=>s.id)),prior=cart.filter(r=>ids.has(r.stock_id));
   if(Math.abs(prior.reduce((sum,r)=>sum+Number(r.qty),0)-qty)<1e-9){next.push(...prior);return;}
   const priorIds=new Set(prior.map(r=>r.stock_id));
   let remaining=qty;g.rows.slice().sort((a,b)=>Number(!priorIds.has(a.id))-Number(!priorIds.has(b.id))||a.id-b.id).forEach(s=>{if(remaining<=1e-9)return;const part=Math.min(Number(s.qty||0),remaining);if(part>0){next.push({...prior.find(r=>r.stock_id===s.id),stock_id:s.id,qty:part});remaining-=part;}});
 });
 cart=next;
 saveBusinessDraft();
 const cartEl=$('cart');if(cartEl)cartEl.innerHTML=cartHTML();
 const post=document.querySelector('[data-action="post"]');if(post)post.disabled=!cart.length||invalid;
 const state=$('bulk-issue-state');if(state){const visible=[...document.querySelectorAll('[data-out-group]')].filter(row=>!row.hidden).length, caution=visible>1?t(`当前筛选还有 ${visible} 项，请按编码/规格确认。`,`There are ${visible} matching items; confirm code/specification.`):'';state.textContent=invalid?t('有物资未填有效正数，或超出可用库存，请修改后再确认。', 'Enter a positive quantity within available stock for every selected item.'):included?`${t(`${included} 项已自动加入待出库清单。`,`${included} item(s) are automatically added to the pending issue list.`)}${caution?` ${caution}`:''}`:(caution||t('填写数量后会自动加入待出库清单。','Enter a quantity to add it automatically to the pending issue list.'));state.className=invalid?'bulk-state invalid':'bulk-state';}
}
function outbound(){
 const bulk=action==='OUT'&&issueMode==='item';
 const picker=bulk?`<div class="bulk-issue"><div class="helper">${t('直接在“本次数量”填写数字，系统会自动加入待出库清单，并从多个批次和库位拆分。','Enter a number in “Issue qty” and it is added automatically; the system allocates across batches and locations.')}</div><div id="bulk-issue-list">${bulkIssueHTML()}</div><div id="bulk-issue-state" class="bulk-state">${t('填写数量后会自动加入待出库清单。','Enter a quantity to add it automatically to the pending issue list.')}</div></div>`:`<div class="actions"><label class="stock-pick" style="flex:1">${t('物资 / 标段 / 仓库 / 库位','Item / Segment / Warehouse / Bin')}<select id="stock-select"><option value="">${t('选择物资位置','Select stock position')}</option>${eligible().map(s=>`<option value="${s.id}">${esc(s.name)}${s.spec?' · '+esc(s.spec):''} · 箱 ${esc(s.box)||'—'} · 批次 ${esc(s.batch)}${s.package?' · '+esc(segmentLabel(s.package)):''} · ${esc(s.warehouse)}/${esc(s.bin)} · ${fmt(s.qty)} ${esc(s.unit)} · ${esc(label(s.state))}</option>`).join('')}</select></label><button class="quiet" data-action="add-cart">${t('添加到单据','Add to document')}</button></div>`;
 return `<p class="intro">${t('选择实际取货物资，录入数量，单据与库存同步完成。','Select materials and quantities. Posting updates both the document and stock.')}</p><section class="panel"><div class="panel-top"><h2>${t('办理库存业务','Stock transaction')}</h2><span class="tag">${t('确认才扣库存','Stock changes on confirmation')}</span></div><div class="switches"><button class="quiet ${action==='OUT'?'selected':''}" data-stock-kind="OUT">${esc(label('OUT'))}</button><details ${action!=='OUT'?'open':''}><summary>更多库存业务</summary><div class="actions">${['HANDOVER','MOVE','STATE'].map(k=>`<button class="quiet ${action===k?'selected':''}" data-stock-kind="${k}">${esc(label(k))}</button>`).join('')}</div></details></div>${action==='OUT'?`<div class="switches"><button class="quiet ${issueMode==='item'?'selected':''}" data-issue-mode="item">按物资数量</button><button class="quiet ${issueMode==='position'?'selected':''}" data-issue-mode="position">按实际箱号 / 库位</button></div>`:''}<div class="form-grid">${input('out-operator',t('经办人 *','Operator *'),sessionStorage.getItem('operator')||'')}${input('out-party',t('领用 / 接收单位 *','Receiving party *'))}${input('out-purpose',t('用途 / 安装区域 / 原因 *','Purpose / Area / Reason *'))}${action==='MOVE'?input('out-warehouse',t('目标仓库 *','Destination warehouse *'))+input('out-bin',t('目标库位 *','Destination bin *')):''}${action==='STATE'?`<label>${t('调整后的状态','New stock status')}<select id="out-state">${options(['AVAILABLE','PENDING','QUARANTINE','SPARE'])}</select></label>`:''}</div>${picker}<div id="cart">${cartHTML()}</div><p class="helper">${t('出库单独编号；系统自动保留每一项的到货批次、箱号和库位来源。','Issue documents have their own number. The arrival batch, box and bin source of every line are retained automatically.')}</p><button data-action="post" ${cart.length?'':'disabled'}>${t('确认并生成出库单','Confirm and create issue document')}</button></section>`;
}
function cartHTML(){return cart.length?`<p class="helper split-preview-note">${issueMode==='position'?t('以下为你选定的实际箱号和库位，确认前可修改数量。','These are your selected stock positions; adjust quantities before confirmation.'):t('系统建议的批次/库位拆分如下，可逐行调整；确认前不会扣库存。','The suggested batch/bin split is shown below. Adjust each line if needed; stock is unchanged until confirmation.')}</p>${table([t('物资 / 位置','Item / Location'),t('当前库存','On hand'),t('本次数量','Quantity'),t('本次备注','Issue remark'),t('操作','Action')],cart.map((r,i)=>{const s=db.stock.find(s=>s.id===r.stock_id);return `<tr class="cart"><td><span class="code">${esc(s?.code)}</span><br>${esc(s?.name)}<div class="sub">${esc(s?.warehouse)} / ${esc(s?.bin)} · ${t('到货批次','Arrival batch')} ${esc(s?.batch)} · ${t('箱号','Box')} ${esc(s?.box)||'—'}${s?.spec?' · '+esc(s.spec):''}${s?.attribute?' · '+esc(s.attribute):''}</div></td><td>${fmt(s?.qty)} ${esc(s?.unit)}</td><td><input aria-label="${t('数量','Quantity')} ${i+1}" data-cart="${i}" type="number" step="1" min="0" max="${s?.qty}" value="${esc(r.qty)}"></td><td><textarea class="issue-line-remark" aria-label="${t('本次备注','Issue remark')} ${i+1}" data-cart-remark="${i}" rows="2" maxlength="1000" placeholder="${t('选填，如安装区域、配件说明','Optional: area or accessory note')}">${esc(r.remark||'')}</textarea></td><td><button class="quiet small" data-remove="${i}">${t('移除','Remove')}</button></td></tr>`;}))}`:empty(t('单据尚无物资','No items in this document'),issueMode==='item'?t('在上方填写本次数量，即可加入待出库清单。','Enter an issue quantity above to add it to the pending document.'):t('从上方选择库位并添加。','Select a stock position above and add it.'));}
function documentActions(d){const eligible=!d.reversed_by&&!['BASELINE','REV'].includes(d.kind);return `<button class="quiet small" data-doc="${d.id}">${t('查看 / 打印','View / Print')}</button>${eligible?`<button class="quiet small" data-reverse="${d.id}">${t('作废 / 冲销','Void / reverse')}</button><button class="danger small" data-delete="${d.id}">${t('密码删除','Delete with password')}</button>`:''}`;}
function syncDeleteSelection(){deleteSelected=[...document.querySelectorAll('[data-delete-doc]:checked')].map(x=>Number(x.dataset.deleteDoc));const count=$('delete-selected-count');if(count)count.textContent=t(`已选择 ${deleteSelected.length} 张单据`,` ${deleteSelected.length} document(s) selected`);const post=document.querySelector('[data-action="delete-post"]');if(post)post.disabled=!deleteSelected.length;}
function deletePage(){const eligible=(db?.documents||[]).filter(d=>!d.reversed_by&&!['BASELINE','REV'].includes(d.kind));const selected=new Set(deleteSelected.map(Number));return `<p class="intro">${t('删除办理用于整张误录单据。先筛选并勾选，再输入管理员密码一次提交；库存会自动回滚。','Use Admin deletion for whole mistaken documents. Filter and select documents, then enter the administrator password once; stock is rolled back automatically.')}</p><section class="panel"><div class="panel-top"><div><h2>${t('管理员删除办理','Admin deletion')}</h2><p class="helper">${db?.admin_password_configured?t('输入密码即可删除，无需管理员账号或姓名。已有后续流水的单据请用作废/冲销。','Enter the password to delete; no administrator account or name is needed. Use reversal if later movements exist.') :t('管理员密码尚未设置，请先到“单据查询”设置。','Set the administrator password first from Documents.')}</p></div><button class="quiet small" data-page="documents">${t('去单据查询设置密码','Open Documents to set password')}</button></div><div class="form-grid">${input('delete-password',t('删除密码 *','Deletion password *'),'','password')}</div><div class="actions"><input id="delete-search" class="search" placeholder="${t('搜索单号、业务号、经办人','Search number, reference or operator')}"><button class="quiet small" data-delete-bulk="all">${t('全选当前结果','Select all results')}</button><button class="quiet small" data-delete-bulk="clear">${t('清空选择','Clear selection')}</button><span class="helper" id="delete-selected-count">${t(`已选择 ${selected.size} 张单据`,` ${selected.size} document(s) selected`)}</span></div>${eligible.length?table([t('选择','Select'),t('单号 / 时间','Number / Time'),t('类型','Type'),t('业务单号','Reference'),t('经办人','Operator'),t('状态','Status'),t('操作','Actions')],eligible.map(d=>`<tr data-delete-row="${d.id}" data-search="${esc(Object.values(d).join(' ').toLowerCase())}"><td><input type="checkbox" data-delete-doc="${d.id}" ${selected.has(Number(d.id))?'checked':''} aria-label="${t('选择','Select')} ${esc(d.number)}"></td><td><span class="name">${esc(d.number)}</span><div class="sub">${esc(d.created)}</div></td><td>${badge(d.kind)}</td><td>${esc(d.external_ref)}</td><td>${esc(d.operator)}</td><td>${t('可删除','Deletable')}</td><td><button class="quiet small" data-doc="${d.id}">${t('查看','View')}</button></td></tr>`)):empty(t('暂无可删除单据','No deletable documents'),t('设计基准单、冲销单和已冲销单不会出现在这里。','Baseline, reversal and already reversed documents are excluded.'))}<button class="danger" data-action="delete-post" ${selected.size?'':'disabled'}>${t('确认删除所选单据','Delete selected documents')}</button></section>`;}
function documents(){const configured=!!db?.admin_password_configured;return `<p class="intro">${t('入错的未确认预览直接取消；已确认单据可作废/冲销，整张误录单据可由管理员输入密码删除并回滚库存。','Cancel an unconfirmed preview. Void/reverse a posted document, or let an administrator delete a whole mistaken document with a password and roll back stock.')}</p><section class="panel"><div class="panel-top"><div><h2>${t('全部单据','All documents')}</h2><p class="helper">${configured?t('管理员删除已启用；修改密码需输入旧密码。','Admin deletion is enabled; changing the password requires the old password.'):t('首次使用管理员删除前，请先设置管理员密码。','Set an administrator password before the first deletion.')}</p></div><div class="actions"><input id="search" class="search" placeholder="${t('搜索单号、单位、经办人','Search number, party, operator')}"><a class="quiet small" href="/api/backup">${t('备份数据（含数据库与原件）','Backup (DB + sources)')}</a><button class="quiet small" data-action="admin-password">${configured?t('修改管理员密码','Change admin password'):t('设置管理员密码','Set admin password')}</button></div></div>${db.documents.length?table([t('单号 / 时间','Number / Time'),t('类型','Type'),t('业务单号','Reference'),t('单位','Party'),t('经办人','Operator'),t('状态','Status'),t('操作','Actions')],db.documents.map(d=>`<tr data-search="${esc(Object.values(d).join(' ').toLowerCase())}"><td><span class="name">${esc(d.number)}</span><div class="sub">${esc(d.created)}</div></td><td>${badge(d.kind)}</td><td>${esc(d.external_ref)}</td><td>${esc(d.party)||'—'}</td><td>${esc(d.operator)}</td><td>${d.reversed_by?t('已冲销','Reversed'):t('已确认','Posted')}</td><td><div class="actions">${documentActions(d)}</div></td></tr>`)):empty(t('暂无业务单据','No documents yet'),t('确认入库或出库后自动生成。','Documents are generated when a transaction is confirmed.'))}</section>`;}
 async function showDoc(id){disposeUniver('recognition-univer');currentRecognition=null;const d=await api('/api/document?id='+id);const remarks=['OUT','HANDOVER','MOVE','STATE'].includes(d.kind);const batchTitle=d.kind==='IN'||d.kind==='BASELINE'?t('到货批次','Arrival batch'):t('来源到货批次','Arrival source');$('modal-body').innerHTML=`<div class="doc-head"><div><div class="eyebrow">SMART WAREHOUSE / MATERIALS</div><h2 class="doc-title">${esc(label(d.kind))}</h2><div class="sub">${t('系统生成 · 补打不重复入账','System generated · Reprints do not repost')}</div></div><div class="code">${esc(d.number)}<br>${esc(d.created)}<br>${d.reversed_by?t('已冲销','REVERSED'):t('已确认','POSTED')}</div></div><div class="doc-meta"><div>${t('业务编号','Reference')}: ${esc(d.external_ref)}</div><div>${t('经办人','Operator')}: ${esc(d.operator)}</div><div>${t('领用 / 供货单位','Receiving / Supplying party')}: ${esc(d.party)||'—'}</div><div>${t('用途 / 原因','Purpose / Reason')}: ${esc(d.purpose)||'—'}</div>${d.arrival_date?`<div>${t('到货时间','Arrival time')}: ${dateText(d.arrival_date)}</div>`:''}${d.reverse_of?`<div>${t('冲销原单ID','Reversed document ID')}: ${d.reverse_of}</div>`:''}</div>${table([t('序号','No.'),t('物资名称','Item name'),t('规格型号','Specification'),batchTitle,t('箱号','Box no.'),t('仓库 / 库位','Warehouse / Bin'),t('状态','Status'),t('数量','Qty'),t('单位','Unit'),...(remarks?[t('备注','Remark')]:[])],d.lines.map((r,i)=>`<tr><td>${i+1}</td><td><span class="name">${esc(r.name)}</span><details class="intake-row-more"><summary>编码 / 图号</summary><span class="code">${esc(r.code)}</span>${r.attribute&&!remarks?`<p>${esc(r.attribute)}</p>`:''}</details></td><td>${esc(r.spec)||'原单未列'}</td><td>${esc(r.batch)}</td><td>${esc(r.box)||'—'}</td><td>${esc(r.warehouse)} / ${esc(r.bin)}</td><td>${esc(label(r.state))}</td><td>${fmt(['OUT','HANDOVER'].includes(d.kind)?Math.abs(r.qty):r.qty)}</td><td>${esc(r.unit)}</td>${remarks?`<td class="document-line-remark">${esc(r.remark||'')}</td>`:''}</tr>`))}<p class="helper">${t('不同单位不合并总数量。业务明细以系统保存记录为准。','Different units are not combined. The saved system record is authoritative.')}</p><div class="signatures"><span>${t('发料 / 交接人','Issued / Handed by')}: ${esc(d.operator)}</span><span>${t('接收签字','Received signature')}: ______________</span><span>${t('日期','Date')}: ______________</span></div><div class="doc-actions"><button data-action="print">${t('打印 / 保存为 PDF','Print / Save as PDF')}</button>${d.source_path?`<a class="quiet" href="/api/source?id=${d.id}">${t('下载原始清单','Download source')}</a>`:''}${!d.reversed_by&&!['BASELINE','REV'].includes(d.kind)?`<button class="quiet" data-reverse="${d.id}">${t('作废 / 冲销（保留流水）','Void / reverse (keep audit trail)')}</button><button class="danger" data-delete="${d.id}">${t('密码删除','Delete with password')}</button>`:''}</div>`;$('modal').showModal();}
function mappedPayload(){const p=payload();return importKind==='IN'?{...p,inputs:intakeInputs,corrections:intakeCorrections}:p;}
function validateReceiptPackage(){
 const value=($('default-package')?.value||'').trim().toUpperCase();
 if(!value||!(db?.segments||[]).some(s=>s.code===value))throw Error(t('请选择固定标段 A1-A16','Select one fixed segment A1-A16'));
 if(importKind==='IN'&&!composeBatch())throw Error(t('批次序号须为正整数（最多12位）','Batch sequence must be a positive integer (maximum 12 digits)'));
}
async function fileData(file){const buffer=new Uint8Array(await file.arrayBuffer());if(buffer.length>12*1024*1024)throw Error(t('文件超过12MB','File exceeds 12 MB'));let s='';for(let i=0;i<buffer.length;i+=32768)s+=String.fromCharCode(...buffer.subarray(i,i+32768));return {filename:file.name,content:btoa(s)};}
async function work(fn){
 if(posting)return;
 posting=true;document.body.setAttribute('aria-busy','true');
 const locked=[$('view'),$('nav'),document.querySelector('.header-actions'),$('modal-body')].filter(Boolean);
 locked.forEach(el=>el.inert=true);
 const busy=t('正在办理，请稍候…','Processing, please wait…');notice(busy);
 try{await fn();}catch(e){notice(e.message,true);}finally{
  posting=false;locked.forEach(el=>el.inert=false);document.body.removeAttribute('aria-busy');
  if($('notice').textContent===busy)$('notice').hidden=true;
 }
}
document.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;
 if(posting){e.preventDefault?.();return;}
 saveBusinessDraft();
 if(b.dataset.page){page=b.dataset.page;selectedContract='';draw();return;}
 if(b.dataset.treeReset){treeState={query:'',contract:'',batch:'',warehouse:'',state:'',sort:'contract'};renderInventoryTree();return;}
 if(b.dataset.treeToggle){document.querySelectorAll('#inventory-tree details').forEach(d=>d.open=b.dataset.treeToggle==='open');return;}
 if(b.dataset.contract){selectedContract=b.dataset.contract;page='inventory';draw();return;}
 if(b.dataset.contractBack){selectedContract='';contractState.ready=false;page='inventory';draw();return;}
 if(b.dataset.kind){importKind=b.dataset.kind;preview=null;draw();return;}
 if(b.dataset.stockKind){if(action===b.dataset.stockKind)return;if(cart.length&&!window.confirm('切换业务会清空待办清单，是否继续？'))return;action=b.dataset.stockKind;cart=[];delete issueDraft.quantities;delete issueDraft.checked;draw();return;}
 if(b.dataset.inventoryLayout){inventoryLayout=b.dataset.inventoryLayout;inventoryPage=0;renderInventoryTree();return;}
 if(b.dataset.inventoryStep){inventoryPage+=Number(b.dataset.inventoryStep);renderInventoryTree();return;}
 if(b.dataset.stockView){work(()=>showStockDetail(Number(b.dataset.stockView),Number(b.dataset.offset||0)));return;}
 if(b.dataset.stockIssue){try{queueStockForIssue(Number(b.dataset.stockIssue));renderInventoryTree();notice('已加入发料清单，确认发料前库存不变。');}catch(e){notice(e.message,true);}return;}
 if(b.dataset.action==='issue-checkout'){action='OUT';issueMode='position';page='outbound';draw();return;}
 if(b.dataset.issueMode){if(issueMode===b.dataset.issueMode)return;if(cart.length&&!window.confirm('切换选料方式会清空当前清单，是否继续？'))return;cart=[];delete issueDraft.quantities;delete issueDraft.checked;issueMode=b.dataset.issueMode;draw();return;}
 if(b.dataset.outBulk==='all'){document.querySelectorAll('[data-out-group]:not([hidden]) [data-group-check]').forEach(x=>x.checked=true);syncBulkCart();return;}
 if(b.dataset.outBulk==='clear'){document.querySelectorAll('[data-group-check]').forEach(x=>x.checked=false);document.querySelectorAll('[data-group-qty]').forEach(x=>x.value='');syncBulkCart();return;}
 if(b.dataset.deleteBulk==='all'){document.querySelectorAll('[data-delete-row]:not([hidden]) [data-delete-doc]').forEach(x=>x.checked=true);syncDeleteSelection();return;}
 if(b.dataset.deleteBulk==='clear'){document.querySelectorAll('[data-delete-doc]').forEach(x=>x.checked=false);syncDeleteSelection();return;}
 if(b.dataset.remove!==undefined){cart.splice(Number(b.dataset.remove),1);restoreBulkFields();$('cart').innerHTML=cartHTML();document.querySelector('[data-action="post"]').disabled=!cart.length;return;}
 if(b.dataset.doc){work(()=>showDoc(b.dataset.doc));return;}
 if(b.dataset.recognition){work(()=>showRecognition(b.dataset.recognition));return;}
 if(b.dataset.rowsTarget){const step=Number(b.dataset.rowsStep||0);if(b.dataset.rowsTarget==='preview'&&preview){previewRawPage=Math.max(0,previewRawPage+step);const fallback=$('preview-html-fallback');if(fallback)fallback.innerHTML=rowsFallback(preview.rows||[],'preview',previewRawPage);}if(b.dataset.rowsTarget==='archive'&&currentRecognition){const rows=currentRecognition.snapshot?.rows||[];recognitionRowsPage=Math.max(0,recognitionRowsPage+step);const fallback=$('recognition-html-fallback');if(fallback)fallback.innerHTML=rowsFallback(rows,'archive',recognitionRowsPage);}return;}
 if(b.dataset.action==='ledger-more'){loadLedger(true);return;}
 if(b.dataset.action==='items-more'){loadItems(true);return;}
 if(b.dataset.action==='contract-more'){loadContractItems(true);return;}
 if(b.dataset.action==='recognition-more'){loadRecognitionList(true);return;}
 if(b.dataset.action==='recognition-search'){loadRecognitionList(false);return;}
 if(b.dataset.delete){work(async()=>{if(!window.confirm(t('确认删除这张整单？系统会回滚库存，删除后只能从管理员操作记录追溯。','Delete this whole document? Stock will be rolled back; only the administrator action log will remain.')))return;const password=prompt(t('请输入管理员密码','Enter administrator password'));if(password===null)return;await api('/api/delete',{id:b.dataset.delete,password});if($('modal').open)$('modal').close();await refresh();notice(t('已删除整张误录单据，库存已回滚','The mistaken document was deleted and stock was rolled back'));});return;}
 if(b.dataset.reverse){work(async()=>{const reason=prompt(t('请输入冲销原因。系统将生成反向单据，原单仍保留。','Enter reason. A reversal will be created; the original remains.'));if(!reason)return;const operator=prompt(t('冲销经办人','Reversal operator'),sessionStorage.getItem('operator')||'');if(!operator)return;const res=await api('/api/reverse',{id:b.dataset.reverse,purpose:reason,operator,request_key:crypto.randomUUID()});$('modal').close();await refresh();await showDoc(res.id);notice(t('已生成冲销记录','Reversal posted'));});return;}
 const a=b.dataset.action;
 if(a==='recognition-delete'||a==='recognition-delete-batch'){work(async()=>{const ids=a==='recognition-delete'?[Number(b.dataset.recognitionId)]:[...recognitionSelected];if(!ids.length)throw Error(t('请先勾选识别记录','Select recognition records first'));if(!window.confirm(t(`确认删除选中的 ${ids.length} 条识别记录？库存、入库单和原始文件会保留。`,`Delete ${ids.length} selected recognition record(s)? Stock, receipts and source files will remain.`)))return;const password=prompt(t('请输入删除密码','Enter deletion password'));if(password===null)return;await api('/api/recognition/delete-batch',{ids,password});if($('modal').open){disposeUniver('recognition-univer');$('modal').close();}currentRecognition=null;recognitionSelected.clear();await loadRecognitionList(false);notice(t(`已删除 ${ids.length} 条识别记录，库存未改变`,`Deleted ${ids.length} recognition record(s); stock unchanged`));});return;}
 if(a==='retry-connect'){clearTimeout(reconnectTimer);reconnectAttempt=0;work(()=>refresh());return;}
 if(a==='recognition-reopen'){work(async()=>{const saved=await api('/api/recognition/reopen?id='+encodeURIComponent(b.dataset.recognitionId));const modes=[...new Set(saved.inputs.map(s=>s.source))];if(modes.length!==1||!['upload','paste','manual'].includes(modes[0]))throw Error('这条归档包含不同录入方式，请从入库办理重新选择原件');const batch=String(saved.defaults?.batch||saved.batches?.[0]||'B01'),number=(batch.match(/(\d+)$/)||[])[1]||'1';clearReceiptDraft();importKind='IN';intakeMode=modes[0];intakeInputs=saved.inputs||[];intakeCorrections=saved.corrections||{};intakeEditPage=0;intakeOnlyProblems=false;selectedSegment=saved.defaults?.package||'';upload={original_name:saved.original_name,batchDate:saved.arrival_date||todayISO(),batchNumber:number,segment:selectedSegment};preview=null;page='inbound';$('modal').close();draw();$('default-warehouse').value=saved.defaults?.warehouse||'主仓库';$('default-bin').value=saved.defaults?.bin||'待分配';$('default-state').value=saved.defaults?.state||'AVAILABLE';$('default-box').value=saved.defaults?.box||'';await prepareIntake();preview=await api('/api/preview',mappedPayload());renderPreview();notice('已恢复到可编辑预览，请核对后手动确认入库。');});return;}
 if(a==='recognition-cancel'){work(async()=>{await api('/api/recognition/cancel',{id:b.dataset.recognitionId});preview=null;upload=null;intakeInputs=[];intakeCorrections={};clearReceiptDraft();page='recognitions';draw();notice(t('本次识别已标记为取消，库存未改变','Recognition marked cancelled. Stock was not changed'));});return;}
 if(a==='print'){window.print();return;}
 if(a==='admin-password'){work(async()=>{const current=db?.admin_password_configured?prompt(t('请输入当前管理员密码','Enter current administrator password')):'';if(db?.admin_password_configured&&current===null)return;const next=prompt(t('设置新删除密码','Set a new deletion password'));if(next===null)return;const confirmPassword=prompt(t('再次输入新密码','Enter the new password again'));if(confirmPassword!==next){notice(t('两次密码不一致，未保存','Passwords do not match; nothing was saved'),true);return;}await api('/api/admin-password',{current_password:current||'',new_password:next});await refresh();notice(t('管理员密码已设置','Administrator password saved'));});return;}
 if(a==='delete-post'){work(async()=>{if(!deleteSelected.length)throw Error(t('请先勾选要删除的单据','Select documents to delete first'));if(!db?.admin_password_configured)throw Error(t('请先到单据查询设置管理员密码','Set the administrator password from Documents first'));const password=$('delete-password').value;if(!window.confirm(t(`确认删除已选择的 ${deleteSelected.length} 张整单？库存会自动回滚。`,`Delete the ${deleteSelected.length} selected document(s)? Stock will be rolled back automatically.`)))return;const res=await api('/api/delete-batch',{ids:deleteSelected,password});deleteSelected=[];await refresh();notice(t(`已删除 ${res.deleted.length} 张误录单据，库存已回滚`,` ${res.deleted.length} mistaken document(s) deleted; stock rolled back`));});return;}
 if(handleIntakeAction(a,b))return;
 if(a==='baseline'){importKind='BASELINE';preview=null;page='inbound';draw();return;}
 work(async()=>{
 if(a==='inspect'){
   validateReceiptPackage();
   if(importKind==='IN')await prepareIntake();
   else {if($('file').files[0])upload=await fileData($('file').files[0]);if(!upload)throw Error(t('请先选择文件','Select a file first'));}
   preview=await api('/api/preview',mappedPayload());
   autoFillReceiptDefaults(preview);
   if(importKind!=='IN')$('sheet').innerHTML=preview.sheets.map(s=>`<option ${s===preview.sheet?'selected':''}>${esc(s)}</option>`).join('');
   intakeEditPage=0;renderPreview();
 }else if(a==='validate'){if(importKind==='IN')await prepareIntake();preview=await api('/api/preview',mappedPayload());renderPreview();
 }else if(a==='import-confirm'){
   validateReceiptPackage();
   if(importKind==='IN')await prepareIntake();
   const p=mappedPayload();preview=await api('/api/preview',p);renderPreview();if(preview.errors.length)return;
   p.recognition_id=preview.recognition_id;p.request_key=crypto.randomUUID();sessionStorage.setItem('operator',p.operator);const res=await api('/api/import',p);upload=null;preview=null;intakeInputs=[];intakeCorrections={};clearReceiptDraft();page='documents';await refresh();notice(t('已确认，单据和台账已更新','Confirmed. Document and ledger updated.'));await showDoc(res.id);
 }else if(a==='add-selected'){
   addSelectedGroups();$('cart').innerHTML=cartHTML();document.querySelector('[data-action="post"]').disabled=!cart.length;
 }else if(a==='add-cart'){
   addCartStock(Number($('stock-select').value));$('cart').innerHTML=cartHTML();document.querySelector('[data-action="post"]').disabled=false;
 }else if(a==='post'){
   const p={kind:action,operator:$('out-operator').value,party:$('out-party').value,purpose:$('out-purpose').value,lines:cart,request_key:outKey,state:$('out-state')?.value,warehouse:$('out-warehouse')?.value,bin:$('out-bin')?.value};sessionStorage.setItem('operator',p.operator);
   const res=await api('/api/post',p);outKey=crypto.randomUUID();cart=[];issueDraft={};page='documents';await refresh();notice(t('单据已生成，库存已同步','Document created. Stock synchronized.'));await showDoc(res.id);
 }else if(a==='change-save'){
   await api('/api/change',{code:$('change-code').value,qty:$('change-qty').value,operator:$('change-operator').value,reason:$('change-reason').value,request_key:crypto.randomUUID()});await refresh();notice(t('设计变更已保存，库存未改变','Design change saved. Stock unchanged.'));
 }else if(a==='batch-save'){
   await api('/api/batch',{code:$('batch-code').value,supplier:$('batch-supplier').value,status:$('batch-status').value,operator:$('batch-operator').value,note:$('batch-note').value});await refresh();notice(t('批次状态已保存','Batch status saved'));
 }
 });
});
document.addEventListener('input',e=>{if(posting)return;saveBusinessDraft();if(e.target.id==='ledger-search'){scheduleLedgerSearch();return;}if(e.target.id==='items-search'){scheduleItemsSearch();return;}if(e.target.id==='search'||e.target.id==='delete-search'){let q=e.target.value.toLowerCase();const selector=e.target.id==='delete-search'?'[data-delete-row]':'[data-search]';document.querySelectorAll(selector).forEach(r=>r.hidden=!r.dataset.search.includes(q));}if(e.target.id==='out-search')applyBulkFilters();if(e.target.dataset.groupQty!==undefined){const check=document.querySelector(`[data-group-check="${e.target.dataset.groupQty}"]`);if(check)check.checked=Number(e.target.value||0)>0;syncBulkCart();}if(e.target.dataset.cartRemark!==undefined)cart[Number(e.target.dataset.cartRemark)].remark=e.target.value;if(e.target.dataset.cart!==undefined)setCartQuantity(Number(e.target.dataset.cart),e.target.value);if(['batch-date','batch-number'].includes(e.target.id)){const b=$('batch-preview');if(b)b.textContent=composeBatch()||t('填写批次序号后生成','Enter a batch number to generate');}if(e.target.id==='tree-search'){const pos=e.target.selectionStart;treeState.query=e.target.value;inventoryPage=0;renderInventoryTree();const next=$('tree-search');if(next){next.focus();next.setSelectionRange(pos,pos);}}});
document.addEventListener('change',e=>{if(posting)return;saveBusinessDraft();if(e.target.dataset.groupCheck!==undefined){const field=document.querySelector(`[data-group-qty="${e.target.dataset.groupCheck}"]`);if(!e.target.checked&&field)field.value='';syncBulkCart();return;}const key={'tree-contract':'contract','tree-batch':'batch','tree-warehouse':'warehouse','tree-state':'state','tree-sort':'sort'}[e.target.id];if(key){treeState[key]=e.target.value;inventoryPage=0;renderInventoryTree();}if(e.target.id==='default-package')selectedSegment=e.target.value;if(e.target.id==='out-contract')applyBulkFilters();if(e.target.id==='ledger-kind'){ledgerState.kind=e.target.value;loadLedger(false);}if(e.target.id.startsWith('recognition-')&&!['recognition-batch','recognition-from','recognition-to'].includes(e.target.id))loadRecognitionList(false);if(e.target.dataset.deleteDoc!==undefined)syncDeleteSelection();});
$('lang').addEventListener('click',()=>{if(posting)return;saveBusinessDraft();lang=lang==='zh'?'en':'zh';localStorage.setItem('materials-language',lang);draw();});
$('refresh').addEventListener('click',()=>{if(posting)return;saveBusinessDraft();work(()=>refresh());});$('close-modal').addEventListener('click',()=>$('modal').close());$('modal').addEventListener('close',()=>{disposeUniver('recognition-univer');currentRecognition=null;});
boot();

function previewTreeHTML(rows){
 const contracts=treeSort(groupRows(rows,row=>row.package||'未分配标段'),'contract');
 return contracts.length?`<div class="tree preview-tree">${contracts.map(treeContractHtml).join('')}</div>`:empty(t('没有可展示的箱内明细','No item details to display'),t('请先修正识别错误。','Correct the recognition errors first.'));
}
function renderPreview(){
 const r=preview, rows=r.rows||[];
 disposeUniver('preview-univer');previewRawPage=0;
 if(r.source_rows){
  intakeExcludedPage=[];
  const problems=r.source_rows.filter(row=>row.issues.length&&!row.exclude_reason).length,boxes=new Set(rows.map(row=>row.box)).size;
  const primary=r.errors.length?(problems?'intake-problems':'intake-settings'):'import-confirm';
  const buttonText=r.errors.length?(problems?`处理 ${problems} 条待确认`:'查看识别问题'):`确认入库 · ${r.count} 条`;
  $('preview').innerHTML=`<section class="panel intake-simple"><div class="step-label">02 / 核对物资</div><div class="panel-top"><h2>${r.source_rows.length} 条物资明细</h2><button class="quiet small" data-action="intake-ai" ${db?.local_ai_ready?'':'disabled'}>本地AI辅助识别</button></div><div id="intake-ai-feedback" class="helper" role="status"></div>${r.errors.length?`<div class="warning-list">${problems?`${problems} 条需要核对，已标黄。取消勾选可跳过不需要的物资。`:esc(r.errors[0])}</div>`:`<p class="helper">已识别 ${boxes} 个箱号。直接修改数量或名称，取消勾选不要的物资。</p>`}<div id="intake-review-host">${intakeReviewHTML()}</div><div class="intake-confirm-bar"><p class="helper"><span id="intake-confirm-count">${intakeCountText()}</span> · ${esc($('default-package')?.value||'')} / ${esc(composeBatch())}</p><p id="intake-confirm-status" class="helper" role="status">${r.errors.length?'核对标黄内容后即可继续。':`本次 ${r.count} 条 · ${boxes} 箱 · ${esc($('default-package')?.value||'')} / ${esc(composeBatch())}`}</p><div class="actions"><button id="intake-submit" data-action="${primary}">${buttonText}</button>${r.recognition_id&&r.recognition_status!=='POSTED'?`<button class="quiet small" data-action="recognition-cancel" data-recognition-id="${r.recognition_id}">取消本次</button>`:''}</div></div></section>`;
  const source=$('intake-source-entry');if(source){source.open=false;$('intake-source-summary').textContent='资料已放入 · 展开可更换或补充';}
  renderIntakeEditor();return;
 }
 const sheetKind=r.sheet_kind==='shipment'?t('发货清单（箱级，仅作物流核对）','Shipment list (carton level; logistics reference only)'):t('装箱清单（箱内详件，可办理入库）','Packing detail (carton contents; receipt eligible)');
 $('preview').innerHTML=`<div class="panel"><div class="step-label">02 / ${t('自动识别并核对','AUTO-READ AND VERIFY')}</div><h2>${t('识别结果','Import preview')} · ${r.source_rows?.length??r.count} ${t('行','rows')}</h2>${r.errors.length?`<details class="error-list"><summary>还有 ${r.errors.length} 项待核对，展开查看原因</summary>${r.errors.map(esc).join('<br>')}</details>`:`<div class="success-box">${t('自动识别通过。确认后生成单据并一次性入账。','Automatic recognition passed. Confirm to post the document and ledger once.')}<br><b>${esc(sheetKind)}</b> · ${t('工作表','Worksheet')}: ${esc(r.sheet)}</div>`}${r.warnings?.length?`<div class="warning-list">${r.warnings.map(esc).join('\n')}</div>`:''}
 <div id="intake-review-host"></div><details class="preview-hierarchy" open><summary>${t('按标段 → 批次 → 箱号 → 箱内物资核对','Verify by lot → batch → box → contents')}</summary><div class="tree-actions"><button class="quiet small" data-preview-toggle="open">${t('全部展开','Expand all')}</button><button class="quiet small" data-preview-toggle="closed">${t('全部收起','Collapse all')}</button></div><div id="preview-tree">${previewTreeHTML(rows)}</div></details>
 <section class="univer-section"><div><h3>${t('全部识别行（只读核对）','All recognized rows (read-only)')}</h3><p class="sub">${t(`识别归档 #${r.recognition_id||'—'} · 共 ${rows.length} 行`,`Archive #${r.recognition_id||'—'} · ${rows.length} rows`)}</p></div><div id="preview-univer" class="univer-grid" ${rows.length?'':'hidden'}></div><div id="preview-html-fallback" ${rows.length?'hidden':''}>${rows.length?rowsFallback(rows,'preview',previewRawPage):empty(t('没有可展示的识别明细','No recognized detail rows'),t('原始文件和识别信息仍已保存到归档。','The original file and recognition record are still archived.'))}</div></section>
 <p class="helper">${t('系统按固定规则自动匹配表头；箱号相同的行在箱层合并显示，箱内明细逐项保留。确认前可回到上方修改默认批次和库位。','Headers are matched automatically. Rows with the same box are grouped at the box level while every item remains visible. You can change the default batch and location above before confirmation.')}</p><p id="intake-confirm-status" class="helper" role="status">${r.errors.length?'尚不能入库：请处理待确认项，或勾选不需要的行“不入库”，再重新核对。':'已通过核对，请确认标段、批次和物资后入库。'}</p><div class="actions">${r.source_rows?`<button class="quiet" data-action="validate">重新核对</button>${r.errors.length?'<button class="quiet" data-action="intake-problems">处理待确认项</button>':''}`:''}<button data-action="import-confirm" ${r.errors.length?'disabled':''}>${importKind==='IN'?t('确认入库并生成入库单','Confirm receipt'):t('确认锁定设计总量','Confirm baseline')}</button>${r.recognition_id&&r.recognition_status!=='POSTED'?`<button class="quiet" data-action="recognition-cancel" data-recognition-id="${r.recognition_id}">${t('取消本次预览','Cancel this preview')}</button>`:''}</div></div>`;
 if(rows.length)mountUniver('preview-univer',rows,'preview-html-fallback');
 if(r.source_rows){$('intake-review-host').innerHTML=intakeReviewHTML();renderIntakeEditor();}
}

function manualRowHTML(row={}){
 const field=key=>`<input aria-label="${intakeFields[key]}" data-manual-field="${key}" value="${esc(row[key]??'')}" ${key==='qty'?'inputmode="decimal"':''}>`;
 return `<tr>${['box','name','spec','qty','unit'].map(key=>`<td>${field(key)}</td>`).join('')}<td><details class="intake-row-more"><summary>选填</summary>${['doc_no','drawing','code','attribute'].map(key=>`<label>${intakeFields[key]}${field(key)}</label>`).join('')}</details><button class="quiet small" data-action="manual-remove" aria-label="删除本行">删除</button></td></tr>`;
}
function intakeEntryHTML(){
 const find=role=>intakeSourceSlot(role==='packing_detail'?0:1);
 return `<details id="intake-source-entry" class="intake-source-entry" open><summary id="intake-source-summary">放入到货资料</summary><div class="intake-modes" role="group" aria-label="录入方式">${[['upload','上传文件'],['paste','粘贴内容'],['manual','手动录入']].map(([mode,title])=>`<button type="button" class="${intakeMode===mode?'':'quiet'}" data-action="intake-mode" data-mode="${mode}" aria-pressed="${intakeMode===mode}">${title}</button>`).join('')}</div>
 <div data-intake-mode="upload" ${intakeMode==='upload'?'':'hidden'}><label class="upload-box">到货资料（系统识别单据类型）<input type="file" id="intake-file-packing_detail" accept=".xls,.xlsx,.csv"><span class="helper">${esc(intakeFiles.packing_detail?.name||find('packing_detail')?.filename||'支持 XLS / XLSX / CSV，单个文件最多12MB')}</span></label><details class="intake-extra-source" ${find('arrival_note')?'open':''}><summary>添加第二份单据核对（可选）</summary><label class="upload-box">到货单<input type="file" id="intake-file-arrival_note" accept=".xls,.xlsx,.csv"><span class="helper">${esc(intakeFiles.arrival_note?.name||find('arrival_note')?.filename||'可以只用到货单中的物资明细入库')}</span></label></details></div>
 <div data-intake-mode="paste" ${intakeMode==='paste'?'':'hidden'}><label>粘贴到货单或装箱单<textarea id="intake-text-packing_detail" rows="6" placeholder="复制表头和物资明细，粘贴到这里">${esc(find('packing_detail')?.text||'')}</textarea></label><details class="intake-extra-source" ${find('arrival_note')?'open':''}><summary>第二份单据内容（可选）</summary><label>到货单内容<textarea id="intake-text-arrival_note" rows="6" placeholder="复制表头和物资明细，粘贴到这里">${esc(find('arrival_note')?.text||'')}</textarea></label></details></div>
 <div data-intake-mode="manual" ${intakeMode==='manual'?'':'hidden'}><p class="helper">填写箱号、名称、数量、单位即可；规格可补充。</p><div class="table-wrap intake-manual"><table><thead><tr>${['box','name','spec','qty','unit'].map(key=>`<th>${intakeFields[key]}</th>`).join('')}<th>操作</th></tr></thead><tbody id="intake-manual-rows">${(manualDraftRows||intakeInputs.find(s=>s.source==='manual')?.rows||[{}]).map(manualRowHTML).join('')}</tbody></table></div><button class="quiet small" data-action="manual-add">＋ 添加一行</button></div>
 ${intakeMode!=='manual'?`<label>主资料类型<select id="intake-role-main">${['auto','packing_detail','arrival_note'].map(role=>`<option value="${role}" ${(intakeSourceSlot(0)?.role||'auto')===role?'selected':''}>${role==='auto'?'自动识别':intakeKinds[role]}</option>`).join('')}</select></label>`:''}
 ${db?.demo_mode?'<p><a class="quiet" href="/api/inbound-demo-data">下载演示单据</a></p>':''}</details>`;
}
async function prepareIntake(){
 const next=[];
 if(intakeMode==='manual'){
  const rows=[...document.querySelectorAll('#intake-manual-rows tr')].map(tr=>Object.fromEntries([...tr.querySelectorAll('[data-manual-field]')].map(el=>[el.dataset.manualField,el.value.trim()]))).filter(row=>Object.values(row).some(Boolean));
  if(rows.length)next.push({source:'manual',role:'packing_detail',rows});
 }else for(const [index,slot] of ['packing_detail','arrival_note'].entries()){
  const role=index===0?($('intake-role-main')?.value||intakeSourceSlot(0)?.role||'auto'):(intakeSourceSlot(1)?.role||'arrival_note');
  if(intakeMode==='paste'){
   const text=$(`intake-text-${slot}`).value;if(text.trim())next.push({source:'paste',role,slot:index,text});
  }else{
   const file=$(`intake-file-${slot}`)?.files?.[0]||intakeFiles[slot],old=intakeSourceSlot(index)?.source==='upload'?intakeSourceSlot(index):null;
   if(file)next.push({source:'upload',role,slot:index,...await fileData(file)});else if(old)next.push({...old,role,slot:index});
  }
 }
 if(!next.length)throw Error('请先选择文件、粘贴内容或填写一行物资');
 const raw=s=>JSON.stringify([s.source,s.role,s.filename,s.content,s.text,s.rows]);
 const unchanged=next.length===intakeInputs.length&&next.every((s,i)=>raw(s)===raw(intakeInputs[i]));
 if(!unchanged){intakeExcludedPage=[];intakeCorrections={};intakeEditPage=0;intakeOnlyProblems=false;}
 intakeInputs=next.map(s=>{const old=intakeInputs.find(x=>raw(x)===raw(s));return old?{...old,...s}:s;});
}
function intakeReviewHTML(){
 const r=preview;
 for(const s of r.selections){if(intakeInputs[s.input]){intakeInputs[s.input].sheet=s.sheet;intakeInputs[s.input].header=s.header_row;}}
 const mapping=r.selections.map(s=>{
  const source=intakeInputs[s.input]||{}, all=r.candidates.filter(c=>c.input===s.input);
  return `<details class="intake-mapping"><summary>来源 ${s.input+1} · ${esc(intakeKinds[s.role])} · ${esc(s.sheet)} · ${esc(intakeKinds[s.kind])}</summary>
   <div class="form-grid"><label>资料类型（可修改）<select data-intake-source="${s.input}" data-intake-setting="role">${['auto','packing_detail','arrival_note'].map(role=>`<option value="${role}" ${(source.role||s.role)===role?'selected':''}>${role==='auto'?'自动识别 · '+intakeKinds[s.role]:intakeKinds[role]}</option>`).join('')}</select></label><label>选择工作表<select data-intake-source="${s.input}" data-intake-setting="sheet">${all.map(c=>`<option value="${esc(c.sheet)}" ${c.sheet===s.sheet?'selected':''}>${esc(c.sheet)} · ${esc(intakeKinds[c.kind])}</option>`).join('')}</select></label><label>表头所在行<input type="number" min="1" max="100" value="${s.header_row}" data-intake-source="${s.input}" data-intake-setting="header"></label>${['unit','box','doc_no'].map(k=>`<label>统一补充${intakeFields[k]}<input value="${esc(source.defaults?.[k]||'')}" data-intake-source="${s.input}" data-intake-default="${k}"></label>`).join('')}</div>
   <div class="intake-map-fields">${Object.entries(intakeFields).map(([key,title])=>`<label>${title}<select data-intake-source="${s.input}" data-intake-map="${key}"><option value="-1">未识别 / 不使用</option>${s.headers.map((h,i)=>`<option value="${i}" ${s.mapping[key]===i?'selected':''}>第${i+1}列 · ${esc(h||'空表头')}</option>`).join('')}</select><small>${s.mapping[key]>=0?'已识别对应列，请核对':'未识别，可选列或补录'}</small></label>`).join('')}</div>
   <details><summary>查看原始内容（前20行）</summary>${table(['行号',...s.sample.reduce((a,row)=>row.length>a.length?row:a,[]).map((_,i)=>`列${i+1}`)],s.sample.map((row,i)=>`<tr><td>${i+1}</td>${row.map(v=>`<td>${esc(v)}</td>`).join('')}</tr>`))}</details>
   <p class="helper">${all.map(c=>`${esc(c.sheet)}：${esc(c.reason)}`).join('；')}</p></details>`;
 }).join('');
 const pageBoxes=r.source_rows.filter(row=>row.page_box&&row.box!==row.page_box&&!row.exclude_reason&&!Object.hasOwn(intakeCorrections[row.id]||{},'box'));
 const layout=(r.layout_rows||[]).length?`<details class="intake-layout"><summary>已自动忽略 ${r.layout_rows.length} 行页眉、表头和签字信息（可查看原文）</summary>${table(['工作表 / 原行号','忽略原因','原始内容'],r.layout_rows.map(row=>`<tr><td>${esc(row.sheet)} / ${row.source_row}</td><td>${esc(row.reason)}</td><td>${esc(row.raw)}</td></tr>`))}</details>`:'';
 const compare=r.reconciliation.length?`<h3>到货与装箱数量核对</h3>${table(['到货单号','物资 / 规格','单位','到货数量','装箱合计','核对结果'],r.reconciliation.map(x=>`<tr><td>${esc(x.doc_no||'待补')}</td><td>${esc(x.name)}<small>${esc(x.spec)}</small></td><td>${esc(x.unit)}</td><td>${fmt(x.arrival)}</td><td>${fmt(x.packing)}</td><td class="${x.ok?'':'intake-problem'}">${x.ok?'一致':'不一致 / 缺明细'}</td></tr>`))}`:'';
 const confirmations=r.selections.map(s=>{const source=intakeInputs[s.input]||{};return `${['unknown','material_summary'].includes(s.kind)?`<label class="checkline"><input type="checkbox" data-intake-source="${s.input}" data-intake-setting="scope_confirmed" ${source.scope_confirmed?'checked':''}>我确认“${esc(s.sheet)}”是本次入库明细，未与汇总重复</label>`:''}${s.role==='arrival_note'&&!r.selections.some(x=>x.role==='packing_detail')?`<label class="checkline"><input type="checkbox" data-intake-source="${s.input}" data-intake-setting="confirm_detail" ${source.confirm_detail?'checked':''}>我确认按这张到货单的物资明细入库</label>`:''}`;}).join('');
 return `<section class="intake-review"><p class="helper">${r.selections.map(s=>`来源 ${s.input+1}：${esc(intakeKinds[s.role])}`).join(' · ')} <button class="quiet small" data-action="intake-settings">修改资料类型 / 表头</button></p>${r.source_rows.some(row=>row.auto_box)?'<p class="helper">完整箱号已按页眉识别，原始值保留在每行“更多”中。</p>':''}${pageBoxes.length?`<div class="intake-box-review"><b>${pageBoxes.length} 条箱号存在不同写法，请核对</b><p>页眉完整发运箱号与表内箱号不一致，可查看每行原文后选择。</p><button class="quiet" data-action="intake-page-boxes">采用各页完整箱号并核对</button></div>`:''}${confirmations}${compare}<div id="intake-editor"></div><details id="intake-advanced" class="intake-advanced"><summary>高级设置 / 原始内容（识别不对时再展开）</summary>${r.errors.length?`<details><summary>全部识别提示 · ${r.errors.length} 项</summary><div class="error-list">${r.errors.map(esc).join('<br>')}</div></details>`:''}${mapping}${layout}${r.warnings?.length?`<p class="helper">${r.warnings.map(esc).join('<br>')}</p>`:''}<button class="quiet small" data-action="intake-clear">清空人工修正</button></details></section>`;
}
function renderIntakeEditor(){
 if(!$('intake-editor'))return;
 const rows=intakeVisibleRows(), size=30, total=Math.max(1,Math.ceil(rows.length/size));intakeEditPage=Math.min(intakeEditPage,total-1);
 const field=(row,key,values)=>{const issues=values.exclude_reason?[]:intakeFieldIssues(row,key);return `<div class="intake-field"><input aria-label="第${row.source_row}行${intakeFields[key]||'不入库原因'}" data-intake-row="${esc(row.id)}" data-intake-field="${key}" value="${esc(values[key]||'')}" ${key==='qty'?'inputmode="decimal"':''} ${issues.length?'aria-invalid="true"':''}>${issues.map(x=>`<small class="intake-problem">${esc(x)}</small>`).join('')}</div>`;};
 $('intake-editor').innerHTML=`<div class="panel-top"><p class="helper">勾选的物资才入库 · <span id="intake-selection-count">${intakeCountText()}</span></p><div class="actions"><button class="quiet small" data-action="intake-exclude-page">本页全部不入库</button><button class="quiet small" data-action="intake-restore-page">恢复本页</button><label class="checkline"><input id="intake-only-problems" type="checkbox" ${intakeOnlyProblems?'checked':''}>只看待确认</label>${total>1?`<button class="quiet small" data-action="intake-prev" ${intakeEditPage===0?'disabled':''}>上一页</button><span>${intakeEditPage+1} / ${total}</span><button class="quiet small" data-action="intake-next" ${intakeEditPage+1>=total?'disabled':''}>下一页</button>`:''}</div></div><div class="table-wrap intake-editor intake-compact"><table><thead><tr><th>入库</th><th>箱号</th><th>物资名称 / 规格</th><th>数量 / 单位</th><th>操作</th></tr></thead><tbody>${rows.slice(intakeEditPage*size,(intakeEditPage+1)*size).map(row=>{
 const values={...row,...intakeCorrections[row.id]};
 return `<tr class="${row.issues.length?'intake-needs-review':''} ${values.exclude_reason?'intake-excluded':''}"><td><input type="checkbox" data-intake-include="${esc(row.id)}" ${values.exclude_reason?'':'checked'} aria-label="将第${row.source_row}行纳入本次入库"></td><td>${field(row,'box',values)}</td><td><div class="intake-name">${field(row,'name',values)}</div><div class="intake-spec">${field(row,'spec',values)}</div>${row.ai_suggestions?`<div class="intake-ai-suggestion"><small>AI建议（请核对）：${Object.entries(row.ai_suggestions).map(([key,value])=>`${intakeFields[key]}：${esc(value)}`).join('；')}</small><button class="quiet small" data-action="intake-ai-accept" data-row-id="${esc(row.id)}">采用本行AI建议</button></div>`:''}${values.exclude_reason?'<small>已排除，本行不参与入库核对</small>':''}</td><td><div class="intake-quantity">${field(row,'qty',values)}${field(row,'unit',values)}</div></td><td><details class="intake-row-more"><summary>更多</summary><label>图号${field(row,'drawing',values)}</label>${['code','doc_no','attribute','exclude_reason'].map(key=>`<label>${intakeFields[key]||'不入库原因'}${field(row,key,values)}</label>`).join('')}<p class="helper">${esc(row.sheet)} · 原第 ${row.source_row} 行</p><p>${row.raw.map(esc).join(' ｜ ')}</p>${Object.keys(row.evidence).length?`<p>${Object.values(row.evidence).map(esc).join('；')}</p>`:''}${Object.keys(row.suggestions).length?`<p>建议：${Object.entries(row.suggestions).map(([key,v])=>`${intakeFields[key]} ${esc(v)}`).join('，')}</p><button class="quiet small" data-action="intake-suggest" data-row-id="${esc(row.id)}">采用本行建议</button>`:''}</details><button class="quiet small" data-action="intake-toggle-row">${values.exclude_reason?'恢复':'移除'}</button></td></tr>`;
 }).join('')}</tbody></table></div>`;
}
function markIntakeDirty(){
 if($('intake-confirm-count'))$('intake-confirm-count').textContent=intakeCountText();
 if($('intake-selection-count'))$('intake-selection-count').textContent=intakeCountText();
 const button=$('intake-submit');if(button){button.disabled=false;button.dataset.action='import-confirm';button.textContent='核对并确认入库';}
 if($('intake-confirm-status'))$('intake-confirm-status').textContent='点击后先核对修改；有问题会停下，通过后只入库已勾选物资。';
}
function handleIntakeAction(a,b){
 if(a==='intake-mode'){
  intakeMode=b.dataset.mode;document.querySelectorAll('[data-intake-mode]').forEach(el=>el.hidden=el.dataset.intakeMode!==intakeMode);document.querySelectorAll('[data-action="intake-mode"]').forEach(el=>{el.classList.toggle('quiet',el.dataset.mode!==intakeMode);el.setAttribute('aria-pressed',el.dataset.mode===intakeMode);});markIntakeDirty();return true;
 }
 if(a==='intake-ai'){
  work(async()=>{await prepareIntake();preview=await api('/api/preview',mappedPayload());renderPreview();const p=mappedPayload(),stamp=JSON.stringify(p);$('intake-ai-feedback').textContent='本地AI正在核对，建议出来后由你选择是否采用…';let result;try{result=await api('/api/intake-ai',p);}catch(error){if($('intake-ai-feedback'))$('intake-ai-feedback').textContent='本地AI未完成，可继续手动核对。';throw error;}if(page!=='inbound'||!$('intake-ai-feedback')||stamp!==JSON.stringify(mappedPayload())){notice('内容已经改变，请重新点击AI辅助识别。');return;}for(const item of result.suggestions){const row=preview.source_rows.find(r=>r.id===item.id);if(row)row.ai_suggestions=item.fields;}preview.ai_mappings=result.mappings;renderIntakeEditor();$('intake-ai-feedback').innerHTML=`已辅助核对 ${result.checked} 条，${result.suggestions.length} 条有原文支持的建议。${result.mappings.length?`<details open><summary>AI列对应建议（先核对再采用）</summary>${result.mappings.map(m=>`<p>来源 ${m.input+1}，表头第 ${m.header} 行：${Object.entries(m.mapping).map(([key,col])=>`${intakeFields[key]} ← 第${col+1}列「${esc(m.headers[col])}」`).join('；')}</p>`).join('')}<button class="quiet small" data-action="intake-ai-map">采用这些列对应并重新识别</button></details>`:''}<br>没有可靠建议的字段继续手动填写，采用建议后仍需确认入库。`;});return true;
 }
 if(a==='intake-ai-accept'){const row=preview.source_rows.find(r=>r.id===b.dataset.rowId);if(row?.ai_suggestions){intakeCorrections[row.id]={...intakeCorrections[row.id],...row.ai_suggestions};delete row.ai_suggestions;renderIntakeEditor();markIntakeDirty();}return true;}
 if(a==='intake-ai-map'){work(async()=>{for(const m of preview.ai_mappings||[]){const source=intakeInputs[m.input];source.header=m.header;source.mapping={...source.mapping,...m.mapping};}markIntakeDirty();await prepareIntake();preview=await api('/api/preview',mappedPayload());renderPreview();notice('已采用列对应，请核对物资和标段后手动确认入库。');});return true;}
 if(a==='manual-add'){$('intake-manual-rows').insertAdjacentHTML('beforeend',manualRowHTML());markIntakeDirty();return true;}
 if(a==='manual-remove'){b.closest('tr').remove();markIntakeDirty();return true;}
 if(a==='intake-toggle-row'){const check=b.closest('tr').querySelector('[data-intake-include]');check.checked=!check.checked;check.dispatchEvent(new Event('change',{bubbles:true}));return true;}
 if(a==='intake-exclude-page'||a==='intake-restore-page'){const ids=a==='intake-restore-page'&&intakeExcludedPage.length?intakeExcludedPage:intakeVisibleRows().slice(intakeEditPage*30,(intakeEditPage+1)*30).map(row=>row.id);for(const id of ids)intakeCorrections[id]={...intakeCorrections[id],exclude_reason:a==='intake-exclude-page'?'人工选择本页不入库':''};intakeExcludedPage=a==='intake-exclude-page'?ids:[];renderIntakeEditor();markIntakeDirty();return true;}
 if(a==='intake-prev'||a==='intake-next'){intakeEditPage+=a==='intake-next'?1:-1;renderIntakeEditor();return true;}
 if(a==='intake-settings'){const advanced=$('intake-advanced');if(advanced){advanced.open=true;advanced.scrollIntoView({behavior:'smooth',block:'start'});}return true;}
 if(a==='intake-problems'){intakeOnlyProblems=true;intakeEditPage=0;renderIntakeEditor();$('intake-review-host').scrollIntoView({behavior:'smooth',block:'start'});document.querySelector('#intake-editor [aria-invalid="true"]')?.focus();return true;}
 if(a==='intake-page-boxes'){for(const row of preview.source_rows){const patch=intakeCorrections[row.id]||{};if(row.page_box&&row.box!==row.page_box&&!row.exclude_reason&&!patch.exclude_reason&&!Object.hasOwn(patch,'box'))intakeCorrections[row.id]={...patch,box:row.page_box};}markIntakeDirty();work(async()=>{await prepareIntake();preview=await api('/api/preview',mappedPayload());intakeOnlyProblems=false;renderPreview();notice('已按各页原文补全箱号，请核对物资后手动确认入库。');});return true;}
 if(a==='intake-clear'){intakeCorrections={};markIntakeDirty();work(async()=>{await prepareIntake();preview=await api('/api/preview',mappedPayload());renderPreview();});return true;}
 if(a==='intake-suggest'){const row=preview.source_rows.find(r=>r.id===b.dataset.rowId);intakeCorrections[row.id]={...intakeCorrections[row.id],...row.suggestions};renderIntakeEditor();markIntakeDirty();return true;}
 return false;
}
document.addEventListener('input',e=>{
 if(posting)return;const el=e.target;
 if(el.dataset.intakeRow){intakeCorrections[el.dataset.intakeRow]={...intakeCorrections[el.dataset.intakeRow],[el.dataset.intakeField]:el.value};if(el.dataset.intakeField==='exclude_reason'){const row=el.closest('tr'),check=row?.querySelector('[data-intake-include]');if(check)check.checked=!el.value.trim();row?.classList.toggle('intake-excluded',!!el.value.trim());}markIntakeDirty();}
 if(el.dataset.manualField||el.id.startsWith('intake-text-'))markIntakeDirty();
});
document.addEventListener('change',e=>{
 if(posting)return;const el=e.target,index=el.dataset.intakeSource;
 if(el.id==='intake-only-problems'){intakeOnlyProblems=el.checked;intakeEditPage=0;renderIntakeEditor();return;}
 if(el.dataset.intakeInclude!==undefined){const id=el.dataset.intakeInclude,c={...intakeCorrections[id]},reason=el.closest('tr')?.querySelector('[data-intake-field="exclude_reason"]');if(!el.checked)c.exclude_reason=c.exclude_reason||'人工选择不入库';else c.exclude_reason='';if(reason)reason.value=c.exclude_reason||'';if(Object.keys(c).length)intakeCorrections[id]=c;else delete intakeCorrections[id];el.closest('tr')?.classList.toggle('intake-excluded',!el.checked);const toggle=el.closest('tr')?.querySelector('[data-action="intake-toggle-row"]');if(toggle)toggle.textContent=el.checked?'移除':'恢复';markIntakeDirty();return;}
 if(index!==undefined){const source=intakeInputs[Number(index)];
  if(el.dataset.intakeMap){source.mapping={...preview.selections.find(s=>s.input===Number(index)).mapping,...source.mapping,[el.dataset.intakeMap]:Number(el.value)};}
  if(el.dataset.intakeDefault){source.defaults={...source.defaults,[el.dataset.intakeDefault]:el.value};}
  if(el.dataset.intakeSetting){const key=el.dataset.intakeSetting;source[key]=el.type==='checkbox'?el.checked:el.value;if(key==='role'&&(source.slot??Number(index))===0&&$('intake-role-main'))$('intake-role-main').value=el.value;if(key==='sheet'){delete source.header;delete source.mapping;intakeCorrections={};}if(key==='header')delete source.mapping;}
  markIntakeDirty();
 }
 if(el.id==='intake-role-main'){const source=intakeSourceSlot(0);if(source)source.role=el.value;markIntakeDirty();}
 if(el.id.startsWith('intake-file-')||['default-package','batch-date','batch-number','default-warehouse','default-bin','default-state','default-box'].includes(el.id))markIntakeDirty();
});

const recognitionPageSize=100;
function disposeUniver(id){try{window.disposeUniverPreview?.(id);}catch(e){console.warn('Univer cleanup failed',e);}}
function mountUniver(id,rows,fallbackId){
 const fallback=$(fallbackId);const host=$(id);if(!host||!rows?.length)return;
 if(typeof window.mountUniverPreview!=='function'){if(fallback)fallback.hidden=false;host.hidden=true;return;}
 host.hidden=false;
 window.mountUniverPreview(id,rows,lang==='zh'?'zh-CN':'en-US').then(()=>{if(fallback)fallback.hidden=true;}).catch(error=>{
  console.warn('Univer preview unavailable; using read-only HTML table',error);
  host.hidden=true;if(fallback)fallback.hidden=false;
 });
}
function rowsFallback(rows,target,pageIndex){
 const fieldsToShow=['code','name','spec','unit','qty','batch','box','warehouse','bin','package','state','attribute'];
 const start=pageIndex*recognitionPageSize,part=rows.slice(start,start+recognitionPageSize),end=Math.min(start+part.length,rows.length);
 const body=part.map(x=>`<tr><td>${esc(x.source_row)}</td>${['code','name','spec','unit','qty','batch','box','warehouse','bin','package'].map(k=>`<td>${esc(x[k])}</td>`).join('')}<td>${badge(x.state)}</td><td>${esc(x.attribute)}</td></tr>`);
 return `${table([t('源行','Row'),...fieldsToShow.map(k=>t(...fields[k]))],body)}<div class="archive-pager"><button class="quiet small" data-rows-target="${target}" data-rows-step="-1" ${pageIndex<=0?'disabled':''}>${t('上一页','Previous')}</button><span>${rows.length?start+1:0}–${end} / ${rows.length}</span><button class="quiet small" data-rows-target="${target}" data-rows-step="1" ${end>=rows.length?'disabled':''}>${t('下一页','Next')}</button></div>`;
}
function recognitionCategoryName(value){return ({packing:t('装箱明细','Packing detail'),shipment:t('发货清单','Shipment list'),baseline:t('设计基准','Design baseline'),unclassified:t('待分类','Unclassified')})[value]||value||'—';}
function recognitionStatusName(value){return ({READY:t('待确认','Ready'),BLOCKED:t('识别受阻','Blocked'),POSTED:t('已入账','Posted'),CANCELLED:t('已取消','Cancelled')})[value]||value||'—';}
function recognitionTime(value){try{return new Intl.DateTimeFormat(lang==='zh'?'zh-CN':'en-GB',{timeZone:'Africa/Johannesburg',dateStyle:'medium',timeStyle:'short'}).format(new Date(value));}catch{return value||'—';}}
function recognitionsPage(){
 return `<p class="intro">${t('按识别时间归档原始文件和识别快照；标段、批次是筛选属性。识别受阻时点击“继续处理”，修正或跳过问题行后再确认入库。','Files and recognition snapshots are archived by recognition time. Segment and batch are searchable attributes. Preview archives do not change stock.')}</p><section class="panel"><div class="panel-top"><div><h2>${t('识别归档','Recognition archive')}</h2><p>${t('业务日期与识别日期分开记录；只有确认后才会关联入库单。','Business date is stored separately; a receipt is linked only after confirmation.')}</p></div><div class="actions"><a class="quiet" href="/api/backup">${t('备份数据（含数据库与原件）','Backup (DB + sources)')}</a><a class="quiet" href="/univer-LICENSES.txt">${t('开源许可','Open-source licenses')}</a></div></div><div class="recognition-filters"><label>${t('识别日期从','Recognized from')}<input id="recognition-from" type="date"></label><label>${t('到','To')}<input id="recognition-to" type="date"></label><label>${t('类别','Category')}<select id="recognition-category"><option value="">${t('全部类别','All categories')}</option><option value="packing">${recognitionCategoryName('packing')}</option><option value="shipment">${recognitionCategoryName('shipment')}</option><option value="baseline">${recognitionCategoryName('baseline')}</option><option value="unclassified">${recognitionCategoryName('unclassified')}</option></select></label><label>${t('标段','Segment')}<select id="recognition-segment"><option value="">${t('全部标段','All segments')}</option>${(db?.segments||[]).map(s=>`<option value="${esc(s.code)}">${esc(s.code)}｜${esc(lang==='zh'?s.zh:s.en)}</option>`).join('')}</select></label><label>${t('批次','Batch')}<input id="recognition-batch" placeholder="${t('批次编号','Batch number')}"></label><label>${t('状态','Status')}<select id="recognition-status"><option value="">${t('全部状态','All statuses')}</option>${['READY','BLOCKED','POSTED','CANCELLED'].map(s=>`<option value="${s}">${recognitionStatusName(s)}</option>`).join('')}</select></label><button data-action="recognition-search">${t('筛选','Filter')}</button></div><div id="recognition-list">${empty(t('正在读取归档','Loading archives'),t('请稍候。','Please wait.'))}</div></section>`;
}
function recognitionDeleteActions(r){const d=(db?.documents||[]).find(d=>Number(d.id)===Number(r.document_id));return `<button class="danger small" data-action="recognition-delete" data-recognition-id="${r.id}">${t('删除记录','Delete record')}</button>${d?.kind==='IN'&&!d.reversed_by?`<button class="danger small" data-delete="${d.id}">${t('删除入库单','Delete receipt')}</button>`:''}`;}
function recognitionRowHtml(r){return `<tr><td><input type="checkbox" data-recognition-select="${r.id}" aria-label="${esc(t('选择记录：','Select record: ')+r.original_name)}" ${recognitionSelected.has(Number(r.id))?'checked':''}></td><td><span class="name">${esc(recognitionTime(r.recognized_at))}</span><div class="sub">${t('业务日期','Business date')}: ${esc(r.business_date)||'—'}</div></td><td>${esc(r.original_name)}</td><td>${esc(recognitionCategoryName(r.category))}</td><td>${esc(r.segments.join('、')||'—')}</td><td>${esc(r.batches.join('、')||'—')}</td><td><span class="tag ${esc(r.status)}">${esc(recognitionStatusName(r.status))}</span>${r.issue_count?`<small class="recognition-issue" title="${esc(r.issue_summary)}">${r.issue_count} 项待核对 · ${esc(r.issue_summary)}</small>`:''}</td><td>${r.document_id?`<button class="quiet small" data-doc="${r.document_id}">${t('入库单','Receipt')} #${r.document_id}</button>`:'—'}</td><td><div class="actions">${r.can_reopen?`<button class="small" data-action="recognition-reopen" data-recognition-id="${r.id}">继续处理</button>`:''}<button class="quiet small" data-recognition="${r.id}">${t('查看','View')}</button>${r.has_source?`<a class="quiet small" href="/api/recognition-source?id=${r.id}">${t('原文件','Source')}</a>`:''}${recognitionDeleteActions(r)}</div></td></tr>`;}
function renderRecognitionList(total,hasMore){
 const host=$('recognition-list');if(!host)return;
 if(!recognitionListRows.length){host.innerHTML=empty(t('暂无识别归档','No recognition archives'),t('完成文件识别后，原件和识别结果会自动保存在这里。','Files and parsed results are saved here after recognition.'));return;}
 host.innerHTML=`<div class="actions"><span id="recognition-selected-count" aria-live="polite"></span><button id="recognition-delete-selected" class="danger" data-action="recognition-delete-batch" disabled>${t('删除选中记录','Delete selected records')}</button><span class="sub">${t('仅删除归档记录，库存和入库单保留','Only archives are deleted; stock and receipts remain')}</span></div>${table(['<input type="checkbox" data-recognition-all aria-label="'+t('全选已加载记录','Select all loaded records')+'">',t('识别时间 / 业务日期','Recognized / Business date'),t('原始文件','Source file'),t('类别','Category'),t('标段','Segments'),t('批次','Batches'),t('状态','Status'),t('关联单据','Linked document'),t('操作','Actions')],recognitionListRows.map(recognitionRowHtml))}<div class="archive-pager"><span>${t('共','Total')} ${total}</span>${hasMore?`<button class="quiet small" data-action="recognition-more">${t('加载更多','Load more')}</button>`:''}</div>`;
 syncRecognitionSelection();
}
function syncRecognitionSelection(){
 const count=$('recognition-selected-count'),button=$('recognition-delete-selected'),all=document.querySelector('[data-recognition-all]');
 if(count)count.textContent=t(`已选 ${recognitionSelected.size} 条`,`Selected ${recognitionSelected.size}`);
 if(button)button.disabled=!recognitionSelected.size;
 if(all){all.checked=recognitionListRows.length>0&&recognitionSelected.size===recognitionListRows.length;all.indeterminate=recognitionSelected.size>0&&!all.checked;}
}
document.addEventListener('change',e=>{
 const el=e.target;
 if(el.dataset.recognitionAll!==undefined){recognitionSelected=el.checked?new Set(recognitionListRows.map(r=>Number(r.id))):new Set();document.querySelectorAll('[data-recognition-select]').forEach(x=>x.checked=el.checked);syncRecognitionSelection();}
 if(el.dataset.recognitionSelect!==undefined){const id=Number(el.dataset.recognitionSelect);if(el.checked)recognitionSelected.add(id);else recognitionSelected.delete(id);syncRecognitionSelection();}
});
async function loadRecognitionList(append=true){
 const host=$('recognition-list');if(recognitionListLoading||!host)return;
 if(!append){recognitionListOffset=0;recognitionListRows=[];recognitionSelected.clear();}
 recognitionListLoading=true;
 try{
  const q=new URLSearchParams({limit:'100',offset:String(recognitionListOffset),from:$('recognition-from')?.value||'',to:$('recognition-to')?.value||'',category:$('recognition-category')?.value||'',segment:$('recognition-segment')?.value||'',batch:$('recognition-batch')?.value.trim()||'',status:$('recognition-status')?.value||''});
  const res=await api('/api/recognitions?'+q.toString());if($('recognition-list')!==host)return;recognitionListRows=recognitionListRows.concat(res.rows);recognitionListOffset+=res.rows.length;renderRecognitionList(res.total,res.has_more);
 }catch(e){if($('recognition-list')===host)host.innerHTML=empty(t('归档读取失败','Could not load archives'),esc(e.message));}
 finally{recognitionListLoading=false;if($('recognition-list')&&$('recognition-list')!==host)loadRecognitionList(false);}
}
async function showRecognition(id){
 disposeUniver('recognition-univer');currentRecognition=await api('/api/recognition?id='+encodeURIComponent(id));recognitionRowsPage=0;
 const r=currentRecognition,s=r.snapshot,rows=s.rows||[];
 $('modal-body').innerHTML=`<div class="doc-head"><div><div class="eyebrow">SMART WAREHOUSE / RECOGNITION ARCHIVE</div><h2 class="doc-title">${esc(r.original_name)}</h2><div class="sub">${esc(recognitionTime(r.recognized_at))} · ${esc(recognitionCategoryName(r.category))} · ${esc(recognitionStatusName(r.status))}</div></div><div class="code">ID ${r.id}<br>SHA-256 ${esc(r.raw_sha256.slice(0,16))}…</div></div><div class="doc-meta"><div>${t('业务日期','Business date')}: ${esc(r.business_date)||'—'}</div><div>${t('工作表','Worksheet')}: ${esc(r.sheet_name)||'—'}</div><div>${t('解析器版本','Parser version')}: ${esc(r.parser_version)}</div><div>${t('标段','Segments')}: ${esc(r.segments.join('、')||'—')}</div><div>${t('批次','Batches')}: ${esc(r.batches.join('、')||'—')}</div><div>${t('识别行数','Recognized rows')}: ${fmt(s.count||rows.length)}</div>${r.document_id?`<div>${t('关联单据','Linked document')}: ${esc(r.document_id)}</div>`:''}</div>${s.errors?.length?`<div class="error-list">${s.errors.map(esc).join('\n')}</div>`:''}${s.warnings?.length?`<div class="warning-list">${s.warnings.map(esc).join('\n')}</div>`:''}<div id="recognition-univer" class="univer-grid" ${rows.length?'':'hidden'}></div><div id="recognition-html-fallback">${rows.length?rowsFallback(rows,'archive',recognitionRowsPage):empty(t('没有识别明细','No recognized rows'),t('原文件仍保存在归档中。','The source file is still available in the archive.'))}</div><div class="doc-actions">${r.has_source?`<a class="quiet" href="/api/recognition-source?id=${r.id}">${t('下载原始文件','Download original file')}</a>`:''}${r.can_reopen?`<button class="quiet" data-action="recognition-reopen" data-recognition-id="${r.id}">继续处理</button>`:''}${r.document_id?`<button class="quiet" data-doc="${r.document_id}">${t('查看关联单据','View linked document')}</button>`:''}${recognitionDeleteActions(r)}</div>`;
 $('modal').showModal();if(rows.length)mountUniver('recognition-univer',rows,'recognition-html-fallback');
}
document.addEventListener('click',e=>{const b=e.target.closest('[data-preview-toggle]');if(!b)return;document.querySelectorAll('#preview-tree details').forEach(d=>d.open=b.dataset.previewToggle==='open');});

function treeLeaf(row){
 const contents=Array.isArray(row.contents)?row.contents:[];
 const childHtml=contents.length?`<div class="tree-contents">${contents.map(c=>`<div>↳ ${c.code?`<span class="code">${esc(c.code)}</span> · `:''}${esc(c.name)} · ${fmt(c.qty)} ${esc(c.unit)}</div>`).join('')}</div>`:'';
 const noteHtml=row.attribute?(contents.length?`<details class="tree-note"><summary>${t('原始备注','Original note')}</summary><div class="sub">${esc(row.attribute)}</div></details>`:`<div class="sub">${esc(row.attribute)}</div>`):'';
 return `<div class="tree-leaf"><div><span class="code">${esc(row.code)}</span><br><span class="name">${esc(row.name)}</span>${row.spec?`<span class="sub"> · ${esc(row.spec)}</span>`:''}${noteHtml}${childHtml}</div><div class="tree-leaf-right"><span>${row.id?`本货位 ${fmt(row.qty)} ${esc(row.unit)}`:stockBalanceText(row)}</span>${badge(row.state)}${row.id?`<div class="actions">${stockActions(row)}</div>`:''}</div></div>`;
}

function intakeVisibleRows(){return (preview?.source_rows||[]).filter(row=>!intakeOnlyProblems||row.issues.length&&!({...row,...intakeCorrections[row.id]}).exclude_reason);}
function intakeCountText(){const rows=preview?.source_rows||[],selected=rows.filter(row=>!({...row,...intakeCorrections[row.id]}).exclude_reason);return `已选 ${selected.length} 条 · 不入库 ${rows.length-selected.length} 条 · 待核对 ${selected.filter(row=>row.issues.length).length} 条`;}
function intakeFieldIssues(row,key){return (row.issues||[]).filter(issue=>{const field=Object.entries(intakeFields).find(([k,title])=>issue.includes(title)||k==='qty'&&/数值|数量/.test(issue));return (field?.[0]||'name')===key;});}
function inventoryModesHTML(){return `<div class="actions inventory-modes"><button class="quiet ${inventoryLayout==='list'?'selected':''}" data-inventory-layout="list">物资列表</button><button class="quiet ${inventoryLayout==='box'?'selected':''}" data-inventory-layout="box">按箱查看</button>${cart.length&&action==='OUT'?`<span>已选 ${cart.length} 条</span><button data-action="issue-checkout">去确认发料</button>`:''}</div>`;}
function stockActions(s){return `<button class="quiet small" data-stock-view="${s.id}">详情</button><button class="quiet small" data-stock-issue="${s.id}" ${s.state==='AVAILABLE'&&Number(s.qty)>0?'':'disabled'}>加入发料</button>`;}
function stockListHTML(rows){const key={item:'name',contract:'package',batch:'batch',box:'box'}[treeState.sort]||'name',sorted=[...rows].sort((a,b)=>treeState.sort==='qty'?(String(a.unit).localeCompare(String(b.unit),'zh-CN')||Number(b.qty)-Number(a.qty)||a.id-b.id):(String(a[key]||'').localeCompare(String(b[key]||''),'zh-CN')||a.id-b.id)),pages=Math.max(1,Math.ceil(rows.length/100));inventoryPage=Math.max(0,Math.min(inventoryPage,pages-1));return table(['物资 / 规格','标段 / 批次 / 箱号','仓库 / 库位','状态','本货位数量','操作'],sorted.slice(inventoryPage*100,(inventoryPage+1)*100).map(s=>`<tr><td><strong>${esc(s.name)}</strong><div class="sub">${esc(s.spec)||'—'}</div></td><td>${esc(segmentLabel(s.package))}<div class="sub">${esc(s.batch)} · 箱 ${esc(s.box)||'—'}</div></td><td>${esc(s.warehouse)} / ${esc(s.bin)}</td><td>${badge(s.state)}</td><td>${fmt(s.qty)} ${esc(s.unit)}</td><td><div class="actions">${stockActions(s)}</div></td></tr>`))+`<div class="actions inventory-pagination"><button class="quiet small" data-inventory-step="-1" ${inventoryPage===0?'disabled':''}>上一页</button><span>${inventoryPage+1} / ${pages}</span><button class="quiet small" data-inventory-step="1" ${inventoryPage+1>=pages?'disabled':''}>下一页</button></div>`;}
function addCartStock(id){const s=(db?.stock||[]).find(s=>s.id===id);if(!s||Number(s.qty)<=0)throw Error('请选择有效的库存位置');if(action==='OUT'&&s.state!=='AVAILABLE'||action==='HANDOVER'&&s.state!=='SPARE')throw Error('此库存状态不可用于当前业务；普通发料只允许可用库存');if(cart.some(r=>r.stock_id===id))throw Error('该箱号和库位已在清单中');cart.push({stock_id:id,qty:Math.min(1,Number(s.qty))});}
function queueStockForIssue(id){if(action!=='OUT'&&cart.length)throw Error('请先处理当前库存业务清单，再加入发料');const s=(db?.stock||[]).find(s=>s.id===id);if(!s||s.state!=='AVAILABLE')throw Error('仅可用库存可以加入发料');action='OUT';addCartStock(id);issueMode='position';}
function groupCartQty(g){const ids=new Set(g.rows.map(s=>s.id));return cart.filter(r=>ids.has(r.stock_id)).reduce((sum,r)=>sum+Number(r.qty||0),0);}
function restoreBulkFields(){if(issueMode!=='item')return;issueGroups().forEach((g,i)=>{const field=document.querySelector(`[data-group-qty="${i}"]`),check=document.querySelector(`[data-group-check="${i}"]`),qty=groupCartQty(g);if(field)field.value=qty?String(qty):'';if(check)check.checked=qty>0;});}
function setCartQuantity(index,value){if(!cart[index])return;if(Number(value)===0){cart.splice(index,1);$('cart').innerHTML=cartHTML();}else cart[index].qty=value;restoreBulkFields();saveBusinessDraft();const button=document.querySelector('[data-action="post"]');if(button)button.disabled=!cart.length||cart.some(r=>{const s=db.stock.find(s=>s.id===r.stock_id),qty=Number(r.qty);return !s||!Number.isFinite(qty)||qty<=0||qty>Number(s.qty)+1e-9;});}
async function showStockDetail(id,offset=0){const {stock:s,history:h}=await api('/api/stock-detail?id='+encodeURIComponent(id)+'&offset='+offset);$('modal-body').innerHTML=`<h2>${esc(s.name)}</h2><p>${esc(s.spec)||'规格未填写'}</p><p>标段 ${esc(segmentLabel(s.package))} · 批次 ${esc(s.batch)} · 箱 ${esc(s.box)||'—'}</p><p>${esc(s.warehouse)} / ${esc(s.bin)} · ${label(s.state)} · 本货位 ${fmt(s.qty)} ${esc(s.unit)}</p><details><summary>编码与同箱物资总量</summary><p>${esc(s.code)} · ${stockBalanceText(s)}</p></details>${s.contents.length?`<h3>箱内明细（随箱记录，不重复扣库存）</h3>${table(['名称','规格','数量'],s.contents.map(c=>`<tr><td>${esc(c.name)}</td><td>${esc(c.spec)}</td><td>${fmt(c.qty)} ${esc(c.unit)}</td></tr>`))}`:''}<h3>同物资、批次和箱号的业务记录</h3>${table(['单据 / 时间','业务','数量变化','位置','原件'],h.rows.map(r=>`<tr><td><button class="quiet small" data-doc="${r.doc_id}">${esc(r.number)}</button><small>${esc(r.date)}</small></td><td>${esc(label(r.kind))}</td><td>${fmt(r.delta)} ${esc(r.unit)}</td><td>${esc(r.warehouse)} / ${esc(r.bin)}</td><td>${r.has_source?`<a href="/api/source?id=${r.doc_id}">下载原件</a>`:'—'}</td></tr>`))}<div class="actions"><button class="quiet small" data-stock-view="${id}" data-offset="${Math.max(0,offset-h.limit)}" ${offset?'':'disabled'}>上一页</button><span>共 ${h.total} 条流水</span><button class="quiet small" data-stock-view="${id}" data-offset="${offset+h.limit}" ${h.has_more?'':'disabled'}>下一页</button></div>`;if(!$('modal').open)$('modal').showModal();}

function intakeSourceSlot(slot){return intakeInputs.find((source,index)=>(source.slot??index)===slot);}
