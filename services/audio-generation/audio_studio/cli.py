"""Operator CLI. `audioctl submit` returns a job id without waiting for audio."""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

from .api import AudioAPI
from .bridge import sync_inbox
from .config import load_config
from .db import Database
from .drive import run_auth_flow
from .github_sync import sync_remote
from .cleanup import asset_updates, ensure_mp3, prepare_listening_copy
from .media import find_ffmpeg
from .preview import PreviewServer
from .worker import Worker


def _call(config, method: str, path: str, payload: dict | None = None) -> dict:
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
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.loads(response.read().decode())
    except urllib.error.HTTPError as exc:
        print(exc.read().decode())
        raise SystemExit(exc.code) from exc


def cmd_listening(config) -> None:
    db = Database(config.db_path)
    ffmpeg = find_ffmpeg(config.ffmpeg)
    notes = []
    for asset in db.search_assets(limit=500):
        wav = Path(asset.get("wav_path") or "")
        if not wav.is_file():
            continue
        if not asset.get("listening_checked"):
            report = prepare_listening_copy(wav, config.library_dir, asset["id"])
            db.update_asset(asset["id"], **asset_updates(report))
            notes.append(asset["id"] + ": " + report["reason"])
        mp3 = config.library_dir / f"{asset['id']}.mp3"
        if ffmpeg and not asset.get("mp3_path") and ensure_mp3(wav, mp3, ffmpeg):
            db.update_asset(asset["id"], mp3_path=str(mp3))
            notes.append(asset["id"] + ": mp3")
    print(json.dumps({"updated": notes, "ffmpeg": bool(ffmpeg)}, indent=2))


def cmd_api(config) -> None:
    server = AudioAPI(config).make_server()
    print(f"audio api listening on http://{config.host}:{server.server_address[1]}", flush=True)
    server.serve_forever()


def cmd_worker(config) -> None:
    worker = Worker(config, Database(config.db_path))
    worker.run_forever(lambda: False)


def cmd_bridge(config, args) -> None:
    if args.remote:
        print(json.dumps({"synced": sync_remote(config)}))
        return
    inbox = config.studio_root / "audio-requests" / "inbox"
    results = config.studio_root / "audio-results"
    accepted = config.studio_root / "audio-requests" / "accepted"
    if args.inbox:
        inbox = config.home / args.inbox
    notes = sync_inbox(config, inbox, results if not args.inbox else inbox.parent / "results", accepted if not args.inbox else inbox.parent / "accepted")
    print(json.dumps({"synced": notes}))


def cmd_preview(config) -> None:
    server = PreviewServer(config).make_server()
    print(f"audio preview listening on http://{config.preview_bind}:{server.server_address[1]}", flush=True)
    server.serve_forever()


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="audioctl")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("api")
    sub.add_parser("worker")
    sub.add_parser("preview")
    sub.add_parser("auth-drive")
    bridge = sub.add_parser("bridge")
    bridge.add_argument("--once", action="store_true")
    bridge.add_argument("--remote", action="store_true")
    bridge.add_argument("--inbox", default="")
    submit = sub.add_parser("submit")
    submit.add_argument("--file")
    submit.add_argument("--prompt")
    submit.add_argument("--episode", default="")
    submit.add_argument("--duration", type=float, default=30)
    submit.add_argument("--genre", default="other")
    submit.add_argument("--request-id", required=True)
    status = sub.add_parser("status")
    status.add_argument("job_id")
    search = sub.add_parser("search")
    search.add_argument("--q", default="")
    search.add_argument("--approved", action="store_true")
    search.add_argument("--genre", default="")
    search.add_argument("--episode", default="")
    approve = sub.add_parser("approve")
    approve.add_argument("asset_id")
    cancel = sub.add_parser("cancel")
    cancel.add_argument("job_id")
    sub.add_parser("health")
    sub.add_parser("listening")
    args = parser.parse_args(argv)
    config = load_config()
    if args.command == "api":
        cmd_api(config)
    elif args.command == "worker":
        cmd_worker(config)
    elif args.command == "preview":
        cmd_preview(config)
    elif args.command == "auth-drive":
        run_auth_flow(config)
    elif args.command == "bridge":
        cmd_bridge(config, args)
    elif args.command == "listening":
        cmd_listening(config)
    elif args.command == "health":
        print(json.dumps(_call(config, "GET", "/v1/health"), indent=2))
    elif args.command == "status":
        print(json.dumps(_call(config, "GET", f"/v1/jobs/{args.job_id}"), indent=2))
    elif args.command == "cancel":
        print(json.dumps(_call(config, "POST", f"/v1/jobs/{args.job_id}/cancel", {}), indent=2))
    elif args.command == "approve":
        print(json.dumps(_call(config, "POST", f"/v1/library/{args.asset_id}/approval", {"approved": True}), indent=2))
    elif args.command == "search":
        query = f"/v1/library?q={args.q}&genre={args.genre}&episode={args.episode}"
        if args.approved:
            query += "&approved=true"
        print(json.dumps(_call(config, "GET", query), indent=2))
    elif args.command == "submit":
        if args.file:
            body = json.loads(open(args.file, encoding="utf-8").read())
        else:
            body = {
                "request_id": args.request_id,
                "type": "music",
                "episode": args.episode,
                "prompt": args.prompt,
                "duration_seconds": args.duration,
                "variants": 1,
                "genre": args.genre,
                "approval": "GENERATE_LIBRARY_MUSIC",
                "save_to_library": True,
                "publishing_authorized": False,
            }
        print(json.dumps(_call(config, "POST", "/v1/jobs", body), indent=2))
    else:
        parser.error("unknown command")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
