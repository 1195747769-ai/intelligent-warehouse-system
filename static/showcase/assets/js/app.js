const state={active:"project",scenes:{},pending:{},raf:0,lastRenderAt:0};
const warehouseMode=new URLSearchParams(location.search).has("warehouse");
const arrivalPreview=[
  {equipment_key:"bess-cabinet",name:"储能柜",lot_code:"Lot-05",unit:"台",model_display_count:86},
  {equipment_key:"pcs",name:"PCS 储能变流器",lot_code:"Lot-05",unit:"台"},
  {equipment_key:"pv-inverter",name:"组串式逆变器",lot_code:"Lot-03",unit:"台"},
  {equipment_key:"pv-transformer",name:"PV 箱式变压器",lot_code:"Lot-04",unit:"台"},
  {equipment_key:"main-transformer",name:"132 kV 主变压器",lot_code:"Lot-15",unit:"台"}
];
const arrivals={items:null,updatedAt:null,error:"",selected:[],selectionHint:""};
const MIN_FRAME_INTERVAL=1000/60;
const viewEls={project:document.getElementById("project"),overview:document.getElementById("overview"),pv:document.getElementById("pv"),transmission:document.getElementById("transmission")};
const specs={
  overview:{canvas:"site-scene",loading:"site",error:"site",create:()=>import("./site-model.js?rev=60").then(({createSiteScene})=>createSiteScene(document.getElementById("site-scene"),document.getElementById("site-inspector")))},
  pv:{canvas:"pv-scene",loading:"pv",error:"pv",create:()=>import("./pv-model.js?rev=63").then(({createPvScene})=>createPvScene(document.getElementById("pv-scene"),document.getElementById("pv-inspector")))},
  transmission:{canvas:"line-scene",loading:"line",error:"line",create:()=>import("./line-model.js?rev=58").then(({createLineScene})=>createLineScene(document.getElementById("line-scene")))}
};

const html=value=>String(value??"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
const arrivalNumber=value=>value===null||value===undefined?"—":Number(value).toLocaleString("zh-CN",{maximumFractionDigits:3});
const arrivalPercent=value=>value===null||value===undefined?"—":`${(Number(value)*100).toLocaleString("zh-CN",{maximumFractionDigits:1})}%`;
function arrivalRows(scope){
  const keys=document.querySelector(`[data-arrival-board="${scope}"]`)?.dataset.arrivalKeys.split(",")||[];
  const rows=arrivals.items||arrivalPreview.map(item=>({...item,status:"not_refreshed",spec:null,received:null,total:null,rate:null,total_basis:"unknown",reason:"请点顶部“手动刷新到货”读取当前仓储汇总"}));
  return rows.filter(item=>keys.includes(item.equipment_key));
}
function renderArrivalBoard(scope){
  const board=document.querySelector(`[data-arrival-board="${scope}"]`),cards=board?.querySelector(`[data-arrival-cards="${scope}"]`),detail=board?.querySelector(`[data-arrival-detail="${scope}"]`);
  if(!board||!cards||!detail)return;
  const rows=arrivalRows(scope);
  cards.innerHTML=rows.map(item=>{
    const selected=arrivals.selected.includes(item.equipment_key);
    return `<button class="arrival-equipment-card${selected?" is-selected":""}" type="button" data-arrival-select="${html(item.equipment_key)}" aria-pressed="${selected}" aria-label="${html(item.name)} 到货率 ${arrivalPercent(item.rate)}"><span class="arrival-equipment-name">${html(item.name)}</span><strong class="arrival-rate">${arrivalPercent(item.rate)}</strong><span class="arrival-summary-caption">到货率</span></button>`;
  }).join("");
  const selected=rows.filter(item=>arrivals.selected.includes(item.equipment_key));
  if(!selected.length){
    detail.textContent=arrivals.selectionHint||arrivals.error||"点选设备卡或场景区域查看规格型号及到货口径。";
    return;
  }
  detail.innerHTML=selected.map(item=>`<article class="arrival-record"><div class="arrival-record-heading"><strong>${html(item.name)}</strong><span>${html(item.lot_code||"Lot 待核")}</span></div><div class="arrival-record-grid"><span>规格型号</span><b>${html(item.spec||"待设备清单确认")}</b><span>现场签收</span><b>${arrivalNumber(item.received)} ${html(item.unit||"")}</b><span>在途 / 清关（参考）</span><b>${arrivalNumber(item.in_transit)} ${html(item.unit||"")}</b><span>项目总量</span><b>${arrivalNumber(item.total)} ${html(item.unit||"")}</b><span>到货率</span><b>${arrivalPercent(item.rate)}</b><span>总量口径</span><b>${item.total_basis==="warehouse_design"?"仓储设计数量":"待确认"}</b></div>${item.model_display_count!==undefined?`<p>模型展示数：${arrivalNumber(item.model_display_count)} ${html(item.unit)}（不作为采购总量）</p>`:""}${item.reason?`<p class="arrival-reason">${html(item.reason)}</p>`:""}${item.in_transit_reason?`<p class="arrival-reason">${html(item.in_transit_reason)}</p>`:""}<a href="/warehouse" class="arrival-warehouse-link">查看仓储业务明细 →</a></article>`).join("");
}
function renderArrivalBoards(){["overview","pv","transmission"].forEach(renderArrivalBoard);}
async function refreshProjectArrivals(){
  const button=document.querySelector("[data-arrival-refresh]"),status=document.querySelector("[data-arrival-refresh-status]");
  if(!button||button.disabled)return;
  button.disabled=true;button.setAttribute("aria-busy","true");status.textContent="正在读取…";
  try{
    const response=await fetch("/api/project-arrivals",{cache:"no-store"});
    if(!response.ok)throw new Error(`HTTP ${response.status}`);
    const result=await response.json();
    if(!Array.isArray(result.items))throw new Error("汇总格式不完整");
    arrivals.items=result.items;arrivals.updatedAt=result.generated_at;arrivals.error="";
    const time=result.generated_at?new Date(result.generated_at).toLocaleString("zh-CN"):"刷新成功";
    status.textContent=`已更新 ${time}`;status.title="手动读取仓储只读汇总";
    renderArrivalBoards();
  }catch(error){
    arrivals.error=arrivals.items?"刷新失败，当前保留上次成功结果。":"到货汇总暂不可用；尚无上次成功数据。";
    status.textContent=arrivals.items?"刷新失败 · 保留上次数据":"刷新失败";status.title=error.message;
    renderArrivalBoards();
  }finally{button.disabled=false;button.removeAttribute("aria-busy");}
}

if(warehouseMode){
  document.querySelector(".topbar-tools").hidden=false;
  document.querySelectorAll("[data-arrival-board]").forEach(board=>{board.hidden=false;});
  document.querySelector("[data-arrival-refresh]").addEventListener("click",refreshProjectArrivals);
  renderArrivalBoards();
  document.addEventListener("click",event=>{
    const button=event.target.closest("[data-arrival-select]");
    if(!button)return;
    arrivals.selected=[button.dataset.arrivalSelect];arrivals.selectionHint="";
    renderArrivalBoards();
  });
  window.addEventListener("baphalane-arrival-focus",event=>{
    arrivals.selected=Array.isArray(event.detail?.keys)?event.detail.keys:[];
    arrivals.selectionHint=!arrivals.selected.length&&event.detail?.label?`${event.detail.label}：尚无匹配的主要设备到货数据，不按 0 台显示。`:"";
    renderArrivalBoards();
  });
}

function initialize(name){
  if(state.scenes[name])return state.scenes[name];
  if(state.pending[name])return state.pending[name];
  const spec=specs[name];
  state.pending[name]=Promise.resolve().then(spec.create).then(instance=>{
    state.scenes[name]=instance;
    document.querySelector(`[data-loading="${spec.loading}"]`).hidden=true;
    if(name==="overview"||name==="pv"||name==="transmission")instance.renderer.domElement.style.cursor="grab";
    instance.controls.addEventListener("change",requestDraw);
    instance.controls.addEventListener("start",requestDraw);
    observeSize(name);
    requestDraw();
    return instance;
  }).catch(error=>{
    console.error("3D 模型初始化失败",error);
    document.querySelector(`[data-loading="${spec.loading}"]`).hidden=true;
    document.querySelector(`[data-error="${spec.error}"]`).hidden=false;
    return null;
  }).finally(()=>{delete state.pending[name];});
  return state.pending[name];
}

function observeSize(name){
  const instance=state.scenes[name], container=document.getElementById(specs[name].canvas);
  const resize=()=>{
    if(!instance||!container.clientWidth||!container.clientHeight)return;
    instance.camera.aspect=container.clientWidth/container.clientHeight;instance.camera.updateProjectionMatrix();
    instance.renderer.setSize(container.clientWidth,container.clientHeight);
    instance.onResize?.();
    requestDraw();
  };
  if("ResizeObserver" in window)new ResizeObserver(resize).observe(container);else window.addEventListener("resize",resize);
  resize();
}

function requestDraw(){
  if(state.raf||document.hidden)return;
  state.raf=requestAnimationFrame(draw);
}

function draw(timestamp){
  state.raf=0;
  if(timestamp-state.lastRenderAt<MIN_FRAME_INTERVAL){requestDraw();return;}
  state.lastRenderAt=timestamp;
  const instance=state.scenes[state.active];
  if(!instance)return;
  const container=document.getElementById(specs[state.active].canvas);
  if(!container.clientWidth||!container.clientHeight)return;
  instance.update?.(timestamp);instance.controls.update();instance.renderer.render(instance.scene,instance.camera);
  if(instance.continuousRender?.())requestDraw();
}

function switchView(name){
  if(!viewEls[name])return;
  if(name!=="overview")state.scenes.overview?.scene.userData.stopTour?.();
  if(name!=="transmission")state.scenes.transmission?.scene.userData.stopTour?.();
  state.active=name;
  if(warehouseMode)renderArrivalBoard(name);
  state.lastRenderAt=0;
  document.body.dataset.activeView=name;
  for(const [id,el] of Object.entries(viewEls)){el.hidden=id!==name;el.classList.toggle("is-active",id===name);}
  document.querySelectorAll("[data-view-target]").forEach(button=>{
    const active=button.dataset.viewTarget===name;button.classList.toggle("is-active",active);
    if(active)button.setAttribute("aria-current","page");else button.removeAttribute("aria-current");
  });
  if(!specs[name])return;
  const instance=initialize(name);
  Promise.resolve(instance).then(ready=>{if(ready)requestAnimationFrame(()=>{
    const el=document.getElementById(specs[name].canvas);if(!el.clientWidth||!el.clientHeight)return;ready.camera.aspect=el.clientWidth/el.clientHeight;ready.camera.updateProjectionMatrix();ready.renderer.setSize(el.clientWidth,el.clientHeight);ready.onResize?.();requestDraw();
  });});
}

document.querySelectorAll("[data-reset-scene]").forEach(button=>button.addEventListener("click",()=>{
  const instance=state.scenes[{site:"overview",pv:"pv",line:"transmission"}[button.dataset.resetScene]];
  if(!instance)return;
  instance.scene.userData.reset?.();
  window.dispatchEvent(new CustomEvent("baphalane-arrival-focus",{detail:{keys:[]}}));
  requestDraw();
}));
function navigateView(name,push=true,focus=false){
  if(!viewEls[name])name="project";
  if(push&&location.hash!==`#${name}`)history.pushState(null,"",`#${name}`);
  switchView(name);
  window.scrollTo(0,0);
  if(focus){
    const heading=document.getElementById(viewEls[name].getAttribute("aria-labelledby"));
    heading?.setAttribute("tabindex","-1");heading?.focus({preventScroll:true});
  }
}
function syncViewToLocation(){navigateView(location.hash.slice(1),false);}

document.querySelectorAll("[data-view-target]").forEach(button=>button.addEventListener("click",()=>navigateView(button.dataset.viewTarget,true,true)));
document.addEventListener("click",event=>{
  if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
  const link=event.target.closest('a[href^="#"]');
  const name=link?.getAttribute("href").slice(1);
  if(!viewEls[name]||link.hasAttribute("download")||link.getAttribute("target"))return;
  event.preventDefault();navigateView(name,true,true);
});
window.addEventListener("hashchange",syncViewToLocation);
window.addEventListener("popstate",syncViewToLocation);
document.addEventListener("click",event=>{if(event.target.closest("button"))requestDraw();});
document.addEventListener("visibilitychange",()=>{if(!document.hidden)requestDraw();});

const initialView=location.hash.slice(1);
switchView(viewEls[initialView]?initialView:"project");
if(location.hash)requestAnimationFrame(()=>window.scrollTo(0,0));
