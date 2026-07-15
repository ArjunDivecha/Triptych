# Operations

This repository is designed to run locally with a simple operational model: static frontend files, a stdlib Python server, and an Excel-to-JSON refresh path.

## How to launch

The documented primary entrypoint is the macOS app bundle at the repository root. The bundle starts the local server and opens the app in a browser window.

A manual server launch is also supported:

```bash
cd "/Users/arjundivecha/Dropbox/AAA Backup/A Working/Triptych/app/scripts"
python3 serve_triptych.py --auto-refresh
# then open http://127.0.0.1:8123/triptych.html
```

## Local API

`app/scripts/serve_triptych.py` exposes:
- `GET /api/status`
- `POST /api/refresh`

### `/api/status`
Returns dataset vintage, workbook freshness, and refresh state.

### `/api/refresh`
Starts a background refresh if one is not already running.
It returns 202 on success and 409 if a refresh is already in flight.

## Refresh behavior

When a refresh runs:
1. the current dataset is backed up as gzipped JSON under `app/data/backups/`
2. the workbook is re-extracted
3. the new dataset is atomically swapped in

This prevents partial writes and preserves a short backup history.

## Cloud deployment (Vercel)

The app can also be deployed as a static site on Vercel. In this mode there is no Python server; `vercel.json` configures static rewrites that map `/api/status` and `/api/refresh` to committed JSON stubs under `app/api/`.

- `app/api/status.json` returns `{"cloud_mode": true, …}` with a message explaining that refresh is not available in the cloud deployment.
- `app/api/refresh.json` returns an error JSON with redeploy instructions.
- `app/assets/triptych.js` checks `status.cloud_mode` and hides the Refresh Data button when true, since live workbook re-extraction is not possible without the local Python server.

To refresh data in a cloud deployment, re-extract locally with `extract_t2_master.py` and redeploy with `vercel --prod`.

### iframe embedding

`vercel.json` sets `frame-ancestors *` in the Content-Security-Policy header, allowing the deployed app to be embedded in an iframe. This was added so the ASADO cockpit can host Triptych as a read-only in-page popup. The app has no auth or mutation actions in cloud mode, so framing is low-risk.

## Requirements

The docs describe the runtime requirements as:
- macOS for the bundled app experience
- Google Chrome preferred, with a fallback to the default browser if Chrome is unavailable
- Python 3 with `openpyxl` for extraction and refresh
- Vercel (optional) for cloud deployment; no server-side runtime needed there

## Troubleshooting signals

Useful failure modes are surfaced explicitly:
- stale workbook vs dataset warnings in the header
- refresh errors in the UI banner and `/api/status`
- server/API availability issues if the app is opened through a plain static file server rather than `serve_triptych.py`

## Tests and verification

Use the Playwright suite to verify the app from the browser’s point of view:
- `npx playwright test`

The test runner starts the local server automatically through `playwright.config.js`.

If you are changing runtime behavior, the two most important checks are:
- `tests/core.spec.js` for math and data-contract regressions
- `tests/smoke.spec.js` for end-to-end rendering and accessibility regressions

## Operational change checklist

When touching launch or refresh code:
- keep status fields aligned with what the UI reads
- keep refresh single-flight
- keep backups limited to the newest 10 files
- keep gzip handling for static assets and JSON
- update the docs if the launch path or API contract changes

## Source files to inspect

- `app/scripts/serve_triptych.py`
- `app/scripts/extract_t2_master.py`
- `app/api/status.json`
- `app/api/refresh.json`
- `vercel.json`
- `app/README.md`
- `README.md`
- `playwright.config.js`
- `tests/core.spec.js`
- `tests/smoke.spec.js`
