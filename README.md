# Visualization

T2 Factor Visualizer for multi-sheet, multi-country time-series analysis.

## Location of App
- Main app code: `app/`
- Full app documentation: `app/README.md`
- Technical program docs: `app/docs/PROGRAM.md`

## Quick Start
```bash
cd app
python3 -m http.server 8000
```
Open: `http://127.0.0.1:8000`

## Regenerate Data
```bash
python3 app/scripts/extract_t2_master.py \
  --input "/Users/arjundivecha/Dropbox/AAA Backup/A Complete/T2 Factor Timing Fuzzy/T2 Master.xlsx" \
  --output "app/data/t2_master.json"
```

## Notes
This repository currently keeps the web app under `app/`.
