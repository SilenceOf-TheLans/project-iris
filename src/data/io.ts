/**
 * CSV I/O module for the Project IRIS EKF simulator.
 *
 * Supports two CSV modes:
 *   - Mode 1: t,px,py,pz,vx,vy,vz,q0,q1,q2,q3   (quaternion orientation)
 *   - Mode 2: t,px,py,vx,vy                       (2D position + velocity)
 *
 * Exports types LoadedData / GeneratedPass, a CSV parser, and a synthetic
 * LEO pass generator for use when no data file is loaded.
 *
 * Data model:
 *   - time / position / velocity   : sparse measurements (what the EKF sees)
 *   - truthTime / truthPosition / truthVelocity : high-resolution clean truth
 *                                                from the two-body orbital equation
 */

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

/** Mode identifier: 'mode1' or 'mode2' */
export type CsvMode = 'mode1' | 'mode2';

/**
 * Parsed CSV row result from loadCSVText / loadCSVFile.
 * - time: scalar seconds
 * - position: 3-vector [x, y, z] in meters (Mode 1) or [x, y, 0] for Mode 2 — sparse measurement
 * - velocity: 3-vector [x, y, z] in m/s (Mode 2 z defaults to 0) — sparse measurement
 * - orientation: optional quaternion [q0, q1, q2, q3] (Mode 1 only)
 */
export interface ParsedRow {
  time: number;
  position: number[];
  velocity: number[];
  orientation?: number[];
}

/**
 * Loaded data from a CSV file or text string.
 * - time: array of measurement time stamps [s]
 * - position: array of sparse 3D position measurement vectors [[x, y, z], ...]
 * - velocity: array of sparse 3D velocity measurement vectors [[x, y, z], ...]
 * - truthTime: high-resolution truth time stamps [s] from the orbital equation
 * - truthPosition: clean truth position vectors from the orbital equation
 * - truthVelocity: clean truth velocity vectors from the orbital equation
 * - quaternion: optional array of quaternion quads [[q0, q1, q2, q3], ...] (Mode 1)
 */
export interface LoadedData {
  time: number[];
  position: number[][];
  velocity: number[][];
  truthTime: number[];
  truthPosition: number[][];
  truthVelocity: number[][];
  quaternion?: number[][];
}

/**
 * Generated synthetic LEO pass data.
 * Shares the same shape as LoadedData but is algorithmically generated.
 */
export interface GeneratedPass {
  time: number[];
  position: number[][];
  velocity: number[][];
  truthTime: number[];
  truthPosition: number[][];
  truthVelocity: number[][];
  quaternion?: number[][];
}

/**
 * Options for generating a synthetic LEO pass.
 */
export interface SyntheticPassOptions {
  /** Altitude above Earth surface in km (default: 300 km) */
  altitude?: number;
  /** Pass duration in seconds (default: 600 s) */
  duration?: number;
  /** Number of sparse measurement points (default: 80) */
  points?: number;
  /** Number of high-resolution truth points for smooth curve drawing (default: max(points*10, 360)) */
  truthPoints?: number;
  /** Standard deviation of measurement noise added to truth position (m, default: 0) */
  noiseStd?: number;
  /** Standard deviation of measurement noise added to truth velocity (m/s, default: 0) */
  noiseVelStd?: number;
}

// ---------------------------------------------------------------------------
// Constants for synthetic pass generation
// ---------------------------------------------------------------------------

/** Earth gravitational parameter μ = 3.986e14 m³/s² */
const MU: number = 3.986e14;

/** Earth equatorial radius in km */
const RE_KM: number = 6378.137;

/** Standard gravitational parameter in km³/s² */
const MU_KM3: number = 3.986e5; // 3.986e14 m³/s² = 3.986e5 km³/s²

// ---------------------------------------------------------------------------
// Helper: parse a single CSV line into fields
// ---------------------------------------------------------------------------

/**
 * Split a CSV line respecting simple comma separation (no quoting needed for
 * the numeric fields we handle).
 * Trims whitespace from each field.
 */
function parseCSVLine(line: string): string[] {
  return line.split(',').map((field) => field.trim());
}

// ---------------------------------------------------------------------------
// Helper: two-body orbital propagator (classical RK4)
// Used to generate high-resolution truth from an initial state.
// ---------------------------------------------------------------------------

/** One classical RK4 step of the two-body equations (state = [r, v]). */
function rk4Step(s: number[], h: number): number[] {
  const deriv = (y: number[]): number[] => {
    const rho = Math.max(1e-6, Math.sqrt(y[0] * y[0] + y[1] * y[1] + y[2] * y[2]));
    const k = -MU / (rho * rho * rho);
    return [y[3], y[4], y[5], k * y[0], k * y[1], k * y[2]];
  };
  const k1 = deriv(s);
  const s2 = s.map((v, i) => v + 0.5 * h * k1[i]);
  const k2 = deriv(s2);
  const s3 = s.map((v, i) => v + 0.5 * h * k2[i]);
  const k3 = deriv(s3);
  const s4 = s.map((v, i) => v + h * k3[i]);
  const k4 = deriv(s4);
  return s.map((v, i) => v + (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]));
}

/**
 * Propagate a two-body orbit from an initial state using RK4 with 5-second
 * substeps. Returns arrays of time/position/velocity at `numSteps` evenly
 * spaced times from t=0 to t=durationS.
 *
 * State: [rx, ry, rz, vx, vy, vz] in meters and m/s.
 */
function propagateTwoBodyTruth(
  r0: number[],
  v0: number[],
  durationS: number,
  numSteps: number
): { time: number[]; position: number[][]; velocity: number[][] } {
  const dt = numSteps > 1 ? durationS / (numSteps - 1) : 0;

  const times: number[] = [];
  const positions: number[][] = [];
  const velocities: number[][] = [];

  let s = [...r0, ...v0];

  for (let i = 0; i < numSteps; i++) {
    times.push(i * dt);
    positions.push([s[0], s[1], s[2]]);
    velocities.push([s[3], s[4], s[5]]);

    if (i === numSteps - 1) break;

    // RK4 is stable for much larger steps; 5 s keeps the integration error
    // far below the measurement noise even over many orbital periods.
    const nSub = Math.max(1, Math.ceil(dt / 5));
    const h = dt / nSub;
    for (let k = 0; k < nSub; k++) s = rk4Step(s, h);
  }

  return { time: times, position: positions, velocity: velocities };
}

// ---------------------------------------------------------------------------
// Helper: cubic Hermite interpolation of the truth trajectory
// ---------------------------------------------------------------------------

/**
 * Interpolate the clean truth position/velocity at an arbitrary time using
 * cubic Hermite interpolation (position + velocity at both ends). This is
 * accurate to well below 1 m for the 10–100 s truth grid spacing used here,
 * unlike nearest-neighbour lookup which can be tens of kilometres off along
 * track when a measurement falls between truth samples.
 */
export function interpolateTruth(
  data: { truthTime: number[]; truthPosition: number[][]; truthVelocity: number[][] },
  t: number
): { position: number[]; velocity: number[] } {
  const times = data.truthTime;
  const n = times.length;
  if (n === 0) return { position: [0, 0, 0], velocity: [0, 0, 0] };
  if (n === 1 || t <= times[0]) {
    return { position: [...data.truthPosition[0]], velocity: [...data.truthVelocity[0]] };
  }
  if (t >= times[n - 1]) {
    return { position: [...data.truthPosition[n - 1]], velocity: [...data.truthVelocity[n - 1]] };
  }

  // Binary search for the bracketing interval [lo, hi].
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }

  const t0 = times[lo];
  const t1 = times[hi];
  const h = Math.max(1e-9, t1 - t0);
  const s = (t - t0) / h;
  const s2 = s * s;
  const s3 = s2 * s;

  // Hermite basis functions and their derivatives with respect to s.
  const h00 = 2 * s3 - 3 * s2 + 1;
  const h10 = s3 - 2 * s2 + s;
  const h01 = -2 * s3 + 3 * s2;
  const h11 = s3 - s2;
  const d00 = 6 * s2 - 6 * s;
  const d10 = 3 * s2 - 4 * s + 1;
  const d01 = -6 * s2 + 6 * s;
  const d11 = 3 * s2 - 2 * s;

  const p0 = data.truthPosition[lo];
  const p1 = data.truthPosition[hi];
  const v0 = data.truthVelocity[lo];
  const v1 = data.truthVelocity[hi];

  const position = [0, 1, 2].map(
    (i) => h00 * p0[i] + h10 * h * v0[i] + h01 * p1[i] + h11 * h * v1[i]
  );
  const velocity = [0, 1, 2].map(
    (i) => (d00 * p0[i] + d10 * h * v0[i] + d01 * p1[i] + d11 * h * v1[i]) / h
  );

  return { position, velocity };
}

// ---------------------------------------------------------------------------
// Mode detection
// ---------------------------------------------------------------------------

/**
 * Detect the CSV mode from the header line.
 * Returns 'mode1' or 'mode2', or throws if the header is unrecognised.
 */
function detectMode(header: string): CsvMode {
  const tokens = parseCSVLine(header);
  const first = tokens[0].toLowerCase().trim();

  if (first !== 't') {
    throw new Error(`Invalid CSV header: expected 't' as first column, got '${first}'`);
  }

  // Mode 1 has 11 fields: t,px,py,pz,vx,vy,vz,q0,q1,q2,q3
  // Mode 2 has 5 fields: t,px,py,vx,vy
  if (tokens.length === 11) {
    return 'mode1';
  }
  if (tokens.length === 5) {
    return 'mode2';
  }

  // Heuristic: check column names
  const second = tokens[1]?.toLowerCase().trim();
  if (second && second.startsWith('p') && tokens.length === 5) {
    return 'mode2';
  }
  if (second && second.startsWith('q') && tokens.length === 11) {
    return 'mode1';
  }

  throw new Error(
    `Unrecognised CSV header (${tokens.length} columns). Expected Mode 1 (11 columns) or Mode 2 (5 columns).`
  );
}

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

/**
 * Parse a CSV text string into LoadedData.
 * Auto-detects mode from the header row.
 * Throws on malformed CSV.
 *
 * The CSV position/velocity columns are treated as SPARSE MEASUREMENTS.
 * A high-resolution truth trajectory is regenerated from the two-body orbital
 * equation using the first measurement as the initial state.
 *
 * @param text - Raw CSV text string
 * @returns LoadedData value with sparse measurements and high-resolution equation truth
 */
export function loadCSVText(text: string): LoadedData {
  // Trim and split into lines, skip empty trailing lines
  const lines = text.trim().split('\n').filter((line) => line.trim().length > 0);

  if (lines.length === 0) {
    throw new Error('Empty CSV text');
  }

  // Detect mode from header
  const mode = detectMode(lines[0]);

  // Parse sparse measurement rows
  const measTimes: number[] = [];
  const measPositions: number[][] = [];
  const measVelocities: number[][] = [];
  const quaternions: number[][] | undefined = mode === 'mode1' ? [] : undefined;

  for (let i = 1; i < lines.length; i++) {
    const row = parseCSVLine(lines[i]);

    // Skip empty rows
    if (row.length === 0 || row.every((f) => f === '')) {
      continue;
    }

    // Validate column count
    if (mode === 'mode1' && row.length !== 11) {
      throw new Error(
        `Mode 1 row ${i + 1}: expected 11 fields, got ${row.length}: ${lines[i]}`
      );
    }
    if (mode === 'mode2' && row.length !== 5) {
      throw new Error(
        `Mode 2 row ${i + 1}: expected 5 fields, got ${row.length}: ${lines[i]}`
      );
    }

    const t = parseFloat(row[0]);
    if (isNaN(t)) {
      throw new Error(`Row ${i + 1}: invalid time value '${row[0]}'`);
    }

    measTimes.push(t);

    if (mode === 'mode1') {
      // Mode 1: t,px,py,pz,vx,vy,vz,q0,q1,q2,q3
      const px = parseFloat(row[1]);
      const py = parseFloat(row[2]);
      const pz = parseFloat(row[3]);
      const vx = parseFloat(row[4]);
      const vy = parseFloat(row[5]);
      const vz = parseFloat(row[6]);
      const q0 = parseFloat(row[7]);
      const q1 = parseFloat(row[8]);
      const q2 = parseFloat(row[9]);
      const q3 = parseFloat(row[10]);

      if (isNaN(px) || isNaN(py) || isNaN(pz) || isNaN(vx) || isNaN(vy) || isNaN(vz)) {
        throw new Error(`Row ${i + 1}: invalid numeric value in position/velocity fields`);
      }
      if (isNaN(q0) || isNaN(q1) || isNaN(q2) || isNaN(q3)) {
        throw new Error(`Row ${i + 1}: invalid quaternion value in q0..q3 fields`);
      }

      measPositions.push([px, py, pz]);
      measVelocities.push([vx, vy, vz]);
      quaternions!.push([q0, q1, q2, q3]);
    } else {
      // Mode 2: t,px,py,vx,vy
      const px = parseFloat(row[1]);
      const py = parseFloat(row[2]);
      const vx = parseFloat(row[3]);
      const vy = parseFloat(row[4]);

      if (isNaN(px) || isNaN(py) || isNaN(vx) || isNaN(vy)) {
        throw new Error(`Row ${i + 1}: invalid numeric value in position/velocity fields`);
      }

      // Mode 2 has 2D position; store as 3D with z = 0
      measPositions.push([px, py, 0]);
      measVelocities.push([vx, vy, 0]);
    }
  }

  // If no data rows were parsed but we have a header, return empty structures
  if (measTimes.length === 0) {
    return {
      time: [],
      position: [],
      velocity: [],
      truthTime: [],
      truthPosition: [],
      truthVelocity: [],
      quaternion: undefined,
    };
  }

  // ---- Generate high-resolution equation-based truth ----
  // Use the first measurement as the initial state and propagate two-body
  // over the full duration. This gives a smooth orbital curve independent
  // of how sparse the measurements are.
  const durationS = measTimes[measTimes.length - 1] - measTimes[0];
  const numTruthPoints = Math.max(measTimes.length * 10, 360);
  const truth = propagateTwoBodyTruth(
    measPositions[0],
    measVelocities[0],
    durationS,
    numTruthPoints
  );

  return {
    time: measTimes,
    position: measPositions,
    velocity: measVelocities,
    // Shift the 0-based propagation times onto the CSV's absolute time axis.
    truthTime: truth.time.map((t) => measTimes[0] + t),
    truthPosition: truth.position,
    truthVelocity: truth.velocity,
    quaternion: quaternions,
  };
}

/**
 * Load a File object (selected via <input type="file">) and parse it as CSV.
 * Uses FileReader under the hood.
 *
 * @param file - File object (typically from file input)
 * @returns Promise resolving to LoadedData
 */
export async function loadCSVFile(file: File): Promise<LoadedData> {
  const text = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const target = e.target as FileReader & { result: string };
      resolve(target.result);
    };
    reader.onerror = () => reject(new Error(`Failed to read file: ${file.name}`));
    reader.readAsText(file);
  });

  return loadCSVText(text);
}

// ---------------------------------------------------------------------------
// Synthetic LEO pass generation
// ---------------------------------------------------------------------------

/**
 * Generate a synthetic LEO pass in circular orbit.
 *
 * Physics:
   - Orbital radius r = RE + altitude
   - Angular velocity ω = √(μ / r³)  (μ = 3.986e14 m³/s²)
   - Position: r·[cos(ωt), sin(ωt), 0]  (equatorial, reference plane)
   - Velocity: rω·[−sin(ωt), cos(ωt), 0]
   - Truth is generated at high resolution for smooth curve drawing.
   - Measurements are sparse samples of truth + noise.

 * Quaternion generation: for each step we produce a small rotation from the
 * identity quaternion that represents the local "down-track" frame orientation.
 * This is sufficient for EKF attitude observation models that need a quaternion
 * state but not a full realistic attitude trajectory.
 *
 * @param options - Altitude in km (default 300), duration in s (default 600),
 *   number of sparse measurement points (default 80), number of truth points
 *   (default max(points*10, 360)), noise std devs (default 0)
 * @returns GeneratedPass with sparse measurements and high-resolution equation truth
 */
export function generateSyntheticPass(
  options?: SyntheticPassOptions
): GeneratedPass {
  const opts = {
    altitude: 300, // km default
    duration: 600, // s default
    points: 80, // default sparse measurement points
    truthPoints: undefined, // computed below
    noiseStd: 0, // m default — no measurement noise on truth
    noiseVelStd: 0, // m/s default — no measurement noise on truth velocity
    ...options,
  };

  const altitude: number = opts.altitude;
  const duration: number = opts.duration;
  const numPoints: number = Math.max(1, Math.min(opts.points, 5000));
  const numTruthPoints: number = opts.truthPoints ?? Math.max(numPoints * 10, 360);
  const noiseStd: number = opts.noiseStd ?? 0;
  const noiseVelStd: number = opts.noiseVelStd ?? 0;

  // Validate
  if (duration <= 0) {
    throw new Error('Duration must be positive');
  }
  if (numPoints < 2) {
    throw new Error('Number of points must be at least 2');
  }
  if (altitude < -RE_KM + 1) {
    throw new Error('Altitude is too low (would be inside Earth)');
  }

  // Orbital radius in km
  const rKm: number = RE_KM + altitude;

  // Gravitational parameter in km³/s²: μ = 3.986e14 m³/s² = 3.986e5 km³/s²
  const muKm3: number = 3.986e5;

  // Angular velocity ω = √(μ / r³)  [rad/s] — using km units, μ in km³/s²
  const omega: number = Math.sqrt(muKm3 / (rKm * rKm * rKm));

  // ---- HIGH-RESOLUTION TRUTH from orbit equation ----
  const truthDt: number = duration / (numTruthPoints - 1);
  const truthTimes: number[] = [];
  const truthPositions: number[][] = [];
  const truthVelocities: number[][] = [];

  for (let i = 0; i < numTruthPoints; i++) {
    const t = i * truthDt;
    const theta: number = omega * t;

    const xKm: number = rKm * Math.cos(theta);
    const yKm: number = rKm * Math.sin(theta);
    const zKm: number = 0;

    truthTimes.push(t);
    truthPositions.push([xKm * 1000, yKm * 1000, zKm * 1000]); // meters

    const vxKmS: number = -rKm * omega * Math.sin(theta);
    const vyKmS: number = rKm * omega * Math.cos(theta);
    const vzKmS: number = 0;

    truthVelocities.push([vxKmS * 1000, vyKmS * 1000, vzKmS * 1000]); // m/s
  }

  // ---- SPARSE MEASUREMENTS = truth + noise at numPoints ----
  const measDt: number = numPoints > 1 ? duration / (numPoints - 1) : 0;
  const measTimes: number[] = [];
  const measPositions: number[][] = [];
  const measVelocities: number[][] = [];
  const quaternions: number[][] | undefined = [];

  // Helper: Gaussian random number (Box-Muller)
  function randn(): number {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  for (let i = 0; i < numPoints; i++) {
    const t = i * measDt;
    measTimes.push(t);

    // Evaluate the orbit equation at the exact measurement time. (Looking up a
    // nearby truth-grid sample would introduce a systematic along-track error
    // whenever the measurement time falls between truth samples.)
    const thetaM: number = omega * t;
    const tx: number = rKm * 1000 * Math.cos(thetaM);
    const ty: number = rKm * 1000 * Math.sin(thetaM);
    const tz: number = 0;
    const tvx: number = -rKm * 1000 * omega * Math.sin(thetaM);
    const tvy: number = rKm * 1000 * omega * Math.cos(thetaM);
    const tvz: number = 0;

    // Measurement = truth + noise
    const mx = noiseStd > 0 ? tx + randn() * noiseStd : tx;
    const my = noiseStd > 0 ? ty + randn() * noiseStd : ty;
    const mz = noiseStd > 0 ? tz + randn() * noiseStd : tz;
    measPositions.push([mx, my, mz]);

    const mvx = noiseVelStd > 0 ? tvx + randn() * noiseVelStd : tvx;
    const mvy = noiseVelStd > 0 ? tvy + randn() * noiseVelStd : tvy;
    const mvz = noiseVelStd > 0 ? tvz + randn() * noiseVelStd : tvz;
    measVelocities.push([mvx, mvy, mvz]);

    // Quaternion for this measurement step
    const qAngle: number = 0.005 * (i + 1);
    const sinHalf = Math.sin(qAngle / 2);
    const cosHalf = Math.cos(qAngle / 2);
    quaternions!.push([cosHalf, 0, 0, sinHalf]);
  }

  return {
    time: measTimes,
    position: measPositions,
    velocity: measVelocities,
    truthTime: truthTimes,
    truthPosition: truthPositions,
    truthVelocity: truthVelocities,
    quaternion: quaternions.length > 0 ? quaternions : undefined,
  };
}
