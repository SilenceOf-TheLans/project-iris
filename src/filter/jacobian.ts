/**
 * Jacobian module for the EKF Simulator.
 * Provides numerical Jacobian computation via central differencing as a
 * fallback when analytic Jacobians are not available.
 *
 * Central difference formula:
 *   J[i,j] = (f_i(x + h*e_j) - f_i(x - h*e_j)) / (2h)
 * where h = sqrt(eps) * max(|x_j|, 1), with eps ≈ 2.22e-16 (machine precision).
 * A fixed h = 1e-4 is used as a reasonable default for aerospace applications.
 */

// Machine epsilon (floating-point precision)
const EPSILON: number = 2.22e-16;

/** Default step size factor for aerospace applications. */
const DEFAULT_H_FACTOR: number = 1e-4;

// ---------------------------------------------------------------------------
// Core: numericJacobian
// ---------------------------------------------------------------------------

/**
 * Compute the Jacobian matrix J = ∂f/∂x evaluated at x using central differencing.
 *
 * Given f: ℝⁿ → ℝᵐ and a point x ∈ ℝⁿ, the Jacobian J is m×n with entries:
 *   J[i,j] = (f_i(x + h·e_j) - f_i(x - h·e_j)) / (2h)
 *
 * where h = √ε · max(|x_j|, 1) per-component, or a fixed h if specified.
 *
 * @param f - Function f: ℝⁿ → ℝᵐ, taking an n-dimensional vector and returning an m-dimensional vector
 * @param x - The n-dimensional point at which to evaluate the Jacobian
 * @param h - Optional step size. If not provided, uses h = 1e-4 default.
 * @returns The m×n Jacobian matrix (m rows, n columns)
 *
 * @example
 * // Jacobian of f(x) = [x₁², x₂³] at x = [1, 2]
 * const f = (x: number[]) => [x[0] * x[0], x[1] * x[1] * x[1]];
 * const x = [1, 2];
 * const J = numericJacobian(f, x);
// J ≈ [[2, 0], [0, 12]]
 */
export function numericJacobian(
  f: (x: number[]) => number[],
  x: number[],
  h?: number
): number[][] {
  // Handle edge cases
  if (x.length === 0) {
    // Empty state: return empty matrix
    return [];
  }

  // Evaluate f at x to determine output dimension m
  const f_x = f(x);
  const m = f_x.length;
  const n = x.length;

  // If m is 0, return an m×n matrix of zeros (0×n)
  if (m === 0) {
    return new Array(m).fill(0).map(() => new Array(n).fill(0));
  }

  // Resolve step size: use 1e-4 if h is undefined or non-positive
  const stepSize: number = h !== undefined && h > 0 ? h : DEFAULT_H_FACTOR;

  // Compute the Jacobian using central differencing
  // J[i][j] = (f_i(x + h*e_j) - f_i(x - h*e_j)) / (2h)
  const J: number[][] = new Array(m)
    .fill(0)
    .map(() => new Array(n).fill(0));

  for (let j = 0; j < n; j++) {
    // Perturbation vector e_j (unit vector in direction j)
    const xPlus: number[] = [...x];
    const xMinus: number[] = [...x];

    xPlus[j] = x[j] + stepSize;
    xMinus[j] = x[j] - stepSize;

    const fPlus = f(xPlus);
    const fMinus = f(xMinus);

    // For each output dimension i
    for (let i = 0; i < m; i++) {
      J[i][j] = (fPlus[i] - fMinus[i]) / (2 * stepSize);
    }
  }

  return J;
}

// ---------------------------------------------------------------------------
// High-level: ekfJacobianF
// ---------------------------------------------------------------------------

/**
 * Compute the process-model Jacobian F for an EKF.
 *
 * If an analytic Jacobian function F_analytic is provided, it is used directly.
 * Otherwise, numericJacobian is used as a fallback.
 *
 * @param f - The process model function: f(x: number[]): number[]
 * @param x - The n-dimensional state point at which to evaluate the Jacobian
 * @param F_analytic - Optional analytic Jacobian: F_analytic(x: number[]): number[][]
 *                     (m×n matrix). If provided, this is returned directly.
 * @param h - Optional step size for numeric fallback. See numericJacobian.
 * @returns The m×n Jacobian matrix F = ∂f/∂x evaluated at x
 *
 * @example
 * // With analytic Jacobian
 * const F = ekfJacobianF(f, x, F_analytic);
 * // Without analytic Jacobian (numeric fallback):
 * const F = ekfJacobianF(f, x);
 */
export function ekfJacobianF(
  f: (x: number[]) => number[],
  x: number[],
  F_analytic?: (x: number[]) => number[][],
  h?: number
): number[][] {
  if (F_analytic !== undefined) {
    // Use analytic Jacobian if provided
    const analyticResult: number[][] = F_analytic(x);
    return analyticResult;
  }
  // Fall back to numerical differentiation
  return numericJacobian(f, x, h);
}

// ---------------------------------------------------------------------------
// High-level: measurementJacobianH
// ---------------------------------------------------------------------------

/**
 * Compute the measurement-model Jacobian H for an EKF.
 *
 * If an analytic Jacobian function H_analytic is provided, it is used directly.
 * Otherwise, numericJacobian is used as a fallback.
 *
 * @param measurementFn - The measurement model function: h(x: number[]): number[]
 * @param x - The n-dimensional state point at which to evaluate the Jacobian
 * @param H_analytic - Optional analytic Jacobian: H_analytic(x: number[]): number[][]
 *                     (m×n matrix). If provided, this is returned directly.
 * @param h - Optional step size for numeric fallback. See numericJacobian.
 * @returns The m×n Jacobian matrix H = ∂h/∂x evaluated at x
 *
 * @example
 * // With analytic Jacobian
 * const H = measurementJacobianH(measurementFn, x, H_analytic);
 * // Without analytic Jacobian (numeric fallback):
 * const H = measurementJacobianH(measurementFn, x);
 */
export function measurementJacobianH(
  measurementFn: (x: number[]) => number[],
  x: number[],
  H_analytic?: (x: number[]) => number[][],
  h?: number
): number[][] {
  if (H_analytic !== undefined) {
    // Use analytic Jacobian if provided
    const analyticResult: number[][] = H_analytic(x);
    return analyticResult;
  }
  // Fall back to numerical differentiation
  return numericJacobian(measurementFn, x, h);
}