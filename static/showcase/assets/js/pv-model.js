import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { addLabelSprite, addLights, makeRenderer } from "./scene-kit.js?rev=57";
import { createPvSurface } from "./site-model.js";
import { createPvPrincipleModel, PV_STEPS } from "./pv-principle-model.js?rev=55";

const PT = 0.08;

export async function createPvScene(container, inspector) {
  const page = document.getElementById("pv");
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, container.clientWidth / container.clientHeight, 0.1, 900);
  const renderer = makeRenderer(container);
  renderer.shadowMap.enabled = false;
  addLights(scene);

  // Build the large drawing-based scene only when the user opens layout mode.
  const layout = new THREE.Group();
  layout.visible = false;
  let layoutPromise = null;
  let pvSurface = null;
  function ensureLayout() {
    if (layoutPromise) return layoutPromise;
    layoutPromise = (async () => {
      const rows = await fetch("./assets/site-plan-rows.json").then(response => {
        if (!response.ok) throw new Error("光伏分区矢量文件无法读取");
        return response.json();
      });
      const [left, top, right, bottom] = rows.pvCrop;
      const width = (right - left) * PT, depth = (bottom - top) * PT;
      const ground = new THREE.Mesh(new THREE.PlaneGeometry(width + 22, depth + 22), new THREE.MeshStandardMaterial({ color: 0x77765f, roughness: 1 }));
      ground.rotation.x = -Math.PI / 2;
      ground.position.y = -0.08;
      layout.add(ground);
      const texture = await new THREE.TextureLoader().loadAsync("./assets/pv-plan-underlay.png");
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 4);
      const plan = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity: 0.86, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
      plan.rotation.x = -Math.PI / 2;
      plan.position.y = 0.015;
      layout.add(plan);
      pvSurface = createPvSurface(rows, rows.pvCrop, 0.58);
      layout.add(pvSurface);
      addLabelSprite(layout, "PV ZONES · 01–13", [0, 8.5, -depth * 0.48], "#e1e9dd");
      const grid = new THREE.GridHelper(Math.max(width, depth) + 20, 48, 0x718079, 0x536258);
      grid.position.y = -0.075;
      grid.material.transparent = true;
      grid.material.opacity = 0.13;
      layout.add(grid);
      scene.add(layout);
      return layout;
    })().catch(error => {
      layoutPromise = null;
      throw error;
    });
    return layoutPromise;
  }

  const demo = createPvPrincipleModel();
  scene.add(demo.root);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.055;
  controls.maxPolarAngle = Math.PI * 0.49;
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let mode = "principle", step = 0, playing = false, paused = false;
  let elapsed = 0, lastFrame = 0, transition = null;
  const modeButtons = [...page.querySelectorAll("[data-pv-mode]")];
  const stepButtons = [...page.querySelectorAll("[data-pv-step]")];
  const focusButtons = [...page.querySelectorAll("[data-pv-focus]")];
  const playButton = page.querySelector("[data-pv-play]");
  const stowButton = page.querySelector("[data-pv-stow]");
  const q = selector => page.querySelector(selector);

  function explain(kicker, title, detail) {
    inspector.querySelector("[data-pv-step-kicker]").textContent = kicker;
    inspector.querySelector("h3").textContent = title;
    inspector.querySelector("p").textContent = detail;
  }
  function syncArrivalSelection(focusKey) {
    const keys=focusKey==="inverter"?["pv-inverter"]:focusKey==="block-transformer"?["pv-transformer"]:[];
    window.dispatchEvent(new CustomEvent("baphalane-arrival-focus",{detail:{keys}}));
  }
  function cameraTo(position, target, immediate = false) {
    transition = null;
    if (immediate || reducedMotion) {
      camera.position.copy(position);
      controls.target.copy(target);
      controls.update();
    } else {
      transition = { from: camera.position.clone(), fromTarget: controls.target.clone(), position, target, elapsed: 0 };
    }
  }
  function focus(key, immediate = false) {
    const target = demo.targets[key];
    if (!target) return;
    const narrow = container.clientWidth / container.clientHeight < 1.2;
    const offset = new THREE.Vector3(13, 10, 23).multiplyScalar(narrow ? 1.5 : 1);
    cameraTo(target.clone().add(offset), target.clone(), immediate);
    focusButtons.forEach(button => button.setAttribute("aria-pressed", String(button.dataset.pvFocus === key)));
  }
  function reset() {
    if (mode === "layout") {
      const portrait = container.clientWidth / container.clientHeight < 1.25;
      cameraTo(new THREE.Vector3(portrait ? 115 : 85, portrait ? 230 : 92, portrait ? 145 : 110), new THREE.Vector3(), true);
      return;
    }
    const bounds = new THREE.Box3().setFromObject(demo.root);
    const center = bounds.getCenter(new THREE.Vector3());
    const aspect = container.clientWidth / container.clientHeight;
    const direction = new THREE.Vector3(0.18, 0.48, 1).normalize();
    camera.position.copy(center).add(direction);
    camera.lookAt(center);
    const inverse = camera.quaternion.clone().invert();
    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    let distance = 0;
    for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
      const corner = new THREE.Vector3(x, y, z).sub(center).applyQuaternion(inverse);
      distance = Math.max(distance, corner.z + Math.abs(corner.x) / (tanV * aspect), corner.z + Math.abs(corner.y) / tanV);
    }
    distance *= 1.12;
    cameraTo(center.clone().addScaledVector(direction, distance), center, true);
    focusButtons.forEach(button => button.setAttribute("aria-pressed", "false"));
  }
  function syncPlayback() {
    playButton.textContent = playing ? "暂停讲解" : paused ? "继续讲解" : "自动讲解";
    playButton.setAttribute("aria-pressed", String(playing));
  }
  function selectStep(index, manual = false) {
    step = (index + PV_STEPS.length) % PV_STEPS.length;
    if (manual) { playing = false; paused = false; elapsed = 0; syncPlayback(); }
    demo.setStep(step);
    stepButtons.forEach(button => button.setAttribute("aria-pressed", String(Number(button.dataset.pvStep) === step)));
    explain("STEP " + String(step + 1).padStart(2, "0") + " / 06", PV_STEPS[step].title, PV_STEPS[step].detail);
    if(manual)syncArrivalSelection(PV_STEPS[step].focus);
    focus(PV_STEPS[step].focus);
  }
  async function setMode(nextMode) {
    if (nextMode === "layout" && !layoutPromise) {
      modeButtons.forEach(button => { button.disabled = true; });
      q("[data-pv-model-stamp]").textContent = "正在加载光伏场区排布…";
      try {
        await ensureLayout();
      } catch (error) {
        console.error("光伏场区排布加载失败", error);
        explain("SITE PLAN", "场区排布暂不可用", "本地矢量或底图加载失败；请稍后重试。原理演示仍可继续使用。");
        q("[data-pv-model-stamp]").textContent = "排布加载失败 · 可重试";
        modeButtons.forEach(button => { button.disabled = false; });
        return;
      }
      modeButtons.forEach(button => { button.disabled = false; });
    }
    mode = nextMode;
    const principle = mode === "principle";
    page.dataset.pvMode = mode;
    demo.root.visible = principle;
    layout.visible = !principle;
    scene.background = new THREE.Color(principle ? 0xe9e8e0 : 0x26322e);
    scene.fog = new THREE.Fog(principle ? 0xe9e8e0 : 0x26322e, principle ? 380 : 285, principle ? 750 : 560);
    camera.fov = principle ? 38 : 36;
    camera.updateProjectionMatrix();
    controls.minDistance = principle ? 7 : 35;
    controls.maxDistance = principle ? 420 : 340;
    modeButtons.forEach(button => button.setAttribute("aria-pressed", String(button.dataset.pvMode === mode)));
    q(".pv-demo-toolbar").hidden = !principle;
    q(".pv-demo-actions").hidden = !principle;
    stowButton.hidden = !principle;
    q("[data-pv-communication]").hidden = !principle;
    q("[data-pv-demo-disclaimer]").hidden = !principle;
    q("[data-pv-baseline-modules]").hidden = !principle;
    q("[data-pv-layout-zones]").hidden = principle;
    focusButtons.forEach(button => { button.hidden = !principle; });
    q(".pv-camera-controls > span").hidden = !principle;
    q("[data-pv-eyebrow]").textContent = principle ? "PV ARRAY · PRINCIPLE DEMONSTRATION" : "PV ARRAY · SITE PLAN";
    q("[data-pv-title]").textContent = principle ? "光伏发电原理演示" : "光伏场区排布";
    q("[data-pv-description]").textContent = principle ? "从跟踪组件串到逆变、集电和两级升压，逐步看懂电能如何送入电网。" : "按总平面图保留13个光伏分区的原相对位置、走向和行列矢量；拖动旋转，滚轮缩放。";
    q("[data-pv-model-stamp]").textContent = principle ? "代表性原理模型 · 距离压缩 · 非实时运行" : "总平面图矢量复原 · 非竣工状态";
    q("[data-pv-source]").textContent = principle ? "依据：附图5-2 / 5-3 / 5-4 / 5-7 与 A-2.5 跟踪支架技术要求" : "依据：附图1 总平面布置图 · 保留原13区矢量模型";
    q("[data-pv-source-note]").textContent = principle ? "图纸的组串长度、逆变器分组及单元容量存在差异；展示只讲原理，不用未统一数值。" : "排布按总平面表达；组件安装高度、跟踪角度和竣工状态未由此图纸确认。";
    container.setAttribute("aria-label", principle ? "光伏单轴跟踪支架、代表性组串、逆变器、箱变和IPP升压站三维原理演示" : "按总平面布置图复原的13个光伏分区三维排布模型");
    if (principle) explain("STEP " + String(step + 1).padStart(2, "0") + " / 06", PV_STEPS[step].title, PV_STEPS[step].detail);
    else explain("SITE PLAN · 13 ZONES", "按总平面图复原的光伏分区", "13个分区按原相对位置、走向与行列矢量显示。组件安装高度、跟踪角度及竣工状态未由此图纸确认。");
    reset();
  }
  modeButtons.forEach(button => button.addEventListener("click", () => setMode(button.dataset.pvMode)));
  stepButtons.forEach(button => button.addEventListener("click", () => selectStep(Number(button.dataset.pvStep), true)));
  focusButtons.forEach(button => button.addEventListener("click", () => selectStep(PV_STEPS.findIndex(item => item.focus === button.dataset.pvFocus), true)));
  q("[data-pv-prev]").addEventListener("click", () => selectStep(step - 1, true));
  q("[data-pv-next]").addEventListener("click", () => selectStep(step + 1, true));
  playButton.addEventListener("click", () => { playing = !playing; paused = !playing; syncPlayback(); });
  stowButton.addEventListener("click", () => {
    const stow = stowButton.getAttribute("aria-pressed") !== "true";
    stowButton.setAttribute("aria-pressed", String(stow));
    stowButton.textContent = stow ? "恢复跟踪演示" : "大风收拢演示";
    demo.setStow(stow);
    selectStep(0, true);
    if (stow) explain("TRACKER CONTROL · DEMO", "大风收拢动作演示", "跟踪控制器可根据气象信号触发支架收拢。本演示让组件平面缓慢回到示例停靠姿态；实际风速阈值、停靠角度及控制策略由厂家设计确定。");
  });
  controls.addEventListener("start", () => {
    transition = null;
    focusButtons.forEach(button => button.setAttribute("aria-pressed", "false"));
  });
  const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2();
  let down = null;
  renderer.domElement.addEventListener("pointerdown", event => { down = [event.clientX, event.clientY]; });
  renderer.domElement.addEventListener("pointercancel", () => { down = null; });
  renderer.domElement.addEventListener("click", event => {
    const start = down; down = null;
    if (!start || Math.hypot(event.clientX - start[0], event.clientY - start[1]) > 5) return;
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    if (mode === "layout") {
    if (pvSurface && raycaster.intersectObject(pvSurface, false).length) explain("SITE PLAN · 13 ZONES", "PV分区 · 按总平面矢量复原", "总平面图中的13个光伏分区按原相对位置、走向和行列矢量抬升显示。组件安装高度、跟踪角度及竣工状态未由此图纸确认。");
      return;
    }
    for (const hit of raycaster.intersectObject(demo.root, true)) {
      let object = hit.object;
      while (object && !object.userData.pickable) object = object.parent;
      if (!object) continue;
      selectStep(object.userData.stepIndex ?? 0, true);
      if (object.userData.focusKey) focus(object.userData.focusKey);
      break;
    }
  });
  page.querySelectorAll("[data-pv-mode], [data-pv-step], [data-pv-focus], [data-pv-prev], [data-pv-next], [data-pv-play], [data-pv-stow]").forEach(button => { button.disabled = false; });
  demo.setStep(0);
  setMode("principle");
  scene.userData.reset = reset;
  function update(timestamp) {
    const delta = lastFrame ? Math.min((timestamp - lastFrame) / 1000, 0.05) : 0;
    lastFrame = timestamp;
    if (mode !== "principle") return;
    if (!paused && !reducedMotion) demo.update(delta);
    if (playing) {
      elapsed += delta;
      if (elapsed >= 8) { elapsed -= 8; selectStep(step + 1); }
    }
    if (transition) {
      transition.elapsed = Math.min(1, transition.elapsed + delta / 0.7);
      const t = transition.elapsed * transition.elapsed * (3 - 2 * transition.elapsed);
      camera.position.lerpVectors(transition.from, transition.position, t);
      controls.target.lerpVectors(transition.fromTarget, transition.target, t);
      if (transition.elapsed === 1) transition = null;
    }
  }
  return { scene, camera, renderer, controls, update, continuousRender() {
    return (mode === "principle" && !paused && !reducedMotion) || playing || transition !== null;
  }, onResize() {
    const selected = focusButtons.find(button => button.getAttribute("aria-pressed") === "true");
    if (mode === "principle" && selected) focus(selected.dataset.pvFocus, true);
    else reset();
  } };
}
