"use strict";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let allReports    = [];   // Raw data from API (current fetch)
let devices       = {};   // device_id -> device object
let filteredReports = []; // After client-side search/filter
let sortCol  = "timestamp";
let sortAsc  = true;
let currentPage = 1;
let pageSize    = 50;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtDatetime(ts) {
  if (ts == null) return "—";
  return new Date(ts * 1000).toLocaleString();
}

function tsToInputValue(date) {
  if (!date) return "";
  const pad = n => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function inputToTimestamp(val) {
  if (!val) return null;
  return Math.floor(new Date(val).getTime() / 1000);
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Device filter UI
// ---------------------------------------------------------------------------

function buildDeviceFilter() {
  const container = document.getElementById("device-filter-list");
  container.innerHTML = "";

  // "All Devices" master checkbox
  const allLabel = document.createElement("label");
  allLabel.className = "filter-check";
  const allCb = document.createElement("input");
  allCb.type = "checkbox";
  allCb.id = "filter-all-devices";
  allCb.checked = true;
  allCb.addEventListener("change", () => {
    container.querySelectorAll(".device-cb").forEach(cb => {
      cb.checked = allCb.checked;
    });
  });
  const allSpan = document.createElement("span");
  allSpan.textContent = "All Devices";
  allLabel.appendChild(allCb);
  allLabel.appendChild(allSpan);
  container.appendChild(allLabel);

  Object.values(devices).forEach(dev => {
    const label = document.createElement("label");
    label.className = "filter-check";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "device-cb";
    cb.dataset.deviceId = dev.id;
    cb.checked = true;
    cb.addEventListener("change", () => {
      const all = [...container.querySelectorAll(".device-cb")].every(c => c.checked);
      document.getElementById("filter-all-devices").checked = all;
    });

    const swatch = document.createElement("span");
    swatch.className = "device-swatch-sm";
    swatch.style.background = dev.color || "#ccc";

    const name = document.createElement("span");
    name.textContent = dev.name || dev.id;

    label.appendChild(cb);
    label.appendChild(swatch);
    label.appendChild(name);
    container.appendChild(label);
  });
}

function getSelectedDeviceIds() {
  const cbs = document.querySelectorAll(".device-cb:checked");
  return new Set([...cbs].map(cb => cb.dataset.deviceId));
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

async function loadDevices() {
  const resp = await fetch("/api/devices");
  if (!resp.ok) return;
  const list = await resp.json();
  devices = {};
  list.forEach(d => { devices[d.id] = d; });
  buildDeviceFilter();
}

async function fetchReports() {
  const start = inputToTimestamp(document.getElementById("filter-start").value);
  const end   = inputToTimestamp(document.getElementById("filter-end").value);

  const params = new URLSearchParams();
  if (start != null) params.set("start", start);
  if (end   != null) params.set("end",   end);

  setSummary("Loading…");

  const resp = await fetch(`/api/locations?${params}`);
  if (!resp.ok) { allReports = []; return; }
  allReports = await resp.json();
}

// ---------------------------------------------------------------------------
// Client-side filtering
// ---------------------------------------------------------------------------

function applyFilters() {
  const selectedDevices = getSelectedDeviceIds();
  const confMin  = parseFloat(document.getElementById("filter-conf-min").value);
  const confMax  = parseFloat(document.getElementById("filter-conf-max").value);
  const accMin   = parseFloat(document.getElementById("filter-acc-min").value);
  const accMax   = parseFloat(document.getElementById("filter-acc-max").value);
  const statusVal = document.getElementById("filter-status").value.trim();
  const statusFilter = statusVal !== "" ? parseInt(statusVal, 10) : null;
  const search   = document.getElementById("search-input").value.trim().toLowerCase();

  filteredReports = allReports.filter(r => {
    // Device
    if (!selectedDevices.has(r.device_id)) return false;

    // Confidence range
    if (!isNaN(confMin) && r.confidence != null && r.confidence < confMin) return false;
    if (!isNaN(confMax) && r.confidence != null && r.confidence > confMax) return false;

    // Accuracy range
    if (!isNaN(accMin) && r.accuracy != null && r.accuracy < accMin) return false;
    if (!isNaN(accMax) && r.accuracy != null && r.accuracy > accMax) return false;

    // Status exact match
    if (statusFilter !== null && r.status !== statusFilter) return false;

    // Text search
    if (search) {
      const dev     = devices[r.device_id];
      const devName = (dev?.name || dev?.id || r.device_id).toLowerCase();
      const ts      = fmtDatetime(r.timestamp).toLowerCase();
      const lat     = String(r.latitude);
      const lng     = String(r.longitude);
      const conf    = r.confidence != null ? String(r.confidence) : "";
      const acc     = r.accuracy   != null ? String(r.accuracy)   : "";
      const stat    = r.status     != null ? String(r.status)     : "";
      const matched = devName.includes(search) || ts.includes(search) ||
                      lat.includes(search)     || lng.includes(search) ||
                      conf.includes(search)    || acc.includes(search) ||
                      stat.includes(search);
      if (!matched) return false;
    }

    return true;
  });

  sortAndRender();
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

function sortAndRender() {
  filteredReports.sort((a, b) => {
    let va, vb;

    if (sortCol === "device_id") {
      const da = devices[a.device_id];
      const db = devices[b.device_id];
      va = (da?.name || da?.id || a.device_id).toLowerCase();
      vb = (db?.name || db?.id || b.device_id).toLowerCase();
    } else {
      va = a[sortCol];
      vb = b[sortCol];
    }

    if (va == null && vb == null) return 0;
    if (va == null) return 1;   // nulls last
    if (vb == null) return -1;
    const cmp = va < vb ? -1 : va > vb ? 1 : 0;
    return sortAsc ? cmp : -cmp;
  });

  currentPage = 1;
  renderTable();
}

// ---------------------------------------------------------------------------
// Table rendering
// ---------------------------------------------------------------------------

function renderTable() {
  const tbody     = document.getElementById("report-tbody");
  const total     = filteredReports.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (currentPage > totalPages) currentPage = totalPages;

  const startIdx = (currentPage - 1) * pageSize;
  const pageRows = filteredReports.slice(startIdx, startIdx + pageSize);

  if (total === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="table-empty">No reports match the current filters.</td></tr>';
  } else {
    tbody.innerHTML = "";
    pageRows.forEach((r, i) => {
      const dev      = devices[r.device_id];
      const color    = dev?.color || "#ccc";
      const devName  = escHtml(dev?.name || dev?.id || r.device_id);
      const rowNum   = startIdx + i + 1;

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="col-num">${rowNum}</td>
        <td class="col-device">
          <span class="device-swatch-sm" style="background:${escHtml(color)}"></span>
          ${devName}
        </td>
        <td class="col-time">${escHtml(fmtDatetime(r.timestamp))}</td>
        <td class="col-lat">${r.latitude.toFixed(6)}</td>
        <td class="col-lng">${r.longitude.toFixed(6)}</td>
        <td class="col-conf">${r.confidence != null ? r.confidence : '<span class="null-val">—</span>'}</td>
        <td class="col-acc">${r.accuracy   != null ? r.accuracy.toFixed(1) : '<span class="null-val">—</span>'}</td>
        <td class="col-status">${r.status  != null ? r.status : '<span class="null-val">—</span>'}</td>
        <td class="col-action">
          <a href="https://maps.google.com/?q=${r.latitude},${r.longitude}"
             target="_blank" rel="noopener noreferrer"
             class="map-link" title="${r.latitude.toFixed(6)}, ${r.longitude.toFixed(6)}">⊙</a>
        </td>
      `;
      tbody.appendChild(tr);
    });
  }

  // Summary text
  const loaded = allReports.length;
  if (total === loaded) {
    setSummary(`${total.toLocaleString()} report${total !== 1 ? "s" : ""}`);
  } else {
    setSummary(`${total.toLocaleString()} of ${loaded.toLocaleString()} reports`);
  }

  // Pagination controls
  document.getElementById("page-info").textContent = `Page ${currentPage} / ${totalPages}`;
  document.getElementById("btn-prev").disabled = currentPage <= 1;
  document.getElementById("btn-next").disabled = currentPage >= totalPages;

  // Sort indicators
  document.querySelectorAll(".sortable").forEach(th => {
    th.classList.remove("sort-asc", "sort-desc");
    if (th.dataset.col === sortCol) {
      th.classList.add(sortAsc ? "sort-asc" : "sort-desc");
    }
  });
}

function setSummary(text) {
  document.getElementById("summary-count").textContent = text;
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

function exportCSV() {
  const headers = ["#", "Device ID", "Device Name", "Unix Timestamp", "Date/Time",
                   "Latitude", "Longitude", "Confidence", "Accuracy (m)", "Status"];

  const rows = filteredReports.map((r, i) => {
    const dev = devices[r.device_id];
    return [
      i + 1,
      r.device_id,
      dev?.name || dev?.id || r.device_id,
      r.timestamp,
      fmtDatetime(r.timestamp),
      r.latitude,
      r.longitude,
      r.confidence != null ? r.confidence : "",
      r.accuracy   != null ? r.accuracy   : "",
      r.status     != null ? r.status     : "",
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(",");
  });

  const csv  = [headers.join(","), ...rows].join("\r\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `findmy-reports-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

document.getElementById("btn-apply-filter").addEventListener("click", async () => {
  await fetchReports();
  applyFilters();
});

document.getElementById("btn-reset-filter").addEventListener("click", () => {
  const now   = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0,  0, 0);
  const end   = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 0);
  document.getElementById("filter-start").value    = tsToInputValue(start);
  document.getElementById("filter-end").value      = tsToInputValue(end);
  document.getElementById("filter-conf-min").value = "";
  document.getElementById("filter-conf-max").value = "";
  document.getElementById("filter-acc-min").value  = "";
  document.getElementById("filter-acc-max").value  = "";
  document.getElementById("filter-status").value   = "";
  document.getElementById("search-input").value    = "";
  document.querySelectorAll(".device-cb").forEach(cb => { cb.checked = true; });
  document.getElementById("filter-all-devices").checked = true;
  applyFilters();
});

// Preset time range buttons
document.querySelectorAll(".preset-btn").forEach(btn => {
  btn.addEventListener("click", async () => {
    const now = new Date();
    if (btn.dataset.all) {
      document.getElementById("filter-start").value = "";
      document.getElementById("filter-end").value   = "";
    } else if (btn.dataset.days) {
      const days = Number(btn.dataset.days);
      const end  = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 0);
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days, 0, 0, 0);
      document.getElementById("filter-start").value = tsToInputValue(start);
      document.getElementById("filter-end").value   = tsToInputValue(end);
    } else {
      const hours = Number(btn.dataset.hours);
      const end   = now;
      const start = new Date(now.getTime() - hours * 3600 * 1000);
      document.getElementById("filter-start").value = tsToInputValue(start);
      document.getElementById("filter-end").value   = tsToInputValue(end);
    }
    await fetchReports();
    applyFilters();
  });
});

// Live search
document.getElementById("search-input").addEventListener("input", () => {
  applyFilters();
});

// Column sort
document.querySelectorAll(".sortable").forEach(th => {
  th.addEventListener("click", () => {
    const col = th.dataset.col;
    if (sortCol === col) {
      sortAsc = !sortAsc;
    } else {
      sortCol = col;
      sortAsc = col !== "timestamp"; // default desc for timestamp
      if (col === "timestamp") sortAsc = false;
    }
    sortAndRender();
  });
});

// Pagination
document.getElementById("btn-prev").addEventListener("click", () => {
  if (currentPage > 1) { currentPage--; renderTable(); }
});
document.getElementById("btn-next").addEventListener("click", () => {
  const totalPages = Math.ceil(filteredReports.length / pageSize);
  if (currentPage < totalPages) { currentPage++; renderTable(); }
});
document.getElementById("page-size-select").addEventListener("change", e => {
  pageSize = Number(e.target.value);
  currentPage = 1;
  renderTable();
});

document.getElementById("btn-export-csv").addEventListener("click", exportCSV);

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

(async function init() {
  const now   = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0,  0, 0);
  const end   = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 0);
  document.getElementById("filter-start").value = tsToInputValue(start);
  document.getElementById("filter-end").value   = tsToInputValue(end);

  await loadDevices();
  await fetchReports();

  // Default sort: newest first
  sortCol = "timestamp";
  sortAsc = false;
  applyFilters();
})();
