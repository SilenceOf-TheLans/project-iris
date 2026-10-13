/**
 * Spacecraft attitude model (Workcase B)
 * Implements process model (MRP kinematics + Euler's rotation equation),
 * RK4 discretization, measurement model (direct MRP), and Jacobians.
 * State: [s^T, ω^T]^T ∈ ℝ⁶ (MRP + angular rate)
 */

/* eslint-disable */

import { Matrix } from "../types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Spacecraft principal moments of inertia (kg·m²): J = diag([Ix, Iy, Iz]) */
export const INERTIA: number[] = [200, 200, 100];

/** Process noise density for MRP (rad) */
export const SIGMA_S: number = 1e-3;

/** Process noise density for angular rate (rad/s) */
export const SIGMA_OMEGA: number = 1e-3;

// ---------------------------------------------------------------------------
// Helper: skew-symmetric matrix [s]_×
// ---------------------------------------------------------------------------

/**
 * Compute the skew-symmetric cross-product matrix of a 3-vector s.
 * [s]_× such that [s]_× * v = s × v for any vector v.
 * Returns 3×3 matrix as { data: number[][], rows: 3, cols: 3 }.
 */
export function skewSymmetric(s: number[]): Matrix {
  const sx = s[0];
  const sy = s[1];
  const sz = s[2];
  return {
    data: [
      [0, -sz, sy],
      [sz, 0, -sx],
      [-sy, sx, 0],
    ],
    rows: 3,
    cols: 3,
  };
}

// ---------------------------------------------------------------------------
// Process model: f(x) = [ṡ; ω̇]
// State x = [s_x, s_y, s_z, ω_x, ω_y, ω_z] (flat 6×1)
// Returns 6×1 flat array [ṡ_x, ṡ_y, ṡ_z, ω̇_x, ω̇_y, ω̇_z]
// ---------------------------------------------------------------------------

/**
 * Compute the process model derivative dx/dt = [ṡ; ω̇].
 * implements MRP kinematics and Euler's rotation equation.
 * J = diag([200, 200, 100]) kg·m², τ = 0 (free-floating).
 */
export function processModelF(x: number[]): number[] {
  // x = [s_x, s_y, s_z, ω_x, ω_y, ω_z]
  const s = x.slice(0, 3);
  const omega = x.slice(3, 6);

  // --- MRP kinematics: ṡ = ¼[(1 − sᵀs)I₃ + 2[s]_× + 2ssᵀ]ω ---
  const s_dot_s = s[0] * s[0] + s[1] * s[1] + s[2] * s[2];

  // sᵀω (scalar)
  const sT_omega = s[0] * omega[0] + s[1] * omega[1] + s[2] * omega[2];

  // [s]_× * ω = s × ω
  const cross_s_omega: number[] = [
    s[1] * omega[2] - s[2] * omega[1],
    s[2] * omega[0] - s[0] * omega[2],
    s[0] * omega[1] - s[1] * omega[0],
  ];

  // ssᵀω = s * (sᵀω) — scalar multiplication of vector s
  const ssT_omega: number[] = [
    s[0] * sT_omega,
    s[1] * sT_omega,
    s[2] * sT_omega,
  ];

  // (1 − sᵀs) * ω
  const one_minus_s_sq_omega: number[] = [
    (1 - s_dot_s) * omega[0],
    (1 - s_dot_s) * omega[1],
    (1 - s_dot_s) * omega[2],
  ];

  // Combine: (1 − sᵀs)I₃ω + 2[s]_×ω + 2ssᵀω
  const combined: number[] = [
    one_minus_s_sq_omega[0] +
      2 * cross_s_omega[0] +
      2 * ssT_omega[0],
    one_minus_s_sq_omega[1] +
      2 * cross_s_omega[1] +
      2 * ssT_omega[1],
    one_minus_s_sq_omega[2] +
      2 * cross_s_omega[2] +
      2 * ssT_omega[2],
  ];

  // ṡ = ¼ * combined
  const mrp_dot: number[] = combined.map((val) => 0.25 * val);

  // --- Euler's rotation equation: ω̇ = J⁻¹(τ − ω × (Jω)) ---
  // J = diag([200, 200, 100])
  const Ix = INERTIA[0]; // 200
  const Iy = INERTIA[1]; // 200
  const Iz = INERTIA[2]; // 100

  // Jω = [Ix*ωx, Iy*ωy, Iz*ωz]ᵀ
  const Jomega: number[] = [Ix * omega[0], Iy * omega[1], Iz * omega[2]];

  // ω × (Jω) — cross product
  const cross_omega_Jomega: number[] = [
    omega[1] * Jomega[2] - omega[2] * Jomega[1],
    omega[2] * Jomega[0] - omega[0] * Jomega[2],
    omega[0] * Jomega[1] - omega[1] * Jomega[0],
  ];

  // τ = 0 for free-floating, so ω̇ = J⁻¹(− ω × (Jω))
  // J⁻¹ = diag([1/Ix, 1/Iy, 1/Iz])
  const omega_dot: number[] = [
    -cross_omega_Jomega[0] / Ix,
    -cross_omega_Jomega[1] / Iy,
    -cross_omega_Jomega[2] / Iz,
  ];

  // Return [ṡ; ω̇] as flat 6×1 vector
  return [...mrp_dot, ...omega_dot];
}

// ---------------------------------------------------------------------------
// RK4 discretization helper
// ---------------------------------------------------------------------------

/**
 * Perform a single 4th-order RK4 step.
 * x: current state vector (6×1) as flat array [s_x, s_y, s_z, ω_x, ω_y, ω_z]
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
// Measurement model: h(x) = s (direct MRP measurement)
// h: (6×1 state) → (3×1 measurement)
// ---------------------------------------------------------------------------

/**
 * Measurement function: returns the MRP part of the state.
 * x: state vector [s_x, s_y, s_z, ω_x, ω_y, ω_z] (flat 6×1)
 * Returns 3×1 measurement vector [s_x, s_y, s_z]ᵀ as flat array.
 */
export function measurementH(x: number[]): number[] {
  return [x[0], x[1], x[2]];
}

// ---------------------------------------------------------------------------
// Jacobian of measurement H(x) = [[I₃, 0₃×₃]] (3×6 matrix)
// ---------------------------------------------------------------------------

/**
 * Jacobian of the measurement model H(x) → 3×6 matrix.
 * Row i has 1 at column i, zeros elsewhere.
 * The MRP part has identity Jacobian; the rate part is zero.
 * x: state vector [s_x, s_y, s_z, ω_x, ω_y, ω_z] (flat 6×1)
 * Returns 3×6 matrix as { data: number[][], rows: 3, cols: 6 }.
 */
export function measurementJacobianH(x: number[]): Matrix {
  return {
    data: [
      [1, 0, 0, 0, 0, 0],
      [0, 1, 0, 0, 0, 0],
      [0, 0, 1, 0, 0, 0],
    ],
    rows: 3,
    cols: 6,
  };
}

// ---------------------------------------------------------------------------
// Q builder: process noise covariance (6×6)
// Q can be diagonal with small values reflecting model uncertainty.
// For this workcase: Q = diag([σ_s², σ_s², σ_s², σ_ω², σ_ω², σ_ω²])
// ---------------------------------------------------------------------------

/**
 * Build process noise covariance matrix Q (6×6), diagonal.
 * sigmaS: standard deviation for MRP components (default: 1e-3)
 * sigmaOmega: standard deviation for angular rate components (default: 1e-3)
 * dt: time step (optional, for future discretization extensions)
 * Returns 6×6 covariance matrix as { data: number[][], rows: 6, cols: 6 }.
 */
export function buildQ(
  sigmaS: number = SIGMA_S,
  sigmaOmega: number = SIGMA_OMEGA,
  dt?: number
): Matrix {
  const qS2 = sigmaS ** 2;
  const qO2 = sigmaOmega ** 2;

  // 6×6 diagonal matrix: [σ_s², σ_s², σ_s², σ_ω², σ_ω², σ_ω²]
  const data: number[][] = new Array(6)
    .fill(0)
    .map(() => new Array(6).fill(0));

  for (let i = 0; i < 6; i++) {
    data[i][i] = i < 3 ? qS2 : qO2;
  }

  return { data, rows: 6, cols: 6 };
}

// ---------------------------------------------------------------------------
// R builder: measurement noise covariance (3×3)
// R: diagonal with MRP noise variance
// ---------------------------------------------------------------------------

/**
 * Build measurement noise covariance matrix R (3×3), diagonal.
 * sigmaMRP: standard deviation for MRP measurements (default: 1e-3 rad)
 * dt: optional time step for future state-dependence
 * Returns 3×3 covariance matrix as { data: number[][], rows: 3, cols: 3 }.
 */
export function buildR(sigmaMRP: number = 1e-3): Matrix {
  const r = sigmaMRP ** 2;

  // 3×3 diagonal matrix: r on diagonal
  const data: number[][] = new Array(3)
    .fill(0)
    .map(() => new Array(3).fill(0));

  for (let i = 0; i < 3; i++) {
    data[i][i] = r;
  }

  return { data, rows: 3, cols: 3 };
}