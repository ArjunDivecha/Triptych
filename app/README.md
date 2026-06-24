# Triptych — App Usage

Interactive local web app for exploring the `T2 Master.xlsx` dataset across factors (Excel sheets), countries/markets, and time. Two tabs: **Triptych Deep-Dive** (factor-timing analysis for one market) and **Factor Visualizer** (multi-series charting workbench).

## Quick start

Double-click `Triptych.app` at the repository root, or run manually:

```bash
cd "/Users/arjundivecha/Dropbox/AAA Backup/A Working/Triptych/app/scripts"
python3 serve_triptych.py --auto-refresh
# open http://127.0.0.1:8123/triptych.html
```

The header shows the data vintage ("Data through … · extracted …"). When the source workbook is newer than the dataset, the chip turns amber and the **Refresh Data** button (or the auto-refresh on launch) re-extracts it — the previous JSON is backed up to `data/backups/` first.

## Triptych Deep-Dive tab

Sidebar controls:

| Control | Options | Notes |
|---|---|---|
| Factor Variable | any of the 58 sheets | searchable combobox |
| Country / Market | any market in the sheet | searchable combobox |
| Signal Normalization | Raw, Z-Score vs own history, Cross-Sectional | expanding z has no look-ahead; cross-sectional is z vs peers at each date |
| Cumulative Return | Absolute, Relative | relative = vs equal-weighted all-country average |
| Forward Horizon | 1/3/6/12/24/36 months | drives the bottom panel and tables |
| Bucket Thresholds | Full-sample, Point-in-time | full-sample is descriptive (has look-ahead); point-in-time uses expanding thresholds with a 36-month warm-up |
| Buckets | Deciles (10), Quintiles (5), Terciles (3) | use fewer buckets for short windows |
| History Window | All, 10Y, 5Y, 3Y, 1Y | filters the analysis sample; the cumulative panel rebases at the window start |
| Export | Tables → xlsx, Charts → PDF | xlsx has Bucket Stats + Horizon Matrix + Settings sheets |

What you see:

- **Stat cards**: latest signal value, current bucket, that bucket's average forward return and hit rate, and the Spearman IC (with an overlap-adjusted t-stat).
- **Top panel**: the signal through time. σ units when normalized.
- **Middle panel**: cumulative return, x-axis aligned with the top panel; hover either panel for a synchronized crosshair.
- **Bottom panel**: average forward return per bucket; the current bucket has an orange border.
- **Cross-Market Snapshot**: each market's current bucket for this factor vs its own history (selected market in orange).
- **Bucket Statistics**: per-bucket obs/avg/median/hit rate/best/worst/t-stat, plus the top-minus-bottom spread row. The current bucket's row is highlighted.
- **Bucket × Horizon matrix**: average forward return heatmap with per-horizon IC row — shows at which horizon the signal works.

URL parameters (`tf`, `tc`, `tn`, `tm`, `th`, `tr`, `td`, `tb`) persist the view; share the URL to reproduce it. (State is URL-only; there is no localStorage persistence — share the URL to reproduce a view.)

## Factor Visualizer tab

- Check any sheets and countries (filter boxes + Select Filtered / Clear)
- Command query: type e.g. `India Trailing PE` and press Enter; fuzzy suggestions appear for ambiguous input
- Axis modes: Raw, Indexed (rebased to 100), Z-Score (static over visible window), Z vs Own History (expanding), Cross-Sectional
- Series manager toggles individual series; Undo restores the last 3 selection states
- URL parameters are namespaced `vs`, `vc`, `vr`, `va`, `vh` (no collision with the Deep-Dive tab)
- State is URL-only (no localStorage); share the URL to reproduce a view
- Guardrails warn at >50 series / >100k points and block >80 series / >200k points

## Data pipeline

```bash
# manual re-extract (defaults to the canonical source and output below)
python3 scripts/extract_t2_master.py
```

- Input: `/Users/arjundivecha/Dropbox/AAA Backup/A Complete/T2 Factor Timing Fuzzy/T2 Master.xlsx`
- Output: `data/t2_master.json` — columnar format v2 (`format: 2`, per-sheet `dates[]` + per-country `values[]`), compact, written atomically
- The frontend requires format 2 and fails loudly on anything else

## Server API

- `GET /api/status` — dataset vintage, source workbook mtime, `stale` flag, refresh state
- `POST /api/refresh` — backup + re-extract + atomic replace (409 if already running)
- Static files are gzip-compressed when the browser accepts it (~6 MB JSON → ~2 MB wire)

## Troubleshooting

- **"Refresh status unavailable"** — the app is being served by something other than `serve_triptych.py` (e.g. a plain `python3 -m http.server`). Charts work; refresh does not.
- **Refresh fails** — the error from the extractor is shown verbatim in the banner and recorded in `/api/status`. Check that the source workbook exists and `openpyxl` is installed.
- **App icon does nothing** — check `~/Library/Logs/Triptych.log`.
