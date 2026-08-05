---
type: Reference
title: Architecture
description: Triptych's three-layer local-first architecture — Python data preparation, shared window.T2Core runtime logic, and two browser tabs on one columnar v2 dataset.
tags: [architecture, frontend, data-model, core]
openwiki:
  roles: [architecture, domain]
  change_kinds: [core, data-model, lifecycle]
  source_paths: [app/assets/core.js, app/assets/triptych.js, app/assets/app.js, app/triptych.html, app/scripts/serve_triptych.py, app/scripts/extract_t2_master.py]
  symbols: [window.T2Core, __t2DataPromise, normalizeToken, linearFit, spearmanIC, PIT_MIN_OBS]
  test_paths: [tests/core.spec.js]
  invariants: [Dataset must be format:2 or core.js throws; core.js loads before tab scripts; indexes built once and shared; no CDN dependencies.]
  validation_commands: ["npx playwright test core.spec.js"]
---

# Architecture

Triptych is a single-repository, local-first web app with three main layers:

1. **Data preparation** in Python
2. **Shared runtime logic** in `window.T2Core`
3. **Two browser tabs** that render different workflows on top of the same dataset

## Runtime shape

- `app/scripts/extract_t2_master.py` converts the Excel workbook into a compact columnar JSON dataset.
- `app/scripts/serve_triptych.py` serves the `app/` directory and exposes `/api/status` and `/api/refresh`.
- `app/assets/core.js` loads the dataset, validates its format, builds shared indexes, and exports the math used by both tabs.
- `app/assets/triptych.js` powers the Deep-Dive tab.
- `app/assets/app.js` powers the Factor Visualizer tab.
- `app/triptych.html` is the shared shell that includes both tab UIs.

This architecture is intentionally lightweight: no separate backend framework, no build step, and no CDN dependency for the frontend libraries.

## Shared core logic

`app/assets/core.js` is the canonical home for logic shared by both tabs.

It owns:
- constants such as range values, horizon options, guardrails, and PIT warm-up
- token normalization so the tabs resolve names the same way
- dataset fetch and `format: 2` validation
- index building for per-series caches and cross-country slices
- signal transforms such as expanding z-scores and cross-sectional z-scores
- bucket assignment and statistics helpers
- date and range utilities

This file exists because the current app previously duplicated math and helper logic across `triptych.js` and `app.js`. The shared core removes drift and keeps the two experiences consistent.

### Why this matters

- The browser fetches the dataset once and reuses it.
- Shared indexes are built once and reused by both tabs.
- Any change to bucketing, normalization, or statistics should happen here first.

## Frontend tabs

### Triptych Deep-Dive

`app/assets/triptych.js` is the main analysis workflow for a single factor and market.
It renders:
- a factor signal chart
- a cumulative return chart
- a bucket-average forward return chart
- a cross-market snapshot
- bucket statistics and bucket × horizon tables
- XLSX and PDF exports

It also handles:
- refresh polling against the local API
- data-vintage status display
- point-in-time vs full-sample bucket thresholds
- the bottom-panel regression overlay that reports slope and R²

### Factor Visualizer

`app/assets/app.js` is the multi-series charting workbench.
It supports:
- searchable factor and country selection
- command-style query input
- raw / indexed / z-score axis modes
- series visibility management
- undo for recent selection changes
- shareable URL state

The visualizer reuses the same index and math layer as the Deep-Dive tab so both views interpret the dataset identically.

## Data model

The frontend expects the generated JSON dataset to have `format: 2` and a columnar shape. That contract is enforced in `core.js` and produced by `extract_t2_master.py`.

Representative shape:

```json
{
  "format": 2,
  "generated_at": "...",
  "source_file": "...",
  "source_mtime": "...",
  "sheets": {
    "Trailing PE": {
      "countries": ["India", "..."],
      "dates": ["2000-02-01", "..."],
      "values": { "India": [21.3, null, "..."] }
    }
  }
}
```

## Server and refresh behavior

`app/scripts/serve_triptych.py` is a stdlib-only HTTP server used for local runs.

It does three important things:
- serves static files from `app/`
- returns refresh/status metadata at `/api/status`
- refreshes the dataset through `/api/refresh`

Refreshes are single-flight and atomic:
- the old dataset is backed up to `app/data/backups/` as gzipped JSON
- the workbook is re-extracted
- the new JSON replaces the old file atomically

The server also gzip-compresses static assets when the browser accepts gzip.

### Cloud (Vercel) deployment

The same `app/` directory can be deployed as a static site on Vercel. `vercel.json` rewrites `/api/status` and `/api/refresh` to committed JSON stubs in `app/api/` that return `cloud_mode: true` and explain that refresh is unavailable. The frontend hides the Refresh Data button when `cloud_mode` is set. Data updates require local re-extraction and redeployment. See [Operations](operations.md) for details.

## macOS launch bundle

The repository documents a clickable macOS app bundle (`Triptych.app/`) at the repo root as the preferred launch path for local use, with the server started automatically if needed. The bundle itself is gitignored and not committed — it is regenerated locally via `app/scripts/gen_icon.py` (PIL → sips → iconutil) plus the committed launcher files.

The launch bundle depends on the same Python server and extraction script described above; it is an operating wrapper, not a separate application architecture.

## Important design constraints

- **Offline-first:** no CDN dependencies for charts, export libraries, or dataset loading
- **Shared math:** the browser should not contain divergent copies of the same analytics logic
- **Fail loudly:** unsupported dataset formats and refresh failures should surface clearly
- **URL state over hidden state:** views are meant to be shareable and reproducible

## Source files to inspect when changing architecture

- `app/assets/core.js`
- `app/assets/triptych.js`
- `app/assets/app.js`
- `app/scripts/serve_triptych.py`
- `app/scripts/extract_t2_master.py`
- `app/triptych.html`
- `vercel.json`
- `app/api/status.json`
- `app/api/refresh.json`
- `README.md`
- `app/README.md`
- `app/docs/PROGRAM.md`
