/**
 * UI Controls module for the Project IRIS EKF Simulator.
 * File loading, log-scale noise sliders, run/reset, scenario tabs, help panels.
 */

import { loadCSVText } from '../data/io';

export type Scenario = 'leo' | 'attitude';

export interface SimulationState {
  running: boolean;
  currentTime: number;
  dt: number;
}

export const Q_RANGE: [number, number] = [1e-12, 1e-2];
export const R_RANGE: [number, number] = [1e-2, 1e3];
export const SPEED_RANGE: [number, number] = [0.1, 10];

const SLIDER_MAX = 1000;

function sliderToLog(pos: number, min: number, max: number): number {
  const t = Math.min(1, Math.max(0, pos / SLIDER_MAX));
  const lmin = Math.log10(min);
  const lmax = Math.log10(max);
  return Math.pow(10, lmin + (lmax - lmin) * t);
}

function logToSlider(value: number, min: number, max: number): number {
  const lmin = Math.log10(min);
  const lmax = Math.log10(max);
  const lv = Math.log10(Math.min(max, Math.max(min, value)));
  return Math.round(((lv - lmin) / (lmax - lmin)) * SLIDER_MAX);
}

function formatSpeed(value: number): string {
  if (value >= 10) return '10×';
  if (value >= 1) return `${value.toFixed(1).replace(/\.0$/, '')}×`;
  return `${value.toFixed(2).replace(/0$/, '')}×`;
}

export function initControls(
  onFileLoad: (data: any) => void,
  onScenarioChange: (scenario: Scenario) => void,
  onQValueChange?: (value: number) => void,
  onRValueChange?: (value: number) => void,
  onRunToggle?: () => boolean,
  onReset?: () => void,
  onSpeedChange?: (value: number) => void,
): void {
  const fileInput = document.querySelector<HTMLInputElement>('#file-input');
  fileInput?.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text = e.target?.result as string;
        const data = loadCSVText(text);
        onFileLoad(data);
      } catch (err) {
        logMessage(err instanceof Error ? err.message : String(err));
      }
    };
    reader.onerror = () => logMessage(`Failed to read file: ${file.name}`);
    reader.readAsText(file);
    fileInput.value = '';
  });

  const qSlider = document.querySelector<HTMLInputElement>('#q-slider');
  const qDisplay = document.querySelector<HTMLElement>('#q-value');
  if (qSlider) {
    const initialQ = 1e-6;
    qSlider.value = String(logToSlider(initialQ, Q_RANGE[0], Q_RANGE[1]));
    if (qDisplay) qDisplay.textContent = initialQ.toExponential(1);
    qSlider.addEventListener('input', () => {
      const value = sliderToLog(parseFloat(qSlider.value), Q_RANGE[0], Q_RANGE[1]);
      if (qDisplay) qDisplay.textContent = value.toExponential(1);
      onQValueChange?.(value);
    });
  }

  const rSlider = document.querySelector<HTMLInputElement>('#r-slider');
  const rDisplay = document.querySelector<HTMLElement>('#r-value');
  if (rSlider) {
    const initialR = 10;
    rSlider.value = String(logToSlider(initialR, R_RANGE[0], R_RANGE[1]));
    if (rDisplay) rDisplay.textContent = initialR.toExponential(1);
    rSlider.addEventListener('input', () => {
      const value = sliderToLog(parseFloat(rSlider.value), R_RANGE[0], R_RANGE[1]);
      if (rDisplay) rDisplay.textContent = value.toExponential(1);
      onRValueChange?.(value);
    });
  }

  const speedSlider = document.querySelector<HTMLInputElement>('#speed-slider');
  const speedDisplay = document.querySelector<HTMLElement>('#speed-value');
  if (speedSlider) {
    const initialSpeed = 1;
    speedSlider.value = String(logToSlider(initialSpeed, SPEED_RANGE[0], SPEED_RANGE[1]));
    if (speedDisplay) speedDisplay.textContent = formatSpeed(initialSpeed);
    speedSlider.addEventListener('input', () => {
      const value = sliderToLog(parseFloat(speedSlider.value), SPEED_RANGE[0], SPEED_RANGE[1]);
      if (speedDisplay) speedDisplay.textContent = formatSpeed(value);
      onSpeedChange?.(value);
    });
  }

  const runButton = document.querySelector<HTMLButtonElement>('#run-button');
  if (runButton && !((runButton as any).__wired)) {
    (runButton as any).__wired = true;
    runButton.addEventListener('click', () => {
      const running = onRunToggle ? onRunToggle() : false;
      runButton.textContent = running ? 'Pause EKF' : 'Run EKF';
    });
  }

  const resetButton = document.querySelector<HTMLButtonElement>('#reset-button');
  if (resetButton && !((resetButton as any).__wired)) {
    (resetButton as any).__wired = true;
    resetButton.addEventListener('click', () => {
      onReset?.();
      if (runButton) runButton.textContent = 'Run EKF';
    });
  }

  const scenarioTabs = document.querySelectorAll<HTMLButtonElement>('.scenario-tab');
  scenarioTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const scenario = tab.dataset.scenario as Scenario;
      if (scenario !== 'leo' && scenario !== 'attitude') return;
      scenarioTabs.forEach((t) => t.classList.toggle('active', t === tab));
      onScenarioChange(scenario);
      if (runButton) runButton.textContent = 'Run EKF';
    });
  });

  const helpTab = document.querySelector<HTMLButtonElement>('#help-tab');
  const aboutTab = document.querySelector<HTMLButtonElement>('#about-tab');
  const helpPanel = document.querySelector<HTMLElement>('#help-panel');
  const aboutPanel = document.querySelector<HTMLElement>('#about-panel');
  helpTab?.addEventListener('click', () => {
    helpPanel?.classList.toggle('open');
    aboutPanel?.classList.remove('open');
  });
  aboutTab?.addEventListener('click', () => {
    aboutPanel?.classList.toggle('open');
    helpPanel?.classList.remove('open');
  });
}

export function setRunButtonLabel(running: boolean): void {
  const runButton = document.querySelector<HTMLButtonElement>('#run-button');
  if (runButton) runButton.textContent = running ? 'Pause EKF' : 'Run EKF';
}

export function logMessage(msg: string): void {
  const el = document.querySelector<HTMLElement>('#log');
  if (el) {
    el.textContent = msg;
    console.warn(msg);
  } else {
    console.warn(msg);
  }
}
