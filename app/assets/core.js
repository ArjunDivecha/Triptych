/*
=============================================================================
FILE: core.js
=============================================================================

DESCRIPTION:
Single source of truth for logic shared by the Triptych Deep-Dive tab
(triptych.js) and the Factor Visualizer tab (app.js). Loaded BEFORE both
tab scripts via a plain <script> tag and exposed on window.T2Core.

Why a shared module (and not native ES modules): both tab scripts are
~1k-line IIFEs that already cooperate via the global window.__t2DataPromise
fetched-once dataset. A plain global core keeps that architecture, needs no
build step, and works fully offline with the stdlib serve_triptych.py server.

Contains:
  - Constants: RANGE_VALUES, HORIZON_OPTIONS, guardrails, heatmap bands,
    PIT warm-up, nearest-date tolerance. (Named here so they stop being
    magic numbers scattered across files.)
  - Token normalization (one canonical version — previously duplicated and
    divergent between the two tabs; the Visualizer stripped slashes that the
    Deep-Dive combobox kept, so names with "/" matched differently).
  - Dataset loading + format validation (the shared __t2DataPromise).
  - Index building from the columnar v2 dataset (series cache, cross-country
    cache, date domain). Built ONCE and shared by both tabs so memory is not
    doubled. crossCountryCache is built lazily on first cross-country use
    (it is opt-in via the cross-sectional axis/normalization modes).
  - Signal construction: expanding z-score (Welford), cross-sectional z.
  - Bucketing: full-sample vs point-in-time thresholds.
  - Statistics: overlap-adjusted t-stats, Spearman IC, ranks, Pearson.
  - Range helpers.

INPUT FILES (fetched over HTTP at runtime):
- ./data/t2_master.json  (columnar v2; format must equal 2 or this throws)

OUTPUT FILES: None. In-memory caches only.
=============================================================================
*/

window.T2Core = (() => {
  /* ---------------------------------------------------------------------
   * Named constants (previously magic numbers inline)
   * --------------------------------------------------------------------- */
  const RANGE_VALUES = new Set(["all", "10y", "5y", "3y", "1y"]);
  const HORIZON_OPTIONS = [1, 3, 6, 12, 24, 36];
  const TOLERANCE_MS = 15 * 86400000; // nearest-date matching window: 15 days
  const PIT_MIN_OBS = 36;             // months of history before PIT bucketing

  // Visualizer render guardrails (previously inline 50/80/100000/200000)
  const GUARDRAIL_WARN_SERIES = 50;
  const GUARDRAIL_BLOCK_SERIES = 80;
  const GUARDRAIL_WARN_POINTS = 100000;
  const GUARDRAIL_BLOCK_POINTS = 200000;

  // Horizon-matrix heatmap bands: |v| >= band3 -> 3, >= band2 -> 2,
  // >= band1 -> 1, else flat. Used by matrixCellClass in triptych.js.
  const HEATMAP_BANDS = { band1: 0.02, band2: 0.07, band3: 0.15 };

  /* ---------------------------------------------------------------------
   * Dataset loader (fetched once, shared by both tabs)
   * --------------------------------------------------------------------- */
  const DATA_PATH = "./data/t2_master.json";

  window.__t2DataPromise =
    window.__t2DataPromise ||
    (async () => {
      const resp = await fetch(DATA_PATH, { cache: "no-store" });
      if (!resp.ok) throw new Error(`Failed to load data (${resp.status})`);
      const parsed = await resp.json();
      if (!parsed || typeof parsed.sheets !== "object") {
        throw new Error("Malformed dataset: missing sheets");
      }
      if (parsed.format !== 2) {
        throw new Error(
          `Unsupported dataset format (${parsed.format ?? "v1"}). ` +
            "Regenerate with scripts/extract_t2_master.py."
        );
      }
      const cleanedSheets = {};
      const skipped = [];
      Object.entries(parsed.sheets).forEach(([name, sheet]) => {
        if (
          !sheet ||
          !Array.isArray(sheet.countries) ||
          !Array.isArray(sheet.dates) ||
          typeof sheet.values !== "object"
        ) {
          skipped.push(name);
          return;
        }
        cleanedSheets[name] = sheet;
      });
      return { ...parsed, sheets: cleanedSheets, __skipped: skipped };
    })();

  /* ---------------------------------------------------------------------
   * Token normalization — ONE canonical version.
   * Slashes are collapsed to spaces so "P/E" and "PE" tokenize the same
   * way across both tabs. (Previously triptych.js kept "/", app.js stripped
   * it — divergent matching for any factor/country containing a slash.)
   * --------------------------------------------------------------------- */
  function normalizeToken(text) {
    return String(text)
      .toLowerCase()
      .replace(/[^\w\s/]+/g, " ")
      .replace(/[\/]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeSheetName(name) {
    return String(name || "").trim().toLowerCase();
  }

  function sortText(a, b) {
    return a.localeCompare(b);
  }

  /* ---------------------------------------------------------------------
   * Date + numeric helpers
   * --------------------------------------------------------------------- */
  function parseDateMs(date) {
    return Date.parse(`${date}T00:00:00Z`);
  }

  function addMonthsMs(ms, months) {
    const d = new Date(ms);
    const targetMonth = d.getUTCMonth() + months;
    d.setUTCMonth(targetMonth);
    // Clamp day to the last day of the target month (fixes Jan 31 + 1 month = Mar 3)
    if (d.getUTCMonth() !== (targetMonth % 12 + 12) % 12) {
      d.setUTCDate(0); // last day of previous month
    }
    return d.getTime();
  }

  function getRangeStartMs(maxMs, range) {
    if (range === "all" || !maxMs) return null;
    const years = { "10y": 10, "5y": 5, "3y": 3, "1y": 1 }[range];
    if (!years) return null;
    const d = new Date(maxMs);
    d.setUTCFullYear(d.getUTCFullYear() - years);
    return d.getTime();
  }

  function formatPct(v, digits = 2) {
    if (!Number.isFinite(v)) return "-";
    return `${(v * 100).toFixed(digits)}%`;
  }

  function formatNum(v, digits = 2) {
    if (!Number.isFinite(v)) return "-";
    return v.toLocaleString(undefined, { maximumFractionDigits: digits });
  }

  function median(values) {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return null;
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) return sorted[mid];
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function quantile(sorted, p) {
    if (!sorted.length) return null;
    const idx = (sorted.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    const w = idx - lo;
    return sorted[lo] * (1 - w) + sorted[hi] * w;
  }

  function binaryInsert(arr, v) {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < v) lo = mid + 1;
      else hi = mid;
    }
    arr.splice(lo, 0, v);
  }

  /* ---------------------------------------------------------------------
   * Index building — run ONCE, shared by both tabs via T2Core.buildIndexes.
   * Returns an object with caches; the caller may store it on T2Core.indexes
   * so the other tab reuses the same in-memory structures (halves memory).
   * crossCountryCache is built lazily (see getCrossCountryAt).
   * --------------------------------------------------------------------- */
  function getSeriesKey(sheet, country) {
    return `${sheet}|||${country}`;
  }

  function getCrossCountryKey(sheet, date) {
    return `${sheet}|||${date}`;
  }

  function buildIndexes(workbook) {
    const allSheets = Object.keys(workbook.sheets).sort(sortText);
    const sheetToCountries = new Map();
    const seriesCache = new Map();
    const seriesMsCache = new Map();
    const countrySet = new Set();
    let minMs = Infinity;
    let maxMs = -Infinity;

    for (const sheet of allSheets) {
      const ws = workbook.sheets[sheet];
      const countries = Array.from(new Set(ws.countries)).sort(sortText);
      sheetToCountries.set(sheet, new Set(countries));
      countries.forEach((c) => countrySet.add(c));

      const dateMs = ws.dates.map(parseDateMs);

      for (const country of countries) {
        const colValues = ws.values[country] || [];
        const points = [];
        for (let i = 0; i < ws.dates.length; i += 1) {
          const raw = colValues[i];
          if (!Number.isFinite(raw)) continue;
          const ms = dateMs[i];
          if (!Number.isFinite(ms)) continue;
          points.push({ date: ws.dates[i], ms, value: Number(raw) });
          if (ms < minMs) minMs = ms;
          if (ms > maxMs) maxMs = ms;
        }
        const key = getSeriesKey(sheet, country);
        seriesCache.set(key, points);
        seriesMsCache.set(key, points.map((p) => p.ms));
      }
    }

    const allCountries = Array.from(countrySet).sort(sortText);
    const dateDomain = {
      min: Number.isFinite(minMs) ? minMs : null,
      max: Number.isFinite(maxMs) ? maxMs : null,
    };

    return {
      allSheets,
      allCountries,
      sheetToCountries,
      seriesCache,
      seriesMsCache,
      crossCountryCache: new Map(), // lazy — populated by ensureCrossCountry
      _workbook: workbook,
      dateDomain,
    };
  }

  /* Lazily build the cross-country slice for a (sheet, date) on first use.
   * Previously both tabs eagerly built ~58 sheets x ~300 dates = ~17k entries
   * up front, even though cross-sectional mode is opt-in. */
  function ensureCrossCountry(indexes, sheet, date) {
    const key = getCrossCountryKey(sheet, date);
    if (indexes.crossCountryCache.has(key)) return indexes.crossCountryCache.get(key);
    const ws = indexes._workbook.sheets[sheet];
    if (!ws) return null;
    // Find the date index. Dates are ISO strings; use the workbook's array.
    const i = ws.dates.indexOf(date);
    if (i < 0) {
      indexes.crossCountryCache.set(key, null);
      return null;
    }
    const countries = Array.from(indexes.sheetToCountries.get(sheet) || []);
    const arr = [];
    for (const country of countries) {
      const raw = (ws.values[country] || [])[i];
      if (!Number.isFinite(raw)) continue;
      arr.push({ country, value: Number(raw) });
    }
    const result = arr.length ? arr : null;
    indexes.crossCountryCache.set(key, result);
    return result;
  }

  function getSeries(indexes, sheet, country) {
    return indexes.seriesCache.get(getSeriesKey(sheet, country)) || [];
  }

  function getCountriesForFactor(indexes, sheet) {
    const set = indexes.sheetToCountries.get(sheet);
    if (!set) return [];
    return Array.from(set).sort(sortText);
  }

  /* Nearest-point lookup within TOLERANCE_MS (handles month-end vs month-start grids). */
  function nearestPoint(indexes, sheet, country, targetMs) {
    const key = getSeriesKey(sheet, country);
    const msArr = indexes.seriesMsCache.get(key);
    const points = indexes.seriesCache.get(key);
    if (!msArr || !msArr.length) return null;
    let lo = 0;
    let hi = msArr.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (msArr[mid] < targetMs) lo = mid + 1;
      else hi = mid;
    }
    let best = null;
    let bestDiff = Infinity;
    for (const i of [lo - 1, lo]) {
      if (i < 0 || i >= msArr.length) continue;
      const diff = Math.abs(msArr[i] - targetMs);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = i;
      }
    }
    if (best === null || bestDiff > TOLERANCE_MS) return null;
    return points[best];
  }

  /* ---------------------------------------------------------------------
   * Signal construction
   * --------------------------------------------------------------------- */
  function percentileVsCrossCountry(indexes, sheet, country, date, value) {
    const arr = ensureCrossCountry(indexes, sheet, date);
    if (!arr || arr.length < 2) return null;

    const peers = [];
    for (const peer of arr) {
      if (peer.country === country) continue;
      if (!Number.isFinite(peer.value)) continue;
      peers.push(peer.value);
    }
    if (peers.length === 0) return null;

    const mean = peers.reduce((sum, v) => sum + v, 0) / peers.length;
    const variance = peers.reduce((sum, v) => sum + (v - mean) ** 2, 0) / peers.length;
    const stdDev = Math.sqrt(variance);
    if (stdDev === 0) return 0;
    return (value - mean) / stdDev;
  }

  function buildExpandingZScoreSeries(rawSeries) {
    let count = 0;
    let mean = 0;
    let m2 = 0;
    return rawSeries.map((p) => {
      const x = p.value;
      count += 1;
      const delta = x - mean;
      mean += delta / count;
      const delta2 = x - mean;
      m2 += delta * delta2;
      if (count < 2) return { ...p, signal: 0 };
      const variance = Math.max(0, m2 / count); // guard against floating-point drift
      const std = Math.sqrt(variance);
      if (!Number.isFinite(std) || std === 0) return { ...p, signal: 0 };
      return { ...p, signal: (x - mean) / std };
    });
  }

  /* ---------------------------------------------------------------------
   * Bucketing: full-sample vs point-in-time thresholds
   * --------------------------------------------------------------------- */
  function thresholdsFromSorted(sorted, k) {
    if (sorted.length < 2) return [];
    const thresholds = [];
    for (let i = 1; i < k; i += 1) thresholds.push(quantile(sorted, i / k));
    return thresholds;
  }

  function assignBucket(value, thresholds) {
    if (!Number.isFinite(value) || !thresholds.length) return null;
    for (let i = 0; i < thresholds.length; i += 1) {
      if (value <= thresholds[i]) return i + 1;
    }
    return thresholds.length + 1;
  }

  /* records must be in chronological order. Returns records with .bucket
   * (null during PIT warm-up) and the latest thresholds. */
  function assignBucketsToRecords(records, mode, k) {
    if (mode === "pit") {
      const sortedSoFar = [];
      const out = records.map((r) => {
        binaryInsert(sortedSoFar, r.signal);
        if (sortedSoFar.length < PIT_MIN_OBS) return { ...r, bucket: null };
        const thresholds = thresholdsFromSorted(sortedSoFar, k);
        return { ...r, bucket: assignBucket(r.signal, thresholds) };
      });
      return { records: out, finalThresholds: thresholdsFromSorted(sortedSoFar, k) };
    }
    const sorted = records.map((r) => r.signal).filter(Number.isFinite).sort((a, b) => a - b);
    const thresholds = thresholdsFromSorted(sorted, k);
    return {
      records: records.map((r) => ({ ...r, bucket: assignBucket(r.signal, thresholds) })),
      finalThresholds: thresholds,
    };
  }

  /* ---------------------------------------------------------------------
   * Statistics: overlap-adjusted t-stats and Spearman IC
   * --------------------------------------------------------------------- */
  function bucketTStat(vals, horizonMonths) {
    const n = vals.length;
    if (n < 3) return null;
    const mean = vals.reduce((a, b) => a + b, 0) / n;
    const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
    const sd = Math.sqrt(variance);
    if (!Number.isFinite(sd) || sd === 0) return null;
    const nEff = Math.max(2, n / Math.max(1, horizonMonths));
    return mean / (sd / Math.sqrt(nEff));
  }

  function rankArray(vals) {
    const idx = vals.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const ranks = new Array(vals.length);
    let i = 0;
    while (i < idx.length) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j += 1;
      const avgRank = (i + j) / 2 + 1;
      for (let k = i; k <= j; k += 1) ranks[idx[k][1]] = avgRank;
      i = j + 1;
    }
    return ranks;
  }

  function pearson(x, y) {
    const n = x.length;
    if (n < 3) return null;
    const mx = x.reduce((a, b) => a + b, 0) / n;
    const my = y.reduce((a, b) => a + b, 0) / n;
    let num = 0;
    let dx = 0;
    let dy = 0;
    for (let i = 0; i < n; i += 1) {
      num += (x[i] - mx) * (y[i] - my);
      dx += (x[i] - mx) ** 2;
      dy += (y[i] - my) ** 2;
    }
    const den = Math.sqrt(dx * dy);
    if (!den) return null;
    return num / den;
  }

  function spearmanIC(records, horizonMonths) {
    const xs = records.map((r) => r.signal);
    const ys = records.map((r) => r.forwardReturn);
    if (xs.length < 6) return { ic: null, t: null };
    const ic = pearson(rankArray(xs), rankArray(ys));
    if (!Number.isFinite(ic)) return { ic: null, t: null };
    const nEff = Math.max(4, xs.length / Math.max(1, horizonMonths));
    const denom = 1 - ic * ic;
    const t = denom > 0 ? ic * Math.sqrt((nEff - 2) / denom) : null;
    return { ic, t };
  }

  function bucketStats(records, k, horizonMonths) {
    const buckets = Array.from({ length: k }, () => []);
    records.forEach((r) => {
      if (!r.bucket) return;
      buckets[r.bucket - 1].push(r.forwardReturn);
    });
    return buckets.map((vals) => {
      if (!vals.length) {
        return { count: 0, avg: null, med: null, hitRate: null, best: null, worst: null, tStat: null };
      }
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      return {
        count: vals.length,
        avg,
        med: median(vals),
        hitRate: vals.filter((v) => v > 0).length / vals.length,
        best: Math.max(...vals),
        worst: Math.min(...vals),
        tStat: bucketTStat(vals, horizonMonths),
      };
    });
  }

  /* ---------------------------------------------------------------------
   * Public surface
   * --------------------------------------------------------------------- */
  return {
    // constants
    RANGE_VALUES,
    HORIZON_OPTIONS,
    TOLERANCE_MS,
    PIT_MIN_OBS,
    GUARDRAIL_WARN_SERIES,
    GUARDRAIL_BLOCK_SERIES,
    GUARDRAIL_WARN_POINTS,
    GUARDRAIL_BLOCK_POINTS,
    HEATMAP_BANDS,
    // loaders / indexes
    loadData: () => window.__t2DataPromise,
    buildIndexes,
    getSeriesKey,
    getCrossCountryKey,
    ensureCrossCountry,
    getSeries,
    getCountriesForFactor,
    nearestPoint,
    // signals
    percentileVsCrossCountry,
    buildExpandingZScoreSeries,
    // bucketing + stats
    thresholdsFromSorted,
    assignBucket,
    assignBucketsToRecords,
    bucketTStat,
    rankArray,
    pearson,
    spearmanIC,
    bucketStats,
    // helpers
    normalizeToken,
    normalizeSheetName,
    sortText,
    parseDateMs,
    addMonthsMs,
    getRangeStartMs,
    formatPct,
    formatNum,
    median,
    quantile,
  };
})();
