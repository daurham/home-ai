"""Private reference clips. They are stored locally and are not sent to the model."""

from __future__ import annotations

import hashlib
import json
import re
import struct
import uuid
from pathlib import Path

REF_ID = re.compile(r"^ref_[a-f0-9]{16}$")
MAX_BYTES = 12_000_000
MAX_COUNT = 6
MIN_SECONDS = 5
MAX_SECONDS = 30
RATES = {44100, 48000}


class ReferenceError(ValueError):
    pass


def reference_dir(config) -> Path:
    path = (Path(config.home) / "data" / "references").resolve()
    path.mkdir(parents=True, exist_ok=True)
    return path


def list_references(config) -> list[dict]:
    root = reference_dir(config)
    rows = []
    for path in sorted(root.glob("ref_*.json")):
        if not REF_ID.match(path.stem):
            continue
        audio = _contained(root, path.stem + ".wav")
        if audio is None:
            continue
        record = _read(path)
        if record:
            rows.append(record)
    return rows


def reference_audio(config, ref_id: str) -> Path | None:
    if not REF_ID.match(ref_id):
        return None
    return _contained(reference_dir(config), ref_id + ".wav")


def save_reference(config, data: bytes, rights: str, original_name: str) -> dict:
    if rights != "yes":
        raise ReferenceError("Confirm that you have the rights to use this recording.")
    if len(data) > MAX_BYTES:
        raise ReferenceError("Reference audio must be 12 MB or smaller.")
    info = inspect_wav(data)
    root = reference_dir(config)
    existing = [path for path in root.glob("ref_*.wav") if REF_ID.match(path.stem)]
    if len(existing) >= MAX_COUNT:
        raise ReferenceError("The reference folder already has six clips. Remove one before adding another.")
    ref_id = "ref_" + uuid.uuid4().hex[:16]
    audio = root / f"{ref_id}.wav"
    meta = root / f"{ref_id}.json"
    audio.write_bytes(data)
    audio.chmod(0o600)
    record = {
        "id": ref_id,
        "audio": f"/references/{ref_id}",
        "seconds": info["seconds"],
        "sample_rate": info["sample_rate"],
        "channels": info["channels"],
        "sha256": hashlib.sha256(data).hexdigest(),
        "size_bytes": len(data),
        "original_name": _safe_name(original_name),
        "rights": "private-local-use",
        "used_for_generation": False,
    }
    meta.write_text(json.dumps(record, indent=2), encoding="utf-8")
    meta.chmod(0o600)
    return record


def inspect_wav(data: bytes) -> dict:
    if len(data) < 44 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise ReferenceError("Only a PCM WAV file can be saved.")
    offset = 12
    fmt = None
    data_size = None
    while offset + 8 <= len(data):
        chunk = data[offset : offset + 4]
        size = struct.unpack_from("<I", data, offset + 4)[0]
        start = offset + 8
        end = start + size
        if end > len(data):
            raise ReferenceError("The WAV file is incomplete.")
        if chunk == b"fmt ":
            if size < 16:
                raise ReferenceError("The WAV format chunk is incomplete.")
            audio_format, channels, rate, _, _, bits = struct.unpack_from("<HHIIHH", data, start)
            fmt = (audio_format, channels, rate, bits)
        elif chunk == b"data":
            data_size = size
        offset = end + (size % 2)
    if not fmt or data_size is None:
        raise ReferenceError("The WAV file has no playable audio.")
    audio_format, channels, rate, bits = fmt
    if audio_format != 1 or bits != 16 or channels not in {1, 2} or rate not in RATES:
        raise ReferenceError("Use 16-bit PCM WAV at 44.1 or 48 kHz, mono or stereo.")
    frame = channels * 2
    if data_size % frame:
        raise ReferenceError("The WAV audio data is truncated.")
    seconds = (data_size / frame) / rate
    if seconds < MIN_SECONDS or seconds > MAX_SECONDS:
        raise ReferenceError("A reference clip must be between 5 and 30 seconds.")
    return {"seconds": round(seconds, 3), "sample_rate": rate, "channels": channels}


def _contained(root: Path, name: str) -> Path | None:
    path = (root / name).resolve()
    if path.parent != root or not path.is_file():
        return None
    return path


def _read(path: Path) -> dict | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict) or not REF_ID.match(str(data.get("id") or "")):
        return None
    return {
        "id": data["id"],
        "audio": f"/references/{data['id']}",
        "seconds": data.get("seconds"),
        "sample_rate": data.get("sample_rate"),
        "channels": data.get("channels"),
        "sha256": data.get("sha256") or "",
        "size_bytes": data.get("size_bytes"),
        "original_name": data.get("original_name") or "",
        "rights": data.get("rights") or "",
        "used_for_generation": False,
    }


def _safe_name(value: str) -> str:
    name = Path(str(value or "reference.wav")).name
    cleaned = "".join(ch if ch.isalnum() or ch in {".", "-", "_"} else "-" for ch in name)
    return cleaned[:80] or "reference.wav"
