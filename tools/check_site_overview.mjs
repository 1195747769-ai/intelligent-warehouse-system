// Run: node tools/check_site_overview.mjs. Checks camera math without a browser.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const root=new URL('../static/showcase/',import.meta.url);
const threeURL=new URL('vendor/three.module.js',root).href;
const THREE=await import(threeURL);
const moduleFrom=async path=>import('data:text/javascript;base64,'+Buffer.from(readFileSync(new URL(path,root),'utf8').replace(/from (["'])three\1/g,`from '${threeURL}'`)).toString('base64'));
const {OrbitControls}=await moduleFrom('vendor/three-addons/controls/OrbitControls.js');
const {attachSiteInteractions}=await moduleFrom('assets/js/site-interactions.js');
const model=readFileSync(new URL('assets/js/site-model.js',root),'utf8');
const setup=model.slice(model.indexOf('  const aspect = container.clientWidth'),model.indexOf('  const renderer = makeRenderer(container);'));
const create=new Function('THREE','container',setup+'return {camera,initialTarget,overviewOffset};');
globalThis.document={querySelector:()=>null,querySelectorAll:()=>[]};
globalThis.window={clearTimeout(){}};
for(const [width,height] of [[1308,512],[768,440],[355,300]]){
  const {camera,initialTarget,overviewOffset}=create(THREE,{clientWidth:width,clientHeight:height});
  const direction=camera.position.clone().sub(initialTarget).normalize();
  assert.ok(direction.distanceTo(overviewOffset.clone().normalize())<1e-12);
  if(width===1308)assert.ok(camera.position.distanceTo(new THREE.Vector3(21.7,12.2,22.5))<1e-12);
  const position=camera.position.clone();
  const controls=new OrbitControls(camera);controls.target.copy(initialTarget);controls.enableDamping=true;controls.update();
  const inspector={hidden:false};
  const interactions=attachSiteInteractions({camera,controls,renderer:{domElement:{addEventListener(){}}},pickTargets:new THREE.Group(),inspector,cameraTargets:[],initialCameraPosition:position,initialTarget});
  camera.position.set(50,20,60);camera.zoom=2;
  controls.target.set(3,2,1);controls._sphericalDelta.set(0,0.2,0.4);
  interactions.reset();
  for(let i=0;i<20;i++)controls.update();
  assert.ok(camera.position.distanceTo(position)<1e-9,'reset must not drift from pending rotation');
  assert.ok(controls.target.distanceTo(initialTarget)<1e-12);
  assert.equal(camera.zoom,1);assert.equal(controls.enableDamping,true);assert.equal(inspector.hidden,true);
}
console.log('PASS: screenshot overview scale, consistent elevation and stable reset after dragging');
// Exercise the real tour button: camera focus, arrival selection and stop.
const events={},focusEvents=[],timers=[];
const tourButton={textContent:'',addEventListener(type,fn){events[type]=fn;},setAttribute(){}};
globalThis.document={querySelector:()=>tourButton,querySelectorAll:()=>[]};
globalThis.CustomEvent=class{constructor(type,{detail}){this.type=type;this.detail=detail;}};
globalThis.window={dispatchEvent:event=>focusEvents.push(event.detail),clearTimeout(){},setTimeout(fn){timers.push(fn);return timers.length;}};
globalThis.requestAnimationFrame=()=>0;
const fields={h3:{},p:{}},inspector={hidden:true,querySelector:selector=>fields[selector]};
const camera=new THREE.PerspectiveCamera(),controls={target:new THREE.Vector3(),addEventListener(){},update(){}};
camera.position.set(10,10,10);
const cameraTargets=['bess','switchyard'].map((key,i)=>({key,distance:10,target:new THREE.Vector3(i,0,0),object:{userData:{title:key,detail:key+' detail'}}}));
attachSiteInteractions({camera,controls,renderer:{domElement:{addEventListener(){}}},pickTargets:new THREE.Group(),inspector,cameraTargets,initialCameraPosition:camera.position.clone(),initialTarget:controls.target.clone()});
try{events.click();}catch(error){console.error('FAIL: site tour startup:',error.message);process.exit(1);}
assert.equal(tourButton.textContent,'停止巡览');assert.equal(fields.h3.textContent,'bess');assert.deepEqual(focusEvents.at(-1).keys,['bess-cabinet','pcs']);
timers[0]();assert.equal(fields.h3.textContent,'switchyard');assert.deepEqual(focusEvents.at(-1).keys,['main-transformer']);
events.click();assert.equal(tourButton.textContent,'自动巡览');
console.log('PASS: site tour starts, changes arrival selection with camera focus, and stops.');

const campus=JSON.parse(readFileSync(new URL('assets/bess-campus-layout.json',root),'utf8'));
const ground=JSON.parse(readFileSync(new URL('assets/bess-ground-boundary.json',root),'utf8'));
const [scale,x,y]=campus.bessTransform;
assert.ok(campus.registrationErrorPoints<0.1);
ground.points.forEach(([a,b],i)=>assert.ok(Math.hypot(a*scale+x-campus.bessBoundary[i][0],b*scale+y-campus.bessBoundary[i][1])<0.1));
assert.equal(campus.aisles.length,3);
assert.equal(campus.stationBoundary.length,5);
assert.ok(!model.includes('sharedPerimeter'));
assert.ok(model.includes('detailPose.rotation.y = equipmentAngle'));
console.log('PASS: six source vertices register within 0.1 PDF point; three real aisles and no invented perimeter');

// Construct the actual scene geometry without opening or automating a browser.
const context={fillRect(){},strokeRect(){},fillText(){}};
globalThis.document={createElement:()=>({getContext:()=>context}),querySelector:()=>null,querySelectorAll:()=>[]};
const fetchAsset=async url=>({ok:true,json:async()=>JSON.parse(readFileSync(new URL(url.split('?')[0],root),'utf8'))});
const tag=(object,kind,title,detail)=>{Object.assign(object.userData,{kind,title,detail});return object;};
class Controls{constructor(camera){this.camera=camera;this.target=new THREE.Vector3();}update(){this.camera.lookAt(this.target);this.camera.updateMatrixWorld();}}
const factory=new Function('THREE','OrbitControls','makeRenderer','tag','attachSiteInteractions','fetch',model.replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'')+'\nreturn createSiteScene;');
let stopped=0;
const sceneFactory=factory(THREE,Controls,()=>({shadowMap:{},domElement:{}}),tag,({camera,controls,initialCameraPosition,initialTarget})=>({bindInteriorToggle(){},stopTour(){stopped++;},reset(){camera.position.copy(initialCameraPosition);controls.target.copy(initialTarget);controls.update();}}),fetchAsset);
const built=await sceneFactory({clientWidth:1308,clientHeight:512},{hidden:true});
built.scene.updateMatrixWorld(true);
let instances=0;
built.scene.traverse(object=>{if(object.isInstancedMesh){instances+=object.count;const bounds=new THREE.Box3().setFromObject(object);assert.ok([bounds.min.x,bounds.max.x,bounds.min.z,bounds.max.z].every(Number.isFinite));}});
assert.ok(instances>500);
console.log('PASS: actual scene constructs with finite equipment geometry and pick proxies');
const yardGround=built.scene.getObjectByName('储能配套展示地面');
assert.ok(yardGround.geometry.parameters.width<15 && yardGround.geometry.parameters.height<25);
assert.equal(built.scene.getObjectByName('储能场坪围栏（展示示意）'),undefined);
const perimeterFence=built.scene.getObjectByName('总平面粉色FENCE围栏（局部）');
assert.ok(perimeterFence.children.length>30,'source perimeter fence must be visible 3D geometry');
const fenceBounds=new THREE.Box3().setFromObject(perimeterFence);
assert.ok(fenceBounds.max.y>0.5 && fenceBounds.max.y<0.7);
const [ga,gb]=[campus.fencePolyline[2],campus.fencePolyline[3]];
assert.ok(Math.abs(ga[0]-444.66)<0.01 && Math.abs(gb[0]-444.66)<0.01);
assert.ok(Math.abs(ga[1]-854.38)<0.01 && Math.abs(gb[1]-1109.56)<0.01);
const gate=ga.map((v,i)=>v+(gb[i]-v)*campus.fenceGate.t);
assert.ok(Math.abs(gate[1]-954)<0.01,'western gate must align with the road crossing');
const approachBounds=new THREE.Box3().setFromObject(built.scene.getObjectByName('西侧来路接入（沿图面路廊）'));
const gateWorld=new THREE.Vector3((gate[0]-475)*0.08,0.045,(gate[1]-952.5)*0.08);
assert.ok(approachBounds.min.x<gateWorld.x && approachBounds.max.x>gateWorld.x,'road must cross the actual outer fence, including the cropped approach');
assert.ok(model.includes('closed: false'),'the source fence continues outside this local view');
built.camera.lookAt(new THREE.Vector3(2.9,0,1.5));built.camera.updateMatrixWorld(true);
for(const [px,py] of campus.fencePolyline){
  const point=new THREE.Vector3((px-475)*0.08,0.64,(py-952.5)*0.08).project(built.camera);
  assert.ok(Math.abs(point.x)<1 && Math.abs(point.y)<1,'source fence must fit in the overview');
}
console.log('PASS: legend FENCE coordinates, compact ground, western road entrance and no invented closure');
const originalPosition=built.camera.position.clone();
for(const [width,height] of [[355,300],[768,440],[1308,512]]){
  built.camera.aspect=width/height;built.camera.updateProjectionMatrix();built.onResize();
  for(const [px,py] of campus.fencePolyline){
    const point=new THREE.Vector3((px-475)*0.08,0.64,(py-952.5)*0.08).project(built.camera);
    assert.ok(Math.abs(point.x)<1&&Math.abs(point.y)<1,'live resizing must keep the overview fence in frame');
  }
}
assert.ok(built.camera.position.distanceTo(originalPosition)<1e-9,'returning to the original width must not accumulate zoom');
const stopCount=stopped;built.onResize();assert.equal(stopped,stopCount,'unchanged size must not stop an active tour');
built.controls.target.set(1,.5,2);built.camera.position.set(6,7,10);
const direction=built.camera.position.clone().sub(built.controls.target).normalize();
built.camera.aspect=355/300;built.onResize();
assert.ok(built.camera.position.clone().sub(built.controls.target).normalize().distanceTo(direction)<1e-12,'resize must preserve the user rotation');
assert.deepEqual(built.controls.target.toArray(),[1,.5,2],'resize must preserve the selected equipment target');
built.scene.userData.reset();const resetPosition=built.camera.position.clone();built.onResize();
assert.ok(built.camera.position.distanceTo(resetPosition)<1e-12,'reset and resize must share the same scale');
console.log('PASS: live narrow/wide framing, stable zoom, unchanged-size tour, user rotation and reset scale.');
