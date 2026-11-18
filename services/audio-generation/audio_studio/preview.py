"""Read-only listening page. It cannot submit jobs or read arbitrary files."""

from __future__ import annotations

import hashlib
import hmac
import html
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs

from .db import Database
from .schema import ASSET_ID

COOKIE = "audio_preview"
MAX_AGE = 12 * 60 * 60


def _signature(token: str, expiry: str) -> str:
    return hmac.new(token.encode(), expiry.encode(), hashlib.sha256).hexdigest()


def _cookie(token: str) -> str:
    expiry = str(int(time.time()) + MAX_AGE)
    return f"{COOKIE}={expiry}.{_signature(token, expiry)}; HttpOnly; SameSite=Strict; Path=/; Max-Age={MAX_AGE}"


def _valid_cookie(token: str, header: str) -> bool:
    if not token or not header:
        return False
    for part in header.split(";"):
        name, _, value = part.strip().partition("=")
        if name != COOKIE or "." not in value:
            continue
        expiry, signature = value.split(".", 1)
        if not expiry.isdigit() or int(expiry) < int(time.time()):
            return False
        expected = _signature(token, expiry)
        if len(signature) != len(expected):
            return False
        return hmac.compare_digest(signature, expected)
    return False


class PreviewServer:
    def __init__(self, config, db: Database | None = None):
        self.config = config
        self.db = db or Database(config.db_path)
        self.failures: dict[str, int] = {}

    def make_server(self) -> ThreadingHTTPServer:
        if not self.config.preview_token:
            raise SystemExit("AUDIO_PREVIEW_TOKEN is required")
        preview = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_GET(self):
                preview._handle(self, "GET")

            def do_HEAD(self):
                preview._handle(self, "HEAD")

            def do_POST(self):
                preview._handle(self, "POST")

            def log_message(self, fmt, *args):
                return

        return ThreadingHTTPServer((self.config.preview_bind, self.config.preview_port), Handler)

    def _handle(self, request, method: str) -> None:
        path = request.path.split("?", 1)[0]
        if method == "POST" and path == "/login":
            self._login(request)
            return
        if path == "/login" and method == "GET":
            self._html(request, 200, self._login_page(""))
            return
        if not _valid_cookie(self.config.preview_token, request.headers.get("Cookie", "")):
            self._redirect(request, "/login")
            return
        if path in {"/", "/library"} and method == "GET":
            self._html(request, 200, self._library_page())
            return
        if path.startswith("/audio/") and method in {"GET", "HEAD"}:
            asset_id = path[len("/audio/"):]
            self._audio(request, method, asset_id)
            return
        self._html(request, 404, "<p>Not found.</p>")

    def _login(self, request) -> None:
        address = request.client_address[0]
        if self.failures.get(address, 0) >= 8:
            self._html(request, 429, "<p>Too many sign-in attempts. Wait and try again.</p>")
            return
        length = int(request.headers.get("Content-Length") or 0)
        if length < 0 or length > 4096:
            self._html(request, 400, "<p>Sign-in request was rejected.</p>")
            return
        raw = request.rfile.read(length).decode("utf-8", "replace") if length else ""
        password = (parse_qs(raw).get("password") or [""])[0]
        expected = self.config.preview_token
        valid = len(password) == len(expected) and hmac.compare_digest(password, expected)
        if not valid:
            self.failures[address] = self.failures.get(address, 0) + 1
            self._html(request, 401, self._login_page("That password was not accepted."))
            return
        self.failures[address] = 0
        body = b""
        request.send_response(303)
        request.send_header("Location", "/")
        request.send_header("Set-Cookie", _cookie(expected))
        request.send_header("Content-Length", "0")
        request.send_header("Cache-Control", "no-store")
        request.end_headers()
        request.wfile.write(body)

    def _library_page(self) -> str:
        rows = []
        for asset in self.db.search_assets(limit=50):
            if not ASSET_ID.match(asset["id"]):
                continue
            title = html.escape(asset["id"])
            prompt = html.escape((asset.get("prompt") or "")[:180])
            genre = html.escape(asset.get("genre") or "")
            episode = html.escape(asset.get("episode") or "")
            duration = asset.get("duration_seconds") or 0
            rows.append(
                "<article>"
                f"<h2>{title}</h2>"
                f"<p>{genre} · {episode} · {duration:.1f}s · {html.escape(asset.get('approval_status') or '')}</p>"
                f"<p>{prompt}</p>"
                f"<audio controls preload=\"none\" src=\"/audio/{title}\"></audio>"
                "</article>"
            )
        body = "\n".join(rows) or "<p>No tracks yet.</p>"
        return (
            "<!doctype html><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
            "<title>Audio library</title>"
            "<style>body{font-family:sans-serif;margin:1.5rem;max-width:40rem}article{margin:0 0 1.5rem}</style>"
            "<h1>Experimental audio library</h1>"
            "<p>These tracks are local listening copies. They are not approved production deliverables.</p>"
            f"{body}"
        )

    def _login_page(self, message: str) -> str:
        note = f"<p>{html.escape(message)}</p>" if message else ""
        return (
            "<!doctype html><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
            "<title>Audio preview</title>"
            "<style>body{font-family:sans-serif;margin:1.5rem;max-width:28rem}</style>"
            "<h1>Audio preview</h1>"
            "<p>Home network only. This page plays library tracks and cannot start a new generation.</p>"
            f"{note}"
            "<form method=\"post\" action=\"/login\">"
            "<label>Password <input name=\"password\" type=\"password\" autocomplete=\"current-password\"></label>"
            "<button type=\"submit\">Listen</button></form>"
        )

    def _audio(self, request, method: str, asset_id: str) -> None:
        if not ASSET_ID.match(asset_id):
            self._html(request, 404, "<p>Not found.</p>")
            return
        asset = self.db.asset(asset_id)
        if not asset or not asset.get("wav_path"):
            self._html(request, 404, "<p>Not found.</p>")
            return
        path = Path(asset["wav_path"]).resolve()
        library = self.config.library_dir.resolve()
        if path.parent != library or path.name != f"{asset_id}.wav" or not path.is_file():
            self._html(request, 404, "<p>Not found.</p>")
            return
        self._send_wav(request, method, path)

    def _send_wav(self, request, method: str, path: Path) -> None:
        size = path.stat().st_size
        start, end = 0, size - 1
        status = 200
        requested = request.headers.get("Range", "")
        if requested.startswith("bytes="):
            spec = requested.split("=", 1)[1].split(",", 1)[0].strip()
            try:
                left, right = spec.split("-", 1)
                if left == "":
                    start = max(0, size - int(right))
                else:
                    start = int(left)
                    end = int(right) if right else size - 1
            except ValueError:
                start, end = 0, -1
            if start < 0 or start >= size or end < start:
                request.send_response(416)
                request.send_header("Content-Range", f"bytes */{size}")
                request.send_header("Content-Length", "0")
                request.end_headers()
                return
            end = min(end, size - 1)
            status = 206
        length = end - start + 1
        request.send_response(status)
        request.send_header("Content-Type", "audio/wav")
        request.send_header("Accept-Ranges", "bytes")
        request.send_header("Content-Length", str(length))
        request.send_header("Cache-Control", "private, no-store")
        if status == 206:
            request.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        request.end_headers()
        if method == "HEAD":
            return
        with path.open("rb") as handle:
            handle.seek(start)
            remaining = length
            while remaining:
                chunk = handle.read(min(65536, remaining))
                if not chunk:
                    break
                request.wfile.write(chunk)
                remaining -= len(chunk)

    def _html(self, request, status: int, body: str) -> None:
        encoded = body.encode()
        request.send_response(status)
        request.send_header("Content-Type", "text/html; charset=utf-8")
        request.send_header("Content-Length", str(len(encoded)))
        request.send_header("Cache-Control", "no-store")
        request.send_header("X-Content-Type-Options", "nosniff")
        request.end_headers()
        request.wfile.write(encoded)

    def _redirect(self, request, location: str) -> None:
        request.send_response(303)
        request.send_header("Location", location)
        request.send_header("Content-Length", "0")
        request.end_headers()
