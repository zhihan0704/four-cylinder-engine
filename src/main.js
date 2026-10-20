import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';

import { createMaterials, makeXrayMaterial } from './materials.js';
import { DieselEngine } from './engine.js';
import { EngineSimulation, ENGINE, strokeInfo, cylinderCycleAngle, clamp, mod } from './simulation.js';
import { FlowSystem } from './flow.js';
import { PARTS, GROUPS } from './parts.js';
import { canvasTexture } from './geometry.js';

const $ = (id) => document.getElementById(id);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const fmt = (v, d = 0) => Number(v).toFixed(d);
const pad2 = (n) => String(n).padStart(2, '0');
const lerp = (a, b, t) => a + (b - a) * t;
const easeInOut = (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

const MODE = {
  xray: false,
  exploded: false,
  labels: false,
  flow: true,
  coolant: true,
  oil: true,
  view: 'free',
  running: true,
};

let scene, camera, renderer, controls, composer, bloomPass, fxaaPass, pmrem, envRT;
let materials, engine, sim, flow;
let clock;
let postEnabled = true;
let selectionHelper = null;
let selectionMarker = null;
let selectedPartInfo = null;
let firstFrame = true;
let pointerInsideCanvas = false;
let lastPointerEvent = { clientX: 0, clientY: 0 };

function showFallback(message = '') {
  const fallback = $('webglFallback');
  if (!fallback) return;
  fallback.hidden = false;
  const p = fallback.querySelector('p');
  if (message && p) p.textContent = message;
  const loading = $('loadingScreen');
  if (loading) loading.classList.add('is-hidden');
}

function init() {
  try {
    const canvas = $('sim-canvas');
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
    });
  } catch (e) {
    console.error(e);
    showFallback('当前浏览器未能创建 WebGL 上下文，请开启硬件加速后重试。');
    return;
  }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.965;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;
  renderer.info.autoReset = true;
  renderer.domElement.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    showToast('WebGL 上下文暂时丢失，正在等待浏览器恢复');
  });
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050a0d);
  scene.fog = new THREE.FogExp2(0x050a0d, 0.016);

  const initialAspect = window.innerWidth / window.innerHeight;
  camera = new THREE.PerspectiveCamera(initialAspect < 0.8 ? 62 : 35, initialAspect, 0.08, 90);
  camera.position.set(9.95, 6.25, 12.75);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0.45, 1.16, 0.12);
  controls.enableDamping = true;
  controls.dampingFactor = 0.065;
  controls.rotateSpeed = 0.58;
  controls.zoomSpeed = 0.78;
  controls.panSpeed = 0.68;
  controls.minDistance = 3.1;
  controls.maxDistance = 32;
  controls.minPolarAngle = 0.08;
  controls.maxPolarAngle = Math.PI * 0.525;
  controls.screenSpacePanning = true;
  controls.update();

  pmrem = new THREE.PMREMGenerator(renderer);
  envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
  scene.environment = envRT.texture;
  scene.environmentIntensity = 0.81;
  applyCameraViewOffset();

  buildLighting();
  buildEnvironment();
  buildModel();
  buildComposer();
  bindUI();
  buildCallouts();
  updateViewButtons('free');
  bindHover();
  clock = new THREE.Clock();
  loadState();
  requestAnimationFrame(animate);
}

function buildLighting() {
  scene.add(new THREE.HemisphereLight(0x9fc8d2, 0x070a0b, 0.36));

  const key = new THREE.DirectionalLight(0xe1eeec, 2.28);
  key.position.set(6.5, 10.5, 7.8);
  key.castShadow = true;
  key.shadow.mapSize.set(1536, 1536);
  key.shadow.camera.left = -6.5;
  key.shadow.camera.right = 6.5;
  key.shadow.camera.top = 7;
  key.shadow.camera.bottom = -5.5;
  key.shadow.camera.near = 2;
  key.shadow.camera.far = 29;
  key.shadow.bias = -0.00035;
  key.shadow.normalBias = 0.028;
  key.shadow.radius = 2.2;
  key.target.position.set(0, 1.3, 0);
  scene.add(key);
  scene.add(key.target);

  const rim = new THREE.DirectionalLight(0xffb16a, 0.78);
  rim.position.set(-7.5, 5.8, -6.8);
  scene.add(rim);

  const fill = new THREE.DirectionalLight(0x69a8c0, 0.9);
  fill.position.set(-6, 4, 7);
  scene.add(fill);

  const frontGlow = new THREE.PointLight(0x2fbbc9, 3.2, 7, 2.4);
  frontGlow.position.set(2.6, 1.2, 4.8);
  scene.add(frontGlow);

  const warmBounce = new THREE.PointLight(0xff9a52, 1.45, 6.5, 2.4);
  warmBounce.position.set(-2.6, 1.4, 3.4);
  scene.add(warmBounce);

  const under = new THREE.PointLight(0x154954, 3.2, 7.5, 2.2);
  under.position.set(0, -2.2, 0.5);
  scene.add(under);
}

function applyCameraViewOffset() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const shift = w > 1180 ? 156 : 0;
  if (shift > 0) {
    camera.setViewOffset(w + shift * 2, h, shift * 2, 0, w, h);
  } else {
    camera.clearViewOffset();
  }
  camera.updateProjectionMatrix();
}

function buildEnvironment() {
  // Display floor: a dark brushed surface with a procedural technical grid that
  // fades into the void in every direction.
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(28, 96),
    new THREE.MeshStandardMaterial({ color: 0x050c10, metalness: 0.26, roughness: 0.7 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -2.9;
  floor.receiveShadow = true;
  scene.add(floor);

  // Soft contact shadow to anchor the machine even when the shadow map is
  // updated at a lower cadence.
  const contactTex = canvasTexture(512, 512, (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, w * 0.02, w / 2, h / 2, w * 0.49);
    g.addColorStop(0, 'rgba(0,0,0,0.72)');
    g.addColorStop(0.36, 'rgba(0,0,0,0.45)');
    g.addColorStop(0.72, 'rgba(0,0,0,0.12)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  });
  const contact = new THREE.Mesh(
    new THREE.PlaneGeometry(8.4, 6.2),
    new THREE.MeshBasicMaterial({ map: contactTex, transparent: true, opacity: 0.72, depthWrite: false })
  );
  contact.rotation.x = -Math.PI / 2;
  contact.position.set(0.2, -2.884, 0.1);
  contact.renderOrder = 1;
  scene.add(contact);

  const tex = canvasTexture(1536, 1536, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2;
    ctx.strokeStyle = 'rgba(114, 190, 198, 0.16)';
    ctx.lineWidth = 1;
    const step = 64;
    for (let x = 0; x <= w; x += step) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    for (let y = 0; y <= h; y += step) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(124, 214, 222, 0.34)';
    ctx.lineWidth = 2.2;
    for (const r of [190, 300, 420, 610]) {
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(124, 214, 222, 0.22)';
    ctx.lineWidth = 1.2;
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * Math.PI * 2;
      const r0 = 420;
      const r1 = i % 6 === 0 ? 448 : 434;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(124, 214, 222, 0.18)';
    ctx.beginPath(); ctx.moveTo(cx - 680, cy); ctx.lineTo(cx + 680, cy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx, cy - 680); ctx.lineTo(cx, cy + 680); ctx.stroke();
    ctx.strokeStyle = 'rgba(210, 236, 235, 0.3)';
    ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI * 2); ctx.stroke();
    ctx.font = '500 15px Consolas, monospace';
    ctx.fillStyle = 'rgba(121, 182, 188, 0.38)';
    ctx.fillText('4C-105  /  BEDPLATE REFERENCE', cx - 680, cy + 42);
    ctx.fillStyle = 'rgba(121, 182, 188, 0.27)';
    ctx.fillText('UNIT: mm     GRID: 100', cx - 680, cy + 66);
    ctx.save();
    ctx.translate(cx + 470, cy - 300);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('FRONT  /  TIMING DRIVE', 0, 0);
    ctx.restore();
    // Radial fade.
    ctx.globalCompositeOperation = 'destination-in';
    const fade = ctx.createRadialGradient(cx, cy, w * 0.1, cx, cy, w * 0.5);
    fade.addColorStop(0, 'rgba(0,0,0,1)');
    fade.addColorStop(0.56, 'rgba(0,0,0,0.72)');
    fade.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = fade;
    ctx.fillRect(0, 0, w, h);
  });
  tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const techFloor = new THREE.Mesh(
    new THREE.PlaneGeometry(15.5, 15.5),
    new THREE.MeshBasicMaterial({
      map: tex, transparent: true, opacity: 0.7, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    })
  );
  techFloor.rotation.x = -Math.PI / 2;
  techFloor.position.y = -2.885;
  techFloor.renderOrder = 2;
  scene.add(techFloor);

  // Warm/cool pools of light reflected in the polished floor.
  const pool = new THREE.Mesh(
    new THREE.CircleGeometry(3.8, 64),
    new THREE.MeshBasicMaterial({
      color: 0x0a2730, transparent: true, opacity: 0.3, depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  pool.rotation.x = -Math.PI / 2;
  pool.position.set(0.2, -2.882, 0);
  scene.add(pool);

  // A wide, low cyan halo helps separate the engine silhouette from the dark
  // studio floor without introducing another realtime light.
  const halo = new THREE.Mesh(
    new THREE.RingGeometry(3.1, 4.72, 96),
    new THREE.MeshBasicMaterial({
      color: 0x1e7785, transparent: true, opacity: 0.065, side: THREE.DoubleSide,
      depthWrite: false, blending: THREE.AdditiveBlending,
    })
  );
  halo.rotation.x = -Math.PI / 2;
  halo.position.set(0.2, -2.878, 0);
  scene.add(halo);

  // A sparse dust field, small enough to read as atmosphere rather than noise.
  const dustGeo = new THREE.BufferGeometry();
  const dustCount = 150;
  const arr = new Float32Array(dustCount * 3);
  for (let i = 0; i < dustCount; i++) {
    const r = 3 + Math.random() * 9;
    const a = Math.random() * Math.PI * 2;
    arr[i * 3] = Math.cos(a) * r;
    arr[i * 3 + 1] = -2.4 + Math.random() * 8;
    arr[i * 3 + 2] = Math.sin(a) * r;
  }
  dustGeo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({
    color: 0x8acbd2, size: 0.021, sizeAttenuation: true,
    transparent: true, opacity: 0.24, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  scene.add(dust);
  window.__dust = dust;
}

function buildModel() {
  materials = createMaterials();
  engine = new DieselEngine(materials);
  scene.add(engine.root);

  selectionHelper = new THREE.Box3Helper(new THREE.Box3(), 0x8df4fb);
  selectionHelper.material.color.setHex(0x8df4fb);
  selectionHelper.material.transparent = true;
  selectionHelper.material.opacity = 0.78;
  selectionHelper.material.depthTest = false;
  selectionHelper.material.depthWrite = false;
  selectionHelper.renderOrder = 30;
  selectionHelper.visible = false;
  scene.add(selectionHelper);

  const markerTex = canvasTexture(256, 256, (ctx, w, h) => {
    const cx = w / 2, cy = h / 2, r = w * 0.34;
    ctx.clearRect(0, 0, w, h);
    const grad = ctx.createRadialGradient(cx, cy, r * 0.82, cx, cy, r * 1.1);
    grad.addColorStop(0, 'rgba(91,236,246,0)');
    grad.addColorStop(0.65, 'rgba(91,236,246,0.14)');
    grad.addColorStop(0.82, 'rgba(91,236,246,0.02)');
    grad.addColorStop(1, 'rgba(91,236,246,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(133,247,251,0.9)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(133,247,251,0.52)';
    ctx.lineWidth = 2;
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2 + Math.PI / 4;
      ctx.beginPath();
      ctx.arc(cx, cy, r + 11, a - 0.2, a + 0.2);
      ctx.stroke();
    }
  });
  selectionMarker = new THREE.Sprite(new THREE.SpriteMaterial({
    map: markerTex, color: 0x9bfcff, transparent: true, opacity: 0.8,
    depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  selectionMarker.renderOrder = 31;
  selectionMarker.visible = false;
  scene.add(selectionMarker);

  sim = new EngineSimulation();
  MODE.running = sim.running;

  flow = new FlowSystem(engine, sim);
  scene.add(flow.group);
  setupExplode();

  // Shadow-budget pass: only meaningful silhouettes and hard-surface casters
  // contribute to the 1536² sun map. Tiny fasteners and transparent shells are
  // lit only, which buys a substantial number of draw calls at 60 FPS.
  engine.root.traverse(o => {
    if (!o.isMesh) return;
    const id = o.userData.partId || '';
    if (o.material && (o.material.transparent || o.material.opacity < 0.95)) {
      o.castShadow = false;
      return;
    }
    if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
    const r = o.geometry.boundingSphere?.radius || 0;
    if (r < 0.17 || /Bolt|bolt|Line|fuelLine|pushrod|lifter|valveSpring|sensor|wiring|hose|Hose|gasket/.test(id)) {
      o.castShadow = false;
    }
  });
  renderer.shadowMap.needsUpdate = true;

  // Material-based scene statistics are deterministic and do not depend on
  // whatever pass the composer happened to render last.
  let meshes = 0;
  let triangles = 0;
  engine.root.traverse(o => {
    if (!o.isMesh) return;
    meshes++;
    const g = o.geometry;
    if (!g) return;
    triangles += g.index ? g.index.count / 3 : (g.attributes.position?.count || 0) / 3;
  });
  const uniqueParts = new Set(engine.raycastMeshes.map(o => o.userData.partId));
  engine.stats = { meshes, triangles: Math.round(triangles), uniqueParts: uniqueParts.size };
}

function buildComposer() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  composer = new EffectComposer(renderer);
  composer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  composer.setSize(w, h);
  composer.addPass(new RenderPass(scene, camera));
  bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h), 0.16, 0.38, 1.03);
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());
  fxaaPass = new ShaderPass(FXAAShader);
  fxaaPass.material.uniforms.resolution.value.set(
    1 / (w * renderer.getPixelRatio()),
    1 / (h * renderer.getPixelRatio())
  );
  composer.addPass(fxaaPass);
  composer.setSize(w, h);
}

// ---------------------------------------------------------------------------
// Camera transitions and view presets
// ---------------------------------------------------------------------------
const VIEWS = {
  free: { pos: [10.2, 6.5, 13.1], target: [0.4, 1.24, 0.12] },
  front: { pos: [17.8, 4.6, 0.55], target: [0.15, 1.5, 0.0] },
  side: { pos: [0.4, 4.2, 17.3], target: [0.25, 1.38, 0.0] },
  top: { pos: [0.4, 18.6, 5.2], target: [0.25, 1.0, 0.1] },
};
const VIEW_LABELS = { free: '轴测', front: '前视', side: '侧视', top: '俯视' };

function viewForState(name) {
  if (!MODE.exploded) return VIEWS[name];
  const target = [0.4, 2.15, 0.2];
  if (name === 'free') return { pos: explodeViewForViewport().pos, target: explodeViewForViewport().target };
  if (name === 'front') return { pos: [23.5, 7.8, 0.55], target };
  if (name === 'side') return { pos: [0.5, 6.2, 24.5], target };
  if (name === 'top') return { pos: [0.4, 26.0, 7.2], target };
  return VIEWS[name];
}

let cameraTween = null;
function flyTo(pos, target, duration = 950) {
  cameraTween = {
    start: performance.now(),
    duration,
    fromPos: camera.position.clone(),
    fromTarget: controls.target.clone(),
    toPos: new THREE.Vector3(...pos),
    toTarget: new THREE.Vector3(...target),
  };
  controls.enabled = false;
}
function updateCameraTween(now) {
  if (!cameraTween) return false;
  const t = clamp((now - cameraTween.start) / cameraTween.duration, 0, 1);
  const e = easeInOut(t);
  camera.position.lerpVectors(cameraTween.fromPos, cameraTween.toPos, e);
  controls.target.lerpVectors(cameraTween.fromTarget, cameraTween.toTarget, e);
  camera.lookAt(controls.target);
  if (t >= 1) {
    cameraTween = null;
    controls.enabled = true;
    controls.update();
  }
  return true;
}

function updateViewButtons(active) {
  $$('.view-btn').forEach(btn => btn.classList.toggle('is-active', btn.dataset.view === active));
}

function setView(name, { silent = false } = {}) {
  const v = viewForState(name);
  if (!v) return;
  MODE.view = name;
  updateViewButtons(name);
  flyTo(v.pos, v.target, name === 'free' ? 1000 : 900);
  if (!silent) showToast(`${VIEW_LABELS[name] || name} · 视角已切换`);
}

// ---------------------------------------------------------------------------
// X-ray mode
// ---------------------------------------------------------------------------
function setXray(on, { silent = false, toast = true } = {}) {
  if (!engine) return;
  if (on === MODE.xray) {
    updateXrayUI();
    return;
  }
  MODE.xray = !!on;
  for (const mesh of engine.shellMeshes) {
    if (!mesh.userData.originalMaterial) {
      mesh.userData.originalMaterial = mesh.material;
      mesh.userData.originalCastShadow = mesh.castShadow;
      mesh.userData.xrayMaterial = makeXrayMaterial(mesh.material);
    }
    if (MODE.xray) {
      mesh.material = mesh.userData.xrayMaterial;
      mesh.castShadow = false;
      mesh.renderOrder = 4;
    } else {
      mesh.material = mesh.userData.originalMaterial;
      mesh.castShadow = mesh.userData.originalCastShadow;
      mesh.renderOrder = 0;
    }
  }
  for (const line of engine.shellEdges) line.visible = MODE.xray;
  scene.environmentIntensity = MODE.xray ? 0.93 : 0.81;
  if (flow) flow.setCutaway(MODE.xray);
  document.body.classList.toggle('mode-xray', MODE.xray);
  updateModeLabel();
  updateSectionUI();
  clearHover();
  if (flow) flow.group.visible = MODE.flow && !MODE.exploded;
  if (!silent && toast) showToast(MODE.xray ? '剖面已开启 · 外壳半透明化' : '已恢复完整装配外壳');
  renderer.shadowMap.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Exploded system view
// ---------------------------------------------------------------------------
const EXPLODE_ITEMS = [];
let explodeCurrent = 0;
let autoLabelsOnExplode = false;
let explodeCamBackup = null;
const EXPLODE_VIEW = {
  pos: [14.8, 10.8, 19.2],
  target: [0.4, 2.05, 0.25],
};
function explodeViewForViewport() {
  if (window.innerWidth < 760) {
    // Portrait viewports see less horizontal field of view. Pull back slightly
    // and bias the target toward the cooling/intercooler side so no assembly
    // leaves the frame.
    return { pos: [16.8, 12.2, 21.6], target: [2.25, 2.2, 0.2] };
  }
  return EXPLODE_VIEW;
}

function setupExplode() {
  const add = (obj, dx, dy, dz, delay = 0) => {
    if (!obj) return;
    EXPLODE_ITEMS.push({
      obj,
      base: obj.position.clone(),
      delta: new THREE.Vector3(dx, dy, dz),
      delay,
    });
  };
  // The upper valvetrain lifts vertically; peripheral service modules pull
  // radially away from the long block in the visual language of the reference
  // exploded-view interface.
  add(engine.parts.upperAssembly, 0, 2.9, 0.15, 0.0);
  if (engine.parts.cover) add(engine.parts.cover, 0, 1.08, -0.12, 0.45);
  add(engine.parts.pan, 0, -1.0, 0.18, 0.4);
  add(engine.parts.fuel, -0.8, 1.5, -2.25, 0.8);
  add(engine.parts.lube, -1.55, -0.72, 1.85, 0.35);
  add(engine.parts.cooling, 3.25, 0.38, 0.36, 0.25);
  add(engine.parts.accessories, -2.0, -0.08, -2.55, 0.55);
  add(engine.parts.timing, 1.78, -0.08, 0.28, 0.45);
  add(engine.parts.bell, -2.1, 0, 0, 0.15);
  add(engine.dynamic.flywheel, -2.5, 0, 0, 0.15);
  if (engine.parts.airIntakeModule) add(engine.parts.airIntakeModule, -1.72, 0.55, -2.65, 0.6);
  if (engine.parts.airExhaustModule) add(engine.parts.airExhaustModule, 1.12, 0.58, 2.55, 0.7);
  if (engine.parts.airIntercoolerModule) add(engine.parts.airIntercoolerModule, 2.95, 0.88, -0.22, 0.5);
}

function updateModeLabel() {
  const label = $('sceneModeText');
  if (!label) return;
  if (MODE.exploded) {
    label.textContent = MODE.xray
      ? '剖面拆解'
      : selectedPartInfo ? `拆解 · ${selectedPartInfo.meta.name}` : '整机拆解';
  } else {
    label.textContent = '完整装配';
  }
  label.closest('.mode-chip')?.classList.toggle('is-section', MODE.exploded);
}

function updateSectionUI() {
  const btn = $('btnSection');
  if (!btn) return;
  const active = MODE.exploded && MODE.xray;
  btn.classList.toggle('is-active', active);
  btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  const state = $('sectionState');
  if (state) state.textContent = active ? 'ON' : 'OFF';
  const hint = $('sectionHint');
  if (hint) hint.textContent = active ? '再次点击还原装配' : '拆解 + X-Ray · 再次点击还原';
}

function toggleSectionView() {
  if (MODE.exploded && MODE.xray) {
    setExploded(false);
    return;
  }
  if (!MODE.exploded) setExploded(true, { silent: true });
  if (!MODE.xray) setXray(true, { silent: true, toast: false });
  updateSectionUI();
  showToast('剖面拆解已开启 · 再次点击“剖面”还原');
}

function setExploded(on, { silent = false } = {}) {
  const next = !!on;
  if (next === MODE.exploded) {
    updateSectionUI();
    return;
  }
  MODE.exploded = next;
  if (MODE.exploded) {
    explodeCamBackup = {
      pos: camera.position.clone(),
      target: controls.target.clone(),
    };
    if (!MODE.labels) {
      autoLabelsOnExplode = true;
      setLabels(true, { silent: true });
    }
    if (flow) flow.group.visible = false;
    const view = explodeViewForViewport();
    flyTo(view.pos, view.target, 1100);
    updateViewButtons(null);
    updateSectionUI();
    updateModeLabel();
    if (!silent) showToast('整机已拆解 · 点击零件切换聚焦，点击空白收回');
  } else {
    clearSelectedPart();
    if (autoLabelsOnExplode) {
      autoLabelsOnExplode = false;
      setLabels(false, { silent: true });
    }
    if (flow) flow.group.visible = MODE.flow;
    if (explodeCamBackup) {
      flyTo(explodeCamBackup.pos.toArray(), explodeCamBackup.target.toArray(), 950);
      explodeCamBackup = null;
    }
    if (MODE.xray) setXray(false, { silent: true, toast: false });
    updateSectionUI();
    updateViewButtons(MODE.view || 'free');
    updateModeLabel();
    if (!silent) showToast('装配已还原');
  }
}

function applyExplode(t) {
  for (const item of EXPLODE_ITEMS) {
    const delayed = item.delay || 0;
    const local = delayed >= 0.999 ? 1 : clamp((t - delayed * 0.42) / (1 - delayed * 0.42), 0, 1);
    const soft = local * local * (3 - 2 * local);
    item.obj.position.copy(item.base).addScaledVector(item.delta, soft);
  }
}

function selectedMeshes() {
  if (!selectedPartInfo) return [];
  const raw = selectedPartInfo.raw;
  const cyl = selectedPartInfo.cyl;
  const out = [];
  for (const m of engine.raycastMeshes) {
    if (m.userData.partId !== raw) continue;
    if (cyl != null && m.userData.cylinderIndex != null && m.userData.cylinderIndex !== cyl) continue;
    out.push(m);
  }
  return out;
}

const _selBox = new THREE.Box3();
const _selMeshBox = new THREE.Box3();

function updateSelectionHelper(now = performance.now()) {
  if (!selectionHelper) return;
  if (!selectedPartInfo || !MODE.exploded) {
    selectionHelper.visible = false;
    if (selectionMarker) selectionMarker.visible = false;
    return;
  }
  engine.root.updateWorldMatrix(true, true);
  _selBox.makeEmpty();
  for (const m of selectedMeshes()) {
    if (!m.geometry) continue;
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
    if (!m.geometry.boundingBox) continue;
    _selMeshBox.copy(m.geometry.boundingBox).applyMatrix4(m.matrixWorld);
    _selBox.union(_selMeshBox);
  }
  if (_selBox.isEmpty()) {
    selectionHelper.visible = false;
    if (selectionMarker) selectionMarker.visible = false;
    return;
  }
  _selBox.expandByScalar(0.035);
  selectionHelper.box.copy(_selBox);
  selectionHelper.visible = true;
  selectionHelper.material.opacity = 0.62 + Math.sin(now * 0.004) * 0.18;
  selectionHelper.updateMatrixWorld(true);
  if (selectionMarker) {
    const center = _selBox.getCenter(new THREE.Vector3());
    const size = _selBox.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.y, size.z);
    selectionMarker.position.copy(center);
    const scale = clamp(span * 0.88 + 0.24, 0.4, 4.2);
    selectionMarker.scale.set(scale, scale, 1);
    selectionMarker.material.opacity = 0.42 + Math.sin(now * 0.004) * 0.12;
    selectionMarker.visible = true;
  }
}

function clearSelectedPart({ hideInfo = true } = {}) {
  selectedPartInfo = null;
  if (selectionHelper) selectionHelper.visible = false;
  if (selectionMarker) selectionMarker.visible = false;
  if (hideInfo) hideCard();
  updateModeLabel();
}

function selectPart(info) {
  if (!info) return;
  selectedPartInfo = info;
  updateSelectionHelper();
  updateModeLabel();
}

function handlePartSelection(info, clientX, clientY, { touch = false } = {}) {
  if (!info) return;
  const wasExploded = MODE.exploded;
  if (!wasExploded) setExploded(true, { silent: true });
  // Desktop clicks disassemble and leave the scene unobstructed. Hover opens
  // the material/specification card. Touch users get the full card as well.
  hideCard();
  selectPart(info);
  if (touch) {
    // Let the disassembly animation play before the full specification card
    // covers the small viewport.
    setTimeout(() => {
      const telemetryOpen = $('telemetry')?.classList.contains('is-open');
      if (MODE.exploded && selectedPartInfo === info && !telemetryOpen) {
        showCard(info, clientX, clientY, { pinned: true });
      }
    }, 1350);
  }
  showToast(touch
    ? `正在拆解 · ${info.meta.name} · 参数卡即将展开`
    : `已拆解 · ${info.meta.name} · 悬停查看参数，点击空白还原`);
}

// ---------------------------------------------------------------------------
// Anchored callouts
// ---------------------------------------------------------------------------
const CALLOUTS = [];
let calloutLayer;
function buildCallouts() {
  calloutLayer = $('calloutLayer');
  if (!calloutLayer) return;
  const anchorTo = (parent, x, y, z) => {
    const o = new THREE.Object3D();
    o.position.set(x, y, z);
    parent.add(o);
    return o;
  };
  const pistonAnchor = anchorTo(engine.pistonGroups[0], 0, 0.17, 0.48);
  const coolingAnchor = anchorTo(engine.parts.cooling, 4.82, 3.26, 1.1);
  const lubeAnchor = anchorTo(engine.parts.lube, 2.3, 0.82, 1.7);
  const turboAnchor = anchorTo(engine.parts.turbo, -1.45, 2.94, 2.08);
  const fuelAnchor = anchorTo(engine.parts.fuel, 0.28, 4.87, -1.08);
  const headAnchor = anchorTo(engine.parts.upperAssembly || engine.parts.head, 0.9, 4.55, 1.1);
  const timingAnchor = anchorTo(engine.parts.timing, 3.2, 2.65, 1.15);
  const intakeAnchor = engine.parts.airIntakeModule
    ? anchorTo(engine.parts.airIntakeModule, 1.1, 3.83, -1.55)
    : null;
  const exhaustAnchor = engine.parts.airExhaustModule
    ? anchorTo(engine.parts.airExhaustModule, 0.65, 3.33, 1.6)
    : null;
  const intercoolerAnchor = engine.parts.airIntercoolerModule
    ? anchorTo(engine.parts.airIntercoolerModule, 4.82, 2.95, -1.27)
    : null;
  const specs = [
    { base: 'piston-0', node: pistonAnchor, dx: -62, dy: 44, flip: true },
    { base: 'crank', node: 'crank-center', dx: 56, dy: -52 },
    { base: 'head', node: headAnchor, dx: 74, dy: -56 },
    { base: 'turbo', node: turboAnchor, dx: 54, dy: 14 },
    { base: 'commonRail', node: fuelAnchor, dx: -48, dy: -40, flip: true },
    { base: 'radiator', node: coolingAnchor, dx: -54, dy: -48, flip: true },
    { base: 'oilFilter', node: lubeAnchor, dx: 50, dy: 24 },
    { base: 'timingGears', node: timingAnchor, dx: 74, dy: -20 },
    intakeAnchor ? { base: 'intakeManifold', node: intakeAnchor, dx: -52, dy: 52, flip: true } : null,
    exhaustAnchor ? { base: 'exhaustManifold', node: exhaustAnchor, dx: 58, dy: 38 } : null,
    intercoolerAnchor ? { base: 'intercooler', node: intercoolerAnchor, dx: -58, dy: -28, flip: true } : null,
  ].filter(Boolean);
  let idx = 1;
  for (const s of specs) {
    const meta = PARTS[s.base];
    if (!meta) continue;
    const el = document.createElement('div');
    el.className = 'scene-callout' + (s.flip ? ' flip' : '');
    el.innerHTML = `<span class="anchor"></span><span class="leader"></span>
      <div class="callout-body"><header><span>${pad2(idx)}</span><b>${meta.name}</b></header><p>${meta.specs?.[0]?.[1] || meta.material}</p></div>`;
    calloutLayer.appendChild(el);
      const body = el.querySelector('.callout-body');
    const leader = el.querySelector('.leader');
    const len = Math.hypot(s.dx, s.dy);
    const angle = Math.atan2(s.dy, s.dx);
    leader.style.width = `${len}px`;
    leader.style.transform = `rotate(${angle}rad)`;
    body.style.left = `${s.dx}px`;
    body.style.top = `${s.dy}px`;
    body.style.transform = 'translateY(-50%)';
    if (s.flip) body.style.transform = 'translate(-100%, -50%)';
    const anchorGetter = () => {
      if (s.node === 'crank-center') return new THREE.Vector3(0, 0.65, 0.72);
      const p = new THREE.Vector3();
      s.node.getWorldPosition(p);
      return p;
    };
    CALLOUTS.push({ ...s, el, meta, anchorGetter });
    idx++;
  }
}

const tempV = new THREE.Vector3();
let labelsVisible = false;
function setLabels(on, { silent = false } = {}) {
  MODE.labels = !!on;
  labelsVisible = MODE.labels;
  if (calloutLayer) calloutLayer.hidden = !on;
  if (!silent) showToast(MODE.labels ? '零件标注已开启' : '零件标注已关闭');
}

function updateCallouts() {
  if (!labelsVisible || !calloutLayer) return;
  const w = window.innerWidth, h = window.innerHeight;
  const safeLeft = 22;
  const safeRight = w > 980 ? w - 356 : w - 10;
  const safeTop = 100;
  const safeBottom = h - 24;
  const bw = 162, bh = 38;
  const placed = [];
  const tip = $('partTooltip');
  let cardRect = null;
  if (tip.classList.contains('is-visible')) {
    const r = tip.getBoundingClientRect();
    if (r.width && r.height) cardRect = { x: r.left, y: r.top, w: r.width, h: r.height };
  }
  for (const c of CALLOUTS) {
    const world = c.anchorGetter();
    tempV.copy(world).project(camera);
    const behind = tempV.z > 1 || tempV.z < -1;
    const x = (tempV.x * 0.5 + 0.5) * w;
    const y = (-tempV.y * 0.5 + 0.5) * h;
    if (behind || x < 10 || x > w - 10) {
      c.el.classList.remove('is-visible');
      continue;
    }
    c.el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    const bodyLeft = x + c.dx - (c.flip || c.dx < 0 ? bw : 0);
    const bodyTop = y + c.dy - bh / 2;
    const rect = { x: bodyLeft, y: bodyTop, w: bw, h: bh };
    const out = rect.x < safeLeft || rect.x + bw > safeRight || rect.y < safeTop || rect.y + bh > safeBottom;
    const covered = cardRect && !(rect.x > cardRect.x + cardRect.w || rect.x + rect.w < cardRect.x || rect.y > cardRect.y + cardRect.h || rect.y + rect.h < cardRect.y);
    const overlaps = placed.some(p => !(rect.x > p.x + p.w || rect.x + rect.w < p.x || rect.y > p.y + p.h || rect.y + rect.h < p.y));
    if (out || covered || overlaps) { c.el.classList.remove('is-visible'); continue; }
    placed.push(rect);
    c.el.classList.add('is-visible');
  }
}

// ---------------------------------------------------------------------------
// Hover interaction & part card
// ---------------------------------------------------------------------------
const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();
let hoveredMesh = null;
let hoveredPartId = null;
let currentCardPart = null;
let currentCardLiveId = null;
let highlighted = null;
let pinnedCard = false;
let lastHoverRay = 0;
let pointerDirty = false;

function highlightMesh(mesh) {
  clearHighlight();
  if (!mesh || !mesh.material || Array.isArray(mesh.material)) return;
  const src = mesh.material;
  if (!('emissive' in src)) return;
  const clone = src.clone();
  clone.emissive = new THREE.Color(0x1f7280);
  clone.emissiveIntensity = src.emissiveIntensity ? Math.max(src.emissiveIntensity, 0.3) : 0.3;
  // The hover highlight should be subtle and readable even on polished steel.
  if (clone.emissiveIntensity) clone.emissiveIntensity = 0.38;
  mesh.material = clone;
  highlighted = { mesh, original: src, clone };
}
function clearHighlight() {
  if (!highlighted) return;
  highlighted.mesh.material = highlighted.original;
  highlighted.clone.dispose();
  highlighted = null;
}

function partMetaFor(mesh) {
  const raw = mesh.userData.partId;
  if (!raw) return null;
  const base = raw.replace(/-\d+$/, '');
  let meta = PARTS[raw] || PARTS[base];
  if (!meta) return null;
  const fromId = Number((raw.match(/-(\d+)$/) || [])[1]);
  const cyl = mesh.userData.cylinderIndex ?? (Number.isFinite(fromId) ? fromId : null);
  const isVariant = meta.variant != null;
  const display = { ...meta };
  if (!isVariant && cyl != null && !display.name.includes('#')) {
    display.name = `${meta.name} #${cyl + 1}`;
    display.en = `${meta.en} #${cyl + 1}`;
    display.variant = cyl;
  }
  const liveId = cyl != null ? `${base}-${cyl}` : base;
  return { raw, base, meta: display, cyl, liveId };
}

function liveStateFor(info) {
  if (!info) return '';
  return sim.liveState({ ...info.meta, id: info.liveId });
}

function categoryLabel(group) {
  const g = GROUPS[group] || GROUPS.fixed;
  return `${g.cn} · ${g.en}`;
}

function fillCard(info) {
  if (!info) return;
  const { meta, cyl } = info;
  currentCardPart = info;
  $('ttCategory').textContent = categoryLabel(meta.group);
  $('ttName').textContent = meta.name;
  $('ttEn').textContent = meta.en;
  $('ttMaterial').textContent = meta.material;
  $('ttProcess').textContent = meta.process;
  $('ttFunction').textContent = meta.function;
  $('ttSpecs').innerHTML = meta.specs.slice(0, 4).map(([k, v]) => (
    `<div class="spec-item"><span>${escapeHtml(k)}</span><b>${escapeHtml(v)}</b></div>`
  )).join('');
  $('ttCounter').textContent = cyl != null ? `CYL ${pad2(cyl + 1)} / 04 · LIVE` : `ASSEMBLY NODE · LIVE`;
  updateCardState();
}

function updateCardState() {
  if (!currentCardPart) return;
  const state = liveStateFor(currentCardPart);
  const stateEl = $('ttState');
  stateEl.innerHTML = `<i></i>${escapeHtml(state)}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

function showCard(info, clientX, clientY, { pinned = false } = {}) {
  const tooltip = $('partTooltip');
  if (!info) return;
  fillCard(info);
  pinnedCard = pinned;
  tooltip.classList.toggle('is-pinned', pinned);
  tooltip.classList.add('is-visible');
  tooltip.setAttribute('aria-hidden', 'false');
  positionCard(clientX, clientY, pinned);
  const reticle = $('hoverReticle');
  if (pinned) {
    reticle.classList.remove('is-visible');
  }
}

function positionCard(clientX, clientY, pinned = false) {
  const tooltip = $('partTooltip');
  const w = tooltip.offsetWidth || 348;
  const h = tooltip.offsetHeight || 360;
  const margin = 16;
  const rightGuard = window.innerWidth > 980 ? 356 : 14;
  const bottomGuard = 18;
  let left, top;
  if (pinned) {
    left = clamp(Math.max(268, window.innerWidth * 0.2), margin, window.innerWidth - w - rightGuard);
    top = 140;
    if (top + h > window.innerHeight - bottomGuard) top = Math.max(86, window.innerHeight - h - bottomGuard);
  } else {
    left = clientX + 22;
    top = clientY + 18;
    if (left + w > window.innerWidth - rightGuard) left = clientX - w - 22;
    if (top + h > window.innerHeight - bottomGuard) top = clientY - h - 20;
    left = clamp(left, margin, window.innerWidth - w - rightGuard);
    top = clamp(top, 86, window.innerHeight - h - bottomGuard);
  }
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function hideCard() {
  const tooltip = $('partTooltip');
  if (!tooltip) return;
  tooltip.classList.remove('is-visible');
  tooltip.setAttribute('aria-hidden', 'true');
  pinnedCard = false;
  currentCardPart = null;
  clearHighlight();
  $('hoverReticle').classList.remove('is-visible');
}

function clearHover() {
  hoveredMesh = null;
  hoveredPartId = null;
  clearHighlight();
  hideCard();
  renderer.domElement.style.cursor = 'grab';
}

function isOccludedByShell(hit) {
  if (!MODE.xray) return false;
  return !!(hit.object.userData && hit.object.userData.shell);
}

function pickPartAt(clientX, clientY) {
  if (!engine) return null;
  const rect = renderer.domElement.getBoundingClientRect();
  pointerNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  pointerNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointerNdc, camera);
  const hits = raycaster.intersectObjects(engine.raycastMeshes, false);
  for (const hit of hits) {
    if (!hit.object.visible) continue;
    if (isOccludedByShell(hit)) continue;
    // Do not make internal glow geometry pickable.
    if (!hit.object.userData.partId) continue;
    return hit;
  }
  return null;
}

function processHover(clientX, clientY) {
  const hit = pickPartAt(clientX, clientY);
  if (!hit) {
    if (hoveredMesh) {
      hoveredMesh = null;
      hoveredPartId = null;
      hideCard();
      renderer.domElement.style.cursor = 'grab';
    }
    return;
  }
  const info = partMetaFor(hit.object);
  if (!info) return;
  if (hoveredMesh !== hit.object) {
    hoveredMesh = hit.object;
    hoveredPartId = hit.object.userData.partId;
    highlightMesh(hit.object);
    fillCard(info);
    showCard(info, clientX, clientY);
    renderer.domElement.style.cursor = 'crosshair';
    const reticle = $('hoverReticle');
    reticle.style.left = `${clientX}px`;
    reticle.style.top = `${clientY}px`;
    reticle.classList.add('is-visible');
  } else {
    // Keep the state fresh and the card tracking the pointer without reflowing content.
    updateCardState();
    positionCard(clientX, clientY);
    const reticle = $('hoverReticle');
    reticle.style.left = `${clientX}px`;
    reticle.style.top = `${clientY}px`;
    reticle.classList.add('is-visible');
  }
}

function bindHover() {
  const canvas = renderer.domElement;
  window.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    lastPointerEvent = { clientX: e.clientX, clientY: e.clientY };
    if (e.target !== canvas) {
      pointerInsideCanvas = false;
      if (!pinnedCard) {
        hoveredMesh = null;
        hoveredPartId = null;
        clearHighlight();
        hideCard();
        renderer.domElement.style.cursor = 'grab';
      }
      return;
    }
    pointerInsideCanvas = true;
    pointerDirty = true;
    if (performance.now() - lastHoverRay > 45) {
      lastHoverRay = performance.now();
      processHover(e.clientX, e.clientY);
      pointerDirty = false;
    }
  }, { passive: true });
  canvas.addEventListener('pointerleave', () => {
    pointerInsideCanvas = false;
    if (!pinnedCard) {
      hoveredMesh = null;
      hideCard();
      renderer.domElement.style.cursor = 'grab';
    }
  });
  let press = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) {
      press = null;
      return;
    }
    press = {
      x: e.clientX,
      y: e.clientY,
      t: performance.now(),
      pointerType: e.pointerType,
      moved: 0,
    };
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!press) return;
    press.moved = Math.max(press.moved, Math.hypot(e.clientX - press.x, e.clientY - press.y));
  });
  canvas.addEventListener('pointerup', (e) => {
    if (!press) return;
    const threshold = press.pointerType === 'touch' ? 11 : 7;
    const elapsed = performance.now() - press.t;
    const isClick = press.moved < threshold && elapsed < 700;
    press = null;
    if (!isClick) return;
    const hit = pickPartAt(e.clientX, e.clientY);
    if (!hit) {
      // Clicking empty space is the quickest way back to the assembled model.
      if (MODE.exploded) {
        setExploded(false);
      } else if (pinnedCard) {
        hideCard();
      }
      return;
    }
    const info = partMetaFor(hit.object);
    if (!info) return;
    handlePartSelection(info, e.clientX, e.clientY, { touch: e.pointerType === 'touch' });
  });
  window.addEventListener('blur', () => {
    pointerInsideCanvas = false;
    press = null;
    hideCard();
  });
}

// ---------------------------------------------------------------------------
// UI bindings
// ---------------------------------------------------------------------------
let toastTimer = null;
function showToast(text) {
  const el = $('statusToast');
  if (!el) return;
  el.textContent = text;
  el.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-visible'), 2400);
}

function setSliderFill(input) {
  if (!input) return;
  const min = Number(input.min), max = Number(input.max);
  const pct = ((Number(input.value) - min) / (max - min)) * 100;
  input.style.setProperty('--fill', `${pct}%`);
}

function initBackgroundMusic() {
  const audio = $('bgm');
  if (!audio) return;
  audio.loop = true;
  audio.volume = 0.34;
  let listening = true;
  const note = document.querySelector('.bgm-note');
  const markPlaying = () => {
    if (!note) return;
    note.classList.add('is-playing');
    note.textContent = 'BGM · brworkstudio《迷离时空》';
  };
  const stopListeners = () => {
    if (!listening) return;
    listening = false;
    for (const ev of ['pointerdown', 'touchstart', 'keydown']) {
      window.removeEventListener(ev, unlock);
    }
  };
  const play = () => {
    if (!audio.paused) return;
    const p = audio.play();
    if (p?.catch) p.catch(() => {});
  };
  const unlock = () => {
    play();
    if (!audio.paused) stopListeners();
  };
  audio.addEventListener('playing', () => {
    markPlaying();
    stopListeners();
  });
  // Try immediately (some browsers allow this for local/embedded files), then
  // fall back to the first user gesture. The track is intentionally looped and
  // not tied to engine speed or pause state.
  play();
  for (const ev of ['pointerdown', 'touchstart', 'keydown']) {
    window.addEventListener(ev, unlock, { passive: true });
  }
}

function setRunningUI() {
  const running = sim.running;
  MODE.running = running;
  const btn = $('btnRun');
  if (btn) {
    btn.classList.toggle('is-paused', !running);
    btn.setAttribute('aria-label', running ? '暂停发动机运转' : '继续发动机运转');
  }
  const online = $('onlineLabel');
  if (online) online.textContent = running ? 'SIMULATION ONLINE' : 'SIMULATION PAUSED';
}

function toggleRunning(force) {
  if (typeof force === 'boolean') sim.setRunning(force); else sim.toggleRunning();
  setRunningUI();
  showToast(sim.running ? '四冲程循环继续 · 曲轴运转中' : '仿真已暂停 · 所有机构保持当前位置');
}

function setTelemetryOpen(open) {
  const panel = $('telemetry');
  const toggle = $('btnTelemetryMobile');
  if (!panel) return;
  panel.classList.toggle('is-open', !!open);
  if (toggle) {
    toggle.classList.toggle('is-open', !!open);
    const label = toggle.querySelector('span');
    if (label) label.textContent = open ? '收起' : '数据';
    toggle.setAttribute('aria-label', open ? '关闭台架数据' : '打开台架数据');
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  if (open) hideCard();
}

function bindUI() {
  $('btnRun').addEventListener('click', () => toggleRunning());
  $('btnStep').addEventListener('click', () => {
    sim.setRunning(false);
    setRunningUI();
    sim.stepDegrees(30);
    engine.update(sim, 0.016);
    showToast('单步 +30° CA · 运动学已重新求解');
  });
  $('btnReset').addEventListener('click', () => {
    sim.reset();
    setRunningUI();
    if (MODE.exploded) setExploded(false, { silent: true });
    if (MODE.xray) setXray(false, { silent: true, toast: false });
    showToast('仿真状态已重置 · 1 缸压缩上止点');
  });
  $('btnSection').addEventListener('click', toggleSectionView);
  $('btnTelemetryMobile')?.addEventListener('click', () => {
    setTelemetryOpen(!$('telemetry')?.classList.contains('is-open'));
  });
  $('btnTelemetryClose')?.addEventListener('click', () => setTelemetryOpen(false));

  window.addEventListener('keydown', (e) => {
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (e.key === 'Escape') {
      if (MODE.exploded) setExploded(false);
      return;
    }
    if (e.key === ' ') { e.preventDefault(); toggleRunning(); return; }
    if (e.key.toLowerCase() === 'x') { toggleSectionView(); return; }
    if (e.key.toLowerCase() === 'r') {
      sim.reset();
      setRunningUI();
      if (MODE.exploded) setExploded(false, { silent: true });
      if (MODE.xray) setXray(false, { silent: true, toast: false });
      showToast('仿真状态已重置');
      return;
    }
    if (['1', '2', '3', '4'].includes(e.key)) {
      setView(['free', 'front', 'side', 'top'][Number(e.key) - 1]);
    }
  });

  const rpm = $('rpmSlider');
  const load = $('loadSlider');
  setSliderFill(rpm);
  setSliderFill(load);
  rpm.addEventListener('input', () => {
    sim.setRpm(Number(rpm.value));
    $('rpmTargetValue').textContent = Number(rpm.value).toLocaleString('en-US');
    setSliderFill(rpm);
  });
  load.addEventListener('input', () => {
    sim.setLoad(Number(load.value));
    $('loadTargetValue').textContent = rpm.value ? Number(load.value) : 0;
    setSliderFill(load);
  });

  $$('.view-btn').forEach(btn => btn.addEventListener('click', () => setView(btn.dataset.view)));
  controls.addEventListener('start', () => {
    if (cameraTween) return;
    if (!MODE.exploded) {
      MODE.view = 'free';
      updateViewButtons('free');
    } else {
      updateViewButtons(null);
    }
    if (!pinnedCard) hideCard();
  });

  buildCylinderCells();
  updateViewButtons('free');
  updateSectionUI();
  updateModeLabel();
  setRunningUI();
  initBackgroundMusic();

  renderer.domElement.addEventListener('dblclick', () => {
    setView(MODE.view || 'free', { silent: true });
  });
}

function buildCylinderCells() {
  const grid = $('cylinderGrid');
  if (!grid) return;
  grid.innerHTML = ENGINE.cylinders.map((c, i) => `
    <div class="cyl-cell" data-cyl="${i}" style="--phase-color:${strokeInfo(cylinderCycleAngle(i, sim.crankAngle)).color}">
      <span class="cyl-num">${pad2(i + 1)}</span>
      <span class="cyl-phase">—</span>
      <span class="cyl-pct">00%</span>
      <span class="cyl-dir">↓</span>
    </div>`).join('');
}

// ---------------------------------------------------------------------------
// Telemetry updates
// ---------------------------------------------------------------------------
let lastUiUpdate = 0;
let lastFpsSample = performance.now();
let fpsFrames = 0;
let fpsDisplay = 60;
const QA_MODE = new URLSearchParams(window.location.search).get('qa') === '1';
let adaptiveLevel = 0;
let lowFpsSamples = 0;
let lastAdaptiveCheck = performance.now();

function applyAdaptiveQuality(level) {
  if (level <= adaptiveLevel) return;
  adaptiveLevel = level;
  const w = window.innerWidth, h = window.innerHeight;
  if (level >= 1) {
    renderer.setPixelRatio(1);
    composer.setPixelRatio(1);
    composer.setSize(w, h);
    fxaaPass.material.uniforms.resolution.value.set(1 / w, 1 / h);
    bloomPass.enabled = false;
  }
  if (level >= 2) {
    renderer.shadowMap.enabled = false;
  }
}

function checkAdaptive(now) {
  if (QA_MODE || adaptiveLevel >= 2) return;
  if (now - lastAdaptiveCheck < 1600) return;
  lastAdaptiveCheck = now;
  if (now < 7000) return;
  if (fpsDisplay > 50) {
    lowFpsSamples = Math.max(0, lowFpsSamples - 1);
    return;
  }
  lowFpsSamples++;
  if (lowFpsSamples >= 3) applyAdaptiveQuality(adaptiveLevel + 1);
}

function updateTelemetry(now) {
  const rpm = sim.running ? sim.rpm : 0;
  const ratio = clamp(rpm / 2400, 0, 1);
  const targetRatio = clamp(sim.rpmTarget / 2400, 0, 1);
  $('rpmValue').textContent = Math.round(rpm).toLocaleString('en-US');
  $('rpmTargetValue').textContent = Number(sim.rpmTarget).toLocaleString('en-US');
  $('loadTargetValue').textContent = Math.round(sim.loadTarget);
  $('rpmFill').style.width = `${ratio * 100}%`;
  $('rpmCursor').style.left = `${ratio * 100}%`;
  $('rpmTargetCursor').style.left = `${targetRatio * 100}%`;

  const data = sim.cylinderData(0);
  $('angleValue').textContent = fmt(data.cycle, 1);
  $('cycleCount').textContent = pad2(1 + (sim.cycleCounter || 0));
  $('strokeNum').textContent = pad2(data.stroke.index + 1);
  $('strokeName').textContent = data.stroke.cn;
  $('strokeEN').textContent = data.stroke.en;

  const dirs = ['↓', '↑', '↓', '↑'];
  $$('.cyl-cell').forEach((cell, i) => {
    const d = sim.cylinderData(i);
    cell.style.setProperty('--phase-color', d.stroke.color);
    cell.querySelector('.cyl-phase').textContent = d.stroke.cn;
    cell.querySelector('.cyl-pct').textContent = `${Math.round(d.stroke.progress * 100)}%`;
    const dir = cell.querySelector('.cyl-dir');
    if (dir) dir.textContent = dirs[d.stroke.index] || '·';
    cell.classList.toggle('is-firing', sim.combustion[i] > 0.08 || sim.injecting[i] > 0);
  });

  $('tempValue').textContent = fmt(sim.waterTemp, 1);
  $('oilValue').textContent = fmt(sim.oilPressure, 1);
  $('boostValue').textContent = fmt(sim.boost, 2);
  $('tempBar').style.width = `${clamp((sim.waterTemp - 20) / 90, 0, 1) * 100}%`;
  $('oilBar').style.width = `${clamp(sim.oilPressure / 6, 0, 1) * 100}%`;
  $('boostBar').style.width = `${clamp(sim.boost / 1.7, 0, 1) * 100}%`;

  if (currentCardPart) updateCardState();
}

let loadingFinished = false;
function finishLoading() {
  if (loadingFinished) return;
  loadingFinished = true;
  const load = $('loadingScreen');
  const bar = $('loaderProgress');
  const status = $('loaderStatus');
  if (bar) bar.style.width = '100%';
  if (status) status.textContent = 'RIG READY / KINEMATICS ONLINE';
  setTimeout(() => {
    load.classList.add('is-hidden');
    setTimeout(() => { load.style.display = 'none'; }, 900);
    setTimeout(() => {
      const coarse = window.matchMedia?.('(pointer: coarse)').matches;
      showToast(coarse
        ? '点击任意处开始背景音乐 · 点按零件拆解 · 右上角“数据”查看仪表'
        : '点击任意处开始 BGM · 点击零件拆解 · 点击空白还原');
    }, 1100);
  }, 320);
}

function loadState() {
  const bar = $('loaderProgress');
  const status = $('loaderStatus');
  if (bar) bar.style.width = '78%';
  if (status) status.textContent = 'COMPILING PBR SHADERS · SOLVING KINEMATICS';
  // Fail-safe: never trap the viewer behind the loading overlay.
  setTimeout(finishLoading, 14000);
  updateTelemetry(performance.now());
}

// ---------------------------------------------------------------------------
// Resize & main loop
// ---------------------------------------------------------------------------
window.addEventListener('resize', () => {
  if (!renderer) return;
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.fov = w / h < 0.8 ? 62 : 35;
  applyCameraViewOffset();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, w < 1000 ? 1.3 : 1.5));
  renderer.setSize(w, h);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(w, h);
  fxaaPass.material.uniforms.resolution.value.set(
    1 / (w * renderer.getPixelRatio()),
    1 / (h * renderer.getPixelRatio())
  );
  bloomPass.setSize(w, h);
});

function animate(now) {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  sim.update(dt);
  // Dynamic shadows can update at a lower cadence than the render loop without
  // affecting silhouettes; internal motion is tiny at the displayed slow-motion
  // scale. This keeps the sun map off the critical path on integrated GPUs.
  if (!animate._shadowFrame) animate._shadowFrame = 0;
  animate._shadowFrame++;
  if (sim.running && animate._shadowFrame % 5 === 0) renderer.shadowMap.needsUpdate = true;
  if (MODE.exploded && explodeCurrent < 1) {
    explodeCurrent = Math.min(1, explodeCurrent + dt * 1.8);
    applyExplode(easeInOut(explodeCurrent));
  } else if (!MODE.exploded && explodeCurrent > 0) {
    explodeCurrent = Math.max(0, explodeCurrent - dt * 2.35);
    applyExplode(easeInOut(explodeCurrent));
  }
  engine.update(sim, dt);
  updateSelectionHelper(now);
  flow.update(dt, sim);
  if (window.__dust) window.__dust.rotation.y += dt * 0.008;
  if (composer) {
    if (updateCameraTween(now)) {
      // Camera is animated explicitly; skip OrbitControls during the tween.
    } else {
      controls.update();
    }
    updateCallouts();
    if (pointerInsideCanvas && pointerDirty && performance.now() - lastHoverRay > 90) {
      lastHoverRay = performance.now();
      processHover(lastPointerEvent.clientX, lastPointerEvent.clientY);
      pointerDirty = false;
    }
    fpsFrames++;
    if (now - lastFpsSample > 620) {
      fpsDisplay = Math.round((fpsFrames * 1000) / (now - lastFpsSample));
      $('fpsValue').textContent = Math.max(1, Math.min(240, fpsDisplay));
      fpsFrames = 0;
      lastFpsSample = now;
      checkAdaptive(now);
    }
    if (now - lastUiUpdate > 90) {
      lastUiUpdate = now;
      updateTelemetry(now);
    }
    if (postEnabled) composer.render();
    else renderer.render(scene, camera);
  } else {
    renderer.render(scene, camera);
  }
  if (firstFrame) {
    firstFrame = false;
    window.__DIESEL_READY__ = true;
    finishLoading();
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
try {
  init();
} catch (err) {
  console.error('Initialization failed:', err);
  showFallback('初始化过程中发生错误：' + (err?.message || String(err)));
}

// Expose a compact QA / embedding API. This is intentionally read-mostly.
window.__DIESEL__ = {
  get ready() { return !!window.__DIESEL_READY__; },
  get sim() { return sim; },
  get engine() { return engine; },
  get flow() { return flow; },
  get scene() { return scene; },
  get camera() { return camera; },
  get renderer() { return renderer; },
  get composer() { return composer; },
  get controls() { return controls; },
  get selected() { return selectedPartInfo; },
  setView,
  setXray,
  setExploded,
  setLabels,
  toggleSectionView,
  openPart(id) {
    const meta = PARTS[id];
    if (!meta) return false;
    const info = { raw: id, base: id.replace(/-\d+$/, ''), meta, cyl: null, liveId: id };
    showCard(info, 0, 0, { pinned: true });
    return true;
  },
  stats() {
    if (!engine) return {};
    return {
      meshes: engine.stats?.meshes || 0,
      uniqueParts: engine.stats?.uniqueParts || 0,
      triangles: engine.stats?.triangles || 0,
      drawCalls: renderer?.info.render.calls || 0,
      crankAngle: sim?.crankAngle,
      rpm: sim?.rpm,
      xray: MODE.xray,
      exploded: MODE.exploded,
      labels: MODE.labels,
      selected: selectedPartInfo?.meta?.name || null,
      fps: fpsDisplay,
      adaptiveLevel,
    };
  },
  setQuality(level) {
    applyAdaptiveQuality(Number(level) || 0);
  },
};
