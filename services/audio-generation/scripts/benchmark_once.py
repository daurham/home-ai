"""Run one real ACE-Step CPU generation and record resource samples."""

from __future__ import annotations

import json
import os
import struct
import time
import urllib.request
import wave
from pathlib import Path

from audio_studio.backends import AceStepBackend


def sample(label: str) -> dict:
    mem = Path("/proc/meminfo").read_text().splitlines()
    info = {}
    for line in mem:
        if line.startswith(("MemAvailable:", "MemFree:", "SwapFree:")):
            info[line.split(":")[0]] = int(line.split()[1]) * 1024
    probes = {}
    for name, url in {
        "ollama": "http://127.0.0.1:11434/api/tags",
        "node_api": "http://127.0.0.1:3000/api/health",
        "dashboard": "http://127.0.0.1:8080/",
    }.items():
        started = time.monotonic()
        try:
            with urllib.request.urlopen(url, timeout=5) as response:
                probes[name] = {"status": response.status, "seconds": round(time.monotonic() - started, 3)}
        except Exception as exc:
            probes[name] = {"error": type(exc).__name__, "seconds": round(time.monotonic() - started, 3)}
    return {
        "label": label,
        "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "loadavg": Path("/proc/loadavg").read_text().strip(),
        "memory": info,
        "probes": probes,
    }


def rms(path: Path) -> float:
    with wave.open(str(path), "rb") as handle:
        channels = handle.getnchannels()
        width = handle.getsampwidth()
        frames = handle.readframes(handle.getnframes())
        duration = handle.getnframes() / float(handle.getframerate())
    if width != 2:
        return -1, duration
    count = len(frames) // 2
    values = struct.unpack("<" + "h" * count, frames[: count * 2])
    if channels > 1:
        values = values[::channels]
    if not values:
        return 0.0, duration
    total = sum(v * v for v in values) / len(values)
    return total ** 0.5, duration


def main() -> None:
    seconds = float(os.environ.get("BENCH_SECONDS", "12"))
    name = os.environ.get("BENCH_NAME", f"{int(seconds)}s")
    root = Path(os.environ.get("AUDIO_HOME", str(Path.home() / "audio-service"))).expanduser() / "data" / "benchmarks"
    root.mkdir(parents=True, exist_ok=True)
    work = root / f"run-{name}"
    work.mkdir(parents=True, exist_ok=True)
    audio_home = Path(os.environ.get("AUDIO_HOME", str(Path.home() / "audio-service"))).expanduser()
    python = Path(os.environ.get("ACESTEP_PYTHON", str(audio_home / "vendor" / "ACE-Step-1.5" / ".venv" / "bin" / "python")))
    config = type("Cfg", (), {})()
    config.acestep_python = python
    config.acestep_root = Path(os.environ.get("ACESTEP_ROOT", str(audio_home / "vendor" / "ACE-Step-1.5")))
    config.acestep_host = "127.0.0.1"
    config.acestep_port = 8001
    config.acestep_api_key = os.environ.get("ACESTEP_API_KEY", "bench-local")
    config.model_name = "acestep-v15-turbo"
    config.inference_steps = 8
    config.generation_timeout_seconds = 7200
    config.init_timeout_seconds = 1800
    backend = AceStepBackend(config)
    before = sample("before")
    samples = [before]
    stop = {"stop": False}

    def sampler():
        while not stop["stop"]:
            time.sleep(10)
            if stop["stop"]:
                return
            try:
                samples.append(sample("during"))
            except Exception as exc:
                samples.append({"label": "during", "error": type(exc).__name__})

    import threading
    thread = threading.Thread(target=sampler, daemon=True)
    thread.start()
    disk_before = os.statvfs(audio_home)
    job = {
        "id": "bench12",
        "prompt": (
            "Atmospheric 1980s Miami synthwave, analog bass, shimmering synthesizers, "
            "restrained percussion, cinematic suspense, instrumental only, no vocals."
        ),
        "duration_seconds": seconds,
        "seed": 12345,
    }
    started = time.monotonic()
    try:
        result = backend.generate(job, work, lambda: False)
        level, duration = rms(Path(result.wav_path))
        outcome = {
            "ok": True,
            "init_seconds": result.init_seconds,
            "generation_seconds": result.generation_seconds,
            "wall_seconds": time.monotonic() - started,
            "reported_duration": result.duration_seconds,
            "wav_duration": duration,
            "wav_bytes": Path(result.wav_path).stat().st_size,
            "rms": level,
            "seed": result.seed,
            "model": result.model,
            "peak_rss_bytes": result.peak_rss_bytes,
        }
    except Exception as exc:
        outcome = {
            "ok": False,
            "error": f"{type(exc).__name__}: {exc}",
            "wall_seconds": time.monotonic() - started,
        }
    stop["stop"] = True
    samples.append(sample("after"))
    disk_after = os.statvfs(audio_home)
    report = {
        "prompt": job["prompt"],
        "samples": samples,
        "disk_free_before": disk_before.f_bavail * disk_before.f_frsize,
        "disk_free_after": disk_after.f_bavail * disk_after.f_frsize,
        "outcome": outcome,
    }
    path = root / f"benchmark-{name}.json"
    path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(outcome, indent=2))
    print("WROTE", path)


if __name__ == "__main__":
    main()
