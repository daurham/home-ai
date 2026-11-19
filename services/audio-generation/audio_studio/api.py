"""Localhost JSON API. Submission returns as soon as the job is stored."""

from __future__ import annotations

import json
import shutil
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from .db import Database
from .schema import ValidationError, validate_generation_request


def public_job(job: dict, latest_event: str = "") -> dict:
    return {
        "job_id": job["id"],
        "request_id": job["request_id"],
        "type": job["type"],
        "state": job["state"],
        "episode": job["episode"],
        "prompt": job.get("prompt") or "",
        "duration_seconds": job.get("duration_seconds"),
        "genre": job.get("genre") or "",
        "asset_id": job["asset_id"],
        "error": job["error"],
        "attempts": job["attempts"],
        "upload_attempts": job["upload_attempts"],
        "created_at": job["created_at"],
        "updated_at": job["updated_at"],
        "started_at": job["started_at"],
        "finished_at": job["finished_at"],
        "provider_cost_usd": job["provider_cost_usd"],
        "latest_event": latest_event,
        "result": job["result"],
        "seed": job.get("seed"),
        "bpm": (job.get("request") or {}).get("bpm"),
        "key_scale": (job.get("request") or {}).get("key_scale") or "",
        "time_signature": (job.get("request") or {}).get("time_signature") or "",
        "arrangement": (job.get("request") or {}).get("arrangement") or "",
        "inference_steps": (job.get("request") or {}).get("inference_steps") or 8,
        "planner": False,
    }


def public_asset(asset: dict) -> dict:
    hidden = {"wav_path", "mp3_path", "clean_wav_path"}
    data = {key: value for key, value in asset.items() if key not in hidden}
    data["local_wav"] = bool(asset.get("wav_path"))
    data["local_mp3"] = bool(asset.get("mp3_path"))
    data["local_clean"] = bool(asset.get("clean_wav_path"))
    data["favorite"] = bool(asset.get("favorite"))
    data["fade_applied"] = bool(asset.get("fade_applied"))
    return data


class AudioAPI:
    def __init__(self, config, db: Database | None = None):
        self.config = config
        self.db = db or Database(config.db_path)

    def make_server(self) -> ThreadingHTTPServer:
        handler = self._handler_class()
        server = ThreadingHTTPServer((self.config.host, self.config.port), handler)
        return server

    def _handler_class(self):
        api = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_GET(self):
                self._dispatch("GET")

            def do_POST(self):
                self._dispatch("POST")

            def log_message(self, fmt, *args):
                return

            def _dispatch(self, method: str):
                try:
                    parsed = urlparse(self.path)
                    status, payload = api.handle(method, parsed.path, parse_qs(parsed.query), self)
                    body = json.dumps(payload).encode()
                    self.send_response(status)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    self.wfile.write(body)
                except Exception as exc:
                    body = json.dumps({"ok": False, "error": "internal error"}).encode()
                    self.send_response(500)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    api_log = api.config.log_dir / "api-error.log"
                    with api_log.open("a", encoding="utf-8") as handle:
                        handle.write(f"{type(exc).__name__}: {exc}\n")

        return Handler

    def handle(self, method: str, path: str, query: dict, request) -> tuple[int, dict]:
        if method == "GET" and path in {"/health", "/v1/health"}:
            free = shutil.disk_usage(self.config.home).free
            return 200, {
                "ok": True,
                "status": "ok",
                "backend": self.config.backend,
                "drive_enabled": self.config.drive_enabled,
                "drive_configured": self.config.drive_configured,
                "queued": self.db.active_count(),
                "free_bytes": free,
                "bind": self.config.host,
            }
        if not self._authorized(request):
            return 401, {"ok": False, "error": "authentication required"}
        parts = [part for part in path.split("/") if part]
        if method == "POST" and parts == ["v1", "jobs"]:
            return self._create_job(request)
        if method == "GET" and parts == ["v1", "jobs"]:
            state = (query.get("state") or [None])[0]
            if state and state not in {
                "queued", "running", "uploading", "local_ready", "completed", "failed", "cancelled"
            }:
                return 400, {"ok": False, "error": "unknown state"}
            jobs = self.db.list_jobs(state)
            return 200, {
                "ok": True,
                "jobs": [public_job(job, self.db.latest_event(job["id"])) for job in jobs],
            }
        if method == "GET" and len(parts) == 3 and parts[:2] == ["v1", "jobs"]:
            job = self.db.job(parts[2])
            if not job:
                return 404, {"ok": False, "error": "job not found"}
            return 200, {"ok": True, "job": public_job(job, self.db.latest_event(job["id"]))}
        if method == "POST" and len(parts) == 4 and parts[:2] == ["v1", "jobs"] and parts[3] == "cancel":
            current = self.db.job(parts[2])
            if not current:
                return 404, {"ok": False, "error": "job not found"}
            if current["state"] in {"completed", "local_ready", "failed", "cancelled"}:
                return 409, {"ok": False, "error": "job already finished", "job": public_job(current)}
            job = self.db.request_cancel(parts[2])
            return 200, {"ok": True, "job": public_job(job, self.db.latest_event(job["id"]))}
        if method == "GET" and parts == ["v1", "library"]:
            def one(name: str):
                values = query.get(name) or []
                return values[0] if values else ""
            def maybe_float(name: str):
                raw = one(name)
                return float(raw) if raw else None
            assets = self.db.search_assets(
                query=one("q"),
                genre=one("genre"),
                mood=one("mood"),
                episode=one("episode"),
                kind=one("type"),
                approved_only=one("approved") in {"1", "true", "yes"},
                favorite_only=one("favorite") in {"1", "true", "yes"},
                min_duration=maybe_float("min_duration"),
                max_duration=maybe_float("max_duration"),
            )
            return 200, {"ok": True, "assets": [public_asset(asset) for asset in assets]}
        if method == "GET" and len(parts) == 3 and parts[:2] == ["v1", "library"]:
            asset = self.db.asset(parts[2])
            if not asset:
                return 404, {"ok": False, "error": "asset not found"}
            return 200, {"ok": True, "asset": public_asset(asset)}
        if method == "POST" and len(parts) == 4 and parts[:2] == ["v1", "library"] and parts[3] == "approval":
            body = self._body(request)
            asset = self.db.set_approval(parts[2], bool(body.get("approved")))
            if not asset:
                return 404, {"ok": False, "error": "asset not found"}
            return 200, {"ok": True, "asset": public_asset(asset)}
        if method == "POST" and len(parts) == 4 and parts[:2] == ["v1", "library"] and parts[3] == "favorite":
            body = self._body(request)
            if not isinstance(body.get("favorite"), bool):
                return 400, {"ok": False, "error": "favorite must be true or false"}
            asset = self.db.set_favorite(parts[2], body["favorite"])
            if not asset:
                return 404, {"ok": False, "error": "asset not found"}
            return 200, {"ok": True, "asset": public_asset(asset)}
        return 404, {"ok": False, "error": "not found"}

    def _authorized(self, request) -> bool:
        if not self.config.api_token:
            return False
        header = request.headers.get("Authorization", "")
        api_key = request.headers.get("X-API-Key", "")
        token = ""
        if header.lower().startswith("bearer "):
            token = header[7:].strip()
        elif api_key:
            token = api_key.strip()
        if len(token) != len(self.config.api_token):
            return False
        import hmac
        return hmac.compare_digest(token, self.config.api_token)

    def _body(self, request) -> dict:
        length = int(request.headers.get("Content-Length") or 0)
        if length < 0 or length > self.config.max_body_bytes:
            raise ValueError("body too large")
        raw = request.rfile.read(length) if length else b""
        if not raw:
            return {}
        data = json.loads(raw.decode("utf-8"))
        if not isinstance(data, dict):
            raise ValueError("JSON object required")
        return data

    def _create_job(self, request) -> tuple[int, dict]:
        try:
            body = self._body(request)
            request_data = validate_generation_request(body, self.config)
        except ValidationError as exc:
            return 400, {"ok": False, "error": "invalid request", "details": exc.errors}
        except (ValueError, json.JSONDecodeError):
            return 400, {"ok": False, "error": "invalid JSON body"}
        free = shutil.disk_usage(self.config.home).free
        if free < self.config.min_free_bytes:
            return 503, {"ok": False, "error": "not enough free disk"}
        if self.db.active_count() >= self.config.max_queue:
            return 429, {"ok": False, "error": "queue is full"}
        if not self.db.allow_submit(
            self.config.rate_limit_count, self.config.rate_limit_window_seconds
        ):
            return 429, {"ok": False, "error": "rate limit exceeded"}
        if request_data["reuse_asset_id"]:
            asset = self.db.asset(request_data["reuse_asset_id"])
            if not asset:
                return 404, {"ok": False, "error": "asset not found"}
            if asset["approval_status"] != "approved":
                return 409, {"ok": False, "error": "asset is not approved for reuse"}
        existing = self.db.job_by_request(request_data["request_id"])
        job = self.db.insert_job(request_data)
        created = existing is None
        if request_data["reuse_asset_id"] and created:
            asset = self.db.asset(request_data["reuse_asset_id"])
            drive_verified = bool(asset.get("drive_file_id"))
            reuse_state = "completed" if drive_verified else "local_ready"
            manifest = {
                "job_id": job["id"],
                "request_id": job["request_id"],
                "state": reuse_state,
                "reused": True,
                "publishing_authorized": False,
                "production_deliverable": False,
                "experimental": True,
                "asset_id": asset["id"],
                "episode": job["episode"],
                "duration_seconds": asset.get("duration_seconds"),
                "sha256": asset.get("sha256"),
                "size_bytes": asset.get("size_bytes"),
                "approval_status": asset.get("approval_status"),
                "drive": {
                    "status": "verified" if drive_verified else "disabled",
                    "verified": drive_verified,
                    "file_id": asset.get("drive_file_id") if drive_verified else None,
                    "url": asset.get("drive_url") if drive_verified else None,
                },
                "metrics": {
                    "generation_seconds": 0,
                    "provider_cost_usd": 0,
                    "provider_cost_basis": "included",
                    "electricity_cost_usd": None,
                },
            }
            self.db.mark(
                job["id"],
                state=reuse_state,
                asset_id=request_data["reuse_asset_id"],
                result={
                    "reused": True,
                    "asset_id": request_data["reuse_asset_id"],
                    "provider_cost_usd": 0,
                    "generation_seconds": 0,
                    "manifest": manifest,
                },
                finished_at=job["finished_at"],
            )
            job = self.db.job(job["id"])
        return (202 if created and job["state"] == "queued" else 200), {
            "ok": True,
            "job": public_job(job, self.db.latest_event(job["id"])),
        }
