# Program Documentation

This document provides a full technical reference for `T2 Factor Visualizer`.

## 1. System Architecture

### 1.1 Components
1. Extractor (`scripts/extract_t2_master.py`)
2. Static frontend (`index.html`, `assets/app.js`, `assets/styles.css`)
3. Data file (`data/t2_master.json`)

### 1.2 Runtime Flow
1. Browser requests `index.html`
2. Frontend loads `t2_master.json`
3. App validates data structure and builds indexes
4. UI events mutate app state
5. Derived state builds chart datasets
6. Chart.js renders canvas
7. State syncs to URL and local storage

## 2. Extractor Script

File: `/Users/arjundivecha/Dropbox/AAA Backup/A Working/Amit/app/scripts/extract_t2_master.py`

### 2.1 Purpose
Convert Excel workbook to normalized JSON that is chart-ready.

### 2.2 CLI
```bash
python3 app/scripts/extract_t2_master.py --input <path.xlsx> --output <path.json>
```

### 2.3 Data Handling
- Reads workbook in read-only mode
- Uses first row as country headers
- Uses column A as date field
- Stores numeric values only (non-numeric -> `null`)
- Skips empty rows/sheets where appropriate

## 3. Frontend State Model

File: `/Users/arjundivecha/Dropbox/AAA Backup/A Working/Amit/app/assets/app.js`

### 3.1 Core State
- `selectedSheets: Set<string>`
- `selectedCountries: Set<string>`
- `hiddenSeries: Set<string>`
- `hiddenSeriesOrder: string[]`
- `activeRange: 'all' | '10y' | '5y' | '3y' | '1y'`
- `axisMode: 'raw' | 'indexed' | 'zscore'`
- `undoStack: snapshot[]`
- `isSharePartial: boolean`

### 3.2 Snapshot/Undo
Each destructive or structural selection action pushes a snapshot.
Undo restores entire snapshot (selections, hidden state, range, axis).
Stack depth: 3.

## 4. Indexes and Caches

### 4.1 Built at init
- `allSheets[]`
- `allCountries[]`
- `sheetToCountries: Map<sheet, Set<country>>`
- `seriesCache: Map<'sheet|||country', Point[]>`

### 4.2 Point Structure
```ts
{
  date: string;   // YYYY-MM-DD
  ms: number;     // unix epoch ms
  value: number;
}
```

## 5. Selection and Cascade Logic

### 5.1 Valid Country Union
Valid countries are computed as union across selected sheets.

### 5.2 Pruning Rules
On sheet changes:
- countries not in union are removed
- hidden series referencing invalid sheet/country are removed
- app notifies user via banner when pruning occurs

## 6. Command Search Behavior

### 6.1 Normalization
- lowercase
- punctuation/extra spaces normalized
- alias replacements:
  - `training -> trailing`
  - `p/e -> pe`

### 6.2 Matching
1. Try exact/substring score-based pair selection
2. If no direct match, compute fuzzy score
3. Show top 3 fuzzy suggestions; user chooses one

### 6.3 Debounce
Command parsing on input: `180ms`.

## 7. Transform and Rendering Pipeline

### 7.1 Modes
- `raw`: unchanged values
- `indexed`: divide by first non-zero visible value, * 100
- `zscore`: `(x - mean) / std` over visible window

### 7.2 Invalid Series Conditions
- `No data`: no points after filters
- `Not indexable`: no usable anchor in indexed mode
- `Not normalizable`: insufficient variation for zscore

### 7.3 Time Range
Range buttons compute a start date from dataset max date:
- `10y`, `5y`, `3y`, `1y`, `all`

### 7.4 Chart Setup
- Chart.js line chart
- x-axis: linear (timestamp ms)
- tooltip title converts x -> `YYYY-MM-DD`
- native legend disabled; custom manager used

## 8. Performance Guardrails

Render checks run before draw:
- warning zone (confirm dialog) for large selections
- hard block beyond configured caps

This prevents accidental huge render combinations from freezing the browser.

## 9. URL and Persistence

### 9.1 URL Encoding
Short index-based serialization of selected entities.

### 9.2 Validation
- strict numeric parsing
- bounds checking against available indices
- capped list sizes

### 9.3 Partial Share
If URL would exceed target length:
- hidden-series payload trimmed
- `partial=1` set
- sender sees warning

### 9.4 Local Storage
- last state cached
- tab-scoped state stored with runtime tab id
- old tab entries pruned

## 10. Error Handling

### 10.1 Data Load
- fetch errors -> banner + empty-state message
- malformed sheet blocks are skipped and listed

### 10.2 Chart Library
If Chart.js is unavailable, app shows explicit chart-load failure message.

## 11. Accessibility Notes

Current support includes:
- labeled controls
- keyboard-usable native inputs/selects/buttons
- live summary/banner text areas

Potential enhancements:
- richer ARIA for dynamic series manager rows
- keyboard shortcuts for power actions

## 12. Security Notes

Current safeguards:
- user-facing strings use `textContent`
- URL/local state validated before apply
- strict number parsing for indices

Recommended hardening for deployment:
- add CSP headers
- pin third-party script versions and integrity attributes

## 13. Operational Procedures

### 13.1 Update source data
1. Regenerate JSON from workbook
2. Restart server
3. Hard refresh browser

### 13.2 Rebuild from scratch
```bash
cd "/Users/arjundivecha/Dropbox/AAA Backup/A Working/Amit"
python3 app/scripts/extract_t2_master.py \
  --input "/Users/arjundivecha/Dropbox/AAA Backup/A Complete/T2 Factor Timing Fuzzy/T2 Master.xlsx" \
  --output "app/data/t2_master.json"
cd app
python3 -m http.server 8000
```

## 14. Known Limitations
- Static JSON can become large and impact first-load time
- Fuzzy parser may still require manual suggestion click for ambiguous phrases
- No built-in export (PNG/CSV) yet
- No automated test suite yet (manual validation currently used)

## 15. Suggested Next Improvements
1. Add automated tests for parser/state serialization
2. Add export functions (chart image + filtered CSV)
3. Add point downsampling for very large series
4. Add deployment profile (Vercel/Cloudflare static hosting)
