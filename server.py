#!/usr/bin/env python3
"""
FindMy Location History Server
Polls Apple FindMy network via FindMy.py, stores history in SQLite, serves a map UI.
"""

from __future__ import annotations

import json
import logging
import os
import queue
import sqlite3
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from flask import Flask, Response, jsonify, request, send_from_directory, stream_with_context
from flask_cors import CORS

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# SSE log streaming
# ---------------------------------------------------------------------------

_log_clients: set[queue.Queue] = set()
_log_clients_lock = threading.Lock()


class _SseLogHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        msg = self.format(record)
        with _log_clients_lock:
            dead: set[queue.Queue] = set()
            for q in _log_clients:
                try:
                    q.put_nowait(msg)
                except queue.Full:
                    dead.add(q)
            _log_clients.difference_update(dead)


_sse_handler = _SseLogHandler()
_sse_handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s"))
logging.getLogger().addHandler(_sse_handler)

BASE_DIR = Path(__file__).parent
DEVICES_DIR = BASE_DIR / "devices"
DATA_DIR = BASE_DIR / "data"
DB_PATH = DATA_DIR / "locations.db"
ACCOUNT_PATH = DATA_DIR / "account.json"
ANISETTE_LIBS_PATH = DATA_DIR / "ani_libs.bin"

POLL_INTERVAL_SECONDS = int(os.environ.get("POLL_INTERVAL", "900"))  # default 15 min
ANISETTE_SERVER = os.environ.get("ANISETTE_SERVER", None)

# Google FindMy (GoogleFindMyTools integration)
GOOGLE_LOCATION_TIMEOUT = int(os.environ.get("GOOGLE_LOCATION_TIMEOUT", "30"))

DEVICE_COLORS = [
    "#e74c3c", "#3498db", "#2ecc71", "#f39c12", "#9b59b6",
    "#1abc9c", "#e67e22", "#e91e63", "#00bcd4", "#8bc34a",
]

app = Flask(__name__, static_folder="static")
CORS(app)

_poll_lock = threading.Lock()
_last_poll_time: float = 0.0
_poll_status: str = "idle"

_google_poll_lock = threading.Lock()
_last_google_poll_time: float = 0.0
_google_poll_status: str = "idle"


# ---------------------------------------------------------------------------
# Database helpers
# ---------------------------------------------------------------------------

def init_db() -> None:
    DATA_DIR.mkdir(exist_ok=True)
    with get_db() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS devices (
                id          TEXT PRIMARY KEY,
                name        TEXT,
                model       TEXT,
                file_path   TEXT NOT NULL DEFAULT '',
                file_type   TEXT NOT NULL DEFAULT 'json',
                color       TEXT NOT NULL DEFAULT '#3498db',
                visible     INTEGER NOT NULL DEFAULT 1,
                last_polled INTEGER,
                source      TEXT NOT NULL DEFAULT 'apple'
            );

            CREATE TABLE IF NOT EXISTS locations (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id   TEXT NOT NULL,
                timestamp   INTEGER NOT NULL,
                latitude    REAL NOT NULL,
                longitude   REAL NOT NULL,
                confidence  INTEGER,
                accuracy    REAL,
                status      INTEGER,
                FOREIGN KEY (device_id) REFERENCES devices(id),
                UNIQUE (device_id, timestamp)
            );

            CREATE INDEX IF NOT EXISTS idx_locations_device_ts
                ON locations (device_id, timestamp);
        """)
        # Migrate existing DBs that lack the source column
        try:
            conn.execute("ALTER TABLE devices ADD COLUMN source TEXT NOT NULL DEFAULT 'apple'")
        except Exception:
            pass  # column already exists


@contextmanager
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Device discovery
# ---------------------------------------------------------------------------

def _load_devices_from_disk() -> list[dict[str, Any]]:
    """Scan devices/ folder and register any new device files in the DB."""
    DEVICES_DIR.mkdir(exist_ok=True)
    found: list[dict[str, Any]] = []

    with get_db() as conn:
        existing_paths = {
            row["file_path"] for row in conn.execute("SELECT file_path FROM devices").fetchall()
        }
        existing_ids = {
            row["id"] for row in conn.execute("SELECT id FROM devices").fetchall()
        }
        color_idx = conn.execute("SELECT COUNT(*) FROM devices").fetchone()[0]

    for path in sorted(DEVICES_DIR.iterdir()):
        if path.suffix not in (".json", ".plist"):
            continue
        rel_path = str(path.relative_to(BASE_DIR))

        file_type = "plist" if path.suffix == ".plist" else "json"

        if file_type == "json":
            try:
                with open(path) as f:
                    data = json.load(f)
            except Exception:
                continue

            # macless-haystack exports a JSON array of AccessoryDTO objects
            if isinstance(data, list):
                # Google FindHub pseudo-rolling: [{index, eik, eid}, ...]
                if (data and isinstance(data[0], dict)
                        and "eik" in data[0] and "eid" in data[0] and "index" in data[0]
                        and "privateKey" not in data[0]):
                    device_id = "findhub_" + data[0]["eik"][:12]
                    if device_id not in existing_ids:
                        color = DEVICE_COLORS[color_idx % len(DEVICE_COLORS)]
                        color_idx += 1
                        name = path.stem
                        with get_db() as conn:
                            conn.execute(
                                """INSERT OR IGNORE INTO devices
                                   (id, name, model, file_path, file_type, color, source)
                                   VALUES (?, ?, 'Google FindHub', ?, 'findhub', ?, 'google_findhub')""",
                                (device_id, name, rel_path, color),
                            )
                        found.append({"id": device_id, "path": str(path), "type": "findhub"})
                        logger.info("Registered FindHub device: %s (%s)", name, device_id)
                        existing_ids.add(device_id)
                    continue

                for mh_dev in data:
                    if not isinstance(mh_dev, dict) or "privateKey" not in mh_dev:
                        continue
                    mh_int_id = mh_dev.get("id")
                    if mh_int_id is None:
                        continue
                    device_id = f"mh_{mh_int_id}"
                    if device_id in existing_ids:
                        continue
                    color = DEVICE_COLORS[color_idx % len(DEVICE_COLORS)]
                    color_idx += 1
                    name = mh_dev.get("name") or device_id
                    with get_db() as conn:
                        conn.execute(
                            """INSERT OR IGNORE INTO devices (id, name, model, file_path, file_type, color, source)
                               VALUES (?, ?, 'macless-haystack', ?, 'macless_haystack', ?, 'apple')""",
                            (device_id, name, rel_path, color),
                        )
                    found.append({"id": device_id, "path": str(path), "type": "macless_haystack"})
                    logger.info("Registered macless-haystack device: %s (%s)", name, device_id)
                    existing_ids.add(device_id)
                continue

            if rel_path in existing_paths:
                continue

            device_id = path.stem
            color = DEVICE_COLORS[color_idx % len(DEVICE_COLORS)]
            color_idx += 1
            name = data.get("name") or data.get("Name")
            model = data.get("model") or data.get("productType")
            with get_db() as conn:
                conn.execute(
                    """INSERT OR IGNORE INTO devices (id, name, model, file_path, file_type, color, source)
                       VALUES (?, ?, ?, ?, ?, ?, 'apple')""",
                    (device_id, name or device_id, model, rel_path, file_type, color),
                )
            found.append({"id": device_id, "path": str(path), "type": file_type})
            logger.info("Registered new device: %s (%s)", device_id, file_type)
        else:
            if rel_path in existing_paths:
                continue
            device_id = path.stem
            color = DEVICE_COLORS[color_idx % len(DEVICE_COLORS)]
            color_idx += 1
            with get_db() as conn:
                conn.execute(
                    """INSERT OR IGNORE INTO devices (id, name, model, file_path, file_type, color, source)
                       VALUES (?, ?, ?, ?, ?, ?, 'apple')""",
                    (device_id, device_id, None, rel_path, file_type, color),
                )
            found.append({"id": device_id, "path": str(path), "type": file_type})
            logger.info("Registered new device: %s (%s)", device_id, file_type)

    return found


# ---------------------------------------------------------------------------
# FindMy.py polling
# ---------------------------------------------------------------------------

def _load_macless_haystack_accessory(path: Path, device_db_id: str) -> Any:
    """Load a FixedRollingKeyPairAccessory from a macless-haystack array JSON file."""
    import base64
    try:
        from findmy import FixedRollingKeyPairAccessory
    except ImportError:
        raise RuntimeError("findmy package not installed. Run: pip install findmy")

    mh_int_id = int(device_db_id.removeprefix("mh_"))
    with open(path) as f:
        devices = json.load(f)

    mh_dev = next((d for d in devices if d.get("id") == mh_int_id), None)
    if mh_dev is None:
        raise ValueError(f"Device id={mh_int_id} not found in {path}")

    private_keys = [base64.b64decode(mh_dev["privateKey"]).hex()]
    for k in mh_dev.get("additionalKeys") or []:
        private_keys.append(base64.b64decode(k).hex())

    return FixedRollingKeyPairAccessory.from_json({
        "type": "custom_rolling_key_accessory",
        "private_keys": private_keys,
        "name": mh_dev.get("name"),
        "identifier": str(mh_int_id),
    })


def _do_poll() -> dict[str, Any]:
    global _last_poll_time, _poll_status

    if not ACCOUNT_PATH.exists():
        return {"ok": False, "error": "No account.json found. Run auth_setup.py first."}

    try:
        from findmy import AppleAccount, FindMyAccessory
    except ImportError:
        return {"ok": False, "error": "findmy package not installed. Run: pip install findmy"}

    _poll_status = "polling"

    _load_devices_from_disk()

    with get_db() as conn:
        device_rows = conn.execute("SELECT * FROM devices WHERE source = 'apple'").fetchall()

    if not device_rows:
        _poll_status = "idle"
        return {"ok": True, "message": "No devices registered. Add device files to the devices/ folder."}

    try:
        # from_json reads the anisette provider type stored in the JSON,
        # so it works for both local and remote providers transparently.
        acc = AppleAccount.from_json(
            str(ACCOUNT_PATH),
            anisette_libs_path=str(ANISETTE_LIBS_PATH),
        )
    except Exception as e:
        _poll_status = "error"
        logger.error("Failed to load account: %s", e)
        return {"ok": False, "error": f"Failed to load account: {e}"}

    accessories = []
    device_map: dict[Any, str] = {}  # accessory object -> device_id

    for row in device_rows:
        path = BASE_DIR / row["file_path"]
        if not path.exists():
            logger.warning("Device file not found: %s", path)
            continue
        try:
            if row["file_type"] == "plist":
                acc_obj = FindMyAccessory.from_plist(str(path))
            elif row["file_type"] == "macless_haystack":
                acc_obj = _load_macless_haystack_accessory(path, row["id"])
            else:
                acc_obj = FindMyAccessory.from_json(str(path))
            accessories.append(acc_obj)
            device_map[acc_obj] = row["id"]
        except Exception as e:
            logger.error("Failed to load device %s: %s", row["id"], e)

    if not accessories:
        _poll_status = "idle"
        return {"ok": True, "message": "No valid devices loaded."}

    logger.info("Polling FindMy for %d device(s)...", len(accessories))
    new_count = 0

    try:
        if len(accessories) == 1:
            reports_raw = acc.fetch_location_history(accessories[0])
            reports_dict = {accessories[0]: reports_raw} if isinstance(reports_raw, list) else {accessories[0]: [reports_raw]} if reports_raw else {}
        else:
            reports_dict = acc.fetch_location_history(accessories)

        for acc_obj, reports in reports_dict.items():
            device_id = device_map.get(acc_obj)
            if not device_id or not reports:
                continue
            for report in reports:
                try:
                    ts = int(report.timestamp.timestamp())
                    lat = report.latitude
                    lon = report.longitude
                    conf = getattr(report, "confidence", None)
                    acc_m = getattr(report, "horizontal_accuracy", None)
                    status = getattr(report, "status", None)
                    with get_db() as conn:
                        conn.execute(
                            """INSERT OR IGNORE INTO locations
                               (device_id, timestamp, latitude, longitude, confidence, accuracy, status)
                               VALUES (?, ?, ?, ?, ?, ?, ?)""",
                            (device_id, ts, lat, lon, conf, acc_m, status),
                        )
                        new_count += 1
                except Exception as e:
                    logger.warning("Skipping bad report for %s: %s", device_id, e)

        with get_db() as conn:
            conn.execute(
                "UPDATE devices SET last_polled = ? WHERE id IN (%s)"
                % ",".join("?" * len(device_map)),
                [int(time.time())] + list(device_map.values()),
            )

    except Exception as e:
        _poll_status = "error"
        logger.error("Poll failed: %s", e, exc_info=True)
        return {"ok": False, "error": str(e)}
    finally:
        try:
            acc.to_json(str(ACCOUNT_PATH))
        except Exception:
            pass

    _last_poll_time = time.time()
    _poll_status = "idle"
    logger.info("Poll complete. %d new reports stored.", new_count)
    return {"ok": True, "new_reports": new_count}


# ---------------------------------------------------------------------------
# Google FindMy polling
# ---------------------------------------------------------------------------

def _register_google_devices_in_db(devices: list[tuple[str, str]]) -> None:
    """Ensure Google FindMy devices are registered in the DB."""
    with get_db() as conn:
        color_idx = conn.execute("SELECT COUNT(*) FROM devices").fetchone()[0]

    for device_name, canonic_id in devices:
        device_id = f"google_{canonic_id}"
        color = DEVICE_COLORS[color_idx % len(DEVICE_COLORS)]
        with get_db() as conn:
            existing = conn.execute("SELECT id FROM devices WHERE id = ?", (device_id,)).fetchone()
            if not existing:
                conn.execute(
                    """INSERT INTO devices (id, name, model, file_path, file_type, color, source)
                       VALUES (?, ?, 'Google FindMy', '', 'google', ?, 'google')""",
                    (device_id, device_name, color),
                )
                logger.info("Registered Google device: %s (%s)", device_name, device_id)
                color_idx += 1


def _do_google_poll() -> dict[str, Any]:
    global _last_google_poll_time, _google_poll_status

    import google_poll

    if not google_poll.is_available():
        msg = "Google FindMy not configured (secret.json or google_findmy_tools/ missing)"
        logger.debug(msg)
        return {"ok": False, "error": msg}

    ok, err = google_poll.setup()
    if not ok:
        _google_poll_status = "error"
        logger.error("Google setup failed: %s", err)
        return {"ok": False, "error": err}

    _google_poll_status = "polling"

    try:
        devices, raw_device_list = google_poll.list_devices_full()
    except Exception as e:
        _google_poll_status = "error"
        logger.error("Google device list failed: %s", e)
        return {"ok": False, "error": f"Failed to list Google devices: {e}"}

    new_count = 0
    errors = []

    # --- Resolve FindHub canonical IDs first (before registering standard devices) ---
    # Pseudo-rolling devices register each EID period as a separate BLE device.
    # We find all matching canonical IDs and consolidate them into a single findhub entry.
    with get_db() as conn:
        findhub_rows = conn.execute(
            "SELECT id, name, file_path FROM devices WHERE source = 'google_findhub'"
        ).fetchall()

    all_findhub_canonic_ids: set[str] = set()
    findhub_canonic_ids_map: dict[str, list[str]] = {}  # findhub device_id -> [canonic_ids]
    findhub_eik_pairs_map: dict[str, list[dict]] = {}   # findhub device_id -> eik_eid_pairs

    for row in findhub_rows:
        file_path = BASE_DIR / row["file_path"]
        if not file_path.exists():
            continue
        try:
            eik_eid_pairs = google_poll.load_findhub_keys(str(file_path))
            findhub_eik_pairs_map[row["id"]] = eik_eid_pairs
        except Exception as e:
            logger.error("Failed to load FindHub keys for %s: %s", row["name"], e)
            continue

        # Use cached result, or run EIK matching against the Nova API device list
        canonic_ids = google_poll._findhub_canonic_ids_cache.get(row["file_path"])
        if canonic_ids is None:
            canonic_ids = google_poll.find_all_findhub_canonical_ids(eik_eid_pairs, raw_device_list)
            if canonic_ids:
                google_poll._findhub_canonic_ids_cache[row["file_path"]] = canonic_ids
                logger.info(
                    "FindHub '%s': matched %d canonical ID(s)", row["name"], len(canonic_ids)
                )

        if canonic_ids:
            all_findhub_canonic_ids.update(canonic_ids)
            findhub_canonic_ids_map[row["id"]] = canonic_ids

            # Consolidate: migrate existing google_ entries into this findhub device
            for cid in canonic_ids:
                google_dev_id = f"google_{cid}"
                with get_db() as conn:
                    if conn.execute("SELECT 1 FROM devices WHERE id = ?", (google_dev_id,)).fetchone():
                        # Move location history (ignore rows that already exist in findhub device)
                        conn.execute(
                            """INSERT OR IGNORE INTO locations
                               (device_id, timestamp, latitude, longitude, confidence, accuracy, status)
                               SELECT ?, timestamp, latitude, longitude, confidence, accuracy, status
                               FROM locations WHERE device_id = ?""",
                            (row["id"], google_dev_id),
                        )
                        conn.execute("DELETE FROM locations WHERE device_id = ?", (google_dev_id,))
                        conn.execute("DELETE FROM devices WHERE id = ?", (google_dev_id,))
                        logger.info("Consolidated %s → %s", google_dev_id, row["id"])

    # --- Standard Google FindMy devices (excluding those handled by findhub files) ---
    filtered_devices = [(n, c) for n, c in devices if c not in all_findhub_canonic_ids]
    if filtered_devices:
        _register_google_devices_in_db(filtered_devices)
        for device_name, canonic_id in filtered_devices:
            device_id = f"google_{canonic_id}"
            try:
                locations = google_poll.fetch_device_location(
                    canonic_id, device_name, timeout=GOOGLE_LOCATION_TIMEOUT
                )
                for lat, lon, ts, acc in locations:
                    with get_db() as conn:
                        conn.execute(
                            """INSERT OR IGNORE INTO locations
                               (device_id, timestamp, latitude, longitude, accuracy)
                               VALUES (?, ?, ?, ?, ?)""",
                            (device_id, ts, lat, lon, acc),
                        )
                    new_count += 1
                with get_db() as conn:
                    conn.execute(
                        "UPDATE devices SET last_polled = ? WHERE id = ?",
                        (int(time.time()), device_id),
                    )
            except TimeoutError as e:
                logger.warning("Google location timeout for %s: %s", device_name, e)
                errors.append(str(e))
            except Exception as e:
                logger.error("Google location error for %s: %s", device_name, e)
                errors.append(f"{device_name}: {e}")
    else:
        logger.info("No standard Google FindMy devices to poll.")

    # --- Google FindHub pseudo-rolling devices ---
    for row in findhub_rows:
        device_id = row["id"]
        name = row["name"]
        eik_eid_pairs = findhub_eik_pairs_map.get(device_id)
        if not eik_eid_pairs:
            continue

        canonic_ids = findhub_canonic_ids_map.get(device_id, [])
        if not canonic_ids:
            logger.warning(
                "FindHub device '%s': no matching canonical ID found. "
                "Register it with CreateBleDevice first.", name
            )
            errors.append(f"{name}: not found in Google account")
            continue

        try:
            locations = google_poll.fetch_findhub_device_location(
                canonic_ids, name, eik_eid_pairs, timeout=GOOGLE_LOCATION_TIMEOUT
            )
            for lat, lon, ts, acc in locations:
                with get_db() as conn:
                    conn.execute(
                        """INSERT OR IGNORE INTO locations
                           (device_id, timestamp, latitude, longitude, accuracy)
                           VALUES (?, ?, ?, ?, ?)""",
                        (device_id, ts, lat, lon, acc),
                    )
                new_count += 1
            with get_db() as conn:
                conn.execute(
                    "UPDATE devices SET last_polled = ? WHERE id = ?",
                    (int(time.time()), device_id),
                )
        except TimeoutError as e:
            logger.warning("FindHub location timeout for %s: %s", name, e)
            errors.append(str(e))
        except Exception as e:
            logger.error("FindHub location error for %s: %s", name, e)
            errors.append(f"{name}: {e}")

    _last_google_poll_time = time.time()
    _google_poll_status = "idle"
    logger.info("Google poll complete. %d new reports stored.", new_count)
    result: dict[str, Any] = {"ok": True, "new_reports": new_count}
    if errors:
        result["warnings"] = errors
    return result


def _background_poller() -> None:
    """Continuously polls FindMy (Apple + Google) in the background."""
    while True:
        time.sleep(60)  # wait 1 min before first poll to allow server startup
        if _poll_lock.acquire(blocking=False):
            try:
                _do_poll()
            finally:
                _poll_lock.release()
        if _google_poll_lock.acquire(blocking=False):
            try:
                _do_google_poll()
            finally:
                _google_poll_lock.release()
        time.sleep(POLL_INTERVAL_SECONDS - 60)


# ---------------------------------------------------------------------------
# REST API
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return send_from_directory("static", "index.html")


@app.route("/details")
def details():
    return send_from_directory("static", "details.html")


@app.route("/static/<path:filename>")
def static_files(filename):
    return send_from_directory("static", filename)


@app.route("/api/devices", methods=["GET"])
def api_get_devices():
    _load_devices_from_disk()
    with get_db() as conn:
        rows = conn.execute("""
            SELECT d.id, d.name, d.model, d.color, d.visible, d.last_polled, d.source,
                   l.latitude, l.longitude, l.timestamp as last_ts
            FROM devices d
            LEFT JOIN locations l ON l.id = (
                SELECT id FROM locations
                WHERE device_id = d.id
                ORDER BY timestamp DESC LIMIT 1
            )
        """).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/devices/<device_id>/visible", methods=["PUT"])
def api_set_visible(device_id: str):
    body = request.get_json(silent=True) or {}
    visible = 1 if body.get("visible", True) else 0
    with get_db() as conn:
        conn.execute("UPDATE devices SET visible = ? WHERE id = ?", (visible, device_id))
    return jsonify({"ok": True})


@app.route("/api/devices/<device_id>", methods=["DELETE"])
def api_delete_device(device_id: str):
    with get_db() as conn:
        conn.execute("DELETE FROM locations WHERE device_id = ?", (device_id,))
        conn.execute("DELETE FROM devices WHERE id = ?", (device_id,))
    return jsonify({"ok": True})


@app.route("/api/devices/<device_id>/name", methods=["PUT"])
def api_set_name(device_id: str):
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()
    if not name:
        return jsonify({"ok": False, "error": "Name cannot be empty"}), 400
    with get_db() as conn:
        conn.execute("UPDATE devices SET name = ? WHERE id = ?", (name, device_id))
    return jsonify({"ok": True})


@app.route("/api/locations", methods=["GET"])
def api_get_locations():
    device_id = request.args.get("device_id")
    start = request.args.get("start", type=int)
    end = request.args.get("end", type=int)

    query = "SELECT device_id, timestamp, latitude, longitude, confidence, accuracy, status FROM locations WHERE 1=1"
    params: list[Any] = []

    if device_id:
        query += " AND device_id = ?"
        params.append(device_id)
    if start is not None:
        query += " AND timestamp >= ?"
        params.append(start)
    if end is not None:
        query += " AND timestamp <= ?"
        params.append(end)

    query += " ORDER BY timestamp ASC"

    with get_db() as conn:
        rows = conn.execute(query, params).fetchall()

    return jsonify([dict(r) for r in rows])


@app.route("/api/poll", methods=["POST"])
def api_poll():
    source = request.args.get("source", "apple")

    if source == "google":
        if not _google_poll_lock.acquire(blocking=False):
            return jsonify({"ok": False, "error": "Google poll already in progress"}), 429
        try:
            result = _do_google_poll()
            return jsonify(result)
        finally:
            _google_poll_lock.release()

    if not _poll_lock.acquire(blocking=False):
        return jsonify({"ok": False, "error": "Poll already in progress"}), 429
    try:
        result = _do_poll()
        return jsonify(result)
    finally:
        _poll_lock.release()


@app.route("/api/status", methods=["GET"])
def api_status():
    import google_poll as gp

    with get_db() as conn:
        device_count = conn.execute("SELECT COUNT(*) FROM devices").fetchone()[0]
        report_count = conn.execute("SELECT COUNT(*) FROM locations").fetchone()[0]
        oldest = conn.execute("SELECT MIN(timestamp) FROM locations").fetchone()[0]
        newest = conn.execute("SELECT MAX(timestamp) FROM locations").fetchone()[0]

    return jsonify({
        "devices": device_count,
        "total_reports": report_count,
        "oldest_report": oldest,
        "newest_report": newest,
        "last_poll": _last_poll_time,
        "poll_status": _poll_status,
        "poll_interval_seconds": POLL_INTERVAL_SECONDS,
        "account_configured": ACCOUNT_PATH.exists(),
        "google_configured": gp.is_available(),
        "google_last_poll": _last_google_poll_time,
        "google_poll_status": _google_poll_status,
    })


@app.route("/api/logs")
def api_logs():
    def generate():
        client_q: queue.Queue = queue.Queue(maxsize=300)
        with _log_clients_lock:
            _log_clients.add(client_q)
        try:
            yield "data: [Log stream connected]\n\n"
            while True:
                try:
                    msg = client_q.get(timeout=20)
                    # Escape embedded newlines so each SSE message stays on one logical line
                    safe = msg.replace("\n", "↵")
                    yield f"data: {safe}\n\n"
                except queue.Empty:
                    yield ": keepalive\n\n"
        except GeneratorExit:
            pass
        finally:
            with _log_clients_lock:
                _log_clients.discard(client_q)

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    init_db()
    _load_devices_from_disk()

    poller_thread = threading.Thread(target=_background_poller, daemon=True)
    poller_thread.start()
    logger.info("Background poller started (interval: %ds)", POLL_INTERVAL_SECONDS)

    port = int(os.environ.get("PORT", "8080"))
    logger.info("Starting server on http://0.0.0.0:%d", port)
    app.run(host="0.0.0.0", port=port, debug=False)
