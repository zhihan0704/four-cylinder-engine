import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

export { THREE };

export function roundedBox(w, h, d, radius = 0.04, seg = 3) {
  return new RoundedBoxGeometry(w, h, d, seg, Math.min(radius, Math.min(w, h, d) * 0.45));
}

export function box(w, h, d) {
  return new THREE.BoxGeometry(w, h, d);
}

export function cylinder(rTop, rBottom, h, radial = 32, open = false) {
  return new THREE.CylinderGeometry(rTop, rBottom, h, radial, 1, open);
}

export function alongX(mesh) {
  mesh.rotation.z = Math.PI / 2;
  return mesh;
}

export function alongZ(mesh) {
  mesh.rotation.x = Math.PI / 2;
  return mesh;
}

export function mesh(geometry, material, opts = {}) {
  const m = new THREE.Mesh(geometry, material);
  m.castShadow = opts.castShadow !== false;
  m.receiveShadow = opts.receiveShadow !== false;
  if (opts.position) m.position.set(...opts.position);
  if (opts.rotation) m.rotation.set(...opts.rotation);
  return m;
}

export function roundedRectShape(w, d, r = 0.08, cx = 0, cz = 0) {
  const s = new THREE.Shape();
  const x = cx - w / 2;
  const z = cz - d / 2;
  const rr = Math.min(r, w / 2, d / 2);
  s.moveTo(x + rr, z);
  s.lineTo(x + w - rr, z);
  s.quadraticCurveTo(x + w, z, x + w, z + rr);
  s.lineTo(x + w, z + d - rr);
  s.quadraticCurveTo(x + w, z + d, x + w - rr, z + d);
  s.lineTo(x + rr, z + d);
  s.quadraticCurveTo(x, z + d, x, z + d - rr);
  s.lineTo(x, z + rr);
  s.quadraticCurveTo(x, z, x + rr, z);
  return s;
}

export function addCircleHole(shape, x, z, radius) {
  const path = new THREE.Path();
  path.absarc(x, z, radius, 0, Math.PI * 2, true);
  shape.holes.push(path);
  return shape;
}

// Build a shape in XZ, extrude upward along Y.
export function extrudeUp(shape, height, bottomY = 0, opts = {}) {
  const depth = Math.max(0.001, height - (opts.bevelThickness ?? 0.03) * 2);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: opts.bevel !== false,
    bevelSegments: opts.bevelSegments ?? 2,
    steps: 1,
    bevelSize: opts.bevelSize ?? 0.025,
    bevelThickness: opts.bevelThickness ?? 0.03,
    curveSegments: opts.curveSegments ?? 28,
  });
  geo.rotateX(-Math.PI / 2);
  if (bottomY !== 0) geo.translate(0, bottomY + (opts.bevelThickness ?? 0.03), 0);
  return geo;
}

// Build a 2D shape in XY then rotate it into the YZ plane with normal along X.
export function extrudePlaneX(shape, thickness, x = 0, opts = {}) {
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: opts.bevel !== false,
    bevelSegments: opts.bevelSegments ?? 1,
    steps: 1,
    bevelSize: opts.bevelSize ?? 0.012,
    bevelThickness: opts.bevelThickness ?? 0.012,
    curveSegments: opts.curveSegments ?? 24,
  });
  geo.rotateY(Math.PI / 2);
  geo.translate(x - thickness / 2, 0, 0);
  return geo;
}

export function tubeFromPoints(points, radius = 0.1, material, opts = {}) {
  const curve = new THREE.CatmullRomCurve3(points, false, opts.curveType || 'centripetal', opts.tension ?? 0.45);
  const geo = new THREE.TubeGeometry(curve, opts.segments ?? 56, radius, opts.radialSegments ?? 10, false);
  const m = new THREE.Mesh(geo, material);
  m.castShadow = opts.castShadow !== false;
  m.receiveShadow = true;
  m.userData.flowCurve = curve;
  return m;
}

export function curveFromPoints(points, opts = {}) {
  return new THREE.CatmullRomCurve3(points, false, opts.curveType || 'centripetal', opts.tension ?? 0.45);
}

export function boltGroup(radius = 0.075, height = 0.09, material, washerMat) {
  const g = new THREE.Group();
  const head = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius * 1.03, height, 6), material);
  head.castShadow = true;
  head.receiveShadow = true;
  g.add(head);
  if (washerMat) {
    const washer = new THREE.Mesh(new THREE.CylinderGeometry(radius * 1.38, radius * 1.38, height * 0.14, 24), washerMat);
    washer.position.y = -height * 0.54;
    washer.castShadow = true;
    washer.receiveShadow = true;
    g.add(washer);
  }
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.8, radius * 0.8, height * 1.15, 16), material);
  collar.position.y = -height * 0.4;
  g.add(collar);
  return g;
}

export function addBolt(parent, x, y, z, radius, height, material, washerMat, rotation = 0) {
  const b = boltGroup(radius, height, material, washerMat);
  b.position.set(x, y, z);
  b.rotation.y = rotation;
  parent.add(b);
  return b;
}

export function torus(radius, tube, radialSeg = 12, tubularSeg = 40) {
  return new THREE.TorusGeometry(radius, tube, radialSeg, tubularSeg);
}

export function makeGear(teeth = 32, pitchR = 0.55, thickness = 0.1, material, opts = {}) {
  const toothH = opts.toothHeight ?? pitchR * 0.11;
  const rootR = pitchR - toothH * 0.54;
  const outerR = pitchR + toothH * 0.46;
  const shape = new THREE.Shape();
  const N = teeth * 4;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    // 4 samples per tooth: root start, flank, tip, flank.
    const phase = i % 4;
    let r = rootR;
    if (phase === 1) r = pitchR - toothH * 0.05;
    if (phase === 2) r = outerR;
    if (phase === 3) r = pitchR + toothH * 0.15;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
  }
  shape.closePath();
  const hubR = opts.hubRadius ?? pitchR * 0.32;
  const hole = new THREE.Path();
  hole.absarc(0, 0, hubR, 0, Math.PI * 2, true);
  shape.holes.push(hole);
  if (opts.spokes) {
    const spokeCount = opts.spokes;
    for (let i = 0; i < spokeCount; i++) {
      const a = (i / spokeCount) * Math.PI * 2;
      const r = pitchR * 0.62;
      const p = new THREE.Path();
      p.absarc(Math.cos(a) * r, Math.sin(a) * r, pitchR * 0.17, 0, Math.PI * 2, true);
      shape.holes.push(p);
    }
  }
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: true,
    bevelSegments: 1,
    steps: 1,
    bevelSize: 0.008,
    bevelThickness: 0.008,
    curveSegments: 20,
  });
  geo.translate(0, 0, -thickness / 2);
  const m = new THREE.Mesh(geo, material);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

export function makeSpring(radius = 0.16, height = 0.45, coils = 6, wire = 0.026, material) {
  const group = new THREE.Group();
  const rings = [];
  const spacing = height / coils;
  for (let i = 0; i < coils; i++) {
    const t = new THREE.Mesh(new THREE.TorusGeometry(radius, wire, 7, 20), material);
    t.rotation.x = Math.PI / 2;
    t.position.y = -height / 2 + i * spacing;
    t.castShadow = true;
    t.receiveShadow = true;
    group.add(t);
    rings.push(t);
  }
  group.userData.rings = rings;
  group.userData.baseSpacing = spacing;
  group.userData.springHeight = height;
  return group;
}

// A radial volute shell, used for turbo housings. Profile is a torus sector with
// a sculpted outlet neck, sufficient for a cutaway visual at this scale.
export function voluteGroup(material, opts = {}) {
  const g = new THREE.Group();
  const R = opts.radius ?? 0.45;
  const tube = opts.tube ?? 0.22;
  const arc = opts.arc ?? Math.PI * 1.72;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(R, tube, 18, 60, arc), material);
  ring.rotation.y = Math.PI / 2;
  ring.rotation.z = opts.rotation ?? 0.65;
  ring.castShadow = true;
  ring.receiveShadow = true;
  g.add(ring);
  // Scroll center / bearing boss.
  const boss = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.62, R * 0.66, tube * 1.75, 28), material);
  boss.rotation.z = Math.PI / 2;
  boss.castShadow = true;
  boss.receiveShadow = true;
  g.add(boss);
  return g;
}

export function canvasTexture(width, height, draw, opts = {}) {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d');
  draw(ctx, width, height);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = opts.colorSpace ?? THREE.SRGBColorSpace;
  t.anisotropy = opts.anisotropy ?? 4;
  t.needsUpdate = true;
  return t;
}

export function disposeGroup(group) {
  group.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) m.dispose();
    }
  });
}

export function bezierPipe(points, radius, material, opts = {}) {
  const curve = new THREE.CatmullRomCurve3(points, opts.closed || false, 'centripetal', opts.tension ?? 0.4);
  const geometry = new THREE.TubeGeometry(curve, opts.segments ?? 48, radius, opts.radialSegments ?? 10, opts.closed || false);
  const m = new THREE.Mesh(geometry, material);
  m.castShadow = true;
  m.receiveShadow = true;
  return { mesh: m, curve };
}

export function makeRibbedPlate(w, h, d, ribCount, ribDepth, material, opts = {}) {
  const group = new THREE.Group();
  const base = new THREE.Mesh(roundedBox(w, h, d, Math.min(h, w) * 0.08), material);
  group.add(base);
  for (let i = 0; i < ribCount; i++) {
    const rib = new THREE.Mesh(box(w * 0.94, h * 0.86, ribDepth), material);
    rib.position.z = (i - (ribCount - 1) / 2) * (d / ribCount) * 0.8;
    rib.scale.x = 0.94;
    group.add(rib);
  }
  return group;
}

export function setShadowRecursive(obj, cast = true, receive = true) {
  obj.traverse(o => {
    if (o.isMesh) {
      o.castShadow = cast;
      o.receiveShadow = receive;
    }
  });
}
