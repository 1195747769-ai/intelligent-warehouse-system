import * as THREE from "three";

export function makeRenderer(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.98;
  container.replaceChildren(renderer.domElement);
  return renderer;
}

export function addLights(scene) {
  scene.add(new THREE.HemisphereLight(0xd7e8e4, 0x514638, 1.35));
  const sun = new THREE.DirectionalLight(0xffedce, 2.0);
  sun.position.set(-70, 110, 65);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -100; sun.shadow.camera.right = 100;
  sun.shadow.camera.top = 100; sun.shadow.camera.bottom = -100;
  scene.add(sun);
}

export function material(color, roughness = 0.78, metalness = 0) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

export function box(parent, size, position, mat, name = "") {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), mat);
  mesh.position.set(...position);
  mesh.castShadow = true; mesh.receiveShadow = true; mesh.name = name;
  parent.add(mesh); return mesh;
}

export function line(parent, points, color, opacity = 1, radius = 0.035) {
  const curve = new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(...p)));
  const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(24, points.length * 5), radius, 6, false), new THREE.MeshStandardMaterial({ color, roughness: 0.68, transparent: opacity < 1, opacity }));
  parent.add(mesh); return mesh;
}

export function tag(group, kind, title, detail) {
  group.userData.pickable = true;
  group.userData.kind = kind;
  group.userData.title = title;
  group.userData.detail = detail;
  return group;
}

export function addSiteFences(parent, width, depth, color = 0x7d8b76) {
  const postMat = material(color);
  const postGeo = new THREE.CylinderGeometry(0.035, 0.045, 1.2, 5);
  const wireMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.52 });
  const points = [[-width/2,-depth/2],[width/2,-depth/2],[width/2,depth/2],[-width/2,depth/2]];
  for (let e=0;e<4;e++) {
    const a=points[e], b=points[(e+1)%4], len=Math.hypot(b[0]-a[0],b[1]-a[1]), n=Math.ceil(len/3);
    for (let i=0;i<=n;i++) {
      const t=i/n, post=new THREE.Mesh(postGeo,postMat); post.position.set(a[0]+(b[0]-a[0])*t,.6,a[1]+(b[1]-a[1])*t); parent.add(post);
    }
    for (const y of [.35,.85]) {
      const pts=[new THREE.Vector3(a[0],y,a[1]),new THREE.Vector3(b[0],y,b[1])];
      parent.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),wireMat));
    }
  }
}

export function addLabelSprite(scene, text, position, tint = "#e7eee3") {
  const canvas = document.createElement("canvas"); canvas.width = 512; canvas.height = 96;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "rgba(16,25,30,.82)"; ctx.fillRect(4,8,504,80);
  ctx.strokeStyle = "rgba(205,190,145,.65)"; ctx.lineWidth=2; ctx.strokeRect(5,9,502,78);
  ctx.fillStyle=tint; ctx.font="500 32px Arial, Microsoft YaHei, sans-serif"; ctx.textAlign="center"; ctx.textBaseline="middle"; ctx.fillText(text,256,48);
  const texture=new THREE.CanvasTexture(canvas); texture.colorSpace=THREE.SRGBColorSpace;
  const sprite=new THREE.Sprite(new THREE.SpriteMaterial({map:texture,transparent:true,depthTest:false}));
  sprite.scale.set(15,2.8,1); sprite.position.set(...position); scene.add(sprite); return sprite;
}
