# Project IRIS — Agent Development Prompt

## Project Overview
Build a **browser-based Extended Kalman Filter (EKF) simulator** for an aerospace engineering exam (ITI → university). Single-tab web app.

**Core capability**: Users upload/generate noisy trajectory data (LEO orbit or attitude), run a nonlinear EKF in the browser, and visualize truth, estimate, measurements, and covariance ellipses in real-time. A linear KF baseline is shown for comparison.

---

## Current Repository State

### Completed
- All 6 `/docs/` files and 3 `/rag/` files written and committed
- Project config: `.gitattributes`, `.gitignore`, `AGENTS.md`, `README.md` present
- Remote: `https://github.com/SilenceOf-TheLans/project-iris.git` (`main`)

### Missing — Implement
- No source code in `/project/` or `/public/` — empty directories
- No `package.json`, no Vite/TypeScript setup, no EKF implementation
- No UI components, no plotting, no data I/O

---

## Project Structure
Create TypeScript + Vite project in `/project/`:

```
project/
├─ index.html           # Single-tab entry point
├─ vite.config.ts
├─ tsconfig.json
├─ package.json
└─ src/
   ├─ main.ts           # App entry — wires UI <-> data <-> EKF
   ├─ data/
   │   ├─ io.ts         # CSV file reader + noise simulator
   │   └─ truth.ts      # Optional synthetic orbit generator (LEO pass)
   ├─ filter/
   │   ├─ ekf.ts        # Generic EKF core (predict/update)
   │   ├─ jacobian.ts   # Numerical Jacobian fallback (central differencing)
   │   └─ metrics.ts    # NIS, NEES diagnostics
   ├─ model/
   │   ├─ range-bearing.ts   # Workcase A — LEO orbit scenario
   │   └─ attitude.ts        # Workcase B — spacecraft attitude
   ├─ ui/
   │   ├─ controls.ts  # Slider + file-input handlers
   │   ├─ plot.ts      # Canvas 2-D plotter (oscilloscope-style)
   │   └─ overlay.ts   # Covariance ellipse renderer
   └─ types/
       └─ index.ts     # Shared TypeScript interfaces
```

---

## Knowledge Base Reference (RAG — Read These)

| File | Key Extractables |
|------|------------------|
| `rag/context.md` | EKF algorithm (predict/update with Jacobians F, H); Workcase A state `[r_x,r_y,r_z,v_x,v_y,v_z]`; Workcase B state `[s^T, ω^T]^T` (MRP + angular rate); Process noise Q; Measurement model h (range & range-rate); Jacobian H (2×6 for range-bearing); NIS/NEES checks; Typical noise levels |
| `rag/qa.md` | 10 exam-style Q&A on KF/EKF theory; Answers verbatim-able; Tuning advice; Particle filter vs EKF trade-offs |
| `rag/architecture.md` | Module map (src/ layout); EKF class API; **UI/UX Aesthetic spec** (AMOLED black background, geometric layout, left-side tabs, oscilloscope-style central graph, neon cyan accents) |
| `docs/data-format.md` | CSV format Mode 1: `t,px,py,pz,vx,vy,vz,q0,q1,q2,q3`; Mode 2: `t,px,py,vx,vy`; Optional measurement columns; Units: SI; Decimal separator: `.` |
| `docs/explainer-ekf.md` | High-school-friendly EKF walkthrough (good for UI tooltips/help) |
| `docs/kf-vs-ekf.md` | Side-by-side KF vs EKF comparison; Exam answer verbatim about Jacobians; Tuning paragraph |
| `docs/kf-explained.md` | KF levels 0–2 (intuition → scalar math); Scalar Kalman gain formula: K = P_pred / (P_pred + R) |
| `docs/ekf-explained.md` | EKF levels 0–2 (Jacobian to scalar example); Worked example with F, H matrices; Note: K > 1 is fine when H scales units differently |

---

## Development Setup

### Prerequisites
- Node.js installed (v20+ recommended)
- Git configured (remote already set up)

### Initialize Project
```bash
# 1. Install dependencies
npm install

# 2. Start development server
npm run dev   # Vite dev server (typically http://localhost:5000)

# 3. Build for production
npm run build # Vite build → /dist
```

### If npm is blocked
- Create `package.json` manually with Vite dependencies
- Or use `corepack enable` + `corepack npm install`

### Required Packages (`package.json`)
```json
{
  "dependencies": { "vite": "^5.0.0", "typescript": "^5.3.0" },
  "devDependencies": { "vite": "^5.0.0", "typescript": "^5.3.0" }
}
```

**No third-party chart libraries** (keep it lightweight/offline-friendly). Use Canvas-based rendering.

---

## Code Conventions

### Identifiers
- English only
- `main` branch
- Imperative commit mood: "Add EKF predict step" not "Adds EKF"

### Markdown (if adding docs)
- ATX headings (`# Heading`, not `## Heading`)
- No tab indentation
- GitHub-flavored

### TypeScript
- Interfaces for all major objects (EKF_Options, StateVector, Measurement, etc.)
- Matrix types — simple 2D number arrays `number[][]` or minimal Matrix class
- Browser-compatible (no Node-specific APIs in source)

---

## Implementation Details

### 1. EKF Core (`src/filter/ekf.ts`)
Implement generic EKF class per `rag/architecture.md` API:

```ts
interface EKF_Options<T extends StateVector> {
  f: (x: Matrix) => Matrix;     // process model
  F: (x: Matrix) => Matrix;     // Jacobian of f
  h: (x: Matrix) => Matrix;     // measurement model
  H: (x: Matrix) => Matrix;     // Jacobian of h
  Q: Matrix | ((dt: number) => Matrix);   // process noise (or Q_d(dt) builder)
  R: Matrix | ((x: Matrix) => Matrix);   // measurement noise (or R(x) for state-dependent sensors)
  x0: Matrix;                   // initial state (n×1)
  P0: Matrix;                   // initial covariance (n×n)
}

class EKF<T extends StateVector> {
  predict(dt: number): void;
  update(z: Matrix): void;
  get state(): Matrix;
  get covariance(): Matrix;
}
```

**Predict step**:
- `x̂⁻ = f(x̂₋₁, u=0, w=0)`
- `P⁻ = F · P₋₁ · Fᵀ + Q_d`

**Update step**:
- `y = z - h(x̂⁻)` (innovation/residual)
- `S = H · P⁻ · Hᵀ + R` (innovation covariance)
- `K = P⁻ · Hᵀ · S⁻¹` (Kalman gain)
- `x̂ = x̂⁻ + K · y` (state update)
- `P = (I - K · H) · P⁻` (covariance update)

**Jacobians**: Either provide analytic derivatives (per `rag/context.md` Sec. 3-4) or use numerical central differencing (Step 7 of context.md).

### 2. Workcase A — LEO Orbit (`src/model/range-bearing.ts`)
- **State**: `[r_x, r_y, r_z, v_x, v_y, v_z]^T` (6×1, ECI position/velocity)
- **Process**: Cowell equation (two-body + J2 perturbation), discretize via 4th-order RK4 each Δt
- **Process noise G, Q**: Acceleration uncertainty as continuous-time white-noise-on-acceleration
  - Q_d ≈ `[[σ_a²/3 · Δt³ · I, σ_a²/2 · Δt² · I], [σ_a²/2 · Δt² · I, σ_a² · Δt · I]]`
- **Measurement**: Slant range ρ and range-rate ρ̇ from ground station at known position r_s
  - `h(x) = [‖r − r_s‖,  ((r−r_s)·(v−v_s)) / ‖r−r_s‖]^T ∈ ℝ²`
- **Jacobian H** (2×6): Per `rag/context.md` Sec. 3.4, with ρ_vec = r − r_s, ρ = ‖ρ_vec‖, u = ρ_vec/ρ, v_rel = v − v_s

### 3. Workcase B — Attitude (`src/model/attitude.ts`)
- **State**: `[s^T, ω^T]^T ∈ ℝ⁶` (MRP + angular rate)
- **Process**: MRP kinematics + Euler's rotation equation
  - ṡ = ¼[(1 − sᵀs)I₃ + 2[s]_× + 2ssᵀ]ω
  - ω̇ = J⁻¹(τ − ω × (Jω))
- **Measurement**: Star-tracker provides quaternion → convert to MRP, or direct MRP measurement with noise
  - Simplified: z = s + v, v ~ N(0, R)
- **Jacobian H**: `[[I₃, 0₃×₃]]` (3×6)

### 4. CSV I/O (`src/data/io.ts`)
Parse per `docs/data-format.md`:
- Mode 1 header: `t,px,py,pz,vx,vy,vz,q0,q1,q2,q3`
- Mode 2 header: `t,px,py,vx,vy`
- Auto-generate short synthetic LEO pass when no file loaded

### 5. Plotting (`src/ui/plot.ts`)
- **Canvas-based**, no third-party charts
- Oscilloscope-style graph:
  - Black background (AMOLED)
  - Grid lines in dim gray
  - Truth: green line
  - EKF estimate: cyan line
  - Linear KF: red line
  - Measurements: small dots
  - Covariance ellipses (2σ) semi-transparent
- Update on every `requestAnimationFrame` step
- Left-side tabs control which scenario is displayed

### 6. UI/UX Aesthetic (from `rag/architecture.md`)
- **Background**: `#000000` (pure black for AMOLED)
- **Accent 1**: `#00ffff` (neon cyan) for active elements, lines
- **Accent 2**: `#e0e0e0` (soft white) for labels/text
- **Layout**:
  - Left sidebar: 200px wide, tabs: *Scenario | Settings | Help*
  - Center canvas: ~70% width, occupies most height
  - Right panel: compact, shows live metrics (NIS, NEES, Kalman gain)
- **Geometry**: Rounded rectangles (`border-radius: 8px`), sharp edges on graph container
- **Interactions**:
  - Tab clicks fade panels in/out
  - Hover glow: `box-shadow: 0 0 10px rgba(0, 255, 255, 0.3)`
  - No photographs — geometric shapes, grid patterns only
  - Subtle pulse animations on active elements

### 7. Metrics & Diagnostics (`src/filter/metrics.ts`)
- **NIS** (Normalized Innovation Squared): `ε_k = yᵀ · S⁻¹ · y`, should hover near χ²(2) bounds (±2σ)
- **NEES** (Normalized Estimation Error Squared): `α_k = (x − x̂)ᵀ · P⁻¹ · (x − x̂)`, should hover near χ²(6) bounds
- Display as charts alongside the graph
- Helpful for QA/defense scenario (exam questions 6–8 in qa.md)

---

## Testing & QA

### Expected Behavior
1. Load scenario (A: LEO or B: Attitude)
2. Auto-generate synthetic data OR upload CSV matching data-format.md
3. Set Q (process noise) and R (measurement noise) via sliders
4. Press "Run EKF" — see real-time convergence
5. Toggle "Linear KF baseline" — observe it lags/diverges while EKF tracks
6. Observe NIS/NEES — should stay within χ² bounds if filter is consistent

### Exam-Ready Q&A (from `rag/qa.md`)
Agent/developer should be able to answer these verbatim:
- Q1: What is a Kalman filter? (recursive Bayesian estimator for linear-Gaussian)
- Q2: Why can't standard KF always be used? (assumes linearity; aerospace is nonlinear)
- Q3: What does EKF add? (linearizes f and h via Jacobians F, H each step)
- Q4: Aerospace example? (LEO tracking from ground station, range & range-rate)
- Q5: Why EKF better than least-squares hold? (state evolves; EKF is recursive; tracks covariance)
- Q6: Role of process noise Q? (model imperfection; tuning knob: higher Q → trust measurements more)
- Q7: State noise vs measurement noise? (Q: model error, affected predict step; R: sensor error, affected update)
- Q8: Tuning/validation tools? (NIS chart, NEES chart, tuning curves on Q/R)
- Q9: Replace EKF with particle filter? (slower; no Gaussian assumptions; EKF simpler for mild nonlinearity)
- Q10: How simulator demonstrates filter working? (upload/generate trajectory → run EKF → plot truth/estimate/measurements → toggle linear KF baseline)

### Consistency Checks (from `rag/context.md` Sec. 7)
- Step 1: Set R from datasheet / truth residual statistics
- Step 2: Set Q from process model fidelity (start small, increase if estimate lags truth)
- Step 3: Verify NIS/NEES within χ² bounds (±2σ envelopes)
- Step 4: If estimate diverges, check residual whiteness and P₀ scaling

---

## Quick Reference Commands

```bash
# From project root (C:\Users\matteo.diluca\Desktop\Project IRIS)
cd project
npm init -y              # If package.json doesn't exist
npm install vite typescript   # Core dependencies
npm run dev          # Start dev server
npm run build      # Production build

# Git (already configured)
git add -A
git commit -m "description"
git push origin main
```

---

## Success Criteria

The project is complete when:

1. **Vite + TypeScript project** scaffolds in `/project/` with `npm run dev` working
2. **Two scenarios** work: LEO orbit (Workcase A) and attitude (Workcase B)
3. **CSV upload** per `docs/data-format.md` loads and filters correctly
4. **Synthetic data** auto-generates a short LEO pass when no file loaded
5. **EKF runs** and estimate converges toward truth
6. **Linear KF baseline** shown lagging/diverging (demonstrating need for EKF)
7. **Real-time plot** shows: truth (green), EKF estimate (blue/cyan), KF (red), measurements (dots), covariance ellipses
8. **AMOLED aesthetic**: black background, cyan accents, geometric layout, left-side tabs
9. **NIS/NEES** display and ideally stay within χ² bounds for reasonable Q/R
10. **All 10 Q&A from `rag/qa.md`** can be answered from implementation knowledge

---

## Critical Questions for Improvement

To make this prompt more actionable and robust, consider the following:

1. **Jacobian computation**: Should analytic Jacobians be required for all workcases, or is a well-tested numerical fallback (central differencing) sufficient for the exam context? What tolerance thresholds should govern the switch?

2. **Discretization of process noise**: The Q_d formula assumes continuous-time white-noise-on-acceleration. Should the prompt explicitly require verification of this discretization against the specific Δt used in the simulation, or is the provided closed-form acceptable?

3. **Linear KF baseline implementation**: The linear KF assumes a fixed linearization point. Should the prompt clarify whether the linear KF uses the Jacobian at the initial state (frozen linearization) or re-linearizes at each step (which would make it closer to an EKF)?

4. **Covariance ellipse rendering**: The 2σ ellipse requires a 2×2 innovation covariance matrix per measurement type. For the range-bearing workcase, what coordinate frame should the ellipse be plotted in (ECI, ENU, local horizon), and how should the ground station position be transformed?

5. **Measurement noise model**: The typical noise levels (range 10m, range-rate 0.01 m/s) are given, but should the prompt specify whether R is constant or state-dependent (e.g., range-dependent radar noise), and how this should be reflected in the UI slider architecture?

6. **Synthetic data generator**: Should the LEO pass generator provide ground station position as a parameter, or is a default equatorial station acceptable? What orbit altitude and pass duration should be the baseline?

7. **Initial covariance P₀**: Should the prompt specify a canonical P₀ (e.g., large diagonal values reflecting uncertain initial state), or should this be a user-controllable parameter via the UI?

8. **NIS/NEES χ² bounds**: The prompt mentions ±2σ envelopes. Should the implementation explicitly compute and display the χ² confidence interval bounds (e.g., using the `chi2inv` function or a precomputed lookup table), or is a simple shaded region acceptable?

9. **Type safety for Matrix operations**: The prompt allows `number[][]` for matrices, but matrix multiplication dimensions must be enforced at runtime. Should the types include compile-time dimension checking, or is a minimal runtime assertion suite sufficient?

10. **Exam defense readiness**: Beyond functional correctness, should the prompt require that the code be structured so an examiner can trace the EKF predict/update steps step-by-step through the UI (e.g., single-step button, state display after each step)?

These questions aim to close ambiguity gaps, ensure the implementation is exam-ready, and elevate the prompt from a feature list to a verifiable specification.