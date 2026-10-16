# Project IRIS — Debugging Timeline

Loop-engineered debug log. Tick boxes as fixes land (`- [x]`).
Evidence: `npx tsc --noEmit` = 0, `npm run build` = OK (vite 8.3.4, 24.27kB JS), numeric repro `node -e`.

## Loop 0 — Explore (structure/wiring)

- [x] Map file tree (`src/` 10 files, `css/`, `dist/`, empty `project/`)
- [x] Confirm entry wiring (`index.html:91` `/src/main.ts` → `vite.config.ts` → `dist/`)
- [x] Confirm `truth.ts`/`overlay.ts` folded in (`io.ts:290`, `plot.ts:627`), not missing
- [ ] Decide canonical layout: code at root `src/` vs `prompt.md` `project/src` + stale `AGENTS.md` `/project/` line

## Loop 1 — Blockers (wrong results / crash on valid input)

- [ ] `src/data/io.ts:115,118,179` — Mode 2 expects 6 cols, spec `t,px,py,vx,vy` is 5. Valid 5-col CSV rejected. Fix: `6` → `5`, update `row.length!==5`, parse `row[1..4]`, fix error string + comment `113`.
- [ ] `src/model/range-bearing.ts:216-219` — `measurementJacobianH` row1 `[v*ux/rho...]` drops `-rr*u/rho` + off-diagonals (O(40-100%) error). Fix to `(v-rr*u)/rho` per `src/main.ts:168-172`, or delete file if unifying on `main.ts`.
- [ ] `src/filter/metrics.ts:205` — `normalQuantile` uses `max(p,1-p)`, should be `min`. Verified bug: `0.975→-1.80` (exp `+1.96`), `0.025→+1.80` (exp `-1.96`). Fix: `q = p<0.5 ? p : 1-p`.
- [ ] `src/main.ts:89-97,99-107` — `buildQ6/Q4` uses `dt^4/4,dt^3/2,dt^2` (pulse model) vs spec `dt^3/3,dt^2/2,dt` (Van Loan, cf `range-bearing.ts:242-261`). Verified at `dt=7.5,q=1e-6`: spec pos `1.4e-10` vs main `7.9e-4`. Fix: unify on Van Loan + single sigma convention.
- [ ] `src/main.ts:116 vs 383 vs 299` — `rrStd` triple-defined (`rStd*0.01` build, `value*0.02` slider, `rStd*0.01` inject). Fix: single helper `rrStd(rStd)`.

## Loop 2 — Major (silent divergence / wrong stats / dead code)

- [ ] `src/filter/metrics.ts:178-181` — `CHI2_TABLE` shifted (df2 97.5% `10.597` vs `7.378`; df3/4/5 same pattern). LEO 95% gate `[0.0506,10.597]` vs `[0.0506,7.378]`. Fix from authoritative χ² values.
- [ ] `src/model/range-bearing.ts:48-56` — J2 formula wrong (`r^-4`, `1-3(z/r)^2`, no 3/2, no z-split). Verified: bug `5.89e4 m/s2` vs two-body `8.9`, correct J2 `1.3e-2`. Fix Vallado `r^-5` form or downgrade claim to two-body.
- [ ] Dead-code divergence — `main.ts` never imports `model/*, metrics.ts, jacobian.ts`. App runs on inline copies. Fix: wire model files in or delete; same for `metrics`/`jacobian`.
- [ ] Workcase B mismatch — running `attitude` is 4-state 2D `[px,py,vx,vy]` (`main.ts:189-218`), spec is 6-state MRP+ω (`attitude.ts`). Fix: implement or explicitly descope.
- [ ] `src/model/range-bearing.ts:151,200` — no `rho≈0`/`r≈0` guard (`/rho`, `1/r^3`). `main.ts:34,156` clamps. Fix: add `max(1e-6,…)` guard.
- [ ] `src/model/range-bearing.ts:208-210` — Jacobian assumes `v_s=0` while `measurementH:133` takes `groundStationVel`. Fix: thread `v_s` into H.
- [ ] `src/filter/ekf.ts:229-249` — no ctor dim checks. Fix: assert `x0 n×1`, `P0 n×n`, Q/R compat.
- [ ] `src/filter/jacobian.ts:42,115,153` — `number[]` API vs `Matrix` EKF, dead code. Fix: Matrix adapter + adaptive `h=√eps·max(|x|,1)` or remove fallback claim.
- [ ] `src/main.ts:119-131` — `f/F` ignore `predict(dt)` arg, close over global `currentDt:20,273`. Fix: thread `dt` explicitly.
- [ ] `src/data/io.ts:75` — `MU=3.986e13` 10× wrong (comment confused). Unused (`MU_KM3:82` used). Fix: correct to `3.986e14` or remove.
- [ ] `src/data/io.ts:205-211` — no `isNaN` on `q0..q3`. Fix: validate quaternion.
- [ ] NIS/NEES never computed/displayed (`metrics.ts` unwired) despite success criterion #9. Fix: wire display with per-scenario DoF (LEO NIS df=2, attitude NIS df=2/3, NEES df=n).

## Loop 3 — Config / hygiene

- [ ] Add `.gitignore` (`node_modules/`, `dist/`, `*.local`), `git rm -r --cached` both (804 `node_modules` files + hashed `dist` currently tracked, causing churn `D/AD/?? index-*.js`).
- [ ] `package.json:7` — `build: vite build` runs no `tsc`. Fix: `tsc --noEmit && vite build`, move `vite/typescript` to `devDependencies`, fix `main: index.js`, remove `**` from description, add real `test` or delete placeholder.
- [ ] `tsconfig.json:10` — `declaration:true + outDir:./dist` collides with Vite. Fix: `noEmit:true`. Reconcile `rootDir:./src` + `include:[...,index.html]`.
- [ ] `vite.config.ts:3-11` — suppress ESM-in-CJS warning (`type:module` or `.mts`), canonical `input:{main:...}` object. CSS in root `css/` works (bundles to `dist/assets/*.css`) but fragile — document or move to `src/assets` import.
- [ ] `implementation_summary.txt:7-8,21-22` stale (Q/R ranges, `step` attrs) vs `controls.ts:16-17`. Fix doc.
- [ ] Branch `master` vs `AGENTS.md` `main` convention. Decide rename or doc fix.

## Loop 4 — Minor / robustness

- [ ] `import {Matrix}` → `import type` (`isolatedModules:true`) in `ekf.ts:7`, `metrics.ts:7`, `range-bearing.ts:8`, `attitude.ts:10`. Remove unused `EKF_Options` imports.
- [ ] `types/index.ts:20` phantom `T`, duplicate `Vector`/`Matrix`, unused `StateVector/Measurement/EKFResult`.
- [ ] `jacobian.ts:13` unused `EPSILON`, doc vs fixed `1e-4:64` mismatch.
- [ ] `io.ts:113` comment `10 fields` → `11`; `123-129` unreachable heuristic; `169` empty-row check never true; `311` allows subsurface `r≈1km`; `302` silent `points>5000` clamp — document.
- [ ] `attitude.ts:200,225` lint noise (`x` ignored, `dt` ignored in `buildQ`).
- [ ] `main.ts:54` redundant `rows` param in `mat()`; `320` covariance circle ignores cross-corr; `327` radius clamp `[1,800]km` hides divergence — log instead.
- [ ] `controls.ts:36,89` `any` + `__wired`, `logMessage:136` overwrites `#log` (no history).
- [ ] `plot.ts:29` unused `age`, `92-97` silent detached canvas fallback.
- [ ] `ekf.ts:302`, `metrics.ts:103` — `(I-KH)P` not Joseph; duplicated matrix helpers — note limitation or unify.
- [ ] `main.ts:130-152` `Fd` missing `1/2` in `I+G·dt²` (should be `I+½G·dt²`); `MU_EARTH:29` vs model `MU` cite one value.

## Verification loop (re-run after each fix batch)

- [ ] `npx tsc --noEmit` clean
- [ ] `npm run build` clean, no new `dist` churn in git
- [ ] Mode 2 5-col CSV loads (repro + `test_csv.csv` Mode 1 still loads)
- [ ] `normalQuantile(0.975)≈+1.96`, `chi2Inverse(0.975,2)=7.378`, `getNisBounds(2,0.95)=[0.0506,7.378]`
- [ ] J2 magnitude `~1e-2 m/s2` at LEO, propagation stable
- [ ] H Jacobian matches `(v-rr*u)/rho` + finite-diff check
- [ ] Qd matches Van Loan scaling; slider R move preserves `rrStd` model
- [ ] No dead imports; NIS/NEES displayed with correct DoF
