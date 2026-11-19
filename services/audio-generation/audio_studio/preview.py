"""Home AI Music Studio page. Generation stays on the localhost API."""

from __future__ import annotations

import ipaddress
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from .db import Database
from .schema import ASSET_ID
from .studio import Studio

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
        self.studio = Studio(config, self.db)

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
        if method not in {"GET", "HEAD", "POST"}:
            self._html(request, 405, "<p>Method not allowed.</p>")
            return
        if self.studio.handle(request, method):
            return
        if method not in {"GET", "HEAD"}:
            self._html(request, 405, "<p>This page cannot accept that request.</p>")
            return
        path = request.path.split("?", 1)[0]
        if path.startswith("/audio/") and method in {"GET", "HEAD"}:
            self._audio(request, method, path[len("/audio/"):])
            return
        self._html(request, 404, "<p>Not found.</p>")

    def _audio(self, request, method: str, name: str) -> None:
        asset_id, kind = _audio_name(name)
        if not asset_id:
            self._html(request, 404, "<p>Not found.</p>")
            return
        asset = self.db.asset(asset_id)
        if not asset:
            self._html(request, 404, "<p>Not found.</p>")
            return
        library = self.config.library_dir.resolve()
        if kind == "wav":
            path = Path(asset.get("wav_path") or "")
            expected = f"{asset_id}.wav"
            content_type = "audio/wav"
        elif kind == "clean":
            path = Path(asset.get("clean_wav_path") or "")
            expected = f"{asset_id}.clean.wav"
            content_type = "audio/wav"
        else:
            path = Path(asset.get("mp3_path") or "")
            expected = f"{asset_id}.mp3"
            content_type = "audio/mpeg"
        if not path:
            self._html(request, 404, "<p>Not found.</p>")
            return
        resolved = path.resolve()
        if resolved.parent != library or resolved.name != expected or not resolved.is_file():
            self._html(request, 404, "<p>Not found.</p>")
            return
        download = "download" in parse_qs(urlparse(request.path).query)
        self._send_audio(request, method, resolved, content_type, expected if download else "")

    def _send_audio(self, request, method: str, path: Path, content_type: str, download_name: str) -> None:
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
        request.send_header("Content-Type", content_type)
        request.send_header("Accept-Ranges", "bytes")
        request.send_header("Content-Length", str(length))
        request.send_header("Cache-Control", "private, no-store")
        if download_name:
            request.send_header("Content-Disposition", f'attachment; filename="{download_name}"')
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


def _audio_name(name: str) -> tuple[str, str]:
    if name.endswith(".clean.wav"):
        asset_id = name[: -len(".clean.wav")]
        kind = "clean"
    elif name.endswith(".mp3"):
        asset_id = name[: -len(".mp3")]
        kind = "mp3"
    elif name.endswith(".wav"):
        asset_id = name[: -len(".wav")]
        kind = "wav"
    else:
        asset_id = name
        kind = "wav"
    if not ASSET_ID.match(asset_id):
        return "", ""
    return asset_id, kind
