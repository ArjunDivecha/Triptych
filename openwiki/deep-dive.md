---
type: Reference
title: Triptych Deep-Dive
description: The core analytical workflow for one factor and one market — signal charts, cumulative returns, bucket statistics, horizon matrix, exports, and refresh UX.
tags: [deep-dive, frontend, analytics, bucketing, exports]
openwiki:
  roles: [domain, workflow]
  change_kinds: [ui, analytics, exports]
  source_paths: [app/assets/triptych.js, app/assets/core.js]
  symbols: [hydrateFromStorage, persistState, applyHydrated, setupCombobox]
  test_paths: [tests/core.spec.js, tests/smoke.spec.js]
  invariants: [Shared math lives in core.js; PIT bucketing needs 36-month warm-up; nearest-date tolerance is 15 days; state is URL-only.]
  validation_commands: ["npx playwright test core.spec.js smoke.spec.js"]
---

# Triptych Deep-Dive

The Deep-Dive tab is the core analytical workflow in Triptych. It answers: for one factor and one market, what does the signal look like over time, how do forward returns behave by bucket, and how consistent is the relationship across horizons?

## Main jobs

`app/assets/triptych.js` drives the following views:
- the factor signal chart
- the cumulative return chart
- the bucket-average forward return chart
- the cross-market current-bucket snapshot
- the bucket statistics table
- the bucket × horizon matrix
- XLSX and PDF exports

## Core controls

The tab supports these user choices:
- factor variable
- country / market
- signal normalization
- cumulative return mode
- forward horizon
- bucket threshold mode
- bucket count
- history window

These controls are documented in `app/README.md` and implemented against the shared helpers in `app/assets/core.js`.

## Analytical modes

### Signal normalization

Triptych supports three signal modes:
- **Raw** values
- **Z-score vs own history** using an expanding calculation
- **Cross-sectional** z-score against peer countries at the same date

The expanding and cross-sectional logic lives in the shared core so the Visualizer uses the same math.

### Bucket threshold modes

Two threshold modes are available:
- **Full-sample**: descriptive thresholds built from the full sample; this mode has look-ahead
- **Point-in-time**: expanding thresholds with a 36-month warm-up; this is the more honest backtest mode

This distinction is important and should be preserved in future UI changes. The documentation explicitly calls out the look-ahead tradeoff.

### Forward return logic

Forward returns are derived from the return index sheet using nearest-date matching with a tolerance window. Relative return mode subtracts the equal-weighted all-country average at the same date.

## Tables and metrics

The Deep-Dive tables summarize bucket behavior using:
- observations
- average and median forward return
- hit rate
- best / worst forward return
- overlap-adjusted t-statistics
- Spearman IC and IC t-statistics
- top-minus-bottom spread

The horizon matrix recomputes the same idea across multiple horizons so the user can see where the signal is strongest.

## Bottom-panel slope and R²

Recent work added a linear best-fit overlay to the bottom bucket-return chart and surfaces the slope and R² in the panel title.

That feature is useful because it makes monotonicity readable at a glance: the bucket chart is no longer just a sequence of bars; it now also communicates whether the bucket curve trends smoothly upward or downward.

The linear fit logic lives in `app/assets/core.js` alongside the other shared math helpers.

## Exports

The tab exports:
- tables to XLSX
- charts to PDF

The README and technical docs describe the output sheets and page structure; if you change export contents or filenames, update those docs together.

## Refresh and data-vintage UX

The Deep-Dive tab also manages the refresh banner and data-vintage chip.
It polls the local server while refreshes run and reloads when the dataset updates.

## What to inspect before making changes

- `app/assets/triptych.js`
- `app/assets/core.js`
- `app/README.md`
- `app/docs/PROGRAM.md`
- `app/scripts/serve_triptych.py`
- `tests/core.spec.js`
- `tests/smoke.spec.js`

## Change hazards

- Do not duplicate bucket, IC, or z-score logic in this file if the same logic belongs in `core.js`.
- Keep the point-in-time vs full-sample distinction visible to users.
- Preserve the nearest-date tolerance behavior; other parts of the app assume month-start and month-end grids both work.
- If export contents change, update the docs and tests together.
