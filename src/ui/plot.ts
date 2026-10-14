/**
 * Plot module for the Project IRIS EKF Simulator.
 * Canvas-based 2D trajectory plot (X vs Y, km) with AMOLED aesthetic.
 * Navigation: wheel zoom (to cursor), drag pan, pinch zoom (touch),
 * double-click / keyboard 0 to reset, keyboard arrows/+/- to move/zoom.
 */

export interface PlotOptions {
  canvasId: string;
  width: number;
  height: number;
  showGrid?: boolean;
  showLegend?: boolean;
}

export interface PlotData {
  time: number;
  truth: number[];
  estimate: number[];
  kf: number[];
  measurements: { x: number; y: number }[];
  covarianceEllipse: [number, number, number];
}

interface TraceEntry {
  x: number;
  y: number;
  type: 'truth' | 'estimate' | 'kf' | 'measurement';
  age: number;
}

interface PlotState {
  rafId: number | null;
  running: boolean;
  lastTime: number;
  traceHistory: TraceEntry[];
  covarianceEllipse: [number, number, number] | null;
  graphRect: { x: number; y: number; width: number; height: number };
  dataRangeX: [number, number];
  dataRangeY: [number, number];
  showGrid: boolean;
  showLegend: boolean;
}

interface UserView {
  cx: number;
  cy: number;
  spanX: number;
  spanY: number;
}

const COLORS = {
  background: '#000000',
  grid: '#2a2a2a',
  axis: '#b0b0b0',
  truth: '#00ff66',
  ekf: '#00ffff',
  kf: '#ff4444',
  measurement: '#ffffff',
  legendText: '#e0e0e0',
  ellipseFill: 'rgba(0, 255, 255, 0.12)',
  ellipseStroke: 'rgba(0, 255, 255, 0.7)',
};

const GRAPH_WIDTH_PERCENT = 0.82;
const GRAPH_HEIGHT_PERCENT = 0.82;
const DEFAULT_DATA_RANGE: [number, number] = [-7000, 7000];
const PAD = 0.08;
const MIN_SPAN = 1;      // km
const MAX_SPAN = 1e8;    // km

let plotState: PlotState = {
  rafId: null,
  running: false,
  lastTime: 0,
  traceHistory: [],
  covarianceEllipse: null,
  graphRect: { x: 0, y: 0, width: 0, height: 0 },
  dataRangeX: DEFAULT_DATA_RANGE.slice() as [number, number],
  dataRangeY: DEFAULT_DATA_RANGE.slice() as [number, number],
  showGrid: true,
  showLegend: true,
};

/** Explicit user-controlled view (zoom/pan). Null = auto-fit data ranges. */
let userView: UserView | null = null;

function getCanvas(id: string): HTMLCanvasElement | null {
  return document.getElementById(id) as HTMLCanvasElement | null;
}

export function initPlot(canvasId: string, options: PlotOptions): HTMLCanvasElement {
  const canvas = getCanvas(canvasId);
  if (!canvas) {
    console.error(`Plot: canvas element with id="${canvasId}" not found`);
    return document.createElement('canvas');
  }

  sizeCanvasToDisplay(canvas, options.width, options.height);

  plotState.dataRangeX = DEFAULT_DATA_RANGE.slice() as [number, number];
  plotState.dataRangeY = DEFAULT_DATA_RANGE.slice() as [number, number];
  plotState.showGrid = options.showGrid !== undefined ? options.showGrid : true;
  plotState.showLegend = options.showLegend !== undefined ? options.showLegend : true;

  attachNavigation(canvas);
  redrawPlot();
  return canvas;
}

function sizeCanvasToDisplay(canvas: HTMLCanvasElement, fallbackW: number, fallbackH: number): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cssW = canvas.clientWidth || fallbackW;
  const cssH = canvas.clientHeight || fallbackH;
  canvas.width = Math.max(1, Math.round(cssW * dpr));
  canvas.height = Math.max(1, Math.round(cssH * dpr));
  const ctx = canvas.getContext('2d');
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const graphWidth = cssW * GRAPH_WIDTH_PERCENT;
  const graphHeight = cssH * GRAPH_HEIGHT_PERCENT;
  const marginX = (cssW - graphWidth) / 2;
  const marginY = (cssH - graphHeight) / 2;
  plotState.graphRect = { x: marginX, y: marginY, width: graphWidth, height: graphHeight };
}

export function clearPlot(): void {
  plotState.traceHistory = [];
  plotState.covarianceEllipse = null;
  plotState.dataRangeX = DEFAULT_DATA_RANGE.slice() as [number, number];
  plotState.dataRangeY = DEFAULT_DATA_RANGE.slice() as [number, number];
  userView = null;
  updateZoomLabel();
  redrawPlot();
}

/** Reset zoom/pan to auto-fit. */
export function resetView(): void {
  userView = null;
  updateZoomLabel();
  redrawPlot();
}

export function updatePlot(data: PlotData): void {
  updateDataRanges(data);

  if (data.truth && data.truth.length >= 2 && isFinite(data.truth[0]) && isFinite(data.truth[1])) {
    plotState.traceHistory.push({ x: data.truth[0], y: data.truth[1], type: 'truth', age: 0 });
  }
  if (data.estimate && data.estimate.length >= 2 && isFinite(data.estimate[0]) && isFinite(data.estimate[1])) {
    plotState.traceHistory.push({ x: data.estimate[0], y: data.estimate[1], type: 'estimate', age: 0 });
  }
  if (data.kf && data.kf.length >= 2 && isFinite(data.kf[0]) && isFinite(data.kf[1])) {
    plotState.traceHistory.push({ x: data.kf[0], y: data.kf[1], type: 'kf', age: 0 });
  }
  if (data.measurements) {
    for (const meas of data.measurements) {
      if (isFinite(meas.x) && isFinite(meas.y)) {
        plotState.traceHistory.push({ x: meas.x, y: meas.y, type: 'measurement', age: 0 });
      }
    }
  }

  const maxEntries = 8000;
  if (plotState.traceHistory.length > maxEntries) {
    plotState.traceHistory.splice(0, plotState.traceHistory.length - maxEntries);
  }

  if (data.covarianceEllipse) {
    plotState.covarianceEllipse = data.covarianceEllipse;
  }

  redrawPlot();
}

function ensureSpan(range: [number, number], minSpan: number): void {
  const span = range[1] - range[0];
  if (!isFinite(span) || span < minSpan) {
    const mid = isFinite(range[0]) && isFinite(range[1]) ? (range[0] + range[1]) / 2 : 0;
    const half = Math.max(minSpan / 2, Math.abs(mid) * 0.05, 1);
    range[0] = mid - half;
    range[1] = mid + half;
  }
}

function updateDataRanges(data: PlotData): void {
  const consider = (x: number, y: number) => {
    if (!isFinite(x) || !isFinite(y)) return;
    // Guard against absurd values blowing up the view
    if (Math.abs(x) > 1e7 || Math.abs(y) > 1e7) return;
    plotState.dataRangeX[0] = Math.min(plotState.dataRangeX[0], x);
    plotState.dataRangeX[1] = Math.max(plotState.dataRangeX[1], x);
    plotState.dataRangeY[0] = Math.min(plotState.dataRangeY[0], y);
    plotState.dataRangeY[1] = Math.max(plotState.dataRangeY[1], y);
  };

  if (data.truth?.length >= 2) consider(data.truth[0], data.truth[1]);
  if (data.estimate?.length >= 2) consider(data.estimate[0], data.estimate[1]);
  // KF baseline excluded: it may drift far and would blow up auto-fit
  if (data.measurements) for (const m of data.measurements) consider(m.x, m.y);

  ensureSpan(plotState.dataRangeX, 10);
  ensureSpan(plotState.dataRangeY, 10);
}

export function resizePlot(canvas: HTMLCanvasElement, width: number, height: number): void {
  sizeCanvasToDisplay(canvas, width, height);
  redrawPlot();
}

export function startAnimation(currentDataCallback?: () => PlotData): void {
  if (plotState.running) return;
  plotState.running = true;
  plotState.lastTime = performance.now();

  const animationStep = (timestamp: number) => {
    if (!plotState.running) return;
    plotState.lastTime = timestamp;
    try {
      const defaultData: PlotData = {
        time: timestamp / 1000,
        truth: [0, 0],
        estimate: [0, 0],
        kf: [0, 0],
        measurements: [],
        covarianceEllipse: [0, 0, 0],
      };
      const data = currentDataCallback ? currentDataCallback() : defaultData;
      updatePlot(data);
    } catch (err) {
      console.error('Plot animation step failed:', err);
    }
    plotState.rafId = requestAnimationFrame(animationStep);
  };

  plotState.rafId = requestAnimationFrame(animationStep);
}

export function stopAnimation(): void {
  plotState.running = false;
  if (plotState.rafId !== null) {
    cancelAnimationFrame(plotState.rafId);
    plotState.rafId = null;
  }
}

export function isAnimationRunning(): boolean {
  return plotState.running;
}

// --- View (zoom/pan) ---

type GraphRect = { x: number; y: number; width: number; height: number };

function effRanges(): { x0: number; x1: number; y0: number; y1: number } {
  if (userView) {
    return {
      x0: userView.cx - userView.spanX / 2,
      x1: userView.cx + userView.spanX / 2,
      y0: userView.cy - userView.spanY / 2,
      y1: userView.cy + userView.spanY / 2,
    };
  }
  return {
    x0: plotState.dataRangeX[0],
    x1: plotState.dataRangeX[1],
    y0: plotState.dataRangeY[0],
    y1: plotState.dataRangeY[1],
  };
}

function ensureUserView(): void {
  if (!userView) {
    const r = effRanges();
    userView = {
      cx: (r.x0 + r.x1) / 2,
      cy: (r.y0 + r.y1) / 2,
      spanX: Math.max(MIN_SPAN, r.x1 - r.x0),
      spanY: Math.max(MIN_SPAN, r.y1 - r.y0),
    };
  }
}

function updateZoomLabel(): void {
  const el = document.getElementById('plot-zoom');
  if (!el) return;
  if (!userView) {
    el.textContent = '';
    return;
  }
  const autoSpanX = Math.max(1e-9, plotState.dataRangeX[1] - plotState.dataRangeX[0]);
  const zoom = autoSpanX / Math.max(1e-9, userView.spanX);
  el.textContent = zoom >= 1 ? `${zoom.toFixed(1)}×` : `${zoom.toFixed(2)}×`;
}

function screenToData(px: number, py: number, graphRect: GraphRect): { x: number; y: number } {
  const r = effRanges();
  const spanX = Math.max(1e-9, r.x1 - r.x0);
  const spanY = Math.max(1e-9, r.y1 - r.y0);
  const tx = ((px - graphRect.x) / graphRect.width - PAD) / (1 - 2 * PAD);
  const ty = ((graphRect.y + graphRect.height * (1 - PAD) - py) / (graphRect.height * (1 - 2 * PAD)));
  return { x: r.x0 + tx * spanX, y: r.y0 + ty * spanY };
}

function zoomAt(px: number, py: number, factor: number): void {
  if (!isFinite(factor) || factor <= 0) return;
  ensureUserView();
  const v = userView!;
  const before = screenToData(px, py, plotState.graphRect);
  v.spanX = Math.min(MAX_SPAN, Math.max(MIN_SPAN, v.spanX * factor));
  v.spanY = Math.min(MAX_SPAN, Math.max(MIN_SPAN, v.spanY * factor));
  const after = screenToData(px, py, plotState.graphRect);
  v.cx += before.x - after.x;
  v.cy += before.y - after.y;
  updateZoomLabel();
  redrawPlot();
}

function panByPixels(x0: number, y0: number, x1: number, y1: number): void {
  ensureUserView();
  const v = userView!;
  const before = screenToData(x0, y0, plotState.graphRect);
  const after = screenToData(x1, y1, plotState.graphRect);
  v.cx += before.x - after.x;
  v.cy += before.y - after.y;
  redrawPlot();
}

function canvasPos(e: { clientX: number; clientY: number }, canvas: HTMLCanvasElement): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function attachNavigation(canvas: HTMLCanvasElement): void {
  if ((canvas as any).__navWired) return;
  (canvas as any).__navWired = true;

  canvas.addEventListener('wheel', (e: WheelEvent) => {
    e.preventDefault();
    const p = canvasPos(e, canvas);
    const unit = e.deltaMode === 1 ? 16 : 1;
    zoomAt(p.x, p.y, Math.exp(e.deltaY * unit * 0.0012));
  }, { passive: false });

  canvas.addEventListener('dblclick', () => resetView());

  const pointers = new Map<number, { x: number; y: number }>();
  let pinchDist = 0;

  canvas.addEventListener('pointerdown', (e: PointerEvent) => {
    canvas.setPointerCapture?.(e.pointerId);
    const p = canvasPos(e, canvas);
    pointers.set(e.pointerId, p);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    }
    canvas.style.cursor = 'grabbing';
  });

  canvas.addEventListener('pointermove', (e: PointerEvent) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const p = canvasPos(e, canvas);
    pointers.set(e.pointerId, p);
    if (pointers.size === 1) {
      panByPixels(prev.x, prev.y, p.x, p.y);
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const prevMid = { x: (mid.x + prev.x - p.x), y: (mid.y + prev.y - p.y) };
      if (pinchDist > 0 && dist > 0) zoomAt(mid.x, mid.y, pinchDist / dist);
      pinchDist = dist;
      panByPixels(prevMid.x, prevMid.y, mid.x, mid.y);
    }
  });

  const release = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchDist = 0;
    if (pointers.size === 0) canvas.style.cursor = 'grab';
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  canvas.setAttribute('tabindex', '0');
  canvas.addEventListener('keydown', (e: KeyboardEvent) => {
    const rect = plotState.graphRect;
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    const step = (userView?.spanX ?? (plotState.dataRangeX[1] - plotState.dataRangeX[0])) * 0.1;
    if (e.key === '+' || e.key === '=') zoomAt(cx, cy, 1 / 1.25);
    else if (e.key === '-' || e.key === '_') zoomAt(cx, cy, 1.25);
    else if (e.key === 'ArrowLeft') { ensureUserView(); userView!.cx -= step; redrawPlot(); }
    else if (e.key === 'ArrowRight') { ensureUserView(); userView!.cx += step; redrawPlot(); }
    else if (e.key === 'ArrowUp') { ensureUserView(); userView!.cy += step; redrawPlot(); }
    else if (e.key === 'ArrowDown') { ensureUserView(); userView!.cy -= step; redrawPlot(); }
    else if (e.key === '0') resetView();
    else return;
    e.preventDefault();
  });
}

// --- Rendering ---

function redrawPlot(): void {
  const canvas = getCanvas('plot-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const cssW = canvas.clientWidth || 800;
  const cssH = canvas.clientHeight || 560;
  const graphRect = plotState.graphRect;
  if (graphRect.width <= 0 || graphRect.height <= 0) return;

  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, cssW, cssH);

  if (plotState.showGrid) drawGrid(ctx, graphRect);
  drawAxes(ctx, graphRect);
  drawTraces(ctx, graphRect);
  drawMeasurements(ctx, graphRect);
  if (plotState.covarianceEllipse) drawCovarianceEllipse(ctx, graphRect, plotState.covarianceEllipse);
  if (plotState.showLegend) drawLegend(ctx, graphRect);

  // axis units
  ctx.fillStyle = COLORS.legendText;
  ctx.font = '11px monospace';
  ctx.fillText('km', graphRect.x + graphRect.width - 18, graphRect.y + graphRect.height + 16);
}

function spanGuarded(min: number, max: number): [number, number] {
  const span = max - min;
  if (!isFinite(span) || span <= 1e-9) {
    const mid = isFinite(min) && isFinite(max) ? (min + max) / 2 : 0;
    return [mid - 1, mid + 1];
  }
  return [min, max];
}

function dataXToPixel(xData: number, graphRect: GraphRect): number {
  const r = effRanges();
  const [mn, mx] = spanGuarded(r.x0, r.x1);
  const t = (xData - mn) / (mx - mn);
  return graphRect.x + graphRect.width * (PAD + t * (1 - 2 * PAD));
}

function dataYToPixel(yData: number, graphRect: GraphRect): number {
  const r = effRanges();
  const [mn, mx] = spanGuarded(r.y0, r.y1);
  const t = (yData - mn) / (mx - mn);
  return graphRect.y + graphRect.height * (1 - PAD - t * (1 - 2 * PAD));
}

function dataToPixelScaleX(graphRect: GraphRect): number {
  const r = effRanges();
  const [mn, mx] = spanGuarded(r.x0, r.x1);
  return (graphRect.width * (1 - 2 * PAD)) / (mx - mn);
}

function drawGrid(ctx: CanvasRenderingContext2D, graphRect: GraphRect): void {
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  const { x, y, width, height } = graphRect;
  ctx.strokeRect(x, y, width, height);
  const stepX = Math.max(24, width / 8);
  const stepY = Math.max(24, height / 8);
  ctx.beginPath();
  for (let gx = x + stepX; gx < x + width; gx += stepX) { ctx.moveTo(gx, y); ctx.lineTo(gx, y + height); }
  for (let gy = y + stepY; gy < y + height; gy += stepY) { ctx.moveTo(x, gy); ctx.lineTo(x + width, gy); }
  ctx.stroke();
}

function drawAxes(ctx: CanvasRenderingContext2D, graphRect: GraphRect): void {
  ctx.strokeStyle = COLORS.axis;
  ctx.lineWidth = 1;
  const { x, y, width, height } = graphRect;
  ctx.beginPath();
  ctx.moveTo(x, y + height);
  ctx.lineTo(x + width, y + height);
  ctx.moveTo(x, y);
  ctx.lineTo(x, y + height);
  ctx.stroke();
  ctx.fillStyle = COLORS.legendText;
  ctx.font = '11px monospace';
  ctx.fillText('x', x + width - 8, y + height - 6);
  ctx.fillText('y', x + 6, y + 12);
}

function drawTraces(ctx: CanvasRenderingContext2D, graphRect: GraphRect): void {
  const truth: TraceEntry[] = [];
  const est: TraceEntry[] = [];
  const kf: TraceEntry[] = [];
  for (const e of plotState.traceHistory) {
    if (e.type === 'truth') truth.push(e);
    else if (e.type === 'estimate') est.push(e);
    else if (e.type === 'kf') kf.push(e);
  }
  const drawTrace = (entries: TraceEntry[], color: string): void => {
    if (entries.length === 0) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    let first = true;
    for (const e of entries) {
      const px = dataXToPixel(e.x, graphRect);
      const py = dataYToPixel(e.y, graphRect);
      if (!isFinite(px) || !isFinite(py)) continue;
      if (first) { ctx.moveTo(px, py); first = false; }
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  };
  drawTrace(truth, COLORS.truth);
  drawTrace(est, COLORS.ekf);
  if (kf.length > 0) drawTrace(kf, COLORS.kf);
}

function drawMeasurements(ctx: CanvasRenderingContext2D, graphRect: GraphRect): void {
  ctx.fillStyle = COLORS.measurement;
  for (const e of plotState.traceHistory) {
    if (e.type !== 'measurement') continue;
    const px = dataXToPixel(e.x, graphRect);
    const py = dataYToPixel(e.y, graphRect);
    if (!isFinite(px) || !isFinite(py)) continue;
    ctx.beginPath();
    ctx.arc(px, py, 2, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawCovarianceEllipse(ctx: CanvasRenderingContext2D, graphRect: GraphRect, ellipse: [number, number, number]): void {
  const [cx, cy, r] = ellipse;
  if (!isFinite(cx) || !isFinite(cy) || !isFinite(r) || r <= 0) return;
  const px = dataXToPixel(cx, graphRect);
  const py = dataYToPixel(cy, graphRect);
  const scaleX = dataToPixelScaleX(graphRect);
  const rPx = Math.max(2, Math.min(120, r * scaleX));
  ctx.fillStyle = COLORS.ellipseFill;
  ctx.strokeStyle = COLORS.ellipseStroke;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(px, py, rPx, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

function drawLegend(ctx: CanvasRenderingContext2D, graphRect: GraphRect): void {
  const { x, y, width } = graphRect;
  ctx.font = '11px monospace';
  const entries = [
    { color: COLORS.truth, label: 'Truth' },
    { color: COLORS.ekf, label: 'EKF Est.' },
    { color: COLORS.kf, label: 'Drift (no update)' },
    { color: COLORS.measurement, label: 'Meas.' },
  ];
  let startY = y + 8;
  const boxX = x + width - 150;
  for (const e of entries) {
    ctx.fillStyle = e.color;
    ctx.fillRect(boxX, startY, 12, 10);
    ctx.fillStyle = COLORS.legendText;
    ctx.fillText(e.label, boxX + 16, startY + 9);
    startY += 17;
  }
}
