"""Optional listening copies. Original WAV masters are never modified."""

from __future__ import annotations

import json
import math
import struct
import wave
from pathlib import Path

from .media import sha256_file, transcode_mp3, wav_duration

# The 60-second synthwave test stays near RMS 0.05–0.20 through 51.75s,
# then sits at about 0.0005 from 52.25s to 60s. 0.004 is far above that
# floor and far below a quiet musical window.
RMS_THRESHOLD = 0.004
MIN_TAIL_SECONDS = 1.5
MIN_KEEP_SECONDS = 2.0
MUSICAL_RMS = 0.02
FADE_SECONDS = 0.12
FADE_PEAK = 0.01


def analyze_wav(path: Path, window_seconds: float = 0.25) -> dict:
    """Return duration and windowed RMS/peak for a 16-bit PCM WAV."""
    with wave.open(str(path), "rb") as handle:
        channels = handle.getnchannels()
        width = handle.getsampwidth()
        rate = handle.getframerate()
        if width != 2 or channels < 1 or rate < 1:
            raise ValueError("listening analysis supports 16-bit PCM")
        window_frames = max(1, int(rate * window_seconds))
        windows = []
        total_frames = 0
        while True:
            raw = handle.readframes(window_frames)
            if not raw:
                break
            count = len(raw) // 2
            if count == 0:
                break
            samples = struct.unpack("<" + "h" * count, raw[: count * 2])
            frames = count // channels
            if frames <= 0:
                break
            square = 0.0
            peak = 0
            for value in samples:
                square += value * value
                peak = max(peak, abs(value))
            windows.append(
                {
                    "t": total_frames / rate,
                    "rms": math.sqrt(square / len(samples)) / 32768.0,
                    "peak": peak / 32768.0,
                }
            )
            total_frames += frames
    return {
        "duration": total_frames / rate,
        "rate": rate,
        "channels": channels,
        "windows": windows,
    }


def detect_trailing_silence(analysis: dict) -> dict:
    """Find a long quiet tail without treating an internal rest as an ending."""
    windows = analysis["windows"]
    duration = float(analysis["duration"])
    if not windows:
        return _silence(None, None, False, "file has no samples")
    last_loud = -1
    for index, window in enumerate(windows):
        if window["rms"] >= RMS_THRESHOLD:
            last_loud = index
    if last_loud < 0:
        return _silence(None, None, False, "no musical level found; the file was left unchanged")
    if last_loud == len(windows) - 1:
        return _silence(None, None, False, "no trailing silence")
    silence_start = float(windows[last_loud + 1]["t"])
    tail = duration - silence_start
    musical = any(
        window["rms"] >= MUSICAL_RMS and window["t"] < silence_start for window in windows
    )
    if tail < MIN_TAIL_SECONDS:
        return _silence(
            silence_start,
            duration,
            False,
            f"trailing quiet section is {tail:.2f}s, shorter than {MIN_TAIL_SECONDS:.1f}s",
        )
    if silence_start < MIN_KEEP_SECONDS or not musical:
        return _silence(
            silence_start,
            duration,
            False,
            "the quiet section is not a tail after a musical passage",
        )
    return _silence(silence_start, duration, True, "substantial trailing silence")


def prepare_listening_copy(wav_path: Path, library_dir: Path, asset_id: str) -> dict:
    """Write a trimmed copy when the tail is silent. The source file is not opened for writing."""
    wav_path = Path(wav_path)
    library_dir = Path(library_dir)
    before = sha256_file(wav_path)
    before_size = wav_path.stat().st_size
    analysis = analyze_wav(wav_path)
    decision = detect_trailing_silence(analysis)
    original_duration = wav_duration(wav_path)
    report = {
        "asset_id": asset_id,
        "original_sha256": before,
        "original_size_bytes": before_size,
        "original_duration_seconds": original_duration,
        "silence_start_seconds": decision["silence_start"],
        "silence_end_seconds": decision["silence_end"],
        "substantial": decision["substantial"],
        "trimmed": False,
        "fade_applied": False,
        "fade_seconds": 0.0,
        "clean_filename": None,
        "clean_sha256": None,
        "clean_size_bytes": None,
        "clean_duration_seconds": None,
        "reason": decision["reason"],
    }
    if decision["substantial"]:
        clean_path = library_dir / f"{asset_id}.clean.wav"
        fade = _write_trimmed(
            wav_path,
            clean_path,
            decision["silence_start"],
            analysis["rate"],
            analysis["channels"],
        )
        report.update(
            {
                "trimmed": True,
                "fade_applied": fade,
                "fade_seconds": FADE_SECONDS if fade else 0.0,
                "clean_filename": clean_path.name,
                "clean_sha256": sha256_file(clean_path),
                "clean_size_bytes": clean_path.stat().st_size,
                "clean_duration_seconds": wav_duration(clean_path),
                "reason": "trimmed a silent tail into a separate listening copy",
            }
        )
    if sha256_file(wav_path) != before or wav_path.stat().st_size != before_size:
        raise RuntimeError("original wav changed during listening-copy preparation")
    note_path = library_dir / f"{asset_id}.listening.json"
    note_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    report["clean_path"] = str(library_dir / report["clean_filename"]) if report["clean_filename"] else None
    return report


def asset_updates(report: dict) -> dict:
    fields = {
        "listening_checked": 1,
        "listening_note": (report.get("reason") or "")[:240],
        "silence_start_seconds": report.get("silence_start_seconds"),
        "silence_end_seconds": report.get("silence_end_seconds"),
        "fade_applied": 1 if report.get("fade_applied") else 0,
        "clean_wav_path": report.get("clean_path"),
        "clean_sha256": report.get("clean_sha256"),
        "clean_size_bytes": report.get("clean_size_bytes"),
        "clean_duration_seconds": report.get("clean_duration_seconds"),
    }
    return fields


def ensure_mp3(wav_path: Path, mp3_path: Path, ffmpeg: str) -> bool:
    if mp3_path.is_file() and mp3_path.stat().st_size > 0:
        return True
    return transcode_mp3(wav_path, mp3_path, ffmpeg)


def _silence(start, end, substantial: bool, reason: str) -> dict:
    return {
        "silence_start": start,
        "silence_end": end,
        "substantial": substantial,
        "reason": reason,
    }


def _write_trimmed(source: Path, dest: Path, keep_seconds: float, rate: int, channels: int) -> bool:
    dest.parent.mkdir(parents=True, exist_ok=True)
    keep_frames = max(1, int(keep_seconds * rate))
    fade_frames = int(FADE_SECONDS * rate)
    with wave.open(str(source), "rb") as incoming:
        width = incoming.getsampwidth()
        frames = incoming.readframes(keep_frames)
        frame_count = len(frames) // (width * channels)
        samples = list(struct.unpack("<" + "h" * (frame_count * channels), frames[: frame_count * channels * width]))
        fade = False
        if fade_frames > 0 and frame_count > fade_frames:
            tail = samples[-fade_frames * channels :]
            peak = max(abs(value) for value in tail) / 32768.0
            if peak >= FADE_PEAK:
                for frame in range(fade_frames):
                    gain = 1.0 - ((frame + 1) / fade_frames)
                    start = (frame_count - fade_frames + frame) * channels
                    for channel in range(channels):
                        samples[start + channel] = int(samples[start + channel] * gain)
                fade = True
        packed = struct.pack("<" + "h" * len(samples), *samples)
    with wave.open(str(dest), "wb") as outgoing:
        outgoing.setnchannels(channels)
        outgoing.setsampwidth(2)
        outgoing.setframerate(rate)
        outgoing.writeframes(packed)
    return fade
