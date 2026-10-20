import * as THREE from 'three';
import { canvasTexture } from './geometry.js';

function grainTexture(size = 256, strength = 0.5) {
  return canvasTexture(size, size, (ctx, w, h) => {
    const img = ctx.createImageData(w, h);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 112 + (Math.random() - 0.5) * 88 * strength;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    // Fine cast pores.
    ctx.globalAlpha = 0.18;
    for (let i = 0; i < 900; i++) {
      const r = Math.random() * 1.4 + 0.2;
      ctx.fillStyle = Math.random() > 0.5 ? '#2b2b2b' : '#dadada';
      ctx.beginPath();
      ctx.arc(Math.random() * w, Math.random() * h, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }, { colorSpace: THREE.NoColorSpace });
}
function brushTexture(size = 512) {
  return canvasTexture(size, size, (ctx, w, h) => {
    ctx.fillStyle = '#8a8a8a';
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 3400; i++) {
      const y = Math.random() * h;
      const x = Math.random() * w;
      const len = 10 + Math.random() * 90;
      const shade = 70 + Math.random() * 130;
      ctx.strokeStyle = `rgba(${shade},${shade},${shade},${0.12 + Math.random() * 0.22})`;
      ctx.lineWidth = 0.5 + Math.random();
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + len, y + (Math.random() - 0.5) * 0.7);
      ctx.stroke();
    }
  }, { colorSpace: THREE.NoColorSpace });
}

export function createMaterials() {
  const grain = grainTexture();
  grain.wrapS = grain.wrapT = THREE.RepeatWrapping;
  grain.repeat.set(3.4, 3.4);
  const grainFine = grainTexture(256, 0.3);
  grainFine.wrapS = grainFine.wrapT = THREE.RepeatWrapping;
  grainFine.repeat.set(7, 7);
  const brush = brushTexture();
  brush.wrapS = brush.wrapT = THREE.RepeatWrapping;
  brush.repeat.set(2, 2);

  const std = (opts) => new THREE.MeshStandardMaterial(opts);
  const phys = (opts) => new THREE.MeshPhysicalMaterial(opts);

  const M = {
    castIron: std({
      color: 0x38464b, metalness: 0.76, roughness: 0.52,
      bumpMap: grain, bumpScale: 0.0018,
    }),
    castIronDark: std({
      color: 0x1f2b2f, metalness: 0.7, roughness: 0.6,
      bumpMap: grain, bumpScale: 0.0022,
    }),
    blockPaint: phys({
      color: 0x293b40, metalness: 0.62, roughness: 0.44, clearcoat: 0.24, clearcoatRoughness: 0.5,
      bumpMap: grain, bumpScale: 0.0013,
    }),
    coverPaint: phys({
      color: 0x22343a, metalness: 0.64, roughness: 0.32, clearcoat: 0.62, clearcoatRoughness: 0.28,
      bumpMap: grainFine, bumpScale: 0.0006,
    }),
    aluCast: std({
      color: 0x738085, metalness: 0.88, roughness: 0.38,
      bumpMap: grainFine, bumpScale: 0.0008,
    }),
    aluHead: std({
      color: 0x627277, metalness: 0.9, roughness: 0.35,
      bumpMap: grainFine, bumpScale: 0.0007,
    }),
    aluMachined: phys({
      color: 0xa8b1b3, metalness: 0.95, roughness: 0.2,
      roughnessMap: brush, clearcoat: 0.18, clearcoatRoughness: 0.2,
    }),
    aluDark: std({ color: 0x36444a, metalness: 0.86, roughness: 0.44 }),
    forgedSteel: phys({
      color: 0x68757b, metalness: 0.97, roughness: 0.27, clearcoat: 0.16, clearcoatRoughness: 0.31,
      roughnessMap: brush,
    }),
    steelDark: std({ color: 0x293338, metalness: 0.9, roughness: 0.36 }),
    polishedSteel: phys({
      color: 0xabb6ba, metalness: 1, roughness: 0.15, clearcoat: 0.4, clearcoatRoughness: 0.1,
    }),
    crankSteel: phys({
      color: 0x6e7c83, metalness: 0.98, roughness: 0.21, clearcoat: 0.25, clearcoatRoughness: 0.25,
      bumpMap: grainFine, bumpScale: 0.0003,
    }),
    rodSteel: phys({
      color: 0x7b888c, metalness: 0.94, roughness: 0.29, clearcoat: 0.2, clearcoatRoughness: 0.35,
    }),
    pistonAlu: phys({
      color: 0xb1aa99, metalness: 0.76, roughness: 0.3, clearcoat: 0.34, clearcoatRoughness: 0.3,
    }),
    pistonTop: std({ color: 0x514c41, metalness: 0.68, roughness: 0.54 }),
    ringSteel: std({ color: 0x1f272a, metalness: 0.88, roughness: 0.29 }),
    valveSteel: phys({ color: 0x777971, metalness: 0.93, roughness: 0.24, clearcoat: 0.3 }),
    valveHot: phys({ color: 0x6b5245, metalness: 0.86, roughness: 0.34, clearcoat: 0.2 }),
    springSteel: std({ color: 0x34566b, metalness: 0.92, roughness: 0.24 }),
    copper: std({ color: 0xa9663e, metalness: 1, roughness: 0.25 }),
    brass: std({ color: 0xa8894d, metalness: 1, roughness: 0.29 }),
    rubber: phys({
      color: 0x0a0e10, metalness: 0.02, roughness: 0.66, clearcoat: 0.24, clearcoatRoughness: 0.55,
      sheen: 0.18, sheenColor: 0x3e4b50,
    }),
    hose: phys({
      color: 0x101619, metalness: 0.06, roughness: 0.52, clearcoat: 0.38, clearcoatRoughness: 0.42,
    }),
    plastic: std({ color: 0x101518, metalness: 0.08, roughness: 0.56 }),
    plasticLight: std({ color: 0x222b2f, metalness: 0.15, roughness: 0.46 }),
    paintedSteel: phys({
      color: 0x192327, metalness: 0.52, roughness: 0.35, clearcoat: 0.52, clearcoatRoughness: 0.33,
    }),
    blackOxide: std({ color: 0x151c20, metalness: 0.8, roughness: 0.34 }),
    gearSteel: phys({ color: 0x6e7a7e, metalness: 1, roughness: 0.21, clearcoat: 0.35 }),
    turboAlu: phys({ color: 0x98a4a7, metalness: 0.98, roughness: 0.19, clearcoat: 0.4 }),
    turboHot: std({
      color: 0x312b27, metalness: 0.58, roughness: 0.72,
      bumpMap: grain, bumpScale: 0.0021,
    }),
    exhaustCast: std({
      color: 0x332c27, metalness: 0.56, roughness: 0.7,
      bumpMap: grain, bumpScale: 0.0019,
    }),
    intakeCast: std({
      color: 0x536065, metalness: 0.9, roughness: 0.38,
      bumpMap: grainFine, bumpScale: 0.0008,
    }),
    radiatorAlu: std({ color: 0x5e6a6d, metalness: 0.84, roughness: 0.43 }),
    gasketMetal: std({ color: 0x816449, metalness: 0.92, roughness: 0.39 }),
    gasketRubber: std({ color: 0x131515, metalness: 0.05, roughness: 0.82 }),
    oil: phys({
      color: 0x9c5f12, metalness: 0, roughness: 0.08, transparent: true, opacity: 0.7,
      transmission: 0.2, thickness: 0.3, clearcoat: 1, emissive: 0x1d0d00, emissiveIntensity: 0.32,
    }),
    coolant: phys({
      color: 0x2b95ae, metalness: 0, roughness: 0.12, transparent: true, opacity: 0.42,
      transmission: 0.2, thickness: 0.3, clearcoat: 0.8, emissive: 0x053a46, emissiveIntensity: 0.45,
      side: THREE.DoubleSide, depthWrite: false,
    }),
    coolantJacket: phys({
      color: 0x2a9fba, metalness: 0, roughness: 0.16, transparent: true, opacity: 0.19,
      transmission: 0.28, thickness: 0.45, clearcoat: 0.7, emissive: 0x063641, emissiveIntensity: 0.7,
      side: THREE.DoubleSide, depthWrite: false,
    }),
    oilJacket: phys({
      color: 0xc27b1e, metalness: 0, roughness: 0.2, transparent: true, opacity: 0.23,
      transmission: 0.2, thickness: 0.2, depthWrite: false, side: THREE.DoubleSide,
    }),
    flame: new THREE.MeshBasicMaterial({
      color: 0xff842d, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false,
    }),
    ember: new THREE.MeshBasicMaterial({
      color: 0xffb35a, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false,
    }),
    cyanGlow: new THREE.MeshBasicMaterial({
      color: 0x48d9ea, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false,
    }),
    amberGlow: new THREE.MeshBasicMaterial({
      color: 0xffa12d, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false,
    }),
    belt: phys({
      color: 0x0c0f10, metalness: 0.12, roughness: 0.56, clearcoat: 0.2,
      bumpMap: grainFine, bumpScale: 0.001,
    }),
    redAccent: std({ color: 0x8f3024, metalness: 0.65, roughness: 0.38 }),
    orangeFilter: std({ color: 0xb55b1e, metalness: 0.58, roughness: 0.36 }),
    whitePrint: std({ color: 0xbcc3c1, metalness: 0.25, roughness: 0.5 }),
    copperWind: std({ color: 0x925332, metalness: 0.9, roughness: 0.36 }),
    ceramic: std({ color: 0xd7d0c1, metalness: 0.1, roughness: 0.3 }),
    sensor: std({ color: 0x263137, metalness: 0.4, roughness: 0.38 }),
    wiring: std({ color: 0x101417, metalness: 0.1, roughness: 0.72 }),
    bearing: std({ color: 0x9e8d6e, metalness: 0.9, roughness: 0.31 }),
    screenDark: new THREE.MeshBasicMaterial({ color: 0x061013 }),
  };

  // Register environment response.
  for (const material of Object.values(M)) {
    if (material.isMeshStandardMaterial || material.isMeshPhysicalMaterial) {
      material.envMapIntensity = 1.15;
    }
  }

  return M;
}

export function makeXrayMaterial(source) {
  const m = source.clone();
  m.transparent = true;
  m.opacity = 0.105;
  m.depthWrite = false;
  m.side = THREE.DoubleSide;
  m.envMapIntensity = 0.48;
  m.metalness = Math.min(source.metalness ?? 0.4, 0.5);
  m.color = source.color ? source.color.clone().lerp(new THREE.Color(0x5c8990), 0.42) : new THREE.Color(0x5c8990);
  m.roughness = Math.min(0.5, (source.roughness ?? 0.4) + 0.08);
  if (m.clearcoat !== undefined) m.clearcoat = 0.06;
  return m;
}
