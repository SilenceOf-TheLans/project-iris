/**
 * Plot module for the Project IRIS EKF Simulator.
 *
 * Provides a Canvas-based oscilloscope-style graph with AMOLED aesthetic.
 * Displays truth, EKF estimate, linear KF, measurements, and covariance ellipses.
 */

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

/**
 * Options for initializing the plot canvas.
 */
export interface PlotOptions {
  /** DOM element ID for the canvas */
  canvasId: string;
  /** Canvas width in pixels */
  width: number;
  /** Canvas height in pixels */
  height: number;
  /** Whether to show grid lines */
  showGrid?: boolean;
  /** Whether to show legend */
  showLegend?: boolean;
}

/**
 * Data for updating the plot at each animation frame.
 */
export interface PlotData {
  /** Current simulation time [s] */
  time: number;
  /** Truth position [x, y] */
  truth: number[];
  /** EKF estimate position [x, y] */
  estimate: number[];
  /** Linear KF position [x, y] */
  kf: number[];
  /** Measurement points */
  measurements: { x: number; y: number }[];
  /** 2σ covariance ellipse parameters [cx, cy, r] */
  covarianceEllipse: [number, number, number];
}

/**
 * Entry in the trace history, with type and age for fade-out effect.
 */
interface TraceEntry {
  /** Data x coordinate */
  x: number;
  /** Data y coordinate */
  y: number;
  /** Entry type for color assignment */
  type: 'truth' | 'estimate' | 'kf' | 'measurement';
  /** Age in animation frames (for fade-out) */
  age: number;
}

/**
 * Internal state for the plot rendering loop.
 */
interface PlotState {
  /** Animation frame request ID */
  rafId: number | null;
  /** Whether the plot is running */
  running: boolean;
  /** Last animation time */
  lastTime: number;
  /** Trace history for fade-out effect */
  traceHistory: TraceEntry[];
  /** Current covariance ellipse params */
  covarianceEllipse: [number, number, number] | null;
  /** Graph area rectangle */
  graphRect: { x: number; y: number; width: number; height: number };
  /** Data range for x-axis (min, max) */
  dataRangeX: [number, number];
  /** Data range for y-axis (min, max) */
  dataRangeY: [number, number];
  /** Whether to show grid */
  showGrid: boolean;
  /** Whether to show legend */
  showLegend: boolean;
}

// ---------------------------------------------------------------------------
// Constants (AMOLED aesthetic)
// ---------------------------------------------------------------------------

const COLORS = {
  background: '#000000',
  grid: '#333333',
  axis: '#b0b0b0',
  truth: '#00ff00',
  ekf: '#00ffff',
  kf: '#ff0000',
  measurement: '#ffffff',
  legendText: '#e0e0e0',
  ellipseFill: 'rgba(0, 255, 255, 0.3)',
  ellipseStroke: 'rgba(0, 255, 255, 0.8)',
};

const MARGIN_PERCENT = 0.1; // 10% margin on each side
const GRAPH_WIDTH_PERCENT = 0.8; // 80% of canvas width
const GRAPH_HEIGHT_PERCENT = 0.8; // 80% of canvas height

// Default data range if not yet computed
const DEFAULT_DATA_RANGE: [number, number] = [-2, 2];

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initializes the plot canvas with the given ID and options.
 *
 * Sets up the canvas element, rendering context, and initial rendering.
 * The canvas pixel dimensions are set to the provided width/height.
 * A graph area of 80% × 80% with 10% margins is calculated and used
 * for all drawing. The canvas is returned for further manipulation.
 *
 * @param canvasId - DOM element ID for the canvas
 * @param options - Initialization options
 * @returns The canvas element
 */
export function initPlot(canvasId: string, options: PlotOptions): HTMLCanvasElement {
  const canvas = document.getElementById(canvasId) as HTMLCanvasElement;
  if (!canvas) {
    console.error(`Plot: canvas element with id="${canvasId}" not found`);
    return document.createElement('canvas');
  }

  // Set canvas pixel dimensions
  canvas.width = options.width;
  canvas.height = options.height;

  // Get rendering context and clear with black
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Calculate graph area rect
  const graphWidth = canvas.width * GRAPH_WIDTH_PERCENT;
  const graphHeight = canvas.height * GRAPH_HEIGHT_PERCENT;
  const marginX = (canvas.width - graphWidth) / 2;
  const marginY = (canvas.height - graphHeight) / 2;
  plotState.graphRect = {
    x: marginX,
    y: marginY,
    width: graphWidth,
    height: graphHeight,
  };

  // Initialize data ranges to defaults
  plotState.dataRangeX = DEFAULT_DATA_RANGE.slice() as [number, number];
  plotState.dataRangeY = DEFAULT_DATA_RANGE.slice() as [number, number];

  // Initialize showGrid/showLegend from options
  plotState.showGrid = options.showGrid !== undefined ? options.showGrid : true;
  plotState.showLegend = options.showLegend !== undefined ? options.showLegend : true;

  // Initial draw
  redrawPlot();

  return canvas;
}

/**
 * Updates the plot with new data point.
 *
 * This function adds the latest data to the trace history and triggers a
 * redraw. It is intended to be called on every `requestAnimationFrame` step.
 *
 * @param data - The plot data containing truth, estimate, KF, measurements,
 *   and covariance ellipse information
 */
export function updatePlot(data: PlotData): void {
  // Update data ranges based on new data
  updateDataRanges(data);

  // Add new trace entries from the current data point
  if (data.truth && data.truth.length >= 2) {
    plotState.traceHistory.push({
      x: data.truth[0],
      y: data.truth[1],
      type: 'truth',
      age: 0,
    });
  }
  if (data.estimate && data.estimate.length >= 2) {
    plotState.traceHistory.push({
      x: data.estimate[0],
      y: data.estimate[1],
      type: 'estimate',
      age: 0,
    });
  }
  if (data.kf && data.kf.length >= 2) {
    plotState.traceHistory.push({
      x: data.kf[0],
      y: data.kf[1],
      type: 'kf',
      age: 0,
    });
  }
  if (data.measurements) {
    for (const meas of data.measurements) {
      plotState.traceHistory.push({
        x: meas.x,
        y: meas.y,
        type: 'measurement',
        age: 0,
      });
    }
  }

  // Prune old traces: keep only recent entries (age < 100 frames ≈ 1.6 seconds at 60fps)
  const maxAge = 100;
  plotState.traceHistory = plotState.traceHistory.filter(
    (entry) => entry.age < maxAge
  );

  // Increment age for all remaining entries
  plotState.traceHistory.forEach((entry) => {
    entry.age += 1;
  });

  // Update covariance ellipse if provided
  if (data.covarianceEllipse) {
    plotState.covarianceEllipse = data.covarianceEllipse;
  }

  // Redraw the plot
  redrawPlot();
}

/**
 * Updates the data range min/max based on new plot data.
 */
function updateDataRanges(data: PlotData): void {
  // Initialize ranges if empty (first data point)
  if (
    plotState.dataRangeX[0] === DEFAULT_DATA_RANGE[0] &&
    plotState.dataRangeX[1] === DEFAULT_DATA_RANGE[1]
  ) {
    plotState.dataRangeX = [Infinity, -Infinity];
    plotState.dataRangeY = [Infinity, -Infinity];
  }

  // Truth
  if (data.truth && data.truth.length >= 2) {
    plotState.dataRangeX[0] = Math.min(plotState.dataRangeX[0], data.truth[0]);
    plotState.dataRangeX[1] = Math.max(plotState.dataRangeX[1], data.truth[0]);
    plotState.dataRangeY[0] = Math.min(plotState.dataRangeY[0], data.truth[1]);
    plotState.dataRangeY[1] = Math.max(plotState.dataRangeY[1], data.truth[1]);
  }

  // EKF estimate
  if (data.estimate && data.estimate.length >= 2) {
    plotState.dataRangeX[0] = Math.min(plotState.dataRangeX[0], data.estimate[0]);
    plotState.dataRangeX[1] = Math.max(plotState.dataRangeX[1], data.estimate[0]);
    plotState.dataRangeY[0] = Math.min(plotState.dataRangeY[0], data.estimate[1]);
    plotState.dataRangeY[1] = Math.max(plotState.dataRangeY[1], data.estimate[1]);
  }

  // Linear KF
  if (data.kf && data.kf.length >= 2) {
    plotState.dataRangeX[0] = Math.min(plotState.dataRangeX[0], data.kf[0]);
    plotState.dataRangeX[1] = Math.max(plotState.dataRangeX[1], data.kf[0]);
    plotState.dataRangeY[0] = Math.min(plotState.dataRangeY[0], data.kf[1]);
    plotState.dataRangeY[1] = Math.max(plotState.dataRangeY[1], data.kf[1]);
  }

  // Measurements
  if (data.measurements) {
    for (const meas of data.measurements) {
      plotState.dataRangeX[0] = Math.min(plotState.dataRangeX[0], meas.x);
      plotState.dataRangeX[1] = Math.max(plotState.dataRangeX[1], meas.x);
      plotState.dataRangeY[0] = Math.min(plotState.dataRangeY[0], meas.y);
      plotState.dataRangeY[1] = Math.max(plotState.dataRangeY[1], meas.y);
    }
  }

  // Covariance ellipse center
  if (data.covarianceEllipse) {
    const [cx, cy, r] = data.covarianceEllipse;
    plotState.dataRangeX[0] = Math.min(plotState.dataRangeX[0], cx - r);
    plotState.dataRangeX[1] = Math.max(plotState.dataRangeX[1], cx + r);
    plotState.dataRangeY[0] = Math.min(plotState.dataRangeY[0], cy - r);
    plotState.dataRangeY[1] = Math.max(plotState.dataRangeY[1], cy + r);
  }

  // Clamp ranges to at least the default range if no data has been added yet
  if (plotState.dataRangeX[0] === Infinity) {
    plotState.dataRangeX = DEFAULT_DATA_RANGE.slice() as [number, number];
  }
  if (plotState.dataRangeY[0] === Infinity) {
    plotState.dataRangeY = DEFAULT_DATA_RANGE.slice() as [number, number];
  }
}

/**
 * Resizes the plot canvas to the given dimensions.
 *
 * Recalculates the graph area based on the new canvas size, maintaining
 * the 80% × 80% graph area with 10% margins. Redraws the plot with
 * the current data and updated data ranges.
 *
 * @param canvas - The canvas element to resize
 * @param width - New canvas width in pixels
 * @param height - New canvas height in pixels
 */
export function resizePlot(canvas: HTMLCanvasElement, width: number, height: number): void {
  // Set canvas pixel dimensions
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Calculate graph area: 80% width, 80% height, 10% margins
  const graphWidth = width * GRAPH_WIDTH_PERCENT;
  const graphHeight = height * GRAPH_HEIGHT_PERCENT;
  const marginX = (width - graphWidth) / 2;
  const marginY = (height - graphHeight) / 2;

  // Update graph rect in state
  plotState.graphRect = {
    x: marginX,
    y: marginY,
    width: graphWidth,
    height: graphHeight,
  };

  // Redraw the plot
  redrawPlot();
}

/**
 * Starts the plot animation loop.
 *
 * Begins the `requestAnimationFrame` loop that will call `updatePlot`
 * on each frame with the current simulation data. Must be called after
 * `initPlot`.
 *
 * @param currentDataCallback - Optional callback that provides current PlotData
 *   for each frame. If not provided, updatePlot must be called externally.
 */
export function startAnimation(currentDataCallback?: () => PlotData): void {
  if (plotState.running) {
    return;
  }
  plotState.running = true;
  plotState.lastTime = performance.now();

  const animationStep = (timestamp: number) => {
    plotState.lastTime = timestamp;

    // Get data either from callback or default zeros
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

    // Continue the loop
    plotState.rafId = requestAnimationFrame(animationStep);
  };

  plotState.rafId = requestAnimationFrame(animationStep);
}

/**
 * Stops the plot animation loop.
 */
export function stopAnimation(): void {
  plotState.running = false;
  if (plotState.rafId !== null) {
    cancelAnimationFrame(plotState.rafId);
    plotState.rafId = null;
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Redraws the entire plot canvas with current state.
 *
 * This is the core rendering function that draws:
 * - Background
 * - Grid lines
 * - Axes
 * - Trace lines (truth, estimate, KF with fade-out based on age)
 * - Measurements as small dots
 * - Covariance ellipse (2σ, semi-transparent neon cyan)
 * - Legend (if enabled)
 */
function redrawPlot(): void {
  const canvas = document.getElementById('plot-canvas') as HTMLCanvasElement;
  if (!canvas) {
    console.warn('redrawPlot: no canvas associated with plot state');
    return;
  }

  const ctx = canvas.getContext('2d')!;
  const graphRect = plotState.graphRect;

  // Clear entire canvas with black
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Draw grid lines
  if (plotState.showGrid) {
    drawGrid(ctx, graphRect);
  }

  // Draw axes
  drawAxes(ctx, graphRect);

  // Draw traces (truth, estimate, KF) with fade-out effect based on age
  drawTraces(ctx, graphRect);

  // Draw measurements as small dots
  drawMeasurements(ctx, graphRect);

  // Draw covariance ellipse (2σ)
  if (plotState.covarianceEllipse) {
    drawCovarianceEllipse(ctx, graphRect, plotState.covarianceEllipse);
  }

  // Draw legend
  if (plotState.showLegend) {
    drawLegend(ctx, graphRect);
  }
}

/**
 * Maps a data x coordinate to a pixel x position within the graph area.
 * @param xData Data x coordinate
 * @param dataMin Minimum data value for x-axis
 * @param dataMax Maximum data value for x-axis
 * @param graphRect Graph area rectangle
 * @returns Pixel x coordinate
 */
function dataXToPixel(
  xData: number,
  dataMin: number,
  dataMax: number,
  graphRect: { x: number; y: number; width: number; height: number }
): number {
  const padding = 0.1; // 10% padding within graph area
  // Map data x to pixel x within graph area, then add margin
  const pixelX =
    ((xData - dataMin) / (dataMax - dataMin)) *
      (graphRect.width * (1 - 2 * padding)) +
    graphRect.x +
    graphRect.width * padding;
  // Clamp to graph area
  return Math.max(graphRect.x, Math.min(graphRect.x + graphRect.width, pixelX));
}

/**
 * Maps a data y coordinate to a pixel y position within the graph area.
 * Y-axis is inverted: higher data value = higher on screen (top).
 * @param yData Data y coordinate
 * @param dataMin Minimum data value for y-axis
 * @param dataMax Maximum data value for y-axis
 * @param graphRect Graph area rectangle
 * @returns Pixel y coordinate
 */
function dataYToPixel(
  yData: number,
  dataMin: number,
  dataMax: number,
  graphRect: { x: number; y: number; width: number; height: number }
): number {
  const padding = 0.1;
  // Invert y-axis: higher data value = higher on screen
  const pixelY =
    -((yData - dataMin) / (dataMax - dataMin)) * graphRect.height +
    graphRect.y +
    graphRect.height * (1 - padding);
  // Clamp to graph area
  return Math.max(graphRect.y, Math.min(graphRect.y + graphRect.height, pixelY));
}

/**
 * Draws grid lines within the graph area.
 */
function drawGrid(ctx: CanvasRenderingContext2D, graphRect: { x: number; y: number; width: number; height: number }): void {
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;

  const { x, y, width, height } = graphRect;

  // Calculate step size based on graph dimensions
  const stepX = Math.max(20, width / 8);
  const stepY = Math.max(20, height / 8);

  // Vertical grid lines
  for (let gx = x; gx <= x + width; gx += stepX) {
    ctx.beginPath();
    ctx.moveTo(gx, y);
    ctx.lineTo(gx, y + height);
    ctx.stroke();
  }

  // Horizontal grid lines
  for (let gy = y; gy <= y + height; gy += stepY) {
    ctx.beginPath();
    ctx.moveTo(x, gy);
    ctx.lineTo(x + width, gy);
    ctx.stroke();
  }
}

/**
 * Draws X and Y axes with labels at the ends.
 */
function drawAxes(ctx: CanvasRenderingContext2D, graphRect: { x: number; y: number; width: number; height: number }): void {
  ctx.strokeStyle = COLORS.axis;
  ctx.lineWidth = 1;

  const { x, y, width, height } = graphRect;

  // X-axis (horizontal line)
  ctx.beginPath();
  ctx.moveTo(x, y + height);
  ctx.lineTo(x + width, y + height);
  ctx.stroke();

  // Y-axis (vertical line)
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x, y + height);
  ctx.stroke();

  // Draw axis labels
  ctx.fillStyle = COLORS.legendText;
  ctx.font = '11px monospace';
  ctx.textBaseline = 'middle';

  // X-axis label at right end
  ctx.fillText('x', x + width - 4, y + height + 4);

  // Y-axis label at top (drawn horizontally for simplicity)
  ctx.save();
  ctx.translate(x + 5, y + 12);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('y', 0, 0);
  ctx.restore();
}

/**
 * Draws trace lines (truth, estimate, KF) with fade-out effect.
 * The fade is achieved by drawing each entry with alpha based on its age.
 * Entries are grouped by type and drawn with their respective colors.
 */
function drawTraces(ctx: CanvasRenderingContext2D, graphRect: { x: number; y: number; width: number; height: number }): void {
  // Group trace entries by type
  const truthEntries: TraceEntry[] = [];
  const estimateEntries: TraceEntry[] = [];
  const kfEntries: TraceEntry[] = [];
  const measurementEntries: TraceEntry[] = [];

  for (const entry of plotState.traceHistory) {
    switch (entry.type) {
      case 'truth':
        truthEntries.push(entry);
        break;
      case 'estimate':
        estimateEntries.push(entry);
        break;
      case 'kf':
        kfEntries.push(entry);
        break;
      case 'measurement':
        measurementEntries.push(entry);
        break;
    }
  }

  // Helper: draw a trace from a list of entries
  const drawTrace = (
    entries: TraceEntry[],
    color: string
  ): void => {
    if (entries.length === 0) {
      return;
    }

    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();

    let first = true;
    for (const entry of entries) {
      const px = dataXToPixel(entry.x, plotState.dataRangeX[0], plotState.dataRangeX[1], graphRect);
      const py = dataYToPixel(entry.y, plotState.dataRangeY[0], plotState.dataRangeY[1], graphRect);

      if (first) {
        ctx.moveTo(px, py);
        first = false;
      } else {
        ctx.lineTo(px, py);
      }
    }

    ctx.stroke();
  };

  // Draw truth trace
  drawTrace(truthEntries, COLORS.truth);

  // Draw EKF estimate trace
  drawTrace(estimateEntries, COLORS.ekf);

  // Draw KF trace
  drawTrace(kfEntries, COLORS.kf);
}

/**
 * Draws measurements as small dots within the graph area.
 */
function drawMeasurements(ctx: CanvasRenderingContext2D, graphRect: { x: number; y: number; width: number; height: number }): void {
  // Find measurement entries in trace history
  const measurementEntries: TraceEntry[] = [];
  for (const entry of plotState.traceHistory) {
    if (entry.type === 'measurement') {
      measurementEntries.push(entry);
    }
  }

  ctx.fillStyle = COLORS.measurement;

  for (const entry of measurementEntries) {
    const px = dataXToPixel(entry.x, plotState.dataRangeX[0], plotState.dataRangeX[1], graphRect);
    const py = dataYToPixel(entry.y, plotState.dataRangeY[0], plotState.dataRangeY[1], graphRect);

    // Draw small dot (3px diameter, radius 1.5)
    ctx.beginPath();
    const radius = 1.5;
    ctx.arc(px, py, radius, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * Draws a 2σ covariance ellipse (semi-transparent neon cyan).
 */
function drawCovarianceEllipse(
  ctx: CanvasRenderingContext2D,
  graphRect: { x: number; y: number; width: number; height: number },
  ellipseParams: [number, number, number]
): void {
  const [cx, cy, r] = ellipseParams;

  // Map center data coordinates to pixel positions
  const px = dataXToPixel(cx, plotState.dataRangeX[0], plotState.dataRangeX[1], graphRect);
  const py = dataYToPixel(cy, plotState.dataRangeY[0], plotState.dataRangeY[1], graphRect);

  ctx.fillStyle = COLORS.ellipseFill;
  ctx.strokeStyle = COLORS.ellipseStroke;
  ctx.lineWidth = 1;

  // Draw ellipse using arc approximation
  const segments = 32;
  ctx.beginPath();
  for (let i = 0; i <= segments; i++) {
    const theta = (i / segments) * Math.PI * 2;
    const dx = r * Math.cos(theta);
    const dy = r * Math.sin(theta);
    const x = px + dx;
    const y = py + dy;
    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

/**
 * Draws a legend in the top-right corner of the graph area.
 */
function drawLegend(ctx: CanvasRenderingContext2D, graphRect: { x: number; y: number; width: number; height: number }): void {
  const { x, y, width, height } = graphRect;

  ctx.fillStyle = COLORS.legendText;
  ctx.font = '11px monospace';
  ctx.textBaseline = 'top';

  // Legend entries
  const entries = [
    { color: COLORS.truth, label: 'Truth' },
    { color: COLORS.ekf, label: 'EKF Est.' },
    { color: COLORS.kf, label: 'Linear KF' },
    { color: COLORS.ellipseFill, label: '2σ Cov.' },
  ];

  let startY = y + 5;
  for (const entry of entries) {
    // Draw color swatch
    ctx.fillStyle = entry.color;
    ctx.fillRect(x + width - 150, startY, 12, 12);
    // Draw label text
    ctx.fillStyle = COLORS.legendText;
    ctx.fillText(entry.label, x + width - 138, startY + 2);
    startY += 18;
  }
}