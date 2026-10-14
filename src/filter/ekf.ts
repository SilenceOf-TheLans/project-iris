/**
 * Generic EKF core module for Project IRIS.
 * Implements predict/update steps per the architecture spec.
 * Matrix operations use simple number[][] representation (see src/types/index.ts).
 */

import { Matrix, EKF_Options } from "../types";

// ---------------------------------------------------------------------------
// Helper: matrix multiplication  A · B
// ---------------------------------------------------------------------------

function multiply(A: Matrix, B: Matrix): Matrix {
  const aRows = A.rows;
  const aCols = A.cols;
  const bRows = B.rows;
  const bCols = B.cols;

  if (aCols !== bRows) {
    throw new Error(
      `Dimension mismatch: A (${aRows}x${aCols}) vs B (${bRows}x${bCols})`
    );
  }

  const result: number[][] = new Array(aRows)
    .fill(0)
    .map(() => new Array(bCols).fill(0));

  for (let i = 0; i < aRows; i++) {
    for (let j = 0; j < bCols; j++) {
      for (let k = 0; k < aCols; k++) {
        result[i][j] += A.data[i][k] * B.data[k][j];
      }
    }
  }

  return { data: result, rows: aRows, cols: bCols };
}

// ---------------------------------------------------------------------------
// Helper: transpose Aᵀ
// ---------------------------------------------------------------------------

function transpose(A: Matrix): Matrix {
  const result: number[][] = new Array(A.cols)
    .fill(0)
    .map(() => new Array(A.rows).fill(0));

  for (let i = 0; i < A.rows; i++) {
    for (let j = 0; j < A.cols; j++) {
      result[j][i] = A.data[i][j];
    }
  }

  return { data: result, rows: A.cols, cols: A.rows };
}

// ---------------------------------------------------------------------------
// Helper: matrix addition  A + B (same dimensions)
// ---------------------------------------------------------------------------

function add(A: Matrix, B: Matrix): Matrix {
  if (A.rows !== B.rows || A.cols !== B.cols) {
    throw new Error(
      `Dimension mismatch: A (${A.rows}x${A.cols}) vs B (${B.rows}x${B.cols})`
    );
  }

  const result: number[][] = new Array(A.rows)
    .fill(0)
    .map(() => new Array(A.cols).fill(0));

  for (let i = 0; i < A.rows; i++) {
    for (let j = 0; j < A.cols; j++) {
      result[i][j] = A.data[i][j] + B.data[i][j];
    }
  }

  return { data: result, rows: A.rows, cols: A.cols };
}

// ---------------------------------------------------------------------------
// Helper: matrix subtraction  A - B (same dimensions)
// ---------------------------------------------------------------------------

function subtract(A: Matrix, B: Matrix): Matrix {
  if (A.rows !== B.rows || A.cols !== B.cols) {
    throw new Error(
      `Dimension mismatch: A (${A.rows}x${A.cols}) vs B (${B.rows}x${B.cols})`
    );
  }

  const result: number[][] = new Array(A.rows)
    .fill(0)
    .map(() => new Array(A.cols).fill(0));

  for (let i = 0; i < A.rows; i++) {
    for (let j = 0; j < A.cols; j++) {
      result[i][j] = A.data[i][j] - B.data[i][j];
    }
  }

  return { data: result, rows: A.rows, cols: A.cols };
}

// ---------------------------------------------------------------------------
// Helper: identity matrix Iₙ (n×n)
// ---------------------------------------------------------------------------

function identity(n: number): Matrix {
  const result: number[][] = new Array(n)
    .fill(0)
    .map(() => new Array(n).fill(0));

  for (let i = 0; i < n; i++) {
    result[i][i] = 1;
  }

  return { data: result, rows: n, cols: n };
}

// ---------------------------------------------------------------------------
// Helper: scalar multiplication  c · A
// ---------------------------------------------------------------------------

function scalarMultiply(c: number, A: Matrix): Matrix {
  const result: number[][] = new Array(A.rows)
    .fill(0)
    .map(() => new Array(A.cols).fill(0));

  for (let i = 0; i < A.rows; i++) {
    for (let j = 0; j < A.cols; j++) {
      result[i][j] = c * A.data[i][j];
    }
  }

  return { data: result, rows: A.rows, cols: A.cols };
}

// ---------------------------------------------------------------------------
// Helper: inverse of a square matrix using Gaussian elimination
// Returns inverse or throws if singular.
// ---------------------------------------------------------------------------

function invert(A: Matrix): Matrix {
  const n = A.rows;
  if (n !== A.cols) {
    throw new Error("Inverse requires a square matrix");
  }

  // Augment [A | I]
  const aug: number[][] = new Array(n);
  for (let i = 0; i < n; i++) {
    aug[i] = new Array(2 * n);
    for (let j = 0; j < n; j++) {
      aug[i][j] = A.data[i][j];
    }
    for (let j = n; j < 2 * n; j++) {
      aug[i][j] = i === j - n ? 1 : 0;
    }
  }

  // Forward elimination with partial pivoting
  for (let col = 0; col < n; col++) {
    // Find pivot
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(aug[row][col]) > Math.abs(aug[maxRow][col])) {
        maxRow = row;
      }
    }

    // Swap rows
    [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];

    const pivot = aug[col][col];
    if (Math.abs(pivot) < 1e-12) {
      throw new Error("Matrix is singular (near-zero pivot)");
    }

    // Scale pivot row
    for (let j = 0; j < 2 * n; j++) {
      aug[col][j] /= pivot;
    }

    // Eliminate all other rows
    for (let row = 0; row < n; row++) {
      if (row !== col) {
        const factor = aug[row][col];
        for (let j = 0; j < 2 * n; j++) {
          aug[row][j] -= factor * aug[col][j];
        }
      }
    }
  }

  // Extract right half (the inverse)
  const result: number[][] = new Array(n);
  for (let i = 0; i < n; i++) {
    result[i] = new Array(n);
    for (let j = 0; j < n; j++) {
      result[i][j] = aug[i][n + j];
    }
  }

  return { data: result, rows: n, cols: n };
}

// ---------------------------------------------------------------------------
// EKF class
// ---------------------------------------------------------------------------

export class EKF {
  private xHat: Matrix;   // current state estimate x̂
  private P: Matrix;      // current covariance P
  private f: (x: Matrix) => Matrix;      // process model
  private F: (x: Matrix) => Matrix;      // Jacobian of f
  private h: (x: Matrix) => Matrix;      // measurement model
  private H: (x: Matrix) => Matrix;      // Jacobian of h
  private Q: Matrix | ((dt: number) => Matrix); // process noise matrix or builder
  private R: Matrix | ((x: Matrix) => Matrix); // measurement noise matrix or state-dependent builder

  /**
   * Constructor per EKF_Options.
   * All matrices are stored as { data: number[][], rows: number, cols: number }.
   * The options parameter matches the EKF_Options shape (generic T is a phantom
   * type for workcase parameterization; all function signatures use Matrix).
   */
  constructor(options: {
    f: (x: Matrix) => Matrix;
    F: (x: Matrix) => Matrix;
    h: (x: Matrix) => Matrix;
    H: (x: Matrix) => Matrix;
    Q: Matrix | ((dt: number) => Matrix);
    R: Matrix | ((x: Matrix) => Matrix);
    x0: Matrix;
    P0: Matrix;
  }) {
    this.f = options.f;
    this.F = options.F;
    this.h = options.h;
    this.H = options.H;
    this.Q = options.Q;
    this.R = options.R;

    // Deep-copy initial state and covariance
    this.xHat = { data: options.x0.data.map(row => [...row]), rows: options.x0.rows, cols: options.x0.cols };
    this.P = { data: options.P0.data.map(row => [...row]), rows: options.P0.rows, cols: options.P0.cols };
  }

  /** Update the process noise Q matrix (or builder function) */
  setQ(newQ: Matrix | ((dt: number) => Matrix)): void {
    this.Q = newQ;
  }

  /** Update the measurement noise R matrix (or builder function) */
  setR(newR: Matrix | ((x: Matrix) => Matrix)): void {
    this.R = newR;
  }

  /** predict(dt) – predict one step forward */
  predict(dt: number): void {
    // x̂⁻ = f(x̂₋₁, u=0, w=0)
    const xBar = this.f(this.xHat);

    // P⁻ = F · P₋₁ · Fᵀ + Q_d
    // F is evaluated at the previous state (stored in options' F closure over x̂₋₁)
    // But per spec: F: (x: Matrix) => Matrix, so we evaluate at x̂₋₁ = this.xHat
    const F = this.F(this.xHat);

    const Ft = transpose(F);
    const F_P_Ft = multiply(multiply(F, this.P), Ft);

    // Q_d: if Q is a function of dt, call it; otherwise use the constant matrix
    const Qd = typeof this.Q === "function" ? this.Q(dt) : this.Q;

    this.P = add(F_P_Ft, Qd);
    this.xHat = xBar;
  }

  /** update(z) – incorporate a measurement vector z */
  update(z: Matrix): void {
    // y = z - h(x̂⁻)  (innovation / residual)
    const h_xBar = this.h(this.xHat);
    const y = subtract(z, h_xBar);

    // S = H · P⁻ · Hᵀ + R  (innovation covariance)
    const H = this.H(this.xHat);
    const Ht = transpose(H);
    const H_P_Ht = multiply(multiply(H, this.P), Ht);
    const S = add(H_P_Ht, typeof this.R === "function" ? this.R(this.xHat) : this.R);

    // K = P⁻ · Hᵀ · S⁻¹  (Kalman gain)
    const Pt_Ht = multiply(this.P, Ht);
    const Sinv = invert(S);
    const K = multiply(Pt_Ht, Sinv);

    // x̂ = x̂⁻ + K · y  (state update)
    const K_y = multiply(K, y);
    this.xHat = add(this.xHat, K_y);

    // P = (I - K · H) · P⁻  (covariance update)
    const K_H = multiply(K, H);
    const I_n = identity(this.xHat.rows);
    const I_minus_KH = subtract(I_n, K_H);
    this.P = multiply(I_minus_KH, this.P);
  }

  /** get state() – current state estimate x̂ */
  get state(): Matrix {
    // Return a copy to avoid external mutation
    return { data: this.xHat.data.map(row => [...row]), rows: this.xHat.rows, cols: this.xHat.cols };
  }

  /** get covariance() – current covariance P */
  get covariance(): Matrix {
    return { data: this.P.data.map(row => [...row]), rows: this.P.rows, cols: this.P.cols };
  }
}