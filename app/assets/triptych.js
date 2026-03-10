const DATA_PATH = "./data/t2_master.json";
const STORAGE_KEY = "triptych:last";



const RANGE_VALUES = new Set(["all", "10y", "5y", "3y", "1y"]);
const HORIZON_OPTIONS = [1, 3, 6, 12, 24, 36];
const NORMALIZATION_OPTIONS = [
  { value: "raw", label: "Raw" },
  { value: "history_z", label: "Z-Score vs own history" },
  { value: "cross_var_pct", label: "Cross-Sectional" },
];
const RETURN_MODE_OPTIONS = [
  { value: "absolute", label: "Absolute Return" },
  { value: "relative", label: "Relative Return" },
];
const RETURN_SHEET_ALIASES = ["tot return index", "total return index", "tot return", "total return"];

const dom = {
  banner: document.getElementById("banner"),
  factorSelect: document.getElementById("factorSelect"),
  normalizationSelect: document.getElementById("normalizationSelect"),
  countrySelect: document.getElementById("countrySelect"),
  returnModeSelect: document.getElementById("returnModeSelect"),
  horizonSelect: document.getElementById("horizonSelect"),
  rangeButtons: Array.from(document.querySelectorAll(".rangeBtn")),
  summary: document.getElementById("summary"),
  topTitle: document.getElementById("topTitle"),
  midTitle: document.getElementById("midTitle"),
  bottomTitle: document.getElementById("bottomTitle"),
  decileTableBody: document.querySelector("#decileTable tbody"),
  topCanvas: document.getElementById("topChart"),
  middleCanvas: document.getElementById("middleChart"),
  bottomCanvas: document.getElementById("bottomChart"),
};

let workbook;
let allSheets = [];
let sheetToCountries = new Map();
let seriesCache = new Map();
let crossCountryCache = new Map();
let dateDomain = { min: null, max: null };

const charts = {
  top: null,
  middle: null,
  bottom: null,
};

const state = {
  factorSheet: "",
  country: "",
  normalization: "raw",
  returnMode: "absolute",
  horizonMonths: 12,
  range: "all",
};

function setBanner(message = "", warn = false) {
  dom.banner.textContent = message;
  dom.banner.classList.toggle("show", Boolean(message));
  if (warn) dom.banner.classList.add("warn");
  else dom.banner.classList.remove("warn");
}

function getSeriesKey(sheet, country) {
  return `${sheet}|||${country}`;
}

function getCrossCountryKey(sheet, date) {
  return `${sheet}|||${date}`;
}

function sortText(a, b) {
  return a.localeCompare(b);
}

function normalizeSheetName(name) {
  return String(name || "").trim().toLowerCase();
}

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

function parseDateMs(date) {
  return Date.parse(`${date}T00:00:00Z`);
}

function buildIndexes() {
  allSheets = Object.keys(workbook.sheets).sort(sortText);
  sheetToCountries = new Map();
  seriesCache = new Map();
  crossCountryCache = new Map();

  let minMs = Infinity;
  let maxMs = -Infinity;

  for (const sheet of allSheets) {
    const ws = workbook.sheets[sheet];
    const countries = Array.from(new Set(ws.countries)).sort(sortText);
    sheetToCountries.set(sheet, new Set(countries));

    for (const country of countries) {
      const points = [];
      for (const row of ws.rows) {
        const raw = row.values[country];
        if (!Number.isFinite(raw)) continue;
        const ms = parseDateMs(row.date);
        if (!Number.isFinite(ms)) continue;
        points.push({ date: row.date, ms, value: Number(raw) });
        if (ms < minMs) minMs = ms;
        if (ms > maxMs) maxMs = ms;
      }
      seriesCache.set(getSeriesKey(sheet, country), points);
    }

    for (const row of ws.rows) {
      const key = getCrossCountryKey(sheet, row.date);
      if (!crossCountryCache.has(key)) crossCountryCache.set(key, []);

      for (const country of countries) {
        const raw = row.values[country];
        if (!Number.isFinite(raw)) continue;
        crossCountryCache.get(key).push({ country, value: Number(raw) });
      }
    }
  }

  dateDomain = {
    min: Number.isFinite(minMs) ? minMs : null,
    max: Number.isFinite(maxMs) ? maxMs : null,
  };
}

function buildSelectOptions(selectEl, options, selectedValue) {
  selectEl.innerHTML = "";
  options.forEach((opt) => {
    const el = document.createElement("option");
    if (typeof opt === "string") {
      el.value = opt;
      el.textContent = opt;
    } else {
      el.value = opt.value;
      el.textContent = opt.label;
    }
    el.selected = el.value === String(selectedValue);
    selectEl.appendChild(el);
  });
}

function getNormalizationLabel(mode) {
  return NORMALIZATION_OPTIONS.find((x) => x.value === mode)?.label || mode;
}

function getRangeStartMs(maxMs, range) {
  if (range === "all" || !maxMs) return null;
  const years = { "10y": 10, "5y": 5, "3y": 3, "1y": 1 }[range];
  if (!years) return null;
  const d = new Date(maxMs);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.getTime();
}

function percentileVsCrossCountry(sheet, country, date, value) {
  const arr = crossCountryCache.get(getCrossCountryKey(sheet, date));
  if (!arr || arr.length < 2) return null;

  const peers = [];
  for (const peer of arr) {
    if (peer.country === country) continue;
    if (!Number.isFinite(peer.value)) continue;
    peers.push(peer.value);
  }

  if (peers.length === 0) return null;

  const mean = peers.reduce((sum, v) => sum + v, 0) / peers.length;
  const variance = peers.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / peers.length;
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

    if (count < 2) {
      return { ...p, signal: 0 };
    }

    const variance = m2 / count;
    const std = Math.sqrt(variance);
    if (!Number.isFinite(std) || std === 0) {
      return { ...p, signal: 0 };
    }

    return { ...p, signal: (x - mean) / std };
  });
}

function addMonthsIso(dateStr, months) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (!Number.isFinite(d.getTime())) return null;
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
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

function buildDecileThresholds(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length < 2) return [];
  const thresholds = [];
  for (let i = 1; i < 10; i += 1) {
    thresholds.push(quantile(sorted, i / 10));
  }
  return thresholds;
}

function assignDecile(value, thresholds) {
  if (!Number.isFinite(value)) return null;
  for (let i = 0; i < thresholds.length; i += 1) {
    if (value <= thresholds[i]) return i + 1;
  }
  return 10;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function formatPct(v, digits = 2) {
  if (!Number.isFinite(v)) return "-";
  return `${(v * 100).toFixed(digits)}%`;
}

function formatNum(v, digits = 2) {
  if (!Number.isFinite(v)) return "-";
  return v.toLocaleString(undefined, { maximumFractionDigits: digits });
}

function getSeries(sheet, country) {
  return seriesCache.get(getSeriesKey(sheet, country)) || [];
}

function getCountriesForFactor(sheet) {
  const set = sheetToCountries.get(sheet);
  if (!set) return [];
  return Array.from(set).sort(sortText);
}

function chooseDefaultFactor() {
  return allSheets.includes("Trailing PE") ? "Trailing PE" : allSheets[0] || "";
}

function chooseDefaultCountry() {
  const countries = getCountriesForFactor(state.factorSheet);
  if (!countries.length) return "";
  if (countries.includes("India")) return "India";
  return countries[0];
}

function hydrateFromUrl() {
  const p = new URLSearchParams(window.location.search);
  return {
    factor: p.get("f"),
    country: p.get("c"),
    normalization: p.get("n"),
    returnMode: p.get("m"),
    horizon: Number(p.get("h")),
    range: p.get("r"),
  };
}

function hydrateFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function applyHydrated(payload) {
  if (!payload) return;

  if (payload.factor && allSheets.includes(payload.factor)) {
    state.factorSheet = payload.factor;
  }

  if (payload.normalization && NORMALIZATION_OPTIONS.some((x) => x.value === payload.normalization)) {
    state.normalization = payload.normalization;
  }

  if (payload.returnMode && RETURN_MODE_OPTIONS.some((x) => x.value === payload.returnMode)) {
    state.returnMode = payload.returnMode;
  }

  if (HORIZON_OPTIONS.includes(payload.horizon)) {
    state.horizonMonths = payload.horizon;
  }

  if (payload.range && RANGE_VALUES.has(payload.range)) {
    state.range = payload.range;
  }

  if (typeof payload.country === "string") {
    state.country = payload.country;
  }
}

function persistState() {
  const payload = {
    factor: state.factorSheet,
    country: state.country,
    normalization: state.normalization,
    returnMode: state.returnMode,
    horizon: state.horizonMonths,
    range: state.range,
  };

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // non-fatal
  }

  const params = new URLSearchParams();
  params.set("f", state.factorSheet);
  params.set("c", state.country);
  params.set("n", state.normalization);
  params.set("m", state.returnMode);
  params.set("h", String(state.horizonMonths));
  params.set("r", state.range);
  window.history.replaceState({}, "", `${window.location.pathname}?${params.toString()}`);
}

function syncRangeButtons() {
  dom.rangeButtons.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.range === state.range);
  });
}

function syncStaticControls() {
  buildSelectOptions(dom.factorSelect, allSheets, state.factorSheet);
  buildSelectOptions(dom.normalizationSelect, NORMALIZATION_OPTIONS, state.normalization);
  buildSelectOptions(dom.returnModeSelect, RETURN_MODE_OPTIONS, state.returnMode);
  buildSelectOptions(
    dom.horizonSelect,
    HORIZON_OPTIONS.map((h) => ({ value: String(h), label: `${h} months` })),
    String(state.horizonMonths)
  );
}

function syncCountryControl() {
  const countries = getCountriesForFactor(state.factorSheet);
  if (!countries.includes(state.country)) {
    state.country = countries.includes("India") ? "India" : countries[0] || "";
  }
  buildSelectOptions(dom.countrySelect, countries, state.country);
}

function buildSignalSeries(rawSeries) {
  if (state.normalization === "raw") {
    return rawSeries.map((p) => ({ ...p, signal: p.value }));
  }

  if (state.normalization === "history_z") {
    return buildExpandingZScoreSeries(rawSeries);
  }

  if (state.normalization === "cross_var_pct") {
    return rawSeries
      .map((p) => ({ ...p, signal: percentileVsCrossCountry(state.factorSheet, state.country, p.date, p.value) }))
      .filter((p) => Number.isFinite(p.signal));
  }

  return rawSeries.map((p) => ({ ...p, signal: p.value }));
}

function buildCumulativeSeries(rawSeries) {
  if (!rawSeries.length) return { points: [], mode: "return" };

  const firstNonZero = rawSeries.find((p) => Number.isFinite(p.value) && p.value !== 0);
  if (!firstNonZero) return { points: [], mode: "return" };

  const mode = firstNonZero.value > 0 ? "return" : "change";
  const points = rawSeries
    .filter((p) => Number.isFinite(p.value))
    .map((p) => {
      if (mode === "return") {
        return { x: p.ms, y: p.value / firstNonZero.value - 1 };
      }
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

function buildRelativeCumulativeSeries(returnSheet, country) {
  if (!returnSheet || !country) return { points: [], mode: "return" };

  const countries = getCountriesForFactor(returnSheet);
  if (!countries.length) return { points: [], mode: "return" };

  const avgByDate = new Map();
  let ownMonthlyReturns = [];

  for (const c of countries) {
    const monthly = buildMonthlyReturnSeries(getSeries(returnSheet, c));
    if (c === country) {
      ownMonthlyReturns = monthly;
    }

    for (const p of monthly) {
      if (!avgByDate.has(p.date)) {
        avgByDate.set(p.date, { ms: p.ms, sum: 0, count: 0 });
      }
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

function computeTriptych() {
  const factorSeries = getSeries(state.factorSheet, state.country);
  const returnSheet = chooseReturnSheet();
  const returnSeries = returnSheet ? getSeries(returnSheet, state.country) : [];
  const startMs = getRangeStartMs(dateDomain.max, state.range);

  if (!factorSeries.length) {
    return {
      topPoints: [],
      middlePoints: [],
      bottomPoints: [],
      decileStats: Array.from({ length: 10 }, () => ({ count: 0, avg: null, med: null, hitRate: null })),
      startMs,
      sampleSize: 0,
      cumulativeMode: "return",
      normalizationLabel: getNormalizationLabel(state.normalization),
      returnSheet,
      hasReturnSeries: returnSeries.length > 0,
    };
  }

  const signalSeries = buildSignalSeries(factorSeries);
  const signalByDate = new Map(signalSeries.map((p) => [p.date, p.signal]));
  const returnByDate = new Map(returnSeries.map((p) => [p.date, p.value]));
  const { points: cumulativeAll, mode: cumulativeMode } =
    state.returnMode === "relative"
      ? buildRelativeCumulativeSeries(returnSheet, state.country)
      : buildCumulativeSeries(returnSeries);

  const avgForwardReturnByDate = new Map();
  if (state.returnMode === "relative" && returnSheet) {
    const countries = getCountriesForFactor(returnSheet);
    for (const c of countries) {
      const cSeries = getSeries(returnSheet, c);
      const cReturnByDate = new Map(cSeries.map((p) => [p.date, p.value]));

      for (const p of cSeries) {
        const baseLevel = p.value;
        if (!Number.isFinite(baseLevel) || baseLevel === 0) continue;

        const targetDate = addMonthsIso(p.date, state.horizonMonths);
        if (!targetDate) continue;

        const targetLevel = cReturnByDate.get(targetDate);
        if (!Number.isFinite(targetLevel)) continue;

        const fwdRet = targetLevel / baseLevel - 1;
        if (!avgForwardReturnByDate.has(p.date)) {
          avgForwardReturnByDate.set(p.date, { sum: 0, count: 0 });
        }
        const agg = avgForwardReturnByDate.get(p.date);
        agg.sum += fwdRet;
        agg.count += 1;
      }
    }
  }

  const forwardRecords = [];
  for (const p of factorSeries) {
    const signal = signalByDate.get(p.date);
    if (!Number.isFinite(signal)) continue;

    const baseReturnLevel = returnByDate.get(p.date);
    if (!Number.isFinite(baseReturnLevel) || baseReturnLevel === 0) continue;

    const targetDate = addMonthsIso(p.date, state.horizonMonths);
    if (!targetDate) continue;

    const targetReturnLevel = returnByDate.get(targetDate);
    if (!Number.isFinite(targetReturnLevel)) continue;

    let forwardReturn = targetReturnLevel / baseReturnLevel - 1;

    if (state.returnMode === "relative") {
      const agg = avgForwardReturnByDate.get(p.date);
      if (agg && agg.count > 0) {
        const avgFwdRet = agg.sum / agg.count;
        forwardReturn = forwardReturn - avgFwdRet;
      }
    }

    forwardRecords.push({
      date: p.date,
      ms: p.ms,
      signal,
      forwardReturn,
    });
  }

  const thresholds = buildDecileThresholds(forwardRecords.map((r) => r.signal));
  const recordsWithDeciles = forwardRecords.map((r) => ({
    ...r,
    decile: assignDecile(r.signal, thresholds),
  }));

  const inRange = (ms) => (startMs ? ms >= startMs : true);
  const rangedRecords = recordsWithDeciles.filter((r) => inRange(r.ms));

  const buckets = Array.from({ length: 10 }, () => []);
  rangedRecords.forEach((r) => {
    if (!r.decile) return;
    buckets[r.decile - 1].push(r.forwardReturn);
  });

  const decileStats = buckets.map((vals) => {
    if (!vals.length) return { count: 0, avg: null, med: null, hitRate: null };
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const med = median(vals);
    const hitRate = vals.filter((v) => v > 0).length / vals.length;
    return { count: vals.length, avg, med, hitRate };
  });

  const topPoints = signalSeries
    .filter((p) => inRange(p.ms))
    .map((p) => ({ x: p.ms, y: p.signal }));

  const middlePoints = cumulativeAll.filter((p) => inRange(p.x));

  const bottomPoints = decileStats.map((row, idx) => ({
    x: idx + 1,
    y: row.avg,
    count: row.count,
  }));

  /* --- current decile: decile that the most recent signal falls into --- */
  let currentDecile = null;
  if (signalSeries.length && thresholds.length) {
    const latestSignal = signalSeries[signalSeries.length - 1].signal;
    if (Number.isFinite(latestSignal)) {
      currentDecile = assignDecile(latestSignal, thresholds);
    }
  }

  return {
    topPoints,
    middlePoints,
    bottomPoints,
    decileStats,
    currentDecile,
    startMs,
    sampleSize: rangedRecords.length,
    cumulativeMode,
    normalizationLabel: getNormalizationLabel(state.normalization),
    returnSheet,
    hasReturnSeries: returnSeries.length > 0,
  };
}

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

function ensureCharts() {
  if (!window.Chart) {
    throw new Error("Chart.js failed to load");
  }

  if (!charts.top) {
    charts.top = new Chart(dom.topCanvas, {
      type: "line",
      data: { datasets: [] },
      options: {
        ...baseChartOptions(),
        scales: {
          ...baseChartOptions().scales,
          y: {
            ticks: { callback: (v) => formatNum(Number(v), 2) },
          },
        },
      },
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
          y: {
            ticks: { callback: (v) => formatPct(Number(v), 1) },
          },
        },
      },
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
          tooltip: {
            mode: "nearest",
            intersect: false,
          },
        },
        scales: {
          x: {
            type: "category",
            ticks: {
              font: { size: 13, weight: "bold" },
              padding: 6,
            },
            grid: { display: false },
          },
          y: {
            ticks: { callback: (v) => formatPct(Number(v), 1) },
          },
        },
      },
    });
  }
}

function renderDecileTable(stats) {
  dom.decileTableBody.innerHTML = "";

  stats.forEach((row, idx) => {
    const tr = document.createElement("tr");

    const d = document.createElement("td");
    d.textContent = `Decile ${idx + 1}`;

    const count = document.createElement("td");
    count.textContent = String(row.count);

    const avg = document.createElement("td");
    avg.textContent = formatPct(row.avg);

    const med = document.createElement("td");
    med.textContent = formatPct(row.med);

    const hit = document.createElement("td");
    hit.textContent = row.hitRate === null ? "-" : `${(row.hitRate * 100).toFixed(1)}%`;
    if (Number.isFinite(row.hitRate)) {
      hit.className = row.hitRate >= 0.5 ? "hitGood" : "hitBad";
    }

    tr.appendChild(d);
    tr.appendChild(count);
    tr.appendChild(avg);
    tr.appendChild(med);
    tr.appendChild(hit);
    dom.decileTableBody.appendChild(tr);
  });
}

function render() {
  syncRangeButtons();

  const computed = computeTriptych();

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
      ? `Cumulative Return To ${state.country} (${computed.returnSheet.trim()})`
      : `Cumulative Return To ${state.country}`;
  }
  dom.bottomTitle.textContent = `${state.horizonMonths}M Forward Return by Decile`;

  dom.summary.textContent = [
    `Country: ${state.country || "-"}`,
    `Factor: ${state.factorSheet || "-"}`,
    `Return source: ${computed.returnSheet ? computed.returnSheet.trim() : "-"}`,
    `Return mode: ${state.returnMode === "relative" ? "Relative vs all-country average" : "Absolute"}`,
    `Normalization: ${computed.normalizationLabel}`,
    `Sample points: ${computed.sampleSize}`,
    `Range: ${state.range.toUpperCase()}`,
  ].join(" | ");

  ensureCharts();

  const xMin = computed.startMs || undefined;

  /* Use the same x-max for both top and middle so their time scales align */
  const topEnd = computed.topPoints.length
    ? computed.topPoints[computed.topPoints.length - 1].x
    : 0;
  const midEnd = computed.middlePoints.length
    ? computed.middlePoints[computed.middlePoints.length - 1].x
    : 0;
  const sharedXMax = Math.max(topEnd, midEnd) || (dateDomain.max || undefined);

  charts.top.options.scales.x.min = xMin;
  charts.top.options.scales.x.max = sharedXMax;
  charts.middle.options.scales.x.min = xMin;
  charts.middle.options.scales.x.max = sharedXMax;

  if (state.normalization === "cross_var_pct") {
    charts.top.options.scales.y.ticks.callback = (v) => `${Number(v).toFixed(0)}%`;
  } else {
    charts.top.options.scales.y.ticks.callback = (v) => formatNum(Number(v), 2);
  }

  charts.middle.options.scales.y.ticks.callback =
    computed.cumulativeMode === "return"
      ? (v) => formatPct(Number(v), 1)
      : (v) => formatNum(Number(v), 2);

  charts.top.options.plugins.tooltip.callbacks.label = (ctx) => {
    const val = Number(ctx.parsed.y);
    if (state.normalization === "cross_var_pct") {
      return `${topLabel}: ${val.toFixed(2)} σ`;
    }
    return `${topLabel}: ${val.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
  };

  charts.middle.options.plugins.tooltip.callbacks.label = (ctx) => {
    const val = Number(ctx.parsed.y);
    if (computed.cumulativeMode === "return") {
      return `${middleLabel}: ${formatPct(val, 2)}`;
    }
    return `Cumulative change: ${formatNum(val, 4)}`;
  };

  charts.bottom.options.plugins.tooltip.callbacks.label = (ctx) => {
    const val = Number(ctx.parsed.y);
    const obs = computed.decileStats[ctx.dataIndex]?.count;
    const obsText = Number.isFinite(obs) ? ` (${obs} obs)` : "";
    return `Avg ${state.horizonMonths}M forward return: ${formatPct(val, 2)}${obsText}`;
  };
  charts.bottom.options.plugins.tooltip.callbacks.title = (items) => {
    if (!items || !items.length) return "";
    return `Decile ${items[0].dataIndex + 1}`;
  };

  charts.top.data.datasets = [
    {
      label: topLabel,
      data: computed.topPoints,
      borderColor: "#0f7e63",
      backgroundColor: "#0f7e63",
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
      borderColor: "#114f88",
      backgroundColor: "#114f88",
      pointRadius: 0,
      pointHoverRadius: 3,
      borderWidth: 2,
      tension: 0.14,
      fill: false,
    },
  ];

  const cd = computed.currentDecile;
  const decileLabels = Array.from({ length: 10 }, (_, i) => String(i + 1));
  const decileValues = computed.bottomPoints.map((p) => p.y);
  charts.bottom.data.labels = decileLabels;
  charts.bottom.data.datasets = [
    {
      label: `Avg ${state.horizonMonths}M forward return`,
      data: decileValues,
      backgroundColor: computed.bottomPoints.map((p) => {
        if (!Number.isFinite(p.y)) return "rgba(110, 110, 110, 0.2)";
        if (p.y >= 0) return "rgba(24, 116, 63, 0.68)";
        return "rgba(160, 60, 45, 0.68)";
      }),
      borderColor: computed.bottomPoints.map((p, i) => {
        if (cd && i + 1 === cd) return "#f5a623";
        if (!Number.isFinite(p.y)) return "rgba(110, 110, 110, 0.6)";
        return p.y >= 0 ? "#18743f" : "#a03c2d";
      }),
      borderWidth: computed.bottomPoints.map((_p, i) =>
        cd && i + 1 === cd ? 3 : 1
      ),
      barPercentage: 0.85,
      categoryPercentage: 0.9,
    },
  ];

  charts.top.update();
  charts.middle.update();
  charts.bottom.update();

  renderDecileTable(computed.decileStats);

  if (!computed.returnSheet) {
    setBanner("No return-index sheet found (expected a sheet like 'Tot Return Index').", true);
  } else if (!computed.hasReturnSeries) {
    setBanner(`No return series available for ${state.country} in ${computed.returnSheet.trim()}.`, true);
  } else if (computed.sampleSize === 0) {
    setBanner("No forward-return sample found for this variable and horizon.", true);
  } else {
    setBanner("");
  }

  persistState();
}

function attachEvents() {
  dom.factorSelect.addEventListener("change", () => {
    state.factorSheet = dom.factorSelect.value;
    syncCountryControl();
    render();
  });

  dom.normalizationSelect.addEventListener("change", () => {
    state.normalization = dom.normalizationSelect.value;
    render();
  });

  dom.countrySelect.addEventListener("change", () => {
    state.country = dom.countrySelect.value;
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

  dom.rangeButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const nextRange = btn.dataset.range;
      if (!RANGE_VALUES.has(nextRange)) return;
      state.range = nextRange;
      render();
    });
  });
}

async function loadWorkbook() {
  setBanner("Loading dataset...");
  const resp = await fetch(DATA_PATH);
  if (!resp.ok) throw new Error(`Failed to load data (${resp.status})`);
  const parsed = await resp.json();

  if (!parsed || typeof parsed.sheets !== "object") {
    throw new Error("Malformed dataset: missing sheets");
  }

  const cleanedSheets = {};
  const skipped = [];

  Object.entries(parsed.sheets).forEach(([name, sheet]) => {
    if (!sheet || !Array.isArray(sheet.countries) || !Array.isArray(sheet.rows)) {
      skipped.push(name);
      return;
    }
    cleanedSheets[name] = sheet;
  });

  workbook = { ...parsed, sheets: cleanedSheets };

  if (skipped.length) {
    setBanner(`Skipped malformed sheets: ${skipped.join(", ")}`, true);
  } else {
    setBanner("");
  }
}

async function init() {
  try {
    await loadWorkbook();
    buildIndexes();

    state.factorSheet = chooseDefaultFactor();
    state.country = chooseDefaultCountry();

    const fromStorage = hydrateFromStorage();
    const fromUrl = hydrateFromUrl();
    applyHydrated(fromStorage);
    applyHydrated(fromUrl);

    if (!allSheets.includes(state.factorSheet)) {
      state.factorSheet = chooseDefaultFactor();
    }

    syncStaticControls();
    syncCountryControl();

    dom.normalizationSelect.value = state.normalization;
    dom.returnModeSelect.value = state.returnMode;
    dom.horizonSelect.value = String(state.horizonMonths);

    attachEvents();
    render();
  } catch (err) {
    console.error(err);
    setBanner(`Triptych failed to load: ${err.message}`, true);
  }
}

window.addEventListener("beforeunload", () => {
  if (charts.top) charts.top.destroy();
  if (charts.middle) charts.middle.destroy();
  if (charts.bottom) charts.bottom.destroy();
});

init();
