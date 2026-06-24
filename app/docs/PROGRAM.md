# Program Documentation

Full technical reference for the Triptych app (Deep-Dive + Factor Visualizer).

## 1. System Architecture

### 1.1 Components
1. Extractor — `app/scripts/extract_t2_master.py` (Excel → columnar JSON v2)
2. Server — `app/scripts/serve_triptych.py` (static files + status/refresh API)
3. Frontend — `app/triptych.html`, `app/assets/triptych.js` (Deep-Dive), `app/assets/app.js` (Visualizer), `app/assets/triptych.css` (light theme)
4. Data — `app/data/t2_master.json` (+ `app/data/backups/`)
5. macOS launcher — `Triptych.app/Contents/MacOS/Triptych` (repo root)
6. Vendored libraries — `app/assets/vendor/` (Chart.js 4.4.1, SheetJS 0.20.3, jsPDF 2.5.2); no CDN, works offline

### 1.2 Runtime flow
1. `Triptych.app` starts `serve_triptych.py --port 8123 --auto-refresh` (if not running) and opens Chrome with `--app=http://127.0.0.1:8123/triptych.html`
2. On startup the server compares the source workbook mtime with the dataset's recorded `source_mtime`; if stale it re-extracts in a background thread
3. The browser loads the dataset once (shared `window.__t2DataPromise` between both tabs), builds indexes, renders
4. The UI polls `/api/status` while a refresh runs and reloads when `dataset_generated_at` changes

## 2. Data Format (v2, columnar)

```json
{
  "format": 2,
  "generated_at": "2026-06-10T18:47:25+00:00",
  "source_file": "/Users/arjundivecha/Dropbox/AAA Backup/A Complete/T2 Factor Timing Fuzzy/T2 Master.xlsx",
  "source_mtime": "2026-06-10T07:38:56+00:00",
  "sheets": {
    "Trailing PE": {
      "countries": ["India", "..."],
      "dates": ["2000-02-01", "..."],
      "values": { "India": [21.3, null, "..."] }
    }
  }
}
```

- Compact (no indentation), written atomically (`.tmp` + `os.replace`)
- ~6 MB vs 21 MB for the old row-oriented v1; the frontend **requires** `format: 2` and throws otherwise (no silent fallback)
- `null` marks missing values; dates are `YYYY-MM-DD` strings

## 3. Server API (`serve_triptych.py`, stdlib only)

| Endpoint | Method | Behavior |
|---|---|---|
| `/...` | GET | static files from `app/`; gzip for json/js/css/html/svg when accepted; `Cache-Control: no-store` on the dataset |
| `/api/status` | GET | `{dataset_generated_at, dataset_source_mtime, source_file, source_exists, source_mtime, stale, refresh_running, last_refresh_result, last_refresh_error, last_refresh_finished}` |
| `/api/refresh` | POST | 202 + background refresh; 409 if one is already running |

Refresh sequence: gzip-backup current JSON to `data/backups/t2_master_<stamp>.json.gz` (keep 10) → `extract_workbook()` → atomic replace. Errors are caught, recorded in `last_refresh_error`, and surfaced in the UI banner — never masked.

## 4. Deep-Dive Analytics (`triptych.js`)

### 4.1 Signal modes
- `raw` — native values
- `history_z` — expanding z-score vs own history (Welford; no look-ahead; 0 during the first observation)
- `cross_var_pct` — z-score vs all *other* countries' values at the same date

### 4.2 Forward returns
- Return source: the `Tot Return Index` sheet (alias/heuristic match)
- Forward return at t over horizon h months: nearest return-index point to t (±15-day tolerance, binary search) vs nearest point to t+h
- Relative mode subtracts the equal-weighted average forward return across all countries with data at t

### 4.3 Bucketing
- `full` (full-sample): thresholds are quantiles of all signals in the sample — descriptive, has look-ahead
- `pit` (point-in-time): for each observation, thresholds use only signals up to and including that date; requires a 36-observation warm-up (`PIT_MIN_OBS`)
- Bucket counts: 10/5/3; the "current bucket" always uses full-history thresholds (which is point-in-time for *today*)

### 4.4 Statistics
- Per bucket: count, mean, median, hit rate, best, worst, t-stat = mean / (sd/√n_eff) with n_eff = n / horizon (overlap adjustment)
- IC: Spearman rank correlation of signal vs forward return over the in-range sample; t = IC·√((n_eff−2)/(1−IC²))
- Spread: top-bucket mean − bottom-bucket mean
- Horizon matrix: the above recomputed for each of 1/3/6/12/24/36 months

### 4.5 Charts
- Top + middle share an x-domain (min and max) and a synchronized crosshair (custom Chart.js plugin registered on both)
- Middle panel rebases at the start of the selected window (absolute: first in-window level; relative: wealth ratios accrued in-window only)
- Snapshot: horizontal bars of each market's current bucket vs its own history; selected market highlighted
- σ tick format for normalized signals; % for returns

## 5. State and Persistence

- Deep-Dive URL params: `tab=triptych`, `tf` (factor), `tc` (country), `tn` (normalization), `tm` (return mode), `th` (horizon), `tr` (range), `td` (bucket mode), `tb` (bucket count); localStorage key `triptych:last`
- Visualizer URL params: `tab=visualizer`, `vs`, `vc`, `vr`, `va`, `vh`, `partial`; localStorage keys `t2viz:*`
- The two namespaces never collide (this fixed a bug where both tabs fought over `c` and `h`)
- Hydration order: defaults → localStorage → URL (URL wins)

## 6. Exports

- **Tables → xlsx** (SheetJS): sheets "Bucket Stats" (incl. spread row), "Horizon Matrix" (incl. spread + IC rows), "Settings" (all control values + data vintage)
- **Charts → PDF** (jsPDF, A4 landscape): page 1 title + top + middle, page 2 bucket bars, page 3 snapshot
- Filenames: `Triptych <country> <factor> <date>.{xlsx,pdf}`

## 7. Visualizer (`app.js`)

Same engine as before with three changes: columnar v2 loader (shared fetch), namespaced URL params, and checkbox lists instead of ctrl-click multi-selects. Guardrails unchanged: warn >50 series or >100k points, block >80 series or >200k points.

## 8. macOS App Bundle

```text
Triptych.app/Contents/
├── Info.plist            # bundle id com.arjundivecha.triptych, LSUIElement
├── MacOS/Triptych        # bash launcher
└── Resources/Triptych.icns
```

Launcher: find a python3 with openpyxl (homebrew → /usr/local → system; loud dialog if none) → start server with `--auto-refresh` if `/api/status` is not answering → `open -na "Google Chrome" --args --app=<url>` (alert + default browser if Chrome missing). Logs: `~/Library/Logs/Triptych.log`. Icon regeneration: `python3 app/scripts/gen_icon.py` (PIL → sips → iconutil).

## 9. Error Handling Policy

FAIL IS FAIL: the frontend throws on non-v2 data; refresh errors surface verbatim in the banner and `/api/status`; the launcher shows critical dialogs instead of degrading silently. The only soft path is Chrome-missing → default browser, and it announces itself with an alert first.

## 10. Operational Procedures

### Update source data
Any of: click **Refresh Data** in the UI; relaunch `Triptych.app` (auto-refresh); or run `python3 app/scripts/extract_t2_master.py`. Previous JSON is always backed up to `app/data/backups/` first.

### Rebuild from scratch
```bash
cd "/Users/arjundivecha/Dropbox/AAA Backup/A Working/Triptych"
python3 app/scripts/extract_t2_master.py
python3 app/scripts/gen_icon.py        # only if the icon/icns is missing
open Triptych.app
```

## 11. Known Limitations
- No automated test suite (manual + Playwright verification)
- PIT bucketing needs 36 months of history, so early-sample observations are excluded in that mode
- The all-country benchmark is equal-weighted over whatever countries have data each month (composition drifts in the early sample)
- Old v1 share links (`s`/`c`/`r`/`a`/`h` params) are not migrated
