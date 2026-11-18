"""Reject audio request files that do not match the library contract."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from audio_studio.schema import ValidationError, validate_generation_request  # noqa: E402


class Limits:
    min_duration_seconds = 10
    max_duration_seconds = 180
    max_prompt_chars = 4000


def main() -> int:
    repo = Path(__file__).resolve().parents[3]
    inbox = repo / "audio-requests" / "inbox"
    if not inbox.is_dir():
        print("No audio-requests/inbox directory")
        return 0
    failed = False
    files = sorted(inbox.glob("*.json"))
    for path in files:
        try:
            body = json.loads(path.read_text(encoding="utf-8"))
            validate_generation_request(body, Limits())
        except (OSError, json.JSONDecodeError, ValidationError) as exc:
            failed = True
            print(f"{path.name}: {exc}")
        else:
            print(f"{path.name}: ok")
    if not files:
        print("No pending audio requests")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
