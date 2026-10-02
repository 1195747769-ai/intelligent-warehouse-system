// Node-only checks of actual routing, PV controls and camera framing; no browser.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const root=new URL('../static/showcase/',import.meta.url);
const read=path=>readFileSync(new URL(path,root),'utf8');
const html=read('index.html');
const css=read('assets/css/showcase.css');
assert.equal(css.split('{').length,css.split('}').length,'style blocks must be balanced');
const tokens=readFileSync(new URL('../tokens.css',root),'utf8');
const defined=new Set([...(tokens+css).matchAll(/(--[\w-]+)\s*:/g)].map(match=>match[1]));
for(const [,name] of css.matchAll(/var\((--[\w-]+)/g))assert.ok(defined.has(name),'undefined style token '+name);
const folio=css.slice(css.indexOf('/* Hallmark · engineering project folio'));
assert.ok(!/:\s*(?:#[0-9a-fA-F]{3,8}\b|rgba?\(|oklch\()/.test(folio),'new design must use the shared palette');
assert.match(css,/html,body\{overflow-x:clip\}/);
assert.match(folio,/\.project-map-stage img\{[^}]*object-fit:contain/,'the original plan must remain uncropped');
assert.match(folio,/@media\(max-width:500px\)\{\.project-explore\{grid-template-columns:minmax\(0,1fr\)/);
assert.match(folio,/@media\(max-width:760px\)/);
const explore=html.match(/<nav class="project-explore"[^>]*>([\s\S]*?)<\/nav>/)[1];
assert.deepEqual([...explore.matchAll(/href="([^"]+)"/g)].map(match=>match[1]),['#pv','#overview','#transmission']);
const gallery=html.match(/<div class="project-system-gallery">([\s\S]*?)<\/section>/)[1];
assert.deepEqual([...gallery.matchAll(/class="project-chapter-link" href="([^"]+)"/g)].map(match=>match[1]),['#pv','#overview','#transmission']);
for(const asset of ['pv-plan-preview.svg','campus-plan-preview.svg']){
  assert.ok(gallery.includes(`./assets/${asset}`));
  assert.match(read('assets/'+asset),/<title[^>]*>[^<]+<\/title>/);
}
assert.match(gallery,/grid-preview-desc[\s\S]+不指定母线分配/);
assert.match(gallery,/设备点位为示意，不代表基础尺寸或采购数量/);
assert.ok(gallery.indexOf('class="grid-preview-collector"')<gallery.indexOf('class="grid-preview-bus"'),'bus symbol must be painted over its station background');
assert.match(folio,/@media\(max-width:960px\)\{\.project-system-gallery\{grid-template-columns:minmax\(0,1fr\)/);
assert.match(folio,/\.project-section-heading,\.project-chapter--pv,\.project-connection\{grid-template-columns:minmax\(0,1fr\)/);
assert.ok(html.indexOf('class="project-map"')<html.indexOf('class="project-metrics"'));
assert.ok(html.indexOf('class="project-concept"')<html.indexOf('class="project-map"'),'concept introduction must precede the expandable engineering plan');
assert.match(html,/<details class="site-plan-reference project-plan-reference">/);
assert.match(html,/project-concept.png[^>]+width="1672"[^>]+height="941"[^>]+fetchpriority="high"/);
assert.match(html,/规划示意 · 非现场照片/);
assert.match(html,/现有线路展示约 25 km[\s\S]*?约 36 km[\s\S]*?待业主\/Eskom书面统一确认/);
assert.ok(readFileSync(new URL('assets/project-concept.png',root)).length>1000);
assert.ok(readFileSync(new URL('assets/Baphalane_Phase_I_Project_Introduction_EN.pdf',root)).subarray(0,5).equals(Buffer.from('%PDF-')));
assert.match(html,/<section class="project-warehouse"[^>]*>[\s\S]*?href="\/warehouse"/);
assert.match(html,/<section id="project" class="view is-active"[^>]*>/);
assert.match(html,/<section id="pv"[^>]* hidden>/);
assert.match(html,/<section id="overview"[^>]* hidden>/);
assert.match(html,/href="#project" aria-label="返回项目介绍首页"/);
assert.ok(html.indexOf('id="site-inspector"')>html.indexOf('data-error="site"'),'equipment explanation should follow the 3D frame');
assert.equal((html.match(/class="view-continuation"/g)||[]).length,3);
assert.equal((html.match(/class="view-breadcrumb"/g)||[]).length,3);
assert.match(html,/<details class="site-plan-reference">/);
assert.match(html,/bess-plan-reference.png\?rev=1[^>]+loading="lazy"/);
const lineInspector=html.slice(html.indexOf('id="line-inspector"'));
assert.match(lineInspector,/<p class="route-disclaimer">[^<]+<\/p>\s*<details class="source-notes">/);
assert.match(lineInspector,/<p class="source-disclaimer">[^<]+19 km \+ 17 km/,'fixed source warning must remain separate from the live explanation');
const element=()=>({hidden:false,dataset:{},style:{},textContent:'',clientWidth:1040,clientHeight:460,
  classList:{toggle(){}},attrs:{},events:{},setAttribute(k,v){this.attrs[k]=v;},getAttribute(k){return this.attrs[k];},
  removeAttribute(k){delete this.attrs[k];},addEventListener(k,fn){this.events[k]=fn;},focus(){this.focused=true;}});
// Exercise default, explicit deep links, bad links, history and nav through app.js.
for(const hash of ['', '#project', '#pv', '#overview', '#transmission', '#bad']){
  const nodes=new Map(),get=id=>{if(!nodes.has(id))nodes.set(id,element());return nodes.get(id);};
  const nav=['project','pv','overview','transmission'].map(id=>Object.assign(element(),{dataset:{viewTarget:id}}));
  const resets=['site','pv','line'].map(resetScene=>Object.assign(element(),{dataset:{resetScene}}));
  for(const name of ['project','pv','overview','transmission'])get(name).attrs['aria-labelledby']=name+'-title';
  const listeners={},documentEvents={},document={hidden:false,body:{dataset:{}},getElementById:get,addEventListener(type,fn){(documentEvents[type]??=[]).push(fn);},
    querySelector:get,querySelectorAll:selector=>selector==='[data-view-target]'?nav:selector==='[data-reset-scene]'?resets:[]};
  let resetCount=0;const focused=[];
  const scene=()=>({scene:{userData:{reset(){resetCount++;}}},camera:{updateProjectionMatrix(){}},renderer:{domElement:element(),setSize(){}},controls:{addEventListener(){}}});
  const loads=[];
  const context=vm.createContext({document,location:{hash,search:''},URLSearchParams,console,
    loadModule(path){loads.push(path);return Promise.resolve({createSiteScene:scene,createPvScene:scene,createLineScene:scene});},requestAnimationFrame(){return 1;},
    CustomEvent:class{constructor(type,{detail}){this.type=type;this.detail=detail;}},
    history:{pushState(_a,_b,h){context.location.hash=h;}},window:{addEventListener(k,fn){listeners[k]=fn;},dispatchEvent(event){focused.push(event);},scrollTo(){}}});
  vm.runInContext(read('assets/js/app.js').replace(/import\("([^"]+)"\)/g,'loadModule("$1")'),context);
  const expected=['#pv','#overview','#transmission'].includes(hash)?hash.slice(1):'project';
  assert.equal(document.body.dataset.activeView,expected);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(loads.length,expected==='project'?0:1,'project introduction must not load 3D');
  nav.find(button=>button.dataset.viewTarget==='overview').events.click();assert.equal(document.body.dataset.activeView,'overview');
  assert.ok(get('overview-title').focused,'navigation should focus the new heading');
  const link={getAttribute:key=>key==='href'?'#pv':null,hasAttribute:()=>false};
  let prevented=false;
  const click={button:0,target:{closest:selector=>selector==='a[href^="#"]'?link:null},preventDefault(){prevented=true;}};
  documentEvents.click.forEach(fn=>fn(click));
  assert.equal(prevented,true);assert.equal(document.body.dataset.activeView,'pv');assert.equal(context.location.hash,'#pv');
  assert.equal(get('pv-title').attrs.tabindex,'-1');assert.ok(get('pv-title').focused);
  prevented=false;documentEvents.click.forEach(fn=>fn({...click,ctrlKey:true}));assert.equal(prevented,false,'modified link clicks must retain native browser behavior');
  context.location.hash='';listeners.popstate();assert.equal(document.body.dataset.activeView,'project');
  await new Promise(resolve=>setImmediate(resolve));
  for(const [i,name] of ['overview','pv','transmission'].entries()){
    nav.find(button=>button.dataset.viewTarget===name).events.click();
    await new Promise(resolve=>setImmediate(resolve));
    resets[i].events.click();
    assert.equal(resetCount,i+1);
    assert.equal(focused.at(-1).type,'baphalane-arrival-focus');
    assert.equal(focused.at(-1).detail.keys.length,0,'manual reset must clear stale arrival selection in every scene');
  }
}
const threeURL=new URL('vendor/three.module.js',root).href;
const THREE=await import(threeURL);
globalThis.document={createElement:()=>({getContext:()=>({fillRect(){},strokeRect(){},fillText(){}})})};
const moduleURL=source=>'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
const kitURL=moduleURL(read('assets/js/scene-kit.js').replace(/from "three"/,`from '${threeURL}'`));
const {createPvPrincipleModel}=await import(moduleURL(read('assets/js/pv-principle-model.js')
  .replace(/from "three"/,`from '${threeURL}'`).replace(/from "\.\/scene-kit\.js\?rev=57"/,`from '${kitURL}'`)));
const pvSource=read('assets/js/pv-model.js').replace(/^import .*;\r?\n/gm,'').replace('export async function','async function');
const PV_STEPS=(await import(moduleURL(read('assets/js/pv-principle-model.js')
  .replace(/from "three"/,`from '${threeURL}'`).replace(/from "\.\/scene-kit\.js\?rev=57"/,`from '${kitURL}'`)))).PV_STEPS;
class Controls{constructor(camera){this.camera=camera;this.target=new THREE.Vector3();}addEventListener(){}update(){this.camera.lookAt(this.target);this.camera.updateMatrixWorld();}}
for(const [width,height] of [[1040,460],[520,450],[350,300]]){
  const nodes=new Map(),get=selector=>{if(!nodes.has(selector))nodes.set(selector,element());return nodes.get(selector);};
  const buttons=[...html.matchAll(/<button\b[^>]*data-pv-[^>]*>/g)].map(match=>{
    const node=element();for(const [,k,v] of match[0].matchAll(/(data-pv-[\w-]+)="([^"]*)"/g))node.dataset[k.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=v;
    const key=match[0].match(/data-pv-[\w-]+/)[0];node.key=key;nodes.set(`[${key}]`,node);return node;
  });
  const page={dataset:{},querySelector:get,querySelectorAll:selector=>buttons.filter(b=>selector.split(',').some(s=>b.key===s.trim().slice(1,-1)))};
  const inspector={querySelector:get},container=Object.assign(element(),{clientWidth:width,clientHeight:height});
  const model=createPvPrincipleModel();
  const create=new Function('THREE','OrbitControls','makeRenderer','addLights','createPvSurface','createPvPrincipleModel','PV_STEPS','document','window','matchMedia','fetch','addLabelSprite',pvSource+';return createPvScene;')(
    {...THREE,TextureLoader:class{async loadAsync(){return new THREE.Texture();}}},Controls,
    ()=>({domElement:element(),shadowMap:{},capabilities:{getMaxAnisotropy:()=>1}}),()=>{},()=>new THREE.Group(),()=>model,PV_STEPS,
    {getElementById:()=>page},{dispatchEvent(){}},()=>({matches:true}),async()=>({ok:true,json:async()=>({pvCrop:[0,0,100,100]})}),()=>{});
  globalThis.CustomEvent=class{};
  const instance=await create(container,inspector);
  instance.camera.updateMatrixWorld();
  const bounds=new THREE.Box3().setFromObject(model.root);
  for(const x of [bounds.min.x,bounds.max.x])for(const y of [bounds.min.y,bounds.max.y])for(const z of [bounds.min.z,bounds.max.z]){
    const point=new THREE.Vector3(x,y,z).project(instance.camera);
    assert.ok(Math.abs(point.x)<1&&Math.abs(point.y)<1,`model clipped at ${width} x ${height}`);
  }
  assert.ok(instance.camera.position.clone().sub(instance.controls.target).normalize().y<.5,'home elevation should stay low');
  for(const button of buttons.filter(b=>b.key==='data-pv-step')){button.events.click();assert.equal(get('h3').textContent,PV_STEPS[Number(button.dataset.pvStep)].title);}
  get('[data-pv-next]').events.click();assert.equal(get('h3').textContent,PV_STEPS[0].title);
  get('[data-pv-stow]').events.click();assert.equal(get('h3').textContent,'大风收拢动作演示');
  await buttons.find(b=>b.dataset.pvMode==='layout').events.click();
  assert.equal(page.dataset.pvMode,'layout');assert.equal(get('.pv-demo-toolbar').hidden,true);assert.equal(get('.pv-demo-actions').hidden,true);assert.equal(get('[data-pv-stow]').hidden,true);
  await buttons.find(b=>b.dataset.pvMode==='principle').events.click();
  assert.equal(page.dataset.pvMode,'principle');assert.equal(get('.pv-demo-actions').hidden,false);
}
console.log('PASS: project home without 3D loading, all deep links/history, source notes, six steps, stow/layout and camera framing.');
