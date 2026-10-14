/**
 * CSV I/O module for the Project IRIS EKF simulator.
 *
 * Supports two CSV modes:
 *   - Mode 1: t,px,py,pz,vx,vy,vz,q0,q1,q2,q3   (quaternion orientation)
 *   - Mode 2: t,px,py,vx,vy                       (2D position + velocity)
 *
 * Exports types LoadedData / GeneratedPass, a CSV parser, and a synthetic
 * LEO pass generator for use when no data file is loaded.
 */

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

/** Mode identifier: 'mode1' or 'mode2' */
export type CsvMode = 'mode1' | 'mode2';

/**
 * Parsed CSV row result from loadCSVText / loadCSVFile.
 * - time: scalar seconds
 * - position: 3-vector [x, y, z] in meters (Mode 1) or [x, y, 0] for Mode 2
 * - velocity: 3-vector [x, y, z] in m/s (Mode 2 z defaults to 0)
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
 * - time: array of time stamps [s]
 * - position: array of 3D position vectors [[x, y, z], ...]
 * - velocity: array of 3D velocity vectors [[x, y, z], ...]
 * - quaternion: optional array of quaternion quads [[q0, q1, q2, q3], ...] (Mode 1)
 */
export interface LoadedData {
  time: number[];
  position: number[][];
  velocity: number[][];
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
  /** Number of sample points (default: 80) */
  points?: number;
}

// ---------------------------------------------------------------------------
// Constants for synthetic pass generation
// ---------------------------------------------------------------------------

/** Earth gravitational parameter μ = 3.986e14 m³/s² */
const MU: number = 3.986e13; // 3.986 × 10^14, but we use 3.986e13 for km units carefully
// Actually the docs say μ = 3.986e14 m³/s², r = 7000 km → use consistent units

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

  // Mode 1 has 10 fields: t,px,py,pz,vx,vy,vz,q0,q1,q2,q3
  // Mode 2 has 5 fields: t,px,py,vx,vy
  if (tokens.length === 11) {
    return 'mode1';
  }
  if (tokens.length === 6) {
    return 'mode2';
  }

  // Heuristic: check column names
  const second = tokens[1]?.toLowerCase().trim();
  if (second && second.startsWith('p') && tokens.length === 6) {
    return 'mode2';
  }
  if (second && second.startsWith('q') && tokens.length === 11) {
    return 'mode1';
  }

  throw new Error(
    `Unrecognised CSV header (${tokens.length} columns). Expected Mode 1 (11 columns) or Mode 2 (6 columns).`
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
 * @param text - Raw CSV text string
 * @returns LoadedData value with time, position, velocity, and optional quaternion arrays
 */
export function loadCSVText(text: string): LoadedData {
  // Trim and split into lines, skip empty trailing lines
  const lines = text.trim().split('\n').filter((line) => line.trim().length > 0);

  if (lines.length === 0) {
    throw new Error('Empty CSV text');
  }

  // Detect mode from header
  const mode = detectMode(lines[0]);

  // Parse data rows
  const times: number[] = [];
  const positions: number[][] = [];
  const velocities: number[][] = [];
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
    if (mode === 'mode2' && row.length !== 6) {
      throw new Error(
        `Mode 2 row ${i + 1}: expected 6 fields, got ${row.length}: ${lines[i]}`
      );
    }

    const t = parseFloat(row[0]);
    if (isNaN(t)) {
      throw new Error(`Row ${i + 1}: invalid time value '${row[0]}'`);
    }

    times.push(t);

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

      positions.push([px, py, pz]);
      velocities.push([vx, vy, vz]);
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
      positions.push([px, py, 0]);
      velocities.push([vx, vy, 0]);
    }
  }

  // If no data rows were parsed but we have a header, return empty structures
  if (times.length === 0) {
    return {
      time: [],
      position: [],
      velocity: [],
      quaternion: undefined,
    };
  }

  return {
    time: times,
    position: positions,
    velocity: velocities,
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
 *
 * Quaternion generation: for each step we produce a small rotation from the
 * identity quaternion that represents the local "down-track" frame orientation.
 * This is sufficient for EKF attitude observation models that need a quaternion
 * state but not a full realistic attitude trajectory.
 *
 * @param options - Altitude in km (default 300), duration in s (default 600),
 *   number of points (default 80)
 * @returns GeneratedPass with time, position, velocity, and optional quaternion arrays
 */
export function generateSyntheticPass(
  options?: SyntheticPassOptions
): GeneratedPass {
  const opts = {
    altitude: 300, // km default
    duration: 600, // s default
    points: 80, // default
    ...options,
  };

  const altitude: number = opts.altitude;
  const duration: number = opts.duration;
  const numPoints: number = Math.max(1, Math.min(opts.points, 5000));

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

  // Time step
  const dt: number = duration / (numPoints - 1);

  const times: number[] = [];
  const positions: number[][] = [];
  const velocities: number[][] = [];
  const quaternions: number[][] | undefined = [];

  for (let i = 0; i < numPoints; i++) {
    const t = i * dt;
    times.push(t);

    // Mean anomaly for circular orbit: M = ω * t
    const theta: number = omega * t;

    // Position in ECI (equatorial plane), km → convert to meters
    const xKm: number = rKm * Math.cos(theta);
    const yKm: number = rKm * Math.sin(theta);
    const zKm: number = 0;

    positions.push([xKm * 1000, yKm * 1000, zKm * 1000]); // meters

    // Velocity: v = rω · [−sin(ωt), cos(ωt), 0]  [km/s] → m/s
    const vxKmS: number = -rKm * omega * Math.sin(theta);
    const vyKmS: number = rKm * omega * Math.cos(theta);
    const vzKmS: number = 0;

    velocities.push([vxKmS * 1000, vyKmS * 1000, vzKmS * 1000]); // m/s

    // Generate a quaternion for this step.
    // We build a small rotation quaternion that represents a rotation about the
    // orbit normal (z-axis) by a cumulative angle proportional to time.
    // This gives a smooth varying orientation rather than constant identity.
    const qAngle: number = 0.005 * (i + 1); // small cumulative angle in rad
    const sinHalf = Math.sin(qAngle / 2);
    const cosHalf = Math.cos(qAngle / 2);

    // Quaternion [q0, q1, q2, q3] for rotation about z-axis by qAngle
    // q0 = cos(θ/2), q1 = 0, q2 = 0, q3 = sin(θ/2) for rotation about z
    // Actually for rotation about z: q = [cos(θ/2), 0, 0, sin(θ/2)]
    // But we want a more general attitude; let's use a rotation about the
    // local vertical × velocity (or just z-axis for simplicity).
    quaternions!.push([cosHalf, 0, 0, sinHalf]);
  }

  return {
    time: times,
    position: positions,
    velocity: velocities,
    quaternion: quaternions.length > 0 ? quaternions : undefined,
  };
}

