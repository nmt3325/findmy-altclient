"use strict";

// ---------------------------------------------------------------------------
// Map setup – Google Maps tiles (no API key required)
// ---------------------------------------------------------------------------

const MAP_TYPES = {
  roadmap:  { lyrs: "m", label: "Roadmap" },
  satellite:{ lyrs: "s", label: "Satellite" },
  hybrid:   { lyrs: "y", label: "Hybrid" },
  terrain:  { lyrs: "p", label: "Terrain" },
};
let currentMapType = "roadmap";

const map = L.map("map", { zoomControl: true }).setView([35.6812, 139.7671], 12);

function makeTileLayer(type) {
  const lyrs = MAP_TYPES[type].lyrs;
  return L.tileLayer(
    "https://mt{s}.google.com/vt/lyrs=" + lyrs + "&x={x}&y={y}&z={z}",
    {
      subdomains: ["0", "1", "2", "3"],
      maxZoom: 21,
      attribution: "© Google",
    }
  );
}
let tileLayer = makeTileLayer(currentMapType);
tileLayer.addTo(map);

// Map type switcher control
const MapTypeControl = L.Control.extend({
  options: { position: "topright" },
  onAdd() {
    const div = L.DomUtil.create("div", "map-type-control");
    Object.entries(MAP_TYPES).forEach(([key, val]) => {
      const btn = document.createElement("button");
      btn.textContent = val.label;
      btn.className = "map-type-btn" + (key === currentMapType ? " active" : "");
      btn.dataset.type = key;
      btn.addEventListener("click", () => {
        map.removeLayer(tileLayer);
        tileLayer = makeTileLayer(key);
        tileLayer.addTo(map);
        currentMapType = key;
        div.querySelectorAll(".map-type-btn").forEach(b => b.classList.toggle("active", b.dataset.type === key));
      });
      div.appendChild(btn);
    });
    L.DomEvent.disableClickPropagation(div);
    return div;
  },
});
new MapTypeControl().addTo(map);


// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let devices = [];           // [{id, name, color, visible, ...}]
let deviceLayers = {};      // device_id -> { polyline, markers[], points[] }
let rangeStart = null;
let rangeEnd   = null;
let expandedDeviceId = null;

// ---------------------------------------------------------------------------
// Bottom sheet (mobile only)
// ---------------------------------------------------------------------------

const SHEET_PEEK_H = 52;
const sheetEl = document.getElementById("sidebar");
const sheetHandle = document.getElementById("sheet-handle");

function isMobile() { return window.innerWidth <= 600; }
function sheetHalfH() { return Math.round(window.innerHeight * 0.52); }
function sheetFullH() { return Math.round(window.innerHeight * 0.88); }

function setSheetHeight(px, animated = true) {
  if (!animated) sheetEl.style.transition = "none";
  sheetEl.style.height = px + "px";
  if (!animated) requestAnimationFrame(() => { sheetEl.style.transition = ""; });
}

function snapSheet(h) {
  const states = [SHEET_PEEK_H, sheetHalfH(), sheetFullH()];
  const nearest = states.reduce((a, b) => Math.abs(a - h) < Math.abs(b - h) ? a : b);
  setSheetHeight(nearest);
}

function expandSheetIfPeeked() {
  if (isMobile() && sheetEl.getBoundingClientRect().height <= SHEET_PEEK_H + 8) {
    setSheetHeight(sheetHalfH());
  }
}

let _touchStartY = 0, _touchStartH = 0, _isDragging = false;

sheetHandle.addEventListener("touchstart", e => {
  if (!isMobile()) return;
  _touchStartY = e.touches[0].clientY;
  _touchStartH = sheetEl.getBoundingClientRect().height;
  _isDragging = true;
  sheetEl.style.transition = "none";
}, { passive: true });

document.addEventListener("touchmove", e => {
  if (!isMobile() || !_isDragging) return;
  const dy = _touchStartY - e.touches[0].clientY;
  const newH = Math.max(SHEET_PEEK_H, Math.min(sheetFullH(), _touchStartH + dy));
  sheetEl.style.height = newH + "px";
}, { passive: true });

document.addEventListener("touchend", () => {
  if (!isMobile() || !_isDragging) return;
  _isDragging = false;
  sheetEl.style.transition = "";
  snapSheet(sheetEl.getBoundingClientRect().height);
});

// Tap handle: toggle peek ↔ half
sheetHandle.addEventListener("click", () => {
  if (!isMobile()) return;
  const h = sheetEl.getBoundingClientRect().height;
  setSheetHeight(h <= SHEET_PEEK_H + 8 ? sheetHalfH() : SHEET_PEEK_H);
});

// ---------------------------------------------------------------------------
// Map navigation helpers (sheet-aware)
// ---------------------------------------------------------------------------

// Returns how many px the bottom sheet currently covers (0 on desktop).
function sheetCoveredPx() {
  return isMobile() ? sheetEl.getBoundingClientRect().height : 0;
}

// flyTo a latlng but offset the map center so the point lands in the
// center of the visible area above the bottom sheet.
function flyToVisible(latlng, zoom, duration = 1.2) {
  const targetZoom = zoom ?? map.getZoom();
  const offset = sheetCoveredPx() / 2; // pixels to shift map center south
  if (offset > 0) {
    const px = map.project(latlng, targetZoom);
    const adjusted = map.unproject(L.point(px.x, px.y + offset), targetZoom);
    map.flyTo(adjusted, targetZoom, { duration });
  } else {
    map.flyTo(latlng, targetZoom, { duration });
  }
}

// fitBounds but add bottom padding equal to the sheet height.
function fitBoundsVisible(bounds) {
  const sheetH = sheetCoveredPx();
  map.fitBounds(bounds, {
    paddingTopLeft:    [16, 16],
    paddingBottomRight:[16, sheetH + 16],
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtDatetime(ts) {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString();
}

function tsToInputValue(date) {
  if (!date) return "";
  const pad = n => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function inputToDate(val) {
  return val ? new Date(val) : null;
}

// Group location reports by timestamp and average their coordinates.
function groupByTimestamp(reports) {
  const buckets = {};
  for (const r of reports) {
    if (!buckets[r.timestamp]) buckets[r.timestamp] = [];
    buckets[r.timestamp].push(r);
  }
  return Object.entries(buckets)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([ts, pts]) => {
      const lat = pts.reduce((s, p) => s + p.latitude,  0) / pts.length;
      const lng = pts.reduce((s, p) => s + p.longitude, 0) / pts.length;
      const best = pts.reduce((a, b) =>
        (b.confidence ?? 0) >= (a.confidence ?? 0) ? b : a
      );
      return { timestamp: Number(ts), lat, lng,
               confidence: best.confidence, accuracy: best.accuracy, status: best.status,
               raw_count: pts.length };
    });
}

// Create a circle marker with popup for a location point.
function makeMarker(device, point) {
  const marker = L.circleMarker([point.lat, point.lng], {
    radius: 6,
    color: device.color,
    fillColor: device.color,
    fillOpacity: 0.85,
    weight: 2,
  });

  marker.on("click", (e) => {
    L.DomEvent.stopPropagation(e);
    showPointPopup(device, point);
  });

  return marker;
}

function showPointPopup(device, point) {
  const dt = new Date(point.timestamp * 1000);

  if (isMobile()) {
    // Show in the sheet's fixed header
    const metaParts = [
      `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`,
    ];
    if (point.accuracy != null) metaParts.push(`±${Math.round(point.accuracy)}m`);
    if (point.raw_count > 1)    metaParts.push(`avg ${point.raw_count}pts`);

    document.getElementById("sheet-point-device").textContent = device.name || device.id;
    document.getElementById("sheet-point-device").style.color = device.color;
    document.getElementById("sheet-point-time").textContent   = dt.toLocaleString();
    document.getElementById("sheet-point-meta").textContent   = metaParts.join("  ·  ");
    document.getElementById("sheet-point-info").classList.remove("hidden");

    // Ensure sheet is visible enough to show the header
    expandSheetIfPeeked();
  } else {
    // Desktop: floating popup
    const lines = [
      `<strong>${device.name || device.id}</strong>`,
      `<span class="popup-time">${dt.toLocaleString()}</span>`,
      `Lat: ${point.lat.toFixed(6)}`,
      `Lng: ${point.lng.toFixed(6)}`,
    ];
    if (point.accuracy   != null) lines.push(`Accuracy: ±${point.accuracy}m`);
    if (point.confidence != null) lines.push(`Confidence: ${point.confidence}`);
    if (point.raw_count  >  1)    lines.push(`(avg of ${point.raw_count} reports)`);

    document.getElementById("popup-content").innerHTML = lines.join("<br>");
    document.getElementById("popup").classList.remove("hidden");
  }
}

// ---------------------------------------------------------------------------
// Render device tracks on map
// ---------------------------------------------------------------------------

function clearDeviceLayers() {
  for (const { polyline, markers } of Object.values(deviceLayers)) {
    if (polyline) map.removeLayer(polyline);
    markers.forEach(m => map.removeLayer(m));
  }
  deviceLayers = {};
}

async function renderDevice(device) {
  if (deviceLayers[device.id]) {
    const { polyline, markers } = deviceLayers[device.id];
    if (polyline) map.removeLayer(polyline);
    markers.forEach(m => map.removeLayer(m));
  }

  if (!device.visible) {
    deviceLayers[device.id] = { polyline: null, markers: [], points: [] };
    return;
  }

  const params = new URLSearchParams({ device_id: device.id });
  if (rangeStart) params.append("start", Math.floor(rangeStart.getTime() / 1000));
  if (rangeEnd)   params.append("end",   Math.floor(rangeEnd.getTime()   / 1000));

  const resp = await fetch(`/api/locations?${params}`);
  if (!resp.ok) return;
  const raw = await resp.json();

  const points = groupByTimestamp(raw);

  if (points.length === 0) {
    deviceLayers[device.id] = { polyline: null, markers: [], points: [] };
    // If this device was expanded, refresh its history panel to show "no data"
    if (expandedDeviceId === device.id) refreshHistoryPanel(device);
    return;
  }

  const latlngs = points.map(p => [p.lat, p.lng]);

  const polyline = L.polyline(latlngs, {
    color: device.color,
    weight: 2,
    opacity: 0.7,
  }).addTo(map);

  const markers = points.map(p => makeMarker(device, p));

  // Latest point: larger marker
  const latest = points[points.length - 1];
  const latestMarker = L.circleMarker([latest.lat, latest.lng], {
    radius: 9,
    color: device.color,
    fillColor: device.color,
    fillOpacity: 1,
    weight: 3,
  });
  latestMarker.on("click", (e) => {
    L.DomEvent.stopPropagation(e);
    showPointPopup(device, latest);
  });

  markers.forEach(m => m.addTo(map));
  latestMarker.addTo(map);
  markers.push(latestMarker);

  deviceLayers[device.id] = { polyline, markers, points };

  // If this device was already expanded, refresh its history panel
  if (expandedDeviceId === device.id) refreshHistoryPanel(device);
}

async function renderAll() {
  await Promise.all(devices.map(d => renderDevice(d)));

  const visibleLayers = devices
    .filter(d => d.visible && deviceLayers[d.id]?.polyline)
    .map(d => deviceLayers[d.id].polyline);
  if (visibleLayers.length > 0) {
    const group = L.featureGroup(visibleLayers);
    fitBoundsVisible(group.getBounds());
  }
}

// ---------------------------------------------------------------------------
// Device history panel
// ---------------------------------------------------------------------------

function refreshHistoryPanel(device) {
  const panel = document.getElementById(`history-${device.id}`);
  if (!panel) return;
  renderHistoryItems(panel, device);
}

function renderHistoryItems(panel, device) {
  const points = deviceLayers[device.id]?.points ?? [];
  panel.innerHTML = "";

  if (points.length === 0) {
    panel.innerHTML = '<div class="history-empty">No data in selected range</div>';
    return;
  }

  // Show newest first
  const sorted = [...points].reverse();
  sorted.forEach(point => {
    const item = document.createElement("div");
    item.className = "history-item";

    const timeEl = document.createElement("span");
    timeEl.className = "history-time";
    timeEl.textContent = new Date(point.timestamp * 1000).toLocaleString();

    item.appendChild(timeEl);

    if (point.accuracy != null) {
      const accEl = document.createElement("span");
      accEl.className = "history-acc";
      accEl.textContent = `±${Math.round(point.accuracy)}m`;
      item.appendChild(accEl);
    }

    item.addEventListener("click", () => {
      flyToVisible([point.lat, point.lng], 17, 1.0);
      showPointPopup(device, point);
    });

    panel.appendChild(item);
  });
}

function toggleDeviceHistory(device, headerEl) {
  const panel = document.getElementById(`history-${device.id}`);
  const arrow = headerEl.querySelector(".device-arrow");
  const isOpen = expandedDeviceId === device.id;

  if (isOpen) {
    // Collapse
    panel.style.maxHeight = "0";
    arrow.classList.remove("open");
    expandedDeviceId = null;
  } else {
    // Collapse any other open panel first
    if (expandedDeviceId) {
      const prevPanel = document.getElementById(`history-${expandedDeviceId}`);
      const prevArrow = document.querySelector(`[data-device-id="${expandedDeviceId}"] .device-arrow`);
      if (prevPanel) prevPanel.style.maxHeight = "0";
      if (prevArrow) prevArrow.classList.remove("open");
    }

    expandedDeviceId = device.id;
    renderHistoryItems(panel, device);
    panel.style.maxHeight = panel.scrollHeight + "px";
    arrow.classList.add("open");

    // Auto-expand sheet on mobile so history list is visible
    expandSheetIfPeeked();

    // Zoom map to latest point
    const points = deviceLayers[device.id]?.points ?? [];
    if (points.length > 0) {
      const latest = points[points.length - 1];
      flyToVisible([latest.lat, latest.lng], 16, 1.2);
    }
  }
}

// ---------------------------------------------------------------------------
// Sidebar – device list
// ---------------------------------------------------------------------------

function renderDeviceList() {
  const el = document.getElementById("device-list");
  if (devices.length === 0) {
    el.innerHTML = '<p class="no-devices">No devices found.<br>Add .json or .plist files to the <code>devices/</code> folder.</p>';
    return;
  }
  el.innerHTML = "";
  devices.forEach(device => {
    // ── Card wrapper ──────────────────────────────────────────────────────
    const card = document.createElement("div");
    card.className = "device-card";

    // ── Header row ────────────────────────────────────────────────────────
    const header = document.createElement("div");
    header.className = "device-row-header";
    header.dataset.deviceId = device.id;

    const swatch = document.createElement("span");
    swatch.className = "device-color";
    swatch.style.background = device.color;

    // Name + arrow (clickable area)
    const nameBtn = document.createElement("div");
    nameBtn.className = "device-name-btn";

    const nameEl = document.createElement("span");
    nameEl.className = "device-name";
    nameEl.textContent = device.name || device.id;

    const arrow = document.createElement("span");
    arrow.className = "device-arrow";
    arrow.textContent = "▶";

    nameBtn.appendChild(nameEl);
    nameBtn.appendChild(arrow);
    nameBtn.addEventListener("click", () => toggleDeviceHistory(device, header));

    // Toggle switch
    const toggle = document.createElement("label");
    toggle.className = "toggle-switch";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = !!device.visible;
    checkbox.addEventListener("change", async () => {
      device.visible = checkbox.checked ? 1 : 0;
      await fetch(`/api/devices/${device.id}/visible`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visible: device.visible }),
      });
      renderDevice(device);
    });
    const slider = document.createElement("span");
    slider.className = "slider";
    toggle.appendChild(checkbox);
    toggle.appendChild(slider);

    const lastSeen = document.createElement("span");
    lastSeen.className = "device-last-seen";
    lastSeen.textContent = device.last_ts ? fmtDatetime(device.last_ts) : "No data";

    header.appendChild(swatch);
    header.appendChild(nameBtn);
    header.appendChild(toggle);
    header.appendChild(lastSeen);

    // ── History panel ─────────────────────────────────────────────────────
    const historyPanel = document.createElement("div");
    historyPanel.className = "device-history";
    historyPanel.id = `history-${device.id}`;
    historyPanel.style.maxHeight = "0";

    // Restore open state if this device was expanded before re-render
    if (expandedDeviceId === device.id) {
      renderHistoryItems(historyPanel, device);
      // Use setTimeout to allow DOM to render before measuring scrollHeight
      setTimeout(() => {
        historyPanel.style.maxHeight = historyPanel.scrollHeight + "px";
      }, 0);
      arrow.classList.add("open");
    }

    card.appendChild(header);
    card.appendChild(historyPanel);
    el.appendChild(card);
  });
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

async function updateStats() {
  const resp = await fetch("/api/status");
  if (!resp.ok) return;
  const s = await resp.json();

  const el = document.getElementById("stats-content");
  el.innerHTML = `
    <div class="stat"><span>Devices</span><strong>${s.devices}</strong></div>
    <div class="stat"><span>Reports stored</span><strong>${s.total_reports.toLocaleString()}</strong></div>
    <div class="stat"><span>Oldest</span><strong>${fmtDatetime(s.oldest_report)}</strong></div>
    <div class="stat"><span>Newest</span><strong>${fmtDatetime(s.newest_report)}</strong></div>
    <div class="stat"><span>Last poll</span><strong>${s.last_poll ? fmtDatetime(Math.floor(s.last_poll)) : "Never"}</strong></div>
    <div class="stat"><span>Next poll</span><strong>~${s.poll_interval_seconds / 60} min interval</strong></div>
  `;

  const label = s.poll_status === "polling" ? "Polling…" : s.account_configured ? "Idle" : "No account";
  const cls   = "status-badge " + (s.poll_status === "polling" ? "polling" : s.account_configured ? "idle" : "warn");
  const badge = document.getElementById("poll-status");
  badge.textContent = label; badge.className = cls;
  const miniBadge = document.getElementById("poll-status-mini");
  if (miniBadge) { miniBadge.textContent = label; miniBadge.className = cls; }
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

async function loadDevices() {
  const resp = await fetch("/api/devices");
  if (!resp.ok) return;
  devices = await resp.json();
  renderDeviceList();
}

document.getElementById("btn-apply").addEventListener("click", async () => {
  rangeStart = inputToDate(document.getElementById("range-start").value);
  rangeEnd   = inputToDate(document.getElementById("range-end").value);
  await renderAll();
});

document.querySelectorAll(".preset-btn").forEach(btn => {
  btn.addEventListener("click", async () => {
    const hours = Number(btn.dataset.hours);
    rangeEnd = new Date();
    rangeStart = new Date(rangeEnd.getTime() - hours * 3600 * 1000);
    document.getElementById("range-start").value = tsToInputValue(rangeStart);
    document.getElementById("range-end").value   = tsToInputValue(rangeEnd);
    await renderAll();
  });
});

document.getElementById("btn-poll").addEventListener("click", async () => {
  const btn = document.getElementById("btn-poll");
  btn.disabled = true;
  btn.textContent = "Polling…";
  document.getElementById("poll-status").textContent = "Polling…";
  document.getElementById("poll-status").className = "status-badge polling";

  try {
    const resp = await fetch("/api/poll", { method: "POST" });
    const result = await resp.json();
    if (!result.ok) {
      alert("Poll failed: " + (result.error || "Unknown error"));
    } else {
      await loadDevices();
      await renderAll();
    }
  } finally {
    btn.disabled = false;
    btn.textContent = "Poll Now";
    await updateStats();
  }
});

function dismissPointInfo() {
  document.getElementById("popup").classList.add("hidden");
  document.getElementById("sheet-point-info").classList.add("hidden");
}

document.getElementById("popup-close").addEventListener("click", dismissPointInfo);
document.getElementById("sheet-point-close").addEventListener("click", dismissPointInfo);
map.on("click", dismissPointInfo);

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

(async function init() {
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 24 * 3600 * 1000);
  rangeStart = dayAgo;
  rangeEnd   = now;
  document.getElementById("range-start").value = tsToInputValue(rangeStart);
  document.getElementById("range-end").value   = tsToInputValue(rangeEnd);

  await loadDevices();
  await renderAll();
  await updateStats();

  setInterval(updateStats, 30_000);
  setInterval(async () => {
    await loadDevices();
    await renderAll();
  }, 60_000);
})();
