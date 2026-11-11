const MAX_LIST_ITEMS = 8;
const COS_LATITUDE = Math.cos(20 * Math.PI / 180);
const MAX_ZOOM = 80;
const CLUSTER_RADIUS_PX = 50;
const CLUSTER_RADIUS_MIN_PX = 20;
const STACK_LIST_LIMIT = 150;
const ROAD_HIT_PX = 9;
const INCIDENT_HIT_PX = 9;
const SHIELD_W = 30;
const SHIELD_H = 32;
const DESKTOP_PANEL_QUERY = window.matchMedia("(min-width: 901px)");
const PERIODS = [
  ["madrugada", "Madrug."],
  ["manha", "Manhã"],
  ["tarde", "Tarde"],
  ["noite", "Noite"]
];

const state = {
  boundary: null,
  prfIncidents: [],
  filteredIncidents: [],
  filteredExceptRoad: [],
  stateVictims: [],
  roads: [],
  roadTotals: new Map(),
  viewBox: null,
  baseViewBox: null,
  selectedIncident: null,
  hoverRoad: "",
  hoverMarker: null,
  chips: { severity: new Set(), period: new Set(), weather: new Set() },
  clusterEnabled: true,
  clusterCache: null,
  filterVersion: 0,
  stack: null,
  shields: [],
  drag: null,
  animation: 0,
  colors: {},
  toastTimer: null,
  year: null,
  years: [],
  yearToken: 0
};

const elements = {};

document.addEventListener("DOMContentLoaded", () => {
  [
    "map-svg", "municipalities", "roads", "markers", "map-canvas", "map-stage", "map-loading", "map-empty",
    "map-status", "map-title", "map-caption", "incident-detail", "incident-list",
    "list-count", "metric-occurrences", "metric-occurrences-note", "metric-fatalities", "metric-injured",
    "road-filter", "type-filter", "cause-filter", "severity-chips", "period-chips", "weather-chips",
    "filter-count", "cluster-toggle",
    "search", "road-ranking", "state-victims", "state-data-through", "municipality-list",
    "toast", "reset-filters", "zoom-in", "zoom-out", "zoom-reset", "road-tooltip", "road-panel", "theme-toggle",
    "year-picker", "year-eyebrow", "year-note", "state-summary-label", "trend-chart", "trend-foot"
  ].forEach((id) => { elements[id] = document.getElementById(id); });

  readThemeColors();
  bindSidebarTabs();
  bindTopNav();
  bindEvents();
  loadBoundary();
  loadRoads();
  loadYears();
  window.addEventListener("hashchange", () => {
    const year = yearFromHash();
    if (year && year !== state.year && state.years.some((item) => item.year === year)) selectYear(year, { updateHash: false });
  });
});

/* ---------- Theme ---------- */

function readThemeColors() {
  const styles = getComputedStyle(document.documentElement);
  const read = (name) => styles.getPropertyValue(name).trim();
  state.colors = {
    danger: read("--danger"),
    warn: read("--warn"),
    ok: read("--ok"),
    markerStroke: read("--marker-stroke"),
    shieldFill: read("--shield-fill"),
    shieldInk: read("--shield-ink"),
    shieldBorder: read("--shield-border"),
    highlight: read("--road-hi-fill"),
    highlightDark: read("--road-hi-casing"),
    surface: read("--surface"),
    ink: read("--ink")
  };
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", read("--bg"));
}

function setTheme(theme, persist) {
  document.documentElement.setAttribute("data-theme", theme);
  if (persist) {
    try { localStorage.setItem("mea-theme", theme); } catch (error) { /* storage unavailable */ }
  }
  readThemeColors();
  elements["theme-toggle"].setAttribute("aria-pressed", String(theme === "dark"));
  state.clusterCache = null;
  drawNow();
}

function storedTheme() {
  try { return localStorage.getItem("mea-theme"); } catch (error) { return null; }
}

/* ---------- Events ---------- */

function bindEvents() {
  ["search", "type-filter", "cause-filter"].forEach((id) => {
    elements[id].addEventListener(id === "search" ? "input" : "change", applyFilters);
  });
  [["severity-chips", "severity"], ["period-chips", "period"], ["weather-chips", "weather"]].forEach(([id, key]) => {
    elements[id].addEventListener("click", (event) => {
      const chip = event.target.closest(".chip[data-value]");
      if (!chip) return;
      const set = state.chips[key];
      if (set.has(chip.dataset.value)) set.delete(chip.dataset.value);
      else set.add(chip.dataset.value);
      chip.setAttribute("aria-pressed", String(set.has(chip.dataset.value)));
      applyFilters();
    });
  });
  elements["cluster-toggle"].addEventListener("click", () => {
    state.clusterEnabled = !state.clusterEnabled;
    elements["cluster-toggle"].classList.toggle("is-on", state.clusterEnabled);
    elements["cluster-toggle"].setAttribute("aria-pressed", String(state.clusterEnabled));
    notify(state.clusterEnabled ? "Ocorrências próximas agrupadas." : "Mostrando cada ocorrência individualmente.");
    drawNow();
  });
  elements["road-filter"].addEventListener("change", () => selectRoad(elements["road-filter"].value, { fit: true }));
  elements["reset-filters"].addEventListener("click", resetFilters);
  elements["zoom-in"].addEventListener("click", () => zoomBy(1.4));
  elements["zoom-out"].addEventListener("click", () => zoomBy(1 / 1.4));
  elements["zoom-reset"].addEventListener("click", resetMapView);
  elements["markers"].addEventListener("pointerdown", onMapPointerDown);
  elements["markers"].addEventListener("pointermove", onMapPointerMove);
  elements["markers"].addEventListener("pointerup", onMapPointerUp);
  elements["markers"].addEventListener("pointercancel", endMapDrag);
  elements["markers"].addEventListener("pointerleave", () => { if (!state.drag) clearHover(); });
  elements["markers"].addEventListener("wheel", onMapWheel, { passive: false });
  elements["theme-toggle"].addEventListener("click", () => {
    const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    setTheme(next, true);
  });
  elements["theme-toggle"].setAttribute("aria-pressed", String(document.documentElement.getAttribute("data-theme") === "dark"));
  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (event) => {
      if (!storedTheme()) setTheme(event.matches ? "dark" : "light", false);
    });
  }
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (state.selectedIncident) {
      clearIncident();
    } else if (selectedRoad()) {
      selectRoad("", { fit: true });
    }
  });
  window.addEventListener("resize", drawNow);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(drawNow);
}

/* ---------- Data loading ---------- */

async function loadBoundary() {
  elements["map-loading"].hidden = false;
  try {
    const response = await fetch("./data/minas-gerais-municipios.geojson");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const geojson = await response.json();
    if (!geojson || geojson.type !== "FeatureCollection" || !Array.isArray(geojson.features) || !geojson.features.length) {
      throw new Error("Arquivo geográfico inválido.");
    }
    state.boundary = geojson;
    renderBoundary(geojson);
    elements["map-loading"].hidden = true;
    drawNow();
  } catch (error) {
    elements["map-loading"].textContent = "Não foi possível carregar o mapa vetorial.";
    elements["map-status"].textContent = `Erro ao carregar o limite de Minas Gerais: ${error.message}`;
    elements["map-status"].hidden = false;
    elements["map-status"].classList.add("status-error");
    notify("Não foi possível carregar o mapa. Verifique a conexão e tente atualizar a página.", "error");
  }
}

async function loadRoads() {
  try {
    const response = await fetch("./data/minas-gerais-brs.geojson");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const geojson = await response.json();
    const features = (geojson.features || []).filter((feature) => (
      feature && feature.properties && feature.geometry && feature.geometry.type === "MultiLineString"
    )).map((feature) => {
      const lines = feature.geometry.coordinates.map((line) => {
        const points = line.map(([longitude, latitude]) => toMapCoordinates(longitude, latitude));
        return { points, bbox: bboxOf(points) };
      });
      return { road: feature.properties.road, kind: feature.properties.kind || "road", lines, bbox: mergeBoxes(lines.map((line) => line.bbox)) };
    });
    state.roads = features.filter((feature) => feature.kind === "road");
    renderRoads();
    drawNow();
  } catch (error) {
    console.error("Não foi possível carregar o traçado das BRs.", error);
    notify("Não foi possível carregar o traçado das rodovias. Os pontos continuam disponíveis.", "error");
  }
}

/* ---------- Years ---------- */

async function loadYears() {
  let manifest = null;
  try {
    const response = await fetch("./data/years.json", { cache: "no-cache" });
    if (response.ok) manifest = await response.json();
  } catch (error) {
    console.error("Não foi possível carregar a lista de anos.", error);
  }
  const years = manifest && Array.isArray(manifest.years) && manifest.years.length
    ? manifest.years.filter((item) => Number.isInteger(item.year)).sort((a, b) => a.year - b.year)
    : [{ year: 2026 }];
  state.years = years;
  const range = document.getElementById("year-range");
  if (range && years.length) {
    range.textContent = years.length > 1 ? `de ${years[0].year} a ${years[years.length - 1].year}` : `em ${years[0].year}`;
  }
  const requested = yearFromHash();
  const latest = years[years.length - 1].year;
  renderYearPicker();
  bindInsights();
  bindStatsPeriod();
  renderStatsPeriodChips();
  watchStatsVisibility();
  await selectYear(years.some((item) => item.year === requested) ? requested : latest, { updateHash: false });
}

function yearFromHash() {
  const match = /(?:^|[#&])ano=(\d{4})/.exec(window.location.hash);
  return match ? Number(match[1]) : null;
}

function yearInfo(year) {
  return (state.years || []).find((item) => item.year === year) || { year };
}

function isPartialYear(info) {
  return Boolean(info.prfThrough) && !info.prfThrough.endsWith("-12-31");
}

function renderYearPicker() {
  const picker = elements["year-picker"];
  picker.innerHTML = state.years.map((info) => {
    const partial = isPartialYear(info);
    const note = info.incidents
      ? `${formatInteger(info.incidents)} ocorr.${partial ? ` · até ${shortMonth(info.prfThrough)}` : ""}`
      : "";
    return `<button type="button" class="year-option" role="radio" data-year="${info.year}" aria-checked="${info.year === state.year}" tabindex="${info.year === state.year ? 0 : -1}">
      <b>${info.year}${partial ? '<i class="year-partial" title="Ano em andamento">parcial</i>' : ""}</b>
      ${note ? `<small>${note}</small>` : ""}
    </button>`;
  }).join("");
  picker.querySelectorAll("[data-year]").forEach((button, index, all) => {
    button.addEventListener("click", () => selectYear(Number(button.dataset.year)));
    button.addEventListener("keydown", (event) => {
      const offset = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (!offset) return;
      event.preventDefault();
      const next = all[(index + offset + all.length) % all.length];
      next.focus();
      selectYear(Number(next.dataset.year));
    });
  });
}

/* ---------- Statistics section ---------- */

const WEEKDAYS_SHORT = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const WEEKDAYS_LONG = ["Domingo", "Segunda-feira", "Terça-feira", "Quarta-feira", "Quinta-feira", "Sexta-feira", "Sábado"];
const MONTHS_SHORT = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
const MONTHS_LONG = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
const PERIOD_LABELS = { madrugada: "Madrugada", manha: "Manhã", tarde: "Tarde", noite: "Noite" };

function dateParts(date, time) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date || "");
  const hour = Number(String(time || "").slice(0, 2));
  return {
    month: match ? Number(match[2]) - 1 : -1,
    weekday: match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay() : -1,
    hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : -1
  };
}

function bindInsights() {
  document.querySelectorAll(".trend-toggle [data-measure]").forEach((button) => {
    button.addEventListener("click", () => {
      state.trendMeasure = button.dataset.measure;
      pressOnly(button);
      renderTrend();
    });
  });
  document.querySelectorAll("#stretch-toggle [data-sort]").forEach((button) => {
    button.addEventListener("click", () => {
      state.stretchSort = button.dataset.sort;
      pressOnly(button);
      renderStretches(state.statsIncidents || []);
    });
  });
}

function pressOnly(button) {
  button.parentElement.querySelectorAll("button").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
}

/* ---------- Statistics period (independent from the map) ---------- */

/*
 * The statistics section has its own date range. "map" mode follows the year shown on the
 * map; any other range loads the needed yearly files and never touches the map's data.
 */
function statsBounds() {
  const years = (state.years || []).map((info) => info.year).sort((a, b) => a - b);
  const latest = (state.years || []).reduce((best, info) => (!best || info.year > best.year ? info : best), null);
  return {
    min: years.length ? `${years[0]}-01-01` : "2022-01-01",
    max: latest && latest.prfThrough ? latest.prfThrough : `${new Date().getFullYear()}-12-31`
  };
}

function currentStatsRange() {
  const period = state.statsPeriod || { mode: "map" };
  if (period.mode === "map") {
    const info = yearInfo(state.year);
    return {
      mode: "map",
      from: `${state.year}-01-01`,
      to: info.prfThrough || `${state.year}-12-31`,
      label: `${state.year}${isPartialYear(info) ? ` (até ${formatDate(info.prfThrough)})` : ""} · mesmo ano do mapa`
    };
  }
  const { max } = statsBounds();
  const to = period.to > max ? max : period.to;
  const label = period.label || `${formatDate(period.from)} a ${formatDate(to)}`;
  return { mode: period.mode, from: period.from, to, label };
}

function bindStatsPeriod() {
  const chips = document.getElementById("stats-period-chips");
  chips.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-period]");
    if (!chip) return;
    const value = chip.dataset.period;
    const { min, max } = statsBounds();
    if (value === "map") setStatsPeriod({ mode: "map" });
    else if (value === "all") setStatsPeriod({ mode: "all", from: min, to: max, label: `Todos os anos (${min.slice(0, 4)}–${max.slice(0, 4)})` });
    else if (value === "12m") setStatsPeriod({ mode: "12m", from: twelveMonthsBefore(max), to: max, label: `Últimos 12 meses publicados (até ${formatDate(max)})` });
    else setStatsPeriod({ mode: `year-${value}`, from: `${value}-01-01`, to: `${value}-12-31`, label: value });
  });
  ["stats-from", "stats-to"].forEach((id) => {
    document.getElementById(id).addEventListener("change", () => {
      const from = document.getElementById("stats-from").value;
      const to = document.getElementById("stats-to").value;
      if (!from || !to) return;
      if (from > to) {
        notify("A data inicial precisa ser anterior à final.", "error");
        return;
      }
      setStatsPeriod({ mode: "custom", from, to });
    });
  });
}

function renderStatsPeriodChips() {
  const chips = document.getElementById("stats-period-chips");
  const years = (state.years || []).map((info) => info.year).sort((a, b) => a - b);
  const options = [["map", "Ano do mapa"], ...years.map((year) => [String(year), String(year)]), ["all", "Todos os anos"], ["12m", "Últimos 12 meses"]];
  const mode = (state.statsPeriod || { mode: "map" }).mode;
  chips.innerHTML = options.map(([value, label]) => {
    const active = mode === value || mode === `year-${value}`;
    return `<button type="button" class="chip period-chip" data-period="${value}" aria-pressed="${active}">${label}</button>`;
  }).join("");
  const { min, max } = statsBounds();
  const range = currentStatsRange();
  ["stats-from", "stats-to"].forEach((id) => {
    const input = document.getElementById(id);
    input.min = min;
    input.max = max;
  });
  document.getElementById("stats-from").value = range.from < min ? min : range.from;
  document.getElementById("stats-to").value = range.to > max ? max : range.to;
}

function setStatsPeriod(period) {
  state.statsPeriod = period;
  renderStatsPeriodChips();
  renderInsights();
}

/* First day of the 12-month window that ends on `isoDate` (e.g. 2026-09-30 -> 2025-10-01). */
function twelveMonthsBefore(isoDate) {
  const [year, month] = isoDate.split("-").map(Number);
  return month === 12 ? `${year}-01-01` : `${year - 1}-${String(month + 1).padStart(2, "0")}-01`;
}

const normalizedYearCache = new Map();
async function getYearIncidents(year) {
  if (!normalizedYearCache.has(year)) {
    const promise = loadYearFile("prf", year).then((snapshot) => normalizePrfSnapshot(snapshot, year));
    promise.catch(() => normalizedYearCache.delete(year));
    normalizedYearCache.set(year, promise);
  }
  return normalizedYearCache.get(year);
}

function renderInsights() {
  if (!document.getElementById("kpi-row")) return;
  const range = currentStatsRange();
  if (range.mode === "map") {
    renderStats(state.filteredIncidents, range);
    return;
  }
  loadStatsRange(range);
}

async function loadStatsRange(range) {
  const token = (state.statsToken || 0) + 1;
  state.statsToken = token;
  const years = (state.years || []).map((info) => info.year)
    .filter((year) => `${year}-12-31` >= range.from && `${year}-01-01` <= range.to);
  document.getElementById("insights-scope").textContent = `${range.label} · carregando…`;
  let incidents;
  try {
    incidents = (await Promise.all(years.map(getYearIncidents))).flat();
  } catch (error) {
    if (token !== state.statsToken) return;
    console.error("Não foi possível carregar os anos do período.", error);
    document.getElementById("insights-scope").textContent = `${range.label} · não foi possível carregar os dados.`;
    return;
  }
  if (token !== state.statsToken) return;
  const spec = state.filterSpec;
  const inRange = incidents.filter((incident) => incident.date >= range.from && incident.date <= range.to);
  const base = spec ? inRange.filter((incident) => spec.baseMatches(incident) && (!spec.road || incident.road === spec.road)) : inRange;
  const filtered = spec && spec.weather.size ? base.filter((incident) => spec.weather.has(incident.weather)) : base;
  renderStats(filtered, range);
}

function renderStats(incidents, range) {
  state.statsIncidents = incidents;
  state.statsRange = range;
  const road = selectedRoad();
  const filters = Number(elements["filter-count"].textContent) - (road ? 1 : 0);
  document.getElementById("insights-scope").textContent = [
    range.label,
    road || "todas as BRs",
    filters > 0 ? `${filters} ${filters === 1 ? "filtro ativo" : "filtros ativos"}` : "sem filtros",
    `${formatInteger(incidents.length)} ${incidents.length === 1 ? "ocorrência" : "ocorrências"}`
  ].join(" · ");
  renderKpis(incidents, range);
  renderTrend();
  renderMonths(incidents, range);
  renderStretches(incidents);
  renderCities(incidents);
  renderWeatherStats(incidents);
  renderHeatmap(incidents);
  renderTypeStats(incidents);
  renderCauseStats(incidents);
}

function emptyBlock(message = "Sem ocorrências para os filtros atuais.") {
  return `<p class="empty-inline">${message}</p>`;
}

function renderKpis(incidents, range) {
  const row = document.getElementById("kpi-row");
  if (!incidents.length) {
    row.innerHTML = ["Letalidade", "Dia mais crítico", "Horário de pico", "Mês com mais mortes"]
      .map((label) => `<div class="kpi"><span>${label}</span><strong>—</strong><small>sem dados</small></div>`).join("");
    return;
  }
  const deaths = sumOf(incidents, (incident) => incident.deaths);
  const byWeekday = countBy(incidents, (incident) => incident.weekday, 7);
  const byHour = countBy(incidents, (incident) => incident.hour, 24);
  const deathsByMonth = new Map();
  incidents.forEach((incident) => {
    if (incident.month < 0) return;
    const key = incident.date.slice(0, 7);
    deathsByMonth.set(key, (deathsByMonth.get(key) || 0) + incident.deaths);
  });
  const multiYear = range.from.slice(0, 4) !== range.to.slice(0, 4);
  const [topMonthKey, topMonthDeaths] = [...deathsByMonth.entries()].sort((a, b) => b[1] - a[1])[0] || ["", 0];
  const topMonthLabel = topMonthKey
    ? `${MONTHS_LONG[Number(topMonthKey.slice(5, 7)) - 1]}${multiYear ? ` de ${topMonthKey.slice(0, 4)}` : ""}`
    : "—";
  const topDay = argMax(byWeekday);
  const topHour = argMax(byHour);
  const kpis = [
    ["Letalidade", formatDecimal(deaths / incidents.length * 100), "mortes a cada 100 ocorrências"],
    ["Dia mais crítico", WEEKDAYS_LONG[topDay], `${formatInteger(byWeekday[topDay])} ocorrências · ${formatPercent(byWeekday[topDay] / incidents.length)}`],
    ["Horário de pico", `${String(topHour).padStart(2, "0")}h–${String((topHour + 1) % 24).padStart(2, "0")}h`, `${formatInteger(byHour[topHour])} ocorrências nessa hora`],
    ["Mês com mais mortes", topMonthDeaths ? topMonthLabel : "—", topMonthDeaths ? `${formatInteger(topMonthDeaths)} mortes` : "nenhuma morte registrada"]
  ];
  row.innerHTML = kpis.map(([label, value, note]) => `<div class="kpi"><span>${label}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small></div>`).join("");
}

/* Column chart shared by the year and month cards. */
function columnChart(chart, columns, { clickable = false } = {}) {
  const maximum = Math.max(1, ...columns.map((column) => column.value || 0));
  chart.innerHTML = columns.map((column) => {
    const tag = clickable ? "button" : "div";
    const attrs = clickable ? `type="button" data-key="${escapeHtml(column.key)}"` : 'tabindex="0"';
    return `<${tag} ${attrs} role="listitem" class="col-bar${column.partial ? " is-partial" : ""}${column.peak ? " is-peak" : ""}"
      aria-current="${Boolean(column.current)}" data-tip="${column.tip.map(escapeHtml).join("&#10;")}" aria-label="${escapeHtml(column.tip.join(". "))}">
      <b>${escapeHtml(column.label)}</b>
      <i style="height:${column.value ? Math.max(3, column.value / maximum * 100) : 0}%"></i>
    </${tag}>`;
  }).join("");
  let axis = chart.nextElementSibling;
  if (!axis || !axis.classList.contains("col-axis")) {
    axis = document.createElement("div");
    axis.className = "col-axis";
    axis.setAttribute("aria-hidden", "true");
    chart.after(axis);
  }
  axis.innerHTML = columns.map((column) => `<span class="${column.current ? "is-current" : ""}">${escapeHtml(column.axis)}</span>`).join("");
}

/*
 * Annual evolution, following the statistics period and the sidebar filters.
 * - Period inside one calendar year: every year is compared over the same day window
 *   (e.g. Jan 1 – Sep 30), which keeps the ongoing year comparable.
 * - Period across years: only the years in the period, each clipped to it.
 * Other years' files are only downloaded once the statistics section is near the screen.
 */
function trendWindows(range) {
  const years = (state.years || []).map((info) => info.year).sort((a, b) => a - b);
  const { max } = statsBounds();
  const sameYear = range.from.slice(0, 4) === range.to.slice(0, 4);
  if (sameYear) {
    const fromDay = range.from.slice(5);
    const toDay = range.to.slice(5);
    return {
      sameYear,
      fromDay,
      toDay,
      windows: years.map((year) => {
        const to = `${year}-${toDay}`;
        return { year, from: `${year}-${fromDay}`, to: to > max ? max : to, partial: to > max };
      }).filter((window) => window.from <= window.to)
    };
  }
  return {
    sameYear,
    windows: years
      .filter((year) => `${year}-12-31` >= range.from && `${year}-01-01` <= range.to)
      .map((year) => {
        const from = range.from > `${year}-01-01` ? range.from : `${year}-01-01`;
        const to = [range.to, `${year}-12-31`, max].sort()[0];
        return { year, from, to, partial: from !== `${year}-01-01` || to !== `${year}-12-31` };
      })
  };
}

async function renderTrend() {
  const chart = elements["trend-chart"];
  const subtitle = document.getElementById("trend-subtitle");
  const range = state.statsRange;
  if (!range || !(state.years || []).length) return;
  const { sameYear, fromDay, toDay, windows } = trendWindows(range);
  const fullYear = sameYear && fromDay === "01-01" && toDay === "12-31";
  const windowLabel = sameYear && !fullYear ? `${fromDay.split("-").reverse().join("/")} a ${toDay.split("-").reverse().join("/")}` : "";
  const filtersActive = Number(elements["filter-count"].textContent) > 0;
  subtitle.textContent = [
    sameYear ? (fullYear ? "Ano inteiro, ano a ano" : `Mesmo período (${windowLabel}) em cada ano`) : "Anos do período escolhido",
    filtersActive ? "com os filtros aplicados" : "sem filtros"
  ].join(" · ");

  if (!state.statsVisible) {
    chart.innerHTML = emptyBlock("O gráfico é carregado ao chegar nesta seção.");
    return;
  }
  const token = (state.trendToken || 0) + 1;
  state.trendToken = token;
  chart.setAttribute("aria-busy", "true");
  let perYear;
  try {
    perYear = await Promise.all(windows.map((window) => getYearIncidents(window.year)));
  } catch (error) {
    if (token === state.trendToken) chart.innerHTML = emptyBlock("Não foi possível carregar os anos.");
    return;
  }
  if (token !== state.trendToken) return;
  chart.removeAttribute("aria-busy");

  const spec = state.filterSpec;
  const values = windows.map((window, index) => {
    let count = 0;
    let deaths = 0;
    for (const incident of perYear[index]) {
      if (incident.date < window.from || incident.date > window.to) continue;
      if (spec && (!spec.baseMatches(incident) || (spec.road && incident.road !== spec.road) || (spec.weather.size && !spec.weather.has(incident.weather)))) continue;
      count += 1;
      deaths += incident.deaths;
    }
    return { ...window, count, deaths };
  });

  const measure = state.trendMeasure || "deaths";
  const valueOf = (item) => (measure === "rate" ? (item.count ? item.deaths / item.count * 100 : 0) : measure === "incidents" ? item.count : item.deaths);
  const selectedYears = new Set(windows
    .filter((window) => `${window.year}-12-31` >= range.from && `${window.year}-01-01` <= range.to)
    .map((window) => window.year));
  columnChart(chart, values.map((item) => {
    const value = valueOf(item);
    return {
      key: String(item.year),
      value,
      label: measure === "rate" ? formatDecimal(value) : formatInteger(value),
      axis: `${item.year}${item.partial ? "*" : ""}`,
      partial: item.partial,
      current: selectedYears.has(item.year),
      tip: [
        `${item.year} · ${formatDate(item.from)} a ${formatDate(item.to)}`,
        `${formatInteger(item.deaths)} mortes · ${formatInteger(item.count)} ocorrências`,
        `${item.count ? formatDecimal(item.deaths / item.count * 100) : "—"} mortes a cada 100 ocorrências`
      ]
    };
  }));

  const partial = values.filter((item) => item.partial);
  const notes = [];
  if (partial.length) {
    const span = (item) => (item.from.endsWith("-01-01") ? `${item.year} até ${formatDate(item.to)}` : `${item.year} de ${formatDate(item.from)} a ${formatDate(item.to)}`);
    notes.push(`* Ano incompleto: ${partial.map(span).join("; ")}.`);
  }
  if (values.length > 1) {
    const sorted = [...values].sort((a, b) => valueOf(b) - valueOf(a));
    const word = measure === "incidents" ? "Mais ocorrências" : measure === "rate" ? "Maior letalidade" : "Mais mortes";
    const least = measure === "incidents" ? "menos ocorrências" : measure === "rate" ? "menor letalidade" : "menos mortes";
    notes.push(`${word}: ${sorted[0].year}; ${least}: ${sorted[sorted.length - 1].year}.`);
  }
  elements["trend-foot"].textContent = notes.join(" ");
}

function watchStatsVisibility() {
  const section = document.getElementById("estatisticas");
  if (!section) {
    state.statsVisible = true;
    return;
  }
  const reveal = () => {
    if (state.statsVisible) return;
    state.statsVisible = true;
    window.removeEventListener("scroll", check);
    if (observer) observer.disconnect();
    renderTrend();
  };
  // Scroll check as a fallback for browsers or embedded views where the observer does not fire.
  const check = () => {
    if (section.getBoundingClientRect().top < window.innerHeight + 600) reveal();
  };
  const observer = "IntersectionObserver" in window
    ? new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) reveal(); }, { rootMargin: "600px 0px" })
    : null;
  if (observer) observer.observe(section);
  window.addEventListener("scroll", check, { passive: true });
  check();
}

/*
 * Up to 24 months: one column per month in order. Longer ranges: totals per calendar month
 * (all Januaries together, etc.), which keeps the chart readable.
 */
function renderMonths(incidents, range) {
  const chart = document.getElementById("month-chart");
  const subtitle = document.getElementById("months-subtitle");
  const months = [];
  let cursor = range.from.slice(0, 7);
  const last = range.to.slice(0, 7);
  while (cursor <= last && months.length < 240) {
    months.push(cursor);
    const [year, month] = cursor.split("-").map(Number);
    cursor = month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`;
  }
  const published = statsBounds().max.slice(0, 7);
  const byKey = new Map();
  incidents.forEach((incident) => {
    const key = incident.date.slice(0, 7);
    const entry = byKey.get(key) || { count: 0, deaths: 0 };
    entry.count += 1;
    entry.deaths += incident.deaths;
    byKey.set(key, entry);
  });

  if (months.length <= 24) {
    const multiYear = months[0].slice(0, 4) !== months[months.length - 1].slice(0, 4);
    const values = months.map((key) => byKey.get(key) || { count: 0, deaths: 0 });
    const peak = argMax(values.map((value) => value.count));
    subtitle.textContent = values[peak] && values[peak].count
      ? `Ocorrências por mês · pico em ${MONTHS_LONG[Number(months[peak].slice(5, 7)) - 1].toLowerCase()}${multiYear ? ` de ${months[peak].slice(0, 4)}` : ""}`
      : "Ocorrências por mês";
    chart.classList.toggle("is-dense", months.length > 14);
    columnChart(chart, months.map((key, index) => {
      const monthName = MONTHS_LONG[Number(key.slice(5, 7)) - 1];
      const missing = key > published;
      return {
        key,
        value: values[index].count,
        label: missing ? "" : formatInteger(values[index].count),
        // Year only on the first column and on each January, so the labels fit.
        axis: multiYear && (index === 0 || key.endsWith("-01"))
          ? `${MONTHS_SHORT[Number(key.slice(5, 7)) - 1]}/${key.slice(2, 4)}`
          : MONTHS_SHORT[Number(key.slice(5, 7)) - 1],
        peak: values[peak].count > 0 && index === peak,
        tip: missing
          ? [`${monthName} de ${key.slice(0, 4)}`, "Ainda sem dados publicados"]
          : [`${monthName} de ${key.slice(0, 4)}`, `${formatInteger(values[index].count)} ocorrências · ${formatInteger(values[index].deaths)} mortes`]
      };
    }));
    return;
  }

  const counts = new Array(12).fill(0);
  const deaths = new Array(12).fill(0);
  const yearsPerMonth = new Array(12).fill(0);
  months.forEach((key) => { if (key <= published) yearsPerMonth[Number(key.slice(5, 7)) - 1] += 1; });
  incidents.forEach((incident) => {
    if (incident.month < 0) return;
    counts[incident.month] += 1;
    deaths[incident.month] += incident.deaths;
  });
  const peak = argMax(counts);
  subtitle.textContent = `Soma por mês do ano no período${counts[peak] ? ` · mais ocorrências em ${MONTHS_LONG[peak].toLowerCase()}` : ""}`;
  chart.classList.remove("is-dense");
  columnChart(chart, MONTHS_SHORT.map((label, month) => ({
    key: String(month),
    value: counts[month],
    label: compactCount(counts[month]),
    axis: label,
    peak: counts[peak] > 0 && month === peak,
    tip: [
      `${MONTHS_LONG[month]} (${yearsPerMonth[month]} ${yearsPerMonth[month] === 1 ? "ano" : "anos"} no período)`,
      `${formatInteger(counts[month])} ocorrências · ${formatInteger(deaths[month])} mortes`
    ]
  })));
}

function computeStretches(incidents) {
  const bins = new Map();
  incidents.forEach((incident) => {
    if (!Number.isFinite(incident.kmValue)) return;
    const start = Math.floor(incident.kmValue / 10) * 10;
    const key = `${incident.road}|${start}`;
    const bin = bins.get(key) || { road: incident.road, start, count: 0, deaths: 0, cities: new Map(), points: [] };
    bin.count += 1;
    bin.deaths += incident.deaths;
    bin.cities.set(incident.city, (bin.cities.get(incident.city) || 0) + 1);
    bin.points.push([incident.x, incident.y]);
    bins.set(key, bin);
  });
  return [...bins.values()].map((bin) => ({
    ...bin,
    city: titleCase([...bin.cities.entries()].sort((a, b) => b[1] - a[1])[0][0])
  }));
}

function renderStretches(incidents) {
  const list = document.getElementById("stretch-list");
  const sort = state.stretchSort || "count";
  const stretches = computeStretches(incidents)
    .sort((a, b) => (sort === "deaths" ? b.deaths - a.deaths || b.count - a.count : b.count - a.count || b.deaths - a.deaths))
    .slice(0, 8);
  if (!stretches.length) {
    list.innerHTML = `<li>${emptyBlock()}</li>`;
    return;
  }
  list.innerHTML = stretches.map((spot, index) => `<li>
    <button type="button" class="rank-item" data-index="${index}" title="Ver este trecho no mapa">
      <em>${index + 1}</em>
      ${shieldHtml(spot.road)}
      <span class="rank-main"><strong>km ${spot.start}–${spot.start + 10}</strong><small>${escapeHtml(spot.city)}</small></span>
      <span class="rank-value"><b>${formatInteger(sort === "deaths" ? spot.deaths : spot.count)} ${sort === "deaths" ? (spot.deaths === 1 ? "morte" : "mortes") : "ocorr."}</b>
      <small>${sort === "deaths" ? `${formatInteger(spot.count)} ocorr.` : spot.deaths ? `${formatInteger(spot.deaths)} ${spot.deaths === 1 ? "morte" : "mortes"}` : ""}</small></span>
    </button>
  </li>`).join("");
  list.querySelectorAll("[data-index]").forEach((button) => {
    button.addEventListener("click", () => {
      const spot = stretches[Number(button.dataset.index)];
      if (selectedRoad() !== spot.road) selectRoad(spot.road, { fit: false });
      showOnMap(bboxOf(spot.points), 0.4);
    });
  });
}

function renderCities(incidents) {
  const list = document.getElementById("city-list");
  const groups = new Map();
  incidents.forEach((incident) => {
    const group = groups.get(incident.city) || { city: incident.city, count: 0, deaths: 0, points: [], roads: new Map() };
    group.count += 1;
    group.deaths += incident.deaths;
    group.points.push([incident.x, incident.y]);
    group.roads.set(incident.road, (group.roads.get(incident.road) || 0) + 1);
    groups.set(incident.city, group);
  });
  const cities = [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 8);
  if (!cities.length) {
    list.innerHTML = `<li>${emptyBlock()}</li>`;
    return;
  }
  list.innerHTML = cities.map((group, index) => {
    const roads = [...group.roads.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([road]) => road).join(", ");
    return `<li>
      <button type="button" class="rank-item" data-index="${index}" title="Ver este município no mapa">
        <em>${index + 1}</em>
        <span class="rank-city-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z"/><circle cx="12" cy="10" r="2.3"/></svg></span>
        <span class="rank-main"><strong>${escapeHtml(titleCase(group.city))}</strong><small>${escapeHtml(roads)}</small></span>
        <span class="rank-value"><b>${formatInteger(group.count)} ocorr.</b><small>${group.deaths ? `${formatInteger(group.deaths)} ${group.deaths === 1 ? "morte" : "mortes"}` : ""}</small></span>
      </button>
    </li>`;
  }).join("");
  list.querySelectorAll("[data-index]").forEach((button) => {
    button.addEventListener("click", () => showOnMap(coreBox(cities[Number(button.dataset.index)].points), 0.25));
  });
}

/* Bounding box of the points near the median, so one mis-geocoded record does not zoom out to the whole state. */
function coreBox(points) {
  const median = (values) => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const cx = median(points.map(([x]) => x));
  const cy = median(points.map(([, y]) => y));
  const near = points.filter(([x, y]) => Math.abs(x - cx) < 0.35 && Math.abs(y - cy) < 0.35);
  return bboxOf(near.length ? near : points);
}

function showOnMap(box, padding) {
  document.getElementById("map-canvas").scrollIntoView({ behavior: "smooth", block: "center" });
  fitToBox(box, true, padding, { minSize: 0.03 });
}

function statBars(container, rows, { onClick, isActive } = {}) {
  if (!rows.length) {
    container.innerHTML = emptyBlock();
    return;
  }
  const maximum = Math.max(...rows.map((row) => row.value)) || 1;
  container.innerHTML = rows.map((row, index) => {
    const tag = onClick ? "button" : "div";
    const active = isActive && isActive(row);
    return `<${tag} ${onClick ? `type="button" aria-pressed="${active}"` : ""} class="stat-bar${active ? " is-active" : ""}" data-index="${index}">
      <span class="stat-bar-top"><span title="${escapeHtml(row.label)}">${escapeHtml(row.label)}</span><b>${row.valueLabel} <small>${row.note || ""}</small></b></span>
      <span class="stat-track"><i class="${row.danger ? "danger" : ""}" style="width:${Math.max(2, row.value / maximum * 100)}%"></i></span>
    </${tag}>`;
  }).join("");
  if (onClick) {
    container.querySelectorAll("[data-index]").forEach((button) => {
      button.addEventListener("click", () => onClick(rows[Number(button.dataset.index)]));
    });
  }
}

function renderWeatherStats(incidents) {
  const groups = groupStats(incidents, (incident) => incident.weather);
  statBars(document.getElementById("weather-stats"), groups.slice(0, 8).map((group) => ({
    key: group.key,
    label: weatherLabel(group.key),
    value: group.count,
    valueLabel: formatInteger(group.count),
    note: `· ${formatDecimal(group.deaths / group.count * 100)} mortes/100`
  })));
}

function renderHeatmap(incidents) {
  const container = document.getElementById("week-heatmap");
  if (!incidents.length) {
    container.innerHTML = emptyBlock();
    return;
  }
  const periods = PERIODS.map(([key]) => key);
  const grid = Array.from({ length: 7 }, () => new Array(periods.length).fill(0));
  incidents.forEach((incident) => {
    const column = periods.indexOf(getTimePeriod(incident.time));
    if (incident.weekday >= 0 && column >= 0) grid[incident.weekday][column] += 1;
  });
  const maximum = Math.max(1, ...grid.flat());
  const order = [1, 2, 3, 4, 5, 6, 0];
  let html = '<span></span>' + periods.map((key) => `<span class="hm-col">${PERIOD_LABELS[key]}</span>`).join("");
  order.forEach((day) => {
    html += `<span class="hm-row">${WEEKDAYS_SHORT[day]}</span>`;
    grid[day].forEach((value, column) => {
      const strength = value / maximum;
      const mix = Math.round(6 + strength * 94);
      html += `<span class="hm-cell${mix > 55 ? " is-strong" : ""}" style="background:color-mix(in srgb, var(--accent) ${mix}%, var(--surface))"
        title="${WEEKDAYS_LONG[day]} · ${PERIOD_LABELS[periods[column]]}: ${formatInteger(value)} ocorrências">${formatInteger(value)}</span>`;
    });
  });
  container.innerHTML = html;
  let legend = container.nextElementSibling;
  if (!legend || !legend.classList.contains("heatmap-legend")) {
    legend = document.createElement("div");
    legend.className = "heatmap-legend";
    container.after(legend);
  }
  legend.innerHTML = `<span>menos</span><i aria-hidden="true"></i><span>mais</span>`;
}

function renderTypeStats(incidents) {
  const groups = groupStats(incidents, (incident) => incident.type)
    .filter((group) => group.count >= 20)
    .map((group) => ({ ...group, rate: group.deaths / group.count * 100 }))
    .sort((a, b) => b.rate - a.rate)
    .slice(0, 6);
  statBars(document.getElementById("type-stats"), groups.map((group) => ({
    label: group.key,
    value: group.rate,
    valueLabel: formatDecimal(group.rate),
    note: `· ${formatInteger(group.count)} ocorr.`,
    danger: true
  })));
}

function renderCauseStats(incidents) {
  const groups = groupStats(incidents, (incident) => incident.cause).slice(0, 6);
  statBars(document.getElementById("cause-stats"), groups.map((group) => ({
    label: group.key,
    value: group.count,
    valueLabel: formatInteger(group.count),
    note: `· ${formatPercent(group.count / incidents.length)}${group.deaths ? ` · ${formatInteger(group.deaths)} mortes` : ""}`
  })));
}

function groupStats(incidents, pick) {
  const groups = new Map();
  incidents.forEach((incident) => {
    const key = pick(incident);
    if (!key) return;
    const group = groups.get(key) || { key, count: 0, deaths: 0 };
    group.count += 1;
    group.deaths += incident.deaths;
    groups.set(key, group);
  });
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

function countBy(incidents, pick, size) {
  const counts = new Array(size).fill(0);
  incidents.forEach((incident) => {
    const index = pick(incident);
    if (index >= 0 && index < size) counts[index] += 1;
  });
  return counts;
}

function argMax(values) {
  return values.reduce((best, value, index) => (value > values[best] ? index : best), 0);
}

function updateYearPicker() {
  elements["year-picker"].querySelectorAll("[data-year]").forEach((button) => {
    const active = Number(button.dataset.year) === state.year;
    button.setAttribute("aria-checked", String(active));
    button.tabIndex = active ? 0 : -1;
    if (active) {
      // Keep the chosen year visible when the picker scrolls sideways (phones).
      const picker = elements["year-picker"];
      const left = button.offsetLeft - picker.offsetLeft;
      if (left < picker.scrollLeft || left + button.offsetWidth > picker.scrollLeft + picker.clientWidth) {
        picker.scrollLeft = left - (picker.clientWidth - button.offsetWidth) / 2;
      }
    }
  });
}

async function selectYear(year, { updateHash = true } = {}) {
  if (year === state.year && state.prfIncidents.length) return;
  const token = (state.yearToken || 0) + 1;
  state.yearToken = token;
  state.year = year;
  updateYearPicker();
  updateYearTexts();
  if (!state.statsPeriod || state.statsPeriod.mode === "map") renderStatsPeriodChips();
  if (updateHash) {
    try { history.replaceState(null, "", `#ano=${year}`); } catch (error) { /* file:// or sandbox */ }
  }
  elements["map-loading"].textContent = `Carregando ${year}…`;
  elements["map-loading"].hidden = false;
  elements["year-picker"].setAttribute("aria-busy", "true");

  const [prf, sejusp] = await Promise.allSettled([loadYearFile("prf", year), loadYearFile("sejusp", year)]);
  if (token !== state.yearToken) return; // another year was chosen meanwhile
  elements["year-picker"].removeAttribute("aria-busy");
  if (state.boundary) elements["map-loading"].hidden = true;

  if (prf.status === "fulfilled") {
    applyPrfSnapshot(prf.value);
  } else {
    console.error(`Não foi possível carregar a base da PRF de ${year}.`, prf.reason);
    state.prfIncidents = [];
    elements["map-empty"].hidden = false;
    elements["map-empty"].querySelector("strong").textContent = `Base da PRF de ${year} indisponível`;
    elements["map-empty"].querySelector("span").textContent = "Não foi possível carregar os dados de acidentes incluídos neste deploy.";
    elements["map-status"].textContent = `Não foi possível carregar a base da PRF de ${year}.`;
    elements["map-status"].hidden = false;
    applyFilters();
    notify(`Não foi possível carregar a base da PRF de ${year}.`, "error");
  }
  if (sejusp.status === "fulfilled") {
    applySejuspSnapshot(sejusp.value, year);
  } else {
    console.error(`Não foi possível carregar a base da SEJUSP de ${year}.`, sejusp.reason);
    state.stateVictims = [];
    elements["state-victims"].textContent = "—";
    elements["state-data-through"].textContent = `Não foi possível carregar a base estadual de ${year}.`;
    elements["municipality-list"].innerHTML = '<p class="empty-inline">Resumo estadual indisponível.</p>';
  }
}

const yearFileCache = new Map();
function loadYearFile(kind, year) {
  const key = `${kind}-${year}`;
  if (!yearFileCache.has(key)) {
    const request = fetch(`./data/${key}.json`).then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    });
    request.catch(() => yearFileCache.delete(key));
    yearFileCache.set(key, request);
  }
  return yearFileCache.get(key);
}

function updateYearTexts() {
  const year = state.year;
  const info = yearInfo(year);
  elements["state-summary-label"].textContent = `registros de vítimas · base ${year}`;
  elements["year-note"].textContent = isPartialYear(info)
    ? `${year} ainda em andamento: dados da PRF até ${formatDate(info.prfThrough)}.`
    : `Ano completo · dados oficiais da PRF e da SEJUSP.`;
}

function applyPrfSnapshot(snapshot) {
  const incidents = normalizePrfSnapshot(snapshot, state.year);
  state.prfIncidents = incidents;
  state.selectedIncident = null;
  state.stack = null;
  state.roadTotals = new Map();
  incidents.forEach((incident) => {
    const total = state.roadTotals.get(incident.road) || { count: 0, deaths: 0 };
    total.count += 1;
    total.deaths += incident.deaths;
    state.roadTotals.set(incident.road, total);
  });
  elements["map-status"].hidden = true;
  elements["map-empty"].hidden = true;
  populateFilters();
  applyFilters();
  renderRoads();
}

function applySejuspSnapshot(snapshot, year) {
  state.stateVictims = normalizeSejuspSnapshot(snapshot);
  renderStateSummary();
  const month = Number(snapshot.dataThrough);
  const monthName = Number.isInteger(month) && month >= 1 && month <= 12
    ? new Intl.DateTimeFormat("pt-BR", { month: "long" }).format(new Date(year, month - 1, 1))
    : "período não informado";
  elements["state-data-through"].textContent = `Base estadual de ${year} disponível até ${monthName}.`;
}

function shortMonth(isoDate) {
  const match = /^(\d{4})-(\d{2})/.exec(isoDate || "");
  if (!match) return "";
  return new Intl.DateTimeFormat("pt-BR", { month: "short" }).format(new Date(Number(match[1]), Number(match[2]) - 1, 1)).replace(".", "");
}

/* ---------- Map geometry ---------- */

function renderBoundary(geojson) {
  const allPoints = [];
  for (const feature of geojson.features) {
    collectCoordinates(feature.geometry, allPoints);
  }
  if (!allPoints.length) throw new Error("O mapa não contém coordenadas.");

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [longitude, latitude] of allPoints) {
    const [x, y] = toMapCoordinates(longitude, latitude);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const padX = (maxX - minX) * 0.035;
  const padY = (maxY - minY) * 0.025;
  state.baseViewBox = {
    x: minX - padX,
    y: minY - padY,
    width: maxX - minX + padX * 2,
    height: maxY - minY + padY * 2
  };
  state.viewBox = { ...state.baseViewBox };
  applyViewBox();

  elements["municipalities"].innerHTML = geojson.features.map((feature) => (
    `<path d="${geometryToPath(feature.geometry)}"></path>`
  )).join("");

  if (selectedRoad()) fitToRoad(selectedRoad(), false);
}

function renderRoads() {
  if (!state.roads.length) return;
  const order = [...state.roads].sort((a, b) => roadCount(a.road) - roadCount(b.road));
  elements["roads"].innerHTML = order.map((road) => {
    const d = road.lines.map((line) => line.points.map(([x, y], index) => (
      `${index ? "L" : "M"}${x.toFixed(4)},${y.toFixed(4)}`
    )).join("")).join("");
    return `<g class="road" data-road="${escapeHtml(road.road)}"><path class="road-casing" d="${d}"></path><path class="road-fill" d="${d}"></path></g>`;
  }).join("");
  updateRoadClasses();
}

function updateRoadClasses() {
  const selected = selectedRoad();
  const group = elements["roads"];
  group.classList.toggle("has-selection", Boolean(selected));
  group.querySelectorAll(".road").forEach((node) => {
    node.classList.toggle("is-selected", node.dataset.road === selected);
    node.classList.toggle("is-hover", node.dataset.road === state.hoverRoad);
  });
  const raise = (road) => {
    if (!road) return;
    const node = group.querySelector(`.road[data-road="${cssEscape(road)}"]`);
    if (node && node !== group.lastElementChild) group.appendChild(node);
  };
  raise(selected);
  raise(state.hoverRoad);
}

function collectCoordinates(geometry, result) {
  if (!geometry || !geometry.coordinates) return;
  const visit = (value) => {
    if (typeof value[0] === "number" && typeof value[1] === "number") {
      result.push(value);
      return;
    }
    value.forEach(visit);
  };
  visit(geometry.coordinates);
}

function geometryToPath(geometry) {
  const rings = [];
  const visit = (value) => {
    if (!Array.isArray(value) || !value.length) return;
    if (typeof value[0][0] === "number") {
      rings.push(value);
      return;
    }
    value.forEach(visit);
  };
  visit(geometry.coordinates);

  return rings.map((ring) => ring.map(([longitude, latitude], index) => {
    const [x, y] = toMapCoordinates(longitude, latitude);
    return `${index === 0 ? "M" : "L"}${x.toFixed(5)},${y.toFixed(5)}`;
  }).join(" ") + " Z").join(" ");
}

/* ---------- Snapshots ---------- */

function normalizePrfSnapshot(snapshot, year) {
  if (!snapshot || !Array.isArray(snapshot.incidents) || !snapshot.incidents.length) {
    throw new Error("A cópia estática da PRF está vazia ou em formato inválido.");
  }
  return snapshot.incidents.filter((incident) => (
    incident && typeof incident.date === "string" && incident.date.startsWith(String(year))
    && Number.isFinite(incident.latitude) && Number.isFinite(incident.longitude)
    && withinMinas(incident.latitude, incident.longitude)
  )).map((incident) => {
    const [x, y] = toMapCoordinates(incident.longitude, incident.latitude);
    return {
      ...incident,
      x,
      y,
      kmValue: parseFloat(String(incident.km || "").replace(",", ".")),
      ...dateParts(incident.date, incident.time),
      deaths: nonNegative(incident.deaths),
      minorInjuries: nonNegative(incident.minorInjuries),
      severeInjuries: nonNegative(incident.severeInjuries),
      people: nonNegative(incident.people)
    };
  });
}

function normalizeSejuspSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.byMunicipality)) {
    throw new Error("A cópia estática da SEJUSP está vazia ou em formato inválido.");
  }
  return snapshot.byMunicipality.filter((row) => (
    row && typeof row.city === "string" && Number.isFinite(row.victims) && row.victims >= 0
  )).map((row) => ({ city: row.city, victims: row.victims }));
}

/* ---------- Filters ---------- */

function populateFilters() {
  const roads = uniqueSorted(state.prfIncidents.map((incident) => incident.road));
  const types = uniqueSorted(state.prfIncidents.map((incident) => incident.type));
  const causes = uniqueSorted(state.prfIncidents.map((incident) => incident.cause));
  fillSelect(elements["road-filter"], roads, "Todas as BRs");
  fillSelect(elements["type-filter"], types, "Todos os tipos");
  fillSelect(elements["cause-filter"], causes, "Todas as causas");
  const weatherCounts = topCounts(state.prfIncidents, (incident) => incident.weather, 50);
  const available = new Set(weatherCounts.map(([weather]) => weather));
  [...state.chips.weather].forEach((weather) => { if (!available.has(weather)) state.chips.weather.delete(weather); });
  elements["weather-chips"].innerHTML = weatherCounts.map(([weather, count]) => `
    <button type="button" class="chip" data-value="${escapeHtml(weather)}" aria-pressed="${state.chips.weather.has(weather)}" title="${formatInteger(count)} ocorrências">
      ${escapeHtml(weatherLabel(weather))} <small class="chip-count">${formatInteger(count)}</small>
    </button>`).join("");
}

function weatherLabel(value) {
  return value === "Ignorado" ? "Não informado" : value;
}

function fillSelect(select, options, placeholder) {
  const previous = select.value;
  select.replaceChildren(new Option(placeholder, ""));
  options.forEach((value) => select.add(new Option(value, value)));
  select.disabled = options.length === 0;
  if (options.includes(previous)) select.value = previous;
}

function selectedRoad() {
  return elements["road-filter"].value;
}

function applyFilters() {
  const query = elements["search"].value.trim().toLocaleLowerCase("pt-BR");
  const road = selectedRoad();
  const type = elements["type-filter"].value;
  const cause = elements["cause-filter"].value;
  const { severity, period, weather } = state.chips;

  // Everything except weather and road; the weather card needs the breakdown before its own filter.
  const baseMatches = (incident) => {
    if (type && incident.type !== type) return false;
    if (cause && incident.cause !== cause) return false;
    if (period.size && !period.has(getTimePeriod(incident.time))) return false;
    if (severity.size && !severity.has(severityKey(incident))) return false;
    if (query && ![
      incident.road, incident.city, incident.cause, incident.type, incident.km
    ].some((value) => String(value).toLocaleLowerCase("pt-BR").includes(query))) return false;
    return true;
  };
  const base = state.prfIncidents.filter(baseMatches);
  state.weatherBase = base.filter((incident) => !road || incident.road === road);
  state.filterSpec = { baseMatches, road, weather };
  state.filteredExceptRoad = weather.size ? base.filter((incident) => weather.has(incident.weather)) : base;
  state.filteredIncidents = state.filteredExceptRoad
    .filter((incident) => !road || incident.road === road)
    .sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`));

  if (state.selectedIncident && !state.filteredIncidents.some((incident) => incident.id === state.selectedIncident.id)) {
    state.selectedIncident = null;
    state.stack = null;
  }
  if (state.stack && state.stack.listOpen) state.stack = null;
  state.filterVersion += 1;
  state.hoverMarker = null;
  const activeFilters = [query, road, type, cause].filter(Boolean).length + severity.size + period.size + weather.size;
  elements["filter-count"].hidden = activeFilters === 0;
  elements["filter-count"].textContent = String(activeFilters);
  updateSectionBadges({ severity: severity.size, period: period.size, weather: weather.size, "type-cause": [type, cause].filter(Boolean).length });
  renderMetrics();
  renderRoadRanking();
  renderRoadPanel();
  renderIncidentList();
  renderIncidentDetail();
  renderStateSummary();
  updateRoadClasses();
  renderInsights();
  drawNow();
}

function selectRoad(road, { fit = true } = {}) {
  elements["road-filter"].value = road || "";
  state.selectedIncident = null;
  applyFilters();
  if (fit) {
    if (road) fitToRoad(road, true);
    else resetMapView();
  }
}

function resetFilters() {
  elements["search"].value = "";
  elements["type-filter"].value = "";
  elements["cause-filter"].value = "";
  Object.values(state.chips).forEach((set) => set.clear());
  document.querySelectorAll(".chip[aria-pressed]").forEach((chip) => chip.setAttribute("aria-pressed", "false"));
  selectRoad("", { fit: true });
}

function updateSectionBadges(counts) {
  document.querySelectorAll("[data-badge]").forEach((badge) => {
    const count = counts[badge.dataset.badge] || 0;
    badge.hidden = count === 0;
    badge.textContent = String(count);
  });
}

/* ---------- Header navigation ---------- */

function bindTopNav() {
  const links = [...document.querySelectorAll(".top-nav [data-section]")];
  const sections = links.map((link) => document.getElementById(link.dataset.section)).filter(Boolean);
  if (!sections.length) return;
  const update = () => {
    // The current section is the last one whose top has passed the upper third of the screen.
    const line = window.innerHeight / 3;
    let current = sections[0].id;
    sections.forEach((section) => { if (section.getBoundingClientRect().top <= line) current = section.id; });
    links.forEach((link) => link.setAttribute("aria-current", String(link.dataset.section === current)));
  };
  let frame = 0;
  window.addEventListener("scroll", () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(update);
  }, { passive: true });
  window.addEventListener("resize", update);
  update();
}

/* ---------- Sidebar tabs ---------- */

function bindSidebarTabs() {
  const tabs = [...document.querySelectorAll(".side-tab")];
  const activate = (tab, focus) => {
    tabs.forEach((item) => {
      const selected = item === tab;
      item.setAttribute("aria-selected", String(selected));
      item.tabIndex = selected ? 0 : -1;
      document.getElementById(item.getAttribute("aria-controls")).hidden = !selected;
    });
    if (focus) tab.focus();
  };
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => activate(tab, false));
    tab.addEventListener("keydown", (event) => {
      const offset = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (!offset) return;
      event.preventDefault();
      activate(tabs[(index + offset + tabs.length) % tabs.length], true);
    });
  });
}

/* ---------- Panels & lists ---------- */

function renderMetrics() {
  const incidents = state.filteredIncidents;
  const road = selectedRoad();
  const deaths = sumOf(incidents, (incident) => incident.deaths);
  const injuries = sumOf(incidents, injuriesOf);
  elements["metric-occurrences"].textContent = formatInteger(incidents.length);
  elements["metric-occurrences-note"].textContent = road ? `registros da PRF na ${road} em ${state.year}` : `registros da PRF em MG em ${state.year}`;
  elements["metric-fatalities"].textContent = formatInteger(deaths);
  elements["metric-injured"].textContent = formatInteger(injuries);
  elements["map-title"].textContent = road || "Minas Gerais";
  elements["map-caption"].textContent = road
    ? "Rodovia selecionada · clique em outra BR ou pressione Esc para voltar"
    : "Passe o mouse sobre uma BR para destacá-la · clique para ver os dados dela";
  elements["map-empty"].hidden = state.prfIncidents.length > 0;
}

function renderRoadRanking() {
  const counts = new Map();
  state.filteredExceptRoad.forEach((incident) => counts.set(incident.road, (counts.get(incident.road) || 0) + 1));
  const roads = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (!roads.length) {
    elements["road-ranking"].innerHTML = '<p class="empty-inline">Nenhuma rodovia encontrada para os filtros atuais.</p>';
    return;
  }
  const maximum = roads[0][1] || 1;
  const active = selectedRoad();
  elements["road-ranking"].innerHTML = roads.map(([road, count]) => `
    <button class="road-rank-button ${active === road ? "active" : ""}" type="button" data-road="${escapeHtml(road)}" aria-pressed="${active === road}">
      ${shieldHtml(road)}
      <span class="road-rank-bar"><i style="width:${Math.max(4, count / maximum * 100)}%"></i></span>
      <span class="road-rank-count">${formatInteger(count)}</span>
    </button>`).join("");
  elements["road-ranking"].querySelectorAll("[data-road]").forEach((button) => {
    button.addEventListener("click", () => {
      const road = button.dataset.road;
      selectRoad(selectedRoad() === road ? "" : road, { fit: true });
    });
    button.addEventListener("mouseenter", () => setHoverRoad(button.dataset.road, null));
    button.addEventListener("mouseleave", () => setHoverRoad("", null));
  });
}

function renderRoadPanel() {
  const road = selectedRoad();
  const panel = elements["road-panel"];
  elements["map-stage"].classList.toggle("has-road", Boolean(road));
  if (!road) {
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }
  const incidents = state.filteredIncidents;
  const deaths = sumOf(incidents, (incident) => incident.deaths);
  const injuries = sumOf(incidents, injuriesOf);
  const totalAll = state.filteredExceptRoad.length || 1;
  const deathsAll = sumOf(state.filteredExceptRoad, (incident) => incident.deaths) || 1;
  const hasGeometry = state.roads.some((item) => item.road === road);

  let body;
  if (!incidents.length) {
    body = '<p class="empty-inline">Nenhuma ocorrência desta BR corresponde aos filtros atuais.</p>';
  } else {
    const hotspots = computeStretches(incidents).sort((a, b) => b.count - a.count || b.deaths - a.deaths).slice(0, 5);
    body = `
      <div class="road-stats">
        <div class="road-stat"><span>Ocorrências</span><strong>${formatInteger(incidents.length)}</strong></div>
        <div class="road-stat danger"><span>Mortes</span><strong>${formatInteger(deaths)}</strong></div>
        <div class="road-stat warn"><span>Feridos</span><strong>${formatInteger(injuries)}</strong></div>
      </div>
      <p class="road-share">Concentra <b>${formatPercent(incidents.length / totalAll)}</b> das ocorrências e <b>${formatPercent(deaths / deathsAll)}</b> das mortes registradas pela PRF em MG nos filtros atuais · <b>${formatDecimal(deaths / incidents.length * 100)}</b> mortes a cada 100 ocorrências.</p>
      ${hotspots.length ? `<section class="road-section">
        <h4>Trechos críticos (10 km)</h4>
        <div class="hotspot-list">${hotspots.map((spot, index) => `
          <button type="button" class="hotspot" data-hotspot="${index}">
            <em>${index + 1}</em>
            <div><strong>km ${spot.start}–${spot.start + 10}</strong><small>${escapeHtml(spot.city)}${spot.deaths ? ` · ${formatInteger(spot.deaths)} ${spot.deaths === 1 ? "morte" : "mortes"}` : ""}</small></div>
            <b>${formatInteger(spot.count)}</b>
          </button>`).join("")}
        </div>
      </section>` : ""}
      <a class="road-more" href="#estatisticas">Causas, horários, clima e municípios da ${escapeHtml(road)} nas estatísticas ↓</a>`;
    state.hotspots = hotspots;
  }

  panel.innerHTML = `
    <div class="road-panel-head">
      ${shieldHtml(road, true)}
      <div><strong>${escapeHtml(road)}</strong><span>${hasGeometry ? "Rodovia federal · trecho em Minas Gerais" : "Traçado indisponível no mapa"} · PRF ${state.year}</span></div>
      <button class="icon-button" type="button" id="road-panel-close" aria-label="Fechar e ver todas as BRs">×</button>
    </div>
    <div class="road-panel-body">${body}</div>`;
  panel.hidden = false;
  panel.querySelector("#road-panel-close").addEventListener("click", () => selectRoad("", { fit: true }));
  panel.querySelectorAll("[data-hotspot]").forEach((button) => {
    button.addEventListener("click", () => {
      const spot = state.hotspots[Number(button.dataset.hotspot)];
      if (spot) fitToBox(bboxOf(spot.points), true, 0.0);
    });
  });
}

function renderStateSummary() {
  const totalVictims = state.stateVictims.reduce((sum, row) => sum + row.victims, 0);
  elements["state-victims"].textContent = formatInteger(totalVictims);
  const query = elements["search"].value.trim().toLocaleLowerCase("pt-BR");
  const cities = state.stateVictims
    .filter((row) => !query || row.city.toLocaleLowerCase("pt-BR").includes(query))
    .sort((a, b) => b.victims - a.victims)
    .slice(0, 12);
  elements["municipality-list"].innerHTML = cities.length
    ? cities.map((row) => `<div class="municipality-row"><span>${escapeHtml(row.city)}</span><strong>${formatInteger(row.victims)}</strong></div>`).join("")
    : '<p class="empty-inline">Nenhum registro municipal para a busca.</p>';
}

function renderIncidentList() {
  const incidents = state.filteredIncidents.slice(0, MAX_LIST_ITEMS);
  elements["list-count"].textContent = `${formatInteger(state.filteredIncidents.length)} ${state.filteredIncidents.length === 1 ? "registro" : "registros"}`;
  if (!incidents.length) {
    elements["incident-list"].innerHTML = '<p class="empty-inline">Nenhuma ocorrência encontrada para os filtros atuais.</p>';
    return;
  }
  elements["incident-list"].innerHTML = incidents.map((incident) => {
    const selected = state.selectedIncident && state.selectedIncident.id === incident.id;
    return `<button type="button" class="incident-row ${selected ? "active" : ""}" data-id="${escapeHtml(incident.id)}">
      <i class="incident-row-dot" style="background:${incidentCssColor(incident)}"></i>
      <span class="incident-row-main"><strong>${escapeHtml(incident.road)} · ${escapeHtml(titleCase(incident.city))}</strong><span>${escapeHtml(incident.type)} · ${formatDate(incident.date)}</span></span>
      <span class="incident-row-time">${escapeHtml(formatTime(incident.time))}</span>
    </button>`;
  }).join("");
  elements["incident-list"].querySelectorAll("[data-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const incident = incidents.find((item) => String(item.id) === button.dataset.id);
      if (incident) selectIncident(incident, { focus: true });
    });
  });
}

function renderIncidentDetail() {
  const card = elements["incident-detail"];
  if (state.stack && state.stack.listOpen) {
    renderStackList(card, state.stack);
    return;
  }
  const incident = state.selectedIncident;
  if (!incident) {
    card.hidden = true;
    return;
  }
  const stack = state.stack && state.stack.items.length > 1 ? state.stack : null;
  card.hidden = false;
  card.innerHTML = `
    ${stack ? `<div class="stack-nav">
      <button type="button" class="stack-back" data-list aria-label="Voltar à lista">☰</button>
      <span>${stack.index + 1} de ${formatInteger(stack.items.length)} neste local</span>
      <div><button type="button" data-step="-1" aria-label="Ocorrência anterior" ${stack.index === 0 ? "disabled" : ""}>‹</button><button type="button" data-step="1" aria-label="Próxima ocorrência" ${stack.index === stack.items.length - 1 ? "disabled" : ""}>›</button></div>
    </div>` : ""}
    <div class="detail-head"><strong><i class="detail-badge" style="background:${incidentCssColor(incident)}"></i>${escapeHtml(incident.road)} · km ${escapeHtml(incident.km || "—")}</strong><button class="detail-close" type="button" aria-label="Fechar detalhes">×</button></div>
    <div class="detail-subtitle">${escapeHtml(titleCase(incident.city))} · ${formatDate(incident.date)} às ${escapeHtml(formatTime(incident.time) || "horário não informado")}</div>
    <div class="detail-grid">
      <div class="detail-item"><span>Tipo</span><strong title="${escapeHtml(incident.type)}">${escapeHtml(incident.type)}</strong></div>
      <div class="detail-item"><span>Classificação</span><strong title="${escapeHtml(incident.classification)}">${escapeHtml(incident.classification)}</strong></div>
      <div class="detail-item"><span>Causa registrada</span><strong title="${escapeHtml(incident.cause)}">${escapeHtml(incident.cause)}</strong></div>
      <div class="detail-item"><span>Fase do dia</span><strong>${escapeHtml(incident.phase || "Não informada")}</strong></div>
      <div class="detail-item"><span>Mortos</span><strong>${formatInteger(incident.deaths)}</strong></div>
      <div class="detail-item"><span>Feridos</span><strong>${formatInteger(injuriesOf(incident))}</strong></div>
      <div class="detail-item"><span>Clima</span><strong>${escapeHtml(weatherLabel(incident.weather))}</strong></div>
      <div class="detail-item"><span>Pista</span><strong>${escapeHtml(incident.roadType)}</strong></div>
    </div>`;
  elements["incident-detail"].querySelector(".detail-close").addEventListener("click", clearIncident);
  card.querySelectorAll("[data-step]").forEach((button) => {
    button.addEventListener("click", () => stepStack(Number(button.dataset.step)));
  });
  const back = card.querySelector("[data-list]");
  if (back) back.addEventListener("click", () => {
    state.stack.listOpen = true;
    renderIncidentDetail();
  });
}

/* Picker for incidents that overlap on the map (same km / same coordinates). */
function renderStackList(card, stack) {
  const items = stack.items.slice(0, STACK_LIST_LIMIT);
  const deaths = sumOf(stack.items, (incident) => incident.deaths);
  card.hidden = false;
  card.innerHTML = `
    <div class="detail-head"><strong>${formatInteger(stack.items.length)} ocorrências neste local</strong><button class="detail-close" type="button" aria-label="Fechar lista">×</button></div>
    <div class="detail-subtitle">${escapeHtml(topCounts(stack.items, (incident) => incident.road, 3).map(([road]) => road).join(", "))}${deaths ? ` · ${formatInteger(deaths)} ${deaths === 1 ? "morte" : "mortes"}` : ""} · escolha um registro</div>
    <div class="stack-list">${items.map((incident, index) => `
      <button type="button" class="stack-item" data-index="${index}">
        <i style="background:${incidentCssColor(incident)}"></i>
        <span><b>${escapeHtml(incident.road)} · km ${escapeHtml(incident.km || "—")}</b><small>${formatDate(incident.date)} ${escapeHtml(formatTime(incident.time))} · ${escapeHtml(incident.type)}</small></span>
      </button>`).join("")}
    </div>
    ${stack.items.length > items.length ? `<p class="empty-inline">Mostrando ${formatInteger(items.length)} de ${formatInteger(stack.items.length)}. Use os filtros para refinar.</p>` : ""}`;
  card.querySelector(".detail-close").addEventListener("click", clearIncident);
  card.querySelectorAll("[data-index]").forEach((button) => {
    button.addEventListener("click", () => {
      stack.index = Number(button.dataset.index);
      stack.listOpen = false;
      state.selectedIncident = stack.items[stack.index];
      renderIncidentDetail();
      renderIncidentList();
      drawNow();
    });
  });
}

function stepStack(step) {
  const stack = state.stack;
  if (!stack) return;
  const index = clamp(stack.index + step, 0, stack.items.length - 1);
  if (index === stack.index) return;
  stack.index = index;
  state.selectedIncident = stack.items[index];
  renderIncidentDetail();
  renderIncidentList();
  drawNow();
  const button = elements["incident-detail"].querySelector(`[data-step="${step}"]`);
  if (button && !button.disabled) button.focus();
}

function selectIncident(incident, { stack = null, focus = false } = {}) {
  const items = stack && stack.length > 1 ? stack : [incident];
  state.stack = { items, index: Math.max(0, items.indexOf(incident)) };
  state.selectedIncident = incident;
  renderIncidentDetail();
  renderIncidentList();
  if (focus) focusIncident(incident);
  drawNow();
}

/* Bring an incident chosen in the list into view, zooming in enough to separate it from its neighbours. */
function focusIncident(incident) {
  if (!state.viewBox) return;
  const transform = mapTransform();
  const [sx, sy] = toScreen(transform, incident.x, incident.y);
  const zoom = state.baseViewBox.width / state.viewBox.width;
  const visible = sx > 40 && sy > 40 && sx < transform.rect.width - 40 && sy < transform.rect.height - 40;
  if (visible && zoom >= 6) return;
  const half = Math.min(state.viewBox.width, state.baseViewBox.width / 6) / 2;
  fitToBox({ minX: incident.x - half, maxX: incident.x + half, minY: incident.y - half, maxY: incident.y + half }, true, 0);
}

function clearIncident() {
  state.selectedIncident = null;
  state.stack = null;
  renderIncidentDetail();
  renderIncidentList();
  drawNow();
}

/* ---------- Clustering ---------- */

/*
 * Greedy clustering in map space: every incident joins the first cluster whose seed is
 * within CLUSTER_RADIUS_PX on screen. Results are cached per zoom level and filter set,
 * so panning does not reshuffle the groups.
 */
function getMarkers(transform) {
  const key = `${state.filterVersion}|${state.clusterEnabled}|${transform.scale.toFixed(4)}`;
  if (state.clusterCache && state.clusterCache.key === key) return state.clusterCache.markers;
  const incidents = state.filteredIncidents;
  let markers;
  if (!state.clusterEnabled) {
    markers = incidents.map((incident) => singleMarker(incident));
  } else {
    const zoom = state.baseViewBox.width / state.viewBox.width;
    const radiusPx = clamp(CLUSTER_RADIUS_PX - Math.log2(Math.max(1, zoom)) * 6, CLUSTER_RADIUS_MIN_PX, CLUSTER_RADIUS_PX);
    const radius = radiusPx / transform.scale;
    const grid = new Map();
    const cellOf = (value) => Math.floor(value / radius);
    const seeds = [];
    // Fatal incidents seed first so they stay visible as their own groups more often.
    const ordered = [...incidents].sort((a, b) => b.deaths - a.deaths);
    for (const incident of ordered) {
      const cx = cellOf(incident.x);
      const cy = cellOf(incident.y);
      let target = null;
      let best = radius;
      for (let gx = cx - 1; gx <= cx + 1 && !target; gx += 1) {
        for (let gy = cy - 1; gy <= cy + 1; gy += 1) {
          const bucket = grid.get(`${gx},${gy}`);
          if (!bucket) continue;
          for (const seed of bucket) {
            const distance = Math.hypot(seed.sx - incident.x, seed.sy - incident.y);
            if (distance < best) {
              best = distance;
              target = seed;
            }
          }
        }
      }
      if (target) {
        target.items.push(incident);
      } else {
        const seed = { sx: incident.x, sy: incident.y, items: [incident] };
        seeds.push(seed);
        const cellKey = `${cx},${cy}`;
        if (!grid.has(cellKey)) grid.set(cellKey, []);
        grid.get(cellKey).push(seed);
      }
    }
    markers = seeds.map((seed) => (seed.items.length === 1 ? singleMarker(seed.items[0]) : clusterMarker(seed.items)));
  }
  state.clusterCache = { key, markers };
  return markers;
}

function singleMarker(incident) {
  return { type: "incident", id: `i:${incident.id}`, x: incident.x, y: incident.y, items: [incident], incident };
}

function clusterMarker(items) {
  let x = 0;
  let y = 0;
  const counts = { danger: 0, warn: 0, ok: 0 };
  items.forEach((incident) => {
    x += incident.x;
    y += incident.y;
    counts[incidentSeverity(incident)] += 1;
  });
  const bbox = bboxOf(items.map((incident) => [incident.x, incident.y]));
  return {
    type: "cluster",
    id: `c:${items[0].id}:${items.length}`,
    x: x / items.length,
    y: y / items.length,
    items,
    counts,
    bbox
  };
}

function clusterRadius(count) {
  return Math.min(20, 9 + Math.sqrt(count) * 0.75);
}

function markerRadius(transform) {
  const zoom = state.baseViewBox.width / state.viewBox.width;
  return Math.min(7, 3.4 + Math.log2(Math.max(1, zoom)) * 0.8);
}

/* ---------- Canvas drawing ---------- */

let drawFrame = 0;
function drawNow() {
  cancelAnimationFrame(drawFrame);
  drawFrame = requestAnimationFrame(draw);
}

function mapTransform() {
  const rect = elements["markers"].getBoundingClientRect();
  const viewBox = state.viewBox;
  const scale = Math.min(rect.width / viewBox.width, rect.height / viewBox.height);
  return {
    rect,
    scale,
    offsetX: (rect.width - viewBox.width * scale) / 2,
    offsetY: (rect.height - viewBox.height * scale) / 2
  };
}

function toScreen(transform, x, y) {
  return [
    transform.offsetX + (x - state.viewBox.x) * transform.scale,
    transform.offsetY + (y - state.viewBox.y) * transform.scale
  ];
}

function draw() {
  const canvas = elements["markers"];
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const pixelRatio = window.devicePixelRatio || 1;
  const width = Math.round(rect.width * pixelRatio);
  const height = Math.round(rect.height * pixelRatio);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext("2d");
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.clearRect(0, 0, rect.width, rect.height);
  state.shields = [];
  state.visibleMarkers = [];
  if (!state.viewBox) return;

  const transform = mapTransform();
  const markers = getMarkers(transform);
  const radius = markerRadius(transform);
  const colors = state.colors;
  const hoverId = state.hoverMarker ? state.hoverMarker.id : "";
  const obstacles = [];
  const singles = [];
  const clusters = [];

  for (const marker of markers) {
    const [sx, sy] = toScreen(transform, marker.x, marker.y);
    const r = marker.type === "cluster" ? clusterRadius(marker.items.length) : radius;
    if (sx < -r || sy < -r || sx > rect.width + r || sy > rect.height + r) continue;
    const visible = { marker, sx, sy, r };
    state.visibleMarkers.push(visible);
    (marker.type === "cluster" ? clusters : singles).push(visible);
    if (marker.type === "cluster") obstacles.push({ x: sx - r * 0.75, y: sy - r * 0.75, w: r * 1.5, h: r * 1.5 });
  }

  // Singles: draw the less severe first so fatal incidents stay on top.
  const rank = { ok: 0, warn: 1, danger: 2 };
  singles.sort((a, b) => rank[incidentSeverity(a.marker.incident)] - rank[incidentSeverity(b.marker.incident)]);
  context.lineWidth = 1.4;
  context.strokeStyle = colors.markerStroke;
  for (const { marker, sx, sy, r } of singles) {
    context.beginPath();
    context.arc(sx, sy, r, 0, Math.PI * 2);
    context.fillStyle = incidentColor(marker.incident);
    context.fill();
    context.stroke();
  }

  for (const { marker, sx, sy, r } of clusters) drawCluster(context, marker, sx, sy, r, marker.id === hoverId);

  const hovered = state.visibleMarkers.find((item) => item.marker.id === hoverId && item.marker.type === "incident");
  if (hovered) {
    context.beginPath();
    context.arc(hovered.sx, hovered.sy, hovered.r + 5, 0, Math.PI * 2);
    context.fillStyle = incidentColor(hovered.marker.incident);
    context.globalAlpha = 0.25;
    context.fill();
    context.globalAlpha = 1;
    context.beginPath();
    context.arc(hovered.sx, hovered.sy, hovered.r + 1.5, 0, Math.PI * 2);
    context.fill();
    context.lineWidth = 2;
    context.stroke();
  }

  const stackSpot = state.stack && state.stack.listOpen ? state.stack.items[0] : null;
  if (stackSpot) {
    const [sx, sy] = toScreen(transform, state.stack.x ?? stackSpot.x, state.stack.y ?? stackSpot.y);
    context.beginPath();
    context.arc(sx, sy, 26, 0, Math.PI * 2);
    context.lineWidth = 3;
    context.strokeStyle = colors.highlight;
    context.setLineDash([5, 4]);
    context.stroke();
    context.setLineDash([]);
  }

  const selected = state.selectedIncident;
  if (selected) {
    const [sx, sy] = toScreen(transform, selected.x, selected.y);
    context.beginPath();
    context.arc(sx, sy, 15, 0, Math.PI * 2);
    context.fillStyle = incidentColor(selected);
    context.globalAlpha = 0.22;
    context.fill();
    context.globalAlpha = 1;
    context.beginPath();
    context.arc(sx, sy, 7.5, 0, Math.PI * 2);
    context.fill();
    context.lineWidth = 3;
    context.strokeStyle = colors.markerStroke;
    context.stroke();
  }

  drawShields(context, transform, obstacles);
}

function drawCluster(context, marker, sx, sy, r, hovered) {
  const colors = state.colors;
  const total = marker.items.length;
  context.save();
  context.shadowColor = "rgba(0, 0, 0, .25)";
  context.shadowBlur = hovered ? 10 : 4;
  context.shadowOffsetY = 1;
  context.beginPath();
  context.arc(sx, sy, hovered ? r + 2 : r, 0, Math.PI * 2);
  context.fillStyle = colors.surface;
  context.fill();
  context.restore();

  // Severity ring: share of fatal / injured / no-victim incidents.
  const ringRadius = (hovered ? r + 2 : r) - 2.5;
  let start = -Math.PI / 2;
  context.lineWidth = 4.5;
  for (const key of ["danger", "warn", "ok"]) {
    const share = marker.counts[key] / total;
    if (!share) continue;
    const end = start + share * Math.PI * 2;
    context.beginPath();
    context.arc(sx, sy, ringRadius, start, end);
    context.strokeStyle = colors[key];
    context.stroke();
    start = end;
  }
  context.beginPath();
  context.arc(sx, sy, (hovered ? r + 2 : r) + 0.5, 0, Math.PI * 2);
  context.lineWidth = hovered ? 2 : 1;
  context.strokeStyle = hovered ? colors.highlight : colors.markerStroke;
  context.stroke();

  context.fillStyle = colors.ink;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.font = `700 ${total >= 1000 ? 10 : total >= 100 ? 11 : 12}px "Inter", sans-serif`;
  context.fillText(compactCount(total), sx, sy + 0.5);
}

function drawShields(context, transform, obstacles = []) {
  if (!state.roads.length) return;
  const { rect } = transform;
  const selected = selectedRoad();
  const placed = [];
  const spacing = Math.max(220, Math.min(rect.width, rect.height) * 0.4);
  const margin = 18;
  const ordered = [...state.roads].sort((a, b) => {
    const priority = (road) => (road.road === selected ? 2 : road.road === state.hoverRoad ? 1 : 0);
    return priority(b) - priority(a) || roadCount(b.road) - roadCount(a.road);
  });
  const shieldBox = (cx, cy) => ({ x: cx - SHIELD_W / 2 - 3, y: cy - SHIELD_H / 2 - 3, w: SHIELD_W + 6, h: SHIELD_H + 6 });
  const spacedBox = (box) => ({ x: box.x - 8, y: box.y - 8, w: box.w + 16, h: box.h + 16 });
  const inside = (cx, cy) => cx >= margin && cy >= margin && cx <= rect.width - margin - 50 && cy <= rect.height - margin - 30;
  const place = (road, cx, cy, highlighted, dimmed) => {
    placed.push(spacedBox(shieldBox(cx, cy)));
    drawShield(context, cx, cy, road, highlighted, dimmed);
    state.shields.push({ road, x: cx - SHIELD_W / 2, y: cy - SHIELD_H / 2, w: SHIELD_W, h: SHIELD_H });
  };

  for (const road of ordered) {
    const highlighted = road.road === selected || road.road === state.hoverRoad;
    const dimmed = selected && !highlighted;
    const lines = [...road.lines].sort((a, b) => boxSize(b.bbox) - boxSize(a.bbox));
    let count = 0;
    let fallback = null;
    for (const line of lines) {
      if (dimmed && count >= 1) break;
      const candidates = sampleLine(line.points.map(([x, y]) => toScreen(transform, x, y)), 14);
      if (candidates.length < 5) continue;
      let sinceLast = spacing / 2;
      for (const [cx, cy, distance] of candidates) {
        sinceLast += 14;
        if (!inside(cx, cy)) continue;
        const box = shieldBox(cx, cy);
        if (placed.some((other) => overlaps(spacedBox(box), other))) continue;
        const crowd = obstacles.reduce((sum, other) => sum + overlapArea(box, other), 0);
        // Remember the least crowded spot in case no fully free spot exists.
        if (!fallback || crowd < fallback.crowd) fallback = { cx, cy, crowd };
        if (crowd > 0 || sinceLast < spacing || distance < 20) continue;
        place(road.road, cx, cy, highlighted, dimmed);
        count += 1;
        sinceLast = 0;
      }
    }
    // Every visible BR keeps at least one shield, at its least crowded spot.
    if (!count && fallback) place(road.road, fallback.cx, fallback.cy, highlighted, dimmed);
  }
}

/* Points every `step` px along a screen-space polyline, with the distance walked so far. */
function sampleLine(screen, step) {
  const result = [];
  let walked = 0;
  let next = step;
  for (let i = 1; i < screen.length; i += 1) {
    const [ax, ay] = screen[i - 1];
    const [bx, by] = screen[i];
    const segment = Math.hypot(bx - ax, by - ay);
    while (segment > 0 && walked + segment >= next) {
      const t = (next - walked) / segment;
      result.push([ax + (bx - ax) * t, ay + (by - ay) * t, next]);
      next += step;
    }
    walked += segment;
  }
  return result;
}

function drawShield(context, cx, cy, road, highlighted, dimmed) {
  const colors = state.colors;
  const w = SHIELD_W;
  const h = SHIELD_H;
  const x = cx - w / 2;
  const y = cy - h / 2;
  const shape = () => {
    context.beginPath();
    context.moveTo(x + 3, y);
    context.lineTo(x + w - 3, y);
    context.quadraticCurveTo(x + w, y, x + w, y + 3);
    context.lineTo(x + w, y + h * 0.55);
    context.quadraticCurveTo(x + w, y + h * 0.82, x + w / 2, y + h);
    context.quadraticCurveTo(x, y + h * 0.82, x, y + h * 0.55);
    context.lineTo(x, y + 3);
    context.quadraticCurveTo(x, y, x + 3, y);
    context.closePath();
  };
  context.save();
  context.globalAlpha = dimmed ? 0.55 : 1;
  context.shadowColor = "rgba(0, 0, 0, .28)";
  context.shadowBlur = highlighted ? 8 : 3;
  context.shadowOffsetY = 1;
  shape();
  context.fillStyle = colors.shieldFill;
  context.fill();
  context.shadowColor = "transparent";
  context.lineWidth = highlighted ? 2.6 : 1.8;
  context.strokeStyle = highlighted ? colors.highlightDark : colors.shieldBorder;
  context.stroke();
  if (highlighted) {
    context.lineWidth = 1.5;
    context.strokeStyle = colors.highlight;
    context.beginPath();
    context.moveTo(x + 4, y + 2.6);
    context.lineTo(x + w - 4, y + 2.6);
    context.stroke();
  }
  context.fillStyle = highlighted ? colors.highlightDark : colors.shieldInk;
  context.textAlign = "center";
  context.textBaseline = "alphabetic";
  context.font = '800 7px "Inter", sans-serif';
  context.fillText("BR", cx, y + 10.5);
  context.font = '800 12px "Manrope", "Inter", sans-serif';
  context.fillText(road.replace("BR-", ""), cx, y + 22.5);
  context.restore();
}

/* ---------- Hit testing ---------- */

function screenPoint(event) {
  const rect = elements["markers"].getBoundingClientRect();
  return [event.clientX - rect.left, event.clientY - rect.top];
}

function shieldAt(sx, sy) {
  for (let i = state.shields.length - 1; i >= 0; i -= 1) {
    const shield = state.shields[i];
    if (sx >= shield.x - 2 && sx <= shield.x + shield.w + 2 && sy >= shield.y - 2 && sy <= shield.y + shield.h + 2) return shield.road;
  }
  return "";
}

function roadAt(sx, sy) {
  if (!state.roads.length || !state.viewBox) return "";
  const transform = mapTransform();
  const mx = state.viewBox.x + (sx - transform.offsetX) / transform.scale;
  const my = state.viewBox.y + (sy - transform.offsetY) / transform.scale;
  const tolerance = ROAD_HIT_PX / transform.scale;
  let best = "";
  let bestDistance = tolerance;
  for (const road of state.roads) {
    if (!inBox(road.bbox, mx, my, tolerance)) continue;
    for (const line of road.lines) {
      if (!inBox(line.bbox, mx, my, tolerance)) continue;
      const points = line.points;
      for (let i = 1; i < points.length; i += 1) {
        const distance = segmentDistance(mx, my, points[i - 1], points[i]);
        if (distance < bestDistance || (distance === bestDistance && road.road === selectedRoad())) {
          bestDistance = distance;
          best = road.road;
        }
      }
    }
  }
  return best;
}

/*
 * Clusters are hit anywhere inside their bubble; single dots get a generous radius
 * (INCIDENT_HIT_PX) and the closest one wins. Incidents sharing practically the same
 * spot come back together so the detail card can page through them.
 */
function markerAt(sx, sy) {
  const visible = state.visibleMarkers || [];
  for (let i = visible.length - 1; i >= 0; i -= 1) {
    const item = visible[i];
    if (item.marker.type === "cluster" && Math.hypot(item.sx - sx, item.sy - sy) <= item.r + 2) return { marker: item.marker, stack: null };
  }
  let nearest = null;
  let nearestDistance = Infinity;
  for (const item of visible) {
    if (item.marker.type !== "incident") continue;
    const distance = Math.hypot(item.sx - sx, item.sy - sy);
    if (distance <= Math.max(INCIDENT_HIT_PX, item.r + 4) && distance < nearestDistance) {
      nearest = item;
      nearestDistance = distance;
    }
  }
  if (!nearest) return null;
  const stack = visible
    .filter((item) => item.marker.type === "incident" && Math.hypot(item.sx - nearest.sx, item.sy - nearest.sy) <= 3)
    .map((item) => item.marker.incident)
    .sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`));
  return { marker: nearest.marker, stack };
}

function resolveHit(sx, sy) {
  const shield = shieldAt(sx, sy);
  if (shield) return { type: "road", road: shield };
  const marker = markerAt(sx, sy);
  if (marker) return { type: marker.marker.type, marker: marker.marker, stack: marker.stack, sx, sy };
  const road = roadAt(sx, sy);
  return road ? { type: "road", road } : null;
}

let hoverFrame = 0;
function updateHover(sx, sy) {
  cancelAnimationFrame(hoverFrame);
  hoverFrame = requestAnimationFrame(() => {
    const hit = resolveHit(sx, sy);
    elements["markers"].classList.toggle("is-pointer", Boolean(hit));
    if (!hit) {
      clearHover();
    } else if (hit.type === "road") {
      setHoverMarker(null);
      setHoverRoad(hit.road, [sx, sy]);
    } else {
      setHoverRoad("", null, true);
      setHoverMarker(hit, [sx, sy]);
    }
  });
}

function clearHover() {
  setHoverMarker(null);
  setHoverRoad("", null);
}

function setHoverMarker(hit, position) {
  const marker = hit ? hit.marker : null;
  const changed = (marker ? marker.id : "") !== (state.hoverMarker ? state.hoverMarker.id : "");
  state.hoverMarker = marker;
  const tooltip = elements["road-tooltip"];
  if (marker && position) {
    tooltip.classList.add("map-tooltip-incident");
    tooltip.innerHTML = marker.type === "cluster" ? clusterTooltip(marker) : incidentTooltip(marker.incident, hit.stack);
    placeTooltip(position);
  } else if (!state.hoverRoad) {
    tooltip.hidden = true;
  }
  if (changed) drawNow();
}

function clusterTooltip(marker) {
  const roads = topCounts(marker.items, (incident) => incident.road, 3).map(([road]) => road).join(", ");
  const deaths = sumOf(marker.items, (incident) => incident.deaths);
  return `<div class="tip-title">${formatInteger(marker.items.length)} ocorrências agrupadas</div>
    <div class="tip-line">${escapeHtml(roads)}${deaths ? ` · ${formatInteger(deaths)} ${deaths === 1 ? "morte" : "mortes"}` : ""}</div>
    <div class="tip-sev">
      <span><i style="background:var(--danger)"></i>${formatInteger(marker.counts.danger)}</span>
      <span><i style="background:var(--warn)"></i>${formatInteger(marker.counts.warn)}</span>
      <span><i style="background:var(--ok)"></i>${formatInteger(marker.counts.ok)}</span>
    </div>
    <div class="tip-hint">Clique para aproximar</div>`;
}

function incidentTooltip(incident, stack) {
  const extra = stack && stack.length > 1 ? ` · +${formatInteger(stack.length - 1)} no mesmo local` : "";
  return `<div class="tip-title"><i class="tip-dot" style="background:${incidentCssColor(incident)}"></i>${escapeHtml(incident.road)} · km ${escapeHtml(incident.km || "—")}</div>
    <div class="tip-line">${escapeHtml(titleCase(incident.city))} · ${formatDate(incident.date)} ${escapeHtml(formatTime(incident.time))}</div>
    <div class="tip-line">${escapeHtml(incident.type)}</div>
    <div class="tip-hint">Clique para ver o registro${extra}</div>`;
}

function placeTooltip(position) {
  const tooltip = elements["road-tooltip"];
  const canvasRect = elements["markers"].getBoundingClientRect();
  tooltip.hidden = false;
  const flipX = position[0] + tooltip.offsetWidth + 24 > canvasRect.width;
  const flipY = position[1] + tooltip.offsetHeight + 24 > canvasRect.height;
  tooltip.style.left = `${position[0]}px`;
  tooltip.style.top = `${position[1]}px`;
  tooltip.style.transform = `translate(${flipX ? "calc(-100% - 14px)" : "14px"}, ${flipY ? "calc(-100% - 14px)" : "14px"})`;
}

function setHoverRoad(road, position, keepTooltip = false) {
  const changed = road !== state.hoverRoad;
  state.hoverRoad = road;
  const tooltip = elements["road-tooltip"];
  if (road && position) {
    const totals = state.roadTotals.get(road) || { count: 0, deaths: 0 };
    const isSelected = road === selectedRoad();
    tooltip.classList.remove("map-tooltip-incident");
    tooltip.innerHTML = `${shieldHtml(road)}<div><strong>${escapeHtml(road)}</strong><span>${formatInteger(totals.count)} ocorrências · ${formatInteger(totals.deaths)} mortes em ${state.year}</span><span>${isSelected ? "Rodovia selecionada" : "Clique para ver os dados desta BR"}</span></div>`;
    placeTooltip(position);
  } else if (!keepTooltip) {
    tooltip.hidden = true;
  }
  if (changed) {
    updateRoadClasses();
    elements["road-ranking"].querySelectorAll("[data-road]").forEach((button) => {
      button.classList.toggle("is-hover", button.dataset.road === road);
    });
    drawNow();
  }
}

/* ---------- Pan & zoom ---------- */

function onMapPointerDown(event) {
  if (!state.viewBox) return;
  stopAnimation();
  event.currentTarget.setPointerCapture(event.pointerId);
  state.drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false, initial: { ...state.viewBox } };
}

function onMapPointerMove(event) {
  if (!state.drag) {
    const [sx, sy] = screenPoint(event);
    updateHover(sx, sy);
    return;
  }
  if (state.drag.pointerId !== event.pointerId) return;
  const dx = event.clientX - state.drag.startX;
  const dy = event.clientY - state.drag.startY;
  if (Math.abs(dx) + Math.abs(dy) > 5) {
    if (!state.drag.moved) {
      elements["markers"].classList.add("is-dragging");
      clearHover();
    }
    state.drag.moved = true;
  }
  if (!state.drag.moved) return;
  const { scale } = mapTransform();
  state.viewBox.x = state.drag.initial.x - dx / scale;
  state.viewBox.y = state.drag.initial.y - dy / scale;
  applyViewBox();
  drawNow();
}

function onMapPointerUp(event) {
  if (!state.drag || state.drag.pointerId !== event.pointerId) return;
  const moved = state.drag.moved;
  endMapDrag();
  if (moved) return;
  const [sx, sy] = screenPoint(event);
  const hit = resolveHit(sx, sy);
  if (!hit) return;
  if (hit.type === "road") {
    if (hit.road !== selectedRoad()) selectRoad(hit.road, { fit: true });
  } else if (hit.type === "cluster") {
    openCluster(hit.marker);
  } else if (hit.stack && hit.stack.length > 3) {
    state.selectedIncident = null;
    state.stack = { items: hit.stack, index: 0, listOpen: true };
    renderIncidentDetail();
    renderIncidentList();
    drawNow();
  } else {
    selectIncident(hit.marker.incident, { stack: hit.stack });
  }
  clearHover();
}

/* Zoom into a group; if its incidents share (almost) the same spot, page through them instead. */
function openCluster(marker) {
  const transform = mapTransform();
  const spreadPx = Math.max(marker.bbox.maxX - marker.bbox.minX, marker.bbox.maxY - marker.bbox.minY) * transform.scale;
  const atMaxZoom = state.viewBox.width <= state.baseViewBox.width / MAX_ZOOM * 1.05;
  if (spreadPx < 4 || atMaxZoom) {
    const items = [...marker.items].sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`));
    state.selectedIncident = null;
    state.stack = { items, index: 0, listOpen: true, x: marker.x, y: marker.y };
    renderIncidentDetail();
    renderIncidentList();
    drawNow();
    return;
  }
  fitToBox(marker.bbox, true, 0.35, { minFactor: 2, minSize: 0.001 });
}

function endMapDrag() {
  state.drag = null;
  elements["markers"].classList.remove("is-dragging");
}

function onMapWheel(event) {
  if (!state.viewBox) return;
  event.preventDefault();
  stopAnimation();
  const [sx, sy] = screenPoint(event);
  zoomAround(sx, sy, event.deltaY < 0 ? 1.19 : 1 / 1.19);
}

function zoomAround(sx, sy, factor) {
  const transform = mapTransform();
  const anchorX = state.viewBox.x + (sx - transform.offsetX) / transform.scale;
  const anchorY = state.viewBox.y + (sy - transform.offsetY) / transform.scale;
  const nextWidth = clamp(state.viewBox.width / factor, state.baseViewBox.width / MAX_ZOOM, state.baseViewBox.width * 1.1);
  const ratio = nextWidth / state.viewBox.width;
  state.viewBox = {
    x: anchorX - (anchorX - state.viewBox.x) * ratio,
    y: anchorY - (anchorY - state.viewBox.y) * ratio,
    width: nextWidth,
    height: state.viewBox.height * ratio
  };
  applyViewBox();
  drawNow();
}

function zoomBy(factor) {
  if (!state.viewBox || !state.baseViewBox) return;
  const width = clamp(state.viewBox.width / factor, state.baseViewBox.width / MAX_ZOOM, state.baseViewBox.width * 1.1);
  const height = width * state.viewBox.height / state.viewBox.width;
  const centerX = state.viewBox.x + state.viewBox.width / 2;
  const centerY = state.viewBox.y + state.viewBox.height / 2;
  animateTo({ x: centerX - width / 2, y: centerY - height / 2, width, height });
}

function resetMapView() {
  if (!state.baseViewBox) return;
  animateTo({ ...state.baseViewBox });
}

function fitToRoad(road, animate) {
  const item = state.roads.find((candidate) => candidate.road === road);
  const points = item ? null : state.prfIncidents.filter((incident) => incident.road === road).map((incident) => [incident.x, incident.y]);
  const box = item ? item.bbox : points && points.length ? bboxOf(points) : null;
  if (box) fitToBox(box, animate, 0.08);
}

/* Fit a map-space box into the part of the map not covered by the BR panel. */
function fitToBox(box, animate, padding, { minFactor = 0, minSize = 0.02 } = {}) {
  if (!state.baseViewBox) return;
  const rect = elements["markers"].getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const panelOpen = !elements["road-panel"].hidden && DESKTOP_PANEL_QUERY.matches;
  const left = panelOpen ? 368 : 24;
  const right = rect.width - 66;
  const top = 24;
  const bottom = rect.height - 64;
  const boxWidth = Math.max(box.maxX - box.minX, minSize) * (1 + padding * 2);
  const boxHeight = Math.max(box.maxY - box.minY, minSize) * (1 + padding * 2);
  const ratio = state.baseViewBox.width / state.baseViewBox.height;
  const maxScale = Math.min(rect.width, rect.height * ratio) / (state.baseViewBox.width / MAX_ZOOM);
  const currentScale = state.viewBox ? mapTransform().scale : 0;
  const fitScale = Math.max(currentScale * minFactor, Math.min((right - left) / boxWidth, (bottom - top) / boxHeight));
  const scale = Math.min(maxScale, Math.max(1e-6, fitScale));
  const width = Math.min(rect.width, rect.height * ratio) / scale;
  const height = width / ratio;
  const offsetX = (rect.width - width * scale) / 2;
  const offsetY = (rect.height - height * scale) / 2;
  const centerX = (box.minX + box.maxX) / 2;
  const centerY = (box.minY + box.maxY) / 2;
  const target = {
    x: centerX - ((left + right) / 2 - offsetX) / scale,
    y: centerY - ((top + bottom) / 2 - offsetY) / scale,
    width,
    height
  };
  if (animate) animateTo(target);
  else {
    state.viewBox = target;
    applyViewBox();
    drawNow();
  }
}

function animateTo(target) {
  if (!state.viewBox) return;
  stopAnimation();
  const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduceMotion) {
    state.viewBox = target;
    applyViewBox();
    drawNow();
    return;
  }
  const start = { ...state.viewBox };
  const startTime = performance.now();
  const duration = 520;
  const step = (now) => {
    const t = Math.min(1, (now - startTime) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    state.viewBox = {
      x: start.x + (target.x - start.x) * eased,
      y: start.y + (target.y - start.y) * eased,
      width: start.width + (target.width - start.width) * eased,
      height: start.height + (target.height - start.height) * eased
    };
    applyViewBox();
    draw();
    state.animation = t < 1 ? requestAnimationFrame(step) : 0;
  };
  state.animation = requestAnimationFrame(step);
}

function stopAnimation() {
  if (state.animation) cancelAnimationFrame(state.animation);
  state.animation = 0;
}

function applyViewBox() {
  if (!state.viewBox) return;
  const { x, y, width, height } = state.viewBox;
  elements["map-svg"].setAttribute("viewBox", `${x} ${y} ${width} ${height}`);
}

/* ---------- Helpers ---------- */

function getTimePeriod(time) {
  const hour = Number(String(time).slice(0, 2));
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) return "";
  if (hour < 6) return "madrugada";
  if (hour < 12) return "manha";
  if (hour < 18) return "tarde";
  return "noite";
}

function withinMinas(latitude, longitude) {
  return latitude >= -23.1 && latitude <= -14.1 && longitude >= -51.1 && longitude <= -39.7;
}

function toMapCoordinates(longitude, latitude) {
  return [longitude * COS_LATITUDE, -latitude];
}

function bboxOf(points) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

function mergeBoxes(boxes) {
  return boxes.reduce((acc, box) => ({
    minX: Math.min(acc.minX, box.minX),
    minY: Math.min(acc.minY, box.minY),
    maxX: Math.max(acc.maxX, box.maxX),
    maxY: Math.max(acc.maxY, box.maxY)
  }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
}

function boxSize(box) {
  return (box.maxX - box.minX) + (box.maxY - box.minY);
}

function inBox(box, x, y, tolerance) {
  return x >= box.minX - tolerance && x <= box.maxX + tolerance && y >= box.minY - tolerance && y <= box.maxY + tolerance;
}

function overlapArea(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function overlaps(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function segmentDistance(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length ? clamp(((px - ax) * dx + (py - ay) * dy) / length, 0, 1) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

function roadCount(road) {
  const totals = state.roadTotals.get(road);
  return totals ? totals.count : 0;
}

function severityKey(incident) {
  return { danger: "fatal", warn: "injury", ok: "no-injury" }[incidentSeverity(incident)];
}

function compactCount(value) {
  if (value < 1000) return String(value);
  return `${(value / 1000).toFixed(value < 10000 ? 1 : 0).replace(".", ",").replace(",0", "")}k`;
}

function incidentSeverity(incident) {
  if (incident.deaths > 0) return "danger";
  if (injuriesOf(incident) > 0) return "warn";
  return "ok";
}

function incidentColor(incident) {
  return state.colors[incidentSeverity(incident)];
}

function incidentCssColor(incident) {
  return `var(--${incidentSeverity(incident)})`;
}

function injuriesOf(incident) {
  return incident.minorInjuries + incident.severeInjuries;
}

function sumOf(items, pick) {
  return items.reduce((sum, item) => sum + pick(item), 0);
}

function topCounts(items, pick, limit) {
  const counts = new Map();
  items.forEach((item) => {
    const key = pick(item);
    if (key) counts.set(key, (counts.get(key) || 0) + 1);
  });
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function shieldHtml(road, large = false) {
  const number = String(road).replace(/^BR-/, "");
  return `<span class="br-shield${large ? " lg" : ""}" aria-hidden="true"><small>BR</small><b>${escapeHtml(number)}</b></span>`;
}

function titleCase(value) {
  const minorWords = new Set(["da", "das", "de", "do", "dos", "e"]);
  return String(value).toLocaleLowerCase("pt-BR").split(/\s+/).map((word, index) => (
    index > 0 && minorWords.has(word) ? word : word.charAt(0).toLocaleUpperCase("pt-BR") + word.slice(1)
  )).join(" ");
}

function notify(message, type = "") {
  clearTimeout(state.toastTimer);
  elements["toast"].textContent = message;
  elements["toast"].className = `toast show${type ? ` ${type}` : ""}`;
  state.toastTimer = setTimeout(() => { elements["toast"].className = "toast"; }, 4400);
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR", { numeric: true }));
}

function nonNegative(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function formatInteger(value) {
  return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 }).format(value);
}

function formatDecimal(value) {
  return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(value);
}

function formatPercent(value) {
  return new Intl.NumberFormat("pt-BR", { style: "percent", maximumFractionDigits: 1 }).format(value);
}

function formatDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value || "");
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value || "Data não informada";
}

function formatTime(value) {
  const match = /^(\d{2}):(\d{2})/.exec(value || "");
  return match ? `${match[1]}h${match[2]}` : value || "—";
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function cssEscape(value) {
  return window.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/"/g, '\\"');
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}
