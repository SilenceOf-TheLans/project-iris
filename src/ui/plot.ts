/**
 * Plot module for the Project IRIS EKF Simulator.
 * Canvas-based 2D trajectory plot (X vs Y, km) with AMOLED aesthetic.
 * Navigation: wheel zoom (to cursor), drag pan, pinch zoom (touch),
 * double-click / keyboard 0 to reset, keyboard arrows/+/- to move/zoom.
 * Layers: click legend icons (or keys 1-5) to toggle truth / estimate /
 * drift / measurements / covariance ellipse.
 */

export interface PlotOptions {
  canvasId: string;
  width: number;
  height: number;
  showGrid?: boolean;
  showLegend?: boolean;
}

export type CovarianceEllipse = [cx: number, cy: number, majorKm: number, minorKm: number, angleRad: number];

export interface PlotData {
  time: number;
  truth: number[];
  estimate?: number[];
  kf?: number[];
  measurements: { x: number; y: number }[];
  covarianceEllipse?: CovarianceEllipse;
}

interface TraceEntry {
  x: number;
  y: number;
  type: 'truth' | 'estimate' | 'kf' | 'measurement';
  age: number;
}

export type LayerId = 'truth' | 'estimate' | 'kf' | 'measurement' | 'ellipse';

export type LayerVisibility = Record<LayerId, boolean>;

interface PlotState {
  rafId: number | null;
  running: boolean;
  lastTime: number;
  traceHistory: TraceEntry[];
  covarianceEllipse: CovarianceEllipse | null;
  graphRect: { x: number; y: number; width: number; height: number };
  dataRangeX: [number, number];
  dataRangeY: [number, number];
  showGrid: boolean;
  showLegend: boolean;
  layers: LayerVisibility;
}

interface LegendHitBox {
  x: number;
  y: number;
  w: number;
  h: number;
  layer: LayerId;
}

interface UserView {
  cx: number;
  cy: number;
  spanX: number;
  spanY: number;
}

export const AXIS_STYLE = {
  color: '#f0f0f0',
  width: 1.5,
  titleColor: '#ffffff',
  titleFont: 'bold 11px monospace',
  tickColor: '#d0d0d0',
  tickFont: '10px monospace',
} as const;

const COLORS = {
  background: '#000000',
  grid: '#2a2a2a',
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
  layers: { truth: true, estimate: true, kf: true, measurement: true, ellipse: true },
};

/** Hit boxes for the clickable legend (CSS pixels, relative to canvas). Rebuilt on every drawLegend. */
let legendHitBoxes: LegendHitBox[] = [];

/** Layer visibility accessors for UI / tests. */
export function getLayerVisibility(): LayerVisibility {
  return { ...plotState.layers };
}

export function isLayerVisible(layer: LayerId): boolean {
  return plotState.layers[layer];
}

export function setLayerVisible(layer: LayerId, visible: boolean): void {
  plotState.layers[layer] = visible;
  redrawPlot();
}

export function toggleLayer(layer: LayerId): boolean {
  plotState.layers[layer] = !plotState.layers[layer];
  redrawPlot();
  return plotState.layers[layer];
}

export function setAllLayersVisible(visible: boolean): void {
  (Object.keys(plotState.layers) as LayerId[]).forEach((k) => {
    plotState.layers[k] = visible;
  });
  redrawPlot();
}

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

  // Graph box stays a rectangle that fills the canvas proportions. 1:1 data
  // scaling is enforced in effRanges() by expanding one axis's range so the
  // data aspect matches the box aspect — pixels-per-km are then identical on
  // both axes without shrinking the box.
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

/**
 * Append a PlotData sample to the trace history.
 *
 * `redraw = false` batches multiple intermediate samples (for example the
 * substeps of a long prediction gap, or several steps at high playback speed)
 * and avoids repainting the canvas dozens of times per animation frame. The
 * caller must finish with a normal `updatePlot(..., true)` call.
 */
export function updatePlot(data: PlotData, redraw = true): void {
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

  if (redraw) redrawPlot();
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
  if (data.estimate && data.estimate.length >= 2) consider(data.estimate[0], data.estimate[1]);
  // KF baseline excluded: it may drift far and would blow up auto-fit
  if (data.measurements) for (const m of data.measurements) consider(m.x, m.y);

  ensureSpan(plotState.dataRangeX, 10);
  ensureSpan(plotState.dataRangeY, 10);
}

export function resizePlot(canvas: HTMLCanvasElement, width: number, height: number): void {
  sizeCanvasToDisplay(canvas, width, height);
  redrawPlot();
}

export function startAnimation(currentDataCallback?: () => PlotData | null): void {
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
      };
      const data = currentDataCallback ? currentDataCallback() : defaultData;
      // A null callback result means this frame was a playback-speed skip:
      // there is no new simulation state to draw, so keep the existing plot.
      if (data) updatePlot(data);
    } catch (err) {
      console.error('Plot animation step failed:', err);
    }
    // The callback may have paused or finished the run. Do not schedule a
    // second RAF chain from an already-finished frame: a later Run would then
    // have two loops mutating the filter state.
    if (plotState.running) {
      plotState.rafId = requestAnimationFrame(animationStep);
    }
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
  const graphRect = plotState.graphRect;
  // Plotting area inside the box (excludes the PAD margin on each side). Same
  // (1 - 2*PAD) factor on both axes, so plotAreaW/plotAreaH == box width/height.
  const plotAreaW = Math.max(1, graphRect.width * (1 - 2 * PAD));
  const plotAreaH = Math.max(1, graphRect.height * (1 - 2 * PAD));
  const boxAspect = plotAreaW / plotAreaH;

  if (userView) {
    const v = userView;
    // Keep 1:1: spanY is derived from spanX so pixels-per-km match on both axes.
    const spanX = Math.max(MIN_SPAN, v.spanX);
    const spanY = spanX / boxAspect;
    return {
      x0: v.cx - spanX / 2,
      x1: v.cx + spanX / 2,
      y0: v.cy - spanY / 2,
      y1: v.cy + spanY / 2,
    };
  }

  // Auto-fit: largest uniform scale that contains all the data while filling
  // the rectangular box. One axis exactly spans the data; the other gets
  // headroom so the box stays rectangular and pixels-per-km stay equal.
  const spanX = plotState.dataRangeX[1] - plotState.dataRangeX[0];
  const spanY = plotState.dataRangeY[1] - plotState.dataRangeY[0];
  const cx = (plotState.dataRangeX[0] + plotState.dataRangeX[1]) / 2;
  const cy = (plotState.dataRangeY[0] + plotState.dataRangeY[1]) / 2;
  const safeX = Math.max(1e-9, spanX);
  const safeY = Math.max(1e-9, spanY);
  const scale = Math.min(plotAreaW / safeX, plotAreaH / safeY);
  const shownSpanX = plotAreaW / scale;
  const shownSpanY = plotAreaH / scale;
  return {
    x0: cx - shownSpanX / 2,
    x1: cx + shownSpanX / 2,
    y0: cy - shownSpanY / 2,
    y1: cy + shownSpanY / 2,
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

function hitLegend(px: number, py: number): LayerId | null {
  for (const b of legendHitBoxes) {
    if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) return b.layer;
  }
  return null;
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

  canvas.addEventListener('dblclick', (e: MouseEvent) => {
    // Double-click on legend should toggle, not reset view.
    const p = canvasPos(e, canvas);
    if (plotState.showLegend && hitLegend(p.x, p.y)) return;
    resetView();
  });

  const pointers = new Map<number, { x: number; y: number }>();
  let pinchDist = 0;
  let downX = 0;
  let downY = 0;
  let downTime = 0;
  let dragMoved = false;

  canvas.addEventListener('pointerdown', (e: PointerEvent) => {
    canvas.setPointerCapture?.(e.pointerId);
    const p = canvasPos(e, canvas);
    pointers.set(e.pointerId, p);
    if (pointers.size === 1) {
      downX = p.x;
      downY = p.y;
      downTime = performance.now();
      dragMoved = false;
    }
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      dragMoved = true;
    }
    canvas.style.cursor = 'grabbing';
  });

  canvas.addEventListener('pointermove', (e: PointerEvent) => {
    // Hover cursor when no button is pressed.
    if (e.buttons === 0 && pointers.size === 0) {
      const p = canvasPos(e, canvas);
      canvas.style.cursor = plotState.showLegend && hitLegend(p.x, p.y) ? 'pointer' : 'grab';
      return;
    }
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const p = canvasPos(e, canvas);
    pointers.set(e.pointerId, p);
    if (pointers.size === 1) {
      if (Math.hypot(p.x - downX, p.y - downY) > 5) dragMoved = true;
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
    const wasSingleTap =
      pointers.size === 1 &&
      !dragMoved &&
      performance.now() - downTime < 500;
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchDist = 0;
    if (pointers.size === 0) {
      canvas.style.cursor = 'grab';
      if (wasSingleTap) {
        const p = canvasPos(e, canvas);
        // Only treat small drifts as taps (pointer capture may shift coords slightly).
        if (Math.hypot(p.x - downX, p.y - downY) <= 8 && plotState.showLegend) {
          const layer = hitLegend(p.x, p.y);
          if (layer) toggleLayer(layer);
        }
      }
    }
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  canvas.setAttribute('tabindex', '0');
  canvas.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === '1') { toggleLayer('truth'); e.preventDefault(); return; }
    if (e.key === '2') { toggleLayer('estimate'); e.preventDefault(); return; }
    if (e.key === '3') { toggleLayer('kf'); e.preventDefault(); return; }
    if (e.key === '4') { toggleLayer('measurement'); e.preventDefault(); return; }
    if (e.key === '5') { toggleLayer('ellipse'); e.preventDefault(); return; }
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
  // Keep the graph box a rectangle filling the canvas; 1:1 scaling is enforced
  // by effRanges() every frame (loop engineering).
  plotState.graphRect = {
    x: (cssW - cssW * GRAPH_WIDTH_PERCENT) / 2,
    y: (cssH - cssH * GRAPH_HEIGHT_PERCENT) / 2,
    width: cssW * GRAPH_WIDTH_PERCENT,
    height: cssH * GRAPH_HEIGHT_PERCENT,
  };
  const graphRect = plotState.graphRect;
  if (graphRect.width <= 0 || graphRect.height <= 0) return;

  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, cssW, cssH);

  if (plotState.showGrid) drawGrid(ctx, graphRect);

  // Clip data layers to the full graph box so traces / measurements /
  // covariance never spill outside the graph's data limits (e.g. into the
  // legend or off-canvas when points fall outside the current view range).
  ctx.save();
  ctx.beginPath();
  ctx.rect(graphRect.x, graphRect.y, graphRect.width, graphRect.height);
  ctx.clip();
  drawTraces(ctx, graphRect);
  drawMeasurements(ctx, graphRect);
  if (plotState.covarianceEllipse && plotState.layers.ellipse) drawCovarianceEllipse(ctx, graphRect, plotState.covarianceEllipse);
  ctx.restore();

  // Draw the coordinate axes above the traces, matching the error chart.
  drawAxes(ctx, graphRect);

  if (plotState.showLegend) drawLegend(ctx, graphRect);
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

/**
 * Compute "nice" tick positions for an axis so gridlines track the data
 * (and therefore zoom/pan) instead of fixed pixel spacing.
 * Returns the tick values plus the step used (for label formatting).
 */
/** Tick values + step for tests/embedding. Exported for unit testing. */
export function niceTicks(min: number, max: number, target: number): { ticks: number[]; step: number } {
  const span = max - min;
  if (!isFinite(span) || span <= 0 || !(target > 0)) return { ticks: [], step: 1 };
  const rawStep = span / target;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  let mult = 10;
  if (norm <= 1) mult = 1;
  else if (norm <= 2) mult = 2;
  else if (norm <= 2.5) mult = 2.5;
  else if (norm <= 5) mult = 5;
  const step = mult * mag;
  const ticks: number[] = [];
  let v = Math.ceil(min / step - 1e-9) * step;
  for (let i = 0; i < 64 && v <= max + step * 1e-9; i++) {
    ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    v += step;
  }
  return { ticks, step };
}

export function tickDecimals(step: number): number {
  if (!isFinite(step) || step <= 0) return 0;
  return Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
}

export function formatTick(v: number, decimals: number): string {
  const s = v.toFixed(decimals);
  // Normalize "-0.00" -> "0.00"
  if (parseFloat(s) === 0) return (0).toFixed(decimals);
  return s;
}

/**
 * Generate tick values that are multiples of `step` within [min, max].
 * Like niceTicks but uses a prescribed step so both axes can share it.
 */
function ticksAtStep(min: number, max: number, step: number): number[] {
  const ticks: number[] = [];
  if (!isFinite(step) || step <= 0) return ticks;
  let v = Math.ceil(min / step - 1e-9) * step;
  for (let i = 0; i < 1000 && v <= max + step * 1e-9; i++) {
    ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    v += step;
  }
  return ticks;
}

/**
 * Single nice tick step suitable for both X and Y axes. Using the same step
 * on both axes guarantees matching numeric labels (multiples of step) where
 * the ranges overlap, instead of each axis picking its own step and one
 * showing 5000 while the other only shows 4000 and 6000.
 * Picks the coarser of the two per-axis nice steps so neither axis exceeds
 * its target tick count.
 */
function commonTickStep(
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  targetX: number,
  targetY: number,
): number {
  const sx = niceTicks(x0, x1, targetX).step;
  const sy = niceTicks(y0, y1, targetY).step;
  if (!sx || !sy) return sx || sy || 1;
  return Math.max(sx, sy);
}

function drawGrid(ctx: CanvasRenderingContext2D, graphRect: GraphRect): void {
  const r = effRanges();
  const [x0, x1] = spanGuarded(r.x0, r.x1);
  const [y0, y1] = spanGuarded(r.y0, r.y1);
  const { x, y, width, height } = graphRect;

  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, width, height);

  // Matching labels on both axes: one common nice step, so X and Y show the
  // same numeric multiples (where their ranges overlap).
  const xTarget = Math.max(3, Math.floor(width / 110));
  const yTarget = Math.max(3, Math.floor(height / 70));
  const step = commonTickStep(x0, x1, y0, y1, xTarget, yTarget);
  const xTicks = ticksAtStep(x0, x1, step);
  const yTicks = ticksAtStep(y0, y1, step);
  ctx.beginPath();
  for (const t of xTicks) {
    const gx = dataXToPixel(t, graphRect);
    ctx.moveTo(gx, y);
    ctx.lineTo(gx, y + height);
  }
  for (const t of yTicks) {
    const gy = dataYToPixel(t, graphRect);
    ctx.moveTo(x, gy);
    ctx.lineTo(x + width, gy);
  }
  ctx.stroke();
}

function drawAxes(ctx: CanvasRenderingContext2D, graphRect: GraphRect): void {
  const r = effRanges();
  const [x0, x1] = spanGuarded(r.x0, r.x1);
  const [y0, y1] = spanGuarded(r.y0, r.y1);
  const { x, y, width, height } = graphRect;

  ctx.save();
  // Coordinate axes at x=0 / y=0 when they fall inside the visible view.
  ctx.strokeStyle = AXIS_STYLE.color;
  ctx.lineWidth = AXIS_STYLE.width;
  ctx.beginPath();
  if (x0 <= 0 && 0 <= x1) {
    const zx = dataXToPixel(0, graphRect);
    ctx.moveTo(zx, y);
    ctx.lineTo(zx, y + height);
  }
  if (y0 <= 0 && 0 <= y1) {
    const zy = dataYToPixel(0, graphRect);
    ctx.moveTo(x, zy);
    ctx.lineTo(x + width, zy);
  }
  ctx.stroke();

  // Axis titles with units.
  ctx.fillStyle = AXIS_STYLE.titleColor;
  ctx.font = AXIS_STYLE.titleFont;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText('x (km)', x + width / 2, y + height + 20);

  // Tick labels in the margins (always shown, even if grid is off).
  const xTarget = Math.max(3, Math.floor(width / 110));
  const yTarget = Math.max(3, Math.floor(height / 70));
  const step = commonTickStep(x0, x1, y0, y1, xTarget, yTarget);
  const xTicks = ticksAtStep(x0, x1, step);
  const yTicks = ticksAtStep(y0, y1, step);
  const dec = tickDecimals(step);
  ctx.fillStyle = AXIS_STYLE.tickColor;
  ctx.font = AXIS_STYLE.tickFont;
  for (const t of xTicks) {
    ctx.fillText(formatTick(t, dec), dataXToPixel(t, graphRect), y + height + 5);
  }
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const t of yTicks) {
    ctx.fillText(formatTick(t, dec), x - 6, dataYToPixel(t, graphRect));
  }
  let maxLabelW = 0;
  for (const t of yTicks) {
    maxLabelW = Math.max(maxLabelW, ctx.measureText(formatTick(t, dec)).width);
  }
  const titleX = Math.max(10, x - 10 - maxLabelW - 12);
  ctx.fillStyle = AXIS_STYLE.titleColor;
  ctx.font = AXIS_STYLE.titleFont;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.save();
  ctx.translate(titleX, y + height / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('y (km)', 0, 0);
  ctx.restore();
  ctx.restore();
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
  const drawTrace = (entries: TraceEntry[], color: string, width: number, dash: number[] = []): void => {
    if (entries.length === 0) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dash);
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
    ctx.setLineDash([]);
  };
  // Draw the no-update drift baseline first (and dashed) so it never hides the
  // truth/estimate traces when the three curves overlap.
  if (plotState.layers.kf && kf.length > 0) drawTrace(kf, COLORS.kf, 1.2, [6, 4]);
  if (plotState.layers.truth) drawTrace(truth, COLORS.truth, 2.4);
  if (plotState.layers.estimate) drawTrace(est, COLORS.ekf, 1.7);
}

function drawMeasurements(ctx: CanvasRenderingContext2D, graphRect: GraphRect): void {
  if (!plotState.layers.measurement) return;
  ctx.fillStyle = COLORS.measurement;
  for (const e of plotState.traceHistory) {
    if (e.type !== 'measurement') continue;
    const px = dataXToPixel(e.x, graphRect);
    const py = dataYToPixel(e.y, graphRect);
    if (!isFinite(px) || !isFinite(py)) continue;
    ctx.beginPath();
    ctx.arc(px, py, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawCovarianceEllipse(ctx: CanvasRenderingContext2D, graphRect: GraphRect, ellipse: CovarianceEllipse): void {
  const [cx, cy, majorKm, minorKm, angle] = ellipse;
  if (![cx, cy, majorKm, minorKm, angle].every(Number.isFinite)) return;
  if (majorKm <= 0 || minorKm < 0) return;

  const px = dataXToPixel(cx, graphRect);
  const py = dataYToPixel(cy, graphRect);
  const scaleX = dataToPixelScaleX(graphRect);
  const rawMajor = majorKm * scaleX;
  const rawMinor = minorKm * scaleX;
  if (!(rawMajor > 0) || !Number.isFinite(rawMajor) || !Number.isFinite(rawMinor)) return;

  // Keep the 2σ ellipse visible but bounded. One uniform display scale keeps
  // its aspect ratio and orientation intact.
  const displayScale = Math.min(120 / rawMajor, Math.max(1, 2 / rawMajor));
  const majorPx = rawMajor * displayScale;
  const minorPx = Math.max(1, rawMinor * displayScale);

  ctx.fillStyle = COLORS.ellipseFill;
  ctx.strokeStyle = COLORS.ellipseStroke;
  ctx.lineWidth = 1;
  ctx.beginPath();
  // Canvas Y grows downward, so negate the data-space rotation.
  ctx.ellipse(px, py, majorPx, minorPx, -angle, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

function drawLegend(ctx: CanvasRenderingContext2D, graphRect: GraphRect): void {
  const { x, y, width } = graphRect;
  ctx.save();
  ctx.font = '11px monospace';
  const entries: { layer: LayerId; color: string; label: string; kind: 'line' | 'dot' | 'ellipse' }[] = [
    { layer: 'truth', color: COLORS.truth, label: 'Truth', kind: 'line' },
    { layer: 'estimate', color: COLORS.ekf, label: 'EKF Est.', kind: 'line' },
    { layer: 'kf', color: COLORS.kf, label: 'Drift (no update)', kind: 'line' },
    { layer: 'measurement', color: COLORS.measurement, label: 'Meas.', kind: 'dot' },
    { layer: 'ellipse', color: COLORS.ellipseStroke, label: 'Cov 2σ', kind: 'ellipse' },
  ];
  const boxX = x + width - 150;
  const rowW = 142;
  const rowH = 17;
  legendHitBoxes = [];
  // Header hint that legend is clickable.
  ctx.fillStyle = COLORS.legendText;
  ctx.globalAlpha = 0.6;
  ctx.fillText('Layers (click)', boxX, y + 8);
  ctx.globalAlpha = 1;
  let startY = y + 14;
  for (const e of entries) {
    const visible = plotState.layers[e.layer];
    const rowY = startY;
    legendHitBoxes.push({ x: boxX - 4, y: rowY - 2, w: rowW, h: rowH, layer: e.layer });
    ctx.globalAlpha = visible ? 1 : 0.35;
    if (e.kind === 'line') {
      ctx.fillStyle = e.color;
      if (visible) {
        ctx.fillRect(boxX, rowY, 12, 10);
      } else {
        ctx.strokeStyle = e.color;
        ctx.lineWidth = 1;
        ctx.strokeRect(boxX + 0.5, rowY + 0.5, 11, 9);
        // X across the swatch to signal hidden.
        ctx.beginPath();
        ctx.moveTo(boxX, rowY + 10);
        ctx.lineTo(boxX + 12, rowY);
        ctx.stroke();
      }
    } else if (e.kind === 'dot') {
      ctx.fillStyle = e.color;
      ctx.beginPath();
      ctx.arc(boxX + 6, rowY + 5, 3, 0, Math.PI * 2);
      if (visible) ctx.fill();
      else ctx.stroke();
    } else {
      ctx.fillStyle = COLORS.ellipseFill;
      ctx.strokeStyle = e.color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(boxX + 6, rowY + 5, 5, 0, Math.PI * 2);
      if (visible) ctx.fill();
      ctx.stroke();
    }
    ctx.fillStyle = COLORS.legendText;
    ctx.fillText(e.label, boxX + 16, rowY + 9);
    if (!visible) {
      // Strikethrough for hidden layers.
      const labelW = ctx.measureText(e.label).width;
      const lineY = rowY + 5;
      ctx.strokeStyle = COLORS.legendText;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(boxX + 16, lineY);
      ctx.lineTo(boxX + 16 + labelW, lineY);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    startY += rowH;
  }
  ctx.restore();
}
