import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { makeRenderer, tag } from "./scene-kit.js?rev=57";
import { attachSiteInteractions } from "./site-interactions.js?rev=48";

const GEOMETRY = "./assets/site-plan-rows.json";
const PT = 0.08;

function addSiteLabel(scene, text, position, width) {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 80;
  const ctx = canvas.getContext("2d");
  const theme = globalThis.getComputedStyle?.(document.documentElement);
  const color = (name, fallback) => theme?.getPropertyValue(name).trim() || fallback;
  ctx.fillStyle = color("--color-paper-2", "#fcfbf8");
  ctx.fillRect(5, 5, 502, 70);
  ctx.strokeStyle = color("--color-rule", "#d6d0c5");
  ctx.lineWidth = 2;
  ctx.strokeRect(5, 5, 502, 70);
  ctx.fillStyle = color("--color-accent", "#a14f2e");
  ctx.fillRect(7, 7, 5, 66);
  ctx.fillStyle = color("--color-ink", "#322e29");
  ctx.font = `600 30px ${color("--font-body", '\"Segoe UI\", \"Microsoft YaHei\", sans-serif')}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 262, 40, 470);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }));
  const height = width * canvas.height / canvas.width;
  sprite.scale.set(width, height, 1);
  sprite.position.set(...position);
  sprite.onBeforeRender = (_renderer, _scene, camera) => {
    const scale = THREE.MathUtils.clamp(camera.position.distanceTo(sprite.position) / 44, 0.38, 1.05);
    sprite.scale.set(width * scale, height * scale, 1);
  };
  scene.add(sprite);
  return sprite;
}

function addFenceSpan(parent, a, b, height = 1.05) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const length = Math.hypot(dx, dz);
  if (length < 0.08) return;
  const rotation = -Math.atan2(dz, dx);
  const postMat = new THREE.MeshStandardMaterial({ color: 0x697772, roughness: 0.74, metalness: 0.16 });
  const panelMat = new THREE.MeshStandardMaterial({ color: 0xaeb8b2, roughness: 0.82, transparent: true, opacity: 0.38, depthWrite: false, side: THREE.DoubleSide });
  const railMat = new THREE.MeshStandardMaterial({ color: 0x77837d, roughness: 0.7, metalness: 0.14 });
  const count = Math.max(1, Math.ceil(length / 0.9));
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.055, height, 0.055), postMat);
    post.position.set(a.x + dx * t, height / 2, a.z + dz * t);
    parent.add(post);
  }
  const panel = new THREE.Mesh(new THREE.BoxGeometry(length, height * 0.68, 0.025), panelMat);
  panel.position.set((a.x + b.x) / 2, height * 0.54, (a.z + b.z) / 2);
  panel.rotation.y = rotation;
  parent.add(panel);
  for (const y of [height * 0.2, height * 0.88]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(length, 0.035, 0.035), railMat);
    rail.position.set((a.x + b.x) / 2, y, (a.z + b.z) / 2);
    rail.rotation.y = rotation;
    parent.add(rail);
  }
}

function addFenceLoopWithGate(parent, points, {
  gateEdgeIndex = 0,
  gateT = 0.5,
  gateWidth = 1.2,
  height = 1.05,
  closed = true
} = {}) {
  if (points.length < 3) return;
  const center = points.reduce((sum, point) => sum.add(point), new THREE.Vector3()).multiplyScalar(1 / points.length);
  const gatePostMat = new THREE.MeshStandardMaterial({ color: 0xe47c32, roughness: 0.6, metalness: 0.12 });
  const gatePanelMat = new THREE.MeshStandardMaterial({ color: 0xc8793f, roughness: 0.7, metalness: 0.08 });
  const n = points.length;

  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const a = points[i], b = points[(i + 1) % n];
    if (i !== gateEdgeIndex) {
      addFenceSpan(parent, a, b, height);
      continue;
    }

    const delta = b.clone().sub(a);
    const length = Math.hypot(delta.x, delta.z);
    if (length < gateWidth + 0.2) {
      addFenceSpan(parent, a, b, height);
      continue;
    }
    const t = THREE.MathUtils.clamp(gateT, gateWidth / length / 2, 1 - gateWidth / length / 2);
    const tangent = new THREE.Vector3(delta.x / length, 0, delta.z / length);
    const edgeMidpoint = a.clone().addScaledVector(tangent, length / 2);
    let inward = new THREE.Vector3(-tangent.z, 0, tangent.x);
    if (inward.dot(center.clone().sub(edgeMidpoint)) < 0) inward.negate();
    const gateCenter = a.clone().addScaledVector(tangent, length * t);
    const gateStart = gateCenter.clone().addScaledVector(tangent, -gateWidth / 2);
    const gateEnd = gateCenter.clone().addScaledVector(tangent, gateWidth / 2);
    addFenceSpan(parent, a, gateStart, height);
    addFenceSpan(parent, gateEnd, b, height);

    for (const hinge of [gateStart, gateEnd]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.075, height + 0.12, 8), gatePostMat);
      post.position.set(hinge.x, (height + 0.12) / 2, hinge.z);
      post.castShadow = true;
      parent.add(post);
    }

    // Swing both leaves inward and back along the fence so the access road stays clear.
    for (const [hinge, side] of [[gateStart, -1], [gateEnd, 1]]) {
      const direction = tangent.clone().multiplyScalar(side * 0.92).addScaledVector(inward, 0.39).normalize();
      const leafLength = gateWidth * 0.61;
      const leaf = new THREE.Group();
      leaf.position.copy(hinge);
      leaf.rotation.y = -Math.atan2(direction.z, direction.x);
      const panel = new THREE.Mesh(new THREE.BoxGeometry(leafLength, height * 0.64, 0.045), gatePanelMat);
      panel.position.set(leafLength / 2, height * 0.53, 0);
      leaf.add(panel);
      const rail = new THREE.Mesh(new THREE.BoxGeometry(leafLength, 0.045, 0.06), gatePostMat);
      rail.position.set(leafLength / 2, height * 0.84, 0);
      leaf.add(rail);
      parent.add(leaf);
    }
  }
}

function addRoadStrip(parent, points, width, material, label, y = 0.17, smooth = true) {
  if (points.length < 2) return null;
  const curve = points.length > 2
    ? new THREE.CatmullRomCurve3(points, false, "centripetal")
    : new THREE.LineCurve3(points[0], points[1]);
  const samples = smooth ? curve.getPoints(Math.max(16, points.length * 10)) : points;
  const halfWidth = width / 2;
  const vertices = [], indices = [];
  for (let i = 0; i < samples.length; i++) {
    const before = samples[Math.max(0, i - 1)], after = samples[Math.min(samples.length - 1, i + 1)];
    const dx = after.x - before.x, dz = after.z - before.z;
    const length = Math.hypot(dx, dz) || 1;
    const nx = -dz / length * halfWidth, nz = dx / length * halfWidth;
    vertices.push(samples[i].x + nx, y, samples[i].z + nz, samples[i].x - nx, y, samples[i].z - nz);
    if (i < samples.length - 1) {
      const a = i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const road = new THREE.Mesh(geometry, material);
  road.name = label;
  road.receiveShadow = true;
  parent.add(road);
  return { road, samples };
}

function addGableRoof(building, width, depth, eaveY, rise, roofMaterial, gableMaterial) {
  const roofGeometry = new THREE.BufferGeometry();
  const x0 = -width / 2 - 0.07, x1 = width / 2 + 0.07;
  const z0 = -depth / 2 - 0.06, z1 = depth / 2 + 0.06;
  const ridgeY = eaveY + rise;
  const vertices = [
    x0,eaveY,z0, x1,eaveY,z0, x1,ridgeY,0, x0,ridgeY,0,
    x0,eaveY,z1, x1,eaveY,z1, x1,ridgeY,0, x0,ridgeY,0
  ];
  roofGeometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  roofGeometry.setIndex([0,1,2,0,2,3,4,6,5,4,7,6]);
  roofGeometry.computeVertexNormals();
  const roofFinish = roofMaterial.clone();
  roofFinish.side = THREE.DoubleSide;
  const roof = new THREE.Mesh(roofGeometry, roofFinish);
  roof.castShadow = true;
  building.add(roof);

  const gableGeometry = new THREE.BufferGeometry();
  const gableVertices = [
    -width / 2 - 0.018,eaveY,z0, -width / 2 - 0.018,eaveY,z1, -width / 2 - 0.018,ridgeY,0,
    width / 2 + 0.018,eaveY,z0, width / 2 + 0.018,eaveY,z1, width / 2 + 0.018,ridgeY,0
  ];
  gableGeometry.setAttribute("position", new THREE.Float32BufferAttribute(gableVertices, 3));
  gableGeometry.setIndex([0,2,1,3,4,5]);
  gableGeometry.computeVertexNormals();
  const gables = new THREE.Mesh(gableGeometry, gableMaterial);
  building.add(gables);

  const ridge = new THREE.Mesh(new THREE.BoxGeometry(width + 0.16, 0.045, 0.055), roofMaterial);
  ridge.position.y = ridgeY + 0.015;
  building.add(ridge);
}

function addOmFloorCutaway(building, width, depth) {
  const interior = new THREE.Group();
  interior.name = "按附图4-2布置的运维楼室内透视";
  interior.visible = false;
  building.add(interior);

  const scale = width / 43.2;
  const corridorDepth = 2.4 * scale;
  const roomDepth = 6.6 * scale;
  const wallHeight = 0.28;
  const wallThickness = 0.016;
  const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
  const materials = {
    outer: new THREE.MeshStandardMaterial({ color: 0xeee9de, roughness: 0.92 }),
    partition: new THREE.MeshStandardMaterial({ color: 0xd3d0c6, roughness: 0.94 }),
    corridor: new THREE.MeshStandardMaterial({ color: 0xbcc7c2, roughness: 0.96 }),
    baseFloor: new THREE.MeshStandardMaterial({ color: 0xe8e6df, roughness: 0.96 }),
    serviceFloor: new THREE.MeshStandardMaterial({ color: 0xdedbd1, roughness: 0.97 }),
    sleepFloor: new THREE.MeshStandardMaterial({ color: 0xe7e1d5, roughness: 0.96 }),
    furniture: new THREE.MeshStandardMaterial({ color: 0x9e8b72, roughness: 0.86 }),
    woodLight: new THREE.MeshStandardMaterial({ color: 0xc4ae8c, roughness: 0.86 }),
    seat: new THREE.MeshStandardMaterial({ color: 0x758780, roughness: 0.88 }),
    screen: new THREE.MeshStandardMaterial({ color: 0x40575b, roughness: 0.46, metalness: 0.12 }),
    bedding: new THREE.MeshStandardMaterial({ color: 0xc2d0cd, roughness: 0.92 }),
    sanitary: new THREE.MeshStandardMaterial({ color: 0xf4f4f0, roughness: 0.48 }),
    appliance: new THREE.MeshStandardMaterial({ color: 0x9ca8a5, roughness: 0.5, metalness: 0.28 }),
    display: new THREE.MeshStandardMaterial({ color: 0x31494d, roughness: 0.4, metalness: 0.08 })
  };

  function addBox(x, y, z, sx, sy, sz, material) {
    const mesh = new THREE.Mesh(boxGeometry, material);
    mesh.position.set(x, y, z);
    mesh.scale.set(sx, sy, sz);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    interior.add(mesh);
    return mesh;
  }

  function addPartition(x, z, sx, sz, material = materials.partition) {
    addBox(x, wallHeight / 2 + 0.07, z, sx, wallHeight, sz, material);
  }

  function addRoomFurniture(type, centerX, centerZ, roomWidth, roomDepth) {
    const low = 0.065, tableH = 0.13;
    const desk = materials.woodLight, chair = materials.seat;
    const addTable = (x, z, w, d, h = tableH) => {
      addBox(x, h, z, w, 0.025, d, desk);
      for (const dx of [-w * 0.42, w * 0.42]) for (const dz of [-d * 0.35, d * 0.35]) {
        addBox(x + dx, h / 2, z + dz, 0.014, h, 0.014, materials.partition);
      }
    };
    const addChair = (x, z) => {
      addBox(x, low, z, 0.045, 0.025, 0.045, chair);
      addBox(x, low + 0.055, z - 0.019, 0.045, 0.09, 0.012, chair);
      for (const dx of [-0.016, 0.016]) for (const dz of [-0.015, 0.015]) {
        addBox(x + dx, low * 0.45, z + dz, 0.008, low * 0.9, 0.008, materials.partition);
      }
    };
    const addBed = (x, z) => {
      const bedW = roomWidth * 0.62, bedD = roomDepth * 0.58;
      addBox(x, low, z, bedW, 0.055, bedD, materials.furniture);
      addBox(x, low + 0.033, z, bedW * 0.92, 0.025, bedD * 0.92, materials.bedding);
      addBox(x, low + 0.054, z - bedD * 0.34, bedW * 0.82, 0.018, bedD * 0.16, materials.sanitary);
    };

    if (type === "dormitory") {
      addBed(centerX, centerZ);
      addBox(centerX + roomWidth * 0.34, low + 0.075, centerZ + roomDepth * 0.27, roomWidth * 0.18, 0.15, roomDepth * 0.2, materials.furniture);
      addBox(centerX - roomWidth * 0.34, low + 0.05, centerZ - roomDepth * 0.29, roomWidth * 0.16, 0.1, roomDepth * 0.18, materials.woodLight);
    } else if (type === "kitchen") {
      addBox(centerX, low + 0.055, centerZ - roomDepth * 0.3, roomWidth * 0.78, 0.11, roomDepth * 0.16, materials.sanitary);
      addBox(centerX - roomWidth * 0.22, low + 0.12, centerZ - roomDepth * 0.3, roomWidth * 0.2, 0.012, roomDepth * 0.11, materials.display);
      for (const xOffset of [-0.27, -0.17, -0.07, 0.03]) {
        addBox(centerX + roomWidth * xOffset, low + 0.13, centerZ - roomDepth * 0.3, 0.018, 0.009, 0.018, materials.appliance);
      }
      addBox(centerX + roomWidth * 0.28, low + 0.14, centerZ - roomDepth * 0.3, roomWidth * 0.12, 0.18, roomDepth * 0.12, materials.appliance);
      addBox(centerX + roomWidth * 0.22, low + 0.095, centerZ + roomDepth * 0.2, roomWidth * 0.18, 0.18, roomDepth * 0.18, materials.furniture);
      addBox(centerX - roomWidth * 0.31, low + 0.2, centerZ + roomDepth * 0.26, roomWidth * 0.17, 0.34, roomDepth * 0.18, materials.appliance);
    } else if (type === "restaurant") {
      for (const z of [-roomDepth * 0.22, roomDepth * 0.22]) {
        addTable(centerX, centerZ + z, roomWidth * 0.48, roomDepth * 0.22, 0.105);
        addChair(centerX - roomWidth * 0.34, centerZ + z);
        addChair(centerX + roomWidth * 0.34, centerZ + z);
      }
    } else if (type === "reception") {
      addTable(centerX, centerZ + roomDepth * 0.18, roomWidth * 0.58, roomDepth * 0.12, 0.12);
      addChair(centerX - roomWidth * 0.17, centerZ - roomDepth * 0.08);
      addChair(centerX + roomWidth * 0.17, centerZ - roomDepth * 0.08);
    } else if (type === "toilet") {
      for (const z of [-roomDepth * 0.2, roomDepth * 0.18]) {
        addPartition(centerX - roomWidth * 0.2, centerZ + z, roomWidth * 0.02, roomDepth * 0.26, materials.outer);
        addBox(centerX - roomWidth * 0.27, low + 0.03, centerZ + z, roomWidth * 0.14, 0.06, roomDepth * 0.14, materials.sanitary);
        addBox(centerX - roomWidth * 0.27, low + 0.064, centerZ + z - roomDepth * 0.02, roomWidth * 0.08, 0.012, roomDepth * 0.07, materials.appliance);
        addBox(centerX + roomWidth * 0.25, low + 0.045, centerZ + z, roomWidth * 0.12, 0.09, roomDepth * 0.12, materials.sanitary);
      }
      addBox(centerX + roomWidth * 0.24, low + 0.16, centerZ - roomDepth * 0.34, 0.012, 0.19, 0.012, materials.appliance);
      addBox(centerX + roomWidth * 0.22, low + 0.26, centerZ - roomDepth * 0.34, 0.065, 0.012, 0.065, materials.sanitary);
    } else if (type === "store") {
      for (let i = 0; i < 3; i++) {
        const x = centerX - roomWidth * 0.28 + i * roomWidth * 0.28;
        addBox(x, low + 0.045, centerZ, roomWidth * 0.16, 0.018, roomDepth * 0.65, materials.furniture);
        for (const y of [0.12, 0.22]) addBox(x, y, centerZ, roomWidth * 0.16, 0.012, roomDepth * 0.65, materials.woodLight);
        for (const z of [-0.22, 0, 0.22]) addBox(x, low + 0.13, centerZ + z * roomDepth, roomWidth * 0.1, 0.045, roomDepth * 0.14, materials.furniture);
      }
    } else if (type === "meeting") {
      addTable(centerX, centerZ, roomWidth * 0.54, roomDepth * 0.3, 0.12);
      for (const side of [-1, 1]) for (const x of [-0.3, 0, 0.3]) {
        addChair(centerX + x * roomWidth * 0.7, centerZ + side * roomDepth * 0.28);
      }
      addBox(centerX, 0.2, centerZ - roomDepth * 0.39, roomWidth * 0.26, 0.11, 0.018, materials.display);
    } else if (type === "lobby") {
      addBox(centerX - roomWidth * 0.2, low + 0.07, centerZ - roomDepth * 0.22, roomWidth * 0.18, 0.14, roomDepth * 0.48, chair);
      addBox(centerX + roomWidth * 0.2, low + 0.07, centerZ - roomDepth * 0.22, roomWidth * 0.18, 0.14, roomDepth * 0.48, chair);
      addBox(centerX - roomWidth * 0.2, low + 0.15, centerZ - roomDepth * 0.29, roomWidth * 0.18, 0.1, 0.035, chair);
      addBox(centerX + roomWidth * 0.2, low + 0.15, centerZ - roomDepth * 0.29, roomWidth * 0.18, 0.1, 0.035, chair);
      addTable(centerX, centerZ + roomDepth * 0.25, roomWidth * 0.3, roomDepth * 0.15, 0.09);
    } else if (type === "security" || type === "office") {
      addTable(centerX, centerZ + roomDepth * 0.14, roomWidth * 0.55, roomDepth * 0.16);
      addChair(centerX, centerZ - roomDepth * 0.12);
      addBox(centerX, 0.205, centerZ + roomDepth * 0.03, roomWidth * 0.16, 0.09, 0.014, materials.display);
      if (type === "security") {
        addBox(centerX, 0.22, centerZ - roomDepth * 0.29, roomWidth * 0.22, 0.12, 0.018, materials.display);
        addBox(centerX + roomWidth * 0.29, low + 0.11, centerZ - roomDepth * 0.18, roomWidth * 0.14, 0.22, roomDepth * 0.24, materials.furniture);
      }
    } else if (type === "control") {
      for (const x of [-0.32, 0, 0.32]) {
        const deskX = centerX + x * roomWidth;
        addTable(deskX, centerZ + roomDepth * 0.2, roomWidth * 0.22, roomDepth * 0.16, 0.13);
        addChair(deskX, centerZ - roomDepth * 0.08);
        addBox(deskX, 0.24, centerZ + roomDepth * 0.02, roomWidth * 0.09, 0.1, 0.015, materials.display);
      }
      addBox(centerX, 0.25, centerZ - roomDepth * 0.38, roomWidth * 0.55, 0.19, 0.016, materials.display);
      addBox(centerX, 0.36, centerZ - roomDepth * 0.38, roomWidth * 0.5, 0.018, 0.02, materials.appliance);
    }
  }

  const roomRows = [
    {
      z: -(corridorDepth / 2 + roomDepth / 2),
      rooms: [
        ["kitchen", 3.6], ["restaurant", 3.6], ["dormitory", 3.6], ["dormitory", 3.6],
        ["reception", 7.2], ["toilet", 3.6], ["store", 3.6], ["meeting", 7.2]
      ]
    },
    {
      z: corridorDepth / 2 + roomDepth / 2,
      rooms: [
        ["dormitory", 3.6], ["dormitory", 3.6], ["dormitory", 3.6], ["dormitory", 3.6],
        ["lobby", 7.2], ["security", 3.6], ["office", 3.6], ["office", 3.6], ["office", 3.6], ["control", 7.2]
      ]
    }
  ];

  const floor = new THREE.Mesh(boxGeometry, materials.baseFloor);
  floor.scale.set(width - 0.025, 0.025, depth - 0.025);
  floor.position.y = 0.025;
  floor.receiveShadow = false;
  interior.add(floor);
  const corridor = new THREE.Mesh(boxGeometry, materials.corridor);
  corridor.scale.set(width - 0.045, 0.012, corridorDepth - 0.012);
  corridor.position.y = 0.045;
  interior.add(corridor);

  // The cutaway uses low perimeter walls so the room arrangement reads clearly from above.
  addPartition(0, -depth / 2 + wallThickness / 2, width, wallThickness, materials.outer);
  addPartition(0, depth / 2 - wallThickness / 2, width, wallThickness, materials.outer);
  addPartition(-width / 2 + wallThickness / 2, 0, wallThickness, depth, materials.outer);
  addPartition(width / 2 - wallThickness / 2, 0, wallThickness, depth, materials.outer);

  for (const row of roomRows) {
    const rowSign = Math.sign(row.z);
    let xStart = -width / 2 + wallThickness;
    for (let i = 0; i < row.rooms.length; i++) {
      const [type, meters] = row.rooms[i];
      const roomWidth = meters * scale;
      const centerX = xStart + roomWidth / 2;
      const floorMaterial = type === "dormitory" ? materials.sleepFloor : ["office", "control", "security", "meeting", "reception", "lobby"].includes(type) ? materials.baseFloor : materials.serviceFloor;
      const roomFloor = new THREE.Mesh(boxGeometry, floorMaterial);
      roomFloor.scale.set(roomWidth - 0.012, 0.01, roomDepth - 0.01);
      roomFloor.position.set(centerX, 0.044, row.z);
      interior.add(roomFloor);
      addRoomFurniture(type, centerX, row.z, roomWidth, roomDepth);

      if (i > 0) addPartition(xStart, row.z, wallThickness, roomDepth - 0.01);

      const corridorZ = row.z - rowSign * (roomDepth / 2 + wallThickness / 2);
      const doorHalfWidth = 0.032;
      const doorwayStart = centerX - doorHalfWidth;
      const doorwayEnd = centerX + doorHalfWidth;
      if (doorwayStart - xStart > 0.012) {
        addPartition((xStart + doorwayStart) / 2, corridorZ, doorwayStart - xStart, wallThickness);
      }
      const roomEnd = xStart + roomWidth;
      if (roomEnd - doorwayEnd > 0.012) {
        addPartition((doorwayEnd + roomEnd) / 2, corridorZ, roomEnd - doorwayEnd, wallThickness);
      }
      addBox(centerX, 0.055, corridorZ, doorHalfWidth * 1.55, 0.012, 0.036, materials.woodLight);
      xStart = roomEnd;
    }
  }
  return interior;
}

export function createPvSurface(rows, bounds = rows.pvCrop, height = 0.52) {
  const positions = [], indices = [], colors = [];
  const variation = [0x182d35, 0x1d3440, 0x223943, 0x182b39, 0x243b43, 0x20333d, 0x183340, 0x233543, 0x1b3038, 0x243a42, 0x1c3540, 0x263b45, 0x1b303b];
  let vertex = 0;
  for (let zi = 0; zi < rows.zones.length; zi++) {
    const tint = new THREE.Color(variation[zi % variation.length]);
    for (const quad of rows.zones[zi].rows) {
      const corners = quad.map(([px, py]) => [
        (px - (bounds[0] + bounds[2]) / 2) * PT,
        (py - (bounds[1] + bounds[3]) / 2) * PT
      ]);
      for (const [x, z] of corners) {
        positions.push(x, height, z);
        colors.push(tint.r, tint.g, tint.b);
      }
      indices.push(vertex, vertex + 1, vertex + 2, vertex, vertex + 2, vertex + 3);
      vertex += 4;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.46, metalness: 0.18, side: THREE.DoubleSide }));
  mesh.name = "按总平面矢量复原的光伏排布";
  return mesh;
}

export async function createSiteScene(container, inspector) {
  const [rows, bessLayout, siteContours, campus] = await Promise.all([
    fetch(GEOMETRY).then(response => {
      if (!response.ok) throw new Error("场区矢量排布文件无法读取");
      return response.json();
    }),
    fetch("./assets/bess-equipment-layout.json").then(response => {
      if (!response.ok) throw new Error("储能设备矢量标注文件无法读取");
      return response.json();
    }),
    fetch("./assets/site-contours.json").then(response => {
      if (!response.ok) throw new Error("场区等高线数据无法读取");
      return response.json();
    }),
    fetch("./assets/bess-campus-layout.json?rev=2").then(response => {
      if (!response.ok) throw new Error("储能总平面定位文件无法读取");
      return response.json();
    })
  ]);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xe5e7e4);
  scene.fog = new THREE.Fog(0xe5e7e4, 95, 190);

  const aspect = container.clientWidth / container.clientHeight;
  const camera = new THREE.PerspectiveCamera(38, aspect, 0.1, 500);
  const initialTarget = new THREE.Vector3(2.9, 0, 1.5);
  // Screenshot overview: keep the same elevation; narrow screens only pull back.
  const overviewOffset = new THREE.Vector3(18.8, 12.2, 21.0);
  camera.position.copy(initialTarget).addScaledVector(overviewOffset, Math.max(1, 1.25 / aspect));
  const renderer = makeRenderer(container);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  scene.add(new THREE.HemisphereLight(0xf7fbff, 0xc2c3bd, 1.55));
  const sunlight = new THREE.DirectionalLight(0xfff3df, 2.25);
  sunlight.position.set(-26, 38, 24);
  sunlight.castShadow = true;
  sunlight.shadow.mapSize.set(1024, 1024);
  sunlight.shadow.camera.left = -26;
  sunlight.shadow.camera.right = 26;
  sunlight.shadow.camera.top = 28;
  sunlight.shadow.camera.bottom = -28;
  sunlight.shadow.bias = -0.0002;
  sunlight.shadow.normalBias = 0.03;
  scene.add(sunlight);
  const fillLight = new THREE.DirectionalLight(0xdce9ef, 0.48);
  fillLight.position.set(18, 16, -20);
  scene.add(fillLight);

  const [cropLeft, cropTop, cropRight, cropBottom] = rows.bessCrop;
  const assets = new THREE.Group();
  scene.add(assets);
  const pickTargets = new THREE.Group();
  scene.add(pickTargets);
  const pickMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, colorWrite: false, depthWrite: false, side: THREE.DoubleSide });
  function addBoundsPickProxy(source, cameraKey) {
    const bounds = new THREE.Box3().setFromObject(source), size = bounds.getSize(new THREE.Vector3());
    const proxy = new THREE.Mesh(new THREE.BoxGeometry(Math.max(size.x, 0.25), Math.max(size.y, 0.25), Math.max(size.z, 0.25)), pickMaterial);
    proxy.position.copy(bounds.getCenter(new THREE.Vector3()));
    tag(proxy, source.userData.kind, source.userData.title, source.userData.detail);
    proxy.userData.cameraKey = cameraKey;
    proxy.userData.arrivalKeys = source.userData.arrivalKeys || [];
    pickTargets.add(proxy);
  }
  const steel = new THREE.MeshStandardMaterial({ color: 0x71817d, roughness: 0.58, metalness: 0.28 });
  const wall = new THREE.MeshStandardMaterial({ color: 0xe4e1d9, roughness: 0.82 });
  const roof = new THREE.MeshStandardMaterial({ color: 0x7e8884, roughness: 0.72 });
  const concrete = new THREE.MeshStandardMaterial({ color: 0xbec3bf, roughness: 0.94 });
  const battery = new THREE.MeshStandardMaterial({ color: 0xdce3df, roughness: 0.66, metalness: 0.08 });
  const screen = new THREE.MeshStandardMaterial({ color: 0x56625e, roughness: 0.82 });
  const groundPoint = (pageX, pageY) => new THREE.Vector3((pageX - (cropLeft + cropRight) / 2) * PT, 0, (pageY - (cropTop + cropBottom) / 2) * PT);
  const displayBounds = new THREE.Box3().setFromPoints(
    [...campus.bessBoundary, ...campus.stationBoundary, ...campus.omBoundary, ...campus.fencePolyline].map(([x,y]) => groundPoint(x,y))
  ).expandByScalar(0.6);
  const groundSize = displayBounds.getSize(new THREE.Vector3());
  const groundCenter = displayBounds.getCenter(new THREE.Vector3());
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(groundSize.x, groundSize.z),
    new THREE.MeshStandardMaterial({ color: 0xd6d4cd, roughness: 1 }));
  ground.name = "储能配套展示地面";
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(groundCenter.x, -0.09, groundCenter.z);
  ground.receiveShadow = true;
  scene.add(ground);
  // The source contour lines are kept flat: the drawings do not provide enough elevation data to build a terrain mesh.
  const contourPositions = [];
  for (const [x0, y0, x1, y1] of siteContours.segments) {
    const a = groundPoint(x0, y0);
    const b = groundPoint(x1, y1);
    if (!displayBounds.containsPoint(a) || !displayBounds.containsPoint(b)) continue;
    contourPositions.push(a.x, -0.055, a.z, b.x, -0.055, b.z);
  }
  const contourGeometry = new THREE.BufferGeometry();
  contourGeometry.setAttribute("position", new THREE.Float32BufferAttribute(contourPositions, 3));
  const contours = new THREE.LineSegments(
    contourGeometry,
    new THREE.LineBasicMaterial({ color: 0x9ba19b, transparent: true, opacity: 0.34, depthWrite: false })
  );
  contours.name = "附图1 场区等高线（平面表达，不代表三维高程）";
  scene.add(contours);
  // One PDF coordinate frame: register the dedicated BESS sheet to the overall plan.
  const [minX, minY, maxX, maxY] = bessLayout.bounds;
  const [planScale, planX, planY] = campus.bessTransform;
  const bessOrigin = groundPoint(planX + (minX + maxX) / 2 * planScale, planY + (minY + maxY) / 2 * planScale);
  const bess = tag(new THREE.Group(), "bess", "储能设备区", "设备符号沿原图三条斜向长排布置，场坪轮廓依据《附图1 总平面布置图》。详图通过对应轮廓点统一缩放定位；柜体外形为展示概括，图面符号数量不作为采购数量。");
  bess.position.copy(bessOrigin);
  assets.add(bess);
  const bessPickGroup = new THREE.Group();
  bessPickGroup.position.copy(bessOrigin);
  pickTargets.add(bessPickGroup);
  const pointScale = planScale * PT;
  const localBessPoint = ([x, y]) => new THREE.Vector3(
    (x - (minX + maxX) / 2) * pointScale, 0,
    (y - (minY + maxY) / 2) * pointScale
  );
  const boundary = campus.bessBoundary.map(([x,y]) => groundPoint(x,y).sub(bessOrigin));
  const bessLocalBounds = new THREE.Box3().setFromPoints(boundary);
  const bessAreaProxy = new THREE.Mesh(new THREE.BoxGeometry(bessLocalBounds.max.x-bessLocalBounds.min.x, 0.025, bessLocalBounds.max.z-bessLocalBounds.min.z), pickMaterial);
  bessAreaProxy.position.set((bessLocalBounds.min.x+bessLocalBounds.max.x)/2, 0.145, (bessLocalBounds.min.z+bessLocalBounds.max.z)/2);
  tag(bessAreaProxy, "bess", bess.userData.title, bess.userData.detail);
  bessAreaProxy.userData.cameraKey = "bess";
  bessAreaProxy.userData.arrivalKeys = ["bess-cabinet", "pcs"];
  bessPickGroup.add(bessAreaProxy);
  const yardGeometry = new THREE.BufferGeometry();
  yardGeometry.setAttribute("position", new THREE.Float32BufferAttribute(boundary.flatMap(point => [point.x, 0, point.z]), 3));
  const yardIndices = [];
  for (let i = 1; i < boundary.length - 1; i++) yardIndices.push(0, i, i + 1);
  yardGeometry.setIndex(yardIndices);
  yardGeometry.computeVertexNormals();
  const yard = new THREE.Mesh(yardGeometry, new THREE.MeshStandardMaterial({ color: 0xd4d8d4, roughness: 0.96, side: THREE.DoubleSide }));
  yard.name = "按储能总平面外轮廓复原的场地地面";
  yard.position.set(0, 0.12, 0);
  yard.receiveShadow = true;
  bess.add(yard);
  const bessRoadMat = new THREE.MeshStandardMaterial({ color: 0x858e89, roughness: 0.96, metalness: 0.01 });
  for (const aisle of campus.aisles) {
    addRoadStrip(bess, aisle.map(([x,y]) => groundPoint(x,y).sub(bessOrigin)), 0.14, bessRoadMat, "原总平面设备排间检修通道", 0.135, false);
  }
  const batteryCoords = bessLayout.symbols.battery;
  const batteryCabinetGeometry = new THREE.BoxGeometry(0.25, 0.9, 0.22);
  const batteryCapGeometry = new THREE.BoxGeometry(0.27, 0.05, 0.24);
  const batteryCabinets = new THREE.InstancedMesh(batteryCabinetGeometry, battery, batteryCoords.length);
  const batteryPickProxy = new THREE.InstancedMesh(new THREE.BoxGeometry(0.33, 1.02, 0.3), pickMaterial, batteryCoords.length);
  tag(batteryPickProxy, "bess", bess.userData.title, bess.userData.detail);
  batteryPickProxy.userData.cameraKey = "bess";
  batteryPickProxy.userData.arrivalKeys = ["bess-cabinet"];
  const batteryCaps = new THREE.InstancedMesh(batteryCapGeometry, roof, batteryCoords.length);
  const batteryVentGeometry = new THREE.BoxGeometry(0.09, 0.012, 0.008);
  const batteryHandleGeometry = new THREE.BoxGeometry(0.014, 0.1, 0.016);
  const batteryBadgeGeometry = new THREE.BoxGeometry(0.045, 0.065, 0.008);
  const batteryVentMaterial = screen;
  const batteryBadgeMaterial = new THREE.MeshStandardMaterial({ color: 0xd8c69e, roughness: 0.82 });
  const batteryLedMaterial = new THREE.MeshStandardMaterial({ color: 0x7b9c77, emissive: 0x223b1e, roughness: 0.48 });
  const batteryVents = new THREE.InstancedMesh(batteryVentGeometry, batteryVentMaterial, batteryCoords.length * 4);
  const batteryHandles = new THREE.InstancedMesh(batteryHandleGeometry, steel, batteryCoords.length);
  const batteryBadges = new THREE.InstancedMesh(batteryBadgeGeometry, batteryBadgeMaterial, batteryCoords.length);
  const batteryLeds = new THREE.InstancedMesh(new THREE.BoxGeometry(0.018, 0.018, 0.009), batteryLedMaterial, batteryCoords.length);
  const detailPose = new THREE.Object3D();
  const equipmentAngle = Math.atan2(4.44, 5.34); // Rectangle edge from the source BESS symbol.
  detailPose.rotation.y = equipmentAngle;
  detailPose.scale.y = 0.45;
  const setEquipmentPose = (point, x, y, z) => {
    // Rotate the cabinet and every attached detail together, while keeping PDF symbol centers.
    detailPose.position.set(point.x + x * Math.cos(equipmentAngle) + z * Math.sin(equipmentAngle), y * 0.45 + 0.075,
      point.z - x * Math.sin(equipmentAngle) + z * Math.cos(equipmentAngle));
  };
  let ventInstance = 0;
  for (let unitIndex = 0; unitIndex < batteryCoords.length; unitIndex++) {
    const coordinate = batteryCoords[unitIndex];
    const point = localBessPoint(coordinate);
    setEquipmentPose(point, 0, 0.55, 0);
    detailPose.updateMatrix();
    batteryCabinets.setMatrixAt(unitIndex, detailPose.matrix);
    batteryPickProxy.setMatrixAt(unitIndex, detailPose.matrix);
    setEquipmentPose(point, 0, 0.95, 0);
    detailPose.updateMatrix();
    batteryCaps.setMatrixAt(unitIndex, detailPose.matrix);
    for (let vent = 0; vent < 4; vent++) {
      setEquipmentPose(point, 0, 0.38 + vent * 0.055, 0.117);
      detailPose.updateMatrix();
      batteryVents.setMatrixAt(ventInstance++, detailPose.matrix);
    }
    setEquipmentPose(point, 0.082, 0.56, 0.122);
    detailPose.updateMatrix();
    batteryHandles.setMatrixAt(unitIndex, detailPose.matrix);
    setEquipmentPose(point, -0.072, 0.84, 0.122);
    detailPose.updateMatrix();
    batteryBadges.setMatrixAt(unitIndex, detailPose.matrix);
    setEquipmentPose(point, 0.076, 0.84, 0.123);
    detailPose.updateMatrix();
    batteryLeds.setMatrixAt(unitIndex, detailPose.matrix);
  }
  for (const repeated of [batteryCabinets, batteryCaps, batteryVents, batteryHandles, batteryBadges, batteryLeds]) {
    repeated.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    repeated.computeBoundingSphere();
    repeated.castShadow = repeated === batteryCabinets;
    repeated.receiveShadow = repeated === batteryCabinets;
    bess.add(repeated);
  }
  batteryPickProxy.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  batteryPickProxy.computeBoundingSphere();
  bessPickGroup.add(batteryPickProxy);

  const pcsCoords = bessLayout.symbols.pcs;
  const pcsBodies = new THREE.InstancedMesh(new THREE.BoxGeometry(0.23, 0.66, 0.2), steel, pcsCoords.length);
  const pcsPickProxy = new THREE.InstancedMesh(new THREE.BoxGeometry(0.32, 0.78, 0.3), pickMaterial, pcsCoords.length);
  tag(pcsPickProxy, "bess", bess.userData.title, bess.userData.detail);
  pcsPickProxy.userData.cameraKey = "bess";
  pcsPickProxy.userData.arrivalKeys = ["pcs"];
  const pcsPanels = new THREE.InstancedMesh(new THREE.BoxGeometry(0.17, 0.42, 0.01), screen, pcsCoords.length);
  const pcsVents = new THREE.InstancedMesh(new THREE.BoxGeometry(0.1, 0.012, 0.008), screen, pcsCoords.length * 5);
  const pcsDisplays = new THREE.InstancedMesh(new THREE.BoxGeometry(0.065, 0.042, 0.01), batteryBadgeMaterial, pcsCoords.length);
  let pcsVentInstance = 0;
  for (let unitIndex = 0; unitIndex < pcsCoords.length; unitIndex++) {
    const coordinate = pcsCoords[unitIndex];
    const point = localBessPoint(coordinate);
    setEquipmentPose(point, 0, 0.45, 0);
    detailPose.updateMatrix();
    pcsBodies.setMatrixAt(unitIndex, detailPose.matrix);
    pcsPickProxy.setMatrixAt(unitIndex, detailPose.matrix);
    setEquipmentPose(point, 0, 0.5, 0.105);
    detailPose.updateMatrix();
    pcsPanels.setMatrixAt(unitIndex, detailPose.matrix);
    setEquipmentPose(point, 0, 0.6, 0.112);
    detailPose.updateMatrix();
    pcsDisplays.setMatrixAt(unitIndex, detailPose.matrix);
    for (let vent = 0; vent < 5; vent++) {
      setEquipmentPose(point, 0, 0.27 + vent * 0.036, 0.111);
      detailPose.updateMatrix();
      pcsVents.setMatrixAt(pcsVentInstance++, detailPose.matrix);
    }
  }
  for (const repeated of [pcsBodies, pcsPanels, pcsVents, pcsDisplays]) {
    repeated.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    repeated.computeBoundingSphere();
    repeated.castShadow = repeated === pcsBodies;
    repeated.receiveShadow = repeated === pcsBodies;
    bess.add(repeated);
  }
  pcsPickProxy.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  pcsPickProxy.computeBoundingSphere();
  bessPickGroup.add(pcsPickProxy);
  const transformerCoords = bessLayout.symbols.transformer;
  const transformerTanks = new THREE.InstancedMesh(new THREE.BoxGeometry(0.45, 0.78, 0.42), concrete, transformerCoords.length);
  const transformerPickProxy = new THREE.InstancedMesh(new THREE.BoxGeometry(0.58, 0.96, 0.55), pickMaterial, transformerCoords.length);
  tag(transformerPickProxy, "bess", bess.userData.title, bess.userData.detail);
  transformerPickProxy.userData.cameraKey = "bess";
  const transformerRadiators = new THREE.InstancedMesh(new THREE.BoxGeometry(0.03, 0.6, 0.32), steel, transformerCoords.length * 3);
  let radiatorInstance = 0;
  for (let unitIndex = 0; unitIndex < transformerCoords.length; unitIndex++) {
    const coordinate = transformerCoords[unitIndex];
    const point = localBessPoint(coordinate);
    for (let rib = 0; rib < 3; rib++) {
      setEquipmentPose(point, -0.25 - rib * 0.04, 0.57, 0);
      detailPose.updateMatrix();
      transformerRadiators.setMatrixAt(radiatorInstance++, detailPose.matrix);
    }
    setEquipmentPose(point, 0, 0.52, 0);
    detailPose.updateMatrix();
    transformerTanks.setMatrixAt(unitIndex, detailPose.matrix);
    transformerPickProxy.setMatrixAt(unitIndex, detailPose.matrix);
  }
  for (const repeated of [transformerTanks, transformerRadiators]) {
    repeated.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    repeated.computeBoundingSphere();
    bess.add(repeated);
  }
  transformerPickProxy.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  transformerPickProxy.computeBoundingSphere();
  bessPickGroup.add(transformerPickProxy);
  addSiteLabel(scene, "储能区 · 431 MWh", [bessOrigin.x, 1.6, bessOrigin.z], 5.4);

  const stationOrigin = groundPoint(521.34, 961.78);
  const station = tag(new THREE.Group(), "ipp-station", "33/132 kV 开关站设备区", "位置和斜向朝向按《附图1 总平面布置图》的站区轮廓表达；站内设备形态为概括展示，未据此推定最终设备数量或施工尺寸。");
  station.userData.arrivalKeys = ["main-transformer"];
  station.position.copy(stationOrigin);
  station.scale.setScalar(0.56);
  station.rotation.y = Math.atan2(48.42, 58.14);
  assets.add(station);
  const stationPad = new THREE.Mesh(new THREE.BoxGeometry(10.8, 0.18, 7.6), concrete);
  stationPad.position.y = 0.12;
  station.add(stationPad);
  for (let i = 0; i < 2; i++) {
    const xf = new THREE.Group();
    xf.position.set(-2.15 + i * 4.3, 0, -0.65);
    const tank = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.0, 1.7), concrete);
    tank.position.y = 0.77;
    xf.add(tank);
    for (let rib = 0; rib < 5; rib++) {
      const radiator = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.84, 1.05), steel);
      radiator.position.set(-0.92 - rib * 0.09, 0.72, 0);
      xf.add(radiator);
    }
    const conservator = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 1.15, 10), steel);
    conservator.rotation.z = Math.PI / 2;
    conservator.position.set(0, 1.5, -0.25);
    xf.add(conservator);
    station.add(xf);
  }
  for (const x of [-3.4, 0, 3.4]) {
    for (const z of [-2.65, 2.45]) {
      const postA = new THREE.Mesh(new THREE.BoxGeometry(0.1, 3.2, 0.1), steel);
      postA.position.set(x - 0.8, 1.72, z);
      const postB = postA.clone();
      postB.position.x = x + 0.8;
      const beam = new THREE.Mesh(new THREE.BoxGeometry(1.85, 0.11, 0.12), steel);
      beam.position.set(x, 3.3, z);
      station.add(postA, postB, beam);
    }
  }
  const controlRoom = new THREE.Mesh(new THREE.BoxGeometry(3.4, 1.45, 1.8), wall);
  controlRoom.position.set(0, 0.92, 2.55);
  station.add(controlRoom);
  const controlRoof = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.15, 2), roof);
  controlRoof.position.set(0, 1.72, 2.55);
  station.add(controlRoof);
  addSiteLabel(scene, "开关站 · 33 / 132 kV", [stationOrigin.x, 2.5, stationOrigin.z], 5.6);

  const siteBoundary = new THREE.Group();
  siteBoundary.name = "原总平面场坪与院落边界";
  assets.add(siteBoundary);
  const outlineMaterial = new THREE.LineBasicMaterial({ color: 0x716960 });
  for (const [name, points] of [["储能场坪边界", campus.bessBoundary], ["开关站区边界", campus.stationBoundary], ["运维场坪边界", campus.omBoundary]]) {
    const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points.map(([x,y]) => groundPoint(x,y).setY(0.15))), outlineMaterial);
    line.name = name;
    siteBoundary.add(line);
  }
  const perimeterFence = new THREE.Group();
  perimeterFence.name = "总平面粉色FENCE围栏（局部）";
  siteBoundary.add(perimeterFence);
  addFenceLoopWithGate(perimeterFence, campus.fencePolyline.map(([x,y]) => groundPoint(x,y)),
    {closed: false, gateEdgeIndex: campus.fenceGate.edgeIndex, gateT: campus.fenceGate.t, gateWidth: 0.65, height: 0.52});
  const roadMaterial = new THREE.MeshStandardMaterial({color: 0x858e89, roughness: 0.97, side: THREE.DoubleSide});
  for (const [index, points] of campus.roads.entries()) {
    // The west approach exits the crop horizontally; retain its intersection
    // with the ground edge so the road still crosses the perimeter entrance.
    const visiblePoints = points.map(([x,y]) => displayBounds.clampPoint(groundPoint(x,y), new THREE.Vector3()));
    addRoadStrip(scene, visiblePoints, 0.31, roadMaterial, ["原图西侧弯道及储能接入", "原图运维院落接入", "西侧来路接入（沿图面路廊）"][index], 0.045, false);
  }

  function addOmCompound(pageX, pageY, label) {
    const origin = groundPoint(pageX, pageY);
    const group = tag(new THREE.Group(), "om", label, "按《附图4-1 运维区总平面布置图》复原综合泵房、运维楼、警卫室和危险品库（Chemical Store）的相对位置；运维院落轮廓与入口依据《附图1》表达，与储能场坪和开关站区分别定位。主楼开间参考《附图4-2》，警卫室参考《附图4-3》。");
    group.position.copy(origin);
    group.scale.setScalar(1);
    assets.add(group);
    const base = new THREE.Mesh(new THREE.BoxGeometry(4.98, 0.14, 4.08), concrete);
    base.position.y = 0.13;
    group.add(base);
    const glazed = new THREE.MeshStandardMaterial({ color: 0x547079, roughness: 0.32, metalness: 0.12 });
    const omWall = new THREE.MeshStandardMaterial({ color: 0xd6d1bf, roughness: 0.82 });
    const omRoof = new THREE.MeshStandardMaterial({ color: 0x788780, roughness: 0.72 });
    const omAccent = new THREE.MeshStandardMaterial({ color: 0x80504b, roughness: 0.76 });
    const addBuilding = (key, title, x, z, sx, sz, height, note, roofStyle = "flat") => {
      const building = tag(new THREE.Group(), key, title, note);
      building.position.set(x, 0.2, z);
      const exterior = new THREE.Group();
      exterior.name = `${title}外观`;
      building.add(exterior);
      const shell = new THREE.Mesh(new THREE.BoxGeometry(sx, height, sz), omWall);
      shell.position.y = height / 2;
      shell.castShadow = true;
      shell.receiveShadow = true;
      exterior.add(shell);
      if (roofStyle === "gable") {
        addGableRoof(exterior, sx, sz, height + 0.02, 0.34, omRoof, omWall);
      } else {
        const roofMesh = new THREE.Mesh(new THREE.BoxGeometry(sx + 0.12, 0.12, sz + 0.12), omRoof);
        roofMesh.position.y = height + 0.06;
        exterior.add(roofMesh);
      }
      const windowCount = roofStyle === "gable" ? 10 : Math.max(2, Math.floor(sx / 0.42));
      for (let i = 0; i < windowCount; i++) {
        const xw = -sx * 0.42 + i * (sx * 0.84 / Math.max(1, windowCount - 1));
        const windowWidth = Math.min(0.18, sx / 10.5);
        for (const side of [-1, 1]) {
          const z = side * (sz / 2 + 0.02);
          const frame = new THREE.Mesh(new THREE.BoxGeometry(windowWidth + 0.045, 0.31, 0.035), steel);
          frame.position.set(xw, height * 0.57, z);
          const glass = new THREE.Mesh(new THREE.BoxGeometry(windowWidth, 0.25, 0.04), glazed);
          glass.position.set(xw, height * 0.57, z + side * 0.012);
          const mullion = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.25, 0.044), omWall);
          mullion.position.set(xw, height * 0.57, z + side * 0.018);
          const sill = new THREE.Mesh(new THREE.BoxGeometry(windowWidth + 0.07, 0.025, 0.075), omRoof);
          sill.position.set(xw, height * 0.57 - 0.15, z + side * 0.028);
          exterior.add(frame, glass, mullion, sill);
        }
      }
      if (roofStyle === "gable") {
        const ridgeY = height + 0.36;
        const seams = [];
        for (let i = 0; i <= 8; i++) {
          const x = -sx * 0.46 + i * sx * 0.115;
          for (const side of [-1, 1]) {
            seams.push(x, height + 0.02, side * (sz / 2 + 0.055), x, ridgeY, side * 0.008);
          }
        }
        const seamGeometry = new THREE.BufferGeometry();
        seamGeometry.setAttribute("position", new THREE.Float32BufferAttribute(seams, 3));
        exterior.add(new THREE.LineSegments(seamGeometry, new THREE.LineBasicMaterial({ color: 0x9da8a2, transparent: true, opacity: 0.55 })));
        for (const side of [-1, 1]) {
          const gutter = new THREE.Mesh(new THREE.BoxGeometry(sx + 0.16, 0.045, 0.045), steel);
          gutter.position.set(0, height, side * (sz / 2 + 0.065));
          exterior.add(gutter);
          for (const x of [-sx / 2 + 0.035, sx / 2 - 0.035]) {
            const downpipe = new THREE.Mesh(new THREE.BoxGeometry(0.025, height * 0.86, 0.03), steel);
            downpipe.position.set(x, height * 0.45, side * (sz / 2 + 0.065));
            exterior.add(downpipe);
          }
        }
        for (const side of [-1, 1]) {
          const accent = new THREE.Mesh(new THREE.BoxGeometry(sx * 0.13, height * 0.86, 0.045), omAccent);
          accent.position.set(side * sx * 0.36, height * 0.52, sz / 2 + 0.035);
          exterior.add(accent);
          const rearAccent = accent.clone();
          rearAccent.position.z = -sz / 2 - 0.035;
          exterior.add(rearAccent);
        }
        const canopy = new THREE.Mesh(new THREE.BoxGeometry(1.28, 0.075, 0.42), omRoof);
        canopy.position.set(0, height * 0.77, sz / 2 + 0.22);
        canopy.castShadow = true;
        exterior.add(canopy);
        for (const xpost of [-0.48, 0.48]) {
          const support = new THREE.Mesh(new THREE.BoxGeometry(0.045, height * 0.68, 0.045), steel);
          support.position.set(xpost, height * 0.39, sz / 2 + 0.42);
          exterior.add(support);
        }
        const entry = new THREE.Mesh(new THREE.BoxGeometry(0.24, height * 0.58, 0.045), glazed);
        entry.position.set(0, height * 0.31, sz / 2 + 0.035);
        const entryFrame = new THREE.Mesh(new THREE.BoxGeometry(0.29, height * 0.63, 0.04), steel);
        entryFrame.position.set(0, height * 0.32, sz / 2 + 0.028);
        const entryHandle = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.11, 0.024), omAccent);
        entryHandle.position.set(0.085, height * 0.3, sz / 2 + 0.07);
        exterior.add(entryFrame, entry, entryHandle);
        for (const step of [0, 1]) {
          const stair = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.035, 0.16), concrete);
          stair.position.set(0, 0.025 + step * 0.035, sz / 2 + 0.08 + step * 0.14);
          exterior.add(stair);
        }
        const plaqueCanvas = document.createElement("canvas");
        plaqueCanvas.width = 640;
        plaqueCanvas.height = 128;
        const plaqueContext = plaqueCanvas.getContext("2d");
        plaqueContext.fillStyle = "#f5f4ee";
        plaqueContext.fillRect(0, 0, plaqueCanvas.width, plaqueCanvas.height);
        plaqueContext.fillStyle = "#e47c32";
        plaqueContext.fillRect(0, 0, 16, plaqueCanvas.height);
        plaqueContext.fillStyle = "#27312e";
        plaqueContext.font = "600 46px Arial, Microsoft YaHei, sans-serif";
        plaqueContext.textAlign = "center";
        plaqueContext.textBaseline = "middle";
        plaqueContext.fillText("运维楼 · O&M BUILDING", 330, 66, 590);
        const plaqueTexture = new THREE.CanvasTexture(plaqueCanvas);
        plaqueTexture.colorSpace = THREE.SRGBColorSpace;
        const plaque = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.15, 0.025), omAccent);
        plaque.position.set(0, height * 0.84, sz / 2 + 0.045);
        const plaqueFace = new THREE.Mesh(new THREE.PlaneGeometry(0.75, 0.12), new THREE.MeshBasicMaterial({ map: plaqueTexture, toneMapped: false }));
        plaqueFace.position.set(0, height * 0.84, sz / 2 + 0.061);
        exterior.add(plaque, plaqueFace);
      }
      building.userData.exteriorGroup = exterior;
      group.add(building);
      return building;
    };
    const omBuilding = addBuilding("om-building", "运维楼", 0.88, -1.16, 2.82, 1.02, 1.08, "建筑位置、朝向与长宽比例按巴法拉内《附图4-1/4-2》表达；坡屋顶、深色屋面、立面点缀和入口雨棚参考2026-05-26替代概念效果图。概念文件标题栏属于其他项目，本模型仅借外观语言，不沿用其总平面或尺寸。", "gable");
    const omInterior = addOmFloorCutaway(omBuilding, 2.82, 1.02);
    addBuilding("pump-station", "综合泵房", -1.42, -1.12, 0.88, 1.62, 0.86, "位置和朝向依据《附图4-1 运维区总平面布置图》；立面细节为展示表达。");
    addBuilding("guard-room", "警卫室", -1.42, 1.18, 0.58, 0.41, 0.74, "《附图4-3 警卫室平面图》外轮廓约8.9 m × 6.3 m；按运维区总平面位置复原。");
    addBuilding("chemical-store", "危险品库（Chemical Store）", 1.72, 1.18, 0.64, 0.58, 0.74, "位置依据《附图4-1 运维区总平面布置图》中的 Chemical Store 标注；建筑外形为展示表达。");
    const siteLabel = addSiteLabel(scene, label.toUpperCase(), [origin.x, 2.55, origin.z], 5.8);
    return { group, omBuilding, omInterior, siteLabel };
  }
  const { group: omCompound, omBuilding, omInterior, siteLabel: omSiteLabel } = addOmCompound(504, 884, "运维楼及配套设施");
  scene.updateMatrixWorld(true);
  addBoundsPickProxy(station, "switchyard");
  addBoundsPickProxy(omCompound, "om");

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(initialTarget);
  controls.enableDamping = true;
  controls.dampingFactor = 0.055;
  controls.minDistance = 3.5;
  controls.maxDistance = 110;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.update();
  const initialCameraPosition = camera.position.clone();
  const omOrigin = groundPoint(504, 884);
  const omBuildingTarget = omOrigin.clone().add(new THREE.Vector3(0.88, 0.48, -1.16));
  const interactions = attachSiteInteractions({
    camera,
    controls,
    renderer,
    pickTargets,
    inspector,
    initialCameraPosition,
    initialTarget,
    cameraTargets: [
      { key: "bess", object: bess, target: bessOrigin.clone().add(new THREE.Vector3(0, 0.8, 0)), distance: 17 },
      { key: "switchyard", object: station, target: stationOrigin.clone().add(new THREE.Vector3(0, 0.8, 0)), distance: 13 },
      { key: "om", object: omCompound, target: omOrigin.clone().add(new THREE.Vector3(0, 0.8, 0)), distance: 12 }
    ]
  });
  const omInteriorButton = document.querySelector("[data-om-interior]");
  let omInteriorActive = false;
  const setOmInteriorMode = active => {
    omInteriorActive = active;
    omBuilding.userData.exteriorGroup.visible = !active;
    omInterior.visible = active;
    omSiteLabel.visible = !active;
    if (omInteriorButton) {
      omInteriorButton.setAttribute("aria-pressed", String(active));
      omInteriorButton.textContent = active ? "恢复外观" : "室内";
    }
  };
  const toggleOmInterior = () => {
    const active = !omInteriorActive;
    setOmInteriorMode(active);
    if (active) {
      interactions.focusPoint(omBuildingTarget.clone().add(new THREE.Vector3(0, 0.12, 0)), 5.6, "运维楼室内透视", "室内房间顺序、中央走廊和使用功能依据《附图4-2 运维楼平面图》重建：接待与会议、中控与办公室、厨房餐厅、宿舍、卫生间和储藏室。室内设备和家具为比例化展示模型。");
    } else {
      interactions.focusView("om");
    }
  };
  interactions.bindInteriorToggle(toggleOmInterior);
  scene.userData.toggleOmInterior = toggleOmInterior;
  let viewportScale = Math.max(1, 1.25 / aspect);
  const onResize = () => {
    const nextScale = Math.max(1, 1.25 / camera.aspect);
    if (Math.abs(nextScale - viewportScale) < 1e-9) return;
    interactions.stopTour();
    controls.update();
    camera.position.sub(controls.target).multiplyScalar(nextScale / viewportScale).add(controls.target);
    viewportScale = nextScale;
    controls.update();
  };
  scene.userData.reset = () => {
    if (omInteriorActive) setOmInteriorMode(false);
    viewportScale = Math.max(1, 1.25 / camera.aspect);
    initialCameraPosition.copy(initialTarget).addScaledVector(overviewOffset, viewportScale);
    interactions.reset();
  };
  scene.userData.stopTour = interactions.stopTour;
  return { scene, camera, renderer, controls, onResize };
}
