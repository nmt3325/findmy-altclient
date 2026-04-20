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
let deviceLayers = {};      // device_id -> { polyline, markers[] }
let rangeStart = null;      // JS Date | null
let rangeEnd   = null;      // JS Date | null

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
    const dt = new Date(point.timestamp * 1000);
    const lines = [
      `<strong>${device.name}</strong>`,
      `<span class="popup-time">${dt.toLocaleString()}</span>`,
      `Lat: ${point.lat.toFixed(6)}`,
      `Lng: ${point.lng.toFixed(6)}`,
    ];
    if (point.accuracy != null) lines.push(`Accuracy: ±${point.accuracy}m`);
    if (point.confidence != null) lines.push(`Confidence: ${point.confidence}`);
    if (point.raw_count > 1) lines.push(`(avg of ${point.raw_count} reports)`);

    document.getElementById("popup-content").innerHTML = lines.join("<br>");
    document.getElementById("popup").classList.remove("hidden");
  });

  return marker;
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
  // Remove existing layers for this device
  if (deviceLayers[device.id]) {
    const { polyline, markers } = deviceLayers[device.id];
    if (polyline) map.removeLayer(polyline);
    markers.forEach(m => map.removeLayer(m));
  }

  if (!device.visible) {
    deviceLayers[device.id] = { polyline: null, markers: [] };
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
    deviceLayers[device.id] = { polyline: null, markers: [] };
    return;
  }

  const latlngs = points.map(p => [p.lat, p.lng]);

  const polyline = L.polyline(latlngs, {
    color: device.color,
    weight: 2,
    opacity: 0.7,
  }).addTo(map);

  const markers = points.map(p => makeMarker(device, p));
  // Latest point gets a bigger star-like marker
  const latestMarker = L.circleMarker([points[points.length - 1].lat, points[points.length - 1].lng], {
    radius: 9,
    color: device.color,
    fillColor: device.color,
    fillOpacity: 1,
    weight: 3,
  });
  latestMarker.on("click", (e) => {
    L.DomEvent.stopPropagation(e);
    markers[markers.length - 1].fire("click", e);
  });

  markers.forEach(m => m.addTo(map));
  latestMarker.addTo(map);
  markers.push(latestMarker);

  deviceLayers[device.id] = { polyline, markers };
}

async function renderAll() {
  const promises = devices.map(d => renderDevice(d));
  await Promise.all(promises);

  // Fit map to visible tracks
  const visibleLayers = devices
    .filter(d => d.visible && deviceLayers[d.id]?.polyline)
    .map(d => deviceLayers[d.id].polyline);
  if (visibleLayers.length > 0) {
    const group = L.featureGroup(visibleLayers);
    map.fitBounds(group.getBounds().pad(0.1));
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
    const row = document.createElement("div");
    row.className = "device-row";

    const swatch = document.createElement("span");
    swatch.className = "device-color";
    swatch.style.background = device.color;

    const nameEl = document.createElement("span");
    nameEl.className = "device-name";
    nameEl.textContent = device.name || device.id;

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

    row.appendChild(swatch);
    row.appendChild(nameEl);
    row.appendChild(toggle);
    row.appendChild(lastSeen);
    el.appendChild(row);
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

  const badge = document.getElementById("poll-status");
  badge.textContent = s.poll_status === "polling" ? "Polling…" : s.account_configured ? "Idle" : "No account";
  badge.className = "status-badge " + (s.poll_status === "polling" ? "polling" : s.account_configured ? "idle" : "warn");
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

document.getElementById("popup-close").addEventListener("click", () => {
  document.getElementById("popup").classList.add("hidden");
});
map.on("click", () => document.getElementById("popup").classList.add("hidden"));

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

(async function init() {
  // Default range: last 24 hours
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 24 * 3600 * 1000);
  rangeStart = dayAgo;
  rangeEnd   = now;
  document.getElementById("range-start").value = tsToInputValue(rangeStart);
  document.getElementById("range-end").value   = tsToInputValue(rangeEnd);

  await loadDevices();
  await renderAll();
  await updateStats();

  // Refresh stats every 30s
  setInterval(updateStats, 30_000);
  // Refresh device list every 60s (picks up new poll results)
  setInterval(async () => {
    await loadDevices();
    await renderAll();
  }, 60_000);
})();
