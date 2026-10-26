/**
 * Error-vs-time chart for the Project IRIS EKF Simulator.
 *
 * Shows position error (km) over the full data time span and a dashed
 * horizontal line at the running mean. Samples are recorded both at measurement
 * updates and along the prediction arcs, so sparse CSVs still produce a
 * meaningful growth-and-correction curve. The x-axis is fixed to the loaded
 * dataset's time range so the curve grows left-to-right instead of rescaling
 * and compressing earlier samples.
 */

import { formatTick, niceTicks } from './plot';

interface ErrorSample {
  time: number;
  errorKm: number;
}

const COLORS = {
  background: '#000000',
  grid: '#2a2a2a',
  axis: '#b0b0b0',
  border: '#333333',
  error: '#ffb000',
  mean: '#8a8a8a',
  text: '#e0e0e0',
  muted: '#8a8a8a',
};

let canvasId = 'error-canvas';
let samples: ErrorSample[] = [];
let meanKm: number | null = null;
let errorSum = 0;
let errorCount = 0;
let timeRange: [number, number] = [0, 1];

function getCanvas(): HTMLCanvasElement | null {
  return document.getElementById(canvasId) as HTMLCanvasElement | null;
}

function sizeCanvas(canvas: HTMLCanvasElement): { width: number; height: number } {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cssW = canvas.clientWidth || 900;
  const cssH = canvas.clientHeight || 200;
  const pixelW = Math.max(1, Math.round(cssW * dpr));
  const pixelH = Math.max(1, Math.round(cssH * dpr));
  if (canvas.width !== pixelW || canvas.height !== pixelH) {
    canvas.width = pixelW;
    canvas.height = pixelH;
  }
  const ctx = canvas.getContext('2d');
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { width: cssW, height: cssH };
}

export function initErrorPlot(id: string): void {
  canvasId = id;
  const canvas = getCanvas();
  if (!canvas) {
    console.error(`Error plot: canvas element with id="${id}" not found`);
    return;
  }
  sizeCanvas(canvas);
  redrawErrorPlot();
}

export function resizeErrorPlot(): void {
  const canvas = getCanvas();
  if (!canvas) return;
  sizeCanvas(canvas);
  redrawErrorPlot();
}

/** Clear the trace and set the time span used by the x-axis. */
export function resetErrorPlot(startTime = 0, endTime = 1): void {
  samples = [];
  meanKm = null;
  errorSum = 0;
  errorCount = 0;
  const start = Number.isFinite(startTime) ? startTime : 0;
  const end = Number.isFinite(endTime) ? endTime : start + 1;
  timeRange = end > start ? [start, end] : [start, start + 1];
  redrawErrorPlot();
}

/**
 * Record one error sample (measurement update or prediction substep). Returns
 * the new running mean so the caller can display it in the sidebar without
 * keeping a second accumulator.
 */
export function pushErrorSample(time: number, errorKm: number): number | null {
  if (!Number.isFinite(time) || !Number.isFinite(errorKm)) return meanKm;
  const err = Math.max(0, errorKm);
  samples.push({ time, errorKm: err });
  errorSum += err;
  errorCount += 1;
  meanKm = errorSum / errorCount;
  return meanKm;
}

export function getMeanErrorKm(): number | null {
  return meanKm;
}

/** Decimal places needed to print a tick step exactly (handles 0.25, 2.5e-3, …). */
function decimalsForStep(step: number): number {
  if (!(step > 0) || !Number.isFinite(step)) return 0;
  const exp = Math.floor(Math.log10(step));
  const mantissa = step / Math.pow(10, exp);
  const base = Math.max(0, -exp);
  return Math.abs(mantissa - 2.5) < 1e-9 && base > 0 ? base + 1 : base;
}

function mapX(time: number, graph: { x: number; width: number }, t0: number, t1: number): number {
  return graph.x + ((time - t0) / (t1 - t0)) * graph.width;
}

function mapY(errorKm: number, graph: { y: number; height: number }, yMax: number): number {
  return graph.y + graph.height - (errorKm / yMax) * graph.height;
}

/** Render the current error trace and running mean. Safe to call before data exists. */
export function redrawErrorPlot(): void {
  const canvas = getCanvas();
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const { width: cssW, height: cssH } = sizeCanvas(canvas);
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, cssW, cssH);

  const graph = {
    x: 64,
    y: 28,
    width: Math.max(30, cssW - 82),
    height: Math.max(30, cssH - 62),
  };

  const t0 = timeRange[0];
  const t1 = timeRange[1] > t0 ? timeRange[1] : t0 + 1;

  let maxError = 0;
  for (const s of samples) {
    if (s.errorKm > maxError) maxError = s.errorKm;
  }
  const targetMax = samples.length === 0
    ? 1
    : Math.max(0.01, maxError * 1.15);
  const yInfo = niceTicks(0, targetMax, 4);
  let yStep = yInfo.step;
  if (!(yStep > 0) || !Number.isFinite(yStep)) yStep = targetMax;
  let yMax = Math.ceil(targetMax / yStep) * yStep;
  if (!(yMax > 0) || !Number.isFinite(yMax)) {
    yStep = 1;
    yMax = 1;
  }

  const xInfo = niceTicks(t0, t1, Math.max(3, Math.floor(graph.width / 110)));
  const xStep = xInfo.step > 0 ? xInfo.step : (t1 - t0);
  const xTicks = xInfo.ticks.length > 0 ? xInfo.ticks : [t0, t1];
  const xDecimals = decimalsForStep(xStep);
  const yDecimals = decimalsForStep(yStep);
  const yTicks: number[] = [];
  for (let v = 0; v <= yMax + yStep * 1e-9 && yTicks.length < 100; v += yStep) {
    yTicks.push(Math.abs(v) < yStep * 1e-9 ? 0 : v);
  }

  // Header: title + legend.
  ctx.font = '11px monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = COLORS.text;
  ctx.fillText('Error vs time', graph.x, 13);

  if (graph.width >= 230) {
    const legendX = graph.x + graph.width - 120;
    ctx.fillStyle = COLORS.text;
    ctx.fillText('Error', legendX + 18, 13);
    ctx.strokeStyle = COLORS.error;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(legendX, 13);
    ctx.lineTo(legendX + 13, 13);
    ctx.stroke();

    const meanX = legendX + 68;
    ctx.fillStyle = COLORS.text;
    ctx.fillText('Mean', meanX + 18, 13);
    ctx.strokeStyle = COLORS.mean;
    ctx.lineWidth = 1.2;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(meanX, 13);
    ctx.lineTo(meanX + 13, 13);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Grid.
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const t of xTicks) {
    const px = mapX(t, graph, t0, t1);
    ctx.moveTo(px, graph.y);
    ctx.lineTo(px, graph.y + graph.height);
  }
  for (const v of yTicks) {
    const py = mapY(v, graph, yMax);
    ctx.moveTo(graph.x, py);
    ctx.lineTo(graph.x + graph.width, py);
  }
  ctx.stroke();

  // Axes and tick labels.
  ctx.strokeStyle = COLORS.axis;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(graph.x, graph.y);
  ctx.lineTo(graph.x, graph.y + graph.height);
  ctx.lineTo(graph.x + graph.width, graph.y + graph.height);
  ctx.stroke();

  ctx.fillStyle = COLORS.muted;
  ctx.font = '10px monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const v of yTicks) {
    ctx.fillText(formatTick(v, yDecimals), graph.x - 7, mapY(v, graph, yMax));
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const t of xTicks) {
    ctx.fillText(formatTick(t, xDecimals), mapX(t, graph, t0, t1), graph.y + graph.height + 5);
  }

  ctx.fillStyle = COLORS.text;
  ctx.font = '11px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('time (s)', graph.x + graph.width / 2, graph.y + graph.height + 25);

  ctx.save();
  ctx.translate(15, graph.y + graph.height / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('error (km)', 0, 0);
  ctx.restore();

  // Data is clipped to the graph box so an unexpectedly large value can never
  // spill into the axes or header.
  ctx.save();
  ctx.beginPath();
  ctx.rect(graph.x, graph.y, graph.width, graph.height);
  ctx.clip();

  if (samples.length === 0) {
    ctx.fillStyle = COLORS.muted;
    ctx.font = '12px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Run the EKF to plot position error', graph.x + graph.width / 2, graph.y + graph.height / 2);
  } else {
    ctx.strokeStyle = COLORS.error;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    let first = true;
    for (const s of samples) {
      if (s.time < t0 || s.time > t1) continue;
      const px = mapX(s.time, graph, t0, t1);
      const py = mapY(s.errorKm, graph, yMax);
      if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
      if (first) {
        ctx.moveTo(px, py);
        first = false;
      } else {
        ctx.lineTo(px, py);
      }
    }
    if (!first) ctx.stroke();

    const last = samples[samples.length - 1];
    if (last.time >= t0 && last.time <= t1) {
      const px = mapX(last.time, graph, t0, t1);
      const py = mapY(last.errorKm, graph, yMax);
      ctx.fillStyle = COLORS.error;
      ctx.beginPath();
      ctx.arc(px, py, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    if (meanKm !== null) {
      const py = mapY(meanKm, graph, yMax);
      ctx.strokeStyle = COLORS.mean;
      ctx.lineWidth = 1.2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(graph.x, py);
      ctx.lineTo(graph.x + graph.width, py);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  ctx.restore();

  ctx.strokeStyle = COLORS.border;
  ctx.lineWidth = 1;
  ctx.strokeRect(graph.x + 0.5, graph.y + 0.5, graph.width - 1, graph.height - 1);
}
