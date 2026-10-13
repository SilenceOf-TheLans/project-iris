/**
 * UI Controls module for the Project IRIS EKF Simulator.
 *
 * Handles all user interface interactions: file loading, slider controls,
 * button actions, scenario switching, and help panel toggling.
 * AMOLED aesthetic: black background, neon cyan accents.
 */

// ---------------------------------------------------------------------------
// Module-level state (initialized by initControls, accessed by exported functions)
// ---------------------------------------------------------------------------

/**
 * String literal type for all control element IDs.
 */
export type ControlIds =
  | 'file-input'
  | 'q-slider'
  | 'r-slider'
  | 'run-button'
  | 'toggle-kf-button'
  | 'scenario-leo'
  | 'scenario-attitude'
  | 'settings-tab'
  | 'help-tab'
  | 'help-panel'
  | 'about-panel';

/**
 * Process noise magnitude range: Q [1e-8, 1e-2] logarithmic scale.
 */
export const QValues: [number, number] = [1e-8, 1e-2];

/**
 * Measurement noise magnitude range: R [1e-4, 1e-1] logarithmic scale.
 */
export const RValues: [number, number] = [1e-4, 1e-1];

/**
 * Simulation state tracking.
 */
export interface SimulationState {
  running: boolean;
  currentTime: number;
  dt: number;
}

/**
 * Scenario identifier: 'leo' (Workcase A: LEO orbit) or 'attitude' (Workcase B: attitude).
 */
export type Scenario = 'leo' | 'attitude';

// Internal module state - shared with exported functions
let simState: SimulationState = {
  running: false,
  currentTime: 0,
  dt: 0.01,
};
let simRunning = false;
let loadedData: any = null;
let currentScenario: Scenario = 'leo';

// ---------------------------------------------------------------------------

/**
 * Initializes all control event listeners.
 *
 * Sets up event listeners for:
 *   - File input: browse and load CSV (Mode 1 or Mode 2)
 *   - Q slider: update process noise covariance magnitude
 *   - R slider: update measurement noise covariance magnitude
 *   - Run EKF button: start/pause the EKF simulation run
 *   - Scenario tabs: switch between LEO and attitude workcases
 *   - Help/About panel toggling
 *
 * @param onFileLoad - Callback invoked when a CSV file is successfully loaded.
 *                     Receives the parsed LoadedData object.
 * @param onScenarioChange - Callback invoked when the user switches scenarios.
 *                         Receives the new Scenario string ('leo' | 'attitude').
 */
export function initControls(
  onFileLoad: (data: any) => void,
  onScenarioChange: (scenario: Scenario) => void
): void {
  // Reset internal state
  simState.running = false;
  simState.currentTime = 0;
  simState.dt = 0.01;
  simRunning = false;
  loadedData = null;
  currentScenario = 'leo';

  // --- File input handler ---
  const fileInput = document.querySelector< HTMLInputElement >('#file-input');
  if (fileInput) {
    fileInput.addEventListener('change', (event) => {
      const target = event.target as HTMLInputElement;
      const file = target.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (e) => {
        const text = e.target?.result as string | undefined;
        if (text === undefined) return;
        try {
          const data = loadCSVText(text);
          loadedData = data;
          currentScenario = detectScenario(data);
          onFileLoad(data);
          onScenarioChange(currentScenario);
        } catch (err) {
          console.error('CSV load error:', err);
        }
      };
      reader.onerror = () => {
        console.error('FileReader error');
      };
      reader.readAsText(file);
    });
  }

  // --- Q (process noise) slider ---
  const qSlider = document.querySelector< HTMLInputElement >('#q-slider');
  if (qSlider) {
    qSlider.setAttribute('min', QValues[0].toString());
    qSlider.setAttribute('max', QValues[1].toString());
    qSlider.setAttribute('step', '1e-9');

    qSlider.addEventListener('input', () => {
      const value = parseFloat(qSlider.value);
      setQValue(value);
      const qDisplay = document.querySelector< HTMLElement >('#q-value');
      if (qDisplay) {
        qDisplay.textContent = value.toExponential(3);
      }
    });
  }

  // --- R (measurement noise) slider ---
  const rSlider = document.querySelector< HTMLInputElement >('#r-slider');
  if (rSlider) {
    rSlider.setAttribute('min', RValues[0].toString());
    rSlider.setAttribute('max', RValues[1].toString());
    rSlider.setAttribute('step', '1e-5');

    rSlider.addEventListener('input', () => {
      const value = parseFloat(rSlider.value);
      setRValue(value);
      const rDisplay = document.querySelector< HTMLElement >('#r-value');
      if (rDisplay) {
        rDisplay.textContent = value.toExponential(3);
      }
    });
  }

  // --- Run EKF button ---
  const runButton = document.querySelector< HTMLButtonElement >('#run-button');
  if (runButton) {
    runButton.addEventListener('click', () => {
      simRunning = !simRunning;
      runButton.textContent = simRunning ? 'Pause EKF' : 'Run EKF';
      console.log('EKF', simRunning ? 'running' : 'paused');
    });
  }

  // --- Scenario tab switching ---
  const scenarioTabs = document.querySelectorAll< HTMLButtonElement >(
    '.scenario-tab'
  );
  scenarioTabs.forEach((tab) => {
    tab.addEventListener('click', (event) => {
      const target = event.target as HTMLButtonElement;
      const scenario = target.dataset.scenario as Scenario;
      if (scenario && onScenarioChange) {
        onScenarioChange(scenario);
      }
    });
  });

  // --- Help/About panel toggling ---
  const helpTab = document.querySelector< HTMLButtonElement >('#help-tab');
  const aboutTab = document.querySelector< HTMLButtonElement >('#about-tab');
  const helpPanel = document.querySelector< HTMLElement >('#help-panel');
  const aboutPanel = document.querySelector< HTMLElement >('#about-panel');

  const togglePanel = (panel: HTMLElement | null) => {
    if (!panel) return;
    const isVisible = panel.style.display !== 'none';
    panel.style.display = isVisible ? 'none' : 'block';
  };

  if (helpTab && helpPanel) {
    helpTab.addEventListener('click', () => togglePanel(helpPanel));
  }
  if (aboutTab && aboutPanel) {
    aboutTab.addEventListener('click', () => togglePanel(aboutPanel));
  }
}

/**
 * Updates the process noise Q value from the slider.
 *
 * @param value - The new Q value (magnitude), typically from the Q slider.
 *                Range: [1e-8, 1e-2] logarithmic scale.
 */
export function setQValue(value: number): void {
  const clamped = Math.max(QValues[0], Math.min(QValues[1], value));
  console.log('Q set to:', clamped.toExponential(3));
}

/**
 * Updates the measurement noise R value from the slider.
 *
 * @param value - The new R value (magnitude), typically from the R slider.
 *                Range: [1e-4, 1e-1] logarithmic scale.
 */
export function setRValue(value: number): void {
  const clamped = Math.max(RValues[0], Math.min(RValues[1], value));
  console.log('R set to:', clamped.toExponential(3));
}

/**
 * Resets the EKF simulation state.
 *
 * Clears loaded data, resets the simulation time, and resets UI to initial state.
 */
export function resetSimulation(): void {
  simState.running = false;
  simState.currentTime = 0;
  simState.dt = 0.01;
  loadedData = null;
  currentScenario = 'leo';
  simRunning = false;
  console.log('Simulation reset');
}

/**
 * Toggles the help panel visibility.
 *
 * Shows or hides the help/About panel in the left-side sidebar.
 */
export function showHelp(): void {
  const helpPanel = document.querySelector< HTMLElement >('#help-panel');
  const aboutPanel = document.querySelector< HTMLElement >('#about-panel');
  if (helpPanel) {
    helpPanel.style.display =
      helpPanel.style.display === 'none' ? 'block' : 'none';
  }
  if (aboutPanel) {
    aboutPanel.style.display =
      aboutPanel.style.display === 'none' ? 'block' : 'none';
  }
}

// ---------------------------------------------------------------------------
// CSV text parser (reuses logic from src/data/io.ts)
// ---------------------------------------------------------------------------

/**
 * Parses a CSV text string into LoadedData.
 * Auto-detects mode from the header row.
 * Throws on malformed CSV.
 *
 * @param text - Raw CSV text string
 * @returns LoadedData value with time, position, velocity, and optional quaternion arrays
 */
function loadCSVText(text: string): any {
  const lines = text.trim().split('\n').filter(
    (line: string) => line.trim().length > 0
  );

  if (lines.length === 0) {
    throw new Error('Empty CSV text');
  }

  const header = lines[0];
  const tokens = header.split(',').map((field) => field.trim());
  const first = tokens[0].toLowerCase().trim();

  if (first !== 't') {
    throw new Error(`Invalid CSV header: expected 't' as first column, got '${first}'`);
  }

  let mode: 'mode1' | 'mode2';
  if (tokens.length === 11) {
    mode = 'mode1';
  } else if (tokens.length === 6) {
    mode = 'mode2';
  } else if (tokens[1]?.toLowerCase()?.startsWith('p') && tokens.length === 6) {
    mode = 'mode2';
  } else if (tokens[1]?.toLowerCase()?.startsWith('q') && tokens.length === 11) {
    mode = 'mode1';
  } else {
    throw new Error(
      `Unrecognised CSV header (${tokens.length} columns). Expected Mode 1 (11 columns) or Mode 2 (6 columns).`
    );
  }

  const times: number[] = [];
  const positions: number[][] = [];
  const velocities: number[][] = [];
  const quaternions: number[][] | undefined = mode === 'mode1' ? [] : undefined;

  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].split(',').map((field) => field.trim());

    if (row.length === 0 || row.every((f) => f === '')) {
      continue;
    }

    if (mode === 'mode1' && row.length !== 11) {
      throw new Error(
        `Mode 1 row ${i + 1}: expected 11 fields, got ${row.length}`
      );
    }
    if (mode === 'mode2' && row.length !== 6) {
      throw new Error(
        `Mode 2 row ${i + 1}: expected 6 fields, got ${row.length}`
      );
    }

    const t = parseFloat(row[0]);
    if (isNaN(t)) {
      throw new Error(`Row ${i + 1}: invalid time value '${row[0]}'`);
    }
    times.push(t);

    if (mode === 'mode1') {
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

      if (
        isNaN(px) || isNaN(py) || isNaN(pz) || isNaN(vx) || isNaN(vy) || isNaN(vz)
      ) {
        throw new Error(
          `Row ${i + 1}: invalid numeric value in position/velocity fields`
        );
      }

      positions.push([px, py, pz]);
      velocities.push([vx, vy, vz]);
      quaternions!.push([q0, q1, q2, q3]);
    } else {
      const px = parseFloat(row[1]);
      const py = parseFloat(row[2]);
      const vx = parseFloat(row[3]);
      const vy = parseFloat(row[4]);

      if (isNaN(px) || isNaN(py) || isNaN(vx) || isNaN(vy)) {
        throw new Error(
          `Row ${i + 1}: invalid numeric value in position/velocity fields`
        );
      }

      positions.push([px, py, 0]);
      velocities.push([vx, vy, 0]);
    }
  }

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
 * Detects the CSV scenario mode from loaded data.
 * @param data - Parsed CSV data
 * @returns 'leo' for Mode 1, 'attitude' for Mode 2, or 'leo' by default
 */
function detectScenario(data: any): Scenario {
  if (data && data.quaternion && data.quaternion.length > 0) {
    return 'leo';
  }
  return 'attitude';
}

