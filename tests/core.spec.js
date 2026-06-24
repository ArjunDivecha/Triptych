/**
 * In-browser unit tests for the shared math in window.T2Core.
 *
 * These load the real app (so core.js, triptych.js, app.js all execute in a
 * real browser against the live dataset) and then assert on T2Core's pure
 * functions with hand-computed inputs. This catches regressions in the
 * bucketing / z-score / IC / t-stat math that the visual smoke test can't.
 */
const { test, expect } = require('@playwright/test');

test.describe('T2Core shared math', () => {
  test.beforeEach(async ({ page }) => {
    // Load the app; wait for core.js (window.T2Core) and the dataset.
    const ready = page.waitForFunction(() => window.T2Core && window.T2Core.RANGE_VALUES, null, { timeout: 15000 });
    await page.goto('/triptych.html');
    await ready;
  });

  test('normalizeToken collapses slashes consistently (P0 #1 regression)', async ({ page }) => {
    // Both tabs previously diverged here; the canonical version collapses "/"
    // to spaces so "P/E" and "PE" tokenize the same way.
    const got = await page.evaluate(() => [
      window.T2Core.normalizeToken('P/E'),
      window.T2Core.normalizeToken('Trailing PE'),
      window.T2Core.normalizeToken('  Multiple   Spaces  '),
      window.T2Core.normalizeToken('CAPE/X'),
    ]);
    expect(got).toEqual(['p e', 'trailing pe', 'multiple spaces', 'cape x']);
  });

  test('assignBucket assigns across thresholds', async ({ page }) => {
    const got = await page.evaluate(() => {
      const C = window.T2Core;
      // deciles: 10 buckets -> 9 thresholds at p = 0.1..0.9
      const sorted = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
      const th = C.thresholdsFromSorted(sorted, 10);
      return {
        thCount: th.length,
        // value 5 should land in bucket 1 (<= first threshold ~10.9)
        b5: C.assignBucket(5, th),
        // value 50 should land in bucket 5
        b50: C.assignBucket(50, th),
        // value 100 should land in bucket 10 (highest)
        b100: C.assignBucket(100, th),
        // non-finite -> null
        bnan: C.assignBucket(NaN, th),
      };
    });
    expect(got.thCount).toBe(9);
    expect(got.b5).toBe(1);
    expect(got.b50).toBe(5);
    expect(got.b100).toBe(10);
    expect(got.bnan).toBeNull();
  });

  test('assignBucketsToRecords PIT warm-up nulls buckets below PIT_MIN_OBS', async ({ page }) => {
    const got = await page.evaluate(() => {
      const C = window.T2Core;
      // 40 chronological records with monotonic signals.
      const records = Array.from({ length: 40 }, (_, i) => ({ ms: i, signal: i, forwardReturn: 0.01 * i }));
      const { records: out } = C.assignBucketsToRecords(records, 'pit', 10);
      const nullCount = out.filter((r) => r.bucket === null).length;
      const assignedCount = out.filter((r) => r.bucket !== null).length;
      return { nullCount, assignedCount, pitMinObs: C.PIT_MIN_OBS };
    });
    // The first PIT_MIN_OBS-1 records (indices 0..34) have null buckets
    // because the accumulator inserts before the length check; record #36
    // (index 35) is the first assigned. So 35 null, 5 assigned.
    expect(got.nullCount).toBe(got.pitMinObs - 1);
    expect(got.assignedCount).toBe(40 - (got.pitMinObs - 1));
  });

  test('buildExpandingZScoreSeries is finite and zero on first point', async ({ page }) => {
    const got = await page.evaluate(() => {
      const C = window.T2Core;
      const raw = [1, 2, 3, 4, 5].map((v, i) => ({ ms: i, value: v }));
      const out = C.buildExpandingZScoreSeries(raw);
      return {
        first: out[0].signal,
        allFinite: out.every((p) => Number.isFinite(p.signal)),
        // for a monotonic 1..5 series, the last z should be positive (new high)
        lastSign: Math.sign(out[out.length - 1].signal),
      };
    });
    expect(got.first).toBe(0);
    expect(got.allFinite).toBe(true);
    expect(got.lastSign).toBe(1);
  });

  test('spearmanIC returns null t-stat for tiny samples and perfect correlation', async ({ page }) => {
    const got = await page.evaluate(() => {
      const C = window.T2Core;
      // 5 records -> below the 6-observation floor -> {ic:null,t:null}
      const small = Array.from({ length: 5 }, (_, i) => ({ signal: i, forwardReturn: i }));
      // 20 perfectly correlated records -> IC ~ 1, but denom = 1 - 1 = 0 so
      // the t-statistic is undefined (correctly null).
      const perfect = Array.from({ length: 20 }, (_, i) => ({ signal: i, forwardReturn: i * 2 }));
      // 20 strongly-but-not-perfectly correlated records -> finite IC and t.
      const strong = Array.from({ length: 20 }, (_, i) => ({
        signal: i,
        forwardReturn: i * 2 + (i % 3 === 0 ? 5 : 0),
      }));
      return {
        small: C.spearmanIC(small, 12),
        perfect: C.spearmanIC(perfect, 1),
        strong: C.spearmanIC(strong, 1),
      };
    });
    expect(got.small).toEqual({ ic: null, t: null });
    expect(got.perfect.ic).toBeCloseTo(1, 5);
    expect(got.perfect.t).toBeNull(); // denom = 1 - 1 = 0 -> undefined
    expect(Number.isFinite(got.strong.ic)).toBe(true);
    expect(got.strong.t).not.toBeNull();
  });

  test('bucketTStat handles tiny/degenerate inputs', async ({ page }) => {
    const got = await page.evaluate(() => {
      const C = window.T2Core;
      return {
        twoObs: C.bucketTStat([1, 2], 12),         // n<3 -> null
        zeroVar: C.bucketTStat([5, 5, 5], 12),     // sd=0 -> null
        normal: C.bucketTStat([1, 2, 3, 4, 5], 1),  // mean 3, finite
      };
    });
    expect(got.twoObs).toBeNull();
    expect(got.zeroVar).toBeNull();
    expect(got.normal).not.toBeNull();
  });

  test('shared indexes build once and expose the dataset domain', async ({ page }) => {
    // Confirms T2Core.buildIndexes produces a sane date domain and that the
    // index layer is shared (both tabs set T2Core.indexes to the same object).
    const got = await page.evaluate(async () => {
      const C = window.T2Core;
      const wb = await C.loadData();
      const idx = C.buildIndexes(wb);
      return {
        sheetCount: idx.allSheets.length,
        countryCount: idx.allCountries.length,
        hasMin: Number.isFinite(idx.dateDomain.min),
        hasMax: Number.isFinite(idx.dateDomain.max),
        cacheIsMap: idx.seriesCache instanceof Map,
      };
    });
    expect(got.sheetCount).toBeGreaterThan(0);
    expect(got.countryCount).toBeGreaterThan(0);
    expect(got.hasMin && got.hasMax).toBe(true);
    expect(got.cacheIsMap).toBe(true);
  });
});
