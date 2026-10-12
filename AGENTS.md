# AGENTS.md — Project IRIS

Context for any agent operating in this repository.

## Project purpose

Build an interactive Extended Kalman Filter (EKF) simulator for an aerospace
engineering exam (ITI → university). Single-tab web app, browser-based.

## Repository layout

```
/.                    # VCS + OpenCode workspace config
/rag/*.md             # Retrieval-Augmented Generation knowledge base
/docs/*.md            # Explainer & design docs (high-school friendly)
/project/             # Source code (Node + TypeScript + Vite)
/public/              # Static assets / built site
/.opencode/           # Optional OpenCode-specific config
```

## Conventions

- All prose docs: **English**.
- Source code: **English identifiers**, `main` branch.
- Commit style: imperative mood ("Add EKF derivation", not "Adds...").
- Markdown: GitHub-flavored, ATX headings (`#`), no tab indentation.

## Knowledge base (RAG) files

1. `/rag/context.md`          — engineer-level EKF derivations
2. `/rag/qa.md`               — high-level exam Q&A
3. `/rag/architecture.md`     — module reference

## Explainer files

1. `/docs/explainer-ekf.md`   — high-school-friendly EKF walkthrough
2. `/docs/data-format.md`     — CSV I/O spec for the simulator tab
3. `/docs/kf-explained.md`    — KF levels 0–2 (intuition to scalar math)
4. `/docs/ekf-explained.md`   — EKF levels 0–2 (Jacobian to scalar example)
5. `/docs/kf-vs-ekf.md`       — side-by-side + exam answer

## Getting started (once project scaffolded)

```bash
npm install
npm run dev      # Vite dev server
npm run build    # production bundle
```

## Related skills

- `opencode`    — workspace & configuration
- `report`      — issue reporting