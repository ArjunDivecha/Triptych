const DATA_PATH = "./data/t2_master.json";
const STORAGE_KEY = "triptych:last";

const RANGE_VALUES = new Set(["all", "10y", "5y", "3y", "1y"]);
const HORIZON_OPTIONS = [3, 6, 12, 24, 36];
const NORMALIZATION_OPTIONS = [
  { value: "raw", label: "Raw" },
  { value: "history_z", label: "Z-Score vs own history" },
  { value: "cross_var_pct", label: "Percentile vs all variables (same month)" },
];

const dom = {
  banner: document.getElementById("banner"),
  factorSelect: document.getElementById("factorSelect"),
  normalizationSelect: document.getElementById("normalizationSelect"),
  countrySelect: document.getElementById("countrySelect"),
  decileSelect: document.getElementById("decileSelect"),
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
let crossVariableCache = new Map();
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
  decile: 1,
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

function getCrossVariableKey(country, date) {
  return `${country}|||${date}`;
}

function sortText(a, b) {
  return a.localeCompare(b);
}

function parseDateMs(date) {
  return Date.parse(`${date}T00:00:00Z`);
}

function buildIndexes() {
  allSheets = Object.keys(workbook.sheets).sort(sortText);
  sheetToCountries = new Map();
  seriesCache = new Map();
  crossVariableCache = new Map();

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
      for (const country of countries) {
        const raw = row.values[country];
        if (!Number.isFinite(raw)) continue;
        const key = getCrossVariableKey(country, row.date);
        if (!crossVariableCache.has(key)) crossVariableCache.set(key, []);
        crossVariableCache.get(key).push(Number(raw));
      }
    }
  }

  for (const [key, values] of crossVariableCache.entries()) {
    values.sort((a, b) => a - b);
    crossVariableCache.set(key, values);
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

function upperBound(sorted, value) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function percentileVsCrossVariable(country, date, value) {
  const arr = crossVariableCache.get(getCrossVariableKey(country, date));
  if (!arr || arr.length === 0) return null;
  const ub = upperBound(arr, value);
  return (ub / arr.length) * 100;
}

function computeZScore(values) {
  const clean = values.filter(Number.isFinite);
  if (clean.length < 2) {
    return { mean: 0, std: 0 };
  }
  const mean = clean.reduce((a, b) => a + b, 0) / clean.length;
  const variance = clean.reduce((a, b) => a + (b - mean) ** 2, 0) / clean.length;
  return { mean, std: Math.sqrt(variance) };
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
    decile: Number(p.get("d")),
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

  if (Number.isInteger(payload.decile) && payload.decile >= 1 && payload.decile <= 10) {
    state.decile = payload.decile;
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
    decile: state.decile,
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
  params.set("d", String(state.decile));
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
  buildSelectOptions(
    dom.decileSelect,
    Array.from({ length: 10 }, (_, i) => ({ value: String(i + 1), label: `Decile ${i + 1}` })),
    String(state.decile)
  );
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
    const { mean, std } = computeZScore(rawSeries.map((p) => p.value));
    if (!Number.isFinite(std) || std === 0) {
      return rawSeries.map((p) => ({ ...p, signal: 0 }));
    }
    return rawSeries.map((p) => ({ ...p, signal: (p.value - mean) / std }));
  }

  if (state.normalization === "cross_var_pct") {
    return rawSeries
      .map((p) => ({ ...p, signal: percentileVsCrossVariable(state.country, p.date, p.value) }))
      .filter((p) => Number.isFinite(p.signal));
  }

  return rawSeries.map((p) => ({ ...p, signal: p.value }));
}

function computeTriptych() {
  const rawSeries = getSeries(state.factorSheet, state.country);
  const startMs = getRangeStartMs(dateDomain.max, state.range);

  if (!rawSeries.length) {
    return {
      topPoints: [],
      middlePoints: [],
      bottomPoints: [],
      decileStats: Array.from({ length: 10 }, () => ({ count: 0, avg: null, med: null, hitRate: null })),
      startMs,
      sampleSize: 0,
      cumulativeMode: "return",
      normalizationLabel: getNormalizationLabel(state.normalization),
    };
  }

  const signalSeries = buildSignalSeries(rawSeries);
  const signalByDate = new Map(signalSeries.map((p) => [p.date, p.signal]));
  const rawByDate = new Map(rawSeries.map((p) => [p.date, p.value]));

  const firstNonZero = rawSeries.find((p) => Number.isFinite(p.value) && p.value !== 0);
  const cumulativeMode = firstNonZero && firstNonZero.value > 0 ? "return" : "change";
  const cumulativeAll = rawSeries
    .filter((p) => Number.isFinite(p.value))
    .map((p) => {
      if (!firstNonZero) return { x: p.ms, y: null };
      if (cumulativeMode === "return") {
        return { x: p.ms, y: p.value / firstNonZero.value - 1 };
      }
      return { x: p.ms, y: p.value - firstNonZero.value };
    })
    .filter((p) => Number.isFinite(p.y));

  const forwardRecords = [];
  for (const p of rawSeries) {
    if (!Number.isFinite(p.value) || p.value === 0) continue;
    const signal = signalByDate.get(p.date);
    if (!Number.isFinite(signal)) continue;

    const targetDate = addMonthsIso(p.date, state.horizonMonths);
    if (!targetDate) continue;

    const target = rawByDate.get(targetDate);
    if (!Number.isFinite(target)) continue;

    forwardRecords.push({
      date: p.date,
      ms: p.ms,
      signal,
      forwardReturn: target / p.value - 1,
    });
  }

  const thresholds = buildDecileThresholds(forwardRecords.map((r) => r.signal));
  const recordsWithDeciles = forwardRecords.map((r) => ({
    ...r,
    decile: assignDecile(r.signal, thresholds),
  }));

  const buckets = Array.from({ length: 10 }, () => []);
  recordsWithDeciles.forEach((r) => {
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

  const inRange = (ms) => (startMs ? ms >= startMs : true);

  const topPoints = signalSeries
    .filter((p) => inRange(p.ms))
    .map((p) => ({ x: p.ms, y: p.signal }));

  const middlePoints = cumulativeAll.filter((p) => inRange(p.x));

  const bottomPoints = recordsWithDeciles
    .filter((r) => inRange(r.ms) && r.decile === state.decile)
    .map((r) => ({ x: r.ms, y: r.forwardReturn }));

  return {
    topPoints,
    middlePoints,
    bottomPoints,
    decileStats,
    startMs,
    sampleSize: recordsWithDeciles.length,
    cumulativeMode,
    normalizationLabel: getNormalizationLabel(state.normalization),
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
}

function renderDecileTable(stats) {
  dom.decileTableBody.innerHTML = "";

  stats.forEach((row, idx) => {
    const tr = document.createElement("tr");
    if (idx + 1 === state.decile) tr.classList.add("active");

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
  const middleLabel = `Cumulative return`;

  dom.topTitle.textContent = `${topLabel} (${computed.normalizationLabel})`;
  dom.midTitle.textContent = `Cumulative Return To ${state.factorSheet}`;
  dom.bottomTitle.textContent = `Decile ${state.decile} Run (${state.horizonMonths}M forward)`;

  dom.summary.textContent = [
    `Country: ${state.country || "-"}`,
    `Factor: ${state.factorSheet || "-"}`,
    `Normalization: ${computed.normalizationLabel}`,
    `Sample points: ${computed.sampleSize}`,
    `Range: ${state.range.toUpperCase()}`,
  ].join(" | ");

  ensureCharts();

  const xMin = computed.startMs || undefined;
  const xMax = dateDomain.max || undefined;

  charts.top.options.scales.x.min = xMin;
  charts.top.options.scales.x.max = xMax;
  charts.middle.options.scales.x.min = xMin;
  charts.middle.options.scales.x.max = xMax;
  charts.bottom.options.scales.x.min = xMin;
  charts.bottom.options.scales.x.max = xMax;

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
      return `${topLabel}: ${val.toFixed(1)} percentile`;
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
    return `Decile ${state.decile} run: ${formatPct(val, 2)}`;
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

  charts.bottom.data.datasets = [
    {
      label: `Decile ${state.decile} run`,
      data: computed.bottomPoints,
      backgroundColor: computed.bottomPoints.map((p) => (p.y >= 0 ? "rgba(24, 116, 63, 0.72)" : "rgba(160, 60, 45, 0.72)")),
      borderColor: computed.bottomPoints.map((p) => (p.y >= 0 ? "#18743f" : "#a03c2d")),
      borderWidth: 1,
      barThickness: 8,
      maxBarThickness: 12,
    },
  ];

  charts.top.update();
  charts.middle.update();
  charts.bottom.update();

  renderDecileTable(computed.decileStats);

  if (computed.sampleSize === 0) {
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

  dom.decileSelect.addEventListener("change", () => {
    state.decile = Number(dom.decileSelect.value);
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
    dom.decileSelect.value = String(state.decile);
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
