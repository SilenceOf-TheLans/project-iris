/**
 * LEO orbit range-bearing model (Workcase A)
 * Implements process model (Cowell + J2), RK4 discretization,
 * measurement model (slant range & range-rate), and Jacobians.
 * State: [r_x, r_y, r_z, v_x, v_y, v_z]^T (6×1, ECI)
 */

import { Matrix } from "../types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Gravitational parameter for Earth (m^3/s^2) */
export const MU: number = 3.986004418e14;

/** Earth equatorial radius (m) */
export const RE: number = 6378137;

/** J2 zonal harmonic */
export const J2: number = 1.08263e-3;

/** Acceleration noise magnitude for process noise (m/s^2) */
export const SA: number = 1e-6;

// ---------------------------------------------------------------------------
// Process model: f(x) = [v; a_total(r)]
// Returns derivative of state: position rate = velocity, velocity rate = acceleration
// ---------------------------------------------------------------------------

/**
 * Compute total acceleration (two-body + J2 perturbation) at position r.
 * Returns 3-vector acceleration.
 */
function totalAcceleration(r: number[]): number[] {
  const rx = r[0];
  const ry = r[1];
  const rz = r[2];

  const rNorm = Math.max(1e-6, Math.sqrt(rx * rx + ry * ry + rz * rz));

  // Two-body: a = -μ * r / ‖r‖³
  const invR3 = 1 / (rNorm * rNorm * rNorm);
  const axTwoBody = -MU * rx * invR3;
  const ayTwoBody = -MU * ry * invR3;
  const azTwoBody = -MU * rz * invR3;

  // J2 perturbation per Vallado: k = (3/2)·μ·J2·R_E² / ‖r‖⁵, s = z²/‖r‖²
  // a_x = -k·x·(1 − 5·s), a_y = -k·y·(1 − 5·s), a_z = -k·z·(3 − 5·s)
  // (~1e-2 m/s² at LEO vs ~8.7 m/s² two-body).
  const r2 = rNorm * rNorm;
  const r5 = r2 * r2 * rNorm;
  const k = (3 / 2) * MU * J2 * (RE * RE) / r5;
  const s = (rz * rz) / r2;

  const axJ2 = -k * rx * (1 - 5 * s);
  const ayJ2 = -k * ry * (1 - 5 * s);
  const azJ2 = -k * rz * (3 - 5 * s);

  // Total acceleration
  return [axTwoBody + axJ2, ayTwoBody + ayJ2, azTwoBody + azJ2];
}

/**
 * State transition function f(x) that computes dx/dt = [v; a_total(r)].
 * Input x is a 6×1 column vector [r; v]. Returns 6×1.
 */
export function processModelF(x: number[]): number[] {
  // x = [rx, ry, rz, vx, vy, vz]
  const rx = x[0];
  const ry = x[1];
  const rz = x[2];
  const vx = x[3];
  const vy = x[4];
  const vz = x[5];

  const ax = totalAcceleration([rx, ry, rz])[0];
  const ay = totalAcceleration([rx, ry, rz])[1];
  const az = totalAcceleration([rx, ry, rz])[2];

  return [vx, vy, vz, ax, ay, az];
}

// ---------------------------------------------------------------------------
// RK4 discretization helper
// ---------------------------------------------------------------------------

/**
 * Perform a single 4th-order RK4 step.
 * x: current state vector (6×1) as flat array [rx, ry, rz, vx, vy, vz]
 * dt: step size (seconds)
 * f: derivative function taking 6-vector and returning 6-vector
 * Returns the new state after one RK4 step.
 */
export function rk4Step(x: number[], dt: number, f: (x: number[]) => number[]): number[] {
  // k1 = dt * f(x)
  const fX = f(x);
  const k1 = fX.map((ki) => dt * ki);

  // k2 = dt * f(x + k1/2)
  const xHalf1 = x.map((xi, i) => xi + k1[i] / 2);
  const fHalf1 = f(xHalf1);
  const k2 = fHalf1.map((ki) => dt * ki);

  // k3 = dt * f(x + k2/2)
  const xHalf2 = x.map((xi, i) => xi + k2[i] / 2);
  const fHalf2 = f(xHalf2);
  const k3 = fHalf2.map((ki) => dt * ki);

  // k4 = dt * f(x + k3)
  const xFull = x.map((xi, i) => xi + k3[i]);
  const fFull = f(xFull);
  const k4 = fFull.map((ki) => dt * ki);

  // x_new = x + (k1 + 2*k2 + 2*k3 + k4) / 6
  const result = x.map((xi, i) =>
    xi + (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]) / 6
  );

  return result;
}

// ---------------------------------------------------------------------------
// Measurement model h(x, groundStationPos, groundStationVel)
// h(x) = [‖r − r_s‖, ((r−r_s)·(v−v_s)) / ‖r−r_s‖]^T ∈ ℝ²
// ---------------------------------------------------------------------------

/**
 * Measurement function: computes slant range and range-rate.
 * x: state vector [rx, ry, rz, vx, vy, vz] (flat array, interpret as 6×1)
 * groundStationPos: [gx, gy, gz] ECI ground station position (constant)
 * groundStationVel: [gvx, gvy, gvz] ground station velocity (constant, typically zero for equatorial station)
 * Returns 2×1 measurement vector [rho, rho_dot]^T as flat array.
 */
export function measurementH(
  x: number[],
  groundStationPos: number[],
  groundStationVel: number[]
): number[] {
  const rx = x[0];
  const ry = x[1];
  const rz = x[2];
  const vx = x[3];
  const vy = x[4];
  const vz = x[5];

  // ρ_vec = r − r_s
  const rhoVecX = rx - groundStationPos[0];
  const rhoVecY = ry - groundStationPos[1];
  const rhoVecZ = rz - groundStationPos[2];

  // ρ = ‖ρ_vec‖ (guarded against division by zero)
  const rho = Math.max(1e-6, Math.sqrt(rhoVecX ** 2 + rhoVecY ** 2 + rhoVecZ ** 2));

  // Range: ρ
  const rhoVal = rho;

  // v_rel = v − v_s
  const vRelX = vx - groundStationVel[0];
  const vRelY = vy - groundStationVel[1];
  const vRelZ = vz - groundStationVel[2];

  // Range-rate: ρ̇ = (ρ_vec · v_rel) / ρ
  const rhoDot = (rhoVecX * vRelX + rhoVecY * vRelY + rhoVecZ * vRelZ) / rho;

  return [rhoVal, rhoDot];
}

// ---------------------------------------------------------------------------
// Jacobian H (2×6) of the measurement model
// Per spec: with ρ_vec = r − r_s, ρ = ‖ρ_vec‖, u = ρ_vec/ρ, v_rel = v − v_s
// ---------------------------------------------------------------------------

/**
 * Jacobian of the measurement model H(x, groundStationPos, groundStationVel) → 2×6 matrix.
 * Row 0: [uᵀ, 0₁×₃]   (derivative of range ρ w.r.t. state)
 * Row 1: [(v_rel − ṙ·u)ᵀ/ρ, uᵀ]
 *   (derivative of range-rate ρ̇ w.r.t. state, with ṙ = (ρ_vec·v_rel)/ρ)
 *
 * x: state vector [rx, ry, rz, vx, vy, vz] (flat array, interpret as 6×1)
 * groundStationPos: [gx, gy, gz] ECI ground station position
 * groundStationVel: [gvx, gvy, gvz] ECI ground station velocity
 *   (defaults to [0,0,0] for a static station); v_rel = v − v_s
 * Returns 2×6 matrix as { data: number[][], rows: 2, cols: 6 }.
 */
export function measurementJacobianH(
  x: number[],
  groundStationPos: number[],
  groundStationVel: number[] = [0, 0, 0]
): Matrix {
  const rx = x[0];
  const ry = x[1];
  const rz = x[2];
  const vx = x[3];
  const vy = x[4];
  const vz = x[5];

  // ρ_vec = r − r_s
  const rhoVecX = rx - groundStationPos[0];
  const rhoVecY = ry - groundStationPos[1];
  const rhoVecZ = rz - groundStationPos[2];

  // ρ = ‖ρ_vec‖ (guarded against division by zero)
  const rho = Math.max(1e-6, Math.sqrt(rhoVecX ** 2 + rhoVecY ** 2 + rhoVecZ ** 2));

  // u = ρ_vec / ρ
  const ux = rhoVecX / rho;
  const uy = rhoVecY / rho;
  const uz = rhoVecZ / rho;

  // v_rel = v − v_s
  const vRelX = vx - groundStationVel[0];
  const vRelY = vy - groundStationVel[1];
  const vRelZ = vz - groundStationVel[2];

  // ṙ = (ρ_vec · v_rel) / ρ
  const rr = (rhoVecX * vRelX + rhoVecY * vRelY + rhoVecZ * vRelZ) / rho;

  // Row 0: [uᵀ, 0₁×₃] = [ρ_vec_x/ρ, ρ_vec_y/ρ, ρ_vec_z/ρ, 0, 0, 0]
  const row0: number[] = [ux, uy, uz, 0, 0, 0];

  // Row 1: [(v_rel − ṙ·u)/ρ, u] — ∂ṙ/∂r = (v_rel − ṙ·u)/ρ, ∂ṙ/∂v = u
  const row1: number[] = [
    (vRelX - rr * ux) / rho,
    (vRelY - rr * uy) / rho,
    (vRelZ - rr * uz) / rho,
    ux,
    uy,
    uz,
  ];

  return { data: [row0, row1], rows: 2, cols: 6 };
}

// ---------------------------------------------------------------------------
// Q_d builder: process noise covariance discretization
// Q_d ≈ [[σ_a²/3 · Δt³ · I, σ_a²/2 · Δt² · I], [σ_a²/2 · Δt² · I, σ_a² · Δt · I]]
// σ_a = 1e-6 m/s² (acceleration noise magnitude)
// Returns 6×6 matrix as { data: number[][], rows: 6, cols: 6 }.
// ---------------------------------------------------------------------------

/**
 * Build discrete-time process noise covariance matrix Q_d for continuous-time
 * white-noise-on-acceleration model.
 * dt: step size in seconds
 * sigmaA: acceleration noise density in m/s² (default: 1e-6)
 * Returns 6×6 covariance matrix.
 */
export function buildQd(dt: number, sigmaA: number = SA): Matrix {
  const sigmaA2 = sigmaA ** 2;
  const dt3 = dt ** 3;
  const dt2 = dt ** 2;
  const dt1 = dt;

  // 3×3 identity blocks
  const I3 = identity3x3();

  // Top-left: σ_a²/3 · Δt³ · I_3
  const q11: number[][] = I3.map((row) => row.map((val) => (sigmaA2 / 3) * dt3 * val));

  // Top-right: σ_a²/2 · Δt² · I_3
  const q12: number[][] = I3.map((row) => row.map((val) => (sigmaA2 / 2) * dt2 * val));

  // Bottom-left: σ_a²/2 · Δt² · I_3 (same as top-right)
  const q21: number[][] = I3.map((row) => row.map((val) => (sigmaA2 / 2) * dt2 * val));

  // Bottom-right: σ_a² · Δt · I_3
  const q22: number[][] = I3.map((row) => row.map((val) => sigmaA2 * dt1 * val));

  // Assemble 6×6 block matrix
  const sixBySix: number[][] = new Array(6)
    .fill(0)
    .map(() => new Array(6).fill(0));

  // Top rows
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      sixBySix[i][j] = q11[i][j];
      sixBySix[i][j + 3] = q12[i][j];
    }
  }

  // Bottom rows
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      sixBySix[i + 3][j] = q21[i][j];
      sixBySix[i + 3][j + 3] = q22[i][j];
    }
  }

  return { data: sixBySix, rows: 6, cols: 6 };
}

/** Helper: 3×3 identity matrix as flat array of arrays */
function identity3x3(): number[][] {
  return [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
}

// ---------------------------------------------------------------------------
// R builder: measurement noise covariance (2×2)
// diag([(10 m)², (0.01 m/s)²]) = diag([100, 0.0001])
// ---------------------------------------------------------------------------

/**
 * Build measurement noise covariance matrix R.
 * Returns 2×2 diagonal matrix as { data: number[][], rows: 2, cols: 2 }.
 */
export function buildR(): Matrix {
  const r11 = 10 ** 2; // (10 m)^2
  const r22 = 0.01 ** 2; // (0.01 m/s)^2
  return { data: [[r11, 0], [0, r22]], rows: 2, cols: 2 };
}

/**
 * Build measurement noise covariance matrix R with custom parameters.
 * rangeStd: slant range standard deviation in meters (default: 10)
 * rangeRateStd: range-rate standard deviation in m/s (default: 0.01)
 * Returns 2×2 diagonal matrix.
 */
export function buildRCustom(rangeStd: number = 10, rangeRateStd: number = 0.01): Matrix {
  const r11 = rangeStd ** 2;
  const r22 = rangeRateStd ** 2;
  return { data: [[r11, 0], [0, r22]], rows: 2, cols: 2 };
}