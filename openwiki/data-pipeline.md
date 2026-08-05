---
type: Reference
title: Data pipeline
description: Workbook-to-JSON extraction, format v2 columnar contract, refresh flow, backups, and the cloud-mode caveat for Triptych.
tags: [data-pipeline, extraction, refresh, format-v2]
openwiki:
  roles: [domain, operations]
  change_kinds: [data-model, lifecycle]
  source_paths: [app/scripts/extract_t2_master.py, app/scripts/serve_triptych.py, app/assets/core.js, app/data/t2_master.json, app/api/status.json, app/api/refresh.json, vercel.json]
  symbols: [extract_workbook, backup_current_json, format]
  invariants: [Dataset format must equal 2 or core.js throws; refresh is single-flight with 409 on conflict; backups trimmed to 10.]
  validation_commands: ["npx playwright test core.spec.js"]
---

# Data pipeline

Triptych’s data pipeline is a workbook-to-JSON conversion with a refreshable local cache.

## Source of truth

The source workbook is `T2 Master.xlsx`, a multi-sheet Excel file where:
- column A contains dates
- row 1 contains country headers
- each sheet represents a factor series

The repository docs and scripts reference the workbook by absolute path in the developer’s local environment. The important part for the codebase is the shape of the workbook, not the specific path.

## Extraction

`app/scripts/extract_t2_master.py` reads the workbook with `openpyxl` in read-only mode and emits a compact JSON payload.

### Output contract

The extractor writes `app/data/t2_master.json` in **format 2**:
- `format: 2`
- `generated_at`
- `source_file`
- `source_mtime`
- `sheets` keyed by sheet name
- each sheet contains:
  - `countries[]`
  - `dates[]`
  - `values` by country

This columnar layout stores dates and country names once, which makes the dataset smaller and faster to parse than the old row-oriented form.

### Extraction behavior

- blank or unusable rows are skipped
- sheets without usable data are skipped
- date values are normalized to `YYYY-MM-DD`
- numeric values become floats, blanks become `null`
- the file is written atomically through a temp file and rename

## Refresh flow

`app/scripts/serve_triptych.py` is responsible for keeping the dataset fresh when the source workbook changes.

### Status endpoint

`GET /api/status` reports:
- dataset generation time
- workbook source mtime
- source file existence
- stale/not stale
- refresh state and last refresh result

### Refresh endpoint

`POST /api/refresh`:
1. backs up the current JSON to `app/data/backups/` as gzipped timestamped files
2. re-runs the extractor
3. atomically replaces `app/data/t2_master.json`

Concurrent refreshes are blocked by a lock. If a refresh is already running, the server returns 409.

### Cloud deployment caveat

On the Vercel static deployment, `/api/refresh` is rewritten to `app/api/refresh.json`, which returns a static error explaining that refresh is unavailable. Data updates must be done locally by running `extract_t2_master.py` and then redeploying. The frontend checks `cloud_mode` from `/api/status` and hides the refresh button accordingly.

## Backups

The server keeps timestamped gzipped backups of the previous dataset and trims the backup directory to the 10 most recent files.

This matters because refreshes overwrite the live dataset. If extraction fails, the previous dataset remains available in the backup history.

## Runtime contract

The browser frontend expects the generated JSON to have `format: 2`. If the format does not match, `app/assets/core.js` throws rather than silently falling back.

That hard failure is intentional:
- it keeps the app and extractor in sync
- it prevents stale or partial datasets from being used silently

## What to watch when changing the pipeline

- preserve the `format: 2` schema unless you also update `core.js` and the frontend loaders
- keep refresh writes atomic
- keep status reporting aligned with what the UI expects
- make sure backup retention still works if the backup naming or location changes
- keep extraction tolerant of workbook quirks, but do not silently coerce unsupported shapes into wrong data

## Related source files

- `app/scripts/extract_t2_master.py`
- `app/scripts/serve_triptych.py`
- `app/assets/core.js`
- `app/data/t2_master.json`
- `app/data/backups/`
- `app/api/status.json`
- `app/api/refresh.json`
- `vercel.json`
