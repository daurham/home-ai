"""LAN interface for Home AI Music Studio.

The browser never receives the generation API token. State-changing calls are
forwarded to the localhost API after origin, CSRF, size, and rate checks.
"""

from __future__ import annotations

import hmac
import json
import re
import secrets
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

from .schema import ASSET_ID, ValidationError, validate_generation_request

WEB_FILES = {"studio.css": "text/css; charset=utf-8", "studio.js": "text/javascript; charset=utf-8"}
CSRF_COOKIE = "studio_csrf"
CSRF_RE = re.compile(r"^[A-Za-z0-9_-]{24,80}$")
DURATIONS = {10, 15, 20, 30, 45, 60, 90, 120, 180}
MOODS = {"energetic", "dark", "upbeat", "calm", "cinematic", "tense", "hopeful", "playful"}


class Studio:
    def __init__(self, config, db):
        self.config = config
        self.db = db
        self.web = Path(__file__).resolve().parent / "studio_web"
        self._hits: dict[str, list[float]] = {}
        self._lock = threading.Lock()

    def handle(self, request, method: str) -> bool:
        path = request.path.split("?", 1)[0]
        if path in {"/", "/library"} and method == "GET":
            self._page(request)
            return True
        if path.startswith("/assets/") and method == "GET":
            self._static(request, path[len("/assets/"):])
            return True
        if path == "/api" or path.startswith("/api/"):
            self._api(request, method, path)
            return True
        return False

    def _page(self, request) -> None:
        page = (self.web / "index.html").read_bytes()
        token = _csrf_value(request.headers.get("Cookie", "")) or secrets.token_urlsafe(32)
        request.send_response(200)
        request.send_header("Content-Type", "text/html; charset=utf-8")
        request.send_header("Content-Length", str(len(page)))
        request.send_header("Cache-Control", "no-store")
        request.send_header("X-Content-Type-Options", "nosniff")
        request.send_header("Content-Security-Policy", "default-src 'self'")
        request.send_header("Set-Cookie", f"{CSRF_COOKIE}={token}; Path=/; SameSite=Strict; Max-Age=43200")
        request.end_headers()
        request.wfile.write(page)

    def _static(self, request, name: str) -> None:
        if name not in WEB_FILES or "/" in name or ".." in name:
            _json(request, 404, {"ok": False, "error": "not found"})
            return
        path = self.web / name
        if not path.is_file():
            _json(request, 404, {"ok": False, "error": "not found"})
            return
        body = path.read_bytes()
        request.send_response(200)
        request.send_header("Content-Type", WEB_FILES[name])
        request.send_header("Content-Length", str(len(body)))
        request.send_header("Cache-Control", "no-store")
        request.send_header("X-Content-Type-Options", "nosniff")
        request.end_headers()
        request.wfile.write(body)

    def _api(self, request, method: str, path: str) -> None:
        parts = [part for part in path.split("/") if part]
        try:
            if method == "GET" and parts == ["api", "library"]:
                status, payload = self._forward("GET", "/v1/library" + _query(request))
                _json(request, status, payload)
                return
            if method == "GET" and len(parts) == 3 and parts[:2] == ["api", "library"] and ASSET_ID.match(parts[2]):
                status, payload = self._forward("GET", f"/v1/library/{parts[2]}")
                _json(request, status, payload)
                return
            if method == "GET" and parts == ["api", "jobs"]:
                status, payload = self._forward("GET", "/v1/jobs")
                _json(request, status, payload)
                return
            if method != "POST":
                _json(request, 405, {"ok": False, "error": "method not allowed"})
                return
            guard = self._guard(request)
            if guard:
                _json(request, guard[0], guard[1])
                return
            body = _read_json(request, 8192)
            if len(parts) == 4 and parts[:2] == ["api", "library"] and parts[3] == "approval" and ASSET_ID.match(parts[2]):
                if not isinstance(body.get("approved"), bool):
                    _json(request, 400, {"ok": False, "error": "approved must be true or false"})
                    return
                status, payload = self._forward("POST", f"/v1/library/{parts[2]}/approval", {"approved": body["approved"]})
                _json(request, status, payload)
                return
            if len(parts) == 4 and parts[:2] == ["api", "library"] and parts[3] == "favorite" and ASSET_ID.match(parts[2]):
                if not isinstance(body.get("favorite"), bool):
                    _json(request, 400, {"ok": False, "error": "favorite must be true or false"})
                    return
                status, payload = self._forward("POST", f"/v1/library/{parts[2]}/favorite", {"favorite": body["favorite"]})
                _json(request, status, payload)
                return
            if len(parts) == 4 and parts[:2] == ["api", "jobs"] and parts[3] == "cancel" and parts[2].startswith("job_"):
                status, payload = self._forward("POST", f"/v1/jobs/{parts[2]}/cancel", {})
                _json(request, status, payload)
                return
            if parts == ["api", "jobs"]:
                limited = self._rate_limit(request)
                if limited:
                    _json(request, limited[0], limited[1])
                    return
                self._create(request, body)
                return
            _json(request, 404, {"ok": False, "error": "not found"})
        except ValidationError as exc:
            _json(request, 400, {"ok": False, "error": "invalid request", "details": exc.errors})
        except ValueError as exc:
            _json(request, 400, {"ok": False, "error": str(exc)})
        except urllib.error.URLError:
            _json(request, 503, {"ok": False, "error": "The local generation service is not reachable."})

    def _create(self, request, body: dict) -> None:
        payload = _studio_request(body, self.config)
        with self._lock:
            active = [
                job for job in self.db.list_jobs(limit=100)
                if job["state"] in {"queued", "running", "uploading"}
            ]
            for job in active:
                same_reuse = payload["reuse_asset_id"] and job["request"].get("reuse_asset_id") == payload["reuse_asset_id"]
                same_prompt = (
                    not payload["reuse_asset_id"]
                    and job["prompt"] == payload["prompt"]
                    and float(job["duration_seconds"] or 0) == float(payload["duration_seconds"])
                )
                if same_reuse or same_prompt:
                    from .api import public_job
                    _json(request, 409, {
                        "ok": False,
                        "error": "That track is already queued. No second copy was created.",
                        "job": public_job(job, self.db.latest_event(job["id"])),
                    })
                    return
            status, response = self._forward("POST", "/v1/jobs", payload)
        _json(request, status, response)

    def _guard(self, request) -> tuple[int, dict] | None:
        length = int(request.headers.get("Content-Length") or 0)
        if length < 0 or length > 8192:
            return 400, {"ok": False, "error": "request is too large"}
        host = request.headers.get("Host", "")
        origin = request.headers.get("Origin", "")
        if not host or not origin:
            return 403, {"ok": False, "error": "origin check failed"}
        parsed = urlparse(origin)
        if parsed.scheme not in {"http", "https"} or parsed.netloc != host:
            return 403, {"ok": False, "error": "origin check failed"}
        cookie = _csrf_value(request.headers.get("Cookie", ""))
        header = request.headers.get("X-CSRF-Token", "")
        if not cookie or not header or len(cookie) != len(header) or not hmac.compare_digest(cookie, header):
            return 403, {"ok": False, "error": "page token check failed"}
        return None

    def _rate_limit(self, request) -> tuple[int, dict] | None:
        address = request.client_address[0]
        now = time.time()
        with self._lock:
            recent = [stamp for stamp in self._hits.get(address, []) if now - stamp < 600]
            if len(recent) >= 8:
                self._hits[address] = recent
                return 429, {"ok": False, "error": "Too many generation requests. Wait a few minutes."}
            recent.append(now)
            self._hits[address] = recent
        return None

    def _forward(self, method: str, path: str, payload: dict | None = None) -> tuple[int, dict]:
        data = None if payload is None else json.dumps(payload).encode()
        base = getattr(self.config, "api_base", "") or f"http://{self.config.host}:{self.config.port}"
        req = urllib.request.Request(
            base.rstrip("/") + path,
            data=data,
            headers={
                "Authorization": "Bearer " + self.config.api_token,
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            method=method,
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as response:
                return response.status, json.loads(response.read().decode() or "{}")
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode() or "{}"
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError:
                parsed = {"ok": False, "error": "generation service rejected the request"}
            return exc.code, parsed


def _studio_request(body: dict, config) -> dict:
    if not isinstance(body, dict):
        raise ValidationError(["body must be a JSON object"])
    reuse = body.get("reuse_asset_id") or ""
    prompt = body.get("prompt") or ""
    if not isinstance(prompt, str):
        raise ValidationError(["prompt must be a string"])
    extras = []
    bpm = body.get("bpm")
    if bpm not in (None, ""):
        if isinstance(bpm, bool) or not isinstance(bpm, (int, float)) or not 40 <= float(bpm) <= 220:
            raise ValidationError(["bpm must be between 40 and 220"])
        extras.append(f"Target tempo: {int(bpm)} BPM.")
    if body.get("instrumental", True) is not False:
        extras.append("Instrumental only, no vocals.")
    full_prompt = " ".join(part for part in [prompt.strip(), *extras] if part)
    if not reuse and len(prompt.strip()) < 8:
        raise ValidationError(["describe the music in at least a few words"])
    duration = body.get("duration_seconds", 30)
    if not reuse and duration not in DURATIONS and float(duration) not in DURATIONS:
        raise ValidationError(["choose a duration from the list"])
    mood = body.get("mood") or []
    if not isinstance(mood, list) or any(item not in MOODS for item in mood):
        raise ValidationError(["mood contains an unknown value"])
    payload = {
        "request_id": "ui-" + secrets.token_hex(8),
        "type": "music",
        "episode": "music-studio",
        "prompt": full_prompt,
        "duration_seconds": duration,
        "variants": 1,
        "genre": body.get("genre") or "other",
        "mood": mood,
        "tags": ["music-studio"],
        "approval": "" if reuse else "GENERATE_LIBRARY_MUSIC",
        "publishing_authorized": False,
        "save_to_library": True,
    }
    if reuse:
        payload["reuse_asset_id"] = reuse
    return validate_generation_request(payload, config)


def _csrf_value(header: str) -> str:
    for part in header.split(";"):
        name, _, value = part.strip().partition("=")
        if name == CSRF_COOKIE and CSRF_RE.match(value):
            return value
    return ""


def _query(request) -> str:
    if "?" not in request.path:
        return ""
    raw = request.path.split("?", 1)[1]
    allowed = []
    for piece in raw.split("&"):
        if not piece:
            continue
        key = piece.split("=", 1)[0]
        if key in {"q", "genre", "mood", "approved", "favorite", "episode", "type"}:
            allowed.append(piece)
    return ("?" + "&".join(allowed)) if allowed else ""


def _read_json(request, limit: int) -> dict:
    length = int(request.headers.get("Content-Length") or 0)
    if length < 0 or length > limit:
        raise ValueError("request is too large")
    raw = request.rfile.read(length) if length else b""
    if not raw:
        return {}
    data = json.loads(raw.decode("utf-8"))
    if not isinstance(data, dict):
        raise ValueError("JSON object required")
    return data


def _json(request, status: int, payload: dict) -> None:
    body = json.dumps(payload).encode()
    request.send_response(status)
    request.send_header("Content-Type", "application/json")
    request.send_header("Content-Length", str(len(body)))
    request.send_header("Cache-Control", "no-store")
    request.send_header("X-Content-Type-Options", "nosniff")
    request.end_headers()
    request.wfile.write(body)
