/**
 * Project IRIS - EKF Simulator Main Entry Point.
 * LEO (6-state, range/range-rate) and Attitude-2D (4-state, position) scenarios.
 * Plot units: km. Internal filter units: m, m/s, s.
 */

import { EKF } from './filter/ekf';
import type { Matrix } from './types';
import { generateSyntheticPass, type LoadedData } from './data/io';
import { initControls, setRunButtonLabel, logMessage, type Scenario } from './ui/controls';
import { initPlot, updatePlot, startAnimation, stopAnimation, isAnimationRunning, clearPlot, resizePlot, type PlotData } from './ui/plot';

// --- State ---

let scenario: Scenario = 'leo';
let loadedData: LoadedData | null = null;
let dataIdx = 0;
let ekf: EKF | null = null;
let kfState: number[] | null = null; // naive dead-reckoning baseline [px,py,pz,vx,vy,vz] or 2D
let currentDt = 1;
let qVar = 1e-6;
let rStd = 10;
let lastEstimateKm: [number, number] = [0, 0];
let lastTruthKm: [number, number] = [0, 0];

const M_TO_KM = 1 / 1000;

/** Earth gravitational parameter (m^3/s^2) and ground-station ECI position (m). */
const MU_EARTH = 3.986e14;
const GROUND_STATION: [number, number, number] = [6378.137 * 1000, 0, 0];

/** Two-body acceleration at position r (m, m/s^2). */
function twoBodyAccel(rx: number, ry: number, rz: number): [number, number, number] {
  const rho = Math.max(1e-6, Math.sqrt(rx * rx + ry * ry + rz * rz));
  const k = -MU_EARTH / (rho * rho * rho);
  return [k * rx, k * ry, k * rz];
}

/** Semi-implicit Euler propagation with 1 s substeps (state as plain array). */
function propagateTwoBody(s: number[], dt: number): number[] {
  let [rx, ry, rz, vx, vy, vz] = s;
  const n = Math.max(1, Math.ceil(dt / 1));
  const h = dt / n;
  for (let k = 0; k < n; k++) {
    const a = twoBodyAccel(rx, ry, rz);
    vx += a[0] * h; vy += a[1] * h; vz += a[2] * h;
    rx += vx * h; ry += vy * h; rz += vz * h;
  }
  return [rx, ry, rz, vx, vy, vz];
}

// --- Small helpers ---

function mat(col: number[], rows: number): Matrix {
  return { data: col.map((v) => [v]), rows, cols: 1 };
}

function randn(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Range-rate std (m/s) derived from range std (m). Single source of truth. */
function rangeRateStd(r: number): number {
  return Math.max(r * 0.01, 0.01);
}

function setStatus(points: number, time: number, state: string): void {
  const set = (id: string, txt: string) => {
    const el = document.getElementById(id);
    if (el) el.textContent = txt;
  };
  set('status-scenario', `scenario: ${scenario}`);
  set('status-points', `points: ${points} (${dataIdx}/${points})`);
  set('status-time', `t: ${time.toFixed(1)} s`);
  set('status-state', state);
}

function setStats(truthKm: [number, number], estKm: [number, number]): void {
  const set = (id: string, txt: string) => {
    const el = document.getElementById(id);
    if (el) el.textContent = txt;
  };
  set('stat-truth', `${truthKm[0].toFixed(1)}, ${truthKm[1].toFixed(1)}`);
  set('stat-est', `${estKm[0].toFixed(1)}, ${estKm[1].toFixed(1)}`);
  const err = Math.hypot(truthKm[0] - estKm[0], truthKm[1] - estKm[1]);
  set('stat-err', err.toFixed(2));
}

// --- EKF builders ---

function buildQ6(q: number): (dt: number) => Matrix {
  return (dt: number): Matrix => {
    // Van Loan white-noise-on-acceleration: q is variance (sigma_a^2).
    const dt2 = dt * dt, dt3 = dt2 * dt;
    const a = (dt3 / 3) * q, b = (dt2 / 2) * q, c = dt * q;
    const d: number[][] = Array.from({ length: 6 }, () => new Array(6).fill(0));
    for (let i = 0; i < 3; i++) { d[i][i] = a; d[i][i + 3] = b; d[i + 3][i] = b; d[i + 3][i + 3] = c; }
    return { data: d, rows: 6, cols: 6 };
  };
}

function buildQ4(q: number): (dt: number) => Matrix {
  return (dt: number): Matrix => {
    // Van Loan white-noise-on-acceleration: q is variance (sigma_a^2).
    const dt2 = dt * dt, dt3 = dt2 * dt;
    const a = (dt3 / 3) * q, b = (dt2 / 2) * q, c = dt * q;
    const d: number[][] = Array.from({ length: 4 }, () => new Array(4).fill(0));
    for (let i = 0; i < 2; i++) { d[i][i] = a; d[i][i + 2] = b; d[i + 2][i] = b; d[i + 2][i + 2] = c; }
    return { data: d, rows: 4, cols: 4 };
  };
}

function buildLeoEKF(data: LoadedData): void {
  const p0 = data.position[0], v0 = data.velocity[0];
  // Offset initial guess so convergence is visible (~10 km, ~10 m/s)
  const x0 = [p0[0] + 8000, p0[1] - 6000, p0[2] + 4000, v0[0] + 10, v0[1] - 8, v0[2] + 5];
  const P0d: number[][] = Array.from({ length: 6 }, () => new Array(6).fill(0));
  for (let i = 0; i < 3; i++) P0d[i][i] = 1e8;      // (10 km)^2
  for (let i = 3; i < 6; i++) P0d[i][i] = 1e4;      // (100 m/s)^2
  const rrStd = rangeRateStd(rStd);
  const [gsx, gsy, gsz] = GROUND_STATION;

  // Discrete two-body propagation; dt supplied via currentDt mutable
  const f = (x: Matrix): Matrix => {
    const dt = currentDt;
    const s = propagateTwoBody(
      [x.data[0][0], x.data[1][0], x.data[2][0], x.data[3][0], x.data[4][0], x.data[5][0]],
      dt,
    );
    return mat(s, 6);
  };
  // Discrete transition with gravity gradient G = -mu/rho^3 (I - 3uu^T):
  // Fd = [[I + 0.5 G dt^2, I dt], [G dt, I]] (semi-implicit Euler)
  const F = (x: Matrix): Matrix => {
    const dt = currentDt;
    const rx = x.data[0][0], ry = x.data[1][0], rz = x.data[2][0];
    const rho = Math.max(1e-6, Math.sqrt(rx * rx + ry * ry + rz * rz));
    const ux = rx / rho, uy = ry / rho, uz = rz / rho;
    const k = MU_EARTH / (rho * rho * rho);
    const u = [ux, uy, uz];
    const G: number[][] = [];
    for (let i = 0; i < 3; i++) {
      G.push([]);
      for (let j = 0; j < 3; j++) G[i].push(-k * ((i === j ? 1 : 0) - 3 * u[i] * u[j]));
    }
    const d: number[][] = Array.from({ length: 6 }, () => new Array(6).fill(0));
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        d[i][j] = (i === j ? 1 : 0) + 0.5 * G[i][j] * dt * dt;
        d[i][j + 3] = i === j ? dt : 0;
        d[i + 3][j] = G[i][j] * dt;
        d[i + 3][j + 3] = i === j ? 1 : 0;
      }
    }
    return { data: d, rows: 6, cols: 6 };
  };
  // Ground-station range / range-rate
  const h = (x: Matrix): Matrix => {
    const ex = x.data[0][0] - gsx, ey = x.data[1][0] - gsy, ez = x.data[2][0] - gsz;
    const rho = Math.max(1e-6, Math.sqrt(ex * ex + ey * ey + ez * ez));
    const rr = (ex * x.data[3][0] + ey * x.data[4][0] + ez * x.data[5][0]) / rho;
    return { data: [[rho], [rr]], rows: 2, cols: 1 };
  };
  const H = (x: Matrix): Matrix => {
    const ex = x.data[0][0] - gsx, ey = x.data[1][0] - gsy, ez = x.data[2][0] - gsz;
    const rho = Math.max(1e-6, Math.sqrt(ex * ex + ey * ey + ez * ez));
    const ux = ex / rho, uy = ey / rho, uz = ez / rho;
    const rr = (ex * x.data[3][0] + ey * x.data[4][0] + ez * x.data[5][0]) / rho;
    return {
      data: [
        [ux, uy, uz, 0, 0, 0],
        [
          (x.data[3][0] - rr * ux) / rho,
          (x.data[4][0] - rr * uy) / rho,
          (x.data[5][0] - rr * uz) / rho,
          ux, uy, uz,
        ],
      ],
      rows: 2, cols: 6,
    };
  };

  ekf = new EKF({
    f, F, h, H,
    Q: buildQ6(qVar),
    R: { data: [[rStd * rStd, 0], [0, rrStd * rrStd]], rows: 2, cols: 2 },
    x0: mat(x0, 6),
    P0: { data: P0d, rows: 6, cols: 6 },
  });
  kfState = [...x0];
}

function buildAttitudeEKF(data: LoadedData): void {
  const p0 = data.position[0], v0 = data.velocity[0];
  const x0 = [p0[0] + 8000, p0[1] - 6000, v0[0] + 10, v0[1] - 8];
  const P0d: number[][] = Array.from({ length: 4 }, () => new Array(4).fill(0));
  P0d[0][0] = 1e8; P0d[1][1] = 1e8; P0d[2][2] = 1e4; P0d[3][3] = 1e4;

  const f = (x: Matrix): Matrix => {
    const dt = currentDt;
    return mat([
      x.data[0][0] + x.data[2][0] * dt,
      x.data[1][0] + x.data[3][0] * dt,
      x.data[2][0], x.data[3][0],
    ], 4);
  };
  const F = (): Matrix => {
    const dt = currentDt;
    return { data: [[1, 0, dt, 0], [0, 1, 0, dt], [0, 0, 1, 0], [0, 0, 0, 1]], rows: 4, cols: 4 };
  };
  const h = (x: Matrix): Matrix => ({ data: [[x.data[0][0]], [x.data[1][0]]], rows: 2, cols: 1 });
  const H = (): Matrix => ({ data: [[1, 0, 0, 0], [0, 1, 0, 0]], rows: 2, cols: 4 });

  ekf = new EKF({
    f, F, h, H,
    Q: buildQ4(qVar),
    R: { data: [[rStd * rStd, 0], [0, rStd * rStd]], rows: 2, cols: 2 },
    x0: mat(x0, 4),
    P0: { data: P0d, rows: 4, cols: 4 },
  });
  kfState = [x0[0], x0[1], 0, x0[2], x0[3], 0];
}

// --- Lifecycle ---

function rebuildFilter(): void {
  if (!loadedData || loadedData.position.length === 0) {
    ekf = null;
    return;
  }
  try {
    if (scenario === 'leo') buildLeoEKF(loadedData);
    else buildAttitudeEKF(loadedData);
  } catch (err) {
    logMessage(`EKF init failed: ${err instanceof Error ? err.message : String(err)}`);
    ekf = null;
  }
}

function resetToStart(): void {
  stopAnimation();
  dataIdx = 0;
  currentDt = 1;
  rebuildFilter();
  clearPlot();
  if (loadedData && loadedData.position.length > 0) {
    const p = loadedData.position[0];
    lastTruthKm = [p[0] * M_TO_KM, p[1] * M_TO_KM];
    lastEstimateKm = [...lastTruthKm];
    setStatus(loadedData.time.length, loadedData.time[0], 'ready');
    setStats(lastTruthKm, lastEstimateKm);
    updatePlot({ time: loadedData.time[0], truth: lastTruthKm, estimate: lastTruthKm, kf: lastTruthKm, measurements: [], covarianceEllipse: [lastTruthKm[0], lastTruthKm[1], 50] });
  } else {
    setStatus(0, 0, 'no data');
  }
  setRunButtonLabel(false);
}

// One animation frame = one data point
function stepFrame(): PlotData {
  const n = loadedData ? loadedData.position.length : 0;
  if (!loadedData || !ekf || n === 0) {
    return { time: 0, truth: lastTruthKm, estimate: lastEstimateKm, kf: lastEstimateKm, measurements: [], covarianceEllipse: [lastEstimateKm[0], lastEstimateKm[1], 50] };
  }
  if (dataIdx >= n) {
    stopAnimation();
    setRunButtonLabel(false);
    setStatus(n, loadedData.time[n - 1], 'done');
    return { time: loadedData.time[n - 1], truth: lastTruthKm, estimate: lastEstimateKm, kf: lastEstimateKm, measurements: [], covarianceEllipse: [lastEstimateKm[0], lastEstimateKm[1], 50] };
  }

  const i = dataIdx;
  const t = loadedData.time[i];
  const p = loadedData.position[i];
  const v = loadedData.velocity[i];
  const dt = i === 0 ? Math.max(0.1, (loadedData.time[1] ?? t + 1) - t) : Math.max(0.1, t - loadedData.time[i - 1]);
  currentDt = Math.min(dt, 60);
  const truthKm: [number, number] = [p[0] * M_TO_KM, p[1] * M_TO_KM];

  try {
    const first = i === 0;
    if (!first) {
      ekf.predict(currentDt);
      // Baseline: same dynamics, no measurement updates (pure propagation)
      if (kfState) {
        if (scenario === 'leo') {
          kfState = propagateTwoBody(kfState, currentDt);
        } else {
          kfState = [
            kfState[0] + kfState[3] * currentDt,
            kfState[1] + kfState[4] * currentDt,
            kfState[2] + kfState[5] * currentDt,
            kfState[3], kfState[4], kfState[5],
          ];
        }
      }
    }

    let z: Matrix;
    let measKm: { x: number; y: number }[];
    if (scenario === 'leo') {
      // Ground-station range / range-rate from noisy truth position
      const velStd = rangeRateStd(rStd);
      const npx = p[0] + randn() * rStd, npy = p[1] + randn() * rStd, npz = p[2] + randn() * rStd;
      const nvx = v[0] + randn() * velStd, nvy = v[1] + randn() * velStd, nvz = v[2] + randn() * velStd;
      const dx = npx - GROUND_STATION[0], dy = npy - GROUND_STATION[1], dz = npz - GROUND_STATION[2];
      const rho = Math.max(1e-6, Math.sqrt(dx * dx + dy * dy + dz * dz));
      const rr = (dx * nvx + dy * nvy + dz * nvz) / rho;
      z = { data: [[rho], [rr]], rows: 2, cols: 1 };
      measKm = [{ x: npx * M_TO_KM, y: npy * M_TO_KM }];
    } else {
      const npx = p[0] + randn() * rStd, npy = p[1] + randn() * rStd;
      z = { data: [[npx], [npy]], rows: 2, cols: 1 };
      measKm = [{ x: npx * M_TO_KM, y: npy * M_TO_KM }];
    }

    ekf.update(z);
    const xs = ekf.state;
    const P = ekf.covariance;
    const estKm: [number, number] = [xs.data[0][0] * M_TO_KM, xs.data[1][0] * M_TO_KM];
    const kfKm: [number, number] = kfState ? [kfState[0] * M_TO_KM, kfState[1] * M_TO_KM] : estKm;
    const pxVar = Math.max(0, P.data[0][0]);
    const pyVar = Math.max(0, P.data[1][1]);
    const rKm = 2 * Math.sqrt((pxVar + pyVar) / 2) * M_TO_KM;

    lastTruthKm = truthKm;
    lastEstimateKm = estKm;
    dataIdx += 1;
    setStatus(n, t, isAnimationRunning() ? 'running' : 'paused');
    setStats(truthKm, estKm);
    return { time: t, truth: [truthKm[0], truthKm[1]], estimate: [estKm[0], estKm[1]], kf: [kfKm[0], kfKm[1]], measurements: measKm, covarianceEllipse: [estKm[0], estKm[1], Math.max(1, Math.min(800, rKm))] };
  } catch (err) {
    logMessage(`Step ${i} failed: ${err instanceof Error ? err.message : String(err)}`);
    stopAnimation();
    setRunButtonLabel(false);
    return { time: t, truth: [truthKm[0], truthKm[1]], estimate: lastEstimateKm, kf: lastEstimateKm, measurements: [], covarianceEllipse: [lastEstimateKm[0], lastEstimateKm[1], 50] };
  }
}

function toggleRun(): boolean {
  if (!loadedData || !ekf) {
    logMessage('No EKF initialised — load data first.');
    return false;
  }
  if (isAnimationRunning()) {
    stopAnimation();
    setStatus(loadedData.position.length, loadedData.time[Math.min(dataIdx, loadedData.position.length - 1)], 'paused');
    return false;
  }
  if (dataIdx >= loadedData.position.length) resetToStart();
  startAnimation(stepFrame);
  return true;
}

// --- Boot ---

initControls(
  (data) => {
    if (!data || !Array.isArray(data.position) || data.position.length === 0) {
      logMessage('Unrecognized CSV format: no position rows.');
      return;
    }
    loadedData = data as LoadedData;
    resetToStart();
  },
  (sc) => {
    scenario = sc;
    document.querySelectorAll('.scenario-tab').forEach((t) =>
      t.classList.toggle('active', (t as HTMLElement).dataset.scenario === sc),
    );
    resetToStart();
  },
  (value) => {
    qVar = value;
    if (ekf) {
      try {
        if (scenario === 'leo') ekf.setQ(buildQ6(qVar));
        else ekf.setQ(buildQ4(qVar));
      } catch { /* rebuilt on reset */ }
    }
  },
  (value) => {
    rStd = value;
    if (ekf) {
      try {
        if (scenario === 'leo') {
          const rrStd = rangeRateStd(value);
          ekf.setR({ data: [[value * value, 0], [0, rrStd * rrStd]], rows: 2, cols: 2 });
        } else {
          ekf.setR({ data: [[value * value, 0], [0, value * value]], rows: 2, cols: 2 });
        }
      } catch { /* rebuilt on reset */ }
    }
  },
  () => toggleRun(),
  () => resetToStart(),
);

initPlot('plot-canvas', { canvasId: 'plot-canvas', width: 900, height: 560, showGrid: true, showLegend: true });

try {
  loadedData = generateSyntheticPass({ altitude: 300, duration: 600, points: 80 });
  resetToStart();
} catch (err) {
  logMessage(`Synthetic pass failed: ${err instanceof Error ? err.message : String(err)}`);
}

let resizeTimer: number | undefined;
window.addEventListener('resize', () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    const canvas = document.getElementById('plot-canvas') as HTMLCanvasElement | null;
    if (canvas) resizePlot(canvas, canvas.clientWidth || 900, canvas.clientHeight || 560);
  }, 150);
});

// Debug handles
(window as any).toggleAnimation = toggleRun;
(window as any).resetSim = resetToStart;
(window as any).getState = () => ({ scenario, dataIdx, qVar, rStd, points: loadedData?.position.length ?? 0 });
