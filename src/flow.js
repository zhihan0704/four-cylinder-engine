import * as THREE from 'three';
import { canvasTexture } from './geometry.js';

const flowVert = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const flowFrag = /* glsl */`
  uniform vec3 uColor;
  uniform vec3 uHotColor;
  uniform float uTime;
  uniform float uSpeed;
  uniform float uOpacity;
  varying vec2 vUv;

  void main() {
    float x = fract(vUv.x * 7.0 - uTime * uSpeed);
    float head = smoothstep(0.0, 0.045, x) * (1.0 - smoothstep(0.055, 0.22, x));
    float tail = smoothstep(0.0, 0.3, x) * (1.0 - smoothstep(0.32, 0.72, x)) * 0.24;
    float pulse = head + tail;
    float edge = smoothstep(0.0, 0.26, vUv.y) * (1.0 - smoothstep(0.74, 1.0, vUv.y));
    float core = 0.16 + 0.18 * edge;
    vec3 col = mix(uColor, uHotColor, head);
    float alpha = (core + pulse * 0.9) * uOpacity * (0.3 + 0.7 * edge);
    gl_FragColor = vec4(col, alpha);
  }
`;

const dotTexture = canvasTexture(128, 128, (ctx, w, h) => {
  const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(210,245,255,0.92)');
  g.addColorStop(0.55, 'rgba(120,210,230,0.32)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
});

function createFlowMaterial(color, hotColor, speed = 1) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uHotColor: { value: new THREE.Color(hotColor) },
      uTime: { value: 0 },
      uSpeed: { value: speed },
      uOpacity: { value: 0.9 },
    },
    vertexShader: flowVert,
    fragmentShader: flowFrag,
    transparent: true,
    depthWrite: false,
    // Streamlines are deliberately holographic: they remain legible through an
    // assembled engine, then brighten in X-Ray mode. The HUD toggles let the
    // operator hide either circuit when the overlay gets busy.
    depthTest: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

function helixCurve(cx, y0, y1, radius, turns = 3.0, sign = 1) {
  const points = [];
  const n = 90;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = t * Math.PI * 2 * turns * sign;
    points.push(new THREE.Vector3(cx + Math.cos(a) * radius, y0 + (y1 - y0) * t, Math.sin(a) * radius));
  }
  return new THREE.CatmullRomCurve3(points, false, 'centripetal', 0.2);
}

export class FlowSystem {
  constructor(engine, sim) {
    this.engine = engine;
    this.sim = sim;
    this.group = new THREE.Group();
    this.group.name = 'Fluid flow visualization';
    this.group.renderOrder = 6;
    this.visible = true;
    this.showOil = true;
    this.showCoolant = true;
    this.waterPhase = 0;
    this.oilPhase = 0;
    this.paths = { coolant: [], oil: [] };
    this.groups = {};
    this.materials = {};
    this.dotMaterials = {};
    this.createNetworks();
  }

  addPath(fluid, curve, radius = 0.022) {
    const mat = this.materials[fluid];
    const geo = new THREE.TubeGeometry(curve, Math.max(36, Math.round(curve.getLength() * 22)), radius, 7, false);
    const tube = new THREE.Mesh(geo, mat);
    tube.renderOrder = 7;
    tube.frustumCulled = false;
    this.groups[fluid].add(tube);
    this.paths[fluid].push(curve);
    return tube;
  }

  addDots(fluid, curve, count = 8, size = 0.075) {
    const positions = new Float32Array(count * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const points = new THREE.Points(geo, this.dotMaterials[fluid]);
    points.frustumCulled = false;
    points.renderOrder = 8;
    this.groups[fluid].add(points);
    this.dotsList = this.dotsList || [];
    this.dotsList.push({ fluid, curve, count, points, positions });
  }

  createNetworks() {
    this.materials.coolant = createFlowMaterial(0x247f95, 0xa7f8ff, 1.0);
    this.materials.oil = createFlowMaterial(0x8c5312, 0xffc25f, 0.9);
    this.materials.coolantDot = new THREE.PointsMaterial({
      size: 0.055, map: dotTexture, color: 0x70e5f4, transparent: true, opacity: 0.85,
      depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
    });
    this.materials.oilDot = new THREE.PointsMaterial({
      size: 0.052, map: dotTexture, color: 0xffb14e, transparent: true, opacity: 0.85,
      depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
    });
    this.dotMaterials.coolant = this.materials.coolantDot;
    this.dotMaterials.oil = this.materials.oilDot;
    this.groups.coolant = new THREE.Group();
    this.groups.oil = new THREE.Group();
    this.groups.coolant.name = 'Coolant flow';
    this.groups.oil.name = 'Oil flow';
    this.group.add(this.groups.coolant, this.groups.oil);

    const f = this.engine.fluid;
    if (!f) return;
    for (const key of ['jacket', 'head', 'upperHose', 'radiator', 'return']) {
      if (f.coolant[key]) {
        this.addPath('coolant', f.coolant[key], key === 'radiator' ? 0.02 : 0.023);
        this.addDots('coolant', f.coolant[key], key === 'jacket' ? 16 : 8);
      }
    }
    // Four helical jacket streamlines around the liners.
    for (let i = 0; i < 4; i++) {
      const x = [2.01, 0.67, -0.67, -2.01][i];
      const curve = helixCurve(x, 1.15, 3.12, 0.563, 2.6, i % 2 ? 1 : -1);
      this.addPath('coolant', curve, 0.014);
      this.addDots('coolant', curve, 4, 0.06);
    }
    for (const key of ['pickup', 'pump', 'filter', 'filterIn', 'cooler', 'gallery', 'head', 'return']) {
      if (f.oil[key]) {
        this.addPath('oil', f.oil[key], key === 'filter' || key === 'head' ? 0.019 : 0.021);
        this.addDots('oil', f.oil[key], 7);
      }
    }
  }

  setVisible(v) {
    this.visible = v;
    this.group.visible = v;
  }

  setFluidVisible(fluid, v) {
    if (fluid === 'oil') this.showOil = v;
    if (fluid === 'coolant') this.showCoolant = v;
    if (this.groups[fluid]) this.groups[fluid].visible = v;
  }

  setCutaway(on) {
    this.cutaway = !!on;
    this.group.renderOrder = on ? 12 : 6;
  }

  update(dt, sim) {
    const rpm = sim.running ? sim.rpm : 0;
    const load = sim.load / 100;
    const flowFactor = Math.max(0, rpm / 900) * (0.5 + load * 0.8);
    this.waterPhase += dt * (0.12 + flowFactor * 1.1);
    this.oilPhase += dt * (0.1 + flowFactor * 0.9);
    this.materials.coolant.uniforms.uTime.value = this.waterPhase;
    this.materials.oil.uniforms.uTime.value = this.oilPhase;
    this.materials.coolant.uniforms.uSpeed.value = 0.55 + flowFactor * 1.4;
    this.materials.oil.uniforms.uSpeed.value = 0.5 + flowFactor * 1.25;
    const cutBoost = this.cutaway ? 0.3 : 0;
    this.materials.coolant.uniforms.uOpacity.value = this.visible ? 0.2 + flowFactor * 0.16 + cutBoost : 0;
    this.materials.oil.uniforms.uOpacity.value = this.visible ? 0.22 + flowFactor * 0.14 + cutBoost : 0;
    this.materials.coolantDot.opacity = this.visible ? 0.17 + flowFactor * 0.2 + (this.cutaway ? 0.3 : 0) : 0;
    this.materials.oilDot.opacity = this.visible ? 0.17 + flowFactor * 0.2 + (this.cutaway ? 0.3 : 0) : 0;

    if (this.dotsList) {
      for (const d of this.dotsList) {
        const phase = d.fluid === 'coolant' ? this.waterPhase : this.oilPhase;
        const speed = 0.08 + flowFactor * 0.45;
        for (let i = 0; i < d.count; i++) {
          const t = ((i / d.count + phase * speed) % 1 + 1) % 1;
          const p = d.curve.getPointAt(t);
          d.positions[i * 3] = p.x;
          d.positions[i * 3 + 1] = p.y;
          d.positions[i * 3 + 2] = p.z;
        }
        d.points.geometry.attributes.position.needsUpdate = true;
      }
    }
  }
}
