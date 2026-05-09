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

const SHEET_PEEK_H       = 52;   // default peek: pill + title row
const SHEET_POINT_PEEK_H = 104;  // point-selected peek: pill + 3 info rows
const sheetEl     = document.getElementById("sidebar");
const sheetHandle = document.getElementById("sheet-handle");

let _pointInfoVisible = false;

function isMobile() { return window.innerWidth <= 600; }
function sheetHalfH() { return Math.round(window.innerHeight * 0.52); }
function sheetFullH() { return Math.round(window.innerHeight * 0.88); }
function currentPeekH() { return _pointInfoVisible ? SHEET_POINT_PEEK_H : SHEET_PEEK_H; }

function setSheetHeight(px, animated = true) {
  if (!animated) sheetEl.style.transition = "none";
  sheetEl.style.height = px + "px";
  if (!animated) requestAnimationFrame(() => { sheetEl.style.transition = ""; });
}

function snapSheet(h) {
  const states = [currentPeekH(), sheetHalfH(), sheetFullH()];
  const nearest = states.reduce((a, b) => Math.abs(a - h) < Math.abs(b - h) ? a : b);
  setSheetHeight(nearest);
}

function expandSheetIfPeeked() {
  if (isMobile() && sheetEl.getBoundingClientRect().height <= currentPeekH() + 8) {
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
  setSheetHeight(h <= currentPeekH() + 8 ? sheetHalfH() : currentPeekH());
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
    // Show in the always-visible handle area
    const metaParts = [`${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`];
    if (point.accuracy != null) metaParts.push(`±${Math.round(point.accuracy)}m`);
    if (point.raw_count > 1)    metaParts.push(`avg ${point.raw_count}pts`);

    document.getElementById("smp-device").textContent   = device.name || device.id;
    document.getElementById("smp-device").style.color   = device.color;
    document.getElementById("smp-time").textContent     = dt.toLocaleString();
    document.getElementById("smp-meta").textContent     = metaParts.join("  ·  ");
    document.getElementById("sheet-mini-point").classList.remove("hidden");
    document.getElementById("sheet-mini-default").classList.add("hidden");

    _pointInfoVisible = true;
    // Expand to point-peek height if currently at default peek
    const curH = sheetEl.getBoundingClientRect().height;
    if (curH <= SHEET_PEEK_H + 8) setSheetHeight(SHEET_POINT_PEEK_H);
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
// Device name inline edit
// ---------------------------------------------------------------------------

function startNameEdit(device, nameEl, editBtn) {
  // Prevent multiple edits at once
  if (nameEl.parentNode.querySelector(".device-name-input")) return;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "device-name-input";
  input.value = device.name || device.id;

  let saved = false;

  const save = async () => {
    if (saved) return;
    saved = true;
    const newName = input.value.trim();
    input.replaceWith(nameEl);
    editBtn.style.display = "";
    if (newName && newName !== device.name) {
      await fetch(`/api/devices/${device.id}/name`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName }),
      });
      device.name = newName;
      nameEl.textContent = newName;
    }
  };

  const cancel = () => {
    if (saved) return;
    saved = true;
    input.replaceWith(nameEl);
    editBtn.style.display = "";
  };

  input.addEventListener("blur", save);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); input.blur(); }
    if (e.key === "Escape") { input.removeEventListener("blur", save); cancel(); }
  });

  nameEl.replaceWith(input);
  editBtn.style.display = "none";
  input.focus();
  input.select();
}

// ---------------------------------------------------------------------------
// Sidebar – device list
// ---------------------------------------------------------------------------

function renderDeviceList() {
  const el = document.getElementById("device-list");
  if (devices.length === 0) {
    el.innerHTML = '<p class="no-devices">No devices found.<br>Add .json or .plist files to the <code>devices/</code> folder.</p>';
    updateToggleAllLabel();
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

    // Clicking the header (non-interactive areas) flies to latest location
    header.addEventListener("click", () => {
      const points = deviceLayers[device.id]?.points ?? [];
      if (points.length > 0) {
        const latest = points[points.length - 1];
        flyToVisible([latest.lat, latest.lng], 16, 1.2);
        showPointPopup(device, latest);
      }
    });

    const swatch = document.createElement("span");
    swatch.className = "device-color";
    swatch.style.background = device.color;

    // Name + edit icon + arrow
    const nameBtn = document.createElement("div");
    nameBtn.className = "device-name-btn";
    // Stop propagation so nameBtn clicks don't trigger the header fly-to
    nameBtn.addEventListener("click", (e) => e.stopPropagation());

    const nameEl = document.createElement("span");
    nameEl.className = "device-name";
    nameEl.textContent = device.name || device.id;
    nameEl.addEventListener("click", () => toggleDeviceHistory(device, header));

    if (device.source === "google") {
      const badge = document.createElement("span");
      badge.className = "source-badge source-google";
      badge.textContent = "Google";
      nameEl.appendChild(badge);
    }

    const editBtn = document.createElement("button");
    editBtn.className = "device-edit-btn";
    editBtn.title = "Rename device";
    editBtn.textContent = "✎";
    editBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      startNameEdit(device, nameEl, editBtn);
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "device-delete-btn";
    deleteBtn.title = "Delete device";
    deleteBtn.textContent = "🗑";
    deleteBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const msg = `「${device.name || device.id}」を削除しますか？\n\nDBから位置履歴ごと削除されます。devices/ フォルダのファイルは残るため、次回ポーリング時に再登録されます。ファイルも不要な場合は手動で削除してください。`;
      if (!confirm(msg)) return;
      const resp = await fetch(`/api/devices/${device.id}`, { method: "DELETE" });
      if (!resp.ok) { alert("削除に失敗しました"); return; }
      // Remove from local state
      if (deviceLayers[device.id]) {
        const { polyline, markers } = deviceLayers[device.id];
        if (polyline) map.removeLayer(polyline);
        markers.forEach(m => map.removeLayer(m));
        delete deviceLayers[device.id];
      }
      if (expandedDeviceId === device.id) expandedDeviceId = null;
      devices = devices.filter(d => d.id !== device.id);
      renderDeviceList();
      updateToggleAllLabel();
      updateStats();
    });

    const arrow = document.createElement("span");
    arrow.className = "device-arrow";
    arrow.textContent = "▶";

    nameBtn.appendChild(nameEl);
    nameBtn.appendChild(editBtn);
    nameBtn.appendChild(deleteBtn);
    nameBtn.appendChild(arrow);

    // Toggle switch – stop propagation so it doesn't trigger header click
    const toggle = document.createElement("label");
    toggle.className = "toggle-switch";
    toggle.addEventListener("click", (e) => e.stopPropagation());
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
      updateToggleAllLabel();
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

  updateToggleAllLabel();
}

// ---------------------------------------------------------------------------
// Toggle all devices
// ---------------------------------------------------------------------------

function updateToggleAllLabel() {
  const btn = document.getElementById("btn-toggle-all");
  if (!btn) return;
  const allVisible = devices.length > 0 && devices.every(d => d.visible);
  btn.textContent = allVisible ? "Hide All" : "Show All";
}

async function toggleAllDevices() {
  const allVisible = devices.every(d => d.visible);
  const newVisible = allVisible ? 0 : 1;

  await Promise.all(devices.map(d => {
    d.visible = newVisible;
    return fetch(`/api/devices/${d.id}/visible`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visible: newVisible }),
    });
  }));

  renderDeviceList();
  await renderAll();
}

// ---------------------------------------------------------------------------
// Poll details panel
// ---------------------------------------------------------------------------

let _pollDetailsOpen = false;
let _pollDetailsInterval = null;

function togglePollDetails() {
  _pollDetailsOpen = !_pollDetailsOpen;
  const panel = document.getElementById("poll-details-panel");
  const badge = document.getElementById("poll-status");

  if (_pollDetailsOpen) {
    panel.classList.add("open");
    badge.setAttribute("aria-expanded", "true");
    updatePollDetails();
    _pollDetailsInterval = setInterval(updatePollDetails, 3000);
  } else {
    panel.classList.remove("open");
    badge.setAttribute("aria-expanded", "false");
    if (_pollDetailsInterval) {
      clearInterval(_pollDetailsInterval);
      _pollDetailsInterval = null;
    }
  }
}

function fmtCountdown(secs) {
  if (secs <= 0) return "soon";
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

async function updatePollDetails() {
  const resp = await fetch("/api/status");
  if (!resp.ok) return;
  const s = await resp.json();

  const now = Date.now() / 1000;
  const nextPollAt = s.last_poll ? s.last_poll + s.poll_interval_seconds : null;
  const secsUntilNext = nextPollAt ? Math.max(0, Math.round(nextPollAt - now)) : null;

  const statusLabel = s.poll_status === "polling" ? "Polling…"
    : s.poll_status === "error" ? "Error"
    : s.account_configured ? "Idle" : "No account";
  const statusClass = s.poll_status === "polling" ? "polling"
    : s.poll_status === "error" ? "error"
    : s.account_configured ? "idle" : "warn";

  const googleLabel = s.google_poll_status === "polling" ? "Polling…"
    : s.google_poll_status === "error" ? "Error"
    : s.google_configured ? "Idle" : "Not configured";
  const googleClass = s.google_poll_status === "polling" ? "polling"
    : s.google_poll_status === "error" ? "error"
    : s.google_configured ? "idle" : "warn";

  const el = document.getElementById("poll-details-content");
  el.innerHTML = `
    <div class="pd-section-title">Apple FindMy</div>
    <div class="pd-row"><span>Status</span><strong class="status-text ${statusClass}">${statusLabel}</strong></div>
    <div class="pd-row"><span>Last poll</span><strong>${s.last_poll ? fmtDatetime(Math.floor(s.last_poll)) : "Never"}</strong></div>
    <div class="pd-row"><span>Next poll</span><strong>${s.poll_status === "polling" ? "Now" : secsUntilNext !== null ? fmtCountdown(secsUntilNext) : "—"}</strong></div>
    <div class="pd-row"><span>Interval</span><strong>${s.poll_interval_seconds / 60} min</strong></div>
    <div class="pd-section-title">Google FindMy</div>
    <div class="pd-row"><span>Status</span><strong class="status-text ${googleClass}">${googleLabel}</strong></div>
    <div class="pd-row"><span>Last poll</span><strong>${s.google_last_poll ? fmtDatetime(Math.floor(s.google_last_poll)) : "Never"}</strong></div>
    <div class="pd-section-title">Overall</div>
    <div class="pd-row"><span>Reports stored</span><strong>${s.total_reports.toLocaleString()}</strong></div>
  `;
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

  const label = s.poll_status === "polling" ? "Polling…"
    : s.poll_status === "error" ? "Error"
    : s.account_configured ? "Idle" : "No account";
  const cls   = "status-badge " + (s.poll_status === "polling" ? "polling"
    : s.poll_status === "error" ? "error"
    : s.account_configured ? "idle" : "warn");
  const badge = document.getElementById("poll-status");
  badge.textContent = label; badge.className = cls;
  const miniBadge = document.getElementById("poll-status-mini");
  if (miniBadge) { miniBadge.textContent = label; miniBadge.className = cls; }

  // If details panel is open, refresh it too
  if (_pollDetailsOpen) updatePollDetails();
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
    const now = new Date();
    if (btn.dataset.days) {
      const days = Number(btn.dataset.days);
      rangeEnd   = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 0);
      rangeStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days, 0, 0, 0);
    } else {
      const hours = Number(btn.dataset.hours);
      rangeEnd   = now;
      rangeStart = new Date(now.getTime() - hours * 3600 * 1000);
    }
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
    btn.textContent = "Poll Apple";
    await updateStats();
  }
});

document.getElementById("btn-poll-google").addEventListener("click", async () => {
  const btn = document.getElementById("btn-poll-google");
  btn.disabled = true;
  btn.textContent = "Polling…";

  try {
    const resp = await fetch("/api/poll?source=google", { method: "POST" });
    const result = await resp.json();
    if (!result.ok) {
      alert("Google poll failed: " + (result.error || "Unknown error"));
    } else {
      const msg = result.new_reports != null
        ? `Google poll complete: ${result.new_reports} new report(s).`
        : result.message || "Done.";
      if (result.warnings?.length) {
        console.warn("Google poll warnings:", result.warnings);
      }
      await loadDevices();
      await renderAll();
    }
  } finally {
    btn.disabled = false;
    btn.textContent = "Poll Google";
    await updateStats();
  }
});

document.getElementById("btn-toggle-all").addEventListener("click", toggleAllDevices);

document.getElementById("poll-status").addEventListener("click", togglePollDetails);
const pollStatusMini = document.getElementById("poll-status-mini");
if (pollStatusMini) {
  pollStatusMini.style.cursor = "pointer";
  pollStatusMini.addEventListener("click", (e) => {
    e.stopPropagation();
    expandSheetIfPeeked();
    togglePollDetails();
  });
}

function dismissPointInfo() {
  document.getElementById("popup").classList.add("hidden");
  document.getElementById("sheet-mini-point").classList.add("hidden");
  document.getElementById("sheet-mini-default").classList.remove("hidden");
  if (_pointInfoVisible) {
    _pointInfoVisible = false;
    // Shrink from point-peek back to default peek if sheet is at that height
    if (isMobile() && sheetEl.getBoundingClientRect().height <= SHEET_POINT_PEEK_H + 8) {
      setSheetHeight(SHEET_PEEK_H);
    }
  }
}

document.getElementById("popup-close").addEventListener("click", dismissPointInfo);
document.getElementById("sheet-point-close").addEventListener("click", dismissPointInfo);
map.on("click", dismissPointInfo);

// ---------------------------------------------------------------------------
// Live log streaming
// ---------------------------------------------------------------------------

let _logEventSource = null;
let _logsOpen = false;

function toggleLogs() {
  _logsOpen = !_logsOpen;
  const panel = document.getElementById("log-panel");
  const btn   = document.getElementById("btn-toggle-logs");

  if (_logsOpen) {
    panel.classList.remove("hidden");
    btn.textContent = "Hide";
    startLogStream();
    expandSheetIfPeeked();
  } else {
    panel.classList.add("hidden");
    btn.textContent = "Show";
    stopLogStream();
  }
}

function startLogStream() {
  if (_logEventSource) return;

  const output = document.getElementById("log-output");
  _logEventSource = new EventSource("/api/logs");

  _logEventSource.onmessage = (e) => {
    const autoscroll = document.getElementById("log-autoscroll")?.checked ?? true;
    const line = document.createElement("div");
    line.className = "log-line";
    const text = e.data;
    if (text.includes("[ERROR]"))   line.classList.add("log-error");
    else if (text.includes("[WARNING]")) line.classList.add("log-warn");
    else if (text.includes("[DEBUG]"))   line.classList.add("log-debug");
    line.textContent = text;
    output.appendChild(line);

    // Cap at 1000 lines to avoid memory growth
    while (output.children.length > 1000) output.removeChild(output.firstChild);

    if (autoscroll) output.scrollTop = output.scrollHeight;
  };

  _logEventSource.onerror = () => {
    const line = document.createElement("div");
    line.className = "log-line log-warn";
    line.textContent = "[Connection lost — will reconnect automatically]";
    output.appendChild(line);
    output.scrollTop = output.scrollHeight;
  };
}

function stopLogStream() {
  if (_logEventSource) {
    _logEventSource.close();
    _logEventSource = null;
  }
}

document.getElementById("btn-toggle-logs").addEventListener("click", toggleLogs);

document.getElementById("btn-log-clear").addEventListener("click", () => {
  document.getElementById("log-output").innerHTML = "";
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

(async function init() {
  const now = new Date();
  rangeStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  rangeEnd   = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 0);
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
