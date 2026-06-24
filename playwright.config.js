/**
 * Playwright config for Triptych front-end review tests.
 *
 * These are in-browser tests: they load the real app against the local
 * serve_triptych.py server and exercise the pure math in window.T2Core
 * (bucketing, expanding z-score, Spearman IC, overlap-adjusted t-stats)
 * against hand-computed inputs. They also smoke-test the two tabs.
 *
 * Run:
 *   npx playwright test
 *
 * Requires the server running: python3 app/scripts/serve_triptych.py --port 8124
 * (webServer below starts it automatically).
 */
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 30000,
  expect: { timeout: 10000 },
  use: {
    baseURL: 'http://127.0.0.1:8124',
    headless: true,
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: 'python3 app/scripts/serve_triptych.py --port 8124',
    url: 'http://127.0.0.1:8124/api/status',
    reuseExistingServer: true,
    timeout: 20000,
    cwd: __dirname,
  },
});
