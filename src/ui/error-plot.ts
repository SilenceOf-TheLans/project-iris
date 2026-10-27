/**
 * Error-vs-time chart for the Project IRIS EKF Simulator.
 *
 * Shows position error (km) over the full data time span and a dashed
 * horizontal line at the running mean. Samples are recorded both at measurement
 * updates and along the prediction arcs, so sparse CSVs still produce a
 * meaningful growth-and-correction curve. The view auto-fits the loaded
 * dataset's time range so the curve grows left-to-right instead of rescaling
 * and compressing earlier samples, and supports the same wheel/drag/pinch/
 * keyboard zoom and pan navigation as the orbital plot.
 */

import { AXIS_STYLE, formatTick, niceTicks } from './plot';

interface ErrorSample {
  time: number;
  errorKm: number;
}

interface ErrorView {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export interface ErrorSummary {
  meanKm: number | null;
  minKm: number | null;
  maxKm: number | null;
}

const COLORS = {
  background: '#000000',
  grid: '#2a2a2a',
  border: '#333333',
  error: '#ffb000',
  mean: '#8a8a8a',
  text: '#e0e0e0',
  muted: '#8a8a8a',
};

let canvasId = 'error-canvas';
let samples: ErrorSample[] = [];
let meanKm: number | null = null;
let minKm: number | null = null;
let maxKm: number | null = null;
let errorSum = 0;
let errorCount = 0;
let timeRange: [number, number] = [0, 1];

/** Explicit zoom/pan view. Null = auto-fit the loaded time range and peak error. */
let userView: ErrorView | null = null;

/** Latest graph box in CSS pixels, shared by rendering and navigation. */
let graphRect = { x: 64, y: 28, width: 1, height: 1 };

const MIN_VIEW_SPAN_X = 1e-6; // seconds
const MAX_VIEW_SPAN_X = 1e9;  // seconds
const MIN_VIEW_SPAN_Y = 1e-9; // km
const MAX_VIEW_SPAN_Y = 1e9;  // km
const AUTO_X_PAD_FRACTION = 0.02;
const AUTO_Y_PAD_FRACTION = 0.06;
const ZOOM_STEP = 1.25;

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
  attachErrorNavigation(canvas);
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
  minKm = null;
  maxKm = null;
  errorSum = 0;
  errorCount = 0;
  userView = null;
  const start = Number.isFinite(startTime) ? startTime : 0;
  const end = Number.isFinite(endTime) ? endTime : start + 1;
  timeRange = end > start ? [start, end] : [start, start + 1];
  updateErrorZoomLabel();
  redrawErrorPlot();
}

/**
 * Record one error sample (measurement update or prediction substep). Returns
 * the running summary so the caller can display mean/min/max in the sidebar
 * without keeping a second accumulator.
 */
export function pushErrorSample(time: number, errorKm: number): ErrorSummary {
  if (!Number.isFinite(time) || !Number.isFinite(errorKm)) return getErrorSummary();
  const err = Math.max(0, errorKm);
  samples.push({ time, errorKm: err });
  errorSum += err;
  errorCount += 1;
  meanKm = errorSum / errorCount;
  if (minKm === null || err < minKm) minKm = err;
  if (maxKm === null || err > maxKm) maxKm = err;
  return getErrorSummary();
}

export function getErrorSummary(): ErrorSummary {
  return { meanKm, minKm, maxKm };
}

function autoYMax(): number {
  const targetMax = maxKm === null
    ? 1
    : Math.max(0.01, maxKm * 1.15);
  const info = niceTicks(0, targetMax, 4);
  let step = info.step;
  if (!(step > 0) || !Number.isFinite(step)) step = targetMax;
  let yMax = Math.ceil(targetMax / step) * step;
  if (!(yMax > 0) || !Number.isFinite(yMax)) yMax = 1;
  return yMax;
}

function effectiveRanges(): ErrorView {
  if (userView) return { ...userView };
  const t0 = timeRange[0];
  const t1 = timeRange[1] > t0 ? timeRange[1] : t0 + 1;
  const span = t1 - t0;
  const yMax = autoYMax();
  // Leave a small margin beyond zero on both axes so the bold x=0 / y=0
  // coordinate lines sit inside the plot instead of looking like a border.
  const xPad = span * AUTO_X_PAD_FRACTION;
  const yPad = yMax * AUTO_Y_PAD_FRACTION;
  return { x0: t0 - xPad, x1: t1 + xPad, y0: -yPad, y1: yMax };
}

function updateErrorZoomLabel(): void {
  const el = document.getElementById('error-plot-zoom');
  if (!el) return;
  if (!userView) {
    el.textContent = '';
    return;
  }
  const autoSpanX = Math.max(
    1e-9,
    (timeRange[1] - timeRange[0]) * (1 + 2 * AUTO_X_PAD_FRACTION),
  );
  const spanX = Math.max(1e-9, userView.x1 - userView.x0);
  const zoom = autoSpanX / spanX;
  el.textContent = zoom >= 1 ? `${zoom.toFixed(1)}×` : `${zoom.toFixed(2)}×`;
}

function screenToErrorData(px: number, py: number): { x: number; y: number } {
  const r = effectiveRanges();
  const xSpan = Math.max(1e-9, r.x1 - r.x0);
  const ySpan = Math.max(1e-9, r.y1 - r.y0);
  return {
    x: r.x0 + ((px - graphRect.x) / graphRect.width) * xSpan,
    y: r.y0 + ((graphRect.y + graphRect.height - py) / graphRect.height) * ySpan,
  };
}

function ensureErrorUserView(): void {
  if (!userView) userView = effectiveRanges();
}

function zoomErrorAt(px: number, py: number, factor: number): void {
  if (!Number.isFinite(factor) || factor <= 0) return;
  ensureErrorUserView();
  const v = userView!;
  const before = screenToErrorData(px, py);
  const spanX = Math.min(MAX_VIEW_SPAN_X, Math.max(MIN_VIEW_SPAN_X, (v.x1 - v.x0) * factor));
  const spanY = Math.min(MAX_VIEW_SPAN_Y, Math.max(MIN_VIEW_SPAN_Y, (v.y1 - v.y0) * factor));
  const fx = (before.x - v.x0) / Math.max(1e-12, v.x1 - v.x0);
  const fy = (before.y - v.y0) / Math.max(1e-12, v.y1 - v.y0);
  v.x0 = before.x - fx * spanX;
  v.x1 = v.x0 + spanX;
  v.y0 = before.y - fy * spanY;
  v.y1 = v.y0 + spanY;
  updateErrorZoomLabel();
  redrawErrorPlot();
}

function panErrorByPixels(x0: number, y0: number, x1: number, y1: number): void {
  ensureErrorUserView();
  const v = userView!;
  const before = screenToErrorData(x0, y0);
  const after = screenToErrorData(x1, y1);
  const dx = before.x - after.x;
  const dy = before.y - after.y;
  v.x0 += dx;
  v.x1 += dx;
  v.y0 += dy;
  v.y1 += dy;
  updateErrorZoomLabel();
  redrawErrorPlot();
}

function resetErrorView(): void {
  userView = null;
  updateErrorZoomLabel();
  redrawErrorPlot();
}

function canvasPos(e: { clientX: number; clientY: number }, canvas: HTMLCanvasElement): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function attachErrorNavigation(canvas: HTMLCanvasElement): void {
  if ((canvas as any).__errorNavWired) return;
  (canvas as any).__errorNavWired = true;
  canvas.setAttribute('tabindex', '0');
  canvas.title = 'Scroll to zoom · Drag to pan · Double-click or 0 to reset · +/- zoom · Arrows pan';

  canvas.addEventListener('wheel', (e: WheelEvent) => {
    e.preventDefault();
    const p = canvasPos(e, canvas);
    const unit = e.deltaMode === 1 ? 16 : 1;
    zoomErrorAt(p.x, p.y, Math.exp(e.deltaY * unit * 0.0012));
  }, { passive: false });

  canvas.addEventListener('dblclick', () => resetErrorView());

  const pointers = new Map<number, { x: number; y: number }>();
  let pinchDist = 0;

  canvas.addEventListener('pointerdown', (e: PointerEvent) => {
    canvas.setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId, canvasPos(e, canvas));
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    }
    canvas.style.cursor = 'grabbing';
  });

  canvas.addEventListener('pointermove', (e: PointerEvent) => {
    if (e.buttons === 0 && pointers.size === 0) {
      canvas.style.cursor = 'grab';
      return;
    }
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const p = canvasPos(e, canvas);
    pointers.set(e.pointerId, p);
    if (pointers.size === 1) {
      panErrorByPixels(prev.x, prev.y, p.x, p.y);
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const prevMid = { x: mid.x + prev.x - p.x, y: mid.y + prev.y - p.y };
      if (pinchDist > 0 && dist > 0) zoomErrorAt(mid.x, mid.y, pinchDist / dist);
      pinchDist = dist;
      panErrorByPixels(prevMid.x, prevMid.y, mid.x, mid.y);
    }
  });

  const release = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchDist = 0;
    if (pointers.size === 0) canvas.style.cursor = 'grab';
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  canvas.addEventListener('keydown', (e: KeyboardEvent) => {
    const r = effectiveRanges();
    const stepX = Math.max(MIN_VIEW_SPAN_X, r.x1 - r.x0) * 0.1;
    const stepY = Math.max(MIN_VIEW_SPAN_Y, r.y1 - r.y0) * 0.1;
    const cx = graphRect.x + graphRect.width / 2;
    const cy = graphRect.y + graphRect.height / 2;
    if (e.key === '+' || e.key === '=') {
      zoomErrorAt(cx, cy, 1 / ZOOM_STEP);
    } else if (e.key === '-' || e.key === '_') {
      zoomErrorAt(cx, cy, ZOOM_STEP);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      ensureErrorUserView();
      const v = userView!;
      if (e.key === 'ArrowLeft') { v.x0 -= stepX; v.x1 -= stepX; }
      if (e.key === 'ArrowRight') { v.x0 += stepX; v.x1 += stepX; }
      if (e.key === 'ArrowUp') { v.y0 += stepY; v.y1 += stepY; }
      if (e.key === 'ArrowDown') { v.y0 -= stepY; v.y1 -= stepY; }
      updateErrorZoomLabel();
      redrawErrorPlot();
    } else if (e.key === '0') {
      resetErrorView();
    } else {
      return;
    }
    e.preventDefault();
  });
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

function mapY(
  errorKm: number,
  graph: { y: number; height: number },
  y0: number,
  y1: number,
): number {
  const span = Math.max(1e-12, y1 - y0);
  return graph.y + graph.height - ((errorKm - y0) / span) * graph.height;
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
    height: Math.max(30, cssH - 68),
  };

  graphRect = graph;

  const view = effectiveRanges();
  const t0 = view.x0;
  const t1 = view.x1;
  const y0 = view.y0;
  const y1 = view.y1;

  const xInfo = niceTicks(t0, t1, Math.max(3, Math.floor(graph.width / 110)));
  const xStep = xInfo.step > 0 ? xInfo.step : (t1 - t0);
  const xTicks = xInfo.ticks.length > 0 ? xInfo.ticks : [t0, t1];
  const xDecimals = decimalsForStep(xStep);

  const yInfo = niceTicks(y0, y1, 4);
  const yStep = yInfo.step > 0 ? yInfo.step : (y1 - y0);
  const yTicks = yInfo.ticks.length > 0 ? yInfo.ticks : [y0, y1];
  const yDecimals = decimalsForStep(yStep);

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
    const py = mapY(v, graph, y0, y1);
    ctx.moveTo(graph.x, py);
    ctx.lineTo(graph.x + graph.width, py);
  }
  ctx.stroke();

  // Tick labels in the margins. The plot frame stays subtle so it does not
  // compete with the trace.
  ctx.fillStyle = AXIS_STYLE.tickColor;
  ctx.font = AXIS_STYLE.tickFont;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const v of yTicks) {
    ctx.fillText(formatTick(v, yDecimals), graph.x - 9, mapY(v, graph, y0, y1));
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const t of xTicks) {
    ctx.fillText(formatTick(t, xDecimals), mapX(t, graph, t0, t1), graph.y + graph.height + 9);
  }

  ctx.fillStyle = AXIS_STYLE.titleColor;
  ctx.font = AXIS_STYLE.titleFont;
  ctx.textAlign = 'center';
  ctx.fillText('time (s)', graph.x + graph.width / 2, graph.y + graph.height + 27);

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
      const px = mapX(s.time, graph, t0, t1);
      const py = mapY(s.errorKm, graph, y0, y1);
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
      const py = mapY(last.errorKm, graph, y0, y1);
      ctx.fillStyle = COLORS.error;
      ctx.beginPath();
      ctx.arc(px, py, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    if (meanKm !== null) {
      const py = mapY(meanKm, graph, y0, y1);
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

  // Keep the plot frame subtle so it does not compete with the data.
  ctx.strokeStyle = COLORS.border;
  ctx.lineWidth = 1;
  ctx.strokeRect(graph.x + 0.5, graph.y + 0.5, graph.width - 1, graph.height - 1);

  // Coordinate axes at x = 0 and y = 0. These are distinct from the plot
  // frame and are emphasized above the trace.
  const showZeroX = t0 <= 0 && 0 <= t1;
  const showZeroY = y0 <= 0 && 0 <= y1;
  if (showZeroX || showZeroY) {
    const zeroX = mapX(0, graph, t0, t1);
    const zeroY = mapY(0, graph, y0, y1);
    ctx.strokeStyle = AXIS_STYLE.color;
    ctx.lineWidth = AXIS_STYLE.width;
    ctx.beginPath();
    if (showZeroX) {
      ctx.moveTo(zeroX, graph.y);
      ctx.lineTo(zeroX, graph.y + graph.height);
    }
    if (showZeroY) {
      ctx.moveTo(graph.x, zeroY);
      ctx.lineTo(graph.x + graph.width, zeroY);
    }
    ctx.stroke();
  }
}
