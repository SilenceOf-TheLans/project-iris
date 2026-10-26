/**
 * Generic EKF core module for Project IRIS.
 * Implements predict/update steps per the architecture spec.
 * Matrix operations use simple number[][] representation (see src/types/index.ts).
 */

import type { Matrix } from "../types";

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
// EKF class
// ---------------------------------------------------------------------------

export class EKF {
  private xHat: Matrix;   // current state estimate x̂
  private P: Matrix;      // current covariance P
  private f: (x: Matrix, dt: number) => Matrix; // process model
  private F: (x: Matrix, dt: number) => Matrix; // Jacobian of f
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
    f: (x: Matrix, dt: number) => Matrix;
    F: (x: Matrix, dt: number) => Matrix;
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
    if (!isFinite(dt) || dt <= 0) {
      throw new Error(`Invalid prediction interval: ${dt}`);
    }

    // x̂⁻ = f(x̂₋₁, u=0, w=0). The interval is passed explicitly so f/F/Q
    // always use the same dt, even if the caller holds other mutable state.
    const xBar = this.f(this.xHat, dt);

    // P⁻ = F · P₋₁ · Fᵀ + Q_d, with F evaluated at the prior state.
    const F = this.F(this.xHat, dt);

    const Ft = transpose(F);
    const F_P_Ft = multiply(multiply(F, this.P), Ft);

    // Q_d: if Q is a function of dt, call it; otherwise use the constant matrix
    const Qd = typeof this.Q === "function" ? this.Q(dt) : this.Q;

    this.P = add(F_P_Ft, Qd);
    this.xHat = xBar;
  }

  /** update(z) – incorporate a measurement vector z */
  update(z: Matrix): void {
    // Process the measurement components sequentially as scalar updates.
    //
    // Inverting the full innovation covariance S becomes numerically unstable
    // when two measurements are nearly collinear in the current prior (e.g.
    // range and range-rate from one ground station over a short arc, where
    // corr(range, range-rate) can approach 1). A near-singular S produces a
    // huge, essentially arbitrary gain. Sequential scalar updates with a
    // diagonal R never require inverting a near-singular matrix.
    //
    // This is a sequential iterated EKF: h/H are re-linearised after each
    // scalar correction. That is not algebraically identical to a single batch
    // update, but it is substantially more robust when the prior is far from
    // the measurement (e.g. the second sample of a 5-point full orbit). The
    // Joseph covariance form keeps P symmetric positive semidefinite.
    const Rfull = typeof this.R === "function" ? this.R(this.xHat) : this.R;
    if (Rfull.rows !== z.rows || Rfull.cols !== z.rows) {
      throw new Error(
        `R dimensions ${Rfull.rows}x${Rfull.cols} do not match ${z.rows} measurements`,
      );
    }

    // The scalar strategy is only valid for uncorrelated measurement noise.
    // Reject correlated R instead of silently dropping its off-diagonal terms.
    for (let i = 0; i < z.rows; i++) {
      for (let j = 0; j < z.rows; j++) {
        if (i === j) continue;
        const scale = Math.max(1, Math.abs(Rfull.data[i][i]), Math.abs(Rfull.data[j][j]));
        if (Math.abs(Rfull.data[i][j]) > 1e-12 * scale) {
          throw new Error(
            "Correlated measurement noise (off-diagonal R) is not supported",
          );
        }
      }
    }

    for (let i = 0; i < z.rows; i++) {
      const Rii = Rfull.data[i][i];
      if (!isFinite(Rii) || Rii < 0) {
        throw new Error(`Invalid measurement variance at index ${i}: ${Rii}`);
      }

      // Re-linearise at the current (partially corrected) state.
      const hAll = this.h(this.xHat);
      const HAll = this.H(this.xHat);
      if (hAll.rows !== z.rows || HAll.rows !== z.rows) {
        throw new Error(
          `Measurement model dimensions do not match ${z.rows} measurements`,
        );
      }

      const yi = z.data[i][0] - hAll.data[i][0];

      const Hi: Matrix = { data: [HAll.data[i].slice()], rows: 1, cols: HAll.cols };
      const Ht = transpose(Hi);
      const PHt = multiply(this.P, Ht); // n×1
      const S = multiply(Hi, PHt).data[0][0] + Rii; // scalar innovation variance

      if (!isFinite(S) || S <= 0) {
        throw new Error(`Invalid innovation variance at index ${i}: ${S}`);
      }

      // K = P Hᵀ / S  (n×1)
      const K = scalarMultiply(1 / S, PHt);
      this.xHat = add(this.xHat, scalarMultiply(yi, K));

      // Joseph-form covariance update for this scalar measurement:
      //   P = (I - K H) P (I - K H)ᵀ + K R Kᵀ
      const K_H = multiply(K, Hi);
      const I_n = identity(this.xHat.rows);
      const I_minus_KH = subtract(I_n, K_H);
      const A = multiply(multiply(I_minus_KH, this.P), transpose(I_minus_KH));
      const B = scalarMultiply(Rii, multiply(K, transpose(K)));
      const P_joseph = add(A, B);

      const P_sym: number[][] = P_joseph.data.map((row, r) =>
        row.map((val, c) => 0.5 * (val + P_joseph.data[c][r]))
      );
      this.P = { data: P_sym, rows: P_joseph.rows, cols: P_joseph.cols };
    }
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