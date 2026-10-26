/**
 * Shared TypeScript interfaces for the EKF Simulator
 */

export interface Matrix {
  data: number[][]
  rows: number
  cols: number
}

/**
 * Row vector (1×n) – data stored as a single row: [[...]].
 */
export interface Vector {
  data: number[][]
  rows: number
  cols: number
}

export interface EKF_Options<T extends StateVector> {
  f: (x: Matrix, dt: number) => Matrix      // process model
  F: (x: Matrix, dt: number) => Matrix      // Jacobian of f
  h: (x: Matrix) => Matrix      // measurement model
  H: (x: Matrix) => Matrix      // Jacobian of h
  Q: Matrix | ((dt: number) => Matrix)   // process noise
  R: Matrix | ((x: Matrix) => Matrix)   // measurement noise; must be diagonal (correlated R is rejected)
  x0: Matrix                      // initial state (n×1)
  P0: Matrix                      // initial covariance (n×n)
}

export interface StateVector {
  data: number[]
  size: number
}

export interface Measurement {
  value: number[]
  covariance: Matrix
}

export interface EKFResult {
  state: Matrix
  covariance: Matrix
  nis: number
  nees: number
}