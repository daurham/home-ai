"""Read-only listening page. It cannot submit jobs or read arbitrary files."""

from __future__ import annotations

import html
import ipaddress
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .db import Database
from .schema import ASSET_ID

_TRUSTED_NETWORKS = tuple(
    ipaddress.ip_network(cidr)
    for cidr in (
        "127.0.0.0/8",
        "10.0.0.0/8",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "169.254.0.0/16",
        "::1/128",
        "fc00::/7",
        "fe80::/10",
    )
)


def trusted_preview_client(address: str) -> bool:
    """True for loopback, link-local, and RFC1918 clients only."""
    if address.startswith("::ffff:"):
        address = address[7:]
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return False
    return any(ip in network for network in _TRUSTED_NETWORKS)


def local_preview_bind(bind: str) -> bool:
    if bind in {"0.0.0.0", "::"}:
        return True
    return trusted_preview_client(bind)


class PreviewServer:
    def __init__(self, config, db: Database | None = None):
        self.config = config
        self.db = db or Database(config.db_path)

    def make_server(self) -> ThreadingHTTPServer:
        if not local_preview_bind(self.config.preview_bind):
            raise SystemExit("AUDIO_PREVIEW_BIND must be a local or private address")
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
        if not trusted_preview_client(request.client_address[0]):
            self._html(request, 403, "<p>This preview is only available on the local network.</p>")
            return
        if method not in {"GET", "HEAD"}:
            self._html(request, 405, "<p>This preview is read-only.</p>")
            return
        path = request.path.split("?", 1)[0]
        if path in {"/", "/library"} and method == "GET":
            self._html(request, 200, self._library_page())
            return
        if path.startswith("/audio/") and method in {"GET", "HEAD"}:
            asset_id = path[len("/audio/"):]
            self._audio(request, method, asset_id)
            return
        self._html(request, 404, "<p>Not found.</p>")

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
        if status == 405:
            request.send_header("Allow", "GET, HEAD")
        request.end_headers()
        request.wfile.write(encoded)
