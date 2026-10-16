/**
 * Metrics module for the EKF Simulator.
 * Computes NIS (Normalized Innovation Squared), NEES (Normalized Estimation Error Squared),
 * chi-squared bounds, and chart data for visualization.
 */

import { Matrix } from "../types";

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
// Helper: inverse of a square matrix using Gaussian elimination with partial pivoting
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
    // Find pivot row
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
// χ² inverse (quantile function)
// Uses a direct lookup table for common degrees of freedom (1–15) and
// probabilities (0.01, 0.025, 0.05, 0.95, 0.975, 0.99).
// For other values, the Wilson-Hilferty transformation is used with a
// simple normal-quantile approximation.
// ---------------------------------------------------------------------------

// χ² quantile lookup table: df (1–15) → [0.01, 0.025, 0.05, 0.95, 0.975, 0.99]
const CHI2_TABLE: Record<number, number[]> = {
  1: [0.0002, 0.001, 0.0039, 3.841, 5.024, 6.635],
  2: [0.0201, 0.0506, 0.1026, 5.991, 7.378, 9.210],
  3: [0.1148, 0.2158, 0.3518, 7.815, 9.348, 11.345],
  4: [0.2971, 0.4844, 0.7107, 9.488, 11.143, 13.277],
  5: [0.5543, 0.8312, 1.1455, 11.070, 12.833, 15.086],
  6: [0.8721, 1.2373, 1.6354, 12.592, 14.449, 16.812],
  7: [1.2390, 1.6899, 2.1673, 14.067, 16.013, 18.475],
  8: [1.6465, 2.1797, 2.7326, 15.507, 17.535, 20.090],
  9: [2.0879, 2.7004, 3.3251, 16.919, 19.023, 21.666],
  10: [2.5582, 3.2470, 3.9403, 18.307, 20.483, 23.209],
  11: [3.0535, 3.8157, 4.5748, 19.675, 21.920, 24.725],
  12: [3.5706, 4.4038, 5.2260, 21.026, 23.337, 26.217],
  13: [4.1069, 5.0088, 5.8919, 22.362, 24.736, 27.688],
  14: [4.6604, 5.6287, 6.5706, 23.685, 26.119, 29.141],
  15: [5.2293, 6.2621, 7.2609, 25.000, 27.488, 30.578],
};

/**
 * Simple normal quantile (probit) approximation using the Hart approximation.
 * Accurate to ~1e-4 for p in (0,1), sufficient for χ² inverse via Wilson-Hilferty.
 */
function normalQuantile(p: number): number {
  if (p <= 0 || p >= 1) throw new Error(`Invalid probability: ${p}`);
  if (p === 0.5) return 0;

  // Use the Hart (1968) approximation for the normal quantile.
  // Coefficients from Hart 1968, Biometrika 55, 324–327.
  const sign = p < 0.5 ? -1 : 1;
  const q = p < 0.5 ? p : 1 - p;

  if (q < 1e-8) {
    // extreme tail: use asymptotic approximation
    return sign * Math.sqrt(-2 * Math.log(q));
  }

  // Rational approximation using the Hart formula
  const c0 = 2.515517;
  const c1 = 0.802853;
  const c2 = 0.010328;
  const d1 = 1.432788;
  const d2 = 0.189269;

  const t = Math.sqrt(-2 * Math.log(q));
  const num = c0 + c1 * t + c2 * t * t;
  const den = 1 + d1 * t + d2 * t * t;

  const z = t - num / den;
  return sign * z;
}

// ---------------------------------------------------------------------------
// χ² inverse (quantile function)
// Maps a probability p to the χ² quantile with given degrees of freedom.
// Uses direct lookup for df in 1..15 and the Wilson-Hilferty transformation
// for intermediate dfs or probabilities not in the table.
// ---------------------------------------------------------------------------

export function chi2Inverse(probability: number, degreesOfFreedom: number): number {
  // Clamp degrees of freedom to table range
  let df = degreesOfFreedom;
  if (df < 1) df = 1;
  if (df > 15) df = 15;

  // Check if we have an exact match in the lookup table
  const tableRow = CHI2_TABLE[df];
  if (tableRow) {
    const probs = [0.01, 0.025, 0.05, 0.95, 0.975, 0.99];
    for (let i = 0; i < probs.length; i++) {
      if (Math.abs(probs[i] - probability) < 1e-10) {
        return tableRow[i];
      }
    }
  }

  // Wilson-Hilferty transformation:
  // If (X/df)^(1/3) ~ N(1 - 2/(9df), 2/(9df)), then
  // X = df * (z * sqrt(2/(9df)) + (1 - 2/(9df)))^3
  // where z = normalQuantile(probability)

  const z = normalQuantile(probability);
  const c1 = 1 - 2 / (9 * df);
  const c2 = Math.sqrt(2 / (9 * df));
  const X = df * Math.pow(z * c2 + c1, 3);

  // χ² is non-negative; return clamped value
  return Math.max(X, 0);
}

// ---------------------------------------------------------------------------
// computeNIS
// ε_k = yᵀ · S⁻¹ · y
// where y = innovation = z - h(x̂⁻) (residual)
// S = innovation covariance = H · P⁻ · Hᵀ + R
// The function takes the innovation vector y and the innovation covariance S,
// and returns the scalar NIS value.
// ---------------------------------------------------------------------------

export function computeNIS(innovation: Matrix, innovationCovariance: Matrix): number {
  // S⁻¹
  const Sinv = invert(innovationCovariance);

  // y is a column vector (n×1). Compute yᵀ · S⁻¹ · y (quadratic form).
  // yᵀ is 1×n, S⁻¹ is n×n → yᵀ · S⁻¹ is 1×n, then (yᵀ · S⁻¹) · y is 1×1 scalar.
  const yT = transpose(innovation); // 1×n
  const yT_Sinv = multiply(yT, Sinv); // 1×n
  const result = multiply(yT_Sinv, innovation); // 1×1 scalar

  return result.data[0][0];
}

// ---------------------------------------------------------------------------
// computeNEES
// α_k = (x − x̂)ᵀ · P⁻¹ · (x − x̂)
// where x = true state, x̂ = estimated state, P = estimation covariance
// For a 6-state EKF, α_k should hover near χ²(6) bounds.
// ---------------------------------------------------------------------------

export function computeNEES(
  trueState: Matrix,
  estimatedState: Matrix,
  covariance: Matrix
): number {
  // P⁻¹
  const Pinv = invert(covariance);

  // error = x - x̂ (column vector, n×1)
  const error = subtract(trueState, estimatedState);

  // errorᵀ · P⁻¹ · error (quadratic form)
  const errorT = transpose(error); // 1×n
  const errorT_Pinv = multiply(errorT, Pinv); // 1×n
  const result = multiply(errorT_Pinv, error); // 1×1 scalar

  return result.data[0][0];
}

// ---------------------------------------------------------------------------
// getNisBounds
// Returns [lower, upper] χ² bounds for the given confidence level (default 0.95).
// The bounds enclose the central `confidence` portion of the χ² distribution:
//   lower = χ²_{(1-confidence)/2, df}
//   upper = χ²_{1-(1-confidence)/2, df}
// ---------------------------------------------------------------------------

export function getNisBounds(
  degreesOfFreedom: number,
  confidence: number = 0.95
): [number, number] {
  const alpha = 1 - confidence;
  const lowerProb = alpha / 2;
  const upperProb = 1 - alpha / 2;

  const lower = chi2Inverse(lowerProb, degreesOfFreedom);
  const upper = chi2Inverse(upperProb, degreesOfFreedom);

  return [lower, upper];
}

// ---------------------------------------------------------------------------
// ChartData type
// Represents chart data as { x: number[], y: number[] } mapping time/index → value.
// ---------------------------------------------------------------------------

export interface ChartData {
  x: number[];
  y: number[];
}

// ---------------------------------------------------------------------------
// nisChartData
// Generates data for NIS chart plotting.
// If `time` is provided and has the same length as `nisValues`, x uses time stamps.
// Otherwise, x uses sequential indices (0, 1, 2, …).
// ---------------------------------------------------------------------------

export function nisChartData(
  nisValues: number[],
  time?: number[]
): ChartData {
  if (time && time.length === nisValues.length) {
    return { x: time, y: nisValues };
  }
  const xValues = Array.from({ length: nisValues.length }, (_, i) => i);
  return { x: xValues, y: nisValues };
}

// ---------------------------------------------------------------------------
// neesChartData
// Generates data for NEES chart plotting.
// If `time` is provided and has the same length as `neesValues`, x uses time stamps.
// Otherwise, x uses sequential indices (0, 1, 2, …).
// ---------------------------------------------------------------------------

export function neesChartData(
  neesValues: number[],
  time?: number[]
): ChartData {
  if (time && time.length === neesValues.length) {
    return { x: time, y: neesValues };
  }
  const xValues = Array.from({ length: neesValues.length }, (_, i) => i);
  return { x: xValues, y: neesValues };
}