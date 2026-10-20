import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  roundedBox, box, cylinder, mesh, alongX, extrudeUp, roundedRectShape, addCircleHole,
  extrudePlaneX, tubeFromPoints, curveFromPoints, makeGear, makeSpring, boltGroup,
  addBolt, canvasTexture, voluteGroup,
} from './geometry.js';
import { ENGINE, RAD, clamp, mod } from './simulation.js';

const CYL_X = ENGINE.cylinders.map(c => c.x);
const DECK_Y = 3.42;
const HEAD_TOP = 4.34;
const VALVE_SEAT = 3.48;
const CAM_Y = 1.9;
const CAM_Z = 0.76;
const ROCKER_Y = 4.93;
const ROCKER_Z = 0.27;
const MAIN_X = [2.68, 1.34, 0, -1.34, -2.68];

const V = (x, y, z) => new THREE.Vector3(x, y, z);

function addTextPlane(text, sub, width, height) {
  const tex = canvasTexture(1024, 256, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(216,225,224,0.96)';
    ctx.font = '700 96px Bahnschrift, Arial Narrow, sans-serif';
    ctx.letterSpacing = '18px';
    ctx.fillText(text, 36, 130);
    ctx.fillStyle = 'rgba(109,206,215,0.9)';
    ctx.font = '500 32px Bahnschrift, Arial, sans-serif';
    ctx.letterSpacing = '9px';
    ctx.fillText(sub, 40, 196);
    ctx.strokeStyle = 'rgba(109,206,215,0.5)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(40, 216);
    ctx.lineTo(w - 40, 216);
    ctx.stroke();
  });
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

export class DieselEngine {
  constructor(materials) {
    this.M = materials;
    this.root = new THREE.Group();
    this.root.name = '4C-105 Diesel Engine';
    this.raycastMeshes = [];
    this.shellMeshes = [];
    this.shellEdges = [];
    this._registered = new Set();
    this.dynamic = {};
    this.parts = {};
    this.flowAnchors = {};
    this.build();
  }

  register(meshObj, partId, opts = {}) {
    if (!meshObj) return meshObj;
    meshObj.userData.partId = partId;
    if (opts.cylinder != null) meshObj.userData.cylinderIndex = opts.cylinder;
    if (opts.shell && !meshObj.userData.shell) {
      meshObj.userData.shell = true;
      this.shellMeshes.push(meshObj);
      const e = new THREE.LineSegments(
        new THREE.EdgesGeometry(meshObj.geometry, 38),
        new THREE.LineBasicMaterial({ color: 0x83d5dd, transparent: true, opacity: 0.28, depthWrite: false })
      );
      e.visible = false;
      e.renderOrder = 9;
      meshObj.add(e);
      this.shellEdges.push(e);
    }
    if (!this._registered.has(meshObj)) {
      this._registered.add(meshObj);
      this.raycastMeshes.push(meshObj);
    }
    return meshObj;
  }

  addMesh(parent, geo, mat, partId, opts = {}) {
    const m = mesh(geo, mat, opts);
    parent.add(m);
    this.register(m, partId, opts);
    return m;
  }

  addBolt(parent, x, y, z, r, h, partId, opts = {}) {
    const b = boltGroup(r, h, this.M.polishedSteel, this.M.steelDark);
    b.position.set(x, y, z);
    if (opts.rotation) b.rotation.set(...opts.rotation);
    parent.add(b);
    b.traverse(o => { if (o.isMesh) this.register(o, partId); });
    return b;
  }

  build() {
    this.buildLongBlock();
    this.buildCrankTrain();
    this.buildValvetrain();
    this.buildTimingAndFront();
    this.buildHeadDetails();
    this.buildFuelSystem();
    this.buildLubrication();
    this.buildCooling();
    this.buildAirSystem();
    this.buildAccessories();
    this.buildSurfaceDetails();
    this.buildStand();
    this.buildEnginePlate();
    this.buildCombustionEffects();
    this.buildFluidCurves();
    this.buildExplosionModules();
    this.optimizeRigidBatches();
  }

  // The upper valvetrain assembly and the air-path modules are promoted to
  // top-level rigid groups so the exploded view can pull them away as coherent
  // service assemblies without losing any animation links.
  buildExplosionModules() {
    const upper = new THREE.Group();
    upper.name = 'Upper valvetrain assembly';
    this.root.add(upper);
    upper.add(this.parts.head);
    for (const v of this.valves) upper.add(v.group);
    for (const s of this.springs) upper.add(s.group);
    for (const r of this.rockers) upper.add(r.group);
    for (const p of this.pushrods) upper.add(p.group);
    for (const inj of this.injectors || []) upper.add(inj);
    this.parts.upperAssembly = upper;
    if (this.parts.cover) this.parts.cover.userData.rigidBatchRoot = true;
    if (this.parts.pan) this.parts.pan.userData.rigidBatchRoot = true;

    const intakeModule = new THREE.Group();
    intakeModule.name = 'Intake path module';
    this.root.add(intakeModule);
    if (this.parts.airIntake) intakeModule.add(this.parts.airIntake);
    if (this.parts.airbox) intakeModule.add(this.parts.airbox);
    if (this.parts.coldPipe) intakeModule.add(this.parts.coldPipe);
    this.parts.airIntakeModule = intakeModule;

    const exhaustModule = new THREE.Group();
    exhaustModule.name = 'Exhaust and turbo module';
    this.root.add(exhaustModule);
    if (this.parts.airExhaust) exhaustModule.add(this.parts.airExhaust);
    if (this.parts.turbo) exhaustModule.add(this.parts.turbo);
    this.parts.airExhaustModule = exhaustModule;

    const intercoolerModule = new THREE.Group();
    intercoolerModule.name = 'Intercooler module';
    this.root.add(intercoolerModule);
    if (this.parts.airIntercooler) intercoolerModule.add(this.parts.airIntercooler);
    if (this.parts.boostAssembly) intercoolerModule.add(this.parts.boostAssembly);
    this.parts.airIntercoolerModule = intercoolerModule;
  }

  // Draw-call consolidation. Meshes that move together (and share a material,
  // part id and cylinder context) are merged into a single geometry. This keeps
  // every pickable part and every animated assembly intact while cutting the
  // submitted draw calls roughly in half.
  optimizeRigidBatches() {
    this.root.updateMatrixWorld(true);
    const before = this.raycastMeshes.length;
    const animatedRoots = new Set();
    const animatedMeshes = new Set();
    const addAnimated = (o) => { if (o && o.isObject3D) animatedRoots.add(o); };
    const addAnimatedMesh = (o) => { if (o && o.isObject3D) animatedMeshes.add(o); };
    [
      this.dynamic.crankGroup, this.dynamic.flywheel, this.dynamic.cam,
      this.dynamic.damper, this.dynamic.waterPulley, this.dynamic.altPulley,
      this.dynamic.tensioner, this.dynamic.fuelPumpPulley, this.dynamic.fan,
      this.dynamic.compWheel, this.dynamic.turbWheel,
      ...this.pistonGroups, ...this.rodGroups,
      ...this.valves.map(v => v.group), ...this.rockers.map(v => v.group),
      ...this.lifters.map(v => v.group), ...this.pushrods.map(v => v.group),
    ].forEach(addAnimated);
    [
      this.dynamic.crankGear, this.dynamic.camGear, this.dynamic.pumpGear,
      this.dynamic.oilPumpRotor,
    ].forEach(addAnimatedMesh);

    // Valve springs and pushrods have children whose transforms are updated
    // independently every frame, so their internal structure is preserved.
    const noBatchRoots = new Set([
      ...this.pushrods.map(p => p.group),
      ...this.springs.map(s => s.group),
    ]);

    const sources = [];
    const skipIds = new Set(['valveSpring']);
    this.root.traverse(o => {
      if (!o.isMesh || !o.userData.partId) return;
      if (o.userData.shell || skipIds.has(o.userData.partId)) return;
      if (!o.material || o.material.transparent || o.material.isMeshBasicMaterial) return;
      // Meshes with important child nodes (edges, articulated parts) stay intact.
      if (o.children.length) return;
      if (animatedMeshes.has(o)) return;
      let target = null;
      let cur = o.parent;
      let blocked = false;
      while (cur && cur !== this.root) {
        if (noBatchRoots.has(cur)) { blocked = true; break; }
        if (animatedRoots.has(cur)) { target = cur; break; }
        if (cur.userData.rigidBatchRoot) { target = cur; break; }
        cur = cur.parent;
      }
      if (blocked) return;
      if (!target) {
        cur = o;
        while (cur && cur.parent && cur.parent !== this.root) cur = cur.parent;
        target = cur && cur.parent === this.root ? cur : this.root;
      }
      sources.push({
        mesh: o,
        target,
        partId: o.userData.partId,
        cylinderIndex: o.userData.cylinderIndex ?? null,
        material: o.material,
      });
    });

    const buckets = new Map();
    for (const src of sources) {
      const key = `${src.target.uuid}|${src.partId}|${src.cylinderIndex}|${src.material.uuid}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(src);
    }

    const removed = new Set();
    const added = [];
    const invTarget = new THREE.Matrix4();
    const relMatrix = new THREE.Matrix4();
    for (const bucket of buckets.values()) {
      if (bucket.length < 2) continue;
      const target = bucket[0].target;
      invTarget.copy(target.matrixWorld).invert();
      const geos = [];
      for (const src of bucket) {
        let g = src.mesh.geometry.clone();
        if (g.index) g = g.toNonIndexed();
        if (!g.getAttribute('position')) continue;
        if (!g.getAttribute('normal')) g.computeVertexNormals();
        if (!g.getAttribute('uv')) {
          const uv = new Float32Array(g.getAttribute('position').count * 2);
          g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
        }
        const cleaned = new THREE.BufferGeometry();
        cleaned.setAttribute('position', g.getAttribute('position'));
        cleaned.setAttribute('normal', g.getAttribute('normal'));
        cleaned.setAttribute('uv', g.getAttribute('uv'));
        relMatrix.multiplyMatrices(invTarget, src.mesh.matrixWorld);
        cleaned.applyMatrix4(relMatrix);
        cleaned.computeBoundingSphere();
        cleaned.computeBoundingBox();
        geos.push(cleaned);
      }
      if (geos.length < 2) continue;
      const merged = mergeGeometries(geos, false);
      if (!merged) continue;
      merged.computeBoundingBox();
      merged.computeBoundingSphere();
      const m = new THREE.Mesh(merged, bucket[0].material);
      m.castShadow = true;
      m.receiveShadow = true;
      m.userData.partId = bucket[0].partId;
      if (bucket[0].cylinderIndex != null) m.userData.cylinderIndex = bucket[0].cylinderIndex;
      target.add(m);
      added.push(m);
      for (const src of bucket) {
        if (src.mesh.parent) src.mesh.parent.remove(src.mesh);
        removed.add(src.mesh);
      }
    }
    if (removed.size) {
      this.raycastMeshes = this.raycastMeshes.filter(m => !removed.has(m));
      this.raycastMeshes.push(...added);
    }
    this.batchStats = {
      before,
      after: this.raycastMeshes.length,
      mergedBatches: added.length,
      collapsedMeshes: removed.size,
    };
  }

  buildCombustionEffects() {
    const glowTex = canvasTexture(256, 256, (ctx, w, h) => {
      const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      g.addColorStop(0, 'rgba(255,235,180,1)');
      g.addColorStop(0.18, 'rgba(255,166,62,0.96)');
      g.addColorStop(0.48, 'rgba(245,83,28,0.42)');
      g.addColorStop(1, 'rgba(120,24,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    });
    this.combustion = [];
    for (let i = 0; i < 4; i++) {
      const g = new THREE.Group();
      g.position.set(CYL_X[i], 3.3, 0);
      const flameCore = new THREE.Mesh(new THREE.SphereGeometry(0.21, 18, 12), this.M.flame.clone());
      flameCore.material.opacity = 0;
      g.add(flameCore);
      const flameOuter = new THREE.Mesh(new THREE.SphereGeometry(0.34, 18, 12), this.M.ember.clone());
      flameOuter.material.opacity = 0;
      flameOuter.scale.set(1.15, 0.55, 1.15);
      g.add(flameOuter);
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTex, color: 0xffb05a, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true,
      }));
      sprite.scale.set(1.15, 1.15, 1);
      g.add(sprite);
      const light = new THREE.PointLight(0xff7733, 0, 2.2, 2.0);
      light.position.set(0, 0.08, 0);
      g.add(light);
      // Injection spray cone under the nozzle.
      const spray = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.34, 14, 1, true), this.M.ember.clone());
      spray.material.opacity = 0;
      spray.rotation.x = Math.PI;
      spray.position.y = 0.62;
      g.add(spray);
      g.visible = false;
      this.root.add(g);
      this.combustion.push({ group: g, core: flameCore, outer: flameOuter, sprite, light, spray });
    }
  }

  setGearSpin(obj, angle) {
    if (!obj) return;
    if (!obj.userData.baseQuat) {
      obj.userData.baseQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2, 0));
    }
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), angle);
    obj.quaternion.copy(q).multiply(obj.userData.baseQuat);
  }

  update(sim, dt = 0.016) {
    const angle = RAD(sim.crankAngle);
    const crankAngleDeg = sim.crankAngle;
    this.dynamic.crankGroup.rotation.x = angle;
    this.dynamic.flywheel.rotation.x = angle;
    this.dynamic.damper.rotation.x = angle;
    this.dynamic.cam.rotation.x = angle * 0.5;
    this.dynamic.fan.rotation.x += dt * (1.0 + sim.waterFan * 10.0);
    this.dynamic.waterPulley.rotation.x = -angle * 1.25;
    this.dynamic.altPulley.rotation.x = -angle * 2.4;
    this.dynamic.tensioner.rotation.x = -angle * 1.8;
    this.dynamic.fuelPumpPulley.rotation.x = -angle;
    this.dynamic.oilPumpRotor.rotation.z = angle * 1.4;
    const turboSpin = dt * (0.4 + sim.turboRpm / 18000);
    this.dynamic.compWheel.rotation.x += turboSpin;
    this.dynamic.turbWheel.rotation.x += turboSpin * 1.12;
    this.dynamic.crankGear && this.setGearSpin(this.dynamic.crankGear, angle);
    this.dynamic.camGear && this.setGearSpin(this.dynamic.camGear, -angle * 0.5);
    this.dynamic.pumpGear && this.setGearSpin(this.dynamic.pumpGear, -angle * 0.8);

    // Slider-crank solution for each cylinder.
    const { crankRadius: r, rodLength: l } = ENGINE;
    for (let i = 0; i < 4; i++) {
      const theta = angle + ENGINE.cylinders[i].throw;
      const pinY = r * Math.cos(theta) + Math.sqrt(l * l - (r * Math.sin(theta)) ** 2);
      const crankPin = V(CYL_X[i], r * Math.cos(theta), r * Math.sin(theta));
      const wrist = V(CYL_X[i], pinY, 0);
      this.pistonGroups[i].position.set(CYL_X[i], pinY, 0);
      const rod = this.rodGroups[i];
      rod.position.copy(crankPin);
      const dir = wrist.clone().sub(crankPin).normalize();
      rod.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    }

    // Valve lift and rocker kinematics.
    for (let i = 0; i < 4; i++) {
      const data = sim.cylinderData(i);
      for (let k = 0; k < 2; k++) {
        const kind = k === 0 ? 'intake' : 'exhaust';
        const lift = kind === 'intake' ? data.intakeLift : data.exhaustLift;
        const valveIdx = i * 2 + k;
        const v = this.valves[valveIdx];
        v.group.position.y = VALVE_SEAT - lift;
        const sp = this.springs[valveIdx];
        const coils = sp.group.userData.rings;
        const base = 4.12;
        const compressed = Math.max(0.3, 0.59 - lift * 1.4);
        for (let j = 0; j < coils.length; j++) {
          coils[j].position.y = (base + (j / (coils.length - 1)) * compressed) - sp.group.position.y;
        }
        const alpha = Math.asin(clamp(lift / 0.235, 0, 0.92));
        const pushLift = 0.30 * Math.sin(alpha);
        const rocker = this.rockers[valveIdx];
        rocker.group.rotation.x = -alpha;
        const lifter = this.lifters[valveIdx];
        lifter.group.position.y = 2.17 + pushLift;
        const lower = V(lifter.group.position.x, 2.38 + pushLift, CAM_Z);
        const upper = new THREE.Vector3(0, 0.06, 0.30)
          .applyEuler(new THREE.Euler(-alpha, 0, 0))
          .add(new THREE.Vector3(lifter.group.position.x, ROCKER_Y, ROCKER_Z));
        const push = this.pushrods[valveIdx];
        const delta = upper.clone().sub(lower);
        const len = delta.length();
        push.group.position.copy(lower);
        push.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
        const shaft = push.group.userData.shaft;
        shaft.scale.y = len;
        shaft.position.y = len / 2;
        if (push.group.userData.ballTop) push.group.userData.ballTop.position.y = len;
      }
    }

    // Combustion flash and injection spray.
    for (let i = 0; i < 4; i++) {
      const c = sim.combustion[i];
      const fx = this.combustion[i];
      const show = c > 0.03 || sim.injecting[i];
      fx.group.visible = show;
      if (show) {
        const f = Math.max(c, 0.06);
        fx.core.material.opacity = f * 0.9;
        fx.outer.material.opacity = f * 0.52;
        fx.sprite.material.opacity = f * 0.95;
        fx.light.intensity = f * 3.2;
        const pulse = 0.8 + c * 0.6;
        fx.core.scale.setScalar(pulse);
        fx.outer.scale.set(1.1 * pulse, 0.48 * pulse, 1.1 * pulse);
        fx.spray.material.opacity = sim.injecting[i] ? 0.7 : 0;
        fx.spray.visible = !!sim.injecting[i];
      } else {
        fx.light.intensity = 0;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Long block
  // ---------------------------------------------------------------------------
  buildLongBlock() {
    const M = this.M;
    const block = new THREE.Group();
    block.name = 'Long block';
    this.root.add(block);
    this.parts.blockGroup = block;

    // Cylinder block upper casting: a box-section jacket surrounding four bores.
    const upperShape = roundedRectShape(5.88, 2.3, 0.2);
    for (const x of CYL_X) addCircleHole(upperShape, x, 0, 0.565);
    // Stop the main jacket below the separate deck flange. The former 2.48
    // extrusion ended exactly on DECK_Y, putting two large coplanar faces around
    // the bores and causing severe z-fighting at close range.
    const upper = new THREE.Mesh(extrudeUp(upperShape, 2.42, 0.94, {
      bevelSize: 0.045, bevelThickness: 0.045, bevelSegments: 2,
    }), M.blockPaint);
    upper.castShadow = upper.receiveShadow = true;
    block.add(upper);
    this.register(upper, 'block', { shell: true });

    // Crankcase / main bearing gallery.
    const lowerShape = roundedRectShape(5.72, 2.16, 0.17);
    const lower = new THREE.Mesh(extrudeUp(lowerShape, 1.06, -0.72, {
      bevelSize: 0.04, bevelThickness: 0.04,
    }), M.castIron);
    lower.castShadow = lower.receiveShadow = true;
    block.add(lower);
    this.register(lower, 'block', { shell: true });

    // Deck flange and fine-machined top face.
    const deckShape = roundedRectShape(5.95, 2.34, 0.14);
    for (const x of CYL_X) addCircleHole(deckShape, x, 0, 0.553);
    const deck = new THREE.Mesh(extrudeUp(deckShape, 0.12, 3.3, { bevelSize: 0.012, bevelThickness: 0.012 }), M.aluMachined);
    deck.castShadow = deck.receiveShadow = true;
    block.add(deck);
    this.register(deck, 'block', { shell: true });

    // Cylinder liners and the translucent water jacket volumes.
    const linerGroup = new THREE.Group();
    const linerGeo = new THREE.CylinderGeometry(0.525, 0.525, 2.34, 48, 1, true);
    const linerLip = new THREE.TorusGeometry(0.527, 0.018, 8, 48);
    for (let i = 0; i < 4; i++) {
      const lg = new THREE.Group();
      lg.position.set(CYL_X[i], 1.06, 0);
      const liner = new THREE.Mesh(linerGeo, M.polishedSteel);
      liner.position.y = 1.17;
      liner.castShadow = true;
      liner.receiveShadow = true;
      lg.add(liner);
      const lip = new THREE.Mesh(linerLip, M.steelDark);
      lip.rotation.x = Math.PI / 2;
      lip.position.y = 2.33;
      lg.add(lip);
      // Honing lines: three subtle bands at the top of the bore.
      for (let b = 0; b < 3; b++) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.518, 0.006, 5, 38), M.steelDark);
        ring.rotation.x = Math.PI / 2;
        ring.position.y = 2.15 - b * 0.11;
        lg.add(ring);
      }
      for (const c of lg.children) this.register(c, 'block');
      linerGroup.add(lg);

      // Water jacket sleeve — intentionally visible in X-ray.
      const jacket = new THREE.Mesh(
        new THREE.CylinderGeometry(0.575, 0.575, 2.05, 32, 1, true),
        M.coolantJacket
      );
      jacket.position.set(CYL_X[i], 2.14, 0);
      jacket.renderOrder = 3;
      this.register(jacket, 'waterJacket');
      block.add(jacket);

      // Deck coolant transfer orifices.
      for (const s of [-1, 1]) {
        const port = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.03, 16), M.gasketRubber);
        port.position.set(CYL_X[i] + s * 0.38, 3.425, s * 0.30);
        block.add(port);
      }
    }
    block.add(linerGroup);

    // Outside ribs and freeze plugs give the casting a full-size, foundry-made feel.
    for (const side of [-1, 1]) {
      for (let i = 0; i < 5; i++) {
        const rib = new THREE.Mesh(roundedBox(0.085, 1.86, 0.09, 0.025), M.blockPaint);
        rib.position.set(-2.68 + i * 1.34, 2.04, side * 1.155);
        rib.castShadow = rib.receiveShadow = true;
        block.add(rib);
        this.register(rib, 'block', { shell: true });
      }
      for (const x of CYL_X) {
        const plug = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.18, 0.055, 24), M.brass);
        plug.rotation.x = Math.PI / 2;
        plug.position.set(x, 1.44, side * 1.18);
        block.add(plug);
        this.register(plug, 'block');
      }
      // Reinforcing rail along the sump face.
      const rail = new THREE.Mesh(roundedBox(5.5, 0.13, 0.15, 0.035), M.castIron);
      rail.position.set(0, -0.69, side * 1.09);
      block.add(rail);
      this.register(rail, 'block', { shell: true });
    }

    // Crankcase windows and lower casting ribs.
    for (const side of [-1, 1]) {
      for (const x of [-2.55, -1.21, 0.13, 1.47, 2.72]) {
        const r = new THREE.Mesh(roundedBox(0.1, 0.7, 0.09, 0.025), M.castIron);
        r.position.set(x, -0.15, side * 1.075);
        r.rotation.x = side * 0.06;
        block.add(r);
        this.register(r, 'block', { shell: true });
      }
    }

    // Engine mount arms.
    for (const side of [-1, 1]) {
      const mount = new THREE.Group();
      const arm = new THREE.Mesh(roundedBox(0.95, 0.2, 0.5, 0.06), M.castIronDark);
      arm.position.set(1.55, 0.36, side * 1.32);
      mount.add(arm);
      const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.2, 0.15, 20), M.rubber);
      pad.rotation.x = Math.PI / 2;
      pad.position.set(1.55, 0.25, side * 1.58);
      mount.add(pad);
      mount.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; this.register(o, 'block'); } });
      block.add(mount);
    }

    // Main bearing bulkheads (five) and caps around the crank.
    for (const x of MAIN_X) {
      for (const side of [-1, 1]) {
        const wall = new THREE.Mesh(roundedBox(0.18, 1.3, 0.28, 0.045), M.castIronDark);
        wall.position.set(x, 0.04, side * 0.82);
        block.add(wall);
        this.register(wall, 'block');
      }
      const cap = new THREE.Group();
      const capBody = new THREE.Mesh(roundedBox(0.34, 0.38, 1.0, 0.08), M.castIronDark);
      capBody.position.set(x, -0.36, 0);
      cap.add(capBody);
      const half = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.34, 24, 1, false, 0, Math.PI), M.bearing);
      half.rotation.z = Math.PI / 2 + Math.PI;
      half.position.set(x, -0.03, 0);
      cap.add(half);
      for (const z of [-0.39, 0.39]) {
        this.addBolt(cap, x, -0.55, z, 0.058, 0.15, 'mainBearing');
      }
      cap.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; this.register(o, 'mainBearing'); } });
      block.add(cap);
    }

    // Crankcase breather canister and front/rear covers.
    const breather = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.52, 20), M.plastic);
    breather.rotation.z = Math.PI / 2;
    breather.position.set(-2.82, 1.5, 0.8);
    block.add(breather);
    this.register(breather, 'block');
    const frontPlate = new THREE.Mesh(roundedBox(0.08, 2.32, 2.17, 0.06), M.castIron);
    frontPlate.position.set(2.94, 1.88, 0);
    block.add(frontPlate);
    this.register(frontPlate, 'block', { shell: true });

    // Oil pan: shallow sump + deep well, stiffening ribs and drain plug.
    const pan = new THREE.Group();
    const panTop = new THREE.Mesh(roundedBox(5.35, 0.76, 1.9, 0.17), M.paintedSteel);
    panTop.position.set(0, -1.19, 0);
    pan.add(panTop);
    const deep = new THREE.Mesh(roundedBox(2.25, 0.35, 1.52, 0.16), M.paintedSteel);
    deep.position.set(0.2, -1.67, 0);
    pan.add(deep);
    for (const z of [-0.7, -0.35, 0, 0.35, 0.7]) {
      const rib = new THREE.Mesh(roundedBox(4.9, 0.05, 0.055, 0.02), M.paintedSteel);
      rib.position.set(0, -0.8, z);
      pan.add(rib);
    }
    const flange = new THREE.Mesh(roundedBox(5.5, 0.08, 2.04, 0.04), M.paintedSteel);
    flange.position.set(0, -0.78, 0);
    pan.add(flange);
    const plug = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.1, 0.1, 6), M.blackOxide);
    plug.rotation.x = Math.PI / 2;
    plug.position.set(1.0, -1.86, 0.35);
    pan.add(plug);
    for (let i = 0; i < 12; i++) {
      this.addBolt(pan, -2.45 + i * 0.445, -0.79, 1.01, 0.043, 0.09, 'pan');
    }
    for (const o of pan.children) if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
    pan.traverse(o => { if (o.isMesh) this.register(o, 'pan'); });
    this.parts.pan = pan;
    // Pan is a cutaway shell only for its major volume.
    panTop.userData.shell = true;
    deep.userData.shell = true;
    this.shellMeshes.push(panTop, deep);
    for (const pm of [panTop, deep]) {
      const e = new THREE.LineSegments(
        new THREE.EdgesGeometry(pm.geometry, 40),
        new THREE.LineBasicMaterial({ color: 0x83d5dd, transparent: true, opacity: 0.22, depthWrite: false })
      );
      e.visible = false;
      pm.add(e);
      this.shellEdges.push(e);
    }
    block.add(pan);

    // Dipstick tube with a high-visibility loop handle.
    const dip = new THREE.Group();
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 2.1, 12), M.steelDark);
    tube.position.set(-0.5, -0.35, 1.14);
    tube.rotation.z = -0.08;
    dip.add(tube);
    const handle = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.026, 8, 22, Math.PI * 1.7), M.amberGlow);
    handle.position.set(-0.4, 0.71, 1.14);
    handle.rotation.y = 0.2;
    dip.add(handle);
    dip.traverse(o => { if (o.isMesh) this.register(o, 'dipstick'); });
    block.add(dip);

    // Oil pan gasket.
    const panGasket = new THREE.Mesh(roundedBox(5.45, 0.025, 1.99, 0.02), M.gasketRubber);
    panGasket.position.set(0, -0.76, 0);
    block.add(panGasket);
    this.register(panGasket, 'gasket');

    this.parts.block = block;

    // Cylinder head + head gasket.
    const head = new THREE.Group();
    this.parts.head = head;
    const gasket = new THREE.Mesh(roundedBox(5.78, 0.045, 2.26, 0.04), M.gasketMetal);
    gasket.position.set(0, DECK_Y + 0.022, 0);
    head.add(gasket);
    this.register(gasket, 'gasket');

    const headCast = new THREE.Mesh(roundedBox(5.76, 0.9, 2.25, 0.075, 3), M.aluHead);
    headCast.position.set(0, DECK_Y + 0.48, 0);
    headCast.castShadow = headCast.receiveShadow = true;
    head.add(headCast);
    this.register(headCast, 'head', { shell: true });
    // Head top deck plate with a slight machined step.
    const headTop = new THREE.Mesh(roundedBox(5.64, 0.1, 2.14, 0.07), M.aluMachined);
    headTop.position.set(0, HEAD_TOP - 0.013, 0);
    head.add(headTop);
    this.register(headTop, 'head', { shell: true });

    // Longitudinal reinforcing ribs on the head sides.
    for (const side of [-1, 1]) {
      const sidePlate = new THREE.Mesh(roundedBox(5.25, 0.56, 0.09, 0.05), M.aluHead);
      sidePlate.position.set(0, DECK_Y + 0.46, side * 1.14);
      head.add(sidePlate);
      this.register(sidePlate, 'head', { shell: true });
      for (const x of [-2.1, -0.7, 0.7, 2.1]) {
        const boss = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.2, 0.13, 20), M.aluCast);
        boss.rotation.x = Math.PI / 2;
        boss.position.set(x, DECK_Y + 0.62, side * 1.2);
        head.add(boss);
        this.register(boss, 'head');
      }
    }

    // Head bolts (ten, M12) with washers.
    for (const x of [-2.48, -1.16, 1.16, 2.48]) {
      for (const z of [-0.94, 0.94]) {
        this.addBolt(head, x, HEAD_TOP + 0.055, z, 0.085, 0.15, 'headBolt');
      }
    }
    for (const z of [-0.85, 0.85]) {
      this.addBolt(head, 0, HEAD_TOP + 0.055, z, 0.085, 0.15, 'headBolt');
    }

    // Inlet and exhaust port flanges on both sides of the head.
    for (let i = 0; i < 4; i++) {
      for (const side of [-1, 1]) {
        const flange = new THREE.Mesh(roundedBox(0.62, 0.54, 0.13, 0.06), side > 0 ? M.exhaustCast : M.intakeCast);
        flange.position.set(CYL_X[i], 3.6, side * 1.18);
        head.add(flange);
        this.register(flange, side > 0 ? 'exhaustManifold' : 'intakeManifold');
      }
    }

    // Cam / rocker cover.
    const cover = new THREE.Group();
    const coverBase = new THREE.Mesh(roundedBox(5.27, 0.55, 1.95, 0.12, 3), M.coverPaint);
    coverBase.position.set(0, 4.60, 0);
    coverBase.castShadow = coverBase.receiveShadow = true;
    cover.add(coverBase);
    this.register(coverBase, 'head', { shell: true });
    const coverTop = new THREE.Mesh(roundedBox(4.85, 0.16, 1.7, 0.08, 2), M.aluMachined);
    coverTop.position.set(0, 4.935, 0);
    cover.add(coverTop);
    this.register(coverTop, 'head', { shell: true });
    // Longitudinal machined ribs plus cast ribs: the cover carries most of the
    // upper silhouette, so this extra relief matters at a closer camera.
    for (const z of [-0.5, 0, 0.5]) {
      const rib = new THREE.Mesh(roundedBox(4.92, 0.045, 0.06, 0.02), M.aluMachined);
      rib.position.set(0, 5.03, z);
      cover.add(rib);
      this.register(rib, 'head', { shell: true });
    }
    for (let i = 0; i < 9; i++) {
      const rib = new THREE.Mesh(roundedBox(0.055, 0.035, 1.52, 0.018), M.aluDark);
      rib.position.set(-2.1 + i * 0.525, 5.012, 0);
      cover.add(rib);
      this.register(rib, 'head', { shell: true });
    }
    // Raised lettering on the cover side.
    const coverBadge = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.22), new THREE.MeshBasicMaterial({
      map: addTextPlane('4C-105', 'TURBO INTERCOOLED DIESEL', 512, 128), transparent: true, opacity: 0.78,
    }));
    coverBadge.position.set(0.22, 4.72, 0.978);
    cover.add(coverBadge);
    this.register(coverBadge, 'head');
    const oilCap = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.2, 0.11, 24), M.orangeFilter);
    oilCap.position.set(-1.85, 5.08, -0.35);
    cover.add(oilCap);
    this.register(oilCap, 'head');
    const oilCapTop = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.02, 24), M.orangeFilter);
    oilCapTop.position.set(-1.85, 5.145, -0.35);
    cover.add(oilCapTop);
    this.register(oilCapTop, 'head');
    const topPlaque = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.2), new THREE.MeshBasicMaterial({
      map: addTextPlane('4C-105', 'TURBO DIESEL  ·  COMMON RAIL', 1024, 256),
      transparent: true, opacity: 0.66, depthWrite: false,
    }));
    topPlaque.rotation.x = -Math.PI / 2;
    topPlaque.position.set(0.35, 5.047, -0.53);
    cover.add(topPlaque);
    this.register(topPlaque, 'head');
    // Injected fuel lines pass through neat rubber grommets in the cover.
    for (let i = 0; i < 4; i++) {
      const grommet = new THREE.Mesh(new THREE.CylinderGeometry(0.095, 0.095, 0.16, 18), M.rubber);
      grommet.position.set(CYL_X[i], 5.07, -0.02);
      cover.add(grommet);
      this.register(grommet, 'head');
    }
    // Cover bolts.
    for (const x of [-2.42, -1.2, 0, 1.2, 2.42]) {
      for (const z of [-0.78, 0.78]) this.addBolt(cover, x, 5.05, z, 0.055, 0.08, 'head');
    }
    head.add(cover);
    this.parts.cover = cover;
    rootHead: this.root.add(head);
  }

  // ---------------------------------------------------------------------------
  // Crankshaft, rods, pistons, flywheel
  // ---------------------------------------------------------------------------
  buildCrankTrain() {
    const M = this.M;
    const crankGroup = new THREE.Group();
    crankGroup.name = 'Crankshaft';
    this.root.add(crankGroup);
    this.dynamic.crankGroup = crankGroup;

    // Central shaft / nose / rear flange.
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 6.0, 24), M.forgedSteel);
    shaft.rotation.z = Math.PI / 2;
    shaft.castShadow = shaft.receiveShadow = true;
    crankGroup.add(shaft);
    this.register(shaft, 'crank');

    const nose = new THREE.Mesh(new THREE.CylinderGeometry(0.21, 0.21, 0.56, 24), M.forgedSteel);
    nose.rotation.z = Math.PI / 2;
    nose.position.x = 3.12;
    crankGroup.add(nose);
    this.register(nose, 'crank');

    // Front damper hub and key.
    const key = new THREE.Mesh(roundedBox(0.06, 0.035, 0.22, 0.01), M.steelDark);
    key.position.set(3.29, 0.23, 0);
    crankGroup.add(key);
    this.register(key, 'crank');

    const webShape = (() => {
      const s = new THREE.Shape();
      s.moveTo(-0.29, -0.95);
      s.bezierCurveTo(-0.5, -1.02, -0.8, -0.8, -0.8, -0.34);
      s.bezierCurveTo(-0.8, 0.04, -0.55, 0.18, -0.34, 0.14);
      s.lineTo(0.34, 0.14);
      s.bezierCurveTo(0.55, 0.18, 0.8, 0.04, 0.8, -0.34);
      s.bezierCurveTo(0.8, -0.8, 0.5, -1.02, 0.29, -0.95);
      s.lineTo(0.29, -0.6);
      s.lineTo(-0.29, -0.6);
      s.closePath();
      return s;
    })();
    const webGeo = extrudePlaneX(webShape, 0.16, 0, { bevelSize: 0.02, bevelThickness: 0.02 });
    const journalGeo = new THREE.CylinderGeometry(0.285, 0.285, 0.32, 34);
    journalGeo.rotateZ(Math.PI / 2);
    const pinGeo = new THREE.CylinderGeometry(0.26, 0.26, 0.4, 34);
    pinGeo.rotateZ(Math.PI / 2);
    const oilHoleGeo = new THREE.CylinderGeometry(0.036, 0.036, 0.27, 12);
    oilHoleGeo.rotateZ(Math.PI / 2);

    // Five main journals.
    for (const x of MAIN_X) {
      const j = new THREE.Mesh(journalGeo, M.polishedSteel);
      j.position.x = x;
      j.castShadow = j.receiveShadow = true;
      crankGroup.add(j);
      this.register(j, 'mainJournal');
      const groove = new THREE.Mesh(new THREE.TorusGeometry(0.286, 0.012, 6, 34), M.blackOxide);
      groove.rotation.y = Math.PI / 2;
      groove.position.x = x + 0.11;
      crankGroup.add(groove);
      this.register(groove, 'mainJournal');
    }

    this.rodJoints = [];
    for (let i = 0; i < 4; i++) {
      const x = CYL_X[i];
      const isUp = i === 0 || i === 3;
      const yPin = isUp ? ENGINE.crankRadius : -ENGINE.crankRadius;
      const pin = new THREE.Mesh(pinGeo, M.polishedSteel);
      pin.position.set(x, yPin, 0);
      pin.castShadow = pin.receiveShadow = true;
      crankGroup.add(pin);
      this.register(pin, 'rodJournal');
      // Drilled oil hole.
      const oilHole = new THREE.Mesh(oilHoleGeo, M.blackOxide);
      oilHole.position.set(x, yPin + 0.26, 0);
      crankGroup.add(oilHole);
      this.register(oilHole, 'rodJournal');

      for (const side of [-1, 1]) {
        const web = new THREE.Mesh(webGeo, M.forgedSteel);
        web.position.set(x + side * 0.29, yPin, 0);
        web.castShadow = web.receiveShadow = true;
        crankGroup.add(web);
        this.register(web, 'counterweight');
        // Lightening / balance drill holes.
        if (side === 1) {
          for (const z of [-0.23, 0.23]) {
            const hole = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.18, 14), M.blackOxide);
            hole.rotation.z = Math.PI / 2;
            hole.position.set(x + side * 0.29, yPin - 0.66, z);
            crankGroup.add(hole);
            this.register(hole, 'counterweight');
          }
        }
      }
      const joint = new THREE.Object3D();
      joint.position.set(x, yPin, 0);
      crankGroup.add(joint);
      this.rodJoints.push(joint);

      // Main webs adjacent to the pin.
      for (const dx of [-0.46, 0.46]) {
        const web = new THREE.Mesh(webGeo, M.forgedSteel);
        web.position.set(x + dx, 0, 0);
        web.scale.set(0.86, 0.82, 0.82);
        crankGroup.add(web);
        this.register(web, 'counterweight');
      }
    }

    this.parts.crank = crankGroup;

    // Pistons and connecting rods are independent of crankGroup because the rod
    // angle is solved from the crankpin and wrist-pin positions each frame.
    this.pistonGroups = [];
    this.rodGroups = [];
    this.pistonPins = [];
    const pistonGeo = new THREE.CylinderGeometry(0.516, 0.505, 0.48, 48, 1);
    const crownGeo = new THREE.CylinderGeometry(0.516, 0.516, 0.055, 48);
    const pinGeoP = new THREE.CylinderGeometry(0.17, 0.17, 0.92, 24);
    pinGeoP.rotateZ(Math.PI / 2);

    for (let i = 0; i < 4; i++) {
      const pg = new THREE.Group();
      pg.name = `Piston ${i + 1}`;
      const body = new THREE.Mesh(pistonGeo, M.pistonAlu);
      body.castShadow = body.receiveShadow = true;
      body.position.y = 0.0;
      pg.add(body);
      this.register(body, `piston-${i}`, { cylinder: i });

      const crown = new THREE.Mesh(crownGeo, M.pistonTop);
      crown.position.y = 0.26;
      pg.add(crown);
      this.register(crown, `piston-${i}`, { cylinder: i });

      // ω combustion bowl — concentric rings with a raised centre.
      const bowl = new THREE.Mesh(new THREE.TorusGeometry(0.20, 0.075, 10, 36), M.steelDark);
      bowl.rotation.x = Math.PI / 2;
      bowl.position.y = 0.245;
      bowl.scale.y = 0.28;
      pg.add(bowl);
      this.register(bowl, `piston-${i}`, { cylinder: i });
      const pip = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.06, 0.06, 18), M.pistonTop);
      pip.position.y = 0.258;
      pg.add(pip);
      this.register(pip, `piston-${i}`, { cylinder: i });

      // Ring grooves + rings.
      for (let r = 0; r < 3; r++) {
        const groove = new THREE.Mesh(new THREE.TorusGeometry(0.514, 0.012, 5, 44), M.blackOxide);
        groove.rotation.x = Math.PI / 2;
        groove.position.y = 0.14 - r * 0.075;
        pg.add(groove);
        this.register(groove, `rings-${i}`, { cylinder: i });
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.522, 0.017 + r * 0.003, 7, 48), M.ringSteel);
        ring.rotation.x = Math.PI / 2;
        ring.position.y = 0.14 - r * 0.075;
        pg.add(ring);
        this.register(ring, `rings-${i}`, { cylinder: i });
      }

      // Piston pin (axis parallel to crankshaft).
      const pin = new THREE.Mesh(pinGeoP, M.polishedSteel);
      pin.position.y = -0.02;
      pg.add(pin);
      this.register(pin, `pin-${i}`, { cylinder: i });

      // Skirt cut-outs / pin bosses.
      for (const side of [-1, 1]) {
        const boss = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.16, 20), M.pistonAlu);
        boss.rotation.z = Math.PI / 2;
        boss.position.set(side * 0.29, -0.02, 0);
        pg.add(boss);
        this.register(boss, `piston-${i}`, { cylinder: i });
      }
      pg.userData.cyl = i;
      this.root.add(pg);
      this.pistonGroups.push(pg);

      // Connecting rod, built along local +Y with its big end at the origin.
      const rod = new THREE.Group();
      rod.name = `Connecting rod ${i + 1}`;
      const shank = new THREE.Mesh(roundedBox(0.145, 1.56, 0.22, 0.055), M.rodSteel);
      shank.position.y = 1.04;
      rod.add(shank);
      const flange = new THREE.Mesh(roundedBox(0.22, 0.16, 0.31, 0.04), M.rodSteel);
      flange.position.y = 1.78;
      rod.add(flange);
      const bigEnd = new THREE.Mesh(new THREE.TorusGeometry(0.30, 0.105, 12, 36), M.rodSteel);
      bigEnd.rotation.y = Math.PI / 2;
      rod.add(bigEnd);
      const smallEnd = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.07, 10, 28), M.rodSteel);
      smallEnd.rotation.y = Math.PI / 2;
      smallEnd.position.y = ENGINE.rodLength;
      rod.add(smallEnd);
      // Big-end cap and its two bolts.
      const cap = new THREE.Mesh(new THREE.TorusGeometry(0.30, 0.09, 10, 36, Math.PI), M.steelDark);
      cap.rotation.y = Math.PI / 2;
      cap.rotation.x = Math.PI;
      cap.position.y = -0.015;
      rod.add(cap);
      const bearing = new THREE.Mesh(new THREE.CylinderGeometry(0.275, 0.275, 0.32, 32, 1, true), M.bearing);
      bearing.rotation.z = Math.PI / 2;
      rod.add(bearing);
      for (const sx of [-0.12, 0.12]) {
        const rodBolt = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.42, 6), M.blackOxide);
        rodBolt.position.set(sx, 0.06, -0.27);
        rod.add(rodBolt);
      }
      for (const c of rod.children) {
        c.castShadow = c.receiveShadow = true;
        this.register(c, c === bearing ? `rodBearing-${i}` : 'rod', { cylinder: i });
      }
      // The small end receives the wrist pin and is tagged accordingly.
      this.register(smallEnd, 'rod', { cylinder: i });
      this.root.add(rod);
      this.rodGroups.push(rod);
    }

    // Flywheel and flywheel housing.
    const flywheel = new THREE.Group();
    flywheel.name = 'Flywheel';
    flywheel.position.x = -3.18;
    this.root.add(flywheel);
    this.dynamic.flywheel = flywheel;

    const flyDisc = new THREE.Mesh(new THREE.CylinderGeometry(1.02, 1.02, 0.17, 64), M.forgedSteel);
    flyDisc.rotation.z = Math.PI / 2;
    flywheel.add(flyDisc);
    this.register(flyDisc, 'flywheel');

    const ringGear = makeGear(72, 1.06, 0.16, M.crankSteel, { toothHeight: 0.13, hubRadius: 0.93 });
    ringGear.rotation.y = Math.PI / 2;
    flywheel.add(ringGear);
    this.register(ringGear, 'flywheel');

    // Machined friction face and eight lightening holes.
    const face = new THREE.Mesh(new THREE.RingGeometry(0.27, 0.98, 64), M.aluMachined);
    face.rotation.y = Math.PI / 2;
    face.position.x = 0.09;
    flywheel.add(face);
    this.register(face, 'flywheel');
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const hole = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.22, 20), M.blackOxide);
      hole.rotation.z = Math.PI / 2;
      hole.position.set(0, Math.cos(a) * 0.66, Math.sin(a) * 0.66);
      flywheel.add(hole);
      this.register(hole, 'flywheel');
    }
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const bolt = boltGroup(0.06, 0.08, M.blackOxide, M.steelDark);
      bolt.rotation.z = Math.PI / 2;
      bolt.position.set(-0.12, Math.cos(a) * 0.22, Math.sin(a) * 0.22);
      flywheel.add(bolt);
      bolt.traverse(o => { if (o.isMesh) this.register(o, 'flywheel'); });
    }

    const bell = new THREE.Group();
    const bellShell = new THREE.Mesh(
      new THREE.CylinderGeometry(1.52, 1.58, 0.62, 58, 1, true, Math.PI * 0.24, Math.PI * 1.52),
      M.aluCast
    );
    bellShell.rotation.z = Math.PI / 2;
    bellShell.position.x = -3.25;
    bellShell.material = M.aluCast.clone();
    bellShell.material.side = THREE.DoubleSide;
    bell.add(bellShell);
    this.register(bellShell, 'flywheelHousing', { shell: true });
    for (let i = 0; i < 9; i++) {
      const a = Math.PI * 0.27 + (i / 8) * Math.PI * 1.46;
      const rib = new THREE.Mesh(new THREE.TorusGeometry(1.45, 0.035, 6, 30, 0.3), M.aluDark);
      rib.rotation.z = Math.PI / 2;
      rib.rotation.y = a;
      rib.position.x = -3.0;
      bell.add(rib);
    }
    const bellRim = new THREE.Mesh(new THREE.TorusGeometry(1.55, 0.055, 10, 64, Math.PI * 1.52), M.aluCast);
    bellRim.rotation.y = Math.PI / 2;
    bellRim.rotation.x = -Math.PI * 0.24;
    bellRim.position.x = -3.56;
    bell.add(bellRim);
    // A bolted rear closure plate keeps the flywheel inside the housing while
    // still allowing it to be inspected in X-ray or from the rear.
    const shieldShape = new THREE.Shape();
    shieldShape.absarc(0, 0, 1.51, 0, Math.PI * 2, false);
    const shieldHole = new THREE.Path();
    shieldHole.absarc(0, 0, 0.55, 0, Math.PI * 2, true);
    shieldShape.holes.push(shieldHole);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
      const hole = new THREE.Path();
      hole.absarc(Math.cos(a) * 0.9, Math.sin(a) * 0.9, 0.15, 0, Math.PI * 2, true);
      shieldShape.holes.push(hole);
    }
    const shieldGeo = new THREE.ExtrudeGeometry(shieldShape, {
      depth: 0.07, bevelEnabled: true, bevelSegments: 1, steps: 1,
      bevelSize: 0.018, bevelThickness: 0.018, curveSegments: 32,
    });
    shieldGeo.rotateY(Math.PI / 2);
    const shieldMaterial = M.aluCast.clone();
    shieldMaterial.side = THREE.DoubleSide;
    const shield = new THREE.Mesh(shieldGeo, shieldMaterial);
    shield.position.set(-2.96, 0, 0);
    shield.castShadow = shield.receiveShadow = true;
    bell.add(shield);
    this.register(shield, 'flywheelHousing', { shell: true });
    const shieldBolt = boltGroup(0.052, 0.075, M.polishedSteel, M.steelDark);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const b = shieldBolt.clone();
      b.position.set(-2.89, Math.cos(a) * 1.38, Math.sin(a) * 1.38);
      b.rotation.z = Math.PI / 2;
      bell.add(b);
      b.traverse(o => { if (o.isMesh) this.register(o, 'flywheelHousing'); });
    }
    bell.traverse(o => { if (o.isMesh) this.register(o, 'flywheelHousing'); });
    this.root.add(bell);
    this.parts.bell = bell;

    // Main bearing shells are partially visible when cut away.
    this.parts.mainBearingCaps = bell;
  }

  // ---------------------------------------------------------------------------
  // Valve train
  // ---------------------------------------------------------------------------
  buildValvetrain() {
    const M = this.M;
    this.valves = [];
    this.springs = [];
    this.rockers = [];
    this.pushrods = [];
    this.lifters = [];

    const valveProfile = [
      [0.0, -0.085], [0.17, -0.07], [0.205, -0.02], [0.20, 0.005],
      [0.115, 0.045], [0.055, 0.07], [0.04, 0.56], [0.04, 1.32], [0.018, 1.4],
    ];
    const pts = valveProfile.map(([r, y]) => new THREE.Vector2(r, y));
    const valveGeo = new THREE.LatheGeometry(pts, 32);

    for (let i = 0; i < 4; i++) {
      for (const kind of ['intake', 'exhaust']) {
        const isIntake = kind === 'intake';
        const x = CYL_X[i] + (isIntake ? -0.185 : 0.185);
        const id = `${kind}Valve-${i}`;
        const vg = new THREE.Group();
        vg.position.set(x, VALVE_SEAT, 0);
        const vm = new THREE.Mesh(valveGeo, isIntake ? M.valveSteel : M.valveHot);
        vm.castShadow = vm.receiveShadow = true;
        vg.add(vm);
        this.register(vm, id, { cylinder: i });
        // Retainer + split keepers.
        const retainer = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.1, 0.055, 22), M.springSteel);
        retainer.position.y = 1.26;
        vg.add(retainer);
        this.register(retainer, id, { cylinder: i });
        const keeper = new THREE.Mesh(new THREE.ConeGeometry(0.072, 0.12, 16), M.blackOxide);
        keeper.position.y = 1.33;
        vg.add(keeper);
        this.register(keeper, id, { cylinder: i });
        this.root.add(vg);
        this.valves.push({ group: vg, kind, cylinder: i, baseY: VALVE_SEAT });

        // Valve spring (coils remain circular; spacing is animated).
        const spring = makeSpring(0.155, 0.59, 7, 0.026, M.springSteel);
        spring.position.set(x, 4.39, 0);
        spring.traverse(o => { if (o.isMesh) this.register(o, 'valveSpring', { cylinder: i }); });
        this.root.add(spring);
        this.springs.push({ group: spring, kind, cylinder: i, baseY: 4.12, baseSpacing: 0.59 / 6 });

        // Rocker arm at the valve end; group rotates about the rocker shaft.
        const rg = new THREE.Group();
        rg.position.set(x, ROCKER_Y, ROCKER_Z);
        const arm = new THREE.Mesh(roundedBox(0.16, 0.085, 0.56, 0.035), M.rockerMat ?? M.forgedSteel);
        arm.position.z = 0.035;
        rg.add(arm);
        const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.19, 18), M.steelDark);
        hub.rotation.z = Math.PI / 2;
        rg.add(hub);
        const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.065, 0.08, 16), M.polishedSteel);
        pad.position.set(0, -0.13, -0.235);
        rg.add(pad);
        const roller = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.1, 16), M.polishedSteel);
        roller.rotation.z = Math.PI / 2;
        roller.position.set(0, 0.06, 0.30);
        rg.add(roller);
        rg.traverse(o => { if (o.isMesh) this.register(o, 'rocker', { cylinder: i }); });
        this.root.add(rg);
        this.rockers.push({ group: rg, kind, cylinder: i });

        // Lifter.
        const lifter = new THREE.Group();
        lifter.position.set(x, 2.17, CAM_Z);
        const lb = new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.105, 0.42, 20), M.forgedSteel);
        lb.castShadow = true;
        lifter.add(lb);
        const lifterFace = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.035, 20), M.polishedSteel);
        lifterFace.position.y = -0.22;
        lifter.add(lifterFace);
        lifter.traverse(o => { if (o.isMesh) this.register(o, 'lifter', { cylinder: i }); });
        this.root.add(lifter);
        this.lifters.push({ group: lifter, kind, cylinder: i });

        // Pushrod, re-oriented every frame.
        const pushrod = new THREE.Group();
        const rodShaft = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1, 12), M.polishedSteel);
        rodShaft.position.y = 0.5;
        pushrod.add(rodShaft);
        const ballA = new THREE.Mesh(new THREE.SphereGeometry(0.055, 12, 8), M.polishedSteel);
        pushrod.add(ballA);
        const ballB = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 8), M.polishedSteel);
        ballB.position.y = 1;
        pushrod.add(ballB);
        pushrod.userData.shaft = rodShaft;
        pushrod.userData.ballTop = ballB;
        pushrod.traverse(o => { if (o.isMesh) this.register(o, 'pushrod', { cylinder: i }); });
        this.root.add(pushrod);
        this.pushrods.push({ group: pushrod, kind, cylinder: i });
      }
    }

    // Camshaft, cam lobes, cam bearings and timing gear.
    const cam = new THREE.Group();
    cam.name = 'Camshaft';
    cam.position.set(0, CAM_Y, CAM_Z);
    this.root.add(cam);
    this.dynamic.cam = cam;

    const camShaft = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 5.72, 20), M.gearSteel);
    camShaft.rotation.z = Math.PI / 2;
    camShaft.position.x = 0.1;
    cam.add(camShaft);
    this.register(camShaft, 'camshaft');

    const lobeShape = new THREE.Shape();
    // Asymmetric cam lobe profile: base circle with a smooth nose.
    for (let k = 0; k <= 48; k++) {
      const a = (k / 48) * Math.PI * 2;
      const nose = Math.max(0, Math.cos(a - 0.35)) ** 3;
      const r = 0.22 + 0.145 * nose;
      const px = Math.cos(a) * r;
      const py = Math.sin(a) * r;
      if (k === 0) lobeShape.moveTo(px, py); else lobeShape.lineTo(px, py);
    }
    lobeShape.closePath();
    // Extrusion profile is a flat plate with normal along X.
    const lobeGeo = new THREE.ExtrudeGeometry(lobeShape, { depth: 0.16, bevelEnabled: true, bevelSize: 0.012, bevelThickness: 0.012, bevelSegments: 1, curveSegments: 8 });
    lobeGeo.rotateY(Math.PI / 2);
    lobeGeo.translate(-0.08, 0, 0);
    const lobePhases = [
      [0.35, 2.5], [2.6, 4.8], [4.1, 0.65], [1.3, 3.7],
      [5.25, 1.95], [3.25, 5.6], [2.0, 4.3], [5.85, 0.35],
    ];
    for (let i = 0; i < 4; i++) {
      for (let k = 0; k < 2; k++) {
        const lobe = new THREE.Mesh(lobeGeo, M.gearSteel);
        lobe.position.x = CYL_X[i] + (k === 0 ? -0.185 : 0.185);
        lobe.rotation.x = lobePhases[i][k];
        cam.add(lobe);
        this.register(lobe, 'camshaft');
      }
    }
    for (const x of [-2.2, 0, 2.2]) {
      const bearing = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.22, 24), M.bearing);
      bearing.rotation.z = Math.PI / 2;
      bearing.position.x = x;
      cam.add(bearing);
      this.register(bearing, 'camshaft');
    }
    // Camshaft gear is added in the timing section and shares the same angular speed.

    // A small brass oil feed tube above the rocker shaft.
    const feed = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 4.7, 10), M.copper);
    feed.rotation.z = Math.PI / 2;
    feed.position.set(0, 5.01, 0.34);
    this.root.add(feed);
    this.register(feed, 'oilGallery');
    for (let i = 0; i < 4; i++) {
      const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.035, 0.16, 9), M.brass);
      nozzle.position.set(CYL_X[i] + 0.3, 5.08, 0.34);
      this.root.add(nozzle);
      this.register(nozzle, 'oilGallery');
    }
  }

  // ---------------------------------------------------------------------------
  // Timing gears, front cover and accessory drive
  // ---------------------------------------------------------------------------
  buildTimingAndFront() {
    const M = this.M;
    const timing = new THREE.Group();
    timing.name = 'Timing gear train';
    this.root.add(timing);
    this.parts.timing = timing;

    const gearX = 2.99;
    // Crank gear (28 t) and cam gear (56 t) are modeled with roughly 1:2 pitch.
    const crankGear = makeGear(28, 0.53, 0.15, M.gearSteel, { toothHeight: 0.1, hubRadius: 0.2 });
    crankGear.rotation.y = Math.PI / 2;
    crankGear.position.set(gearX, 0, 0);
    timing.add(crankGear);
    this.register(crankGear, 'timingGears');
    this.dynamic.crankGear = crankGear;

    const camGear = makeGear(56, 1.02, 0.14, M.gearSteel, { toothHeight: 0.11, hubRadius: 0.26, spokes: 4 });
    camGear.rotation.y = Math.PI / 2;
    camGear.position.set(gearX + 0.14, CAM_Y - 0.05, CAM_Z - 0.18);
    timing.add(camGear);
    this.register(camGear, 'timingGears');
    this.dynamic.camGear = camGear;

    // Idler gear and injection pump gear.
    const idler = makeGear(34, 0.65, 0.13, M.gearSteel, { toothHeight: 0.09, hubRadius: 0.18 });
    idler.rotation.y = Math.PI / 2;
    idler.position.set(gearX + 0.28, 1.0, -1.1);
    timing.add(idler);
    this.register(idler, 'timingGears');

    const pumpGear = makeGear(40, 0.76, 0.14, M.gearSteel, { toothHeight: 0.1, hubRadius: 0.2 });
    pumpGear.rotation.y = Math.PI / 2;
    pumpGear.position.set(gearX + 0.2, 1.48, -1.42);
    timing.add(pumpGear);
    this.register(pumpGear, 'timingGears');
    this.dynamic.pumpGear = pumpGear;

    // Front timing cover with a cast window frame silhouette.
    const coverShape = new THREE.Shape();
    coverShape.moveTo(-1.76, -1.13);
    coverShape.lineTo(1.15, -1.13);
    coverShape.quadraticCurveTo(1.53, -1.08, 1.53, -0.7);
    coverShape.lineTo(1.53, 0.67);
    coverShape.quadraticCurveTo(1.53, 1.22, 1.03, 1.5);
    coverShape.lineTo(-0.62, 1.5);
    coverShape.quadraticCurveTo(-1.42, 1.44, -1.64, 0.72);
    coverShape.closePath();
    const coverGeo = new THREE.ExtrudeGeometry(coverShape, {
      depth: 0.2, bevelEnabled: true, bevelSegments: 2, bevelSize: 0.04, bevelThickness: 0.04, curveSegments: 24,
    });
    coverGeo.rotateY(Math.PI / 2);
    const cover = new THREE.Mesh(coverGeo, M.coverPaint);
    cover.position.set(3.26, 1.58, 0);
    cover.castShadow = cover.receiveShadow = true;
    timing.add(cover);
    this.register(cover, 'timingCover', { shell: true });

    // Stepped cast face and ribs break up the large front silhouette.
    const frontPlate = new THREE.Mesh(roundedBox(0.045, 2.05, 2.5, 0.06), M.castIron);
    frontPlate.position.set(3.475, 1.55, 0.02);
    frontPlate.castShadow = true;
    timing.add(frontPlate);
    this.register(frontPlate, 'timingCover', { shell: true });
    for (let i = 0; i < 3; i++) {
      const rib = new THREE.Mesh(roundedBox(0.035, 0.055, 2.2, 0.015), M.aluDark);
      rib.position.set(3.505, 0.92 + i * 0.52, 0.03);
      timing.add(rib);
      this.register(rib, 'timingCover');
    }
    const coverBadge = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.24), new THREE.MeshBasicMaterial({
      map: addTextPlane('TIMING', 'GEAR DRIVE  |  2 : 1', 512, 128), transparent: true, opacity: 0.72,
    }));
    coverBadge.rotation.y = Math.PI / 2;
    coverBadge.position.set(3.529, 2.65, -0.4);
    timing.add(coverBadge);
    this.register(coverBadge, 'timingCover');

    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      this.addBolt(timing, 3.52, 1.58 + Math.cos(a) * 1.23, Math.sin(a) * 1.27, 0.045, 0.08, 'timingCover', { rotation: [0, 0, Math.PI / 2] });
    }

    // Lower cover boss closes around the crank gear. Without this, the crank
    // gear teeth read as an exposed external part in a fully assembled view.
    const lowerCover = new THREE.Mesh(roundedBox(0.24, 1.4, 1.6, 0.28, 3), M.coverPaint);
    lowerCover.position.set(3.32, -0.19, 0);
    lowerCover.castShadow = lowerCover.receiveShadow = true;
    timing.add(lowerCover);
    this.register(lowerCover, 'timingCover', { shell: true });
    for (let i = 0; i < 2; i++) {
      const rib = new THREE.Mesh(roundedBox(0.03, 0.06, 1.22, 0.015), M.aluDark);
      rib.position.set(3.46, -0.46 + i * 0.3, 0);
      timing.add(rib);
      this.register(rib, 'timingCover');
    }
    for (const z of [-0.53, 0.53]) {
      this.addBolt(timing, 3.47, -0.75, z, 0.04, 0.07, 'timingCover', { rotation: [0, 0, Math.PI / 2] });
    }

    // Front crank damper / pulley — also serves as a visual rotation cue.
    const damper = new THREE.Group();
    damper.position.set(3.47, 0, 0);
    const damperOuter = new THREE.Mesh(new THREE.CylinderGeometry(0.61, 0.61, 0.27, 48), M.blackOxide);
    damperOuter.rotation.z = Math.PI / 2;
    damper.add(damperOuter);
    const damperFace = new THREE.Mesh(new THREE.CylinderGeometry(0.52, 0.52, 0.28, 48), M.aluMachined);
    damperFace.rotation.z = Math.PI / 2;
    damper.add(damperFace);
    const damperHub = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.4, 24), M.steelDark);
    damperHub.rotation.z = Math.PI / 2;
    damper.add(damperHub);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const hole = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.3, 12), M.blackOxide);
      hole.rotation.z = Math.PI / 2;
      hole.position.set(0, Math.cos(a) * 0.35, Math.sin(a) * 0.35);
      damper.add(hole);
    }
    damper.traverse(o => { if (o.isMesh) { o.castShadow = true; this.register(o, 'crank'); } });
    this.root.add(damper);
    this.dynamic.damper = damper;

    // Ribs on the damper face to make rotation legible.
    for (let i = 0; i < 4; i++) {
      const mark = new THREE.Mesh(roundedBox(0.02, 0.42, 0.035, 0.01), M.cyanGlow);
      const a = (i / 4) * Math.PI * 2;
      mark.position.set(0.15, Math.cos(a) * 0.28, Math.sin(a) * 0.28);
      mark.rotation.x = a;
      damper.add(mark);
    }

    // Water pump pulley, alternator pulley and serpentine belt.
    const pulley = (r, width, mat) => {
      const g = new THREE.Group();
      const p = new THREE.Mesh(new THREE.CylinderGeometry(r, r, width, 32), mat);
      p.rotation.z = Math.PI / 2;
      g.add(p);
      const lip = new THREE.Mesh(new THREE.TorusGeometry(r * 0.96, 0.025, 8, 32), M.steelDark);
      lip.rotation.y = Math.PI / 2;
      g.add(lip);
      return g;
    };
    const wpPulley = pulley(0.33, 0.14, M.steelDark);
    wpPulley.position.set(3.41, 2.3, -0.49);
    this.root.add(wpPulley);
    this.dynamic.waterPulley = wpPulley;

    const altPulley = pulley(0.27, 0.14, M.polishedSteel);
    altPulley.position.set(3.42, 1.02, 1.42);
    this.root.add(altPulley);
    this.dynamic.altPulley = altPulley;

    const tensioner = pulley(0.18, 0.12, M.gearSteel);
    tensioner.position.set(3.43, 0.65, -0.95);
    this.root.add(tensioner);
    this.dynamic.tensioner = tensioner;

    const beltPoints = [
      V(3.43, 0.00, 0.64), V(3.43, 0.66, 0.53), V(3.43, 1.1, 1.25), V(3.43, 1.44, 1.58),
      V(3.43, 2.15, 0.72), V(3.43, 2.5, -0.2), V(3.43, 2.14, -0.85), V(3.43, 1.2, -1.02),
      V(3.43, 0.2, -0.85), V(3.43, -0.35, 0.2), V(3.43, -0.25, 0.61),
    ];
    const beltCurve = new THREE.CatmullRomCurve3(beltPoints, true, 'catmullrom', 0.3);
    const beltGeo = new THREE.TubeGeometry(beltCurve, 180, 0.058, 6, true);
    beltGeo.scale(1, 1, 1);
    const belt = new THREE.Mesh(beltGeo, M.belt);
    belt.castShadow = true;
    belt.receiveShadow = true;
    this.root.add(belt);
    this.register(belt, 'alternator');

    this.flowAnchors.timing = { x: 3.0, y: 2.0, z: 0 };
  }

  // ---------------------------------------------------------------------------
  // Head details, injectors and engine plate
  // ---------------------------------------------------------------------------
  buildHeadDetails() {
    const M = this.M;
    this.injectors = [];
    // Intake and exhaust ports / seats visible in cutaway.
    for (let i = 0; i < 4; i++) {
      for (const isIntake of [true, false]) {
        const port = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.19, 0.45, 20), isIntake ? M.aluMachined : M.turboHot);
        port.position.set(CYL_X[i] + (isIntake ? -0.185 : 0.185), 3.78, isIntake ? -0.68 : 0.68);
        port.rotation.x = Math.PI / 2;
        port.rotation.z = isIntake ? 0.32 : -0.32;
        this.root.add(port);
        this.register(port, isIntake ? 'intakeManifold' : 'exhaustManifold');
      }
    }

    // Injector bodies and visible tops. The body is mostly inside the head.
    for (let i = 0; i < 4; i++) {
      const inj = new THREE.Group();
      const x = CYL_X[i];
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.1, 0.72, 18), M.injectorMat ?? M.steelDark);
      body.position.y = 4.52;
      inj.add(body);
      const top = new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.11, 0.36, 18), M.blackOxide);
      top.position.y = 5.02;
      inj.add(top);
      const solenoid = new THREE.Mesh(roundedBox(0.23, 0.22, 0.18, 0.04), M.plastic);
      solenoid.position.set(0, 5.18, 0);
      inj.add(solenoid);
      const connector = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.14, 12), M.sensor);
      connector.rotation.z = Math.PI / 2;
      connector.position.set(0.16, 5.2, 0);
      inj.add(connector);
      // Nozzle tip visible at the combustion chamber.
      const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.052, 0.22, 14), M.polishedSteel);
      nozzle.position.y = 4.04;
      inj.add(nozzle);
      const clamp = new THREE.Mesh(roundedBox(0.32, 0.08, 0.22, 0.03), M.aluCast);
      clamp.position.y = 4.72;
      inj.add(clamp);
      inj.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; this.register(o, `injector-${i}`, { cylinder: i }); } });
      this.root.add(inj);
      this.injectors.push(inj);
    }

    // Engine identification plaque.
    const plaqueTex = canvasTexture(1024, 512, (ctx, w, h) => {
      ctx.fillStyle = '#171d20';
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = '#b9965b';
      ctx.lineWidth = 8;
      ctx.strokeRect(24, 24, w - 48, h - 48);
      ctx.fillStyle = '#d2d8d6';
      ctx.font = '700 92px Bahnschrift, Arial Narrow, sans-serif';
      ctx.fillText('4C-105', 68, 166);
      ctx.fillStyle = '#6fcbd5';
      ctx.font = '500 36px Bahnschrift, Arial, sans-serif';
      ctx.letterSpacing = '10px';
      ctx.fillText('TURBO DIESEL  ·  2.0 L', 70, 240);
      ctx.fillStyle = '#8e9a9a';
      ctx.font = '400 26px Bahnschrift, Arial, sans-serif';
      ctx.fillText('105 × 130 mm   |   17.5 : 1   |   1,800 bar', 70, 306);
      ctx.fillStyle = '#b9965b';
      ctx.fillRect(70, 338, w - 140, 2);
      ctx.font = '400 23px Bahnschrift, Arial, sans-serif';
      ctx.fillStyle = '#9da6a4';
      ctx.fillText('SERIAL  CN-4C-105-2026   ·   SYNTHETIC CUTAWAY', 70, 390);
    });
    const plaque = new THREE.Mesh(new THREE.PlaneGeometry(1.28, 0.64), new THREE.MeshBasicMaterial({ map: plaqueTex }));
    plaque.position.set(-1.0, -0.34, 1.086);
    plaque.rotation.x = -0.03;
    this.root.add(plaque);
    this.register(plaque, 'block');

    // Cylinder number castings on the valve cover sides.
    for (let i = 0; i < 4; i++) {
      const tex = canvasTexture(128, 128, (ctx, w, h) => {
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = 'rgba(210,220,219,0.8)';
        ctx.font = '700 76px Bahnschrift, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(i + 1), w / 2, h / 2 + 2);
      });
      const num = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.2), new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.8 }));
      num.position.set(CYL_X[i], 5.062, 0.87);
      num.rotation.x = -Math.PI / 2;
      this.root.add(num);
      this.register(num, 'head');
    }
  }

  buildSurfaceDetails() {
    const M = this.M;
    const details = new THREE.Group();
    details.name = 'Casting and assembly details';
    this.root.add(details);

    // Crankcase side access cover on the visible (+Z) flank.
    const access = new THREE.Group();
    const accessPlate = new THREE.Mesh(roundedBox(1.85, 0.5, 0.06, 0.055), M.castIron);
    accessPlate.position.set(-0.05, -0.12, 1.085);
    access.add(accessPlate);
    const accessGasket = new THREE.Mesh(roundedBox(1.98, 0.6, 0.025, 0.05), M.gasketRubber);
    accessGasket.position.set(-0.05, -0.12, 1.065);
    access.add(accessGasket);
    for (const x of [-0.82, -0.29, 0.24, 0.77]) {
      for (const y of [-0.31, 0.08]) {
        const b = boltGroup(0.045, 0.065, M.polishedSteel, M.steelDark);
        b.position.set(-0.05 + x, -0.12 + y, 1.13);
        b.rotation.z = Math.PI / 2;
        access.add(b);
        b.traverse(o => { if (o.isMesh) this.register(o, 'block'); });
      }
    }
    const accessRib = new THREE.Mesh(roundedBox(1.55, 0.06, 0.035, 0.015), M.castIronDark);
    accessRib.position.set(-0.05, -0.12, 1.13);
    access.add(accessRib);
    access.traverse(o => { if (o.isMesh && !o.userData.partId) { o.castShadow = true; o.receiveShadow = true; this.register(o, 'block'); } });
    details.add(access);

    // Casting number and tiny machined marks on the flank.
    const flankTex = canvasTexture(512, 128, (ctx, w, h) => {
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = 'rgba(175,197,196,0.54)';
      ctx.font = '500 58px Bahnschrift, Arial Narrow, sans-serif';
      ctx.fillText('4C·105', 16, 76);
      ctx.font = '400 22px Consolas, monospace';
      ctx.fillStyle = 'rgba(150,177,179,0.4)';
      ctx.fillText('GJV-450  /  105 × 130', 18, 108);
    });
    const flank = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 0.32), new THREE.MeshBasicMaterial({
      map: flankTex, transparent: true,
    }));
    flank.position.set(-1.8, 0.9, 1.155);
    details.add(flank);
    this.register(flank, 'block');

    // Lifting eyes at the ends of the cylinder head.
    for (const x of [-2.45, 2.45]) {
      const eye = new THREE.Group();
      const base = new THREE.Mesh(roundedBox(0.34, 0.12, 0.24, 0.03), M.steelDark);
      base.position.set(x, 4.39, 0.52);
      eye.add(base);
      const loop = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.045, 8, 22, Math.PI), M.steelDark);
      loop.position.set(x, 4.5, 0.52);
      loop.rotation.y = Math.PI / 2;
      loop.rotation.z = Math.PI;
      eye.add(loop);
      eye.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; this.register(o, 'head'); } });
      details.add(eye);
    }

    // Cross-bolted coolant outlet / hose clamp hardware.
    const clampGroup = new THREE.Group();
    for (const [x, y, z, r] of [[3.33, 3.98, -0.95, 0.16], [4.74, 3.28, 1.15, 0.16], [3.16, 1.86, -0.48, 0.14]]) {
      const clamp = new THREE.Mesh(new THREE.TorusGeometry(r, 0.024, 7, 28), M.polishedSteel);
      clamp.position.set(x, y, z);
      clamp.rotation.y = Math.PI / 2;
      clampGroup.add(clamp);
      this.register(clamp, 'coolantHose');
    }
    details.add(clampGroup);

    // Wiring loom clips along the head and block.
    for (const x of [-2.05, -0.7, 0.65, 2.0]) {
      const clip = new THREE.Mesh(roundedBox(0.11, 0.09, 0.18, 0.02), M.plastic);
      clip.position.set(x, 3.93, 1.24);
      details.add(clip);
      this.register(clip, 'ecu');
    }
    const loom = tubeFromPoints([
      V(-2.6, 3.94, 1.22), V(-1.6, 3.9, 1.27), V(-0.4, 3.92, 1.27), V(0.8, 3.9, 1.25),
      V(2.1, 3.94, 1.2), V(2.85, 3.55, 1.1), V(3.15, 2.8, 0.9),
    ], 0.03, M.wiring, { segments: 60, radialSegments: 6 });
    details.add(loom);
    this.register(loom, 'ecu');

    // Cast diagonal ribs below the freeze plugs.
    for (const [x, rz] of [[-2.35, -0.34], [-1.32, 0.3], [1.35, -0.28], [2.35, 0.32]]) {
      const rib = new THREE.Mesh(roundedBox(0.065, 0.62, 0.065, 0.02), M.castIron);
      rib.position.set(x, 0.34, 1.1);
      rib.rotation.z = rz;
      details.add(rib);
      this.register(rib, 'block');
    }
    const sideRail = new THREE.Mesh(roundedBox(5.5, 0.06, 0.06, 0.02), M.castIron);
    sideRail.position.set(0, 0.58, 1.12);
    details.add(sideRail);
    this.register(sideRail, 'block');
    // Oil sump stencil.
    const sumpLabel = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.16), new THREE.MeshBasicMaterial({
      map: addTextPlane('OIL 6.5 L', 'DEEP SUMP / GJV-450', 512, 128),
      transparent: true, opacity: 0.48, depthWrite: false,
    }));
    sumpLabel.position.set(0.45, -1.23, 0.965);
    details.add(sumpLabel);
    this.register(sumpLabel, 'pan');

    // Small quick-connect service fittings and warning cap.
    const serviceCap = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.1, 0.1, 18), M.orangeFilter);
    serviceCap.position.set(2.72, 0.51, 1.11);
    serviceCap.rotation.x = Math.PI / 2;
    details.add(serviceCap);
    this.register(serviceCap, 'waterJacket');
    const coolantTag = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.12), new THREE.MeshBasicMaterial({
      map: addTextPlane('COOLANT', 'DO NOT OPEN HOT', 512, 128), transparent: true, opacity: 0.68,
    }));
    coolantTag.position.set(2.72, 0.68, 1.12);
    details.add(coolantTag);
    this.register(coolantTag, 'waterJacket');
  }

  buildStand() {
    const M = this.M;
    const stand = new THREE.Group();
    const floorY = -2.84;
    const base = new THREE.Mesh(new THREE.CylinderGeometry(3.5, 3.6, 0.13, 64), M.steelDark);
    base.position.y = floorY + 0.065;
    base.receiveShadow = true;
    base.castShadow = true;
    stand.add(base);
    this.register(base, 'stand');
    for (const x of [-1.72, 1.72]) {
      const post = new THREE.Mesh(roundedBox(0.3, 1.02, 0.44, 0.08), M.castIronDark);
      post.position.set(x, floorY + 0.62, 0);
      post.castShadow = post.receiveShadow = true;
      stand.add(post);
      this.register(post, 'stand');
      const cradle = new THREE.Mesh(roundedBox(0.44, 0.16, 1.5, 0.07), M.steelDark);
      cradle.position.set(x, -1.81, 0);
      stand.add(cradle);
      this.register(cradle, 'stand');
      const pad = new THREE.Mesh(roundedBox(0.5, 0.07, 1.33, 0.03), M.rubber);
      pad.position.set(x, -1.91, 0);
      stand.add(pad);
      this.register(pad, 'stand');
    }
    // Foundation bolts and cyan perimeter marks.
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      this.addBolt(stand, Math.cos(a) * 3.22, floorY + 0.15, Math.sin(a) * 3.22, 0.06, 0.08, 'stand');
    }
    const ring = new THREE.Mesh(new THREE.TorusGeometry(3.34, 0.008, 6, 128), M.cyanGlow);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = floorY + 0.135;
    stand.add(ring);
    this.register(ring, 'stand');
    this.root.add(stand);
    this.parts.stand = stand;
  }

  buildFuelSystem() {
    const M = this.M;
    const fuel = new THREE.Group();
    fuel.name = 'Fuel system';
    this.root.add(fuel);
    this.parts.fuel = fuel;

    // Common rail across the top of the valve cover.
    const rail = new THREE.Group();
    const railY = 4.69;
    const railZ = -1.07;
    const railBody = new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.105, 4.18, 24), M.polishedSteel);
    railBody.rotation.z = Math.PI / 2;
    rail.add(railBody);
    for (const x of [-1.8, 1.8]) {
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.12, 6), M.steelDark);
      cap.rotation.z = Math.PI / 2;
      cap.position.x = x;
      rail.add(cap);
    }
    for (const x of [-2.1, -0.7, 0.7, 2.1]) {
      const port = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.065, 0.2, 14), M.copper);
      port.position.set(x, 0.08, 0);
      rail.add(port);
    }
    const sensor = new THREE.Mesh(roundedBox(0.24, 0.18, 0.2, 0.03), M.plastic);
    sensor.position.set(1.8, 0.02, 0.12);
    rail.add(sensor);
    const connector = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.18, 10), M.sensor);
    connector.rotation.z = Math.PI / 2;
    connector.position.set(2.05, 0.02, 0.12);
    rail.add(connector);
    for (const x of [-1.85, 1.85]) {
      const bracket = new THREE.Mesh(roundedBox(0.32, 0.07, 0.22, 0.025), M.aluDark);
      bracket.position.set(x, -0.15, 0.08);
      rail.add(bracket);
    }
    rail.position.set(0, railY, railZ);
    rail.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; this.register(o, 'commonRail'); } });
    fuel.add(rail);

    // High-pressure lines: elegant, equal-length arcs from rail to injector tops.
    for (let i = 0; i < 4; i++) {
      const x = CYL_X[i];
      const pts = [
        V(x, railY + 0.09, railZ), V(x, railY + 0.28, railZ + 0.18), V(x, 5.31, -0.42),
        V(x, 5.34, -0.05), V(x, 5.27, 0.06), V(x, 5.16, 0.05),
      ];
      const tube = tubeFromPoints(pts, 0.023, M.polishedSteel, { segments: 48, radialSegments: 8 });
      fuel.add(tube);
      this.register(tube, 'fuelLine');
      for (const p of [pts[0], pts[3]]) {
        const nut = new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.048, 0.08, 6), M.copper);
        nut.position.copy(p);
        nut.rotation.x = Math.PI / 2;
        fuel.add(nut);
        this.register(nut, 'fuelLine');
      }
      const clamp = new THREE.Mesh(roundedBox(0.17, 0.035, 0.11, 0.015), M.aluDark);
      clamp.position.set(x, 5.32, -0.35);
      fuel.add(clamp);
      this.register(clamp, 'fuelLine');
    }

    // High-pressure pump at the front of the timing case.
    const pump = new THREE.Group();
    const pumpBody = new THREE.Mesh(roundedBox(0.72, 0.78, 0.7, 0.08), M.aluCast);
    pumpBody.position.set(3.05, 1.18, -1.42);
    pump.add(pumpBody);
    for (const z of [-0.2, 0, 0.2]) {
      const plunger = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.55, 16), M.polishedSteel);
      plunger.position.set(3.0, 1.6, -1.42 + z);
      pump.add(plunger);
    }
    const pumpFlange = new THREE.Mesh(new THREE.CylinderGeometry(0.31, 0.31, 0.14, 24), M.aluMachined);
    pumpFlange.rotation.z = Math.PI / 2;
    pumpFlange.position.set(3.4, 1.18, -1.42);
    pump.add(pumpFlange);
    const pumpPulley = new THREE.Group();
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.14, 32), M.steelDark);
    wheel.rotation.z = Math.PI / 2;
    pumpPulley.add(wheel);
    for (let i = 0; i < 3; i++) {
      const hole = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.16, 14), M.blackOxide);
      hole.rotation.z = Math.PI / 2;
      const a = (i / 3) * Math.PI * 2;
      hole.position.set(0, Math.cos(a) * 0.18, Math.sin(a) * 0.18);
      pumpPulley.add(hole);
    }
    pumpPulley.position.set(3.51, 1.18, -1.42);
    pump.add(pumpPulley);
    this.dynamic.fuelPumpPulley = pumpPulley;
    const inlet = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.065, 0.35, 12), M.copper);
    inlet.position.set(2.72, 1.55, -1.5);
    inlet.rotation.z = 0.9;
    pump.add(inlet);
    const pumpOutlet = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.32, 12), M.polishedSteel);
    pumpOutlet.position.set(2.83, 1.72, -1.58);
    pump.add(pumpOutlet);
    pump.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; this.register(o, 'fuelPump'); } });
    fuel.add(pump);

    // Pump-to-rail line.
    const pumpLine = tubeFromPoints([
      V(2.83, 1.9, -1.58), V(2.45, 2.7, -1.7), V(1.9, 3.65, -1.75), V(1.95, 4.48, -1.4),
      V(2.05, 4.72, -1.08),
    ], 0.03, M.polishedSteel, { segments: 64, radialSegments: 8 });
    fuel.add(pumpLine);
    this.register(pumpLine, 'fuelLine');

    // Fuel filter / water separator.
    const filter = new THREE.Group();
    const filt = new THREE.Mesh(new THREE.CylinderGeometry(0.245, 0.245, 0.72, 28), M.paintedSteel);
    filt.position.set(2.36, 2.18, -1.62);
    filter.add(filt);
    const filtTop = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.27, 0.12, 28), M.aluMachined);
    filtTop.position.set(2.36, 2.6, -1.62);
    filter.add(filtTop);
    const filtCap = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.17, 6), M.plastic);
    filtCap.position.set(2.36, 2.72, -1.62);
    filter.add(filtCap);
    const waterSensor = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.16, 12), M.sensor);
    waterSensor.position.set(2.36, 1.73, -1.62);
    filter.add(waterSensor);
    const filterBracket = new THREE.Mesh(roundedBox(0.46, 0.15, 0.18, 0.03), M.aluDark);
    filterBracket.position.set(2.47, 2.55, -1.44);
    filter.add(filterBracket);
    for (const [y, x] of [[2.48, 2.6], [2.34, 2.6]]) {
      const fitting = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.28, 10), M.steelDark);
      fitting.rotation.x = Math.PI / 2;
      fitting.position.set(x, y, -1.36);
      filter.add(fitting);
    }
    filter.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; this.register(o, 'fuelFilter'); } });
    fuel.add(filter);

    const feedHose = tubeFromPoints([
      V(2.6, 2.42, -1.32), V(2.78, 2.22, -1.5), V(2.97, 1.92, -1.6), V(3.11, 1.57, -1.58),
    ], 0.035, M.rubber, { segments: 24, radialSegments: 8 });
    fuel.add(feedHose);
    this.register(feedHose, 'fuelFilter');

    // Low-pressure return line back toward the tank.
    const returnLine = tubeFromPoints([
      V(2.85, 1.0, -1.55), V(2.5, 0.6, -1.35), V(2.2, 0.35, -1.2), V(1.9, 0.24, -0.9),
    ], 0.028, M.steelDark, { segments: 32, radialSegments: 7 });
    fuel.add(returnLine);
    this.register(returnLine, 'fuelLine');

    this.flowAnchors.fuelPump = { x: 3.05, y: 1.5, z: -1.42 };
  }

  buildLubrication() {
    const M = this.M;
    const lube = new THREE.Group();
    lube.name = 'Lubrication system';
    this.root.add(lube);
    this.parts.lube = lube;

    // Oil pump inside the sump, visible in X-ray.
    const pump = new THREE.Group();
    const pumpBody = new THREE.Mesh(roundedBox(0.5, 0.44, 0.4, 0.07), M.aluCast);
    pumpBody.position.set(1.58, -1.3, 0.23);
    pump.add(pumpBody);
    const cover = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.14, 24), M.aluMachined);
    cover.rotation.x = Math.PI / 2;
    cover.position.set(1.58, -1.3, 0.48);
    pump.add(cover);
    // Gerotor rotor visible on the pump face.
    const rotor = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.05, 6), M.gearSteel);
    rotor.rotation.x = Math.PI / 2;
    rotor.position.set(1.58, -1.3, 0.57);
    pump.add(rotor);
    this.dynamic.oilPumpRotor = rotor;
    const pickupPipe = tubeFromPoints([
      V(1.58, -1.48, 0.18), V(1.38, -1.63, 0.22), V(1.05, -1.7, 0.3), V(0.88, -1.75, 0.32),
    ], 0.055, M.steelDark, { segments: 30, radialSegments: 8 });
    pump.add(pickupPipe);
    const screen = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.16, 0.18, 22), M.brass);
    screen.position.set(0.8, -1.75, 0.32);
    pump.add(screen);
    const screenHole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.19, 16), M.blackOxide);
    screenHole.position.copy(screen.position);
    pump.add(screenHole);
    pump.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; this.register(o, 'oilPump'); } });
    lube.add(pump);

    // Spin-on oil filter.
    const of = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.68, 30), M.paintedSteel);
    body.position.set(2.32, 0.49, 1.43);
    of.add(body);
    const top = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.1, 30), M.aluMachined);
    top.position.set(2.32, 0.88, 1.43);
    of.add(top);
    const nut = new THREE.Mesh(new THREE.CylinderGeometry(0.095, 0.095, 0.11, 6), M.steelDark);
    nut.position.set(2.32, 0.98, 1.43);
    of.add(nut);
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.286, 0.286, 0.05, 30), M.orangeFilter ?? M.brass);
    band.position.set(2.32, 0.67, 1.43);
    of.add(band);
    const band2 = new THREE.Mesh(new THREE.CylinderGeometry(0.289, 0.289, 0.024, 30), M.brass);
    band2.position.set(2.32, 0.32, 1.43);
    of.add(band2);
    // Bracket to block.
    const bracket = new THREE.Mesh(roundedBox(0.46, 0.14, 0.45, 0.03), M.aluDark);
    bracket.position.set(2.38, 0.93, 1.24);
    of.add(bracket);
    // Inlet/outlet fittings.
    for (const [x, y] of [[2.14, 0.6], [2.5, 0.6]]) {
      const fit = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.25, 10), M.copper);
      fit.rotation.x = Math.PI / 2;
      fit.position.set(x, y, 1.22);
      of.add(fit);
    }
    const filterLabel = new THREE.Mesh(new THREE.PlaneGeometry(0.31, 0.15), new THREE.MeshBasicMaterial({
      map: canvasTexture(512, 256, (ctx, w, h) => {
        ctx.fillStyle = '#d7ddd9';
        ctx.font = '700 94px Bahnschrift, Arial Narrow, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('OIL', w / 2, 126);
        ctx.font = '500 30px Bahnschrift, sans-serif';
        ctx.fillStyle = '#6d898c';
        ctx.fillText('FILTER  ·  5 μm', w / 2, 183);
      }), transparent: true,
    }));
    filterLabel.position.set(2.32, 0.5, 1.718);
    of.add(filterLabel);
    of.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; this.register(o, 'oilFilter'); } });
    lube.add(of);

    // Laminated oil cooler under the filter on the block side.
    const cooler = new THREE.Group();
    const coolerBody = new THREE.Mesh(roundedBox(0.9, 0.5, 0.36, 0.05), M.aluCast);
    coolerBody.position.set(1.32, 0.72, 1.26);
    cooler.add(coolerBody);
    for (let i = 0; i < 9; i++) {
      const plate = new THREE.Mesh(roundedBox(0.82, 0.025, 0.38, 0.01), M.aluMachined);
      plate.position.set(1.32, 0.5 + i * 0.05, 1.26);
      cooler.add(plate);
    }
    for (const [x, color] of [[1.35, M.copper], [1.5, M.steelDark]]) {
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.28, 10), color);
      pipe.rotation.x = Math.PI / 2;
      pipe.position.set(x, 0.78, 1.06);
      cooler.add(pipe);
    }
    cooler.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; this.register(o, 'oilCooler'); } });
    lube.add(cooler);

    // Main oil gallery running along the block, with six branch fittings.
    const gallery = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 5.25, 12), M.copper);
    gallery.rotation.z = Math.PI / 2;
    gallery.position.set(-0.05, 0.93, 1.03);
    lube.add(gallery);
    this.register(gallery, 'oilGallery');
    for (const x of [-2.4, -1.34, 0, 1.34, 2.4]) {
      const branch = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.22, 9), M.brass);
      branch.rotation.x = Math.PI / 2;
      branch.position.set(x, 0.93, 0.9);
      lube.add(branch);
      this.register(branch, 'oilGallery');
    }
    const pressureSensor = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.16, 14), M.sensor);
    pressureSensor.rotation.x = Math.PI / 2;
    pressureSensor.position.set(-2.53, 1.04, 1.04);
    lube.add(pressureSensor);
    this.register(pressureSensor, 'oilGallery');

    // External oil cooler lines.
    const oilFeed = tubeFromPoints([
      V(2.47, 0.45, 1.2), V(2.21, 0.35, 1.05), V(1.85, 0.5, 1.15), V(1.66, 0.63, 1.2),
    ], 0.034, M.steelDark, { segments: 28, radialSegments: 7 });
    lube.add(oilFeed);
    this.register(oilFeed, 'oilCooler');
    const oilReturn = tubeFromPoints([
      V(1.2, 0.78, 1.08), V(0.95, 0.9, 1.0), V(0.55, 0.92, 0.98),
    ], 0.034, M.steelDark, { segments: 22, radialSegments: 7 });
    lube.add(oilReturn);
    this.register(oilReturn, 'oilCooler');

    // Small turbo oil feed / drain.
    const turboFeed = tubeFromPoints([
      V(-2.55, 1.22, -0.7), V(-2.4, 2.2, 0.4), V(-2.2, 3.0, 1.45), V(-1.9, 3.02, 2.05),
    ], 0.032, M.copper, { segments: 44, radialSegments: 7 });
    lube.add(turboFeed);
    this.register(turboFeed, 'oilGallery');
    const turboDrain = tubeFromPoints([
      V(-1.5, 2.14, 2.15), V(-1.48, 1.35, 1.86), V(-1.32, 0.3, 1.6), V(-1.2, -0.65, 1.18),
    ], 0.06, M.rubber, { segments: 42, radialSegments: 9 });
    lube.add(turboDrain);
    this.register(turboDrain, 'oilGallery');

    this.flowAnchors.oilFilter = { x: 2.32, y: 0.5, z: 1.43 };
    this.flowAnchors.oilCooler = { x: 1.32, y: 0.72, z: 1.26 };
  }

  buildCooling() {
    const M = this.M;
    const cooling = new THREE.Group();
    cooling.name = 'Cooling system';
    this.root.add(cooling);
    this.parts.cooling = cooling;

    // Water pump volute on the timing case.
    const wp = new THREE.Group();
    const volute = new THREE.Mesh(new THREE.SphereGeometry(0.34, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.62), M.aluCast);
    volute.rotation.z = Math.PI / 2;
    volute.rotation.x = Math.PI / 2;
    volute.position.set(3.05, 2.3, -0.49);
    wp.add(volute);
    const inlet = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.55, 18), M.aluCast);
    inlet.rotation.x = Math.PI / 2;
    inlet.position.set(3.05, 2.15, -0.82);
    wp.add(inlet);
    for (let i = 0; i < 6; i++) {
      const vane = new THREE.Mesh(roundedBox(0.04, 0.34, 0.16, 0.015), M.aluDark);
      const a = (i / 6) * Math.PI * 2;
      vane.position.set(3.02, 2.3 + Math.cos(a) * 0.2, -0.49 + Math.sin(a) * 0.2);
      vane.rotation.x = a;
      wp.add(vane);
    }
    wp.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; this.register(o, 'waterPump'); } });
    cooling.add(wp);

    // Thermostat housing with wax element and outlet neck.
    const thermo = new THREE.Group();
    const th = new THREE.Mesh(roundedBox(0.46, 0.32, 0.52, 0.09), M.aluCast);
    th.position.set(3.02, 3.98, -0.95);
    thermo.add(th);
    const tcap = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 0.18, 28), M.aluMachined);
    tcap.position.set(3.02, 4.18, -0.95);
    thermo.add(tcap);
    const outlet = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.38, 18), M.aluCast);
    outlet.rotation.z = Math.PI / 2;
    outlet.position.set(3.22, 3.98, -0.95);
    thermo.add(outlet);
    for (const z of [-1.1, -0.8]) {
      this.addBolt(thermo, 2.94, 4.04, z, 0.042, 0.07, 'thermostat');
    }
    thermo.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; this.register(o, 'thermostat'); } });
    cooling.add(thermo);

    // Hoses: formed EPDM with spring clamps and quick-connect collars.
    const hoseGroup = (pts, radius, id) => {
      const g = new THREE.Group();
      const hose = tubeFromPoints(pts, radius, M.hose, { segments: 64, radialSegments: 12 });
      g.add(hose);
      this.register(hose, id);
      for (const i of [1, pts.length - 2]) {
        const p = pts[i];
        const tangent = new THREE.Vector3().subVectors(pts[i + 1] || pts[i - 1], pts[i - 1]).normalize();
        const ring = new THREE.Mesh(new THREE.TorusGeometry(radius * 1.15, 0.02, 7, 22), M.polishedSteel);
        ring.position.copy(p);
        ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), tangent);
        g.add(ring);
        this.register(ring, id);
      }
      cooling.add(g);
      return g;
    };
    hoseGroup([
      V(3.32, 3.98, -0.95), V(3.55, 4.05, -1.1), V(3.9, 4.0, -0.4), V(4.24, 3.8, 0.6),
      V(4.5, 3.5, 1.08), V(4.72, 3.28, 1.15),
    ], 0.13, 'coolantHose');
    hoseGroup([
      V(4.7, 0.9, 1.14), V(4.45, 0.68, 1.0), V(4.02, 0.55, 0.62), V(3.55, 0.65, 0.06),
      V(3.25, 1.42, -0.42), V(3.16, 1.86, -0.48),
    ], 0.13, 'coolantHose');
    hoseGroup([
      V(3.02, 2.05, -0.75), V(2.75, 1.9, -0.9), V(2.4, 1.8, -1.05), V(2.08, 1.7, -1.06),
    ], 0.09, 'coolantHose');

    // Radiator assembly at the front, visually balanced against the intercooler.
    const radiator = new THREE.Group();
    const radZ = 1.1;
    const radX = 4.82;
    const radW = 1.78;
    const radH = 2.42;
    const radY = 2.0;
    const core = new THREE.Mesh(roundedBox(0.2, radH, radW, 0.04), M.radiatorAlu);
    core.position.set(radX, radY, radZ);
    radiator.add(core);
    this.register(core, 'radiator', { shell: true });
    // Fine cooling tubes and fins, intentionally dense enough to read at close zoom.
    const tubeGeo = new THREE.BoxGeometry(0.26, 0.022, radW * 0.92);
    const finGeo = new THREE.BoxGeometry(0.24, radH * 0.94, 0.012);
    for (let i = 0; i < 18; i++) {
      const t = new THREE.Mesh(tubeGeo, M.aluMachined);
      t.position.set(radX, radY - radH * 0.44 + (i / 17) * radH * 0.88, radZ);
      radiator.add(t);
      this.register(t, 'radiator');
    }
    for (let i = 0; i < 23; i++) {
      const f = new THREE.Mesh(finGeo, M.radiatorAlu);
      f.position.set(radX, radY, radZ - radW * 0.44 + (i / 22) * radW * 0.88);
      radiator.add(f);
      this.register(f, 'radiator');
    }
    for (const s of [-1, 1]) {
      const tank = new THREE.Mesh(roundedBox(0.3, radH + 0.12, 0.18, 0.06), M.aluDark);
      tank.position.set(radX, radY, radZ + s * (radW / 2 + 0.08));
      radiator.add(tank);
      this.register(tank, 'radiator', { shell: true });
    }
    const filler = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.16, 0.12, 20), M.aluMachined);
    filler.position.set(radX, radY + radH / 2 + 0.1, radZ + radW / 2 - 0.23);
    radiator.add(filler);
    this.register(filler, 'radiator');
    const frameMat = M.aluDark;
    for (const y of [-1, 1]) {
      const rail = new THREE.Mesh(roundedBox(0.3, 0.09, radW + 0.3, 0.02), frameMat);
      rail.position.set(radX, radY + y * (radH / 2 + 0.08), radZ);
      radiator.add(rail);
      this.register(rail, 'radiator');
    }
    radiator.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    const radBadge = new THREE.Mesh(new THREE.PlaneGeometry(1.05, 0.2), new THREE.MeshBasicMaterial({
      map: addTextPlane('RADIATOR', 'COOLANT  ·  58 kW', 512, 128),
      transparent: true, opacity: 0.65, depthWrite: false,
    }));
    radBadge.rotation.y = Math.PI / 2;
    radBadge.position.set(radX + 0.15, 3.08, radZ);
    radiator.add(radBadge);
    this.register(radBadge, 'radiator');
    cooling.add(radiator);

    // Shroud + electronic fan.
    const shroud = new THREE.Mesh(new THREE.TorusGeometry(0.89, 0.075, 10, 48), M.plastic);
    shroud.rotation.y = Math.PI / 2;
    shroud.position.set(radX - 0.28, 1.98, radZ);
    shroud.castShadow = true;
    cooling.add(shroud);
    this.register(shroud, 'fan');
    const fan = new THREE.Group();
    fan.position.set(radX - 0.3, 1.98, radZ);
    const fanHub = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.22, 0.2, 24), M.plastic);
    fanHub.rotation.z = Math.PI / 2;
    fan.add(fanHub);
    const bladeGeo = roundedBox(0.16, 0.55, 0.045, 0.045);
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      const blade = new THREE.Mesh(bladeGeo, M.plastic);
      blade.position.set(0, Math.cos(a) * 0.58, Math.sin(a) * 0.58);
      blade.rotation.x = -a + 0.28;
      blade.rotation.z = 0.2;
      fan.add(blade);
    }
    fan.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; this.register(o, 'fan'); } });
    cooling.add(fan);
    this.dynamic.fan = fan;

    // Expansion reservoir: dark blow-moulded shell with a translucent level strip.
    const bottle = new THREE.Group();
    const bottleBody = new THREE.Mesh(roundedBox(0.4, 0.7, 0.22, 0.09), M.plasticLight);
    bottleBody.position.set(4.28, 2.86, 2.22);
    bottle.add(bottleBody);
    this.register(bottleBody, 'radiator');
    const bottleWindow = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.55), M.coolant);
    bottleWindow.position.set(4.28, 2.83, 2.335);
    bottle.add(bottleWindow);
    this.register(bottleWindow, 'radiator');
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.08, 16), M.aluDark);
    cap.position.set(4.28, 3.24, 2.22);
    bottle.add(cap);
    this.register(cap, 'radiator');
    const capBadge = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.025, 16), M.orangeFilter);
    capBadge.position.set(4.28, 3.285, 2.22);
    bottle.add(capBadge);
    this.register(capBadge, 'radiator');
    bottle.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    cooling.add(bottle);
    const overflow = tubeFromPoints([
      V(4.48, 2.7, 2.2), V(4.68, 2.5, 1.9), V(4.72, 2.4, 1.65),
    ], 0.035, M.hose, { segments: 20, radialSegments: 7 });
    cooling.add(overflow);
    this.register(overflow, 'coolantHose');

    this.flowAnchors.waterPump = { x: 3.1, y: 2.3, z: -0.5 };
    this.flowAnchors.thermostat = { x: 3.2, y: 4.0, z: -0.95 };
    this.flowAnchors.radiator = { x: 4.72, y: 2.0, z: 1.1 };
  }

  buildAirSystem() {
    const M = this.M;
    const air = new THREE.Group();
    air.name = 'Air and exhaust systems';
    this.root.add(air);
    this.parts.air = air;

    // Intake plenum on the cold side (-Z).
    const intake = new THREE.Group();
    const plenum = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.29, 4.2, 24), M.intakeCast);
    plenum.rotation.z = Math.PI / 2;
    plenum.position.set(0, 3.72, -1.48);
    intake.add(plenum);
    for (const x of [-2.05, 2.05]) {
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.25, 24), M.aluCast);
      cap.rotation.z = Math.PI / 2;
      cap.position.set(x, 3.72, -1.48);
      intake.add(cap);
    }
    for (let i = 0; i < 4; i++) {
      const x = CYL_X[i] - 0.185;
      const runner = tubeFromPoints([
        V(x, 3.7, -1.56), V(x, 3.66, -1.38), V(x, 3.6, -1.18),
      ], 0.165, M.intakeCast, { segments: 24, radialSegments: 14 });
      intake.add(runner);
      const gasket = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.028, 8, 28), M.gasketRubber);
      gasket.rotation.y = 0;
      gasket.rotation.x = Math.PI / 2;
      gasket.position.set(x, 3.58, -1.17);
      intake.add(gasket);
      const boss = new THREE.Mesh(roundedBox(0.35, 0.34, 0.14, 0.04), M.aluCast);
      boss.position.set(x, 3.57, -1.14);
      intake.add(boss);
    }
    const intakeBadge = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.18), new THREE.MeshBasicMaterial({
      map: addTextPlane('AIR INTAKE', 'CHARGE AIR  |  42 °C', 512, 128), transparent: true, opacity: 0.65,
    }));
    intakeBadge.position.set(0.4, 3.81, -1.745);
    intake.add(intakeBadge);
    intake.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; this.register(o, 'intakeManifold'); } });
    air.add(intake);
    this.parts.airIntake = intake;

    // Cold-side charge pipe from intercooler to manifold.
    const coldPipe = new THREE.Group();
    const cp = tubeFromPoints([
      V(4.35, 2.0, -2.2), V(4.1, 2.05, -2.55), V(3.5, 2.2, -2.3), V(2.9, 2.65, -2.05),
      V(2.45, 3.15, -1.86), V(2.25, 3.55, -1.7), V(2.18, 3.7, -1.5),
    ], 0.16, M.aluMachined, { segments: 84, radialSegments: 14 });
    coldPipe.add(cp);
    this.register(cp, 'intakeManifold');
    for (const p of [V(4.35, 2.0, -2.2), V(2.24, 3.62, -1.72)]) {
      const coupler = new THREE.Mesh(new THREE.CylinderGeometry(0.185, 0.185, 0.14, 24), M.hose);
      coupler.position.copy(p);
      coupler.rotation.x = Math.PI / 2;
      coldPipe.add(coupler);
    }
    air.add(coldPipe);
    this.parts.coldPipe = coldPipe;

    // Exhaust manifold on the hot side (+Z).
    const exhaust = new THREE.Group();
    const collector = V(-1.55, 2.45, 1.75);
    for (let i = 0; i < 4; i++) {
      const x = CYL_X[i] + 0.185;
      const runner = tubeFromPoints([
        V(x, 3.62, 1.17), V(x, 3.58, 1.35), V(x, 3.25, 1.55), V(x * 0.72 + collector.x * 0.28, 2.85, 1.72),
        V(collector.x, collector.y, collector.z),
      ], 0.155, M.exhaustCast, { segments: 40, radialSegments: 12 });
      exhaust.add(runner);
      this.register(runner, 'exhaustManifold');
      const flange = new THREE.Mesh(roundedBox(0.42, 0.4, 0.12, 0.035), M.exhaustCast);
      flange.position.set(x, 3.6, 1.18);
      exhaust.add(flange);
      this.register(flange, 'exhaustManifold');
    }
    const collectorBody = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.33, 0.65, 24), M.exhaustCast);
    collectorBody.rotation.x = Math.PI / 2;
    collectorBody.position.set(collector.x, collector.y, collector.z + 0.2);
    exhaust.add(collectorBody);
    this.register(collectorBody, 'exhaustManifold');
    // Punched stainless heat shield.
    const shield = new THREE.Mesh(roundedBox(3.32, 0.035, 0.66, 0.014), M.steelDark);
    shield.position.set(0.62, 3.52, 1.48);
    shield.rotation.x = 0.15;
    exhaust.add(shield);
    this.register(shield, 'exhaustManifold');
    for (let i = 0; i < 10; i++) {
      const hole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.06, 10), M.blackOxide);
      hole.position.set(-0.95 + i * 0.35, 3.525, 1.48);
      hole.rotation.x = Math.PI / 2;
      exhaust.add(hole);
      this.register(hole, 'exhaustManifold');
    }
    // Heat-shield standoffs.
    for (const x of [-0.8, 0.1, 1.0, 1.9]) {
      const standoff = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.22, 8), M.polishedSteel);
      standoff.position.set(x, 3.38, 1.4);
      standoff.rotation.z = 0.2;
      exhaust.add(standoff);
      this.register(standoff, 'exhaustManifold');
    }
    exhaust.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    air.add(exhaust);
    this.parts.airExhaust = exhaust;

    // Turbocharger with visible compressor and turbine wheels.
    const turbo = new THREE.Group();
    turbo.name = 'VNT Turbocharger';
    const cy = 2.35;
    const cz = 2.08;
    const cx = -1.48;
    const central = new THREE.Mesh(new THREE.CylinderGeometry(0.23, 0.23, 1.35, 28), M.aluCast);
    central.rotation.z = Math.PI / 2;
    central.position.set(cx, cy, cz);
    turbo.add(central);
    this.register(central, 'turbo');
    for (const x of [cx - 0.72, cx + 0.72]) {
      const clamp = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.035, 8, 28), M.steelDark);
      clamp.rotation.y = Math.PI / 2;
      clamp.position.set(x, cy, cz);
      turbo.add(clamp);
      this.register(clamp, 'turbo');
    }
    const compHousing = voluteGroup(M.turboAlu, { radius: 0.42, tube: 0.18, arc: Math.PI * 1.7, rotation: 0.4 });
    compHousing.position.set(cx + 0.7, cy, cz);
    turbo.add(compHousing);
    compHousing.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; this.register(o, 'turbo'); } });
    const turbHousing = voluteGroup(M.turboHot, { radius: 0.4, tube: 0.17, arc: Math.PI * 1.65, rotation: 2.2 });
    turbHousing.position.set(cx - 0.7, cy, cz);
    turbo.add(turbHousing);
    turbHousing.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; this.register(o, 'turbo'); } });
    // Compressor inlet and outlet necks.
    const inletNeck = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.28, 0.32, 24), M.turboAlu);
    inletNeck.rotation.z = Math.PI / 2;
    inletNeck.position.set(cx + 1.15, cy, cz);
    turbo.add(inletNeck);
    this.register(inletNeck, 'turbo');
    const inletDark = new THREE.Mesh(new THREE.CircleGeometry(0.195, 28), M.blackOxide);
    inletDark.rotation.y = Math.PI / 2;
    inletDark.position.set(cx + 1.315, cy, cz);
    turbo.add(inletDark);
    this.register(inletDark, 'turbo');
    const inletLip = new THREE.Mesh(new THREE.TorusGeometry(0.225, 0.025, 8, 32), M.polishedSteel);
    inletLip.rotation.y = Math.PI / 2;
    inletLip.position.set(cx + 1.32, cy, cz);
    turbo.add(inletLip);
    this.register(inletLip, 'turbo');
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const screw = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.045, 6), M.steelDark);
      screw.rotation.z = Math.PI / 2;
      screw.position.set(cx + 1.13, cy + Math.cos(a) * 0.31, cz + Math.sin(a) * 0.31);
      turbo.add(screw);
      this.register(screw, 'turbo');
    }
    const outletNeck = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.2, 0.45, 20), M.turboAlu);
    outletNeck.position.set(cx + 0.75, cy + 0.62, cz + 0.18);
    outletNeck.rotation.z = 0.2;
    turbo.add(outletNeck);
    this.register(outletNeck, 'turbo');
    // Compressor wheel.
    const compWheel = new THREE.Group();
    compWheel.position.set(cx + 0.72, cy, cz);
    const cHub = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.13, 0.28, 18), M.polishedSteel);
    cHub.rotation.z = Math.PI / 2;
    compWheel.add(cHub);
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2;
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.25, 0.075), M.polishedSteel);
      blade.position.set(0, Math.cos(a) * 0.17, Math.sin(a) * 0.17);
      blade.rotation.x = a + 0.6;
      blade.rotation.z = 0.55;
      compWheel.add(blade);
    }
    compWheel.traverse(o => { if (o.isMesh) { o.castShadow = true; this.register(o, 'turbo'); } });
    turbo.add(compWheel);
    this.dynamic.compWheel = compWheel;
    // Turbine wheel.
    const turbWheel = new THREE.Group();
    turbWheel.position.set(cx - 0.72, cy, cz);
    const tHub = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.23, 16), M.turboHot);
    tHub.rotation.z = Math.PI / 2;
    turbWheel.add(tHub);
    for (let i = 0; i < 11; i++) {
      const a = (i / 11) * Math.PI * 2;
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.25, 0.08), M.turboHot);
      blade.position.set(0, Math.cos(a) * 0.16, Math.sin(a) * 0.16);
      blade.rotation.x = a - 0.35;
      blade.rotation.z = -0.35;
      turbWheel.add(blade);
    }
    turbWheel.traverse(o => { if (o.isMesh) this.register(o, 'turbo'); });
    turbo.add(turbWheel);
    this.dynamic.turbWheel = turbWheel;

    // Wastegate actuator canister and rod.
    const actuator = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.32, 18), M.aluMachined);
    actuator.rotation.z = Math.PI / 2;
    actuator.position.set(cx - 0.38, cy + 0.72, cz + 0.4);
    turbo.add(actuator);
    this.register(actuator, 'turbo');
    const actuatorRod = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.55, 8), M.polishedSteel);
    actuatorRod.rotation.z = Math.PI / 2;
    actuatorRod.position.set(cx - 0.55, cy + 0.55, cz + 0.32);
    turbo.add(actuatorRod);
    this.register(actuatorRod, 'turbo');
    const oilBanjo = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.28, 12), M.copper);
    oilBanjo.position.set(cx, cy + 0.34, cz - 0.05);
    turbo.add(oilBanjo);
    this.register(oilBanjo, 'oilGallery');
    turbo.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    air.add(turbo);
    this.parts.turbo = turbo;

    // Boost pipe from compressor to intercooler, routed above the exhaust side.
    const boostPipe = tubeFromPoints([
      V(cx + 0.85, cy + 0.64, cz + 0.29), V(cx + 0.55, 3.02, cz + 0.48), V(0.15, 3.06, 2.68),
      V(2.35, 3.0, 2.65), V(3.95, 2.92, 2.34), V(4.5, 2.77, 2.15), V(4.72, 2.55, 2.1),
      V(4.7, 2.3, 2.12), V(4.55, 2.1, 2.15),
    ], 0.145, M.aluMachined, { segments: 110, radialSegments: 14 });
    const boostAssembly = new THREE.Group();
    boostAssembly.add(boostPipe);
    this.register(boostPipe, 'intakeManifold');
    for (const p of [V(cx + 0.5, 3.02, cz + 0.48), V(4.55, 2.1, 2.15)]) {
      const clamp = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.033, 8, 24), M.blackOxide);
      clamp.position.copy(p);
      clamp.rotation.x = Math.PI / 2;
      boostAssembly.add(clamp);
      this.register(clamp, 'intakeManifold');
    }
    air.add(boostAssembly);
    this.parts.boostAssembly = boostAssembly;

    // Intercooler at the front, offset to the cold side.
    const ic = new THREE.Group();
    const icX = 4.82;
    const icZ = -1.27;
    const icCenterY = 2.03;
    const icH = 1.72;
    const icW = 1.68;
    const icCore = new THREE.Mesh(roundedBox(0.34, icH, icW, 0.05), M.radiatorAlu);
    icCore.position.set(icX, icCenterY, icZ);
    ic.add(icCore);
    this.register(icCore, 'intercooler', { shell: true });
    for (let i = 0; i < 14; i++) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.035, icW * 0.93), M.aluMachined);
      bar.position.set(icX, icCenterY - icH * 0.44 + (i / 13) * icH * 0.88, icZ);
      ic.add(bar);
      this.register(bar, 'intercooler');
    }
    for (const s of [-1, 1]) {
      const tank = new THREE.Mesh(roundedBox(0.4, 0.3, icW + 0.08, 0.06), s === 1 ? M.aluDark : M.aluCast);
      tank.position.set(icX, icCenterY + s * (icH / 2 + 0.16), icZ);
      ic.add(tank);
      this.register(tank, 'intercooler');
      const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.15, 0.35, 18), M.aluMachined);
      neck.position.set(icX, icCenterY + s * (icH / 2 + 0.35), icZ + (s === 1 ? 0.25 : -0.25));
      neck.rotation.x = Math.PI / 2;
      ic.add(neck);
      this.register(neck, 'intercooler');
    }
    ic.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    const icBadge = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.2), new THREE.MeshBasicMaterial({
      map: addTextPlane('INTERCOOLER', 'CHARGE AIR  ·  42 °C', 512, 128),
      transparent: true, opacity: 0.65, depthWrite: false,
    }));
    icBadge.rotation.y = Math.PI / 2;
    icBadge.position.set(icX + 0.24, 2.98, icZ);
    ic.add(icBadge);
    this.register(icBadge, 'intercooler');
    air.add(ic);
    this.parts.airIntercooler = ic;

    // Airbox and intake snorkel on the cold side rear.
    const airbox = new THREE.Group();
    const airboxBody = new THREE.Mesh(roundedBox(0.88, 0.66, 0.68, 0.12), M.plastic);
    airboxBody.position.set(-2.35, 3.15, -1.75);
    airbox.add(airboxBody);
    const airboxLid = new THREE.Mesh(roundedBox(0.76, 0.08, 0.58, 0.04), M.aluDark);
    airboxLid.position.set(-2.35, 3.51, -1.75);
    airbox.add(airboxLid);
    for (let i = 0; i < 3; i++) {
      const clip = new THREE.Mesh(roundedBox(0.06, 0.12, 0.12, 0.015), M.polishedSteel);
      clip.position.set(-2.7 + i * 0.35, 3.47, -1.45);
      airbox.add(clip);
    }
    const airboxOutlet = tubeFromPoints([
      V(-2.72, 3.1, -1.48), V(-2.95, 2.85, -0.6), V(-3.02, 2.65, 0.3), V(-2.9, 2.5, 1.2),
      V(-2.5, 2.42, 1.9),
    ], 0.11, M.hose, { segments: 50, radialSegments: 10 });
    airbox.add(airboxOutlet);
    airbox.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; this.register(o, 'intakeManifold'); } });
    air.add(airbox);
    this.parts.airbox = airbox;
  }

  buildAccessories() {
    const M = this.M;
    const acc = new THREE.Group();
    acc.name = 'Accessories';
    this.root.add(acc);
    this.parts.accessories = acc;

    // Alternator, front right.
    const alternator = new THREE.Group();
    const altX = 3.0;
    const altBody = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.82, 30, 1), M.aluCast);
    altBody.rotation.z = Math.PI / 2;
    altBody.position.set(altX, 1.02, 1.42);
    alternator.add(altBody);
    for (let i = 0; i < 4; i++) {
      const rib = new THREE.Mesh(new THREE.TorusGeometry(0.305, 0.018, 6, 28), M.aluDark);
      rib.rotation.y = Math.PI / 2;
      rib.position.set(altX - 0.3 + i * 0.2, 1.02, 1.42);
      alternator.add(rib);
    }
    const altRear = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.3, 0.16, 26), M.plastic);
    altRear.rotation.z = Math.PI / 2;
    altRear.position.set(altX - 0.48, 1.02, 1.42);
    alternator.add(altRear);
    const altFront = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.26, 0.22, 26), M.aluCast);
    altFront.rotation.z = Math.PI / 2;
    altFront.position.set(altX + 0.48, 1.02, 1.42);
    alternator.add(altFront);
    const altBracket = new THREE.Mesh(roundedBox(0.48, 0.16, 0.65, 0.04), M.castIronDark);
    altBracket.position.set(altX, 0.68, 1.2);
    alternator.add(altBracket);
    alternator.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; this.register(o, 'alternator'); } });
    acc.add(alternator);

    // Starter motor at the flywheel side.
    const starter = new THREE.Group();
    const stBody = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.95, 28), M.steelDark);
    stBody.rotation.z = Math.PI / 2;
    stBody.position.set(-2.35, -0.45, -1.18);
    starter.add(stBody);
    const stNose = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.24, 0.36, 24), M.aluCast);
    stNose.rotation.z = Math.PI / 2;
    stNose.position.set(-2.9, -0.45, -1.18);
    starter.add(stNose);
    const stSolenoid = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.5, 20), M.aluCast);
    stSolenoid.rotation.x = Math.PI / 2;
    stSolenoid.position.set(-2.45, 0.0, -1.0);
    starter.add(stSolenoid);
    const terminal = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.16, 10), M.copper);
    terminal.position.set(-2.45, 0.13, -0.78);
    starter.add(terminal);
    const stGear = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.12, 20, 1), M.gearSteel);
    stGear.rotation.z = Math.PI / 2;
    stGear.position.set(-3.05, -0.45, -1.18);
    starter.add(stGear);
    const stBracket = new THREE.Mesh(roundedBox(0.6, 0.16, 0.6, 0.04), M.castIronDark);
    stBracket.position.set(-2.3, -0.15, -1.05);
    starter.add(stBracket);
    starter.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; this.register(o, 'starter'); } });
    acc.add(starter);

    // ECU on the cold side, with a proper connector block and harness.
    const ecu = new THREE.Group();
    const ecuBody = new THREE.Mesh(roundedBox(0.95, 0.52, 0.32, 0.08), M.aluDark);
    ecuBody.position.set(-2.33, 1.46, -1.24);
    ecu.add(ecuBody);
    const ecuLid = new THREE.Mesh(roundedBox(0.86, 0.06, 0.27, 0.02), M.aluMachined);
    ecuLid.position.set(-2.33, 1.74, -1.24);
    ecu.add(ecuLid);
    for (let i = 0; i < 3; i++) {
      const plug = new THREE.Mesh(roundedBox(0.2, 0.1, 0.12, 0.02), M.plastic);
      plug.position.set(-2.65 + i * 0.3, 1.41, -1.41);
      ecu.add(plug);
    }
    const harness = tubeFromPoints([
      V(-2.35, 1.28, -1.32), V(-2.0, 1.0, -1.45), V(-1.2, 1.15, -1.55), V(-0.35, 1.8, -1.6),
      V(0.5, 2.3, -1.6), V(1.3, 2.35, -1.55), V(1.6, 2.75, -1.6),
    ], 0.055, M.rubber, { segments: 64, radialSegments: 9 });
    ecu.add(harness);
    ecu.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; this.register(o, 'ecu'); } });
    acc.add(ecu);

    // Small sensors and plugs dotted around the block.
    for (let i = 0; i < 4; i++) {
      const sensor = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.17, 12), M.sensor);
      sensor.position.set(CYL_X[i] + 0.3, 3.32, -1.05);
      acc.add(sensor);
      this.register(sensor, 'block');
    }
    const crankSensor = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.18, 12), M.sensor);
    crankSensor.position.set(2.86, 0.18, -0.94);
    acc.add(crankSensor);
    this.register(crankSensor, 'block');
    const sensorCable = tubeFromPoints([
      V(2.86, 0.18, -0.86), V(2.75, 0.5, -1.2), V(2.65, 1.1, -1.45), V(2.2, 1.4, -1.4),
    ], 0.024, M.wiring, { segments: 30, radialSegments: 6 });
    acc.add(sensorCable);
    this.register(sensorCable, 'block');
  }

  buildEnginePlate() {
    // The metal identification plaque is built with the long block.
  }

  // The fluid network curves are assembled after systems so anchors are known.
  buildFluidCurves() {
    this.fluid = {
      coolant: {},
      oil: {},
    };
    // Internal network: block jacket -> head -> thermostat -> radiator -> pump.
    this.fluid.coolant.jacket = curveFromPoints([
      V(2.69, 1.25, 0.65), V(2.3, 1.35, 0.78), V(1.55, 1.65, 0.8), V(0.8, 2.1, 0.78),
      V(0.15, 2.85, 0.68), V(-0.35, 3.16, 0.42), V(-1.0, 3.16, 0.1), V(-1.75, 3.13, -0.1),
      V(-2.3, 2.85, -0.25), V(-2.6, 1.5, 0.18), V(-2.15, 1.2, 0.62), V(-1.25, 1.3, 0.76),
      V(-0.4, 1.55, 0.8),
    ], { tension: 0.4 });
    this.fluid.coolant.head = curveFromPoints([
      V(-2.5, 3.4, -0.55), V(-1.5, 3.85, -0.35), V(-0.55, 3.78, -0.47), V(0.55, 3.78, -0.47),
      V(1.6, 3.72, -0.55), V(2.5, 3.72, -0.62), V(3.02, 3.86, -0.94),
    ], { tension: 0.35 });
    this.fluid.coolant.upperHose = curveFromPoints([
      V(3.08, 3.94, -0.98), V(3.48, 4.14, -1.15), V(3.95, 4.05, -0.2), V(4.28, 3.85, 0.72),
      V(4.52, 3.58, 1.1), V(4.65, 3.3, 1.15),
    ], { tension: 0.45 });
    this.fluid.coolant.radiator = curveFromPoints([
      V(4.7, 3.22, 1.15), V(4.72, 2.2, 1.15), V(4.72, 1.1, 1.15), V(4.6, 0.54, 1.05),
      V(4.18, 0.35, 0.88), V(3.55, 0.55, 0.2), V(3.42, 1.4, -0.35), V(3.45, 2.08, -0.5),
    ], { tension: 0.4 });
    this.fluid.coolant.return = curveFromPoints([
      V(3.43, 2.25, -0.52), V(2.9, 2.4, -0.72), V(2.2, 2.05, -0.7), V(1.6, 1.6, -0.65),
    ], { tension: 0.35 });

    // Oil: pickup -> pump -> filter -> cooler -> gallery -> head -> return.
    this.fluid.oil.pickup = curveFromPoints([
      V(1.02, -1.72, 0.36), V(1.12, -1.45, 0.34), V(1.2, -1.13, 0.32), V(1.48, -1.0, 0.28),
      V(1.7, -0.9, 0.2), V(1.83, -0.55, 0.12),
    ], { tension: 0.3 });
    this.fluid.oil.pump = curveFromPoints([
      V(1.83, -0.55, 0.18), V(2.14, -0.3, 0.36), V(2.4, 0.08, 0.82), V(2.52, 0.4, 1.16),
      V(2.5, 0.6, 1.38),
    ], { tension: 0.42 });
    this.fluid.oil.filter = curveFromPoints([
      V(2.55, 0.58, 1.44), V(2.55, 0.82, 1.58), V(2.34, 1.02, 1.48), V(1.98, 0.93, 1.36),
      V(1.66, 0.8, 1.27), V(1.32, 0.75, 1.27),
    ], { tension: 0.34 });
    this.fluid.oil.filterIn = curveFromPoints([
      V(2.32, 0.12, 1.2), V(2.4, 0.28, 1.4), V(2.45, 0.45, 1.5),
    ], { tension: 0.25 });
    this.fluid.oil.cooler = curveFromPoints([
      V(1.25, 0.76, 1.25), V(0.9, 0.62, 1.14), V(0.45, 0.56, 1.06), V(0.05, 0.65, 1.02),
      V(-0.32, 0.82, 1.02), V(-0.52, 1.1, 1.0),
    ], { tension: 0.3 });
    this.fluid.oil.gallery = curveFromPoints([
      V(-0.52, 1.1, 1.0), V(-1.1, 1.2, 1.01), V(-1.8, 1.2, 0.99), V(-2.48, 1.1, 0.8),
      V(-2.55, 2.2, 0.52), V(-2.55, 3.2, 0.22), V(-2.5, 3.8, 0.1),
    ], { tension: 0.35 });
    this.fluid.oil.head = curveFromPoints([
      V(-2.5, 4.05, 0.1), V(-1.8, 4.7, 0.16), V(-0.9, 5.0, 0.25), V(0.2, 5.02, 0.35),
      V(1.2, 4.95, 0.3), V(2.2, 4.6, 0.4), V(2.65, 3.8, 0.5),
    ], { tension: 0.4 });
    this.fluid.oil.return = curveFromPoints([
      V(2.65, 3.7, 0.5), V(2.7, 3.1, 0.58), V(2.75, 2.0, 0.7), V(2.7, 0.8, 0.82),
      V(2.5, 0.1, 0.78), V(2.2, -0.65, 0.56), V(2.05, -1.28, 0.4), V(1.9, -1.52, 0.36),
    ], { tension: 0.36 });
  }
}
