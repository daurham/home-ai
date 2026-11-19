"""Generation backends. ACE-Step stays on localhost and is swappable."""

from __future__ import annotations

import json
import os
import signal
import subprocess
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

from .media import write_tone


@dataclass
class GenerationResult:
    wav_path: str
    duration_seconds: float
    seed: str | None
    model: str
    generator: str
    init_seconds: float | None
    generation_seconds: float
    peak_rss_bytes: int | None
    cpu_seconds: float | None
    license_note: str


class BackendError(RuntimeError):
    pass


class Cancelled(BackendError):
    pass


class DisabledBackend:
    name = "disabled"

    def __init__(self, reason: str):
        self.reason = reason

    def generate(self, job: dict, workdir: Path, cancelled) -> GenerationResult:
        raise BackendError(self.reason)


class FakeBackend:
    name = "fake"

    def __init__(self, sleep_seconds: float = 0.0):
        self.sleep_seconds = sleep_seconds

    def generate(self, job: dict, workdir: Path, cancelled) -> GenerationResult:
        started = time.monotonic()
        if self.sleep_seconds:
            time.sleep(self.sleep_seconds)
        if cancelled():
            raise Cancelled("cancelled before fake render")
        target = workdir / "audio.wav"
        write_tone(target, seconds=1.0)
        return GenerationResult(
            wav_path=str(target),
            duration_seconds=1.0,
            seed=str(job.get("seed") if job.get("seed") is not None else 1),
            model="fake-1",
            generator="fake",
            init_seconds=0.0,
            generation_seconds=time.monotonic() - started,
            peak_rss_bytes=0,
            cpu_seconds=0.0,
            license_note="Synthetic test tone. Not for publication.",
        )


class AceStepBackend:
    """Talks only to the official localhost ACE-Step API."""

    name = "acestep"
    LICENSE = (
        "Generated locally with ACE-Step 1.5 (code MIT; Hugging Face model card "
        "license: mit; card states generated music may be used commercially). "
        "Text encoder Qwen3-Embedding-0.6B is a separate component. "
        "Not a substitute for a lawyer's rights review. publishing_authorized=false."
    )

    def __init__(self, config):
        self.config = config

    def generate(self, job: dict, workdir: Path, cancelled) -> GenerationResult:
        if not self.config.acestep_python.is_file():
            raise BackendError(
                f"ACE-Step Python is not installed at {self.config.acestep_python}"
            )
        log_path = workdir / "acestep.log"
        proc = self._start(log_path)
        init_started = time.monotonic()
        peak = 0
        try:
            self._wait_until_ready(proc, cancelled, log_path)
            init_seconds = time.monotonic() - init_started
            task_id = self._release(job)
            gen_started = time.monotonic()
            info = self._poll(proc, task_id, cancelled, peak_holder := [peak], log_path)
            peak = peak_holder[0]
            wav = self._download(info["file"], workdir / "audio.wav")
            return GenerationResult(
                wav_path=str(wav),
                duration_seconds=float((info.get("metas") or {}).get("duration") or job["duration_seconds"]),
                seed=str(info.get("seed_value") or job.get("seed") or ""),
                model=str(info.get("dit_model") or self.config.model_name),
                generator="ACE-Step 1.5",
                init_seconds=init_seconds,
                generation_seconds=time.monotonic() - gen_started,
                peak_rss_bytes=peak,
                cpu_seconds=None,
                license_note=self.LICENSE,
            )
        finally:
            self._stop(proc)

    def _start(self, log_path: Path) -> subprocess.Popen:
        env = os.environ.copy()
        env.update(
            {
                "ACESTEP_INIT_LLM": "false",
                "ACESTEP_NO_INIT": "false",
                "ACESTEP_DEVICE": "cpu",
                "ACESTEP_USE_FLASH_ATTENTION": "false",
                "ACESTEP_COMPILE_MODEL": "false",
                "ACESTEP_CONFIG_PATH": self.config.model_name,
                "ACESTEP_DOWNLOAD_SOURCE": "huggingface",
                "ACESTEP_API_HOST": self.config.acestep_host,
                "ACESTEP_API_PORT": str(self.config.acestep_port),
                "ACESTEP_API_KEY": self.config.acestep_api_key,
                "OMP_NUM_THREADS": "12",
                "MKL_NUM_THREADS": "12",
                "TOKENIZERS_PARALLELISM": "false",
            }
        )
        log_handle = log_path.open("w", encoding="utf-8")
        return subprocess.Popen(
            [
                str(self.config.acestep_python),
                "-m",
                "acestep.api_server",
                "--host",
                "127.0.0.1",
                "--port",
                str(self.config.acestep_port),
            ],
            cwd=str(self.config.acestep_root),
            env=env,
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            text=True,
            start_new_session=True,
        )

    def _request(self, method: str, path: str, payload: dict | None = None, timeout: int = 60):
        data = None if payload is None else json.dumps(payload).encode()
        headers = {"Content-Type": "application/json"}
        if self.config.acestep_api_key:
            headers["Authorization"] = f"Bearer {self.config.acestep_api_key}"
        req = urllib.request.Request(
            f"http://{self.config.acestep_host}:{self.config.acestep_port}{path}",
            data=data,
            headers=headers,
            method=method,
        )
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return json.loads(response.read().decode())

    def _wait_until_ready(self, proc: subprocess.Popen, cancelled, log_path: Path) -> None:
        deadline = time.monotonic() + self.config.init_timeout_seconds
        while time.monotonic() < deadline:
            if cancelled():
                raise Cancelled("cancelled during model load")
            if proc.poll() is not None:
                raise BackendError(f"ACE-Step exited during startup: {_tail(log_path)}")
            try:
                body = self._request("GET", "/health", timeout=5)
                data = body.get("data") or {}
                if data.get("models_initialized") and not data.get("llm_initialized"):
                    return
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
                pass
            time.sleep(2)
        raise BackendError("ACE-Step did not finish loading the DiT model before the timeout")

    def _release(self, job: dict) -> str:
        payload = release_payload(job, self.config)
        body = self._request("POST", "/release_task", payload, timeout=120)
        if body.get("code") not in (None, 200):
            raise BackendError(body.get("error") or "ACE-Step rejected the task")
        task_id = (body.get("data") or {}).get("task_id")
        if not task_id:
            raise BackendError("ACE-Step did not return a task_id")
        return task_id

    def _poll(self, proc, task_id: str, cancelled, peak_holder: list[int], log_path: Path) -> dict:
        deadline = time.monotonic() + self.config.generation_timeout_seconds
        while time.monotonic() < deadline:
            if cancelled():
                raise Cancelled("cancelled during generation")
            if proc.poll() is not None:
                raise BackendError(f"ACE-Step exited during generation: {_tail(log_path)}")
            peak_holder[0] = max(peak_holder[0], _tree_rss(proc.pid))
            body = self._request(
                "POST", "/query_result", {"task_id_list": [task_id]}, timeout=60
            )
            rows = body.get("data") or []
            if rows:
                status = rows[0].get("status")
                if status == 1:
                    result = rows[0].get("result")
                    parsed = json.loads(result) if isinstance(result, str) else result
                    if isinstance(parsed, list):
                        parsed = parsed[0]
                    if not parsed or not parsed.get("file"):
                        raise BackendError("ACE-Step succeeded without an audio file")
                    return parsed
                if status == 2:
                    raise BackendError(str(rows[0].get("result") or "ACE-Step generation failed")[:500])
            time.sleep(3)
        raise BackendError("generation timed out")

    def _download(self, file_ref: str, dest: Path) -> Path:
        if not file_ref.startswith("/v1/audio"):
            raise BackendError("ACE-Step returned an unexpected audio reference")
        url = f"http://{self.config.acestep_host}:{self.config.acestep_port}{file_ref}"
        headers = {}
        if self.config.acestep_api_key:
            headers["Authorization"] = f"Bearer {self.config.acestep_api_key}"
        req = urllib.request.Request(url, headers=headers)
        dest.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(req, timeout=120) as response, dest.open("wb") as handle:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                handle.write(chunk)
        if dest.stat().st_size < 44:
            raise BackendError("downloaded audio is empty")
        return dest

    def _stop(self, proc: subprocess.Popen) -> None:
        if proc.poll() is not None:
            return
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        try:
            proc.wait(timeout=20)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait(timeout=10)


def release_payload(job: dict, config) -> dict:
    """Build the ACE-Step request. Planning stays off; Turbo stays at its step count."""

    request = job.get("request") or {}
    payload = {
        "prompt": job["prompt"],
        "lyrics": request.get("lyrics") or "[Instrumental]",
        "thinking": False,
        "use_cot_caption": False,
        "use_cot_language": False,
        "use_format": False,
        "audio_duration": job["duration_seconds"],
        "audio_format": "wav",
        "inference_steps": config.inference_steps,
        "batch_size": 1,
        "use_random_seed": job.get("seed") is None,
        "seed": job.get("seed") if job.get("seed") is not None else -1,
        "task_type": "text2music",
        "model": config.model_name,
        "vocal_language": request.get("vocal_language") or "unknown",
    }
    if request.get("bpm"):
        payload["bpm"] = int(request["bpm"])
    if request.get("key_scale"):
        payload["key_scale"] = request["key_scale"]
    if request.get("time_signature"):
        payload["time_signature"] = request["time_signature"]
    return payload


def _tail(log_path: Path) -> str:
    try:
        text = log_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    return text[-1000:]


def _tree_rss(pid: int) -> int:
    total = 0
    pending = [pid]
    seen = set()
    while pending:
        current = pending.pop()
        if current in seen:
            continue
        seen.add(current)
        status = Path(f"/proc/{current}/status")
        if not status.is_file():
            continue
        for line in status.read_text(encoding="utf-8", errors="replace").splitlines():
            if line.startswith("VmRSS:"):
                parts = line.split()
                total += int(parts[1]) * 1024
        children = Path(f"/proc/{current}/task/{current}/children")
        if children.is_file():
            text = children.read_text(encoding="utf-8").strip()
            pending.extend(int(item) for item in text.split() if item.isdigit())
    return total
