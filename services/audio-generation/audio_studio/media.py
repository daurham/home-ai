"""Audio files, checksums, and optional MP3 previews."""

from __future__ import annotations

import hashlib
import math
import shutil
import struct
import subprocess
import wave
from pathlib import Path


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def wav_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as handle:
        frames = handle.getnframes()
        rate = handle.getframerate() or 1
        return frames / float(rate)


def write_tone(path: Path, seconds: float = 1.0, rate: int = 22050, freq: float = 220.0) -> None:
    """Write a short valid PCM WAV. Used by the fake backend and tests."""
    path.parent.mkdir(parents=True, exist_ok=True)
    frames = max(1, int(seconds * rate))
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        samples = bytearray()
        for i in range(frames):
            value = int(8000 * math.sin(2 * math.pi * freq * (i / rate)))
            samples += struct.pack("<h", value)
        handle.writeframes(bytes(samples))


def transcode_mp3(wav_path: Path, mp3_path: Path, ffmpeg: str) -> bool:
    if not ffmpeg:
        return False
    mp3_path.parent.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        [
            ffmpeg, "-y", "-i", str(wav_path),
            "-codec:a", "libmp3lame", "-qscale:a", "4",
            str(mp3_path),
        ],
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
    )
    return result.returncode == 0 and mp3_path.is_file() and mp3_path.stat().st_size > 0


def find_ffmpeg(explicit: str = "") -> str:
    if explicit and Path(explicit).is_file():
        return explicit
    found = shutil.which("ffmpeg")
    if found:
        return found
    try:
        import imageio_ffmpeg
    except ImportError:
        return ""
    try:
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return ""


def safe_child(root: Path, name: str) -> Path:
    root = root.resolve()
    candidate = (root / name).resolve()
    if candidate.parent != root:
        raise ValueError("path escapes the inbox")
    return candidate
