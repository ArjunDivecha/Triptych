# Triptych

**Triptych** is a local-first factor-timing dashboard for cross-country equity analysis. It turns the multi-sheet `T2 Master.xlsx` workbook (58 factor sheets × 34 markets × monthly since 2000) into an interactive web app, packaged as a clickable macOS application with automatic data refresh.

## What it does

Two views in one app:

1. **Triptych Deep-Dive** — the core workflow. For one factor and one market:
   - **Top panel**: the factor signal (raw, expanding z-score vs own history, or cross-sectional z vs peers)
   - **Middle panel**: cumulative return (absolute, or relative to the all-country average), rebased at the start of the selected window; x-axis aligned with the top panel, with a synchronized crosshair
   - **Bottom panel**: average N-month forward return by signal bucket (deciles/quintiles/terciles), current bucket highlighted
   - **Cross-Market Snapshot**: every market's *current* bucket for the selected factor vs its own history
   - **Bucket statistics table**: observations, average/median forward return, hit rate, best/worst, overlap-adjusted t-stats, top-minus-bottom spread
   - **Bucket × Horizon matrix**: average forward return heatmap across 1/3/6/12/24/36-month horizons, with the Spearman IC per horizon
   - **Headline stat cards**: latest signal, current bucket, bucket average forward return, hit rate, IC
   - **Exports**: tables → xlsx, charts → PDF

2. **Factor Visualizer** — a multi-series charting workbench: any combination of sheets and markets, five axis modes, command-style queries ("India Trailing PE"), per-series visibility manager, undo, shareable URLs.

### Methodology notes
- Bucket thresholds come in two modes: **Full-sample** (descriptive; uses the entire history, so it has look-ahead) and **Point-in-time** (expanding thresholds with a 36-month warm-up; an honest backtest).
- t-stats and the IC t-stat use an effective sample size of n / horizon to adjust for overlapping forward returns.
- Forward returns use nearest-date matching (±15 days) so month-start vs month-end grids both work.

## Repository layout

```text
.
├── README.md                      # This file
├── Triptych.app/                  # macOS launcher bundle (gitignored; rebuild with gen_icon.py + the files below)
└── app/
    ├── triptych.html              # App shell (both tabs)
    ├── index.html                 # Redirect to triptych.html
    ├── README.md                  # App-level usage documentation
    ├── docs/PROGRAM.md            # Technical architecture reference
    ├── assets/
    │   ├── triptych.js            # Deep-Dive tab logic (analytics, charts, refresh, exports)
    │   ├── app.js                 # Visualizer tab logic
    │   ├── triptych.css           # Light-mode stylesheet (both tabs)
    │   ├── styles.css             # (legacy, unused by triptych.html)
    │   ├── favicon.svg            # Browser tab icon
    │   ├── icon-1024.png          # Master app icon image
    │   └── vendor/                # Chart.js, SheetJS, jsPDF (offline, no CDN)
    ├── scripts/
    │   ├── extract_t2_master.py   # Excel → columnar JSON (format v2)
    │   ├── serve_triptych.py      # Local server + /api/status + /api/refresh
    │   └── gen_icon.py            # Regenerates the .icns app icon
    └── data/
        ├── t2_master.json         # Generated dataset (compact columnar JSON)
        └── backups/               # Timestamped gzipped backups (auto, keeps 10)
```

## How to launch

**Double-click `Triptych.app`** (at the repo root). It:
1. Starts the local server (`serve_triptych.py --port 8123 --auto-refresh`) if not already running
2. If the source workbook is newer than the dataset, re-extracts it in the background (the UI shows "Refreshing dataset…" and reloads when done)
3. Opens the UI in a chromeless Google Chrome app window

Server logs go to `~/Library/Logs/Triptych.log`.

### Manual launch (terminal)

```bash
cd "/Users/arjundivecha/Dropbox/AAA Backup/A Working/Triptych/app/scripts"
python3 serve_triptych.py --auto-refresh
# open http://127.0.0.1:8123/triptych.html
```

## Data pipeline

- **Source workbook**: `/Users/arjundivecha/Dropbox/AAA Backup/A Complete/T2 Factor Timing Fuzzy/T2 Master.xlsx`
  (row 1 = country headers, column A = dates, one sheet per factor)
- **Extractor**: `app/scripts/extract_t2_master.py` → `app/data/t2_master.json` (columnar format v2, ~6 MB; ~1.6 s)
- **Refresh paths** (all run the same extract):
  1. Auto on launch — `--auto-refresh` compares the workbook mtime to the dataset's recorded `source_mtime`
  2. The **Refresh Data** button in the UI header (POST `/api/refresh`)
  3. Manually: `python3 app/scripts/extract_t2_master.py`
- Every refresh first writes a gzipped, timestamped backup of the previous JSON to `app/data/backups/` (10 most recent kept) and replaces the dataset atomically.
- The header chip shows the data vintage ("Data through … · extracted …") and warns when the source workbook is newer.

## Requirements

- macOS with Google Chrome (falls back to the default browser with a notice)
- python3 with `openpyxl` (the launcher checks homebrew, /usr/local, and system python and fails loudly if none has it)
- No other dependencies; all JS libraries are vendored locally and the app works offline

## Related repositories

- **Asado** (`/Users/arjundivecha/Dropbox/AAA Backup/A Working/Asado`) — the data platform whose monthly/daily pipelines update T2 workbooks. Its refresh architecture (status endpoint, timestamped backups, stdlib HTTP server) is the model for Triptych's updater.
