# Project IRIS — Interactive EKF Simulator

 A browser-based **Extended Kalman Filter (EKF) simulator** built for
aerospace engineering students and exam prep.

## What is it?

A single-tab web app that:

- Lets you **upload or generate** noisy trajectory data (LEO orbit or attitude)
- Runs a nonlinear **Extended Kalman Filter** in your browser
- Plots the **truth, estimate, measurements, and covariance ellipses** in real time
- Compares against a **linear (KF) baseline** to show why nonlinear filtering matters

Designed for an Italian ITI + aerospace-uni exam context.
Once scaffolded: open the Vite dev page or `index.html` from the build.
No installs for the examiner — just a browser.

## Quick start

```bash
# 1. scaffold the project
npm install

# 2. start dev server
npm run dev

# 3. build for production
npm run build
```

## Documentation

| File | Purpose |
|------|---------|
| [`AGENTS.md`](./AGENTS.md) | Context for agent collaborators |
| [`rag/context.md`](./rag/context.md) | Engineer-level EKF derivations |
| [`rag/qa.md`](./rag/qa.md) | Exam-defense Q&A |
| [`rag/architecture.md`](./rag/architecture.md) | Code module reference |
| [`docs/explainer-ekf.md`](./docs/explainer-ekf.md) | High-school-friendly walkthrough |
| [`docs/kf-explained.md`](./docs/kf-explained.md) | KF levels 0–2 |
| [`docs/ekf-explained.md`](./docs/ekf-explained.md) | EKF levels 0–2 |
| [`docs/kf-vs-ekf.md`](./docs/kf-vs-ekf.md) | Side-by-side + exam answer |
| [`docs/data-format.md`](./docs/data-format.md) | CSV file spec |

## License

MIT