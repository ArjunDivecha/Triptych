/**
 * Smoke tests for both Triptych tabs: load the app, check for console
 * errors, and confirm charts + tables actually render with real data.
 * This guards the refactor (core.js extraction, ARIA, memoization) against
 * breaking the live app.
 */
const { test, expect } = require('@playwright/test');

test.describe('Deep-Dive tab smoke', () => {
  test('loads without console errors and renders charts + stat cards', async ({ page }) => {
    const errors = [];
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
    page.on('pageerror', (err) => errors.push(String(err)));

    await page.goto('/triptych.html');
    // Wait for the first chart to actually get data (skeleton dismissed).
    await page.waitForFunction(() => {
      const sk = document.querySelector('.chartSkeleton:not(.is-loaded)');
      return !sk; // all skeletons dismissed after first render
    }, null, { timeout: 15000 });

    // Stat cards render with values.
    const cardCount = await page.locator('#statCards .statCard').count();
    expect(cardCount).toBeGreaterThanOrEqual(1);

    // Decile table has body rows (real data).
    const rowCount = await page.locator('#decileTable tbody tr').count();
    expect(rowCount).toBeGreaterThan(0);

    // Horizon matrix rendered.
    const matrixRows = await page.locator('#horizonMatrix tbody tr').count();
    expect(matrixRows).toBeGreaterThan(0);

    // No console errors.
    expect(errors).toEqual([]);
  });

  test('combobox opens with ARIA listbox and keyboard navigates', async ({ page }) => {
    await page.goto('/triptych.html');
    // Wait until setupCombobox has run (it sets role=combobox on the input).
    await page.waitForFunction(() => {
      const el = document.getElementById('factorInput');
      return el && el.getAttribute('role') === 'combobox';
    }, null, { timeout: 15000 });

    const factorInput = page.locator('#factorInput');
    await factorInput.click();
    // Focus (via click) should open the list -> aria-expanded=true.
    await expect(factorInput).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#factorList')).toHaveAttribute('role', 'listbox');

    // ArrowDown should set aria-activedescendant on the input.
    await factorInput.press('ArrowDown');
    const ad = await factorInput.getAttribute('aria-activedescendant');
    expect(ad).toBeTruthy();
  });

  test('tabs switch via keyboard arrows and expose aria-selected', async ({ page }) => {
    await page.goto('/triptych.html');
    await page.waitForFunction(() => window.T2Core, null, { timeout: 15000 });

    const triptych = page.locator('#tabTriptych');
    const visualizer = page.locator('#tabVisualizer');

    await triptych.focus();
    await page.keyboard.press('ArrowRight');
    await expect(visualizer).toHaveAttribute('aria-selected', 'true');
    await expect(triptych).toHaveAttribute('aria-selected', 'false');
    // Visualizer panel shown, triptych hidden.
    await expect(page.locator('#visualizer-view')).not.toHaveAttribute('hidden', '');
    // Actually: when visualizer is active, triptych-view should be hidden.
    const triptychHidden = await page.locator('#triptych-view').evaluate((el) => el.hidden);
    expect(triptychHidden).toBe(true);
  });
});

test.describe('Visualizer tab smoke', () => {
  test('loads, renders the chart, and series manager has focusable toggles', async ({ page }) => {
    const errors = [];
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
    page.on('pageerror', (err) => errors.push(String(err)));

    await page.goto('/triptych.html?tab=visualizer');
    // Wait for series manager rows (default selection loads one sheet+country).
    await page.waitForFunction(() => document.querySelectorAll('#vizSeriesManager .seriesItem').length > 0, null, { timeout: 15000 });

    const seriesCount = await page.locator('#vizSeriesManager .seriesItem').count();
    expect(seriesCount).toBeGreaterThan(0);

    // Toggling a series checkbox keeps focus (P0 #2 regression guard).
    const firstToggle = page.locator('#vizSeriesManager .seriesItem input').first();
    await firstToggle.focus();
    await firstToggle.uncheck();
    // After re-render, focus should still be on a checkbox in the manager.
    const focusedIsCheckbox = await page.evaluate(() => {
      const a = document.activeElement;
      return a && a.tagName === 'INPUT' && a.type === 'checkbox' &&
        a.closest('#vizSeriesManager') !== null;
    });
    expect(focusedIsCheckbox).toBe(true);

    expect(errors).toEqual([]);
  });
});
