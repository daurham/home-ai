"""Fetch audio requests from GitHub and push JSON results back.

The checkout used here is separate from the tree the API imports. Commits are
limited to request, result, and activity files. Audio bytes are never staged.
"""

from __future__ import annotations

import fcntl
import os
import re
import subprocess
from pathlib import Path

from .bridge import BridgeError, sync_inbox

ALLOWED_PREFIXES = ("audio-requests/", "audio-results/", "ops/activity/")
DISALLOWED_SUFFIXES = (
    ".wav", ".mp3", ".flac", ".ogg", ".mp4", ".mov", ".png", ".jpg", ".jpeg", ".webp",
)
SECRET_RE = re.compile(
    r"https://[^/\s@]+@|Bearer [A-Za-z0-9._\-]+|ghp_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+"
)


def sync_remote(config) -> list[str]:
    if not config.github_branch:
        raise BridgeError("AUDIO_GITHUB_BRANCH is required")
    if not config.github_push:
        raise BridgeError("AUDIO_GITHUB_PUSH must be true for the remote bridge")
    lock_path = config.home / "data" / "bridge.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a", encoding="utf-8") as handle:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return ["bridge already running"]
        root = _ensure_repo(config)
        _commit_allowlisted(root)
        _git(root, ["fetch", "origin", config.github_branch])
        _git(root, ["rebase", f"origin/{config.github_branch}"])
        notes = sync_inbox(
            config,
            root / "audio-requests" / "inbox",
            root / "audio-results",
            root / "audio-requests" / "accepted",
            log_root=root,
        )
        _commit_allowlisted(root)
        if _ahead(root, config.github_branch):
            _push(root, config.github_branch)
        return notes


def _ensure_repo(config) -> Path:
    root = Path(config.sync_root)
    url = config.github_remote_url or _origin_url(config.studio_root)
    branch = config.github_branch
    if not (root / ".git").exists():
        if root.exists() and any(root.iterdir()):
            raise BridgeError("sync directory is not a git checkout")
        root.parent.mkdir(parents=True, exist_ok=True)
        _git(root.parent, ["clone", "--branch", branch, "--single-branch", url, str(root)])
    return root


def _origin_url(studio_root: Path) -> str:
    result = _git(studio_root, ["remote", "get-url", "origin"])
    return result.stdout.strip()


def _git(cwd: Path, args: list[str]) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    env["GIT_TERMINAL_PROMPT"] = "0"
    result = subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        env=env,
        text=True,
        capture_output=True,
    )
    if result.returncode != 0:
        detail = SECRET_RE.sub("[redacted]", (result.stderr or result.stdout or "git failed"))
        raise BridgeError(detail[-500:])
    return result


def _safe(path: str) -> bool:
    if path.startswith("/") or ".." in Path(path).parts:
        return False
    if not path.startswith(ALLOWED_PREFIXES):
        return False
    return not path.lower().endswith(DISALLOWED_SUFFIXES)


def _commit_allowlisted(root: Path) -> bool:
    status = _git(root, ["status", "--porcelain", "-uall"]).stdout.splitlines()
    stage = []
    for line in status:
        if len(line) < 4:
            continue
        path = line[3:].strip()
        if " -> " in path:
            path = path.split(" -> ", 1)[1].strip()
        if _safe(path):
            stage.append(path)
    if not stage:
        return False
    _git(root, ["add", "--", *stage])
    staged = [item for item in _git(root, ["diff", "--cached", "--name-only"]).stdout.split() if item]
    if any(not _safe(item) for item in staged):
        _git(root, ["reset"])
        raise BridgeError("refusing to commit a file outside the audio metadata allowlist")
    if not staged:
        return False
    _git(
        root,
        [
            "-c", "user.name=Audio Bridge",
            "-c", "user.email=audio-bridge@localhost",
            "commit", "-m",
            "Record audio job status\n\nJSON manifest only. No audio bytes are included.",
        ],
    )
    return True


def _ahead(root: Path, branch: str) -> bool:
    result = _git(root, ["rev-list", "--count", f"origin/{branch}..HEAD"])
    return int(result.stdout.strip() or "0") > 0


def _push(root: Path, branch: str) -> None:
    try:
        _git(root, ["push", "origin", f"HEAD:{branch}"])
    except BridgeError as exc:
        text = str(exc).lower()
        if "non-fast-forward" not in text and "fetch first" not in text:
            raise
        _git(root, ["pull", "--rebase", "origin", branch])
        _git(root, ["push", "origin", f"HEAD:{branch}"])
