/*
=============================================================================
FILE: triptych.js
=============================================================================

DESCRIPTION:
Frontend logic for the Triptych Deep-Dive tab. Loads the columnar v2
dataset, builds per-series indexes, and renders:
  - Top panel:    factor signal (raw / expanding z / cross-sectional z)
  - Middle panel: cumulative return (absolute or relative vs all-country
                  average), rebased at the start of the selected window
  - Bottom panel: average forward return by signal bucket
  - Snapshot:     every market's current bucket vs its own history
  - Tables:       bucket statistics (with overlap-adjusted t-stats and IC)
                  and a bucket x horizon matrix
Bucket thresholds support two modes: full-sample (descriptive, has
look-ahead) and point-in-time (expanding thresholds, no look-ahead).
Also manages the data-vintage chip, the Refresh Data flow against
/api/status + /api/refresh, and xlsx/PDF exports.

INPUT FILES (fetched over HTTP at runtime):
- /Users/arjundivecha/Dropbox/AAA Backup/A Working/Triptych/app/data/t2_master.json
- /api/status, /api/refresh (scripts/serve_triptych.py endpoints)

OUTPUT FILES:
- None on disk. Generates browser downloads on demand:
  "Triptych <country> <factor>.xlsx" and "Triptych <country> <factor>.pdf".
=============================================================================
*/

(() => {
const C = window.T2Core;
if (!C) throw new Error("core.js failed to load — required before triptych.js");

// Constants that are Deep-Dive-specific (normalization labels, bucket words)
// live here. Shared constants (ranges, horizons, tolerance, PIT warm-up,
// heatmap bands, guardrails) come from T2Core so they stop being magic
// numbers duplicated across files.
const NORMALIZATION_OPTIONS = [
  { value: "raw", label: "Raw" },
  { value: "history_z", label: "Z-Score vs own history" },
  { value: "cross_var_pct", label: "Cross-Sectional" },
];
const RETURN_MODE_OPTIONS = [
  { value: "absolute", label: "Absolute Return" },
  { value: "relative", label: "Relative Return" },
];
const DECILE_MODE_OPTIONS = [
  { value: "full", label: "Full-sample (descriptive)" },
  { value: "pit", label: "Point-in-time (no look-ahead)" },
];
const BUCKET_COUNT_OPTIONS = [
  { value: "10", label: "Deciles (10)" },
  { value: "5", label: "Quintiles (5)" },
  { value: "3", label: "Terciles (3)" },
];
const BUCKET_WORD = { 10: "Decile", 5: "Quintile", 3: "Tercile" };
const RETURN_SHEET_ALIASES = ["tot return index", "total return index", "tot return", "total return"];

// Refresh polling guardrail (previously unbounded — polled every 1s forever
// if refresh_running never cleared). Cap attempts then surface a clear error.
const REFRESH_POLL_INTERVAL_MS = 1000;
const REFRESH_POLL_MAX_ATTEMPTS = 120; // ~2 minutes

const COLORS = {
  signal: "#0f7e63",
  cumulative: "#114f88",
  barGood: "rgba(24, 116, 63, 0.68)",
  barBad: "rgba(160, 60, 45, 0.68)",
  barGoodBorder: "#18743f",
  barBadBorder: "#a03c2d",
  barNeutral: "rgba(110, 110, 110, 0.2)",
  barNeutralBorder: "rgba(110, 110, 110, 0.6)",
  highlight: "#f5a623",
  snapshot: "rgba(17, 79, 136, 0.55)",
  snapshotBorder: "#114f88",
  crosshair: "rgba(16, 36, 30, 0.35)",
  grid: "rgba(16, 36, 30, 0.08)",
  gridZero: "rgba(16, 36, 30, 0.3)",
};

const dom = {
  banner: document.getElementById("banner"),
  factorInput: document.getElementById("factorInput"),
  factorList: document.getElementById("factorList"),
  countryInput: document.getElementById("countryInput"),
  countryList: document.getElementById("countryList"),
  normalizationSelect: document.getElementById("normalizationSelect"),
  returnModeSelect: document.getElementById("returnModeSelect"),
  horizonSelect: document.getElementById("horizonSelect"),
  decileModeSelect: document.getElementById("decileModeSelect"),
  bucketCountSelect: document.getElementById("bucketCountSelect"),
  rangeButtons: Array.from(document.querySelectorAll(".tripRangeBtn")),
  statCards: document.getElementById("statCards"),
  summary: document.getElementById("tripSummary"),
  topTitle: document.getElementById("topTitle"),
  midTitle: document.getElementById("midTitle"),
  bottomTitle: document.getElementById("bottomTitle"),
  snapshotTitle: document.getElementById("snapshotTitle"),
  decileTableTitle: document.getElementById("decileTableTitle"),
  matrixTitle: document.getElementById("matrixTitle"),
  decileTableBody: document.querySelector("#decileTable tbody"),
  horizonMatrix: document.getElementById("horizonMatrix"),
  topCanvas: document.getElementById("topChart"),
  middleCanvas: document.getElementById("middleChart"),
  bottomCanvas: document.getElementById("bottomChart"),
  snapshotCanvas: document.getElementById("snapshotChart"),
  dataVintage: document.getElementById("dataVintage"),
  refreshBtn: document.getElementById("refreshBtn"),
  exportXlsxBtn: document.getElementById("exportXlsxBtn"),
  exportPdfBtn: document.getElementById("exportPdfBtn"),
};

let workbook;
// Shared index structures (built once via T2Core.buildIndexes, reused by the
// Visualizer tab through T2Core.indexes). Replacing the per-tab caches with
// a single shared set roughly halves memory for the index layer.
let indexes = null;
let allSheets = [];
let dateDomain = { min: null, max: null };
let lastComputed = null;
let lastMatrix = null;
// Memoization caches for the two expensive recomputations that render() used
// to re-run on every interaction (horizon matrix + cross-market snapshot).
let matrixMemo = null;
let snapshotMemo = null;
let factorCombo = null;
let countryCombo = null;

const charts = { top: null, middle: null, bottom: null, snapshot: null };

const state = {
  factorSheet: "",
  country: "",
  normalization: "raw",
  returnMode: "absolute",
  horizonMonths: 12,
  range: "all",
  decileMode: "full",
  bucketCount: 10,
};

/* ----------------------------------------------------------------------
 * Shared dataset loader lives in core.js (T2Core.loadData / window.__t2DataPromise)
 * so the JSON is fetched once and shared with app.js.
 * ---------------------------------------------------------------------- */

function setBanner(message = "", warn = false) {
  dom.banner.textContent = message;
  dom.banner.classList.toggle("show", Boolean(message));
  if (warn) dom.banner.classList.add("warn");
  else dom.banner.classList.remove("warn");
  // Keep a CSS variable in sync with the banner height so the sticky sidebar
  // never slides under the sticky banner (previously top:14px overlapped the
  // ~42px banner). The sidebar reads --banner-h via its top offset.
  const h = message ? 42 : 0;
  document.documentElement.style.setProperty("--banner-h", `${h}px`);
}

/* ----------------------------------------------------------------------
 * Utilities — shared ones delegate to T2Core. Local aliases keep the rest of
 * this file readable. normalizeToken now comes from core (one canonical,
 * slash-collapsing version — previously divergent between the two tabs).
 * ---------------------------------------------------------------------- */
const getSeriesKey = C.getSeriesKey;
const getCrossCountryKey = C.getCrossCountryKey;
const sortText = C.sortText;
const normalizeSheetName = C.normalizeSheetName;
const normalizeToken = C.normalizeToken;
const parseDateMs = C.parseDateMs;
const addMonthsMs = C.addMonthsMs;
const formatPct = C.formatPct;
const formatNum = C.formatNum;
const median = C.median;
const quantile = C.quantile;
const binaryInsert = C.binaryInsert;

function chooseReturnSheet() {
  const normalizedToActual = new Map(allSheets.map((sheet) => [normalizeSheetName(sheet), sheet]));
  for (const alias of RETURN_SHEET_ALIASES) {
    const exact = normalizedToActual.get(alias);
    if (exact) return exact;
  }
  const heuristic = allSheets.find((sheet) => /\btot(?:al)?\s*return\s*index\b/i.test(sheet));
  if (heuristic) return heuristic;
  const fallback = allSheets.find((sheet) => /\breturn\b/i.test(sheet) && /\bindex\b/i.test(sheet));
  return fallback || "";
}

function formatSignal(v) {
  if (!Number.isFinite(v)) return "-";
  if (state.normalization === "raw") return formatNum(v, 2);
  return `${v.toFixed(2)}σ`;
}

/* ----------------------------------------------------------------------
 * Index building — delegates to T2Core so the index layer is shared with
 * the Visualizer tab (one set of caches in memory, not two). The lazy
 * crossCountryCache is built on first cross-country request via
 * T2Core.ensureCrossCountry.
 * ---------------------------------------------------------------------- */
function buildIndexes() {
  // Build (or reuse) a single shared index set on T2Core.
  indexes = C.indexes || (C.indexes = C.buildIndexes(workbook));
  allSheets = indexes.allSheets;
  dateDomain = indexes.dateDomain;
}

function getSeries(sheet, country) {
  return C.getSeries(indexes, sheet, country);
}

/* Nearest-point lookup within TOLERANCE_MS (handles month-end vs month-start grids). */
function nearestPoint(sheet, country, targetMs) {
  return C.nearestPoint(indexes, sheet, country, targetMs);
}

function getCountriesForFactor(sheet) {
  return C.getCountriesForFactor(indexes, sheet);
}

/* ----------------------------------------------------------------------
 * Signal construction — shared with app.js via T2Core.
 * percentileVsCrossCountry now uses the lazy crossCountryCache
 * (T2Core.ensureCrossCountry) instead of the old eagerly-built map.
 * --------------------------------------------------------------------- */
function percentileVsCrossCountry(sheet, country, date, value) {
  return C.percentileVsCrossCountry(indexes, sheet, country, date, value);
}

const buildExpandingZScoreSeries = C.buildExpandingZScoreSeries;

function buildSignalSeriesFor(sheet, country, rawSeries, startMs) {
  // Filter to range for expanding z-score computation so the Welford
  // accumulator resets at the range boundary. Without this, a "1Y" range
  // would display z-scores measured against the full 20-year history.
  const seriesForNormalization = (state.normalization === "history_z" && startMs)
    ? rawSeries.filter((p) => p.ms >= startMs)
    : rawSeries;
  if (state.normalization === "history_z") {
    return buildExpandingZScoreSeries(seriesForNormalization);
  }
  if (state.normalization === "cross_var_pct") {
    return seriesForNormalization
      .map((p) => ({ ...p, signal: percentileVsCrossCountry(sheet, country, p.date, p.value) }))
      .filter((p) => Number.isFinite(p.signal));
  }
  return seriesForNormalization.map((p) => ({ ...p, signal: p.value }));
}

/* ----------------------------------------------------------------------
 * Bucketing + statistics — shared with app.js via T2Core.
 * --------------------------------------------------------------------- */
const thresholdsFromSorted = C.thresholdsFromSorted;
const assignBucket = C.assignBucket;
const assignBucketsToRecords = C.assignBucketsToRecords;
const bucketTStat = C.bucketTStat;
const rankArray = C.rankArray;
const pearson = C.pearson;
const spearmanIC = C.spearmanIC;
const bucketStats = C.bucketStats;

/* ----------------------------------------------------------------------
 * Cumulative return series (rebased at the start of the visible window)
 * ---------------------------------------------------------------------- */
function buildCumulativeSeries(levelSeries, startMs) {
  const pts = levelSeries
    .filter((p) => Number.isFinite(p.value))
    .filter((p) => (startMs ? p.ms >= startMs : true));
  if (!pts.length) return { points: [], mode: "return" };

  const firstNonZero = pts.find((p) => p.value !== 0);
  if (!firstNonZero) return { points: [], mode: "return" };

  const mode = firstNonZero.value > 0 ? "return" : "change";
  const points = pts
    .map((p) => {
      if (mode === "return") return { x: p.ms, y: p.value / firstNonZero.value - 1 };
      return { x: p.ms, y: p.value - firstNonZero.value };
    })
    .filter((p) => Number.isFinite(p.y));
  return { points, mode };
}

function buildMonthlyReturnSeries(levelSeries) {
  if (!levelSeries.length) return [];
  const ordered = levelSeries.slice().sort((a, b) => a.ms - b.ms);
  const returns = [];
  let prev = null;
  for (const p of ordered) {
    if (!Number.isFinite(p.value)) continue;
    if (prev && Number.isFinite(prev.value) && prev.value !== 0) {
      const monthlyReturn = p.value / prev.value - 1;
      if (Number.isFinite(monthlyReturn)) {
        returns.push({ date: p.date, ms: p.ms, value: monthlyReturn });
      }
    }
    prev = p;
  }
  return returns;
}

function buildRelativeCumulativeSeries(returnSheet, country, startMs) {
  if (!returnSheet || !country) return { points: [], mode: "return" };
  const countries = getCountriesForFactor(returnSheet);
  if (!countries.length) return { points: [], mode: "return" };

  const avgByDate = new Map();
  let ownMonthlyReturns = [];

  for (const c of countries) {
    const monthly = buildMonthlyReturnSeries(getSeries(returnSheet, c));
    if (c === country) ownMonthlyReturns = monthly;
    for (const p of monthly) {
      if (!avgByDate.has(p.date)) avgByDate.set(p.date, { ms: p.ms, sum: 0, count: 0 });
      const agg = avgByDate.get(p.date);
      agg.sum += p.value;
      agg.count += 1;
    }
  }
  if (!ownMonthlyReturns.length) return { points: [], mode: "return" };

  let ownWealth = 1;
  let benchmarkWealth = 1;
  const points = [];
  for (const p of ownMonthlyReturns) {
    if (startMs && p.ms < startMs) continue; // rebase: only accrue inside the window
    const agg = avgByDate.get(p.date);
    if (!agg || agg.count === 0) continue;
    const avgMonthlyReturn = agg.sum / agg.count;
    if (!Number.isFinite(avgMonthlyReturn)) continue;
    ownWealth *= 1 + p.value;
    benchmarkWealth *= 1 + avgMonthlyReturn;
    if (!Number.isFinite(ownWealth) || !Number.isFinite(benchmarkWealth) || benchmarkWealth === 0) continue;
    points.push({ x: p.ms, y: ownWealth / benchmarkWealth - 1 });
  }
  return { points, mode: "return" };
}

/* ----------------------------------------------------------------------
 * Forward-return records
 * ---------------------------------------------------------------------- */
function buildForwardRecords(signalSeries, returnSheet, horizonMonths, relative) {
  if (!returnSheet) return [];
  const countries = relative ? getCountriesForFactor(returnSheet) : null;

  const records = [];
  for (const p of signalSeries) {
    if (!Number.isFinite(p.signal)) continue;

    const basePoint = nearestPoint(returnSheet, state.country, p.ms);
    if (!basePoint || !Number.isFinite(basePoint.value) || basePoint.value === 0) continue;
    const targetMs = addMonthsMs(p.ms, horizonMonths);
    const targetPoint = nearestPoint(returnSheet, state.country, targetMs);
    if (!targetPoint || !Number.isFinite(targetPoint.value)) continue;
    if (targetPoint.ms <= basePoint.ms) continue;

    let forwardReturn = targetPoint.value / basePoint.value - 1;

    if (relative) {
      let sum = 0;
      let count = 0;
      for (const c of countries) {
        const cBase = nearestPoint(returnSheet, c, p.ms);
        if (!cBase || !Number.isFinite(cBase.value) || cBase.value === 0) continue;
        const cTarget = nearestPoint(returnSheet, c, targetMs);
        if (!cTarget || !Number.isFinite(cTarget.value)) continue;
        if (cTarget.ms <= cBase.ms) continue;
        sum += cTarget.value / cBase.value - 1;
        count += 1;
      }
      if (count > 0) forwardReturn -= sum / count;
    }

    records.push({ date: p.date, ms: p.ms, signal: p.signal, forwardReturn });
  }
  return records;
}

/* ----------------------------------------------------------------------
 * Range helpers — getRangeStartMs is shared via T2Core.
 * --------------------------------------------------------------------- */
const getRangeStartMs = C.getRangeStartMs;

function getNormalizationLabel(mode) {
  return NORMALIZATION_OPTIONS.find((x) => x.value === mode)?.label || mode;
}

/* ----------------------------------------------------------------------
 * Main computation
 * ---------------------------------------------------------------------- */
function computeTriptych() {
  const k = state.bucketCount;
  const factorSeries = getSeries(state.factorSheet, state.country);
  const returnSheet = chooseReturnSheet();
  const returnSeries = returnSheet ? getSeries(returnSheet, state.country) : [];
  const startMs = getRangeStartMs(dateDomain.max, state.range);
  const relative = state.returnMode === "relative";

  const empty = {
    topPoints: [],
    middlePoints: [],
    bottomStats: Array.from({ length: k }, () => ({ count: 0, avg: null, med: null, hitRate: null, best: null, worst: null, tStat: null })),
    currentBucket: null,
    latestSignal: null,
    ic: { ic: null, t: null },
    startMs,
    sampleSize: 0,
    cumulativeMode: "return",
    normalizationLabel: getNormalizationLabel(state.normalization),
    returnSheet,
    hasReturnSeries: returnSeries.length > 0,
    signalSeries: [],
    rangedRecords: [],
  };
  if (!factorSeries.length) return empty;

  const signalSeries = buildSignalSeriesFor(state.factorSheet, state.country, factorSeries, startMs);
  if (!signalSeries.length) return empty;

  const { points: middlePoints, mode: cumulativeMode } = relative
    ? buildRelativeCumulativeSeries(returnSheet, state.country, startMs)
    : buildCumulativeSeries(returnSeries, startMs);

  const forwardRecords = buildForwardRecords(signalSeries, returnSheet, state.horizonMonths, relative);
  const { records: bucketed, finalThresholds } = assignBucketsToRecords(
    forwardRecords,
    state.decileMode,
    k
  );

  const inRange = (ms) => (startMs ? ms >= startMs : true);
  const rangedRecords = bucketed.filter((r) => inRange(r.ms) && r.bucket);

  const bottomStats = bucketStats(rangedRecords, k, state.horizonMonths);
  const ic = spearmanIC(rangedRecords, state.horizonMonths);

  const topPoints = signalSeries.filter((p) => inRange(p.ms)).map((p) => ({ x: p.ms, y: p.signal }));

  let currentBucket = null;
  let latestSignal = null;
  const finiteSignals = signalSeries.filter((p) => Number.isFinite(p.signal));
  if (finiteSignals.length && finalThresholds.length) {
    latestSignal = finiteSignals[finiteSignals.length - 1];
    currentBucket = assignBucket(latestSignal.signal, finalThresholds);
  }

  return {
    topPoints,
    middlePoints,
    bottomStats,
    currentBucket,
    latestSignal,
    ic,
    startMs,
    sampleSize: rangedRecords.length,
    cumulativeMode,
    normalizationLabel: getNormalizationLabel(state.normalization),
    returnSheet,
    hasReturnSeries: returnSeries.length > 0,
    signalSeries,
    rangedRecords,
  };
}

/* Per-horizon stats for the bucket x horizon matrix.
 * Memoized: the matrix only depends on (factorSheet, normalization,
 * returnMode, decileMode, bucketCount, range) — not on the selected horizon
 * or country. Previously render() recomputed it (6 horizons x per-record
 * country loops in relative mode) on every interaction, including ones that
 * don't affect it. */
function computeHorizonMatrix(signalSeries, returnSheet, startMs) {
  const key = [
    state.factorSheet,
    state.normalization,
    state.returnMode,
    state.decileMode,
    state.bucketCount,
    state.range,
  ].join("|");
  if (matrixMemo && matrixMemo.key === key) return matrixMemo.value;

  const k = state.bucketCount;
  const relative = state.returnMode === "relative";
  const inRange = (ms) => (startMs ? ms >= startMs : true);

  const value = C.HORIZON_OPTIONS.map((h) => {
    const records = buildForwardRecords(signalSeries, returnSheet, h, relative);
    const { records: bucketed } = assignBucketsToRecords(records, state.decileMode, k);
    const ranged = bucketed.filter((r) => inRange(r.ms) && r.bucket);
    const stats = bucketStats(ranged, k, h);
    const ic = spearmanIC(ranged, h);
    const topAvg = stats[k - 1]?.avg;
    const bottomAvg = stats[0]?.avg;
    const spread = Number.isFinite(topAvg) && Number.isFinite(bottomAvg) ? topAvg - bottomAvg : null;
    return { horizon: h, stats, ic, spread };
  });
  matrixMemo = { key, value };
  return value;
}

/* Snapshot: each market's current bucket vs its own signal history.
 * Memoized on (factorSheet, normalization, bucketCount) — independent of the
 * selected country, range, return mode, horizon, and decile mode. */
function computeSnapshot() {
  const key = [state.factorSheet, state.normalization, state.bucketCount].join("|");
  if (snapshotMemo && snapshotMemo.key === key) return snapshotMemo.value;

  const sheet = state.factorSheet;
  const k = state.bucketCount;
  const rows = [];
  for (const country of getCountriesForFactor(sheet)) {
    const raw = getSeries(sheet, country);
    if (raw.length < 24) continue;
    const sig = buildSignalSeriesFor(sheet, country, raw).filter((p) => Number.isFinite(p.signal));
    if (sig.length < 24) continue;
    const latest = sig[sig.length - 1];
    const sorted = sig.map((p) => p.signal).sort((a, b) => a - b);
    const thresholds = thresholdsFromSorted(sorted, k);
    const bucket = assignBucket(latest.signal, thresholds);
    if (!bucket) continue;
    rows.push({ country, bucket, signal: latest.signal, date: latest.date });
  }
  rows.sort((a, b) => b.bucket - a.bucket || b.signal - a.signal || sortText(a.country, b.country));
  snapshotMemo = { key, value: rows };
  return rows;
}

/* ----------------------------------------------------------------------
 * Charts
 * ---------------------------------------------------------------------- */
const crosshairState = { ms: null, raf: 0 };
const crosshairPlugin = {
  id: "tripCrosshair",
  afterEvent(chart, args) {
    if (chart.isDestroyed) return;
    const ev = args.event;
    let next = crosshairState.ms;
    if (ev.type === "mousemove" && args.inChartArea) {
      next = chart.scales.x.getValueForPixel(ev.x);
    } else if (ev.type === "mouseout") {
      next = null;
    }
    if (next !== crosshairState.ms) {
      crosshairState.ms = next;
      // Coalesce redraws to one per animation frame. Previously every
      // mousemove called .draw() on both charts synchronously — Chart.js
      // discourages manual .draw(), and on dense histories this janks.
      if (!crosshairState.raf) {
        crosshairState.raf = requestAnimationFrame(() => {
          crosshairState.raf = 0;
          if (charts.top && !charts.top.isDestroyed) charts.top.update("none");
          if (charts.middle && !charts.middle.isDestroyed) charts.middle.update("none");
        });
      }
    }
  },
  afterDraw(chart) {
    if (chart.isDestroyed) return;
    const ms = crosshairState.ms;
    if (ms == null) return;
    const area = chart.chartArea;
    if (!area) return;
    const x = chart.scales.x.getPixelForValue(ms);
    if (x < area.left || x > area.right) return;
    const ctx = chart.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = COLORS.crosshair;
    ctx.moveTo(x, area.top);
    ctx.lineTo(x, area.bottom);
    ctx.stroke();
    ctx.restore();
  },
};

function baseChartOptions() {
  return {
    parsing: false,
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    normalized: true,
    interaction: { mode: "nearest", intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        mode: "nearest",
        intersect: false,
        callbacks: {
          title: (items) => {
            if (!items || !items.length) return "";
            const ms = Number(items[0].parsed.x);
            if (!Number.isFinite(ms)) return "";
            return new Date(ms).toISOString().slice(0, 10);
          },
        },
      },
    },
    scales: {
      x: {
        type: "linear",
        grid: { color: COLORS.grid },
        ticks: {
          maxTicksLimit: 10,
          callback: (value) => {
            const ms = Number(value);
            if (!Number.isFinite(ms)) return "";
            return String(new Date(ms).getUTCFullYear());
          },
        },
      },
    },
  };
}

function lineYScale(tickCallback) {
  return {
    grid: {
      color: (ctx) => (ctx.tick && ctx.tick.value === 0 ? COLORS.gridZero : COLORS.grid),
    },
    ticks: { callback: tickCallback },
  };
}

function ensureCharts() {
  if (!window.Chart) throw new Error("Chart.js failed to load");

  if (!charts.top) {
    charts.top = new Chart(dom.topCanvas, {
      type: "line",
      data: { datasets: [] },
      options: {
        ...baseChartOptions(),
        scales: {
          ...baseChartOptions().scales,
          y: lineYScale((v) => formatNum(Number(v), 2)),
        },
      },
      plugins: [crosshairPlugin],
    });
  }

  if (!charts.middle) {
    charts.middle = new Chart(dom.middleCanvas, {
      type: "line",
      data: { datasets: [] },
      options: {
        ...baseChartOptions(),
        scales: {
          ...baseChartOptions().scales,
          y: lineYScale((v) => formatPct(Number(v), 1)),
        },
      },
      plugins: [crosshairPlugin],
    });
  }

  if (!charts.bottom) {
    charts.bottom = new Chart(dom.bottomCanvas, {
      type: "bar",
      data: { labels: [], datasets: [] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: "nearest", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: { mode: "nearest", intersect: false },
        },
        scales: {
          x: {
            type: "category",
            ticks: { font: { size: 13, weight: "bold" }, padding: 6 },
            grid: { display: false },
          },
          y: lineYScale((v) => formatPct(Number(v), 1)),
        },
      },
    });
  }

  if (!charts.snapshot) {
    charts.snapshot = new Chart(dom.snapshotCanvas, {
      type: "bar",
      data: { labels: [], datasets: [] },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: {
          legend: { display: false },
          tooltip: { mode: "nearest", intersect: false },
        },
        scales: {
          x: {
            min: 0,
            grid: { color: COLORS.grid },
            ticks: { stepSize: 1 },
            title: { display: true, text: "Current bucket (vs own history)" },
          },
          y: {
            grid: { display: false },
            ticks: { autoSkip: false, font: { size: 11 } },
          },
        },
      },
    });
  }
}

/* ----------------------------------------------------------------------
 * Rendering
 * ---------------------------------------------------------------------- */
function bucketWord() {
  return BUCKET_WORD[state.bucketCount] || "Bucket";
}

function bucketShort() {
  return { 10: "D", 5: "Q", 3: "T" }[state.bucketCount] || "B";
}

function renderStatCards(computed) {
  const cards = [];
  const k = state.bucketCount;
  const latest = computed.latestSignal;

  cards.push({
    label: "Latest Signal",
    value: latest ? formatSignal(latest.signal) : "-",
    sub: latest ? latest.date : "no data",
  });

  const cb = computed.currentBucket;
  cards.push({
    label: `Current ${bucketWord()}`,
    value: cb ? `${bucketShort()}${cb} of ${k}` : "-",
    sub: cb ? (cb >= k ? "highest signal bucket" : cb <= 1 ? "lowest signal bucket" : "vs own history") : "insufficient history",
    accent: Boolean(cb),
  });

  const bs = cb ? computed.bottomStats[cb - 1] : null;
  cards.push({
    label: `${bucketWord()} Avg Fwd Return`,
    value: bs && Number.isFinite(bs.avg) ? formatPct(bs.avg) : "-",
    sub: `${state.horizonMonths}M forward, in window`,
    tone: bs && Number.isFinite(bs.avg) ? (bs.avg >= 0 ? "good" : "bad") : null,
  });

  cards.push({
    label: `${bucketWord()} Hit Rate`,
    value: bs && Number.isFinite(bs.hitRate) ? `${(bs.hitRate * 100).toFixed(0)}%` : "-",
    sub: bs ? `${bs.count} observations` : "-",
    tone: bs && Number.isFinite(bs.hitRate) ? (bs.hitRate >= 0.5 ? "good" : "bad") : null,
  });

  cards.push({
    label: "IC (Spearman)",
    value: Number.isFinite(computed.ic.ic) ? computed.ic.ic.toFixed(2) : "-",
    sub: Number.isFinite(computed.ic.t) ? `t ≈ ${computed.ic.t.toFixed(1)} (overlap-adj)` : "signal vs fwd return",
    tone: Number.isFinite(computed.ic.ic) ? (Math.abs(computed.ic.ic) >= 0.1 ? (computed.ic.ic > 0 ? "good" : "bad") : null) : null,
  });

  dom.statCards.innerHTML = "";
  cards.forEach((c) => {
    const card = document.createElement("div");
    card.className = "statCard" + (c.accent ? " accent" : "");
    const label = document.createElement("div");
    label.className = "statLabel";
    label.textContent = c.label;
    const value = document.createElement("div");
    value.className = "statValue" + (c.tone ? ` ${c.tone}` : "");
    value.textContent = c.value;
    const sub = document.createElement("div");
    sub.className = "statSub";
    sub.textContent = c.sub;
    card.appendChild(label);
    card.appendChild(value);
    card.appendChild(sub);
    dom.statCards.appendChild(card);
  });
}

function renderDecileTable(computed) {
  const k = state.bucketCount;
  dom.decileTableBody.innerHTML = "";

  computed.bottomStats.forEach((row, idx) => {
    const tr = document.createElement("tr");
    if (computed.currentBucket === idx + 1) tr.className = "currentRow";

    const cells = [
      `${bucketWord()} ${idx + 1}`,
      String(row.count),
      formatPct(row.avg),
      formatPct(row.med),
      row.hitRate === null ? "-" : `${(row.hitRate * 100).toFixed(1)}%`,
      formatPct(row.best),
      formatPct(row.worst),
      Number.isFinite(row.tStat) ? row.tStat.toFixed(2) : "-",
    ];
    cells.forEach((text, i) => {
      const td = document.createElement("td");
      td.textContent = text;
      if (i === 4 && Number.isFinite(row.hitRate)) {
        td.className = row.hitRate >= 0.5 ? "hitGood" : "hitBad";
      }
      tr.appendChild(td);
    });
    dom.decileTableBody.appendChild(tr);
  });

  // Spread row: top bucket minus bottom bucket
  const top = computed.bottomStats[k - 1];
  const bottom = computed.bottomStats[0];
  const tr = document.createElement("tr");
  tr.className = "spreadRow";
  const spread =
    top && bottom && Number.isFinite(top.avg) && Number.isFinite(bottom.avg) ? top.avg - bottom.avg : null;
  const medSpread =
    top && bottom && Number.isFinite(top.med) && Number.isFinite(bottom.med) ? top.med - bottom.med : null;
  const cells = [
    `${bucketShort()}${k} − ${bucketShort()}1 Spread`,
    "",
    formatPct(spread),
    formatPct(medSpread),
    "",
    "",
    "",
    "",
  ];
  cells.forEach((text) => {
    const td = document.createElement("td");
    td.textContent = text;
    tr.appendChild(td);
  });
  dom.decileTableBody.appendChild(tr);
}

function matrixCellClass(v) {
  if (!Number.isFinite(v)) return "mx-na";
  const a = Math.abs(v);
  const b = C.HEATMAP_BANDS;
  const band = a >= b.band3 ? 3 : a >= b.band2 ? 2 : a >= b.band1 ? 1 : 0;
  if (band === 0) return "mx-flat";
  return (v > 0 ? "mx-pos-" : "mx-neg-") + band;
}

function renderHorizonMatrix(matrix) {
  const k = state.bucketCount;
  const table = dom.horizonMatrix;
  table.innerHTML = "";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  const th0 = document.createElement("th");
  th0.textContent = bucketWord();
  headRow.appendChild(th0);
  matrix.forEach((col) => {
    const th = document.createElement("th");
    th.textContent = `${col.horizon}M`;
    if (col.horizon === state.horizonMonths) th.className = "currentCol";
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (let b = 0; b < k; b += 1) {
    const tr = document.createElement("tr");
    const td0 = document.createElement("td");
    td0.textContent = `${bucketShort()}${b + 1}`;
    tr.appendChild(td0);
    matrix.forEach((col) => {
      const td = document.createElement("td");
      const v = col.stats[b]?.avg;
      td.textContent = formatPct(v, 1);
      td.className = matrixCellClass(v);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }

  const trSpread = document.createElement("tr");
  trSpread.className = "spreadRow";
  const tdS = document.createElement("td");
  tdS.textContent = `${bucketShort()}${k}−${bucketShort()}1`;
  trSpread.appendChild(tdS);
  matrix.forEach((col) => {
    const td = document.createElement("td");
    td.textContent = formatPct(col.spread, 1);
    td.className = matrixCellClass(col.spread);
    trSpread.appendChild(td);
  });
  tbody.appendChild(trSpread);

  const trIC = document.createElement("tr");
  trIC.className = "icRow";
  const tdI = document.createElement("td");
  tdI.textContent = "IC";
  trIC.appendChild(tdI);
  matrix.forEach((col) => {
    const td = document.createElement("td");
    td.textContent = Number.isFinite(col.ic.ic) ? col.ic.ic.toFixed(2) : "-";
    trIC.appendChild(td);
  });
  tbody.appendChild(trIC);

  table.appendChild(tbody);
}

function renderSnapshot(rows) {
  const k = state.bucketCount;
  charts.snapshot.data.labels = rows.map((r) => r.country);
  charts.snapshot.data.datasets = [
    {
      data: rows.map((r) => r.bucket),
      backgroundColor: rows.map((r) =>
        r.country === state.country ? COLORS.highlight : COLORS.snapshot
      ),
      borderColor: rows.map((r) =>
        r.country === state.country ? COLORS.highlight : COLORS.snapshotBorder
      ),
      borderWidth: 1,
      barPercentage: 0.8,
      categoryPercentage: 0.85,
    },
  ];
  charts.snapshot.options.scales.x.max = k;
  charts.snapshot.options.plugins.tooltip.callbacks = {
    label: (ctx) => {
      const row = rows[ctx.dataIndex];
      if (!row) return "";
      return `${bucketWord()} ${row.bucket} of ${k} | signal ${formatSignal(row.signal)} | ${row.date}`;
    },
  };
  // Size the canvas wrap so ~34 markets stay readable.
  const wrap = dom.snapshotCanvas.parentElement;
  wrap.style.height = `${Math.max(220, rows.length * 17 + 60)}px`;
  charts.snapshot.update();

  // Mirror the snapshot into a visually-hidden data table so the bar chart
  // (which encodes ~34 markets' current buckets) has a non-visual equivalent.
  const tbl = document.getElementById("snapshotDataTable");
  if (tbl) {
    const tb = tbl.querySelector("tbody");
    tb.innerHTML = "";
    rows.forEach((r) => {
      const tr = document.createElement("tr");
      const mkCell = (text) => { const td = document.createElement("td"); td.textContent = text; return td; };
      tr.appendChild(mkCell(r.country));
      tr.appendChild(mkCell(`${bucketWord()} ${r.bucket} of ${k}`));
      tr.appendChild(mkCell(formatSignal(r.signal)));
      tr.appendChild(mkCell(r.date));
      tb.appendChild(tr);
    });
  }
}

function render() {
  syncRangeButtons();

  const computed = computeTriptych();
  lastComputed = computed;

  const topLabel = `${state.country} - ${state.factorSheet}`;
  const middleLabel =
    state.returnMode === "relative"
      ? `${state.country} relative cumulative return`
      : `${state.country} cumulative return`;

  dom.topTitle.textContent = `${topLabel} (${computed.normalizationLabel})`;
  if (state.returnMode === "relative") {
    dom.midTitle.textContent = computed.returnSheet
      ? `Relative Cumulative Return: ${state.country} vs all-country average (${computed.returnSheet.trim()})`
      : `Relative Cumulative Return: ${state.country} vs all-country average`;
  } else {
    dom.midTitle.textContent = computed.returnSheet
      ? `Cumulative Return: ${state.country} (${computed.returnSheet.trim()})`
      : `Cumulative Return: ${state.country}`;
  }
  dom.bottomTitle.textContent = `${state.horizonMonths}M Forward Return by ${bucketWord()} (${
    state.decileMode === "pit" ? "point-in-time" : "full-sample"
  } thresholds)`;
  dom.snapshotTitle.textContent = `Cross-Market Snapshot: current ${bucketWord().toLowerCase()} of ${
    state.factorSheet
  } vs each market's own history`;
  dom.decileTableTitle.textContent = `${bucketWord()} Statistics (${state.horizonMonths}M forward)`;
  dom.matrixTitle.textContent = `Avg Forward Return: ${bucketWord()} × Horizon`;

  dom.summary.textContent = "";
  // Summary as scannable chips instead of a pipe-delimited line.
  const chips = [
    { k: "Country", v: state.country || "-" },
    { k: "Factor", v: state.factorSheet || "-" },
    { k: "Return", v: `${state.returnMode === "relative" ? "Relative" : "Absolute"} (${computed.returnSheet ? computed.returnSheet.trim() : "-"})` },
    { k: "Normalization", v: computed.normalizationLabel },
    { k: "Thresholds", v: state.decileMode === "pit" ? "Point-in-time" : "Full-sample" },
    { k: "Sample", v: String(computed.sampleSize) },
    { k: "Range", v: state.range.toUpperCase() },
  ];
  chips.forEach(({ k, v }) => {
    const chip = document.createElement("span");
    chip.className = "summary-chip";
    const lab = document.createElement("span");
    lab.className = "summary-chip-k";
    lab.textContent = k;
    const val = document.createElement("span");
    val.className = "summary-chip-v";
    val.textContent = v;
    chip.appendChild(lab);
    chip.appendChild(val);
    dom.summary.appendChild(chip);
  });

  ensureCharts();

  /* Shared x-domain so the top and middle panels align vertically. */
  const firstTop = computed.topPoints.length ? computed.topPoints[0].x : null;
  const firstMid = computed.middlePoints.length ? computed.middlePoints[0].x : null;
  const lastTop = computed.topPoints.length ? computed.topPoints[computed.topPoints.length - 1].x : null;
  const lastMid = computed.middlePoints.length ? computed.middlePoints[computed.middlePoints.length - 1].x : null;
  const sharedXMin =
    computed.startMs ||
    (firstTop !== null && firstMid !== null ? Math.min(firstTop, firstMid) : firstTop ?? firstMid ?? undefined);
  const sharedXMax =
    lastTop !== null && lastMid !== null ? Math.max(lastTop, lastMid) : lastTop ?? lastMid ?? dateDomain.max ?? undefined;

  charts.top.options.scales.x.min = sharedXMin;
  charts.top.options.scales.x.max = sharedXMax;
  charts.middle.options.scales.x.min = sharedXMin;
  charts.middle.options.scales.x.max = sharedXMax;

  /* Correct tick formats: sigma for normalized signals, numbers for raw. */
  if (state.normalization === "raw") {
    charts.top.options.scales.y.ticks.callback = (v) => formatNum(Number(v), 2);
  } else {
    charts.top.options.scales.y.ticks.callback = (v) => `${Number(v).toFixed(1)}σ`;
  }

  charts.middle.options.scales.y.ticks.callback =
    computed.cumulativeMode === "return" ? (v) => formatPct(Number(v), 1) : (v) => formatNum(Number(v), 2);

  charts.top.options.plugins.tooltip.callbacks.label = (ctx) => {
    const val = Number(ctx.parsed.y);
    if (state.normalization === "raw") {
      return `${topLabel}: ${val.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
    }
    return `${topLabel}: ${val.toFixed(2)}σ`;
  };

  charts.middle.options.plugins.tooltip.callbacks.label = (ctx) => {
    const val = Number(ctx.parsed.y);
    if (computed.cumulativeMode === "return") return `${middleLabel}: ${formatPct(val, 2)}`;
    return `Cumulative change: ${formatNum(val, 4)}`;
  };

  charts.bottom.options.plugins.tooltip.callbacks.label = (ctx) => {
    const val = Number(ctx.parsed.y);
    const stat = computed.bottomStats[ctx.dataIndex];
    const obsText = stat && Number.isFinite(stat.count) ? ` (${stat.count} obs)` : "";
    return `Avg ${state.horizonMonths}M forward return: ${formatPct(val, 2)}${obsText}`;
  };
  charts.bottom.options.plugins.tooltip.callbacks.title = (items) => {
    if (!items || !items.length) return "";
    return `${bucketWord()} ${items[0].dataIndex + 1}`;
  };

  charts.top.data.datasets = [
    {
      label: topLabel,
      data: computed.topPoints,
      borderColor: COLORS.signal,
      backgroundColor: COLORS.signal,
      pointRadius: 0,
      pointHoverRadius: 3,
      borderWidth: 2,
      tension: 0.1,
      fill: false,
    },
  ];

  charts.middle.data.datasets = [
    {
      label: middleLabel,
      data: computed.middlePoints,
      borderColor: COLORS.cumulative,
      backgroundColor: COLORS.cumulative,
      pointRadius: 0,
      pointHoverRadius: 3,
      borderWidth: 2,
      tension: 0.14,
      fill: false,
    },
  ];

  const cb = computed.currentBucket;
  const k = state.bucketCount;
  charts.bottom.data.labels = Array.from({ length: k }, (_, i) => String(i + 1));
  charts.bottom.data.datasets = [
    {
      label: `Avg ${state.horizonMonths}M forward return`,
      data: computed.bottomStats.map((s) => s.avg),
      backgroundColor: computed.bottomStats.map((s) => {
        if (!Number.isFinite(s.avg)) return COLORS.barNeutral;
        return s.avg >= 0 ? COLORS.barGood : COLORS.barBad;
      }),
      borderColor: computed.bottomStats.map((s, i) => {
        if (cb && i + 1 === cb) return COLORS.highlight;
        if (!Number.isFinite(s.avg)) return COLORS.barNeutralBorder;
        return s.avg >= 0 ? COLORS.barGoodBorder : COLORS.barBadBorder;
      }),
      borderWidth: computed.bottomStats.map((_s, i) => (cb && i + 1 === cb ? 3 : 1)),
      barPercentage: 0.85,
      categoryPercentage: 0.9,
    },
  ];

  charts.top.update();
  charts.middle.update();
  charts.bottom.update();

  // First successful render: dismiss the loading skeletons.
  document.querySelectorAll(".chartSkeleton").forEach((sk) => sk.classList.add("is-loaded"));

  renderStatCards(computed);
  renderDecileTable(computed);

  const matrix = computeHorizonMatrix(computed.signalSeries, computed.returnSheet, computed.startMs);
  lastMatrix = matrix;
  renderHorizonMatrix(matrix);

  renderSnapshot(computeSnapshot());

  if (!computed.returnSheet) {
    setBanner("No return-index sheet found (expected a sheet like 'Tot Return Index').", true);
  } else if (!computed.hasReturnSeries) {
    setBanner(`No return series available for ${state.country} in ${computed.returnSheet.trim()}.`, true);
  } else if (computed.sampleSize === 0) {
    setBanner(
      state.decileMode === "pit"
        ? "No bucketed sample in this window (point-in-time mode needs 36 months of warm-up history)."
        : "No forward-return sample found for this variable and horizon.",
      true
    );
  } else if (computed.sampleSize < state.bucketCount * 3) {
    setBanner(
      `Small sample (${computed.sampleSize} obs for ${state.bucketCount} buckets) — consider fewer buckets or a longer window.`,
      true
    );
  } else {
    setBanner("");
  }

  persistState();
}

/* ----------------------------------------------------------------------
 * State persistence (URL params are namespaced t* to avoid colliding
 * with the Visualizer tab's v* params)
 * ---------------------------------------------------------------------- */
function hydrateFromUrl() {
  const p = new URLSearchParams(window.location.search);
  return {
    factor: p.get("tf"),
    country: p.get("tc"),
    normalization: p.get("tn"),
    returnMode: p.get("tm"),
    horizon: Number(p.get("th")),
    range: p.get("tr"),
    decileMode: p.get("td"),
    bucketCount: Number(p.get("tb")),
  };
}

function hydrateFromStorage() {
  return null;
}

function applyHydrated(payload) {
  if (!payload) return;
  if (payload.factor && allSheets.includes(payload.factor)) state.factorSheet = payload.factor;
  if (payload.normalization && NORMALIZATION_OPTIONS.some((x) => x.value === payload.normalization)) {
    state.normalization = payload.normalization;
  }
  if (payload.returnMode && RETURN_MODE_OPTIONS.some((x) => x.value === payload.returnMode)) {
    state.returnMode = payload.returnMode;
  }
  if (C.HORIZON_OPTIONS.includes(payload.horizon)) state.horizonMonths = payload.horizon;
  if (payload.range && C.RANGE_VALUES.has(payload.range)) state.range = payload.range;
  if (payload.decileMode && DECILE_MODE_OPTIONS.some((x) => x.value === payload.decileMode)) {
    state.decileMode = payload.decileMode;
  }
  if ([10, 5, 3].includes(payload.bucketCount)) state.bucketCount = payload.bucketCount;
  if (typeof payload.country === "string") state.country = payload.country;
}

function persistState() {
  if (!document.getElementById("tabTriptych").classList.contains("active")) return;
  const payload = {
    factor: state.factorSheet,
    country: state.country,
    normalization: state.normalization,
    returnMode: state.returnMode,
    horizon: state.horizonMonths,
    range: state.range,
    decileMode: state.decileMode,
    bucketCount: state.bucketCount,
  };
  const params = new URLSearchParams();
  params.set("tab", "triptych");
  params.set("tf", state.factorSheet);
  params.set("tc", state.country);
  params.set("tn", state.normalization);
  params.set("tm", state.returnMode);
  params.set("th", String(state.horizonMonths));
  params.set("tr", state.range);
  params.set("td", state.decileMode);
  params.set("tb", String(state.bucketCount));
  window.history.replaceState({}, "", `${window.location.pathname}?${params.toString()}`);
}

/* ----------------------------------------------------------------------
 * Controls
 * ---------------------------------------------------------------------- */
function chooseDefaultFactor() {
  return allSheets.includes("REER") ? "REER" : allSheets[0] || "";
}

function chooseDefaultCountry() {
  const countries = getCountriesForFactor(state.factorSheet);
  if (!countries.length) return "";
  if (countries.includes("India")) return "India";
  return countries[0];
}

function buildSelectOptions(selectEl, options, selectedValue) {
  selectEl.innerHTML = "";
  options.forEach((opt) => {
    const el = document.createElement("option");
    el.value = opt.value;
    el.textContent = opt.label;
    el.selected = el.value === String(selectedValue);
    selectEl.appendChild(el);
  });
}

function syncRangeButtons() {
  dom.rangeButtons.forEach((btn) => {
    const isActive = btn.dataset.range === state.range;
    btn.classList.toggle("active", isActive);
    // Expose the toggle state to assistive tech (not just the visual .active).
    btn.setAttribute("aria-pressed", String(isActive));
  });
}

function syncStaticControls() {
  buildSelectOptions(dom.normalizationSelect, NORMALIZATION_OPTIONS, state.normalization);
  buildSelectOptions(dom.returnModeSelect, RETURN_MODE_OPTIONS, state.returnMode);
  buildSelectOptions(
    dom.horizonSelect,
    C.HORIZON_OPTIONS.map((h) => ({ value: String(h), label: `${h} months` })),
    String(state.horizonMonths)
  );
  buildSelectOptions(dom.decileModeSelect, DECILE_MODE_OPTIONS, state.decileMode);
  buildSelectOptions(dom.bucketCountSelect, BUCKET_COUNT_OPTIONS, String(state.bucketCount));
}

function ensureValidCountry() {
  const countries = getCountriesForFactor(state.factorSheet);
  if (!countries.includes(state.country)) {
    state.country = countries.includes("India") ? "India" : countries[0] || "";
  }
}

/* Searchable combobox (factor and country pickers). */
/* Searchable combobox implementing the WAI-ARIA combobox + listbox pattern.
 * Previously this was a plain <input> + <div> with no ARIA and only
 * Enter/Escape handling — keyboard users couldn't move through the list.
 * Adds: role=combobox/listbox/option, aria-expanded, aria-controls,
 * aria-activedescendant, aria-selected, and Up/Down/Home/End/Enter/Escape. */
function setupCombobox({ input, list, getOptions, getCurrent, onSelect }) {
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  list.id = list.id || `cb-list-${Math.random().toString(36).slice(2, 9)}`;
  input.setAttribute("aria-controls", list.id);
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", input.getAttribute("aria-label") || input.previousElementSibling?.textContent || "Options");

  let activeIndex = -1;
  let currentOptions = [];

  function renderList(filterText) {
    const term = normalizeToken(filterText || "");
    const opts = getOptions();
    currentOptions = term ? opts.filter((o) => normalizeToken(o).includes(term)) : opts;
    list.innerHTML = "";
    const current = getCurrent();
    activeIndex = currentOptions.indexOf(current);
    if (activeIndex < 0 && currentOptions.length) activeIndex = 0;

    currentOptions.forEach((opt, i) => {
      const div = document.createElement("div");
      div.className = "comboOption" + (opt === current ? " selected" : "");
      div.setAttribute("role", "option");
      div.setAttribute("aria-selected", String(opt === current));
      div.id = `${list.id}-opt-${i}`;
      div.textContent = opt;
      div.addEventListener("mousedown", (e) => {
        e.preventDefault();
        choose(opt);
      });
      list.appendChild(div);
    });
    if (!currentOptions.length) {
      const d = document.createElement("div");
      d.className = "comboEmpty";
      d.setAttribute("role", "status");
      d.textContent = "No matches";
      list.appendChild(d);
    }
    updateActiveDescendant();
  }

  function updateActiveDescendant() {
    if (activeIndex >= 0 && activeIndex < currentOptions.length) {
      input.setAttribute("aria-activedescendant", `${list.id}-opt-${activeIndex}`);
    } else {
      input.removeAttribute("aria-activedescendant");
    }
    // Visually mark the active (keyboard-focused) option distinct from the
    // selected one so both sighted and keyboard users can tell them apart.
    list.querySelectorAll(".comboOption").forEach((el, i) => {
      el.classList.toggle("active", i === activeIndex);
    });
    // Keep the active option scrolled into view.
    const activeEl = list.querySelectorAll(".comboOption")[activeIndex];
    if (activeEl) activeEl.scrollIntoView({ block: "nearest" });
  }

  function openList() {
    list.classList.add("open");
    input.setAttribute("aria-expanded", "true");
    renderList("");
    input.select();
  }

  function closeList() {
    list.classList.remove("open");
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    input.value = getCurrent();
  }

  function choose(opt) {
    onSelect(opt);
    closeList();
  }

  input.addEventListener("focus", openList);
  input.addEventListener("input", () => renderList(input.value));
  input.addEventListener("blur", () => setTimeout(closeList, 120));
  input.addEventListener("keydown", (e) => {
    if (!list.classList.contains("open")) {
      if (["ArrowDown", "ArrowUp", "Enter"].includes(e.key)) openList();
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (currentOptions.length) {
        activeIndex = (activeIndex + 1) % currentOptions.length;
        updateActiveDescendant();
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (currentOptions.length) {
        activeIndex = (activeIndex - 1 + currentOptions.length) % currentOptions.length;
        updateActiveDescendant();
      }
    } else if (e.key === "Home") {
      e.preventDefault();
      activeIndex = 0;
      updateActiveDescendant();
    } else if (e.key === "End") {
      e.preventDefault();
      activeIndex = currentOptions.length - 1;
      updateActiveDescendant();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (activeIndex >= 0 && activeIndex < currentOptions.length) {
        choose(currentOptions[activeIndex]);
      } else {
        const first = list.querySelector(".comboOption");
        if (first) choose(first.textContent);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeList();
    }
  });

  return { sync: () => { input.value = getCurrent(); } };
}

/* ----------------------------------------------------------------------
 * Data vintage chip + refresh flow
 * ---------------------------------------------------------------------- */
async function fetchStatus() {
  try {
    const r = await fetch("/api/status", { cache: "no-store" });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

function renderVintage(status) {
  const lastDate = dateDomain.max ? new Date(dateDomain.max).toISOString().slice(0, 10) : "?";
  const extracted = workbook.generated_at ? workbook.generated_at.slice(0, 10) : "?";
  let text = `Data through ${lastDate} · extracted ${extracted}`;
  let warn = false;
  if (status && status.refresh_running) {
    text = "Refreshing dataset…";
    warn = true;
  } else if (status && status.stale) {
    text += " · source is newer";
    warn = true;
  }
  dom.dataVintage.textContent = text;
  dom.dataVintage.classList.toggle("warn", warn);
}

function setRefreshBusy(busy) {
  dom.refreshBtn.disabled = busy;
  dom.refreshBtn.setAttribute("aria-busy", String(busy));
  dom.refreshBtn.classList.toggle("is-busy", busy);
}

function pollRefreshUntilDone() {
  const loadedGeneratedAt = workbook.generated_at;
  let attempts = 0;
  const timer = setInterval(async () => {
    attempts += 1;
    const s = await fetchStatus();
    if (!s) {
      clearInterval(timer);
      setRefreshBusy(false);
      setBanner("Refresh status unavailable — is serve_triptych.py running?", true);
      return;
    }
    renderVintage(s);
    if (!s.refresh_running) {
      clearInterval(timer);
      setRefreshBusy(false);
      if (s.last_refresh_result === "error") {
        setBanner(`Data refresh FAILED: ${s.last_refresh_error}`, true);
      } else if (s.dataset_generated_at && s.dataset_generated_at !== loadedGeneratedAt) {
        setBanner("Dataset refreshed — reloading…");
        setTimeout(() => window.location.reload(), 400);
      } else {
        setBanner("Dataset already current.");
        setTimeout(() => setBanner(""), 2500);
      }
      return;
    }
    // Guardrail: previously this polled every 1s forever if refresh_running
    // never cleared (server crash mid-refresh, stuck lock, etc.).
    if (attempts >= REFRESH_POLL_MAX_ATTEMPTS) {
      clearInterval(timer);
      setRefreshBusy(false);
      setBanner(
        `Refresh still running after ${Math.round(REFRESH_POLL_MAX_ATTEMPTS * REFRESH_POLL_INTERVAL_MS / 1000)}s — timed out. Check ~/Library/Logs/Triptych.log.`,
        true
      );
    }
  }, REFRESH_POLL_INTERVAL_MS);
}

async function handleRefreshClick() {
  if (dom.refreshBtn.disabled) return;
  setRefreshBusy(true);
  setBanner("Requesting data refresh…");
  let resp;
  try {
    resp = await fetch("/api/refresh", { method: "POST" });
  } catch (err) {
    setRefreshBusy(false);
    setBanner(`Refresh request failed: ${err.message} — is serve_triptych.py running?`, true);
    return;
  }
  if (resp.status === 202 || resp.status === 409 || resp.ok) {
    setBanner("Refreshing dataset…");
    pollRefreshUntilDone();
  } else {
    setRefreshBusy(false);
    setBanner(`Refresh request failed (HTTP ${resp.status}).`, true);
  }
}

async function initVintage() {
  const status = await fetchStatus();
  renderVintage(status);
  if (status && status.cloud_mode) {
    dom.refreshBtn.style.display = "none";
  } else if (status && status.refresh_running) {
    // A refresh is already running (e.g. auto-refresh on launch): mirror that
    // state in the button so the user sees it's busy.
    setRefreshBusy(true);
    setBanner("Data refresh in progress…");
    pollRefreshUntilDone();
  }
}

/* ----------------------------------------------------------------------
 * Exports
 * ---------------------------------------------------------------------- */
function exportFileStem() {
  const stamp = new Date().toISOString().slice(0, 10);
  const safeCountry = String(state.country || "unknown").replace(/[^a-zA-Z0-9 -]/g, "-");
  const safeSheet = String(state.factorSheet || "unknown").trim().replace(/[^a-zA-Z0-9 -]/g, "-");
  return `Triptych ${safeCountry} ${safeSheet} ${stamp}`.replace(/[/\\:]+/g, "-").replace(/\s+/g, " ");
}

function exportXlsx() {
  if (!window.XLSX) {
    setBanner("xlsx library failed to load.", true);
    return;
  }
  if (!lastComputed || !lastMatrix) return;
  const k = state.bucketCount;
  const wb = XLSX.utils.book_new();

  const statsHeader = ["Bucket", "Obs", "Avg Fwd Return", "Median", "Hit Rate", "Best", "Worst", "t-Stat (overlap-adj)"];
  const statsRows = lastComputed.bottomStats.map((r, i) => [
    `${bucketWord()} ${i + 1}`,
    r.count,
    r.avg,
    r.med,
    r.hitRate,
    r.best,
    r.worst,
    r.tStat,
  ]);
  const top = lastComputed.bottomStats[k - 1];
  const bottom = lastComputed.bottomStats[0];
  statsRows.push([
    `${bucketShort()}${k} - ${bucketShort()}1 Spread`,
    null,
    Number.isFinite(top?.avg) && Number.isFinite(bottom?.avg) ? top.avg - bottom.avg : null,
    Number.isFinite(top?.med) && Number.isFinite(bottom?.med) ? top.med - bottom.med : null,
    null,
    null,
    null,
    null,
  ]);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([statsHeader, ...statsRows]), "Bucket Stats");

  const matrixHeader = [bucketWord(), ...lastMatrix.map((c) => `${c.horizon}M`)];
  const matrixRows = [];
  for (let b = 0; b < k; b += 1) {
    matrixRows.push([`${bucketShort()}${b + 1}`, ...lastMatrix.map((c) => c.stats[b]?.avg ?? null)]);
  }
  matrixRows.push([`${bucketShort()}${k}-${bucketShort()}1`, ...lastMatrix.map((c) => c.spread)]);
  matrixRows.push(["IC", ...lastMatrix.map((c) => c.ic.ic)]);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([matrixHeader, ...matrixRows]), "Horizon Matrix");

  const settings = [
    ["Country", state.country],
    ["Factor", state.factorSheet],
    ["Normalization", getNormalizationLabel(state.normalization)],
    ["Return mode", state.returnMode],
    ["Horizon (months)", state.horizonMonths],
    ["Bucket thresholds", state.decileMode === "pit" ? "Point-in-time" : "Full-sample"],
    ["Buckets", state.bucketCount],
    ["Range", state.range],
    ["Sample size", lastComputed.sampleSize],
    ["Dataset extracted", workbook.generated_at],
    ["Source file", workbook.source_file],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Setting", "Value"], ...settings]), "Settings");

  XLSX.writeFile(wb, `${exportFileStem()}.xlsx`);
}

function exportPdf() {
  if (!window.jspdf || !window.jspdf.jsPDF) {
    setBanner("jsPDF library failed to load.", true);
    return;
  }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 36;
  const contentW = pageW - margin * 2;

  function addChart(canvas, y, maxH) {
    const img = canvas.toDataURL("image/png");
    const ratio = canvas.height / canvas.width;
    let w = contentW;
    let h = w * ratio;
    if (h > maxH) {
      h = maxH;
      w = h / ratio;
    }
    doc.addImage(img, "PNG", margin + (contentW - w) / 2, y, w, h);
    return h;
  }

  doc.setFontSize(16);
  doc.text(`Triptych: ${state.country} — ${state.factorSheet.trim()}`, margin, margin + 4);
  doc.setFontSize(9);
  doc.setTextColor(110);
  doc.text(
    `${getNormalizationLabel(state.normalization)} | ${state.returnMode} return | ${state.horizonMonths}M horizon | ` +
      `${state.decileMode === "pit" ? "point-in-time" : "full-sample"} thresholds | range ${state.range.toUpperCase()} | ` +
      `data extracted ${workbook.generated_at?.slice(0, 10) || "?"}`,
    margin,
    margin + 20
  );
  doc.setTextColor(0);

  let y = margin + 36;
  const halfH = (pageH - y - margin - 16) / 2;
  y += addChart(dom.topCanvas, y, halfH) + 16;
  addChart(dom.middleCanvas, y, halfH);

  doc.addPage();
  addChart(dom.bottomCanvas, margin, pageH - margin * 2);

  doc.addPage();
  addChart(dom.snapshotCanvas, margin, pageH - margin * 2);

  doc.save(`${exportFileStem()}.pdf`);
}

/* ----------------------------------------------------------------------
 * Events and init
 * ---------------------------------------------------------------------- */
function attachEvents() {
  dom.normalizationSelect.addEventListener("change", () => {
    state.normalization = dom.normalizationSelect.value;
    render();
  });

  dom.returnModeSelect.addEventListener("change", () => {
    state.returnMode = dom.returnModeSelect.value;
    render();
  });

  dom.horizonSelect.addEventListener("change", () => {
    state.horizonMonths = Number(dom.horizonSelect.value);
    render();
  });

  dom.decileModeSelect.addEventListener("change", () => {
    state.decileMode = dom.decileModeSelect.value;
    render();
  });

  dom.bucketCountSelect.addEventListener("change", () => {
    state.bucketCount = Number(dom.bucketCountSelect.value);
    render();
  });

  dom.rangeButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const nextRange = btn.dataset.range;
      if (!C.RANGE_VALUES.has(nextRange)) return;
      state.range = nextRange;
      render();
    });
  });

  dom.refreshBtn.addEventListener("click", handleRefreshClick);
  dom.exportXlsxBtn.addEventListener("click", exportXlsx);
  dom.exportPdfBtn.addEventListener("click", exportPdf);
}

async function init() {
  try {
    workbook = await window.__t2DataPromise;
    buildIndexes();

    if (workbook.__skipped && workbook.__skipped.length) {
      setBanner(`Skipped malformed sheets: ${workbook.__skipped.join(", ")}`, true);
    }

    state.factorSheet = chooseDefaultFactor();
    state.country = chooseDefaultCountry();

    applyHydrated(hydrateFromStorage());
    applyHydrated(hydrateFromUrl());

    if (!allSheets.includes(state.factorSheet)) state.factorSheet = chooseDefaultFactor();
    ensureValidCountry();

    syncStaticControls();

    factorCombo = setupCombobox({
      input: dom.factorInput,
      list: dom.factorList,
      getOptions: () => allSheets,
      getCurrent: () => state.factorSheet,
      onSelect: (sheet) => {
        state.factorSheet = sheet;
        ensureValidCountry();
        countryCombo.sync();
        render();
      },
    });
    countryCombo = setupCombobox({
      input: dom.countryInput,
      list: dom.countryList,
      getOptions: () => getCountriesForFactor(state.factorSheet),
      getCurrent: () => state.country,
      onSelect: (country) => {
        state.country = country;
        render();
      },
    });
    factorCombo.sync();
    countryCombo.sync();

    attachEvents();
    render();
    initVintage();
  } catch (err) {
    console.error(err);
    setBanner(`Triptych failed to load: ${err.message}`, true);
    dom.dataVintage.textContent = "Data unavailable";
    dom.dataVintage.classList.add("warn");
  }
}

window.addEventListener("beforeunload", () => {
  Object.values(charts).forEach((c) => c && c.destroy());
});

window.addEventListener("tab-switch", (e) => {
  if (e.detail === "triptych") {
    if (workbook) {
      // Destroy and recreate charts on tab return — display:none corrupts
      // Chart.js internal state (documented issues #4659, #7297). Without
      // this, charts can render at zero height or produce NaN scales.
      Object.keys(charts).forEach((k) => {
        if (charts[k]) { charts[k].destroy(); charts[k] = null; }
      });
      crosshairState.ms = null;
      ensureCharts();
      render();
      persistState();
    }
  }
});

init();
})();
