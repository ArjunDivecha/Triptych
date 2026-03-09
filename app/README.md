# Triptych

Interactive local web apps for exploring the `T2 Master.xlsx` dataset across:
- multiple variables (Excel sheets)
- multiple countries/markets
- time

`T2 Factor Visualizer` is optimized for multi-series comparison.

`Triptych` is optimized for a 3-panel workflow:
- top panel: one selected variable (raw or normalized)
- middle panel: cumulative return to selected country (absolute or relative to all-country average)
- bottom panel: `N`-month forward return by decile (all deciles shown)

## Contents
- Overview
- Features
- Triptych Features
- Project Structure
- Quick Start
- Data Pipeline
- How To Use
- URL State Format
- Guardrails and Limits
- Troubleshooting
- Development Notes

## Overview
`T2 Factor Visualizer` converts a multi-sheet Excel workbook into JSON and renders interactive time-series charts in the browser using Chart.js.

Architecture:
1. Python extractor reads workbook and writes `t2_master.json`
2. Static frontend loads JSON and builds in-memory indices
3. UI state drives chart rendering and URL synchronization

## Features
- Multi-select `Sheet` and `Country`
- Command search (example: `India Trailing P/E`)
- Fuzzy suggestion fallback for ambiguous inputs
- Date range presets: `All`, `10Y`, `5Y`, `3Y`, `1Y`
- Axis modes:
  - `Raw` (native values)
  - `Indexed` (rebased to 100)
  - `Z-Score` (standardized)
- Series manager with per-series visibility toggles
- Auto-pruning when sheet/country combinations become invalid
- Undo support (last 3 actions)
- URL state persistence and shareable links
- Render guardrails for large selections

## Triptych Features
- Single-variable focus by country
- Top-panel normalization modes:
  - `Raw`
  - `Z-Score vs own history` (expanding window, no look-ahead)
  - `Percentile vs other countries (same month)`
- Middle panel cumulative return mode: `Absolute` or `Relative vs all-country average` (from return-index sheet)
- Bottom panel forward return by signal decile (`N`-month average return for each decile)
- Decile stats table (`Obs`, `Avg`, `Median`, `Hit Rate`)
- Range controls and URL/local-state persistence

## Project Structure
```text
app/
  assets/
    app.js                # Frontend logic/state/chart rendering
    triptych.js           # Triptych app logic
    styles.css            # UI styling
    triptych.css          # Triptych app styling
  data/
    t2_master.json        # Generated data payload used by UI
  docs/
    PROGRAM.md            # Full technical reference
  scripts/
    extract_t2_master.py  # Workbook -> JSON extractor
  index.html              # App shell
  triptych.html           # Triptych shell
  README.md               # This file
```

## Quick Start
From repo root (`.../Amit`):

1. Generate JSON from Excel
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

3. Open in browser
- `http://127.0.0.1:8000`
- Visualizer: `http://127.0.0.1:8000/index.html`
- Triptych: `http://127.0.0.1:8000/triptych.html`

## Data Pipeline
### Input
- Excel workbook with multiple sheets
- First row contains country/market headers
- First column contains dates
- Remaining cells contain numeric values (or blanks)

### Output JSON
Top-level shape:
```json
{
  "generated_at": "...",
  "source_file": "...",
  "sheets": {
    "Sheet Name": {
      "countries": ["India", "U.S.", "..."],
      "rows": [
        {
          "date": "YYYY-MM-DD",
          "values": {
            "India": 12.34,
            "U.S.": 9.87
          }
        }
      ]
    }
  }
}
```

## How To Use
### 1) Choose data
- Use `Sheet Filter` + `Select Filtered` to bulk-select variables
- Use `Country Filter` + `Select Filtered` to bulk-select countries

### 2) Command search
- Enter phrases like:
  - `India Trailing PE`
  - `Japan Earnings Yield`
  - `ChinaA REER`
- Click `Apply`

### 3) View controls
- Range buttons trim chart horizon
- Axis mode changes transformation behavior
- Series Manager lets you hide/show individual lines

### 4) Undo and clear
- `Undo` restores last selection snapshot
- `Clear` buttons remove current list selections
- `Clear All` resets both lists and hidden-series state

## URL State Format
State is encoded in query params:
- `s=` selected sheet indices
- `c=` selected country indices
- `r=` range (`all|10y|5y|3y|1y`)
- `a=` axis (`raw|indexed|zscore`)
- `h=` hidden series index pairs
- `partial=1` indicates trimmed share state

Example:
```text
?s=1,7,12&c=2,8&r=5y&a=raw&h=1-2.7-8
```

## Guardrails and Limits
To prevent browser lockups:
- Warn/confirm when render is large
- Block rendering when selection is too large
- URL payload is capped to keep links practical

Key caps in frontend:
- max URL length target: `1800` chars
- max decoded sheet indices: `80`
- max decoded country indices: `80`
- max hidden-series entries from URL: `500`

## Troubleshooting
### App loads but chart is blank
- Ensure at least one sheet and one country are selected
- Check `Series Manager` for `No data`, `Not indexable`, or `Not normalizable`
- Switch from `Z-Score`/`Indexed` to `Raw` to verify data availability

### Not seeing full time history
- Click `All` range
- Hard refresh browser (`Cmd+Shift+R`) after JS updates

### `localhost refused to connect`
- Restart the server:
```bash
cd app
python3 -m http.server 8000
```

### Extractor fails
- Confirm Python version and `openpyxl` availability
- Re-run extraction command and verify input path exists

## Development Notes
- Frontend is framework-free vanilla JS for portability
- No backend required; static hosting is enough
- Chart library is loaded via CDN in `index.html`
- Data must be regenerated when source workbook changes

## Additional Documentation
See full technical reference:
- [PROGRAM.md](/Users/arjundivecha/Dropbox/AAA Backup/A Working/Amit/app/docs/PROGRAM.md)
