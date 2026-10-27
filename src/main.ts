/**
 * Project IRIS - EKF Simulator Main Entry Point.
 * LEO (6-state, range/range-rate) and planar 2D orbit (4-state, position)
 * scenarios. Plot units: km. Internal filter units: m, m/s, s.
 */

import { EKF } from './filter/ekf';
import type { Matrix } from './types';
import { generateSyntheticPass, interpolateTruth, type LoadedData } from './data/io';
import { initControls, setRunButtonLabel, logMessage, type Scenario } from './ui/controls';
import { initPlot, updatePlot, startAnimation, stopAnimation, isAnimationRunning, clearPlot, resizePlot, type PlotData } from './ui/plot';
import { initErrorPlot, resetErrorPlot, pushErrorSample, getErrorSummary, redrawErrorPlot, resizeErrorPlot, type ErrorSummary } from './ui/error-plot';

// --- State ---

let scenario: Scenario = 'leo';
let loadedData: LoadedData | null = null;
let dataIdx = 0;
let ekf: EKF | null = null;
let kfState: number[] | null = null; // naive dead-reckoning baseline [px,py,pz,vx,vy,vz] or 2D
let filterError = false;
let qVar = 1e-6;
let rStd = 10;
let simSpeed = 1;          // playback multiplier; does not change filter dynamics
let speedAccumulator = 0;  // fractional steps carried between animation frames
let lastEstimateKm: [number, number] = [0, 0];
let lastTruthKm: [number, number] = [0, 0];

const M_TO_KM = 1 / 1000;

/** Earth gravitational parameter (m^3/s^2) and ground-station ECI position (m). */
const MU_EARTH = 3.986e14;
const GROUND_STATION: [number, number, number] = [6378.137 * 1000, 0, 0];

/**
 * Integrate the two-body state and its 6×6 variational state-transition matrix
 * (STM) over `dt` using classical RK4 with 5-second substeps.
 *
 * The STM satisfies  Φ' = A Φ,  Φ(0) = I,  where
 *   A = [[0, I], [G, 0]],   G = ∂a/∂r = -μ/ρ³ (I - 3 u uᵀ).
 *
 * Using the true variational STM (instead of a single-step Euler
 * approximation) is essential when measurements are far apart: the covariance
 * is propagated over thousands of seconds and a crude F causes the filter to
 * become overconfident and diverge.
 *
 * State: [rx, ry, rz, vx, vy, vz] in meters and m/s.
 */
function propagateWithSTM(
  s: number[],
  dt: number,
): { state: number[]; Phi: number[][] } {
  if (!Number.isFinite(dt) || dt <= 0) {
    throw new Error(`Invalid propagation interval: ${dt} s`);
  }
  const n = Math.max(1, Math.ceil(dt / 5));
  if (n > 2_000_000) {
    throw new Error(`Propagation interval too large: ${dt} s`);
  }

  let r = [s[0], s[1], s[2]];
  let v = [s[3], s[4], s[5]];
  let Phi: number[][] = Array.from({ length: 6 }, (_, i) =>
    Array.from({ length: 6 }, (_, j) => (i === j ? 1 : 0)),
  );

  const accel = (rr: number[]): number[] => {
    const rho = Math.max(1e-6, Math.sqrt(rr[0] * rr[0] + rr[1] * rr[1] + rr[2] * rr[2]));
    const k = -MU_EARTH / (rho * rho * rho);
    return [k * rr[0], k * rr[1], k * rr[2]];
  };

  const gravityGradient = (rr: number[]): number[][] => {
    const rho = Math.max(1e-6, Math.sqrt(rr[0] * rr[0] + rr[1] * rr[1] + rr[2] * rr[2]));
    const u = [rr[0] / rho, rr[1] / rho, rr[2] / rho];
    const k = MU_EARTH / (rho * rho * rho);
    return Array.from({ length: 3 }, (_, i) =>
      Array.from({ length: 3 }, (_, j) => -k * ((i === j ? 1 : 0) - 3 * u[i] * u[j])),
    );
  };

  const phiDot = (rr: number[], P: number[][]): number[][] => {
    const G = gravityGradient(rr);
    return Array.from({ length: 6 }, (_, i) =>
      Array.from({ length: 6 }, (_, j) => {
        if (i < 3) return P[i + 3][j];
        let sum = 0;
        for (let l = 0; l < 3; l++) sum += G[i - 3][l] * P[l][j];
        return sum;
      }),
    );
  };

  const addScaled = (A: number[][], B: number[][], c: number): number[][] =>
    A.map((row, i) => row.map((val, j) => val + c * B[i][j]));

  const h = dt / n;

  for (let step = 0; step < n; step++) {
    const k1r = v;
    const k1v = accel(r);
    const k1P = phiDot(r, Phi);

    const r2 = r.map((x, i) => x + (h / 2) * k1r[i]);
    const v2 = v.map((x, i) => x + (h / 2) * k1v[i]);
    const P2 = addScaled(Phi, k1P, h / 2);
    const k2r = v2;
    const k2v = accel(r2);
    const k2P = phiDot(r2, P2);

    const r3 = r.map((x, i) => x + (h / 2) * k2r[i]);
    const v3 = v.map((x, i) => x + (h / 2) * k2v[i]);
    const P3 = addScaled(Phi, k2P, h / 2);
    const k3r = v3;
    const k3v = accel(r3);
    const k3P = phiDot(r3, P3);

    const r4 = r.map((x, i) => x + h * k3r[i]);
    const v4 = v.map((x, i) => x + h * k3v[i]);
    const P4 = addScaled(Phi, k3P, h);
    const k4r = v4;
    const k4v = accel(r4);
    const k4P = phiDot(r4, P4);

    r = r.map((x, i) => x + (h / 6) * (k1r[i] + 2 * k2r[i] + 2 * k3r[i] + k4r[i]));
    v = v.map((x, i) => x + (h / 6) * (k1v[i] + 2 * k2v[i] + 2 * k3v[i] + k4v[i]));
    Phi = Phi.map((row, i) =>
      row.map((val, j) => val + (h / 6) * (k1P[i][j] + 2 * k2P[i][j] + 2 * k3P[i][j] + k4P[i][j])),
    );
  }

  return { state: [r[0], r[1], r[2], v[0], v[1], v[2]], Phi };
}

/** Propagate a two-body state (no STM) with RK4. */
function propagateTwoBody(s: number[], dt: number): number[] {
  return propagateWithSTM(s, dt).state;
}

/**
 * Planar (2D) two-body propagation with the 4×4 variational STM.
 *
 * The z = 0 plane is invariant under two-body gravity, so the planar dynamics
 * decouple exactly from z. The 4×4 STM is the x-y block of the 6×6 STM.
 * State: [x, y, vx, vy] in meters and m/s.
 */
function propagateWithSTM2D(
  s: number[],
  dt: number,
): { state: number[]; Phi: number[][] } {
  const r6 = propagateWithSTM([s[0], s[1], 0, s[2], s[3], 0], dt);
  return {
    state: [r6.state[0], r6.state[1], r6.state[3], r6.state[4]],
    Phi: [
      [r6.Phi[0][0], r6.Phi[0][1], r6.Phi[0][3], r6.Phi[0][4]],
      [r6.Phi[1][0], r6.Phi[1][1], r6.Phi[1][3], r6.Phi[1][4]],
      [r6.Phi[3][0], r6.Phi[3][1], r6.Phi[3][3], r6.Phi[3][4]],
      [r6.Phi[4][0], r6.Phi[4][1], r6.Phi[4][3], r6.Phi[4][4]],
    ],
  };
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

function setStats(truthKm: [number, number], estKm: [number, number]): number {
  const set = (id: string, txt: string) => {
    const el = document.getElementById(id);
    if (el) el.textContent = txt;
  };
  set('stat-truth', `${truthKm[0].toFixed(1)}, ${truthKm[1].toFixed(1)}`);
  set('stat-est', `${estKm[0].toFixed(1)}, ${estKm[1].toFixed(1)}`);
  const err = Math.hypot(truthKm[0] - estKm[0], truthKm[1] - estKm[1]);
  set('stat-err', err.toFixed(2));
  return err;
}

function setErrorStats(stats: ErrorSummary | null): void {
  const set = (id: string, value: number | null | undefined) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value == null ? '—' : value.toFixed(2);
  };
  set('stat-mean-err', stats?.meanKm);
  set('stat-max-err', stats?.maxKm);
  set('stat-min-err', stats?.minKm);
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
  // Offset the in-plane initial guess so convergence is visible (~10 km,
  // ~10 m/s). Do not offset z/vz: on the equatorial/planar passes used by the
  // app those states are weakly observable from range/range-rate, so an
  // artificial z offset would persist as a hidden bias.
  const x0 = [p0[0] + 8000, p0[1] - 6000, p0[2], v0[0] + 10, v0[1] - 8, v0[2]];
  const P0d: number[][] = Array.from({ length: 6 }, () => new Array(6).fill(0));
  for (let i = 0; i < 3; i++) P0d[i][i] = 1e8;      // (10 km)^2
  for (let i = 3; i < 6; i++) P0d[i][i] = 1e4;      // (100 m/s)^2
  const rrStd = rangeRateStd(rStd);
  const [gsx, gsy, gsz] = GROUND_STATION;

  // Two-body propagation with the full variational state-transition matrix.
  // predict(dt) calls f and F back-to-back with the same state and dt, so
  // cache the expensive RK4 + STM integration instead of computing it twice.
  let stmCache: { state: number[]; dt: number; result: { state: number[]; Phi: number[][] } } | null = null;
  const propagateCached = (x: Matrix, dt: number) => {
    const s = [x.data[0][0], x.data[1][0], x.data[2][0], x.data[3][0], x.data[4][0], x.data[5][0]];
    if (
      stmCache &&
      stmCache.dt === dt &&
      stmCache.state.every((v, i) => v === s[i])
    ) {
      return stmCache.result;
    }
    const result = propagateWithSTM(s, dt);
    stmCache = { state: s, dt, result };
    return result;
  };
  const f = (x: Matrix, dt: number): Matrix => mat(propagateCached(x, dt).state, 6);
  const F = (x: Matrix, dt: number): Matrix => ({ data: propagateCached(x, dt).Phi, rows: 6, cols: 6 });
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

  // Planar two-body dynamics. The previous constant-velocity model cuts a
  // straight chord between measurements; with a full orbit and sparse samples
  // that chord is thousands of kilometres away from the curved truth, so the
  // filter never follows the path. The variational STM keeps the covariance
  // honest across gaps of thousands of seconds.
  let stmCache: { state: number[]; dt: number; result: { state: number[]; Phi: number[][] } } | null = null;
  const propagateCached = (x: Matrix, dt: number) => {
    const s = [x.data[0][0], x.data[1][0], x.data[2][0], x.data[3][0]];
    if (
      stmCache &&
      stmCache.dt === dt &&
      stmCache.state.every((v, i) => v === s[i])
    ) {
      return stmCache.result;
    }
    const result = propagateWithSTM2D(s, dt);
    stmCache = { state: s, dt, result };
    return result;
  };
  const f = (x: Matrix, dt: number): Matrix => mat(propagateCached(x, dt).state, 4);
  const F = (x: Matrix, dt: number): Matrix => ({ data: propagateCached(x, dt).Phi, rows: 4, cols: 4 });
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
  filterError = false;
  speedAccumulator = 0;
  rebuildFilter();
  clearPlot();
  setErrorStats(null);
  if (loadedData && loadedData.position.length > 0) {
    const tp = loadedData.truthPosition[0];
    lastTruthKm = [tp[0] * M_TO_KM, tp[1] * M_TO_KM];
    lastEstimateKm = [...lastTruthKm];
    const kfKm: [number, number] = kfState
      ? [kfState[0] * M_TO_KM, kfState[1] * M_TO_KM]
      : lastTruthKm;
    setStatus(loadedData.time.length, loadedData.time[0], 'ready');
    setStats(lastTruthKm, lastEstimateKm);
    resetErrorPlot(loadedData.time[0], loadedData.time[loadedData.time.length - 1]);
    updatePlot({ time: loadedData.time[0], truth: lastTruthKm, estimate: lastTruthKm, kf: kfKm, measurements: [] });
  } else {
    setStatus(0, 0, 'no data');
    resetErrorPlot(0, 1);
  }
  setRunButtonLabel(false);
}

/**
 * Convert the x–y covariance block to a 2σ ellipse for display.
 * Returns [cx, cy, major km, minor km, angle rad]. Using the full 2×2 block
 * preserves correlation and orientation; drawing a circle from the average
 * variance hides both.
 */
function covarianceEllipse2Sigma(
  cxKm: number,
  cyKm: number,
  P: Matrix,
): [number, number, number, number, number] {
  const sxx = Math.max(0, P.data[0][0]);
  const syy = Math.max(0, P.data[1][1]);
  const sxy = 0.5 * (P.data[0][1] + P.data[1][0]);
  const mid = 0.5 * (sxx + syy);
  const halfDiff = 0.5 * (sxx - syy);
  const rad = Math.sqrt(Math.max(0, halfDiff * halfDiff + sxy * sxy));
  const l1 = Math.max(0, mid + rad);
  const l2 = Math.max(0, mid - rad);
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return [
    cxKm,
    cyKm,
    2 * Math.sqrt(l1) * M_TO_KM,
    2 * Math.sqrt(l2) * M_TO_KM,
    angle,
  ];
}

// One animation frame = one data point
function stepFrame(): PlotData {
  const n = loadedData ? loadedData.position.length : 0;
  const kfKmNow = (): [number, number] | undefined => (
    kfState ? [kfState[0] * M_TO_KM, kfState[1] * M_TO_KM] : undefined
  );
  if (!loadedData || !ekf || n === 0) {
    return { time: 0, truth: lastTruthKm, estimate: lastEstimateKm, kf: kfKmNow(), measurements: [] };
  }
  if (dataIdx >= n) {
    stopAnimation();
    setRunButtonLabel(false);
    setStatus(n, loadedData.time[n - 1], 'done');
    return { time: loadedData.time[n - 1], truth: lastTruthKm, estimate: lastEstimateKm, kf: kfKmNow(), measurements: [] };
  }

  const i = dataIdx;
  const t = loadedData.time[i];
  const tPrev = i === 0 ? t : loadedData.time[i - 1];
  const gap = i === 0 ? 0 : t - tPrev;
  // Truth is evaluated from the equation at the exact measurement time.
  // Nearest-sample lookup would introduce tens of kilometres of along-track
  // error whenever a measurement falls between truth-grid samples.
  const truthAtT = interpolateTruth(loadedData, t);
  const tp = truthAtT.position;
  const tv = truthAtT.velocity;
  const truthKm: [number, number] = [tp[0] * M_TO_KM, tp[1] * M_TO_KM];

  try {
    if (i > 0) {
      // Propagate across the FULL measurement gap in small steps. This keeps
      // the state synchronised with the measurement time (clamping the step
      // would make the filter diverge) and lets the estimate trace follow the
      // orbital curve instead of drawing straight chords between sparse points.
      // Summing per-substep Q is the correct discretisation of continuous
      // white-noise-on-acceleration, so the covariance is unchanged by the
      // subdivision.
      const nSub = Math.max(6, Math.min(48, Math.ceil(gap / 20)));
      const h = gap / nSub;

      for (let k = 1; k <= nSub; k++) {
        ekf.predict(h);

        // Baseline: same dynamics, no measurement updates (pure propagation).
        if (kfState) {
          kfState = propagateTwoBody(kfState, h);
        }

        // Draw the predicted truth/estimate at intermediate times. The final
        // substep is drawn by the returned PlotData below (after the update).
        if (k < nSub) {
          const tSub = tPrev + k * h;
          const truthSub = interpolateTruth(loadedData, tSub);
          const xsSub = ekf.state;
          const Psub = ekf.covariance;
          const truthSubKm: [number, number] = [
            truthSub.position[0] * M_TO_KM,
            truthSub.position[1] * M_TO_KM,
          ];
          const estSubKm: [number, number] = [xsSub.data[0][0] * M_TO_KM, xsSub.data[1][0] * M_TO_KM];
          // Sample the error along the prediction arc too, not only at the
          // sparse measurement times. With five CSV rows this turns the error
          // chart from five straight chords into the actual growth/correction
          // curve between updates.
          pushErrorSample(tSub, Math.hypot(truthSubKm[0] - estSubKm[0], truthSubKm[1] - estSubKm[1]));
          updatePlot({
            time: tSub,
            truth: truthSubKm,
            estimate: estSubKm,
            kf: kfKmNow(),
            measurements: [],
            covarianceEllipse: covarianceEllipse2Sigma(estSubKm[0], estSubKm[1], Psub),
          }, false);
        }
      }
    }

    // The CSV row is the sparse measurement. Regenerating a "measurement" from
    // the interpolated truth would silently discard the user's measurement
    // values (including any noise already present in the file), so use the
    // stored row and add only the runtime sensor noise selected by the slider.
    const mp = loadedData.position[i];
    const mv = loadedData.velocity[i];

    let z: Matrix;
    let measKm: { x: number; y: number }[];
    if (scenario === 'leo') {
      // Ground-station range / range-rate from the measurement row.
      const velStd = rangeRateStd(rStd);
      const npx = mp[0] + randn() * rStd, npy = mp[1] + randn() * rStd, npz = mp[2] + randn() * rStd;
      const nvx = mv[0] + randn() * velStd, nvy = mv[1] + randn() * velStd, nvz = mv[2] + randn() * velStd;
      const dx = npx - GROUND_STATION[0], dy = npy - GROUND_STATION[1], dz = npz - GROUND_STATION[2];
      const rho = Math.max(1e-6, Math.sqrt(dx * dx + dy * dy + dz * dz));
      const rr = (dx * nvx + dy * nvy + dz * nvz) / rho;
      z = { data: [[rho], [rr]], rows: 2, cols: 1 };
      measKm = [{ x: npx * M_TO_KM, y: npy * M_TO_KM }];
    } else {
      // Attitude (2D): measurement = stored 2D position + runtime noise.
      const npx = mp[0] + randn() * rStd, npy = mp[1] + randn() * rStd;
      z = { data: [[npx], [npy]], rows: 2, cols: 1 };
      measKm = [{ x: npx * M_TO_KM, y: npy * M_TO_KM }];
    }

    ekf.update(z);
    const xs = ekf.state;
    const P = ekf.covariance;
    const estKm: [number, number] = [xs.data[0][0] * M_TO_KM, xs.data[1][0] * M_TO_KM];
    const kfKm = kfKmNow() ?? estKm;

    lastTruthKm = truthKm;
    lastEstimateKm = estKm;
    dataIdx += 1;
    setStatus(n, t, isAnimationRunning() ? 'running' : 'paused');
    const errKm = setStats(truthKm, estKm);
    setErrorStats(pushErrorSample(t, errKm));
    return { time: t, truth: [truthKm[0], truthKm[1]], estimate: [estKm[0], estKm[1]], kf: [kfKm[0], kfKm[1]], measurements: measKm, covarianceEllipse: covarianceEllipse2Sigma(estKm[0], estKm[1], P) };
  } catch (err) {
    logMessage(`Step ${i} failed: ${err instanceof Error ? err.message : String(err)}`);
    filterError = true;
    stopAnimation();
    setRunButtonLabel(false);
    setStatus(n, t, 'error');
    setErrorStats(getErrorSummary());
    return { time: t, truth: [truthKm[0], truthKm[1]], estimate: lastEstimateKm, kf: kfKmNow(), measurements: [] };
  }
}

/**
 * Advance playback according to the speed slider.
 *
 * 1× = one measurement per animation frame, 0.1× = one measurement every ten
 * frames, 10× = up to ten measurements per frame. The fractional remainder is
 * carried between frames so low speeds stay smooth instead of rounding down to
 * a freeze. This only changes wall-clock pacing; the filter never sees it.
 */
function playbackFrame(): PlotData | null {
  speedAccumulator += simSpeed;
  if (speedAccumulator < 1 - 1e-9) return null;

  const steps = Math.min(50, Math.max(1, Math.floor(speedAccumulator + 1e-9)));
  speedAccumulator = Math.max(0, speedAccumulator - steps);

  let last: PlotData | null = null;
  for (let k = 0; k < steps; k++) {
    last = stepFrame();
    if (!isAnimationRunning()) break;
    if (k < steps - 1 && last) updatePlot(last, false);
    if (!loadedData || dataIdx >= loadedData.position.length) break;
  }
  if (last) redrawErrorPlot();
  return last;
}

function toggleRun(): boolean {
  if (!loadedData || !ekf) {
    logMessage('No EKF initialised — load data first.');
    return false;
  }
  if (filterError) {
    logMessage('Reset the simulation before running again after a failed step.');
    return false;
  }
  if (isAnimationRunning()) {
    stopAnimation();
    speedAccumulator = 0;
    const pausedIdx = Math.max(0, Math.min(dataIdx - 1, loadedData.position.length - 1));
    setStatus(loadedData.position.length, loadedData.time[pausedIdx], 'paused');
    return false;
  }
  if (dataIdx >= loadedData.position.length) resetToStart();
  speedAccumulator = 0;
  startAnimation(playbackFrame);
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
    // Match the filter to the file's actual measurement mode. Loading a 5-col
    // planar file into the 6-state scenario (or an 11-col 3D file into the 2D
    // scenario) otherwise silently drops a dimension.
    let nextScenario: Scenario = scenario;
    if (loadedData.mode === 'mode2') nextScenario = 'attitude';
    else if (loadedData.mode === 'mode1') nextScenario = 'leo';
    if (nextScenario !== scenario) {
      scenario = nextScenario;
      document.querySelectorAll('.scenario-tab').forEach((t) =>
        t.classList.toggle('active', (t as HTMLElement).dataset.scenario === scenario),
      );
    }
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
  (value) => {
    if (Number.isFinite(value) && value > 0) simSpeed = value;
  },
);

initPlot('plot-canvas', { canvasId: 'plot-canvas', width: 900, height: 560, showGrid: true, showLegend: true });
initErrorPlot('error-canvas');

try {
  loadedData = generateSyntheticPass({ altitude: 300, duration: 600, points: 80, noiseStd: 0, noiseVelStd: 0 });
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
    resizeErrorPlot();
  }, 150);
});

// Debug handles
(window as any).toggleAnimation = toggleRun;
(window as any).resetSim = resetToStart;
(window as any).getState = () => ({ scenario, dataIdx, qVar, rStd, simSpeed, points: loadedData?.position.length ?? 0 });
