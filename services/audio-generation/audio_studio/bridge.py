"""Turn inbox JSON files into local jobs and compact result manifests."""

from __future__ import annotations

import json
import shutil
import subprocess
import urllib.request
from pathlib import Path

from .schema import REQUEST_ID


class BridgeError(RuntimeError):
    pass


def _request(config, method: str, path: str, payload: dict | None = None) -> dict:
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(
        f"http://{config.host}:{config.port}{path}",
        data=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {config.api_token}",
        },
        method=method,
    )
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.loads(response.read().decode())


TERMINAL = {"completed", "local_ready", "failed", "cancelled"}


def sync_inbox(config, inbox: Path, results: Path, accepted: Path, log_root: Path | None = None) -> list[str]:
    inbox.mkdir(parents=True, exist_ok=True)
    results.mkdir(parents=True, exist_ok=True)
    accepted.mkdir(parents=True, exist_ok=True)
    notes = []
    for path in sorted(inbox.glob("*.json")):
        if path.name.startswith("."):
            continue
        body = json.loads(path.read_text(encoding="utf-8"))
        request_id = str(body.get("request_id") or body.get("id") or "")
        if not REQUEST_ID.match(request_id):
            raise BridgeError(f"{path.name} has an unsafe request id")
        response = _request(config, "POST", "/v1/jobs", body)
        job = response["job"]
        _write_result(results / f"{request_id}.json", job)
        destination = accepted / path.name
        shutil.move(str(path), destination)
        if job["state"] in TERMINAL:
            if (job.get("result") or {}).get("reused"):
                _log(config, "done", request_id, job, "Reused an existing library asset. No new audio was generated.", log_root)
            notes.append(request_id + " already finished")
            continue
        _log(config, "start", request_id, job, "Audio request accepted", log_root)
        notes.append(request_id)
    for result_path in sorted(results.glob("*.json")):
        current = json.loads(result_path.read_text(encoding="utf-8"))
        if current.get("state") in TERMINAL:
            continue
        job_id = current.get("job_id")
        if not job_id:
            continue
        response = _request(config, "GET", f"/v1/jobs/{job_id}")
        job = response["job"]
        if job["state"] == current.get("state") and job["state"] not in TERMINAL:
            continue
        _write_result(result_path, job)
        if job["state"] in {"completed", "local_ready"}:
            reused = bool((job.get("result") or {}).get("reused"))
            if reused:
                _log(config, "done", job["request_id"], job, "Reused an existing library asset. No new audio was generated.", log_root)
            else:
                _log(config, "usage", job["request_id"], job, "Local music generation finished", log_root)
                if job["state"] == "local_ready":
                    _log(config, "done", job["request_id"], job, "Local WAV verified. Drive upload is disabled. Experimental asset only.", log_root)
                else:
                    _log(config, "done", job["request_id"], job, "Drive upload verified. Publishing is not authorized.", log_root)
        elif job["state"] == "failed":
            _log(config, "error", job["request_id"], job, "Audio generation failed", log_root)
        elif job["state"] == "uploading":
            _log(config, "blocked", job["request_id"], job, "Audio is waiting for an enabled Google Drive upload", log_root)
        notes.append("updated " + result_path.name)
    return notes


def _write_result(path: Path, job: dict) -> None:
    manifest = (job.get("result") or {}).get("manifest") if job.get("result") else None
    payload = manifest or {
        "job_id": job["job_id"],
        "request_id": job["request_id"],
        "state": job["state"],
        "asset_id": job.get("asset_id"),
        "error": job.get("error"),
        "publishing_authorized": False,
        "production_deliverable": False,
        "provider_cost_usd": 0,
        "drive": {"status": "pending" if job["state"] == "uploading" else "not_uploaded", "verified": False},
    }
    path.write_text(json.dumps(_scrub(payload), indent=2) + "\n", encoding="utf-8")


def _scrub(value):
    hidden = {"wav_path", "mp3_path", "clean_wav_path", "local_path"}
    if isinstance(value, dict):
        return {key: _scrub(item) for key, item in value.items() if key not in hidden}
    if isinstance(value, list):
        return [_scrub(item) for item in value]
    if isinstance(value, str) and (
        value.startswith("/home/") or value.startswith("Bearer ") or "ghp_" in value or "github_pat_" in value
    ):
        return "[redacted]"
    return value


def _log(config, kind: str, request_id: str, job: dict, message: str, root: Path | None = None) -> None:
    studio = Path(root) if root else config.studio_root
    script = studio / "scripts" / "studio-log.mjs"
    if not script.is_file():
        return
    run = ("audio-" + request_id)[:96]
    episode = job.get("episode") or ""
    command = [
        "node", str(script), kind,
        "--run", run,
        "--task", "library audio",
        "--actor", "beelink-audio",
        "--message", message[:180],
    ]
    if episode:
        command.extend(["--episode", episode])
    if kind == "usage":
        seconds = ((job.get("result") or {}).get("manifest") or {}).get("duration_seconds")
        command.extend([
            "--service", "local-ace-step",
            "--model", "acestep-v15-turbo",
            "--usd", "0",
            "--basis", "included",
        ])
        if seconds:
            command.extend(["--audio-seconds", str(seconds)])
    if kind == "error":
        command.extend(["--code", "generation_failed"])
    subprocess.run(command, cwd=str(studio), check=False, capture_output=True, text=True)


def git_commit_results(config, paths: list[str]) -> str | None:
    """Commit only allowlisted result paths. Never stages the rest of the tree."""
    if not config.github_push:
        return None
    root = config.studio_root
    allowed_prefixes = ("audio-requests/", "audio-results/", "ops/activity/")
    safe = []
    for rel in paths:
        if not rel.startswith(allowed_prefixes) or ".." in rel.split("/"):
            raise BridgeError(f"refusing to commit {rel}")
        safe.append(rel)
    if not safe:
        return None
    subprocess.run(["git", "add", "--", *safe], cwd=root, check=True)
    staged = subprocess.run(
        ["git", "diff", "--cached", "--name-only"], cwd=root, check=True, capture_output=True, text=True
    ).stdout.split()
    if any(not item.startswith(allowed_prefixes) for item in staged):
        subprocess.run(["git", "reset"], cwd=root, check=True)
        raise BridgeError("staged files escaped the audio allowlist; reset")
    if not staged:
        return None
    subprocess.run(
        ["git", "commit", "-m", "Record audio job results\n\nAutomated library manifest and activity log. No media bytes."],
        cwd=root, check=True,
    )
    if config.github_branch:
        subprocess.run(["git", "push", "origin", f"HEAD:{config.github_branch}"], cwd=root, check=True)
    return "pushed"
