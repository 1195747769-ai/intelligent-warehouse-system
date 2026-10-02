import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { makeRenderer } from "./scene-kit.js?rev=57";

function addBox(parent, size, position, material) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
  mesh.position.set(...position);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

const LINE_PHASE_OFFSETS = [-2.05, 0, 2.05];

function stationFootprint(stationId) {
  if (stationId === "baphalane") return [9.2, 6.5];
  if (stationId === "manama") return [8.2, 6.0];
  return [10.2, 7.0];
}

function stationEdgeDistance(station, outward) {
  const [width, depth] = stationFootprint(station.id);
  const xEdge = Math.abs(outward.x) < 1e-4 ? Infinity : width / 2 / Math.abs(outward.x);
  const zEdge = Math.abs(outward.z) < 1e-4 ? Infinity : depth / 2 / Math.abs(outward.z);
  return Math.min(xEdge, zEdge);
}

function addRodBetween(scene, start, end, material, radius = 0.035) {
  const rod = new THREE.Mesh(
    new THREE.TubeGeometry(new THREE.LineCurve3(start, end), 1, radius, 6, false),
    material
  );
  rod.castShadow = false;
  rod.receiveShadow = false;
  scene.add(rod);
  return rod;
}

function addLabel(scene, text, position, width = 8, accent = "#e47c32") {
  const canvas = document.createElement("canvas");
  canvas.width = 720;
  canvas.height = 110;
  const context = canvas.getContext("2d");
  context.fillStyle = "rgba(250,251,249,.97)";
  context.fillRect(4, 4, 712, 102);
  context.strokeStyle = accent;
  context.lineWidth = 5;
  context.strokeRect(6, 6, 708, 98);
  context.fillStyle = accent;
  context.fillRect(7, 7, 12, 96);
  context.fillStyle = "#27312e";
  context.font = "600 34px Arial, Microsoft YaHei, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(text, 370, 55, 650);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }));
  const height = width * canvas.height / canvas.width;
  sprite.scale.set(width, height, 1);
  sprite.position.set(...position);
  sprite.onBeforeRender = (_renderer, _scene, camera) => {
    const factor = THREE.MathUtils.clamp(camera.position.distanceTo(sprite.position) / 75, 0.52, 1.08);
    sprite.scale.set(width * factor, height * factor, 1);
  };
  scene.add(sprite);
  return sprite;
}

function addCrossingMarker(scene, crossing, point) {
  const marker = new THREE.Group();
  marker.position.copy(point);
  marker.userData = {
    pickable: true,
    crossingId: crossing.id,
    title: crossing.title,
    detail: `${crossing.location}。${crossing.detail}`
  };
  const mast = new THREE.Mesh(
    new THREE.CylinderGeometry(0.035, 0.045, 0.76, 6),
    new THREE.MeshStandardMaterial({ color: 0x71817d, roughness: 0.66, metalness: 0.18 })
  );
  mast.position.y = 0.4;
  marker.add(mast);

  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext("2d");
  context.beginPath();
  context.arc(64, 64, 56, 0, Math.PI * 2);
  context.fillStyle = "#fffaf4";
  context.fill();
  context.lineWidth = 8;
  context.strokeStyle = "#e47c32";
  context.stroke();
  context.fillStyle = "#27312e";
  context.font = "700 64px Arial, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(crossing.id, 64, 68);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const badge = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }));
  badge.scale.set(0.9, 0.9, 1);
  badge.position.y = 1.36;
  marker.add(badge);
  scene.add(marker);
  return marker;
}

function addTower(scene, position, rotation, mats) {
  const group = new THREE.Group();
  group.position.copy(position);
  group.rotation.y = rotation;
  group.userData = {
    pickable: true,
    title: "132 kV 典型格构塔 · 展示示意",
    detail: "用于识别架空线路结构的通用展示模型。当前资料未冻结塔型、回路布置、导线型号及杆塔坐标；不得作为批准设计或施工放样依据。"
  };
  const points = [];
  const segment = (a, b) => points.push(...a, ...b);
  const height = 7.15;
  const lower = 1.16;
  const top = 0.28;
  for (const z of [-0.28, 0.28]) {
    segment([-lower, 0.12, z], [-top, height - 0.34, z * 0.38]);
    segment([lower, 0.12, z], [top, height - 0.34, z * 0.38]);
    segment([-lower, 0.12, z], [lower, 0.12, z]);
  }
  for (const y of [0.95, 2.05, 3.15, 4.25, 5.1]) {
    const t = y / height;
    const half = lower + (top - lower) * t;
    for (const z of [-0.28, 0.28]) {
      segment([-half, y, z], [half, y, z]);
      segment([-half, y, z], [half, y + 0.78, z]);
      segment([half, y, z], [-half, y + 0.78, z]);
    }
    segment([-half, y, -0.28], [-half, y, 0.28]);
    segment([half, y, -0.28], [half, y, 0.28]);
  }
  for (const y of [1.15, 2.25, 3.35, 4.45]) {
    segment([-lower + 0.12, y, -0.28], [-lower + 0.12, y + 0.72, 0.28]);
    segment([lower - 0.12, y, -0.28], [lower - 0.12, y + 0.72, 0.28]);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
  const lattice = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: 0x65736f, transparent: true, opacity: 0.9 }));
  group.add(lattice);
  const crossarmY = 5.62;
  const arm = 2.6;
  segment([-arm, crossarmY, 0], [arm, crossarmY, 0]);
  segment([-arm, crossarmY, 0], [-0.18, height - 0.24, 0]);
  segment([arm, crossarmY, 0], [0.18, height - 0.24, 0]);
  const crossarmGeometry = new THREE.BufferGeometry();
  crossarmGeometry.setAttribute("position", new THREE.Float32BufferAttribute(points.slice(-18), 3));
  const crossarm = new THREE.LineSegments(crossarmGeometry, lattice.material);
  group.add(crossarm);
  const shieldArm = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.08, 0.08), mats.steel);
  shieldArm.position.set(0, height - 0.18, 0);
  group.add(shieldArm);
  for (const x of [-2.05, 0, 2.05]) {
    const string = new THREE.Group();
    for (let disc = 0; disc < 4; disc++) {
      const insulator = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.035, 8), mats.porcelain);
      insulator.position.y = -disc * 0.085;
      string.add(insulator);
    }
    string.position.set(x, crossarmY - 0.02, 0);
    group.add(string);
    const clamp = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.07, 0.1), mats.steel);
    clamp.position.set(x, 5.22, 0);
    group.add(clamp);
  }
  for (const x of [-lower, lower]) {
    for (const z of [-0.28, 0.28]) {
      addBox(group, [0.34, 0.12, 0.32], [x, 0.08, z], mats.concrete);
    }
  }
  scene.add(group);
  return {
    group,
    phases: [-2.05, 0, 2.05].map(x => group.localToWorld(new THREE.Vector3(x, 5.17, 0))),
    shield: group.localToWorld(new THREE.Vector3(0, height + 0.02, 0))
  };
}

function addWireSpan(scene, start, end, sag, material, radius = 0.017) {
  const middle = start.clone().lerp(end, 0.5);
  middle.y -= sag;
  const curve = new THREE.QuadraticBezierCurve3(start, middle, end);
  const wire = new THREE.Mesh(new THREE.TubeGeometry(curve, 24, radius, 5, false), material);
  wire.castShadow = false;
  wire.receiveShadow = false;
  scene.add(wire);
}

function addLinePortal(scene, station, outward, routeTangent, mats, feederLabel) {
  const edgeDistance = stationEdgeDistance(station, outward);
  const position = station.position.clone().addScaledVector(outward, edgeDistance + 0.42);
  const rotationY = Math.atan2(routeTangent.x, routeTangent.z);
  const group = new THREE.Group();
  group.position.copy(position);
  group.rotation.y = rotationY;
  group.userData = {
    pickable: true,
    stationId: station.id,
    title: `${station.shortName} · ${feederLabel}`,
    detail: "站端出线架与相导线接头按单线图关系作识别性示意；空间位置、跨距和间隔布置不代表批准 GA 或施工设计。"
  };

  const postWidth = 0.16;
  for (const x of [-2.36, 2.36]) {
    addBox(group, [postWidth, 5.45, postWidth], [x, 2.72, 0], mats.steel);
  }
  addBox(group, [5.05, 0.16, 0.18], [0, 5.42, 0], mats.steel);
  addBox(group, [0.18, 1.15, 0.18], [0, 6.04, 0], mats.steel);
  for (const x of LINE_PHASE_OFFSETS) {
    const insulator = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.09, 0.43, 8), mats.porcelain);
    insulator.position.set(x, 5.19, 0);
    group.add(insulator);
    addBox(group, [0.16, 0.075, 0.12], [x, 4.96, 0], mats.steel);
  }
  scene.add(group);
  group.updateMatrixWorld(true);
  const phases = LINE_PHASE_OFFSETS.map(x => group.localToWorld(new THREE.Vector3(x, 4.92, 0)));
  const shield = group.localToWorld(new THREE.Vector3(0, 6.68, 0));
  return { group, station, position, outward, routeTangent, rotationY, edgeDistance, phases, shield, feederLabel };
}

function addFeederBay(scene, portal, mats, label) {
  const { station, outward, edgeDistance, rotationY } = portal;
  const group = new THREE.Group();
  group.position.copy(station.position).addScaledVector(outward, Math.max(0.35, edgeDistance - 0.82));
  group.rotation.y = rotationY;
  group.userData = {
    pickable: true,
    stationId: station.id,
    title: label,
    detail: "三相线路经站端出线架进入对应 132 kV 馈线间隔；断路器、隔离及母线关系作概念表达，物理间隔位置非比例。"
  };
  addBox(group, [4.7, 0.14, 1.55], [0, 0.08, 0], mats.concrete);
  const taps = [];
  LINE_PHASE_OFFSETS.forEach((x, phase) => {
    addBox(group, [0.13, 1.5, 0.13], [x, 0.88, 0.15], mats.steel);
    const insulator = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.095, 0.5, 8), mats.porcelain);
    insulator.position.set(x, 1.92, 0.15);
    group.add(insulator);
    addBox(group, [0.42, 0.42, 0.46], [x, 0.48, 0.5], mats.equipment);
    addBox(group, [0.28, 0.08, 0.12], [x, 2.28, 0.15], mats.steel);
    taps.push(new THREE.Vector3(x, 3.18, 0.15));
  });
  scene.add(group);
  group.updateMatrixWorld(true);
  const worldTaps = taps.map(point => group.localToWorld(point));
  portal.phases.forEach((phasePoint, index) => addWireSpan(scene, phasePoint, worldTaps[index], 0.05, mats.conductor, 0.023));
  return { group, station, label, taps: worldTaps };
}

function addManamaDoubleBus(scene, station, mats) {
  const center = station.position;
  const buses = [-0.96, 0.96].map((busOffset, busIndex) => {
    const phaseZ = [-0.28, 0, 0.28].map(offset => busOffset + offset);
    for (const z of phaseZ) {
      const start = center.clone().add(new THREE.Vector3(-2.75, 3.42, z));
      const end = center.clone().add(new THREE.Vector3(2.75, 3.42, z));
      addRodBetween(scene, start, end, mats.conductor, 0.026);
      for (const x of [-2.25, 0, 2.25]) {
        addBox(scene, [0.08, 2.0, 0.08], [center.x + x, 2.2, center.z + z], mats.steel);
        const insulator = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.075, 0.28, 8), mats.porcelain);
        insulator.position.set(center.x + x, 3.36, center.z + z);
        scene.add(insulator);
      }
    }
    addLabel(scene, `BUS ${busIndex === 0 ? "1A" : "1B"}`, [center.x + 3.25, 3.75, center.z + busOffset], 3.7, "#738a86");
    return phaseZ;
  });

  buses[0].forEach((zA, phase) => {
    const zB = buses[1][phase];
    const pointA = center.clone().add(new THREE.Vector3(0, 3.42, zA));
    const pointB = center.clone().add(new THREE.Vector3(0, 3.42, zB));
    const coupler = center.clone().add(new THREE.Vector3(0, 2.7, (zA + zB) / 2));
    addWireSpan(scene, pointA, coupler, 0.025, mats.conductor, 0.018);
    addWireSpan(scene, coupler, pointB, 0.025, mats.conductor, 0.018);
    addBox(scene, [0.38, 0.3, 0.34], [center.x, 1.45, center.z + (zA + zB) / 2], mats.equipment);
  });
  return buses;
}

function tieFeederToBus(scene, feederBay, phaseZ, mats) {
  const sources = [...feederBay.taps].sort((a, b) => a.z - b.z);
  sources.forEach((source, phase) => {
    const x = THREE.MathUtils.clamp(source.x - feederBay.station.position.x, -2.65, 2.65);
    const target = feederBay.station.position.clone().add(new THREE.Vector3(x, 3.42, phaseZ[phase]));
    addWireSpan(scene, source, target, 0.025, mats.conductor, 0.022);
  });
}

function addSubstation(scene, station, point, index, mats) {
  const group = new THREE.Group();
  group.position.copy(point);
  group.userData = {
    pickable: true,
    stationId: station.id,
    title: station.shortName,
    detail: station.description
  };

  const dimensions = stationFootprint(station.id);
  const [width, depth] = dimensions;
  addBox(group, [width, 0.2, depth], [0, 0.12, 0], mats.concrete);

  const postGeo = new THREE.BoxGeometry(0.075, 0.78, 0.075);
  const halfW = width / 2, halfD = depth / 2;
  for (const z of [-halfD, halfD]) {
    for (let x = -halfW; x <= halfW + 0.001; x += 1.05) {
      const post = new THREE.Mesh(postGeo, mats.steel);
      post.position.set(Math.min(x, halfW), 0.54, z);
      group.add(post);
    }
  }
  for (const x of [-halfW, halfW]) {
    for (let z = -halfD; z <= halfD + 0.001; z += 1.05) {
      const post = new THREE.Mesh(postGeo, mats.steel);
      post.position.set(x, 0.54, Math.min(z, halfD));
      group.add(post);
    }
  }
  for (const y of [0.3, 0.83]) {
    const railFront = new THREE.Mesh(new THREE.BoxGeometry(width, 0.04, 0.035), mats.steel);
    railFront.position.set(0, y, -halfD);
    group.add(railFront);
    const railBack = railFront.clone();
    railBack.position.z = halfD;
    group.add(railBack);
    const railSide = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.04, depth), mats.steel);
    railSide.position.set(-halfW, y, 0);
    group.add(railSide);
    const railSide2 = railSide.clone();
    railSide2.position.x = halfW;
    group.add(railSide2);
  }

  const unitCount = index === 0 ? 2 : 0;
  for (let i = 0; i < unitCount; i++) {
    const x = (i - (unitCount - 1) / 2) * 2.25;
    addBox(group, [1.35, 0.86, 1.28], [x, 0.65, -0.45], mats.equipment);
    for (let rib = 0; rib < 4; rib++) {
      addBox(group, [0.035, 0.66, 1.0], [x - 0.73 - rib * 0.055, 0.58, -0.45], mats.steel);
    }
  }

  const bayCount = index === 1 ? 0 : index === 2 ? 4 : 2;
  for (let bay = 0; bay < bayCount; bay++) {
    const x = (bay - (bayCount - 1) / 2) * 2.0;
    for (const z of [-1.7, 1.75]) {
      addBox(group, [0.09, 2.9, 0.09], [x, 1.62, z], mats.steel);
      addBox(group, [1.15, 0.085, 0.1], [x, 3.06, z], mats.steel);
      for (const side of [-0.38, 0.38]) {
        const insulator = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.09, 0.34, 7), mats.porcelain);
        insulator.position.set(x + side, 3.28, z);
        group.add(insulator);
      }
    }
  }

  const controlW = index === 2 ? 3.3 : 2.85;
  const control = addBox(group, [controlW, 1.15, 1.2], [0, 0.78, halfD - 1.05], mats.wall);
  control.castShadow = true;
  addBox(group, [controlW + 0.12, 0.12, 1.34], [0, 1.41, halfD - 1.05], mats.roof);
  for (let x = -controlW * 0.34; x <= controlW * 0.34; x += controlW * 0.34) {
    addBox(group, [0.3, 0.38, 0.025], [x, 0.83, halfD - 0.43], mats.glass);
  }

  addLabel(scene, station.shortName, [point.x, 7.0, point.z], index === 1 ? 10.6 : 9.7, station.color);
  scene.add(group);
  return group;
}

export async function createLineScene(container) {
  const response = await fetch("./assets/transmission-route.json?rev=3");
  if (!response.ok) throw new Error("输电线路展示路径文件无法读取");
  const route = await response.json();
  const allCoords = [...route.segments.flatMap(segment => segment.coordinates), ...route.stations.map(station => station.coords)];
  const lonValues = allCoords.map(point => point[0]);
  const latValues = allCoords.map(point => point[1]);
  const centerLon = (Math.min(...lonValues) + Math.max(...lonValues)) / 2;
  const centerLat = (Math.min(...latValues) + Math.max(...latValues)) / 2;
  // Compress the mapped corridor for presentation: preserve the route shape,
  // not literal distance. This keeps all three station compounds legible.
  const scale = 0.0013;
  const metersPerLon = 111320 * Math.cos(THREE.MathUtils.degToRad(centerLat));
  const toWorld = ([lon, lat]) => new THREE.Vector3(
    (lon - centerLon) * metersPerLon * scale,
    0,
    -(lat - centerLat) * 111320 * scale
  );
  const worldStations = route.stations.map(station => ({ ...station, position: toWorld(station.coords) }));
  const worldSegments = route.segments.map(segment => ({
    ...segment,
    points: segment.coordinates.map(toWorld)
  }));
  const extentPoints = [...worldSegments.flatMap(segment => segment.points), ...worldStations.map(station => station.position)];
  const minX = Math.min(...extentPoints.map(point => point.x));
  const maxX = Math.max(...extentPoints.map(point => point.x));
  const minZ = Math.min(...extentPoints.map(point => point.z));
  const maxZ = Math.max(...extentPoints.map(point => point.z));
  const center = new THREE.Vector3((minX + maxX) / 2, 0, (minZ + maxZ) / 2);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xe4e7e3);
  scene.fog = new THREE.Fog(0xe4e7e3, 95, 190);
  const camera = new THREE.PerspectiveCamera(40, container.clientWidth / container.clientHeight, 0.1, 500);
  const renderer = makeRenderer(container);
  renderer.shadowMap.enabled = false;
  scene.add(new THREE.HemisphereLight(0xf8fbff, 0xc4c7c1, 1.65));
  const keyLight = new THREE.DirectionalLight(0xfff1dc, 1.8);
  keyLight.position.set(-28, 44, 18);
  scene.add(keyLight);
  const fillLight = new THREE.DirectionalLight(0xd9e8ee, 0.44);
  fillLight.position.set(20, 18, -24);
  scene.add(fillLight);

  const width = maxX - minX + 18;
  const depth = maxZ - minZ + 16;
  const span = Math.max(width, depth);
  const aspect = container.clientWidth / container.clientHeight;
  const fitScale = 1 + 0.55 * THREE.MathUtils.clamp((1.45 - aspect) / 0.65, 0, 1);
  camera.position.copy(center).add(new THREE.Vector3(0, span * 0.9, span * 0.68).multiplyScalar(fitScale));
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), new THREE.MeshStandardMaterial({ color: 0xd9ddd9, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(center.x, -0.13, center.z);
  ground.receiveShadow = true;
  scene.add(ground);

  const padMat = new THREE.MeshStandardMaterial({ color: 0xc8ceca, roughness: 0.96 });
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xe9e8e1, roughness: 0.83 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x707c77, roughness: 0.74 });
  const steelMat = new THREE.MeshStandardMaterial({ color: 0x667672, roughness: 0.56, metalness: 0.28 });
  const equipmentMat = new THREE.MeshStandardMaterial({ color: 0x9aa6a0, roughness: 0.72, metalness: 0.08 });
  const porcelainMat = new THREE.MeshStandardMaterial({ color: 0xf1ede2, roughness: 0.36, metalness: 0.08 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x8ea9aa, roughness: 0.27, metalness: 0.08 });
  const conductorMat = new THREE.MeshStandardMaterial({ color: 0x899691, roughness: 0.46, metalness: 0.58 });
  const shieldMat = new THREE.MeshStandardMaterial({ color: 0x606d69, roughness: 0.5, metalness: 0.56 });
  const mats = { concrete: padMat, wall: wallMat, roof: roofMat, steel: steelMat, equipment: equipmentMat, porcelain: porcelainMat, glass: glassMat, conductor: conductorMat, shield: shieldMat };

  const stationGroups = worldStations.map((station, index) => addSubstation(scene, station, station.position, index, mats));
  const stationById = new Map(worldStations.map(station => [station.id, station]));
  const manamaBuses = addManamaDoubleBus(scene, stationById.get("manama"), mats);
  const crossingGroups = [];
  const connectorGroups = [];
  worldSegments.forEach((segment, segmentIndex) => {
    const points = segment.points.map(point => new THREE.Vector3(point.x, 4.12, point.z));
    const curve = new THREE.CatmullRomCurve3(points, false, "centripetal");
    const startStation = stationById.get(segment.fromStationId);
    const endStation = stationById.get(segment.toStationId);
    if (!startStation || !endStation) throw new Error(`线路端点站信息缺失：${segment.id}`);
    const length = curve.getLength();
    const startTangent = curve.getTangentAt(0).setY(0).normalize();
    const endTangent = curve.getTangentAt(1).setY(0).normalize();
    const startPortal = addLinePortal(scene, startStation, startTangent.clone(), startTangent, mats, segment.feederLabel);
    const endPortal = addLinePortal(scene, endStation, endTangent.clone().negate(), endTangent, mats, segment.feederLabel);
    const startBay = addFeederBay(scene, startPortal, mats, `${segment.feederLabel} · ${startStation.shortName}`);
    const endBay = addFeederBay(scene, endPortal, mats, `${segment.feederLabel} · ${endStation.shortName}`);
    connectorGroups.push(startPortal.group, endPortal.group, startBay.group, endBay.group);
    if (startStation.id === "manama") tieFeederToBus(scene, startBay, manamaBuses[segmentIndex], mats);
    if (endStation.id === "manama") tieFeederToBus(scene, endBay, manamaBuses[segmentIndex], mats);
    const supportStart = Math.min(0.78, (startPortal.edgeDistance + 1.8) / length);
    const supportEnd = Math.max(supportStart + 0.12, 1 - (endPortal.edgeDistance + 1.8) / length);
    const supportFractions = [0.18, 0.5, 0.82].map(fraction => supportStart + (supportEnd - supportStart) * fraction);
    const supportTowers = supportFractions.map(t => {
      const point = curve.getPointAt(t);
      const tangent = curve.getTangentAt(t);
      return addTower(scene, new THREE.Vector3(point.x, 0, point.z), Math.atan2(tangent.x, tangent.z), mats);
    });
    const wireSupports = [startPortal, ...supportTowers, endPortal];
    for (let spanIndex = 0; spanIndex < wireSupports.length - 1; spanIndex++) {
      const from = wireSupports[spanIndex], to = wireSupports[spanIndex + 1];
      for (let phase = 0; phase < 3; phase++) {
        addWireSpan(scene, from.phases[phase], to.phases[phase], 0.34, conductorMat, 0.025);
      }
      addWireSpan(scene, from.shield, to.shield, 0.22, shieldMat, 0.012);
    }
    const guideStart = Math.min(0.92, (startPortal.edgeDistance + 0.42) / length);
    const guideEnd = Math.max(guideStart + 0.04, 1 - (endPortal.edgeDistance + 0.42) / length);
    const guidePoints = [];
    for (let sample = 0; sample <= 96; sample++) {
      const t = sample / 96;
      if (t < guideStart || t > guideEnd) continue;
      const point = curve.getPointAt(t);
      point.y = 0.025;
      guidePoints.push(point);
    }
    if (guidePoints.length > 1) {
      const guide = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(guidePoints),
        new THREE.LineDashedMaterial({ color: 0xe47c32, dashSize: 0.42, gapSize: 0.3, transparent: true, opacity: 0.78 })
      );
      guide.computeLineDistances();
      scene.add(guide);
    }
    const labelPoint = curve.getPointAt(0.52);
    addLabel(scene, `${segment.km} km · 工作基线`, [labelPoint.x, 6.6, labelPoint.z], 9.5, segmentIndex === 0 ? "#e47c32" : "#738a86");
    for (const crossing of route.crossings.filter(item => item.segmentId === segment.id)) {
      crossingGroups.push(addCrossingMarker(scene, crossing, curve.getPointAt(crossing.fraction)));
    }
    if (points.length < 2) throw new Error("线路样条点不足");
  });

  const north = new THREE.Group();
  north.position.set(maxX - 1.7, 0.04, minZ + 2.1);
  const northLine = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0.03, 1.15), new THREE.Vector3(0, 0.03, -0.9)]),
    new THREE.LineBasicMaterial({ color: 0x56645f })
  );
  north.add(northLine);
  const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.24, 0.55, 4), new THREE.MeshStandardMaterial({ color: 0xe47c32, roughness: 0.62 }));
  arrow.position.set(0, 0.05, -0.98);
  arrow.rotation.x = -Math.PI / 2;
  north.add(arrow);
  addLabel(scene, "N", [north.position.x, 1.55, north.position.z - 1.55], 1.8, "#738a86");
  scene.add(north);

  const controls = new OrbitControls(camera, renderer.domElement);
  const initialPosition = camera.position.clone();
  const initialTarget = center.clone();
  controls.target.copy(initialTarget);
  controls.enableDamping = true;
  controls.dampingFactor = 0.055;
  controls.minDistance = 9;
  controls.maxDistance = 180;
  controls.maxPolarAngle = Math.PI * 0.48;
  controls.update();
  renderer.domElement.style.cursor = "grab";

  const inspector = document.getElementById("line-inspector");
  const tourButton = document.querySelector("[data-line-tour]");
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const start = new THREE.Vector2();
  let pointerDown = false;
  let tweenId = 0;
  let tourTimer = 0;
  let tourIndex = 0;
  let touring = false;

  function updateTourButton(active) {
    touring = active;
    if (tourButton) {
      tourButton.textContent = active ? "停止巡览" : "自动巡览";
      tourButton.setAttribute("aria-pressed", String(active));
    }
  }

  function stopTour() {
    if (tourTimer) window.clearTimeout(tourTimer);
    tourTimer = 0;
    tweenId++;
    if (touring) updateTourButton(false);
  }

  function moveCamera(target, distance, duration = 1000) {
    tweenId++;
    const currentTween = tweenId;
    const fromPosition = camera.position.clone();
    const fromTarget = controls.target.clone();
    const direction = fromPosition.clone().sub(fromTarget).normalize();
    const toTarget = target.clone();
    const toPosition = toTarget.clone().addScaledVector(direction, distance);
    toPosition.y = Math.max(toPosition.y, toTarget.y + 5.5);
    const startTime = performance.now();
    function animate(now) {
      if (currentTween !== tweenId) return;
      const t = Math.min(1, (now - startTime) / duration);
      const eased = t * t * (3 - 2 * t);
      camera.position.lerpVectors(fromPosition, toPosition, eased);
      controls.target.lerpVectors(fromTarget, toTarget, eased);
      controls.update();
      if (t < 1) requestAnimationFrame(animate);
    }
    requestAnimationFrame(animate);
  }

  const lineViews = [
    { key: "baphalane", object: stationGroups[0], target: worldStations[0].position.clone().add(new THREE.Vector3(0, 1, 0)), distance: 17 },
    { key: "manama", object: stationGroups[1], target: worldStations[1].position.clone().add(new THREE.Vector3(0, 1, 0)), distance: 16 },
    { key: "spitskop", object: stationGroups[2], target: worldStations[2].position.clone().add(new THREE.Vector3(0, 1, 0)), distance: 18 },
    { key: "route", object: null, target: center.clone(), distance: 77 }
  ];

  function setActiveView(key) {
    document.querySelectorAll("[data-focus-line]").forEach(button => {
      const active = button.dataset.focusLine === key;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
  }

  function setActiveCrossing(id = null) {
    document.querySelectorAll("[data-crossing-id]").forEach(button => {
      const active = button.dataset.crossingId === id;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
  }

  function setCrossingVisibility(id = null) {
    crossingGroups.forEach(marker => { marker.visible = id === null || marker.userData.crossingId === id; });
  }

  function focusView(key, fromTour = false) {
    const view = lineViews.find(item => item.key === key);
    if (!view) return;
    if (!fromTour) stopTour();
    setActiveCrossing();
    setCrossingVisibility(key === "route" ? null : "");
    setActiveView(key);
    if (inspector) {
      if (view.object) {
        inspector.querySelector("h3").textContent = view.object.userData.title;
        inspector.querySelector("p").textContent = view.object.userData.detail;
      } else {
        inspector.querySelector("h3").textContent = "三站 132 kV 送出链路";
        inspector.querySelector("p").textContent = route.routeNote;
      }
    }
    moveCamera(view.target, view.distance, fromTour ? 1250 : 950);
  }

  function focusCrossing(id) {
    const marker = crossingGroups.find(item => item.userData.crossingId === id);
    if (!marker) return;
    stopTour();
    window.dispatchEvent(new CustomEvent("baphalane-arrival-focus", { detail: { keys: [] } }));
    setActiveView("route");
    setActiveCrossing(id);
    setCrossingVisibility(id);
    if (inspector) {
      inspector.querySelector("h3").textContent = marker.userData.title;
      inspector.querySelector("p").textContent = marker.userData.detail;
    }
    moveCamera(marker.position.clone().add(new THREE.Vector3(0, 0.7, 0)), 12, 800);
  }

  function startTour() {
    stopTour();
    updateTourButton(true);
    tourIndex = 0;
    const next = () => {
      if (!touring) return;
      focusView(lineViews[tourIndex % lineViews.length].key, true);
      tourIndex++;
      tourTimer = window.setTimeout(next, 3600);
    };
    next();
  }

  tourButton?.addEventListener("click", () => touring ? stopTour() : startTour());
  document.querySelectorAll("[data-focus-line]").forEach(button => button.addEventListener("click", () => focusView(button.dataset.focusLine)));
  document.querySelectorAll("[data-crossing-id]").forEach(button => button.addEventListener("click", () => focusCrossing(button.dataset.crossingId)));
  controls.addEventListener("start", stopTour);
  renderer.domElement.addEventListener("pointerdown", event => {
    pointerDown = event.isPrimary && event.button === 0;
    start.set(event.clientX, event.clientY);
  });
  renderer.domElement.addEventListener("pointercancel", () => { pointerDown = false; });
  renderer.domElement.addEventListener("click", event => {
    if (!pointerDown || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) {
      pointerDown = false;
      return;
    }
    pointerDown = false;
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects([...stationGroups, ...crossingGroups.filter(group => group.visible), ...connectorGroups], true)[0];
    if (!hit) return;
    let node = hit.object;
    while (node.parent && !node.userData.pickable) node = node.parent;
    if (!node.userData.pickable) return;
    window.dispatchEvent(new CustomEvent("baphalane-arrival-focus", { detail: { keys: node.userData.stationId === "baphalane" ? ["main-transformer"] : [] } }));
    if (node.userData.crossingId) focusCrossing(node.userData.crossingId);
    else focusView(node.userData.stationId);
  });

  function reset() {
    stopTour();
    setActiveView("route");
    setActiveCrossing();
    setCrossingVisibility();
    if (inspector) {
      inspector.querySelector("h3").textContent = "三站 132 kV 送出链路";
      inspector.querySelector("p").textContent = route.routeNote;
    }
    camera.position.copy(initialPosition);
    controls.target.copy(initialTarget);
    controls.update();
  }
  scene.userData.reset = reset;
  scene.userData.stopTour = stopTour;
  return { scene, camera, renderer, controls };
}
