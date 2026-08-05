---
type: Reference
title: Factor Visualizer
description: The multi-series charting workbench tab for exploring arbitrary factor and country combinations, with namespaced URL-only state and render guardrails.
tags: [visualizer, frontend, url-state, charting]
openwiki:
  roles: [domain, workflow]
  change_kinds: [ui, url-state]
  source_paths: [app/assets/app.js, app/assets/core.js]
  symbols: [hydrateFromStorage, persistToStorage, updateUrlFromState]
  test_paths: [tests/smoke.spec.js]
  invariants: [State is URL-only (localStorage hooks are no-ops); URL params are namespaced vs/vc/vr/va/vh; guardrails warn at >50 series/>100k points and block >80 series/>200k points.]
  validation_commands: ["npx playwright test smoke.spec.js"]
---

# Factor Visualizer

The Factor Visualizer is the second Triptych tab. It is a multi-series charting workbench for exploring arbitrary combinations of factors and countries from the same dataset used by the Deep-Dive workflow.

## What it is for

Use this tab when you want to:
- compare many factor series at once
- search and select sheet/country pairs quickly
- normalize series in different ways
- share a reproducible chart state by URL

## Main capabilities

`app/assets/app.js` implements:
- searchable factor and country pickers
- command-style queries such as `India Trailing PE`
- fuzzy suggestions for ambiguous input
- five axis modes
- a per-series visibility manager
- undo for recent selection changes
- URL-encoded state sharing

## Axis modes

The tab supports five axis modes:
- raw
- indexed
- z-score over the visible window
- expanding z-score vs own history
- cross-sectional z-score

The shared math for these modes lives in `app/assets/core.js`.

## Selection model

The visualizer uses sheet and country selection lists rather than a single factor/country pair.
It also includes filter boxes plus bulk actions to select or clear filtered entries.

This is a more exploratory workflow than Deep-Dive, which is why the tab has a separate selection manager and undo stack.

## URL and persistence model

The visualizer stores state in the URL only, with namespaced parameters so it does not collide with the Deep-Dive tab.

`hydrateFromStorage()` returns `null` and `persistToStorage()` is a no-op — persistence is URL-only, matching the Deep-Dive tab and the `app/README.md` guarantee. Hydration order is defaults → URL (URL wins).

That design matters because both tabs live in the same app shell and share runtime helpers. Keep the parameter namespaces separate if you add new URL state.

## Guardrails

The tab warns and blocks when the chart becomes too large:
- warning above 50 series or 100k points
- block above 80 series or 200k points

These guardrails are part of the product behavior, not just implementation details; future changes should keep them visible.

## Shared dependencies

The visualizer depends on the shared dataset loader, shared index builder, and shared token normalization in `core.js`. That means changes to token parsing or index building can affect both tabs simultaneously.

## What to inspect before making changes

- `app/assets/app.js`
- `app/assets/core.js`
- `app/README.md`
- `app/docs/PROGRAM.md`
- `tests/smoke.spec.js`

## Change hazards

- Do not reintroduce a second copy of token normalization or date parsing.
- Keep the URL namespace separate from the Deep-Dive tab.
- Preserve the focus behavior of checkbox toggles; the Playwright smoke test guards this.
- If you change selection semantics, update both the docs and the browser tests.
