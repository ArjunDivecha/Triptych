# Visualization

Repository for **T2 Factor Visualizer**: a local-first web application that turns a multi-sheet Excel workbook into an interactive time-series analysis interface.

The app is built for comparing many variables (factors) across many countries/markets over time, with fast filtering, transformations, and shareable state.

## What This Repository Does
This repo provides an end-to-end workflow:

1. Read a structured Excel workbook (`T2 Master.xlsx` style data).
2. Convert the workbook into a frontend-friendly JSON dataset.
3. Serve a static web UI that supports multi-selection and charting.
4. Persist chart configuration in URL parameters for reproducible views.

In short: it is a lightweight analytics product for cross-country factor visualization.

## Primary Use Case
Use this project when you need to answer questions like:
- How did `Trailing PE` evolve for `India` vs `U.S.`?
- How do several valuation and macro factors co-move through time?
- What changed in the last `1Y`, `3Y`, `5Y`, or full history?
- Which series are comparable only after normalization (`Indexed` or `Z-Score`)?

## Key Features
- Multi-select sheets (variables) and countries.
- Command-style query input such as `India Trailing P/E`.
- Fuzzy suggestions when exact parsing is ambiguous.
- Date windows: `All`, `10Y`, `5Y`, `3Y`, `1Y`.
- Axis modes:
  - `Raw` values.
  - `Indexed` values (rebase to 100).
  - `Z-Score` normalized values.
- Series manager with per-series visibility toggle.
- Undo stack for selection operations.
- Selection/canvas state encoded into URL.
- Render guardrails to avoid freezing browser on huge combinations.

## Repository Layout
```text
.
├── README.md                      # Repository-level guide (this file)
└── app/
    ├── index.html                 # App shell
    ├── README.md                  # App-level usage documentation
    ├── docs/
    │   └── PROGRAM.md             # Technical architecture and behavior
    ├── assets/
    │   ├── app.js                 # Frontend state, parsing, rendering logic
    │   └── styles.css             # UI styling
    ├── scripts/
    │   └── extract_t2_master.py   # Excel -> JSON extractor
    └── data/
        └── t2_master.json         # Generated dataset consumed by frontend
```

## How the System Works
### 1) Data extraction
`app/scripts/extract_t2_master.py` reads Excel in `read_only` mode and exports a JSON object keyed by sheet name.

Each sheet output includes:
- `countries`: list of country/market columns.
- `rows`: date-indexed objects containing numeric values by country.

### 2) Frontend indexing
At app startup (`app/assets/app.js`):
- JSON is loaded and validated.
- in-memory indices are built:
  - all sheets.
  - all countries.
  - sheet -> country availability.
  - precomputed point arrays per `(sheet, country)`.

### 3) State-driven rendering
User actions update a central state model:
- selected sheets.
- selected countries.
- hidden series.
- date range.
- axis mode.

The renderer derives datasets from state and updates Chart.js.

### 4) URL synchronization
Selections are serialized to query parameters (`s`, `c`, `r`, `a`, `h`) so a URL can reconstruct the same view.

## Data Expectations
The extractor and frontend assume this workbook pattern:
- Row 1: headers (`Country`, then country/market names).
- Column A: date values.
- Remaining cells: numeric data points or blanks.

If source format changes significantly, update extractor logic first.

## Quick Start
From repository root:

1. Regenerate JSON from Excel
```bash
python3 app/scripts/extract_t2_master.py \
  --input "/Users/arjundivecha/Dropbox/AAA Backup/A Complete/T2 Factor Timing Fuzzy/T2 Master.xlsx" \
  --output "app/data/t2_master.json"
```

2. Start local server
```bash
cd app
python3 -m http.server 8000
```

3. Open app
- [http://127.0.0.1:8000](http://127.0.0.1:8000)

## Typical Workflow
1. Select one or more sheets (variables).
2. Select one or more countries.
3. Use range buttons for horizon control.
4. Use axis mode to normalize if scales are very different.
5. Hide noisy series in Series Manager.
6. Share URL when view is finalized.

## Guardrails and Practical Limits
To protect browser performance, the UI enforces render limits and warnings:
- warns before very large renders.
- blocks oversized combinations.
- trims URL state when necessary and marks link as partial.

This prevents accidental “too many lines x too many points” crashes.

## Known Limitations
- Static JSON can become large as dataset grows.
- No backend, user auth, or server-side query layer.
- No built-in export module (PNG/CSV) yet.
- Automated test suite is not yet implemented.

## Developer Notes
- Frontend is vanilla JS for minimal dependencies.
- Charting is done with Chart.js via CDN.
- State logic lives in one file (`app/assets/app.js`) and is heavily behavior-driven.
- Data refresh means re-running extractor and reloading browser.

## Recommended Next Enhancements
1. Add tests for parser, URL state round-tripping, and cascade pruning.
2. Add data export features (CSV and chart image).
3. Add downsampling strategy for dense series.
4. Add static deployment profile (Vercel/Cloudflare Pages).

## Documentation Map
- App guide: [app/README.md](/Users/arjundivecha/Dropbox/AAA Backup/A Working/Amit/app/README.md)
- Technical reference: [app/docs/PROGRAM.md](/Users/arjundivecha/Dropbox/AAA Backup/A Working/Amit/app/docs/PROGRAM.md)

