import * as THREE from "three";
import { material, line, tag, addLabelSprite } from "./scene-kit.js?rev=57";

export const PV_STEPS = [
  { title: "光照与跟踪", focus: "tracker", detail: "组件把光能转成直流电。南北向单轴支架绕扭矩管旋转，控制器结合太阳位置及气象信息调整朝向；回溯控制用于减少相邻排遮挡。本动画演示机构运动，不代表现场实时角度。" },
  { title: "组串直流", focus: "tracker", detail: "组件在一串内串联，电压叠加，同串电流近似相同；不同组串接入逆变器的直流输入。运动段由柔性引线接至固定接线点，正、负极电缆形成回路。这里显示代表性组件段，实际串长和输入分组以最终统一设计为准。" },
  { title: "逆变与 MPPT", focus: "inverter", detail: "组串逆变器通过 MPPT 调整工作点以获取适宜的发电功率，并把直流转换为与交流系统匹配的交流电。散热、隔离和保护使设备安全运行；图中设备为通用外形。" },
  { title: "低压交流汇集", focus: "inverter", detail: "各逆变器交流输出沿低压电缆汇集，经开关与保护接入箱变低压侧。橙色流动点表示能量传递方向，不表示实际电流、负载或设备运行状态。" },
  { title: "箱变升压", focus: "block-transformer", detail: "光伏发电单元箱变将低压交流升至 33 kV。附图5-4提供 0.8/33 kV 电压接口依据；低压接线、保护配置与设备容量仍应按对应设计版本确认。" },
  { title: "集电与并网", focus: "ipp", detail: "33 kV 集电线路把发电单元接至 IPP 升压站，主变再由 33 kV 升至 132 kV，经送出回路连接电网。展示压缩了空间距离；送出方向为原理表达，不代表批准线路路径。" }
];

export function createPvPrincipleModel() {
  const root = new THREE.Group();
  root.name = "PV principle demonstration";
  const targets = {
    tracker: new THREE.Vector3(-27, 2.5, 0),
    inverter: new THREE.Vector3(-13, 2, 0),
    "block-transformer": new THREE.Vector3(5, 2, 0),
    ipp: new THREE.Vector3(24, 3, 0)
  };
  const mats = {
    ground: material(0xe6e0d5), concrete: material(0xc7c6bd), white: material(0xeeeee8),
    steel: material(0x738080, .55, .35), dark: material(0x344349), panel: material(0x172f42, .36, .2),
    orange: material(0xd66a25), red: material(0xa35c42), blue: material(0x4c7290), insulator: material(0x899784)
  };
  const boxes = new Map();
  const cylinderGeo = new THREE.CylinderGeometry(1, 1, 1, 10);
  const sphereGeo = new THREE.SphereGeometry(1, 10, 6);
  function cube(parent, size, position, mat) {
    const key = size.join(",");
    if (!boxes.has(key)) boxes.set(key, new THREE.BoxGeometry(...size));
    const mesh = new THREE.Mesh(boxes.get(key), mat);
    mesh.position.set(...position); parent.add(mesh); return mesh;
  }
  function cylinder(parent, radius, height, position, mat, rotation = null) {
    const mesh = new THREE.Mesh(cylinderGeo, mat);
    mesh.scale.set(radius, height, radius); mesh.position.set(...position);
    if (rotation) mesh.rotation.set(...rotation);
    parent.add(mesh); return mesh;
  }
  function beam(parent, from, to, radius = .09, mat = mats.steel) {
    const a = new THREE.Vector3(...from), b = new THREE.Vector3(...to);
    const mesh = cylinder(parent, radius, a.distanceTo(b), a.clone().add(b).multiplyScalar(.5).toArray(), mat);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.sub(a).normalize());
    return mesh;
  }
  function dashed(parent, points, color) {
    const mesh = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points.map(p => new THREE.Vector3(...p))), new THREE.LineDashedMaterial({color, dashSize: .45, gapSize: .3}));
    mesh.computeLineDistances(); parent.add(mesh); return mesh;
  }
  const markers = [];
  function stage(index, position) {
    const group = tag(new THREE.Group(), "pv-principle", PV_STEPS[index].title, PV_STEPS[index].detail);
    group.userData.stepIndex = index; group.userData.focusKey = PV_STEPS[index].focus;
    root.add(group);
    const marker = cube(root, [index === 0 ? 10 : index === 5 ? 18 : 7, .06, index === 0 ? 20 : index === 5 ? 19 : 8], position, mats.orange);
    markers.push(marker); return group;
  }
  function label(text, position, width = 10) {
    const sprite = addLabelSprite(root, text, position, "#fff6e7");
    sprite.scale.set(width, width * .18, 1);
  }
  cube(root, [75, .55, 26], [0, -.32, 0], mats.ground);
  cube(root, [69, .03, 3], [0, .01, 11], mats.concrete);
  for (let x = -33; x < 34; x += 6) cube(root, [2, .02, .1], [x, .04, 11], mats.white);

  const pv = stage(0, [-27, .045, 0]);
  cube(pv, [9.6, .12, 19.6], [-27, .12, 0], mats.concrete);
  for (const z of [-7, -3.5, 0, 3.5, 7]) {
    cylinder(pv, .14, 2.4, [-27, 1.4, z], mats.steel);
    cube(pv, [.65, .28, .6], [-27, .34, z], mats.white);
    cube(pv, [.5, .32, .4], [-27, 2.56, z], mats.dark);
  }
  const tracker = new THREE.Group(); tracker.position.set(-27, 2.8, 0); pv.add(tracker);
  cylinder(tracker, .13, 18.4, [0, 0, 0], mats.steel, [Math.PI / 2, 0, 0]);
  // ponytail: a representative panel section; replace with the approved string arrangement when versions converge.
  for (let i = 0; i < 10; i++) {
    const z = (i - 4.5) * 1.7;
    cube(tracker, [4.7, .1, 1.61], [0, .19, z], mats.white);
    cube(tracker, [4.58, .03, 1.48], [0, .255, z], mats.panel);
    for (const x of [-1.5, 0, 1.5]) cube(tracker, [.018, .012, 1.47], [x, .279, z], mats.steel);
    cube(tracker, [4.8, .12, .09], [0, -.08, z], mats.steel);
  }
  cylinder(pv, .5, .6, [-27, 2.7, 0], mats.dark, [Math.PI / 2, 0, 0]);
  cylinder(pv, .22, 1.1, [-26.36, 2.53, 0], mats.steel, [0, 0, Math.PI / 2]);
  cube(pv, [.85, .95, .35], [-27.5, 1.67, .75], mats.white);
  cube(pv, [.31, .21, .02], [-27.5, 1.85, .94], mats.dark);
  cube(pv, [.5, .34, .4], [-27.13, 2.41, 1], mats.dark);
  line(pv, [[-27.13, 2.24, 1], [-27, 1.7, 1], [-27, 1, 1]], 0xa35c42, 1, .04);
  line(pv, [[-27.13, 2.24, 1.18], [-27, 1.7, 1.3], [-27, .9, 1.3]], 0x344349, 1, .04);
  const flexibleLeads = [0xa35c42, 0x344349].map((color, i) => {
    const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(), new THREE.Vector3(-26.1, 1.75, 1 + i * .18), new THREE.Vector3(-27.13, 2.41, 1 + i * .18));
    const geometry = new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(new Float32Array(17 * 3), 3));
    const mesh = new THREE.Line(geometry, new THREE.LineBasicMaterial({color}));
    mesh.frustumCulled = false; pv.add(mesh); return {curve, geometry, offset: i * .18};
  });
  const weather = new THREE.Group(); pv.add(weather);
  cylinder(weather, .08, 5.2, [-32, 2.7, -8], mats.steel);
  const windRotor = new THREE.Group(); windRotor.position.set(-32, 5.3, -8); weather.add(windRotor);
  for (let i = 0; i < 3; i++) {
    const angle = i * Math.PI * 2 / 3;
    beam(windRotor, [0, 0, 0], [Math.cos(angle) * .7, 0, Math.sin(angle) * .7], .035);
    const cup = new THREE.Mesh(sphereGeo, mats.dark); cup.scale.set(.19, .1, .19);
    cup.position.set(Math.cos(angle) * .7, 0, Math.sin(angle) * .7); windRotor.add(cup);
  }
  cube(weather, [.55, .18, .55], [-32, 4.6, -8], mats.white);
  const sun = new THREE.Mesh(sphereGeo, material(0xe9b05a)); sun.scale.set(.9, .9, .9); pv.add(sun);
  label("跟踪支架 · 代表性组件段", [-27, 6.3, 8], 15);

  const dc = stage(1, [-20, .045, -1.6]);
  line(dc, [[-27, 1, 1], [-24, .48, 1], [-20, .48, 1], [-14, .48, 1], [-14, 1.4, .5]], 0xa35c42, 1, .055);
  line(dc, [[-27, .9, 1.3], [-24, .48, 1.3], [-20, .48, 1.3], [-13.7, .48, 1.3], [-13.7, 1.4, .5]], 0x344349, 1, .055);
  cube(dc, [3.6, .16, .75], [-20, .29, 1.15], mats.concrete);

  const inverter = stage(2, [-13, .045, 0]);
  cube(inverter, [5.5, .22, 5], [-13, .2, 0], mats.concrete);
  for (const x of [-14.2, -11.8]) cylinder(inverter, .09, 2.7, [x, 1.65, -.1], mats.steel);
  cube(inverter, [3.2, 2.15, 1.25], [-13, 2.1, 0], mats.white);
  cube(inverter, [2.8, .14, 1.45], [-13, 3.23, 0], mats.steel);
  cube(inverter, [.5, .3, .03], [-13, 2.6, .65], mats.dark);
  for (const x of [-14, -13, -12]) {
    cylinder(inverter, .31, .09, [x, 1.75, .68], mats.dark, [Math.PI / 2, 0, 0]);
    for (let j = 0; j < 4; j++) cube(inverter, [.025, .51, .03], [x - .15 + j * .1, 1.75, .75], mats.steel);
  }
  for (let i = 0; i < 12; i++) cube(inverter, [.13, 1.9, .35], [-14.38 + i * .25, 2.1, -.77], mats.steel);
  label("组串逆变器 · MPPT / DC→AC", [-13, 5.5, -7], 14);

  const lv = stage(3, [-4, .045, 0]);
  cube(lv, [4.5, .18, 4.5], [-4, .19, 0], mats.concrete);
  cube(lv, [2.2, 2.6, 1.4], [-4, 1.64, 0], mats.white);
  for (const x of [-4.55, -3.45]) {
    cube(lv, [.93, 2.33, .035], [x, 1.65, .73], mats.steel);
    cube(lv, [.09, .25, .07], [x + .26, 1.5, .77], mats.dark);
    cube(lv, [.4, .25, .035], [x, 2.32, .76], mats.dark);
  }
  line(lv, [[-12, .45, 1.6], [-9, .45, 2.1], [-4, .45, 2.1], [-4, 1, .72]], 0x4c7290, 1, .08);
  dashed(lv, [[-9, .55, 6.7], [-6, .55, 6.7], [-4, .55, 5], [-4, .55, 2.1]], 0x687478);
  label("其他逆变器交流来线 · 示意", [-7.5, 2.1, 8.2], 12);
  label("低压交流汇集", [-4, 4.6, 7], 10);

  const transformer = stage(4, [5, .045, 0]);
  cube(transformer, [7, .22, 6.5], [5, .22, 0], mats.concrete);
  cube(transformer, [3.4, 2.8, 2.8], [4.6, 1.78, 0], mats.steel);
  cube(transformer, [1.4, 3.1, 2.8], [7.1, 1.93, 0], mats.white);
  cube(transformer, [5.4, .15, 3.2], [5.3, 3.57, 0], mats.dark);
  for (const side of [-1, 1]) for (let i = 0; i < 10; i++) cube(transformer, [.17, 1.9, .35], [3.1 + i * .3, 1.86, side * 1.56], mats.dark);
  for (const x of [6.72, 7.38]) {
    cube(transformer, [.56, 2.58, .04], [x, 1.9, 1.43], mats.concrete);
    cube(transformer, [.06, .28, .06], [x + .18, 1.85, 1.47], mats.dark);
  }
  line(transformer, [[-3.1, .4, 1.5], [1.1, .4, 1.5], [2.8, .7, 1]], 0x4c7290, 1, .08);
  label("发电单元箱变 · 0.8 / 33 kV", [5, 5.5, -7], 14);

  const ipp = stage(5, [24, .045, 0]);
  cube(ipp, [17.5, .2, 18.5], [24, .2, 0], mats.concrete);
  cube(ipp, [5.3, 3.1, 4], [20, 1.86, 5.7], mats.white);
  cube(ipp, [5.7, .18, 4.4], [20, 3.5, 5.7], mats.steel);
  cube(ipp, [1.1, 2, .06], [19.2, 1.53, 7.73], mats.dark);
  cube(ipp, [2, .9, .08], [21.1, 2.1, 7.73], mats.blue);
  cube(ipp, [5, .18, 4.7], [22, .46, -1.3], mats.white);
  cube(ipp, [3.5, 2.3, 2.5], [22, 1.68, -1.3], mats.steel);
  cylinder(ipp, .48, 3.2, [22, 3.03, -2.1], mats.dark, [0, 0, Math.PI / 2]);
  for (let i = 0; i < 9; i++) {
    cube(ipp, [.17, 2, .7], [20.5 + i * .37, 1.76, .18], mats.steel);
    cube(ipp, [.17, 2, .7], [20.5 + i * .37, 1.76, -2.78], mats.steel);
  }
  for (const x of [21, 22, 23]) for (let r = 0; r < 6; r++) cylinder(ipp, .2, .1, [x, 3 + r * .17, -1.1], mats.insulator);
  for (const z of [-5.5, -2.5, .5]) {
    cylinder(ipp, .15, 2.2, [27, 1.48, z], mats.steel);
    for (let r = 0; r < 8; r++) cylinder(ipp, .22, .09, [27, 2.55 + r * .15, z], mats.insulator);
    beam(ipp, [25, 3.7, z], [29, 3.7, z], .06, mats.dark);
  }
  [-5.5, -2.5, .5].forEach((z, i) => {
    line(ipp, [[21 + i, 3.9, -1.1], [24, 4.3, z], [25, 3.7, z]], 0x60696a, 1, .045);
  });
  for (const z of [-6.2, 1.2]) {
    beam(ipp, [31, .4, z], [31, 7, z], .18);
    beam(ipp, [30.3, .4, z], [31, 7, z], .07);
  }
  beam(ipp, [31, 7, -6.2], [31, 7, 1.2], .2);
  for (const z of [-5.5, -2.5, .5]) {
    for (let r = 0; r < 6; r++) cylinder(ipp, .16, .08, [31, 6.85 - r * .16, z], mats.insulator);
    line(ipp, [[27, 3.7, z], [29, 4.5, z], [31, 5.95, z], [35.5, 5.2, z], [37, 5.6, z]], 0x60696a, 1, .045);
  }
  line(ipp, [[7.8, .5, -1], [12, .5, -1], [16, .5, -1], [20.25, .8, -1]], 0x4c7290, 1, .12);
  cube(ipp, [1.3, 1.6, .8], [17.1, 1.26, 6.3], mats.white);
  cube(ipp, [.85, .4, .04], [17.1, 1.5, 6.72], mats.dark);
  dashed(root, [[-32, 4.6, -8], [-32, .65, -8], [-29, .65, -8], [-29, .65, .75], [-27.5, 1.67, .75]], 0x397b9b);
  dashed(root, [[-27.5, 1.67, .75], [-28, .65, 3.1], [-17, .65, 3.1], [-13, 2.6, .8]], 0x397b9b);
  dashed(root, [[-13, 2.6, .8], [-12, .65, 4.6], [13.2, .65, 4.6], [13.2, .65, 6.3], [17.1, 1.5, 6.3], [18.3, 1.5, 6.3]], 0x397b9b);
  label("IPP · 33 / 132 kV", [24, 8.9, 4.8], 13);
  label("132 kV 送出端", [34, 9.2, -5], 10);
  label("气象 / 跟踪控制", [-31, 6.8, -8], 10);
  label("通信箱 → PV SCADA", [17.5, 4.7, 8.3], 12);

  const flowPoints = [
    [[-28, 7, 0], [-27, 3.2, 0]],
    [[-26.5, .9, 1.1], [-20, .8, 1.1], [-14, .8, 1.1]],
    [[-14, 2, .85], [-12, 2, .85]],
    [[-12, .65, 2.1], [-4, .65, 2.1], [-4, 1, .9]],
    [[-3.1, .65, 1.5], [2, .65, 1.5], [5, 2, 0]],
    [[8, .75, -1], [18.5, .75, -1], [22, 3.5, -1], [27, 4, -2.5], [31, 6.2, -2.5], [37, 5.65, -2.5]]
  ].map(points => new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(...p))));
  const particles = new THREE.InstancedMesh(sphereGeo, mats.orange, 18);
  particles.instanceMatrix.setUsage(THREE.DynamicDrawUsage); particles.frustumCulled = false; root.add(particles);
  const dummy = new THREE.Object3D();
  const leadPoint = new THREE.Vector3();
  let elapsed = 0, stepIndex = 0, stow = false;
  function setStep(index) {
    stepIndex = Math.max(0, Math.min(PV_STEPS.length - 1, Math.trunc(index) || 0));
    markers.forEach((marker, i) => { marker.visible = i === stepIndex; });
  }
  function update(deltaSeconds) {
    const delta = Number.isFinite(deltaSeconds) ? Math.max(0, Math.min(deltaSeconds, .1)) : 0;
    elapsed += delta;
    const targetAngle = stow ? 0 : Math.sin(elapsed * .17) * .6;
    tracker.rotation.z = THREE.MathUtils.damp(tracker.rotation.z, targetAngle, 2.5, delta);
    flexibleLeads.forEach(({curve, geometry, offset}) => {
      curve.v0.set(-27 + 1.8 * Math.cos(tracker.rotation.z) + .08 * Math.sin(tracker.rotation.z), 2.8 + 1.8 * Math.sin(tracker.rotation.z) - .08 * Math.cos(tracker.rotation.z), 1 + offset);
      for (let i = 0; i < 17; i++) {
        curve.getPoint(i / 16, leadPoint);
        geometry.attributes.position.setXYZ(i, leadPoint.x, leadPoint.y, leadPoint.z);
      }
      geometry.attributes.position.needsUpdate = true;
    });
    windRotor.rotation.y += delta * 1.8;
    sun.position.set(-27 + Math.sin(elapsed * .17) * 8, 10 + Math.cos(elapsed * .17) * 2, -2);
    flowPoints.forEach((curve, i) => {
      for (let j = 0; j < 3; j++) {
        dummy.position.copy(curve.getPoint((elapsed * .2 + j / 3) % 1));
        dummy.scale.setScalar(i === stepIndex ? .2 : .09);
        dummy.updateMatrix(); particles.setMatrixAt(i * 3 + j, dummy.matrix);
      }
    });
    particles.instanceMatrix.needsUpdate = true;
  }
  setStep(0); update(0);
  return { root, targets, setStep, setStow(value) { stow = Boolean(value); }, update };
}
