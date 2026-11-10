const MAX_LIST_ITEMS = 8;

const state = {
  boundary: null,
  prfIncidents: [],
  filteredIncidents: [],
  stateVictims: [],
  viewBox: null,
  baseViewBox: null,
  selectedIncident: null,
  toastTimer: null
};

const elements = {};

document.addEventListener("DOMContentLoaded", () => {
  [
    "map-svg", "municipalities", "markers", "map-canvas", "map-loading", "map-empty",
    "map-status", "map-count", "map-caption", "incident-detail", "incident-list",
    "list-count", "metric-occurrences", "metric-fatalities", "metric-injured",
    "source-count", "road-filter", "type-filter", "cause-filter", "period-filter", "severity-filter",
    "search", "road-ranking", "state-victims", "state-data-through", "municipality-list",
    "toast", "reset-filters", "zoom-in", "zoom-out", "zoom-reset"
  ].forEach((id) => { elements[id] = document.getElementById(id); });

  bindEvents();
  loadBoundary();
  loadStaticSnapshots();
});

function bindEvents() {
  ["search", "road-filter", "type-filter", "cause-filter", "period-filter", "severity-filter"].forEach((id) => {
    elements[id].addEventListener(id === "search" ? "input" : "change", applyFilters);
  });
  elements["reset-filters"].addEventListener("click", resetFilters);
  elements["zoom-in"].addEventListener("click", () => zoomBy(1.25));
  elements["zoom-out"].addEventListener("click", () => zoomBy(0.8));
  elements["zoom-reset"].addEventListener("click", resetMapView);
  elements["markers"].addEventListener("pointerdown", onMapPointerDown);
  elements["markers"].addEventListener("pointermove", onMapPointerMove);
  elements["markers"].addEventListener("pointerup", onMapPointerUp);
  elements["markers"].addEventListener("pointercancel", endMapDrag);
  elements["markers"].addEventListener("wheel", onMapWheel, { passive: false });
  window.addEventListener("resize", drawMarkers);
}

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
    drawMarkers();
  } catch (error) {
    elements["map-loading"].textContent = "Não foi possível carregar o mapa vetorial.";
    elements["map-status"].textContent = `Erro ao carregar o limite de Minas Gerais: ${error.message}`;
    elements["map-status"].classList.add("status-error");
    notify("Não foi possível carregar o mapa. Verifique a conexão e tente atualizar a página.", "error");
  }
}

async function loadStaticSnapshots() {
  const results = await Promise.allSettled([
    loadStaticPrfSnapshot(),
    loadStaticSejuspSnapshot()
  ]);
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      const source = index === 0 ? "PRF" : "SEJUSP";
      console.error(`Não foi possível carregar a cópia estática da fonte ${source}.`, result.reason);
      if (source === "PRF") {
        elements["map-empty"].querySelector("strong").textContent = "Base da PRF indisponível";
        elements["map-empty"].querySelector("span").textContent = "Não foi possível carregar os dados de acidentes incluídos neste deploy.";
        elements["map-status"].textContent = "Não foi possível carregar a base estática da PRF.";
      } else {
        elements["state-victims"].textContent = "—";
        elements["state-data-through"].textContent = "Não foi possível carregar a base estadual incluída neste deploy.";
        elements["municipality-list"].innerHTML = '<p class="empty-inline">Resumo estadual indisponível.</p>';
      }
      notify(`Não foi possível carregar a base ${source} incluída no site. Consulte o estado da fonte e tente novamente.`, "error");
    }
  });
}

async function loadStaticPrfSnapshot() {
  const response = await fetch("./data/prf-2026.json");
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const snapshot = await response.json();
  const incidents = normalizePrfSnapshot(snapshot);
  state.prfIncidents = incidents;
  state.selectedIncident = null;
  elements["map-status"].textContent = `${formatInteger(incidents.length)} ocorrências da PRF · dados até ${formatDate(snapshot.dataThrough)} · incluídos neste deploy.`;
  elements["map-empty"].hidden = true;
  elements["map-caption"].textContent = "Mapa estadual · ocorrências geolocalizadas da PRF";
  populateFilters();
  applyFilters();
}

async function loadStaticSejuspSnapshot() {
  const response = await fetch("./data/sejusp-2026.json");
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const snapshot = await response.json();
  state.stateVictims = normalizeSejuspSnapshot(snapshot);
  renderStateSummary();
  const month = Number(snapshot.dataThrough);
  const monthName = Number.isInteger(month) && month >= 1 && month <= 12
    ? new Intl.DateTimeFormat("pt-BR", { month: "long" }).format(new Date(2026, month - 1, 1))
    : "período não informado";
  elements["state-data-through"].textContent = `Base estadual disponível até ${monthName} de 2026.`;
  updateSourceCount();
}

function renderBoundary(geojson) {
  const allPoints = [];
  for (const feature of geojson.features) {
    collectCoordinates(feature.geometry, allPoints);
  }
  if (!allPoints.length) throw new Error("O mapa não contém coordenadas.");

  const cosLatitude = Math.cos(20 * Math.PI / 180);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [longitude, latitude] of allPoints) {
    const x = longitude * cosLatitude;
    const y = -latitude;
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

  const paths = geojson.features.map((feature) => {
    const path = geometryToPath(feature.geometry, cosLatitude);
    return `<path d="${path}"></path>`;
  }).join("");
  elements["municipalities"].innerHTML = paths;
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

function geometryToPath(geometry, cosLatitude) {
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
    const x = longitude * cosLatitude;
    const y = -latitude;
    return `${index === 0 ? "M" : "L"}${x.toFixed(5)},${y.toFixed(5)}`;
  }).join(" ") + " Z").join(" ");
}

function normalizePrfSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.incidents) || !snapshot.incidents.length) {
    throw new Error("A cópia estática da PRF está vazia ou em formato inválido.");
  }
  return snapshot.incidents.filter((incident) => (
    incident && typeof incident.date === "string" && incident.date.startsWith("2026")
    && Number.isFinite(incident.latitude) && Number.isFinite(incident.longitude)
    && withinMinas(incident.latitude, incident.longitude)
  )).map((incident) => ({
    ...incident,
    deaths: nonNegative(incident.deaths),
    minorInjuries: nonNegative(incident.minorInjuries),
    severeInjuries: nonNegative(incident.severeInjuries),
    people: nonNegative(incident.people)
  }));
}

function normalizeSejuspSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.byMunicipality)) {
    throw new Error("A cópia estática da SEJUSP está vazia ou em formato inválido.");
  }
  return snapshot.byMunicipality.filter((row) => (
    row && typeof row.city === "string" && Number.isFinite(row.victims) && row.victims >= 0
  )).map((row) => ({ city: row.city, victims: row.victims }));
}

function populateFilters() {
  const roads = uniqueSorted(state.prfIncidents.map((incident) => incident.road));
  const types = uniqueSorted(state.prfIncidents.map((incident) => incident.type));
  const causes = uniqueSorted(state.prfIncidents.map((incident) => incident.cause));
  fillSelect(elements["road-filter"], roads, "Todas as BRs");
  fillSelect(elements["type-filter"], types, "Todos os tipos");
  fillSelect(elements["cause-filter"], causes, "Todas as causas");
}

function fillSelect(select, options, placeholder) {
  const previous = select.value;
  select.replaceChildren(new Option(placeholder, ""));
  options.forEach((value) => select.add(new Option(value, value)));
  select.disabled = options.length === 0;
  if (options.includes(previous)) select.value = previous;
}

function applyFilters() {
  const query = elements["search"].value.trim().toLocaleLowerCase("pt-BR");
  const road = elements["road-filter"].value;
  const type = elements["type-filter"].value;
  const cause = elements["cause-filter"].value;
  const period = elements["period-filter"].value;
  const severity = elements["severity-filter"].value;

  state.filteredIncidents = state.prfIncidents.filter((incident) => {
    if (road && incident.road !== road) return false;
    if (type && incident.type !== type) return false;
    if (cause && incident.cause !== cause) return false;
    if (period && getTimePeriod(incident.time) !== period) return false;
    if (severity === "fatal" && incident.deaths <= 0) return false;
    if (severity === "injury" && incident.minorInjuries + incident.severeInjuries <= 0) return false;
    if (severity === "no-injury" && (incident.deaths > 0 || incident.minorInjuries + incident.severeInjuries > 0)) return false;
    if (query && ![
      incident.road, incident.city, incident.cause, incident.type, incident.km
    ].some((value) => String(value).toLocaleLowerCase("pt-BR").includes(query))) return false;
    return true;
  }).sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`));

  if (state.selectedIncident && !state.filteredIncidents.some((incident) => incident.id === state.selectedIncident.id)) {
    state.selectedIncident = null;
  }
  renderMetrics();
  renderRoadRanking();
  renderIncidentList();
  renderIncidentDetail();
  renderStateSummary();
  updateSourceCount();
  drawMarkers();
}

function renderMetrics() {
  const incidents = state.filteredIncidents;
  const deaths = incidents.reduce((sum, incident) => sum + nonNegative(incident.deaths), 0);
  const injuries = incidents.reduce((sum, incident) => sum + nonNegative(incident.minorInjuries) + nonNegative(incident.severeInjuries), 0);
  elements["metric-occurrences"].textContent = formatInteger(incidents.length);
  elements["metric-fatalities"].textContent = formatInteger(deaths);
  elements["metric-injured"].textContent = formatInteger(injuries);
  elements["map-count"].textContent = `${formatInteger(incidents.length)} ${incidents.length === 1 ? "ocorrência" : "ocorrências"}`;
  elements["map-empty"].hidden = state.prfIncidents.length > 0;
}

function renderRoadRanking() {
  const counts = new Map();
  state.filteredIncidents.forEach((incident) => counts.set(incident.road, (counts.get(incident.road) || 0) + 1));
  const roads = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (!roads.length) {
    elements["road-ranking"].innerHTML = '<p class="empty-inline">Nenhuma rodovia encontrada para os filtros atuais.</p>';
    return;
  }
  const maximum = roads[0][1] || 1;
  elements["road-ranking"].innerHTML = roads.map(([road, count]) => `
    <button class="road-rank-button ${elements["road-filter"].value === road ? "active" : ""}" type="button" data-road="${escapeHtml(road)}">
      <span class="road-rank-code">${escapeHtml(road)}</span>
      <span class="road-rank-bar"><i style="width:${Math.max(4, count / maximum * 100)}%"></i></span>
      <span class="road-rank-count">${formatInteger(count)}</span>
    </button>`).join("");
  elements["road-ranking"].querySelectorAll("[data-road]").forEach((button) => {
    button.addEventListener("click", () => {
      elements["road-filter"].value = button.dataset.road;
      applyFilters();
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
    .slice(0, 5);
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
      <i class="incident-row-dot" style="background:${incidentColor(incident)}"></i>
      <span class="incident-row-main"><strong>${escapeHtml(incident.road)} · ${escapeHtml(incident.city)}</strong><span>${escapeHtml(incident.type)} · ${formatDate(incident.date)}</span></span>
      <span class="incident-row-time">${escapeHtml(incident.time || "—")}</span>
    </button>`;
  }).join("");
  elements["incident-list"].querySelectorAll("[data-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const incident = incidents.find((item) => String(item.id) === button.dataset.id);
      if (incident) selectIncident(incident);
    });
  });
}

function renderIncidentDetail() {
  const incident = state.selectedIncident;
  if (!incident) {
    elements["incident-detail"].hidden = true;
    return;
  }
  elements["incident-detail"].hidden = false;
  elements["incident-detail"].innerHTML = `
    <div class="detail-head"><strong>${escapeHtml(incident.road)} · km ${escapeHtml(incident.km || "—")}</strong><button class="detail-close" type="button" aria-label="Fechar detalhes">×</button></div>
    <div class="detail-subtitle">${escapeHtml(incident.city)} · ${formatDate(incident.date)} às ${escapeHtml(incident.time || "horário não informado")}</div>
    <div class="detail-grid">
      <div class="detail-item"><span>Tipo</span><strong>${escapeHtml(incident.type)}</strong></div>
      <div class="detail-item"><span>Classificação</span><strong>${escapeHtml(incident.classification)}</strong></div>
      <div class="detail-item"><span>Causa registrada</span><strong>${escapeHtml(incident.cause)}</strong></div>
      <div class="detail-item"><span>Fase do dia</span><strong>${escapeHtml(incident.phase || "Não informada")}</strong></div>
      <div class="detail-item"><span>Mortos</span><strong>${formatInteger(nonNegative(incident.deaths))}</strong></div>
      <div class="detail-item"><span>Feridos</span><strong>${formatInteger(nonNegative(incident.minorInjuries) + nonNegative(incident.severeInjuries))}</strong></div>
      <div class="detail-item"><span>Clima</span><strong>${escapeHtml(incident.weather)}</strong></div>
      <div class="detail-item"><span>Pista</span><strong>${escapeHtml(incident.roadType)}</strong></div>
    </div>`;
  elements["incident-detail"].querySelector(".detail-close").addEventListener("click", () => {
    state.selectedIncident = null;
    renderIncidentDetail();
    renderIncidentList();
    drawMarkers();
  });
}

function selectIncident(incident) {
  state.selectedIncident = incident;
  renderIncidentDetail();
  renderIncidentList();
  drawMarkers();
}

let drawFrame = 0;
function drawMarkers() {
  cancelAnimationFrame(drawFrame);
  drawFrame = requestAnimationFrame(() => {
    const canvas = elements["markers"];
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const pixelRatio = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * pixelRatio);
    canvas.height = Math.round(rect.height * pixelRatio);
    const context = canvas.getContext("2d");
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, rect.width, rect.height);
    if (!state.viewBox) return;

    const scale = Math.min(rect.width / state.viewBox.width, rect.height / state.viewBox.height);
    const drawnWidth = state.viewBox.width * scale;
    const drawnHeight = state.viewBox.height * scale;
    const offsetX = (rect.width - drawnWidth) / 2;
    const offsetY = (rect.height - drawnHeight) / 2;
    state.filteredIncidents.forEach((incident) => {
      const [x, y] = toMapCoordinates(incident.longitude, incident.latitude);
      const screenX = offsetX + (x - state.viewBox.x) * scale;
      const screenY = offsetY + (y - state.viewBox.y) * scale;
      if (screenX < -8 || screenY < -8 || screenX > rect.width + 8 || screenY > rect.height + 8) return;
      const selected = state.selectedIncident && state.selectedIncident.id === incident.id;
      const radius = selected ? 6 : state.filteredIncidents.length > 5000 ? 2 : 3.2;
      context.beginPath();
      context.arc(screenX, screenY, radius, 0, Math.PI * 2);
      context.fillStyle = incidentColor(incident);
      context.globalAlpha = selected ? 1 : 0.78;
      context.fill();
      context.globalAlpha = 1;
      context.lineWidth = selected ? 2 : 1;
      context.strokeStyle = "#fff";
      context.stroke();
    });
  });
}

function onMapPointerDown(event) {
  if (!state.viewBox) return;
  event.currentTarget.setPointerCapture(event.pointerId);
  state.drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false, initial: { ...state.viewBox } };
}

function onMapPointerMove(event) {
  if (!state.drag || state.drag.pointerId !== event.pointerId) return;
  const dx = event.clientX - state.drag.startX;
  const dy = event.clientY - state.drag.startY;
  if (Math.abs(dx) + Math.abs(dy) > 3) state.drag.moved = true;
  if (!state.drag.moved) return;
  const rect = elements["markers"].getBoundingClientRect();
  const scale = Math.min(rect.width / state.viewBox.width, rect.height / state.viewBox.height);
  state.viewBox.x = state.drag.initial.x - dx / scale;
  state.viewBox.y = state.drag.initial.y - dy / scale;
  applyViewBox();
  drawMarkers();
}

function onMapPointerUp(event) {
  if (!state.drag || state.drag.pointerId !== event.pointerId) return;
  const moved = state.drag.moved;
  state.drag = null;
  if (!moved) selectNearestIncident(event);
}

function endMapDrag() {
  state.drag = null;
}

function selectNearestIncident(event) {
  if (!state.filteredIncidents.length || !state.viewBox) return;
  const rect = elements["markers"].getBoundingClientRect();
  const scale = Math.min(rect.width / state.viewBox.width, rect.height / state.viewBox.height);
  const offsetX = (rect.width - state.viewBox.width * scale) / 2;
  const offsetY = (rect.height - state.viewBox.height * scale) / 2;
  const clickX = event.clientX - rect.left;
  const clickY = event.clientY - rect.top;
  let nearest = null;
  let nearestDistance = 13;

  for (const incident of state.filteredIncidents) {
    const [x, y] = toMapCoordinates(incident.longitude, incident.latitude);
    const distance = Math.hypot(offsetX + (x - state.viewBox.x) * scale - clickX, offsetY + (y - state.viewBox.y) * scale - clickY);
    if (distance < nearestDistance) {
      nearest = incident;
      nearestDistance = distance;
    }
  }
  if (nearest) selectIncident(nearest);
}

function onMapWheel(event) {
  if (!state.viewBox) return;
  event.preventDefault();
  const rect = elements["markers"].getBoundingClientRect();
  const scale = Math.min(rect.width / state.viewBox.width, rect.height / state.viewBox.height);
  const offsetX = (rect.width - state.viewBox.width * scale) / 2;
  const offsetY = (rect.height - state.viewBox.height * scale) / 2;
  const anchorX = state.viewBox.x + (event.clientX - rect.left - offsetX) / scale;
  const anchorY = state.viewBox.y + (event.clientY - rect.top - offsetY) / scale;
  const factor = event.deltaY < 0 ? 0.84 : 1.19;
  const nextWidth = clamp(state.viewBox.width * factor, state.baseViewBox.width / 8, state.baseViewBox.width);
  const ratio = nextWidth / state.viewBox.width;
  state.viewBox = {
    x: anchorX - (anchorX - state.viewBox.x) * ratio,
    y: anchorY - (anchorY - state.viewBox.y) * ratio,
    width: nextWidth,
    height: state.viewBox.height * ratio
  };
  applyViewBox();
  drawMarkers();
}

function zoomBy(factor) {
  if (!state.viewBox || !state.baseViewBox) return;
  const width = clamp(state.viewBox.width / factor, state.baseViewBox.width / 8, state.baseViewBox.width);
  const height = width * state.viewBox.height / state.viewBox.width;
  const centerX = state.viewBox.x + state.viewBox.width / 2;
  const centerY = state.viewBox.y + state.viewBox.height / 2;
  state.viewBox = { x: centerX - width / 2, y: centerY - height / 2, width, height };
  applyViewBox();
  drawMarkers();
}

function resetMapView() {
  if (!state.baseViewBox) return;
  state.viewBox = { ...state.baseViewBox };
  applyViewBox();
  drawMarkers();
}

function applyViewBox() {
  if (!state.viewBox) return;
  const { x, y, width, height } = state.viewBox;
  elements["map-svg"].setAttribute("viewBox", `${x} ${y} ${width} ${height}`);
}

function resetFilters() {
  elements["search"].value = "";
  elements["road-filter"].value = "";
  elements["type-filter"].value = "";
  elements["cause-filter"].value = "";
  elements["period-filter"].value = "";
  elements["severity-filter"].value = "";
  applyFilters();
}

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
  return [longitude * Math.cos(20 * Math.PI / 180), -latitude];
}

function incidentColor(incident) {
  if (incident.deaths > 0) return "#d95c4e";
  if (incident.minorInjuries + incident.severeInjuries > 0) return "#db9a42";
  return "#4a9270";
}

function updateSourceCount() {
  const count = Number(state.prfIncidents.length > 0) + Number(state.stateVictims.length > 0);
  elements["source-count"].textContent = String(count);
}

function titleCase(value) {
  const minorWords = new Set(["da", "das", "de", "do", "dos", "e"]);
  return value.toLocaleLowerCase("pt-BR").split(/\s+/).map((word, index) => (
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

function formatDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value || "");
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value || "Data não informada";
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}
