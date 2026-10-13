/**
 * Project IRIS - EKF Simulator Main Entry Point
 *
 * Wires the UI components together with the EKF filter and data models.
 * Initializes the EKF scenarios and handles the main application loop.
 */

import { EKF } from './filter/ekf';
import { Matrix } from './types';
import { loadCSVText, generateSyntheticPass, type CsvMode } from './data/io';
import { initControls, type SimulationState, type Scenario } from './ui/controls';
import { initPlot, type PlotOptions, type PlotData, updatePlot, startAnimation, stopAnimation } from './ui/plot';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_DT = 0.01; // 100Hz update rate

// ---------------------------------------------------------------------------
// Initialize internal state
// ---------------------------------------------------------------------------

let simulationState: SimulationState = {
  running: false,
  currentTime: 0,
  dt: DEFAULT_DT,
};

let ekfInstance: EKF | null = null;
let currentScenario: Scenario = 'leo';
let loadedData: any = null;

// Type guards for CSV data detection
function isMode1Data(data: any): data is { time: number[], position: number[][], velocity: number[][], quaternion: number[][] } {
  return data && Array.isArray(data.time) && Array.isArray(data.position) && Array.isArray(data.quaternion);
}

function isMode2Data(data: any): data is { time: number[], position: number[][], velocity: number[][] } {
  return data && Array.isArray(data.time) && Array.isArray(data.position);
}

// ---------------------------------------------------------------------------
// Initialize controls and wire callbacks
// ---------------------------------------------------------------------------

initControls(
  // onFileLoad callback
  (data: any) => {
    if (isMode1Data(data)) {
      loadedData = data;
      currentScenario = 'leo';
    } else if (isMode2Data(data)) {
      loadedData = data;
      currentScenario = 'attitude';
    } else {
      console.error('Unrecognized CSV format');
      return;
    }
    console.log('CSV loaded, scenario:', currentScenario);
    // Reset EKF with new data
    resetEKF();
  },
  // onScenarioChange callback
  (scenario: Scenario) => {
    currentScenario = scenario;
    console.log('Scenario changed to:', scenario);
    resetEKF();
  }
);

// ---------------------------------------------------------------------------
// Reset/EKF setup function
// ---------------------------------------------------------------------------

function resetEKF(): void {
  // Clean up previous animation
  stopAnimation();

  // Dispose of previous EKF instance if it exists
  ekfInstance = null;
  loadedData = null;
  simulationState = {
    running: false,
    currentTime: 0,
    dt: DEFAULT_DT,
  };

  // Scenario-specific EKF setup
  if (currentScenario === 'leo') {
    // Workcase A: LEO Orbit EKF
    // State: [r_x, r_y, r_z, v_x, v_y, v_z]^T (6×1)
    const x0: number[] = [0, 0, 7000000, 0, 0, 0]; // initial state (position, velocity)

    // Initial state matrix (6×1)
    const x0Matrix: Matrix = {
      data: x0.map(val => [val]),
      rows: 6,
      cols: 1
    };

    // Initial covariance matrix (6×6) - diagonal with large values for position, small for velocity
    const P0data: number[][] = [];
    for (let i = 0; i < 6; i++) {
      const row: number[] = [];
      for (let j = 0; j < 6; j++) {
        row.push(i === j ? (i < 3 ? 1e6 : 1e-3) : 0);
      }
      P0data.push(row);
    }
    const P0Matrix: Matrix = {
      data: P0data,
      rows: 6,
      cols: 6
    };

    // Process noise Q (6×6) - continuous-time white-noise-on-acceleration discretization
    const sigmaA = 1e-6; // acceleration noise density
    const qValue = sigmaA ** 2 * DEFAULT_DT;
    const Qdata: number[][] = [];
    for (let i = 0; i < 6; i++) {
      const row: number[] = [];
      for (let j = 0; j < 6; j++) {
        row.push(i === j ? qValue : 0);
      }
      Qdata.push(row);
    }
    const QMatrix: Matrix = {
      data: Qdata,
      rows: 6,
      cols: 6
    };

    // Measurement noise R (2×2) - range and range-rate
    const rRange = 10; // 10 meters
    const rRate = 0.01; // 0.01 m/s
    const Rdata: number[][] = [
      [rRange ** 2, 0],
      [0, rRate ** 2]
    ];
    const RMatrix: Matrix = {
      data: Rdata,
      rows: 2,
      cols: 2
    };

    // Process model (Cowell with J2) - simplified using the EKF from src/filter/ekf
    // f: (x: Matrix) => Matrix - process model
    const f = (x: Matrix): Matrix => {
      // Simplified: just propagate state
      // In full implementation: Cowell equations with J2 perturbation
      const result: number[][] = new Array(6);
      for (let i = 0; i < 6; i++) result[i] = new Array(1).fill(0);
      // dx/dt = [v_x, v_y, v_z, a_x, a_y, a_z]^T
      result[0][0] = x.data[3][0]; // vx
      result[1][0] = x.data[4][0]; // vy
      result[2][0] = x.data[5][0]; // vz
      result[3][0] = 0; // ax (model-dependent)
      result[4][0] = 0; // ay
      result[5][0] = 0; // az
      return { data: result, rows: 6, cols: 1 };
    };

    // Jacobian F of f
    const F = (x: Matrix): Matrix => {
      // Simple Jacobian for position-velocity state
      const result: number[][] = new Array(6);
      for (let i = 0; i < 6; i++) result[i] = new Array(6).fill(0);
      for (let i = 0; i < 3; i++) {
        result[i][i + 3] = 1; // d(v)/d(x) = I for position part
      }
      for (let i = 3; i < 6; i++) {
        result[i][i] = 1; // d(v)/d(v) = I
      }
      return { data: result, rows: 6, cols: 6 };
    };

    // Measurement model: range and range-rate from ground station
    // h: (x: Matrix) => Matrix
    const h = (x: Matrix): Matrix => {
      // Simplified: return slant range from origin
      const r = Math.sqrt(x.data[0][0] ** 2 + x.data[1][0] ** 2 + x.data[2][0] ** 2);
      return { data: [[r, 0]], rows: 2, cols: 1 }; // [range, range-rate] simplified
    };

    // Jacobian H of h
    const H = (x: Matrix): Matrix => {
      const rhoX = x.data[0][0];
      const rhoY = x.data[1][0];
      const rhoZ = x.data[2][0];
      const rho = Math.sqrt(rhoX ** 2 + rhoY ** 2 + rhoZ ** 2);
      const uX = rhoX / rho;
      const uY = rhoY / rho;
      const uZ = rhoZ / rho;

      // H = [uᵀ, 0₁×₃] for range, [v_rel·uᵀ, uᵀ] for range-rate (simplified)
      const result: number[][] = new Array(2);
      result[0] = [uX, uY, uZ, 0, 0, 0]; // range Jacobian (1×6)
      result[1] = [0, 0, 0, uX, uY, uZ]; // range-rate Jacobian (1×6) simplified
      return { data: result, rows: 2, cols: 6 };
    };

    // EKF options for LEO workcase
    const ekfOptions = {
      f: f,
      F: F,
      h: h,
      H: H,
      Q: QMatrix,
      R: RMatrix,
      x0: x0Matrix,
      P0: P0Matrix
    };

    ekfInstance = new EKF(ekfOptions);
    console.log('LEO EKF initialized');

  } else if (currentScenario === 'attitude') {
    // Workcase B: Attitude EKF (placeholder)
    console.log('Attitude EKF setup (placeholder)');
  }

  // Start the animation loop if we have an EKF instance
  if (ekfInstance) {
    // Start the plot animation
    startAnimation(() => {
      if (!loadedData || !ekfInstance) {
        return {
          time: simulationState.currentTime,
          truth: [0, 0],
          estimate: [0, 0],
          kf: [0, 0],
          measurements: [],
          covarianceEllipse: [0, 0, 0]
        } as PlotData;
      }

      // Advance the EKF simulation time
      simulationState.currentTime += simulationState.dt;

      // Run EKF predict step
      ekfInstance.predict(simulationState.dt);

      // Get current state
      const state = ekfInstance.state;
      const covariance = ekfInstance.covariance;

      // Get measurement (simplified - from first position row)
      let measurement: { x: number; y: number }[] = [];
      if (loadedData.position && loadedData.position.length > 0) {
        const pos = loadedData.position[0]; // first time point
        const range = Math.sqrt(pos[0] ** 2 + pos[1] ** 2 + pos[2] ** 2);
        measurement = [{ x: range, y: 0 }];
      }

      // Run EKF update step
      if (measurement.length > 0) {
        const z: Matrix = {
          data: [[measurement[0].x]],
          rows: 1,
          cols: 1
        };
        ekfInstance.update(z);
      }

      // Get updated state
      const updatedState = ekfInstance.state;

      // Return data for plotting
      return {
        time: simulationState.currentTime,
        truth: [loadedData.position?.[0]?.[0] || 0, loadedData.position?.[1]?.[0] || 0],
        estimate: [updatedState.data[0][0], updatedState.data[1][0]],
        kf: [updatedState.data[0][0], updatedState.data[1][0]], // simplified KF same as EKF for now
        measurements: measurement,
        covarianceEllipse: [updatedState.data[0][0], updatedState.data[1][0], 10]
      } as PlotData;
    });
  }
}

// ---------------------------------------------------------------------------
// Initialize with synthetic data if no file loaded
// ---------------------------------------------------------------------------

// Generate a synthetic LEO pass after a short delay
setTimeout(() => {
  const syntheticData = generateSyntheticPass({
    altitude: 300, // 300 km altitude
    duration: 600, // 10 minute pass
    points: 80
  });

  if (isMode1Data(syntheticData)) {
    loadedData = syntheticData;
    currentScenario = 'leo';
    console.log('Generated synthetic LEO pass, points:', syntheticData.time.length);

    // Initialize EKF with synthetic data
    resetEKF();
  }
}, 500);

// ---------------------------------------------------------------------------
// Export for debugging
// ---------------------------------------------------------------------------

// @ts-ignore - global access for debugging
(window as any).simulationState = simulationState;
(window as any).ekfInstance = ekfInstance;
(window as any).currentScenario = currentScenario;