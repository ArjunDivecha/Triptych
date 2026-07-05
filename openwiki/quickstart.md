# OpenWiki quickstart

Triptych is a local-first factor-timing dashboard for cross-country equity analysis. It turns a multi-sheet Excel workbook into an interactive web app with two views:

- **Triptych Deep-Dive** for factor timing analysis on one factor and one market
- **Factor Visualizer** for multi-series charting across factors and countries

The app is built to run locally, serve its own data, refresh from the workbook when stale, and work offline with vendored frontend libraries.

## Start here

1. Read the architecture overview: [Architecture](architecture.md)
2. Read how the data is produced and refreshed: [Data pipeline](data-pipeline.md)
3. Read the Deep-Dive workflow: [Triptych Deep-Dive](deep-dive.md)
4. Read the multi-series charting workflow: [Factor Visualizer](visualizer.md)
5. Read ops and test guidance before making changes: [Operations](operations.md) and [Testing](testing.md)

## Repository at a glance

### Product surface
- `app/triptych.html` is the shared app shell for both tabs.
- `app/assets/core.js` is the shared runtime logic loaded by both tabs.
- `app/assets/triptych.js` implements the Deep-Dive analytics and exports.
- `app/assets/app.js` implements the Factor Visualizer.

### Data and backend
- `app/scripts/extract_t2_master.py` converts `T2 Master.xlsx` into `app/data/t2_master.json`.
- `app/scripts/serve_triptych.py` serves static assets and exposes `/api/status` and `/api/refresh`.
- `app/data/backups/` stores timestamped gzipped backups of the previous dataset during refresh.

### Verification
- `tests/core.spec.js` checks the shared math and data model in the browser.
- `tests/smoke.spec.js` smoke-tests both tabs against the live server.
- `playwright.config.js` starts the local server automatically for the Playwright suite.

## Primary source documents

The repository already includes useful docs that OpenWiki synthesizes rather than replaces:

- Root overview: `README.md`
- App usage guide: `app/README.md`
- Full technical reference: `app/docs/PROGRAM.md`

Use OpenWiki for the shortest path into the repository, then jump back to the source docs when you need more detail.

## Important implementation themes

- **Shared core logic:** both tabs depend on `window.T2Core` from `app/assets/core.js` so math and dataset handling stay consistent.
- **Columnar dataset contract:** the frontend expects `format: 2` JSON from `extract_t2_master.py`.
- **Local refresh model:** the server tracks workbook staleness and refreshes the dataset without a separate backend service.
- **URL-driven state:** both tabs encode state in the URL for shareable, reproducible views.
- **Offline-ready frontend:** Chart.js, SheetJS, and jsPDF are vendored under `app/assets/vendor/`.

## Documentation map

- [Architecture](architecture.md)
- [Data pipeline](data-pipeline.md)
- [Triptych Deep-Dive](deep-dive.md)
- [Factor Visualizer](visualizer.md)
- [Operations](operations.md)
- [Testing](testing.md)

## What to read before changing code

- Changing shared math, bucketing, indexing, or dataset loading: read [Architecture](architecture.md) and [Testing](testing.md)
- Changing workbook extraction or refresh behavior: read [Data pipeline](data-pipeline.md) and [Operations](operations.md)
- Changing the Deep-Dive charts, thresholds, exports, or monotonicity analysis: read [Triptych Deep-Dive](deep-dive.md)
- Changing selection logic, axis modes, or shareable URLs: read [Factor Visualizer](visualizer.md)

## Notes for future agents

- Recent work moved shared logic into `app/assets/core.js`; avoid reintroducing tab-specific copies of the same math.
- The slope/R² addition in the bottom bucket panel is part of the Deep-Dive workflow and is computed from the decile curve, not from the raw signal series.
- The data pipeline scripts (`extract_t2_master.py`, `serve_triptych.py`) and the generated dataset are all committed; inspect `git status` before altering the data pipeline to detect any local changes.
