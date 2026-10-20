// Four-stroke diesel simulation core.
// Geometry units: 1 scene unit = 100 mm.
// Crank angle domain: 0..720° CA. 0° = cylinder #1 compression TDC (firing TDC).

export const ENGINE = {
  bore: 105,
  stroke: 130,
  crankRadius: 0.65,
  rodLength: 2.2,
  cylinderSpacing: 1.34,
  compressionRatio: 17.5,
  firingOrder: [1, 3, 4, 2],
  cylinders: [
    { index: 0, x: 2.01, phase: 360, throw: 0 },
    { index: 1, x: 0.67, phase: 540, throw: Math.PI },
    { index: 2, x: -0.67, phase: 180, throw: Math.PI },
    { index: 3, x: -2.01, phase: 0, throw: 0 },
  ],
  intake: { open: 716, duration: 224, peakLift: 0.125 },
  exhaust: { open: 530, duration: 230, peakLift: 0.125 },
  valveClearance: 0.003,
  baseVisualScale: 0.026,
};

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const mod = (v, m) => ((v % m) + m) % m;

export const CRANK_DEG = (rad) => (rad * 180) / Math.PI;
export const RAD = (deg) => (deg * Math.PI) / 180;

export function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

// Returns progress 0..1 in a wrapped valve event window.
export function valveWindowProgress(cycle, open, duration) {
  const p = mod(cycle - open, 720);
  return p < duration ? p / duration : -1;
}

export function valveLiftFor(cycle, kind) {
  const spec = ENGINE[kind];
  const p = valveWindowProgress(cycle, spec.open, spec.duration);
  if (p < 0) return 0;
  // Smooth, low-acceleration cam profile: sin^2, with short seating ramps.
  const shaped = Math.sin(Math.PI * p) ** 2;
  const ramp = smoothstep(0, 0.035, p) * (1 - smoothstep(0.965, 1, p));
  return spec.peakLift * shaped * ramp;
}

export function cylinderCycleAngle(i, crankAngle) {
  return mod(crankAngle + ENGINE.cylinders[i].phase, 720);
}

export function pistonPinY(i, crankAngle) {
  const cyl = ENGINE.cylinders[i];
  const theta = RAD(crankAngle) + cyl.throw;
  const { crankRadius: r, rodLength: l } = ENGINE;
  return r * Math.cos(theta) + Math.sqrt(l * l - (r * Math.sin(theta)) ** 2);
}

export function pistonDisplacement(i, crankAngle) {
  // 0 mm at TDC, 130 mm at BDC.
  const y = pistonPinY(i, crankAngle);
  const tdc = ENGINE.crankRadius + ENGINE.rodLength;
  return (tdc - y) * 100;
}

const STROKES = [
  { cn: '进气', en: 'INTAKE', color: '#55b8d0', short: '吸气' },
  { cn: '压缩', en: 'COMPRESSION', color: '#d3a15d', short: '压缩' },
  { cn: '做功', en: 'POWER', color: '#ef7b45', short: '做功' },
  { cn: '排气', en: 'EXHAUST', color: '#8a939b', short: '排气' },
];

export function strokeInfo(cycle) {
  const c = mod(cycle, 720);
  const idx = Math.floor(c / 180);
  const local = c - idx * 180;
  return {
    index: idx,
    ...STROKES[idx],
    local,
    progress: local / 180,
    label: `${
      idx === 0 ? '进气下行' :
      idx === 1 ? '压缩上行' :
      idx === 2 ? '膨胀做功' : '排气上行'
    }`,
  };
}

export class EngineSimulation {
  constructor() {
    this.crankAngle = 660;
    this.rpmTarget = 850;
    this.rpm = 850;
    this.loadTarget = 46;
    this.load = 46;
    this.running = true;
    this.visualScale = ENGINE.baseVisualScale;
    this.time = 0;
    this.cycleCount = 0;
    this.cycleCounter = 0;
    this.waterTemp = 87.4;
    this.oilTemp = 94.2;
    this.oilPressure = 4.0;
    this.railPressure = 1410;
    this.boost = 0.38;
    this.turboRpm = 62_000;
    this.flowWater = 43;
    this.flowOil = 15.2;
    this.powerKw = 22;
    this.torqueNm = 250;
    this.horsepower = 0;
    this.combustion = [0, 0, 0, 0];
    this.injecting = [0, 0, 0, 0];
    this.waterFan = 0.42;
  }

  setRunning(v) {
    this.running = v;
  }

  toggleRunning() {
    this.running = !this.running;
    return this.running;
  }

  setRpm(v) {
    this.rpmTarget = clamp(v, 0, 2400);
  }

  setLoad(v) {
    this.loadTarget = clamp(v, 0, 100);
  }

  stepDegrees(deg = 30) {
    this.crankAngle = mod(this.crankAngle + deg, 720);
    this.injecting = ENGINE.cylinders.map((_, i) => {
      const c = cylinderCycleAngle(i, this.crankAngle);
      return c > 344 && c < 362 ? 1 : 0;
    });
  }

  reset() {
    this.crankAngle = 660;
    this.rpmTarget = 850;
    this.loadTarget = 46;
    this.running = true;
    this.waterTemp = 87.4;
    this.oilTemp = 94.2;
    this.cycleCounter = 0;
  }

  update(dt) {
    const safeDt = Math.min(dt, 0.06);
    this.time += safeDt;

    // First-order inertia for displayed actuator values.
    this.rpm = lerp(this.rpm, this.rpmTarget, 1 - Math.exp(-safeDt * 2.6));
    this.load = lerp(this.load, this.loadTarget, 1 - Math.exp(-safeDt * 1.8));

    const effectiveRpm = this.running ? this.rpm : 0;
    if (this.running) {
      const previous = this.crankAngle;
      this.crankAngle = mod(this.crankAngle + effectiveRpm * 6 * safeDt * this.visualScale, 720);
      if (this.crankAngle < previous) this.cycleCounter += 1;
    }
    this.cycleCount = this.cycleCounter;

    const speedFactor = effectiveRpm / 2400;
    const loadFactor = this.load / 100;
    const thermalTarget = 81.5 + loadFactor * 11.5 + speedFactor * 2.2;
    this.waterTemp = lerp(this.waterTemp, thermalTarget, 1 - Math.exp(-safeDt * 0.22));
    this.oilTemp = lerp(this.oilTemp, this.waterTemp + 7.5 + loadFactor * 4.2, 1 - Math.exp(-safeDt * 0.18));

    const flowFactor = effectiveRpm / 850 * (0.55 + 0.45 * loadFactor);
    this.flowWater = Math.max(0, 43 * flowFactor);
    this.flowOil = Math.max(0, 14.8 * flowFactor);
    this.oilPressure = effectiveRpm < 20
      ? 0.24
      : clamp(1.35 + (effectiveRpm / 2200) * 2.9 - Math.max(0, this.oilTemp - 105) * 0.014, 0.5, 5.2);
    this.railPressure = effectiveRpm < 20 ? 0 : 620 + loadFactor * 770 + speedFactor * 220;

    const spool = smoothstep(750, 2150, effectiveRpm);
    this.boost = Math.max(0, (spool * (0.5 + loadFactor * 1.15) * 1.6) - 0.06);
    this.turboRpm = effectiveRpm < 20 ? 0 : 25_000 + spool * (42_000 + loadFactor * 82_000);
    this.waterFan = effectiveRpm < 20 ? 0 : clamp(0.22 + (this.waterTemp - 82) / 22 + loadFactor * 0.24, 0, 1);

    // Brake torque follows a broad diesel plateau; shaft power remains
    // thermodynamically consistent with torque × angular velocity.
    const rpmNow = Math.max(0, effectiveRpm);
    const torqueShape = 326 + 56 * Math.exp(-(((rpmNow - 1600) / 620) ** 2)) - 28 * Math.exp(-(((rpmNow - 2360) / 500) ** 2));
    const loadTorqueFactor = 0.08 + 0.92 * loadFactor;
    this.torqueNm = rpmNow < 20 ? 0 : Math.round(torqueShape * loadTorqueFactor);
    this.powerKw = rpmNow < 20 ? 0 : Math.round((this.torqueNm * rpmNow * Math.PI * 2 / 60 / 1000) * 10) / 10;
    this.horsepower = Math.round((this.powerKw / 0.7457) * 10) / 10;

    this.injecting = ENGINE.cylinders.map((_, i) => {
      const c = cylinderCycleAngle(i, this.crankAngle);
      return c > 344 && c < 362 && effectiveRpm > 15 ? 1 : 0;
    });
    this.combustion = ENGINE.cylinders.map((_, i) => {
      const c = cylinderCycleAngle(i, this.crankAngle);
      if (c < 358 || c > 470) return 0;
      const t = (c - 358) / 112;
      return effectiveRpm > 15 ? Math.exp(-t * 3.2) * (1 - t) : 0;
    });

    return safeDt;
  }

  cylinderData(i) {
    const cycle = cylinderCycleAngle(i, this.crankAngle);
    const stroke = strokeInfo(cycle);
    const crank = this.crankAngle;
    const intakeLift = valveLiftFor(cycle, 'intake');
    const exhaustLift = valveLiftFor(cycle, 'exhaust');
    return {
      cycle, stroke,
      intakeLift, exhaustLift,
      displacement: pistonDisplacement(i, crank),
      pistonY: pistonPinY(i, crank),
      flame: this.combustion[i],
      injecting: this.injecting[i],
      rpm: this.running ? this.rpm : 0,
    };
  }

  valveState(kind, cylinder = 0) {
    const c = cylinderCycleAngle(cylinder, this.crankAngle);
    const lift = valveLiftFor(c, kind);
    const spec = ENGINE[kind];
    const p = valveWindowProgress(c, spec.open, spec.duration);
    if (lift < 0.0007) {
      return p >= 0 ? '落座 / 开启前间隙' : '关闭 · 气门间隙 0.30 mm';
    }
    const opening = p < 0.5;
    return `${opening ? '开启中' : '回位中'} · 升程 ${(lift * 100).toFixed(1)} mm`;
  }

  liveState(part) {
    if (!part) return '';
    const id = part.id || '';
    const base = id.replace(/-\d+$/, '');
    const idx = Number((id.match(/-(\d+)$/) || [])[1] || 0);
    const cyl = this.cylinderData(idx);
    const runningText = this.running && this.rpm > 10 ? `${Math.round(this.rpm)} rpm · ${cyl.stroke.cn}冲程 ${cyl.cycle.toFixed(0)}°` : '停机 · 0 rpm';

    switch (base) {
      case 'piston':
        return `${cyl.stroke.label} · 距上止点 ${cyl.displacement.toFixed(1)} mm · 速度 ${this.pistonSpeed(idx).toFixed(2)} m/s`;
      case 'rings':
        return `随活塞${cyl.stroke.label} · 环岸温度 ${Math.round(165 + cyl.stroke.index * 30)} °C`;
      case 'pin':
        return `全浮式 · 摆角 ${(Math.sin(RAD(cyl.cycle)) * 7.2).toFixed(1)}° · ${runningText}`;
      case 'rod':
        return `摆角 ${(Math.abs(Math.sin(RAD(this.crankAngle + ENGINE.cylinders[idx].throw)) * 0.28) * 57.3).toFixed(1)}° · 承受${cyl.stroke.index === 2 ? '爆发压力' : '惯性拉力'}`;
      case 'rodBearing':
        return `动压油膜 ${(18 + this.oilPressure * 2.5).toFixed(0)} μm · ${this.rpm > 10 ? '供油正常' : '预润滑'}`;
      case 'intakeValve':
        return this.valveState('intake', idx);
      case 'exhaustValve':
        return this.valveState('exhaust', idx);
      case 'valveSpring': {
        const springLift = Math.max(cyl.intakeLift, cyl.exhaustLift);
        return `压缩量 ${(springLift * 100).toFixed(1)} mm · ${this.rpm > 10 ? '无飞脱' : '静置'}`;
      }
      case 'injector':
        return cyl.injecting ? `主喷射中 · 轨压 ${this.railPressure.toFixed(0)} bar` : `待喷 · 轨压 ${this.railPressure.toFixed(0)} bar`;
      case 'crank':
        return `${runningText} · 输出扭矩 ${this.torqueNm} Nm`;
      case 'mainJournal':
        return `曲轴转角 ${this.crankAngle.toFixed(1)}° · 油膜压力 ${(16 + this.load * 0.16).toFixed(0)} MPa`;
      case 'rodJournal':
        return `曲柄转角 ${(this.crankAngle + ENGINE.cylinders[idx].throw * 57.3).toFixed(0)}° · 瞬时载荷 ${(18 + this.combustion[idx] * 72 + this.load * 0.32).toFixed(0)} kN`;
      case 'counterweight':
        return `当前离心力 ${(Math.pow(this.rpm / 1000, 2) * 13.4).toFixed(1)} kN · 动态平衡`;
      case 'flywheel':
        return `${this.running ? Math.round(this.rpm) : 0} rpm · 线速度 ${(this.rpm / 60 * Math.PI * 0.28).toFixed(1)} m/s`;
      case 'camshaft':
        return `${this.running && this.rpm > 10 ? Math.round(this.rpm / 2) : 0} rpm（曲轴½）· 相位 ${(this.crankAngle / 2).toFixed(1)}°`;
      case 'lifter':
      case 'pushrod':
      case 'rocker':
        return this.rpm > 10 ? `配气机构工作中 · 循环 ${cyl.cycle.toFixed(0)}° CA` : '停机 · 弹簧预紧';
      case 'turbo':
        return this.rpm > 10 ? `${Math.round(this.boost * 1000)} mbar 增压 · ${Math.round(this.turboRpm / 1000) * 1000} rpm` : '静止 · 无增压';
      case 'commonRail':
        return `轨压 ${this.railPressure.toFixed(0)} bar · 负荷 ${Math.round(this.load)} %`;
      case 'fuelPump':
        return this.rpm > 10 ? `计量阀开度 ${(12 + this.load * 0.28).toFixed(0)} % · ${(this.railPressure * 0.72).toFixed(0)} bar` : '停机 · 计量阀关闭';
      case 'fuelFilter':
        return this.rpm > 10 ? `燃油流量 ${(this.load * 0.035 + 0.8).toFixed(1)} L/min · 压差 0.14 bar` : '静止';
      case 'waterPump':
        return this.rpm > 10 ? `流量 ${this.flowWater.toFixed(0)} L/min · 扬程 ${(0.8 + this.flowWater / 140).toFixed(1)} m` : '静止';
      case 'waterJacket':
        return `冷却液 ${this.waterTemp.toFixed(1)} °C · 流量 ${this.flowWater.toFixed(0)} L/min`;
      case 'thermostat':
        return `开度 ${Math.round(smoothstep(82, 95, this.waterTemp) * 100)} % · 出口 ${this.waterTemp.toFixed(1)} °C`;
      case 'radiator':
        return this.rpm > 10 ? `散热 ${(18 + this.flowWater * 0.46).toFixed(0)} kW · 风扇 ${Math.round(this.waterFan * 100)} %` : '自然对流 · 无强制散热';
      case 'coolantHose':
        return `流速 ${(this.flowWater / 60 / 11.4 * 1000).toFixed(1)} dm/s · ${this.waterTemp.toFixed(1)} °C`;
      case 'fan':
        return this.rpm > 10 ? `转速 ${Math.round(this.waterFan * 2000)} rpm · 占空比 ${Math.round(this.waterFan * 100)} %` : '静止';
      case 'oilPump':
        return this.rpm > 10 ? `供油 ${this.flowOil.toFixed(1)} L/min · ${this.oilPressure.toFixed(2)} bar` : '停机 · 油道保压 0.24 bar';
      case 'oilFilter':
        return `压差 ${(0.12 + this.flowOil * 0.012).toFixed(2)} bar · 油温 ${this.oilTemp.toFixed(0)} °C`;
      case 'oilGallery':
        return `主油道压力 ${this.oilPressure.toFixed(2)} bar · 温度 ${this.oilTemp.toFixed(0)} °C`;
      case 'oilCooler':
        return `进油 ${(this.oilTemp + 9).toFixed(0)} °C → 出油 ${this.oilTemp.toFixed(0)} °C`;
      case 'dipstick':
        return `液位 72 % · 油温 ${this.oilTemp.toFixed(0)} °C · 油质正常`;
      case 'intakeManifold':
        return `歧管绝对压力 ${(1 + this.boost).toFixed(2)} bar · 进气 42 °C`;
      case 'exhaustManifold':
        return `排气温度 ${Math.round(280 + this.load * 4.5)} °C · 能量回收中`;
      case 'intercooler':
        return this.rpm > 10 ? `出口空气 42 °C · 压降 0.08 bar` : '无流动';
      case 'alternator':
        return this.rpm > 10 ? `输出 ${(13.9).toFixed(1)} V · ${Math.round(18 + this.rpm * 0.045)} A` : '静止 · 蓄电池供电';
      case 'starter':
        return this.rpm > 10 ? '待机 · 驱动齿轮已回位' : '待机 · 未啮合';
      case 'ecu':
        return `目标转速 ${Math.round(this.rpmTarget)} rpm · 负荷 ${Math.round(this.load)} % · 主喷 ${(8 + this.load * 0.28).toFixed(1)} mg`;
      case 'fuelLine':
        return `${this.railPressure.toFixed(0)} bar 脉动压力 · 4 路等长`;
      case 'camGear':
        return `啮合中 · 曲轴 ${Math.round(this.running ? this.rpm : 0)} rpm / 凸轮 ${Math.round(this.running ? this.rpm / 2 : 0)} rpm`;
      case 'mainBearing':
        return `油膜承载 ${(this.load * 0.45 + 14).toFixed(0)} MPa · 供油 ${this.oilPressure.toFixed(1)} bar`;
      case 'block':
        return `缸体温度 ${(this.waterTemp + 13).toFixed(0)} °C · 曲轴箱压力 -0.2 kPa`;
      case 'head':
        return `火力面 ${(this.waterTemp + 121).toFixed(0)} °C · 冷却液出口 ${this.waterTemp.toFixed(0)} °C`;
      case 'pan':
        return `机油液位 72 % · 油温 ${this.oilTemp.toFixed(0)} °C`;
      case 'headBolt':
        return `预紧力 66 kN · 无松弛`;
      case 'gasket':
        return `密封燃气 ${(18 + this.load * 1.6).toFixed(0)} bar · 完好`;
      case 'timingCover':
        return `齿轮油温 ${(this.oilTemp + 2).toFixed(0)} °C · 正时相位锁定`;
      case 'flywheelHousing':
        return `壳体温度 ${(this.waterTemp * 0.76).toFixed(0)} °C · 同轴度 0.06 mm`;
      case 'timingGears':
        return `曲轴 ${Math.round(this.running ? this.rpm : 0)} rpm · 凸轮 ${Math.round(this.running ? this.rpm / 2 : 0)} rpm`;
      case 'stand':
        return `静态 · 承载 ${(580 + this.rpm * 0.04).toFixed(0)} kg`;
      default:
        return part.group === 'fixed' ? `固定部件 · 工作正常` : '工作正常';
    }
  }

  pistonSpeed(i) {
    const dt = 0.001;
    const d = pistonPinY(i, this.crankAngle + 0.1) - pistonPinY(i, this.crankAngle - 0.1);
    // mm per 0.2° CA; convert to m/s at instantaneous rpm and slow-motion factor removed.
    const mmPerRev = d * (360 / 0.2) * 100;
    return Math.abs(mmPerRev) * (this.rpm / 60) / 1000;
  }
}

export { STROKES };
