# Testing

Triptych uses Playwright browser tests to validate both the shared math layer and the two-tab UI.

## Test runner

`playwright.config.js` configures the suite to:
- run tests from `./tests`
- launch the local server on port 8124 automatically
- use the live `triptych.html` app in a real browser

## What is tested

### `tests/core.spec.js`
This suite focuses on the shared logic exported by `window.T2Core`.
It checks:
- token normalization
- bucket assignment
- point-in-time bucket warm-up behavior
- expanding z-score construction
- Spearman IC and overlap-adjusted t-stat behavior
- bucket t-stat edge cases
- linear slope / intercept / R² fitting
- shared index construction and date-domain calculation

These tests are the best guard against regressions in the math layer or data loading contract.

### `tests/smoke.spec.js`
This suite exercises the live UI.
It checks:
- the Deep-Dive tab loads without console errors
- charts, stat cards, and tables render with real data
- the factor combobox behaves like a proper ARIA combobox
- keyboard tab switching works
- the Visualizer tab renders and keeps checkbox focus across updates

These tests guard the actual user experience, not just the helper functions.

## What the tests imply about architecture

The tests reveal a few important design constraints:
- the app must load `core.js` before either tab script
- the dataset must already be available in the browser
- the UI depends on accessibility roles and keyboard interaction, not just clicks
- the shared math layer is intended to be deterministic and browser-safe

## Running the suite

The config and tests indicate the canonical command is:

```bash
npx playwright test
```

The server is started automatically by the Playwright config, so you usually do not need to start it separately.

## When changing code

Before changing any of these areas, make sure the relevant test coverage still passes:
- shared math or data loading → `tests/core.spec.js`
- UI rendering or interactions → `tests/smoke.spec.js`
- launch/server plumbing → the whole Playwright suite

If you change behavior that is currently only covered indirectly, add a regression test near the existing suite instead of relying on manual verification.
