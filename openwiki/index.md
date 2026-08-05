---
okf_version: "0.1"
---

# Files

- [Architecture](architecture.md) - Triptych's three-layer local-first architecture — Python data preparation, shared window.T2Core runtime logic, and two browser tabs on one columnar v2 dataset.
- [Data pipeline](data-pipeline.md) - Workbook-to-JSON extraction, format v2 columnar contract, refresh flow, backups, and the cloud-mode caveat for Triptych.
- [Triptych Deep-Dive](deep-dive.md) - The core analytical workflow for one factor and one market — signal charts, cumulative returns, bucket statistics, horizon matrix, exports, and refresh UX.
- [Operations](operations.md) - Local and cloud deployment, refresh behavior, API surface, requirements, troubleshooting, and the OpenWiki auto-update CI workflow for Triptych.
- [OpenWiki quickstart](quickstart.md) - Entry point for the Triptych OpenWiki knowledge base — what the app does, how the docs are organized, and where to go next for any change area.
- [Testing](testing.md) - Playwright browser tests validating the shared math layer (core.spec.js) and both tab UIs (smoke.spec.js) against the live app.
- [Factor Visualizer](visualizer.md) - The multi-series charting workbench tab for exploring arbitrary factor and country combinations, with namespaced URL-only state and render guardrails.
