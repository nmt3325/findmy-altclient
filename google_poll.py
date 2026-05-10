"""
Google FindMy integration for findmy-altclient.

Requirements:
  1. Clone GoogleFindMyTools into google_findmy_tools/:
       git clone https://github.com/leonboe1/GoogleFindMyTools google_findmy_tools
       pip install -r google_findmy_tools/requirements.txt
  2. Copy Auth/secrets.json from GoogleFindMyTools (after auth on another machine)
     to this project root as secret.json.
"""

from __future__ import annotations

import hashlib
import logging
import shutil
import sys
import time
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).parent
GOOGLE_SECRET_PATH = BASE_DIR / "secret.json"
GOOGLE_TOOLS_DIR = BASE_DIR / "google_findmy_tools"


def is_available() -> bool:
    return GOOGLE_SECRET_PATH.exists() and GOOGLE_TOOLS_DIR.exists()


def setup() -> tuple[bool, str]:
    """Prepare GoogleFindMyTools for import. Returns (success, error_message)."""
    if not GOOGLE_SECRET_PATH.exists():
        return False, "secret.json not found in project root"
    if not GOOGLE_TOOLS_DIR.exists():
        return False, (
            "google_findmy_tools/ directory not found. "
            "Run: git clone https://github.com/leonboe1/GoogleFindMyTools google_findmy_tools"
        )

    auth_dir = GOOGLE_TOOLS_DIR / "Auth"
    auth_dir.mkdir(exist_ok=True)
    shutil.copy2(str(GOOGLE_SECRET_PATH), str(auth_dir / "secrets.json"))

    tools_path = str(GOOGLE_TOOLS_DIR)
    if tools_path not in sys.path:
        sys.path.insert(0, tools_path)

    return True, ""


def list_devices_full() -> tuple[list[tuple[str, str]], Any]:
    """
    List Google FindMy devices from Nova API.
    Returns ([(device_name, canonic_id), ...], raw DevicesList protobuf).
    """
    from NovaApi.ListDevices.nbe_list_devices import request_device_list
    from ProtoDecoders.decoder import parse_device_list_protobuf, get_canonic_ids

    result_hex = request_device_list()
    device_list = parse_device_list_protobuf(result_hex)

    try:
        from SpotApi.UploadPrecomputedPublicKeyIds.upload_precomputed_public_key_ids import refresh_custom_trackers
        refresh_custom_trackers(device_list)
    except Exception as e:
        logger.debug("refresh_custom_trackers skipped: %s", e)

    return get_canonic_ids(device_list), device_list


def list_devices() -> list[tuple[str, str]]:
    """
    List Google FindMy devices from Nova API.
    Returns list of (device_name, canonic_id).
    """
    devices, _ = list_devices_full()
    return devices


# ---------------------------------------------------------------------------
# Google FindHub pseudo-rolling device support
# ---------------------------------------------------------------------------

import json as _json

_findhub_canonic_ids_cache: dict[str, list[str]] = {}  # rel_path -> [canonic_ids]


def load_findhub_keys(path: str) -> list[dict]:
    """
    Load EIK/EID pairs from a FindHub pseudo-rolling device file.
    Returns list of {index, eik (bytes), eid (bytes)}.
    """
    with open(path) as f:
        data = _json.load(f)
    entries = []
    for item in data:
        try:
            entries.append({
                "index": item["index"],
                "eik": bytes.fromhex(item["eik"]),
                "eid": bytes.fromhex(item["eid"]),
            })
        except Exception:
            pass
    return entries


def find_all_findhub_canonical_ids(eik_eid_pairs: list[dict], device_list: Any) -> list[str]:
    """
    Find ALL canonical IDs whose stored EIK matches any EIK in the findhub file.
    Pseudo-rolling devices register each EID period as a separate BLE device,
    so one findhub file may correspond to many canonical IDs.

    Note: retrieve_identity_key() calls exit(1) on decryption failure, so we
    catch BaseException (which includes SystemExit) and continue to the next device.
    """
    from NovaApi.ExecuteAction.LocateTracker.decrypt_locations import retrieve_identity_key, is_mcu_tracker

    known_eiks = {pair["eik"] for pair in eik_eid_pairs}
    matched: list[str] = []

    for device in device_list.deviceMetadata:
        if not is_mcu_tracker(device.information.deviceRegistration):
            continue
        try:
            identity_key = retrieve_identity_key(device.information.deviceRegistration)
            if identity_key in known_eiks:
                for cid in device.identifierInformation.canonicIds.canonicId:
                    matched.append(cid.id)
        except BaseException as e:
            logger.debug("Identity key retrieval skipped during findhub matching: %s", type(e).__name__)
            continue

    return matched


def find_findhub_canonical_id(eik_eid_pairs: list[dict], device_list: Any) -> str | None:
    """Return the first matching canonical ID, or None."""
    ids = find_all_findhub_canonical_ids(eik_eid_pairs, device_list)
    return ids[0] if ids else None


def _try_decrypt_findhub_loc(
    identity_key: bytes,
    enc_loc: bytes,
    pub_key: bytes,
) -> bytes | None:
    """Try AES-GCM (own report) or ECDH-EAX decryption with offset=0 (MCU-style)."""
    import hashlib
    from FMDNCrypto.foreign_tracker_cryptor import decrypt
    from KeyBackup.cloud_key_decryptor import decrypt_aes_gcm
    try:
        if pub_key == b"":
            return decrypt_aes_gcm(hashlib.sha256(identity_key).digest(), enc_loc)
        return decrypt(identity_key, enc_loc, pub_key, 0)
    except Exception:
        return None


def _extract_locations_findhub(
    device_update: Any,
    eik_eid_pairs: list[dict],
) -> list[tuple[float, float, int, float | None]]:
    """
    Decrypt locations from an FCM DeviceUpdate by trying each known EIK in turn.
    Each (EIK, EID) pair is independent (pseudo-rolling), so we brute-try until
    AES-EAX authentication succeeds.
    """
    from ProtoDecoders import DeviceUpdate_pb2, Common_pb2

    reports = (
        device_update.deviceMetadata.information
        .locationInformation.reports.recentLocationAndNetworkLocations
    )

    locs = list(reports.networkLocations)
    times = list(reports.networkLocationTimestamps)
    if reports.HasField("recentLocation"):
        locs.append(reports.recentLocation)
        times.append(reports.recentLocationTimestamp)

    results: list[tuple[float, float, int, float | None]] = []
    for loc, t in zip(locs, times):
        try:
            if loc.status == Common_pb2.Status.SEMANTIC:
                continue

            enc_loc = loc.geoLocation.encryptedReport.encryptedLocation
            pub_key = loc.geoLocation.encryptedReport.publicKeyRandom

            dec_bytes = None
            for pair in eik_eid_pairs:
                dec_bytes = _try_decrypt_findhub_loc(pair["eik"], enc_loc, pub_key)
                if dec_bytes is not None:
                    break

            if dec_bytes is None:
                logger.warning("Could not decrypt FindHub location entry with any known EIK")
                continue

            proto_loc = DeviceUpdate_pb2.Location()
            proto_loc.ParseFromString(dec_bytes)

            lat = proto_loc.latitude / 1e7
            lon = proto_loc.longitude / 1e7
            ts = int(t.seconds)
            acc = loc.geoLocation.accuracy or None

            if -90 <= lat <= 90 and -180 <= lon <= 180 and ts > 0:
                results.append((lat, lon, ts, acc))
        except Exception as e:
            logger.warning("Skipping FindHub location entry: %s", e)

    return results


def fetch_findhub_device_location(
    canonic_ids: list[str],
    name: str,
    eik_eid_pairs: list[dict],
    timeout: int = 30,
) -> list[tuple[float, float, int, float | None]]:
    """
    Request the current location for a FindHub pseudo-rolling device via FCM.
    Tries each canonical ID in sequence (each represents one rolling period).
    Stops at the first successful response. Decrypts by trying all known EIKs.
    """
    from Auth.fcm_receiver import FcmReceiver
    from NovaApi.ExecuteAction.LocateTracker.location_request import create_location_request
    from NovaApi.nova_request import nova_request
    from NovaApi.scopes import NOVA_ACTION_API_SCOPE
    from NovaApi.util import generate_random_uuid
    from ProtoDecoders.decoder import parse_device_update_protobuf

    per_id_timeout = max(8, timeout // max(len(canonic_ids), 1))

    for canonic_id in canonic_ids:
        result: list[Any] = [None]
        request_uuid = generate_random_uuid()

        def _on_fcm(hex_string: str, _uuid: str = request_uuid) -> None:
            try:
                update = parse_device_update_protobuf(hex_string)
                if update.fcmMetadata.requestUuid == _uuid:
                    result[0] = update
            except Exception as e:
                logger.debug("FCM parse skip: %s", e)

        receiver = FcmReceiver()
        fcm_token = receiver.register_for_location_updates(_on_fcm)

        logger.info("[FindHub] Requesting location for %s (canonic_id=%s)...", name, canonic_id[:8])
        hex_payload = create_location_request(canonic_id, fcm_token, request_uuid)
        nova_request(NOVA_ACTION_API_SCOPE, hex_payload)

        deadline = time.time() + per_id_timeout
        while result[0] is None and time.time() < deadline:
            time.sleep(0.1)

        try:
            receiver.location_update_callbacks.remove(_on_fcm)
        except (ValueError, AttributeError):
            pass

        if result[0] is not None:
            locs = _extract_locations_findhub(result[0], eik_eid_pairs)
            if locs:
                return locs

    raise TimeoutError(f"No FCM response for FindHub device '{name}' from any of {len(canonic_ids)} canonical ID(s)")


def _extract_locations(device_update: Any) -> list[tuple[float, float, int, float | None]]:
    """
    Decrypt and extract location data from a DeviceUpdate protobuf.
    Returns list of (latitude, longitude, unix_timestamp, accuracy_meters).
    """
    from NovaApi.ExecuteAction.LocateTracker.decrypt_locations import retrieve_identity_key, is_mcu_tracker
    from KeyBackup.cloud_key_decryptor import decrypt_aes_gcm
    from FMDNCrypto.foreign_tracker_cryptor import decrypt
    from ProtoDecoders import DeviceUpdate_pb2, Common_pb2

    device_registration = device_update.deviceMetadata.information.deviceRegistration

    try:
        identity_key = retrieve_identity_key(device_registration)
    except SystemExit:
        logger.error("Identity key decryption failed (owner key mismatch). Re-auth may be needed.")
        return []

    is_mcu = is_mcu_tracker(device_registration)
    reports = (
        device_update.deviceMetadata.information
        .locationInformation.reports.recentLocationAndNetworkLocations
    )

    locs = list(reports.networkLocations)
    times = list(reports.networkLocationTimestamps)

    if reports.HasField("recentLocation"):
        locs.append(reports.recentLocation)
        times.append(reports.recentLocationTimestamp)

    results: list[tuple[float, float, int, float | None]] = []
    for loc, t in zip(locs, times):
        try:
            if loc.status == Common_pb2.Status.SEMANTIC:
                continue

            enc_loc = loc.geoLocation.encryptedReport.encryptedLocation
            pub_key = loc.geoLocation.encryptedReport.publicKeyRandom

            if pub_key == b"":
                dec_bytes = decrypt_aes_gcm(hashlib.sha256(identity_key).digest(), enc_loc)
            else:
                offset = 0 if is_mcu else loc.geoLocation.deviceTimeOffset
                dec_bytes = decrypt(identity_key, enc_loc, pub_key, offset)

            proto_loc = DeviceUpdate_pb2.Location()
            proto_loc.ParseFromString(dec_bytes)

            lat = proto_loc.latitude / 1e7
            lon = proto_loc.longitude / 1e7
            ts = int(t.seconds)
            acc = loc.geoLocation.accuracy or None

            if -90 <= lat <= 90 and -180 <= lon <= 180 and ts > 0:
                results.append((lat, lon, ts, acc))
        except Exception as e:
            logger.warning("Skipping undecryptable location entry: %s", e)

    return results


def fetch_device_location(
    canonic_id: str,
    name: str,
    timeout: int = 30,
) -> list[tuple[float, float, int, float | None]]:
    """
    Request the current location of a Google FindMy device via FCM.
    Blocks until a response arrives or timeout expires.
    Returns list of (latitude, longitude, unix_timestamp, accuracy_meters).
    """
    from Auth.fcm_receiver import FcmReceiver
    from NovaApi.ExecuteAction.LocateTracker.location_request import create_location_request
    from NovaApi.nova_request import nova_request
    from NovaApi.scopes import NOVA_ACTION_API_SCOPE
    from NovaApi.util import generate_random_uuid
    from ProtoDecoders.decoder import parse_device_update_protobuf

    result: list[Any] = [None]
    request_uuid = generate_random_uuid()

    def _on_fcm(hex_string: str) -> None:
        try:
            update = parse_device_update_protobuf(hex_string)
            if update.fcmMetadata.requestUuid == request_uuid:
                result[0] = update
        except Exception as e:
            logger.debug("FCM parse skip: %s", e)

    receiver = FcmReceiver()
    fcm_token = receiver.register_for_location_updates(_on_fcm)

    logger.info("[Google] Requesting location for %s...", name)
    hex_payload = create_location_request(canonic_id, fcm_token, request_uuid)
    nova_request(NOVA_ACTION_API_SCOPE, hex_payload)

    deadline = time.time() + timeout
    while result[0] is None and time.time() < deadline:
        time.sleep(0.1)

    try:
        receiver.location_update_callbacks.remove(_on_fcm)
    except ValueError:
        pass

    if result[0] is None:
        raise TimeoutError(f"No FCM response for '{name}' within {timeout}s")

    return _extract_locations(result[0])
