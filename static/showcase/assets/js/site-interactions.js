import * as THREE from "three";

export function attachSiteInteractions({ camera, controls, renderer, pickTargets, inspector, cameraTargets, initialCameraPosition, initialTarget }) {
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const startPosition = new THREE.Vector2();
  const tourButton = document.querySelector("[data-site-tour]");
  const interiorButton = document.querySelector("[data-om-interior]");
  let pointerDown = false;
  let tweenId = 0;
  let tourTimer = 0;
  let tourIndex = 0;
  let touring = false;

  function arrivalFocus(keys, label) {
    window.dispatchEvent(new CustomEvent("baphalane-arrival-focus", { detail: { keys, label } }));
  }

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

  function moveCamera(target, distance, duration = 1050) {
    tweenId++;
    const thisTween = tweenId;
    const fromPosition = camera.position.clone();
    const fromTarget = controls.target.clone();
    const direction = fromPosition.clone().sub(fromTarget).normalize();
    const toTarget = target.clone();
    const toPosition = toTarget.clone().addScaledVector(direction, distance);
    toPosition.y = Math.max(toPosition.y, toTarget.y + 4.2);
    const startTime = performance.now();

    function animate(now) {
      if (thisTween !== tweenId) return;
      const t = Math.min(1, (now - startTime) / duration);
      const eased = t * t * (3 - 2 * t);
      camera.position.lerpVectors(fromPosition, toPosition, eased);
      controls.target.lerpVectors(fromTarget, toTarget, eased);
      controls.update();
      if (t < 1) requestAnimationFrame(animate);
    }
    requestAnimationFrame(animate);
  }

  function setFocusButton(key) {
    document.querySelectorAll("[data-focus-site]").forEach(button => {
      const selected = button.dataset.focusSite === key;
      button.classList.toggle("is-active", selected);
      if (selected) button.setAttribute("aria-pressed", "true");
      else button.setAttribute("aria-pressed", "false");
    });
  }

  function focusView(key, fromTour = false) {
    const view = cameraTargets.find(item => item.key === key);
    if (!view) return;
    if (!fromTour) stopTour();
    arrivalFocus(key === "bess" ? ["bess-cabinet", "pcs"] : key === "switchyard" ? ["main-transformer"] : []);
    setFocusButton(key);
    inspector.querySelector("h3").textContent = view.object.userData.title;
    inspector.querySelector("p").textContent = view.object.userData.detail;
    inspector.hidden = false;
    moveCamera(view.target, view.distance, fromTour ? 1350 : 950);
  }

  function focusPoint(target, distance, title, detail) {
    stopTour();
    arrivalFocus([]);
    setFocusButton("");
    inspector.querySelector("h3").textContent = title;
    inspector.querySelector("p").textContent = detail;
    inspector.hidden = false;
    moveCamera(target.clone(), distance, 1000);
  }

  function startTour() {
    stopTour();
    updateTourButton(true);
    tourIndex = 0;
    const next = () => {
      if (!touring) return;
      const view = cameraTargets[tourIndex % cameraTargets.length];
      tourIndex++;
      focusView(view.key, true);
      tourTimer = window.setTimeout(next, 4100);
    };
    next();
  }

  tourButton?.addEventListener("click", () => touring ? stopTour() : startTour());
  document.querySelectorAll("[data-focus-site]").forEach(button => {
    button.addEventListener("click", () => focusView(button.dataset.focusSite));
  });
  controls.addEventListener("start", stopTour);

  renderer.domElement.addEventListener("pointerdown", event => {
    pointerDown = event.isPrimary && event.button === 0;
    startPosition.set(event.clientX, event.clientY);
  });
  renderer.domElement.addEventListener("pointercancel", () => { pointerDown = false; });
  renderer.domElement.addEventListener("click", event => {
    if (!pointerDown || Math.hypot(event.clientX - startPosition.x, event.clientY - startPosition.y) > 5) {
      pointerDown = false;
      return;
    }
    pointerDown = false;
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObject(pickTargets, true)[0];
    if (!hit) return;
    let node = hit.object;
    while (node.parent && !node.userData.pickable) node = node.parent;
    if (!node.userData.pickable) return;

    stopTour();
    arrivalFocus(node.userData.arrivalKeys || [], node.userData.title);
    inspector.querySelector("h3").textContent = node.userData.title;
    inspector.querySelector("p").textContent = node.userData.detail;
    inspector.hidden = false;
    const view = cameraTargets.find(item => item.key === node.userData.cameraKey) || cameraTargets.find(item => item.object === node);
    const point = view ? view.target : node.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0.6, 0));
    setFocusButton(view?.key ?? "");
    moveCamera(point, view?.distance ?? 16, 850);
  });

  return {
    bindInteriorToggle(handler) {
      interiorButton?.addEventListener("click", handler);
    },
    reset() {
      stopTour();
      setFocusButton("");
      inspector.hidden = true;
      const damping = controls.enableDamping;
      controls.enableDamping = false;
      controls.update();
      camera.position.copy(initialCameraPosition);
      camera.zoom = 1;
      camera.updateProjectionMatrix();
      controls.target.copy(initialTarget);
      controls.update();
      controls.enableDamping = damping;
    },
    stopTour,
    focusView,
    focusPoint
  };
}
