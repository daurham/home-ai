"""Environment configuration. Secrets come from the environment, never from code."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _load_env_file(path: Path) -> None:
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip("'").strip('"')
        if key and key not in os.environ:
            os.environ[key] = value


def _int(name: str, default: int, low: int, high: int) -> int:
    raw = os.environ.get(name, str(default))
    try:
        value = int(raw)
    except ValueError as exc:
        raise SystemExit(f"{name} must be an integer") from exc
    if value < low or value > high:
        raise SystemExit(f"{name} must be between {low} and {high}")
    return value


def _float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, str(default)))
    except ValueError as exc:
        raise SystemExit(f"{name} must be a number") from exc


@dataclass(frozen=True)
class Config:
    home: Path
    db_path: Path
    library_dir: Path
    work_dir: Path
    import_dir: Path
    log_dir: Path
    host: str
    port: int
    api_token: str
    max_queue: int
    max_duration_seconds: float
    min_duration_seconds: float
    max_prompt_chars: int
    max_body_bytes: int
    rate_limit_count: int
    rate_limit_window_seconds: int
    max_generation_attempts: int
    max_upload_attempts: int
    min_free_bytes: int
    backend: str
    backend_reason: str
    acestep_root: Path
    acestep_python: Path
    acestep_host: str
    acestep_port: int
    acestep_api_key: str
    model_name: str
    inference_steps: int
    generation_timeout_seconds: int
    init_timeout_seconds: int
    worker_poll_seconds: float
    google_client_secrets: Path
    google_token_path: Path
    drive_parent_id: str
    drive_scope: str
    studio_root: Path
    sync_root: Path
    github_branch: str
    github_remote_url: str
    github_push: bool
    bridge_poll_seconds: float
    drive_enabled: bool
    preview_bind: str
    preview_port: int
    preview_token: str
    ffmpeg: str

    @property
    def drive_configured(self) -> bool:
        return self.google_client_secrets.is_file() and self.google_token_path.is_file()


def load_config() -> Config:
    home = Path(os.environ.get("AUDIO_HOME", str(Path.home() / "audio-service"))).expanduser()
    env_file = Path(os.environ.get("AUDIO_ENV_FILE", str(home / ".env")))
    _load_env_file(env_file)
    home = Path(os.environ.get("AUDIO_HOME", str(home))).expanduser()
    host = os.environ.get("AUDIO_BIND_HOST", "127.0.0.1")
    if host not in {"127.0.0.1", "localhost", "::1"}:
        raise SystemExit("AUDIO_BIND_HOST must stay on localhost")
    backend = os.environ.get("AUDIO_BACKEND", "acestep").strip().lower()
    if backend not in {"acestep", "fake", "disabled"}:
        raise SystemExit("AUDIO_BACKEND must be acestep, fake, or disabled")
    token = os.environ.get("AUDIO_API_TOKEN", "")
    scope = os.environ.get(
        "AUDIO_DRIVE_SCOPE", "https://www.googleapis.com/auth/drive.file"
    )
    allowed_scopes = {
        "https://www.googleapis.com/auth/drive.file",
        "https://www.googleapis.com/auth/drive",
    }
    if scope not in allowed_scopes:
        raise SystemExit("AUDIO_DRIVE_SCOPE is not an allowed Drive scope")
    preview_bind = os.environ.get("AUDIO_PREVIEW_BIND", "127.0.0.1").strip()
    if preview_bind in {"*", ""}:
        raise SystemExit("AUDIO_PREVIEW_BIND must be an address")
    drive_enabled = os.environ.get("AUDIO_DRIVE_ENABLED", "false").strip().lower() in {
        "1", "true", "yes", "on",
    }
    studio_root_raw = os.environ.get("AUDIO_STUDIO_ROOT", "").strip()
    cfg = Config(
        home=home,
        db_path=home / "data" / "audio.sqlite",
        library_dir=home / "data" / "library",
        work_dir=home / "data" / "work",
        import_dir=home / "data" / "import-inbox",
        log_dir=home / "data" / "logs",
        host=host,
        port=_int("AUDIO_PORT", 8795, 1024, 65535),
        api_token=token,
        max_queue=_int("AUDIO_MAX_QUEUE", 8, 1, 100),
        max_duration_seconds=_float("AUDIO_MAX_DURATION_SECONDS", 180),
        min_duration_seconds=_float("AUDIO_MIN_DURATION_SECONDS", 10),
        max_prompt_chars=_int("AUDIO_MAX_PROMPT_CHARS", 4000, 100, 20000),
        max_body_bytes=_int("AUDIO_MAX_BODY_BYTES", 65536, 1024, 1_000_000),
        rate_limit_count=_int("AUDIO_RATE_LIMIT_COUNT", 6, 1, 1000),
        rate_limit_window_seconds=_int("AUDIO_RATE_LIMIT_WINDOW", 600, 10, 86400),
        max_generation_attempts=_int("AUDIO_MAX_GENERATION_ATTEMPTS", 2, 1, 5),
        max_upload_attempts=_int("AUDIO_MAX_UPLOAD_ATTEMPTS", 5, 1, 20),
        min_free_bytes=_int("AUDIO_MIN_FREE_BYTES", 8 * 1024 ** 3, 1, 10 ** 15),
        backend=backend,
        backend_reason=os.environ.get(
            "AUDIO_BACKEND_REASON",
            "The generation backend is disabled.",
        ),
        acestep_root=Path(
            os.environ.get("ACESTEP_ROOT", str(home / "vendor" / "ACE-Step-1.5"))
        ).expanduser(),
        acestep_python=Path(
            os.environ.get(
                "ACESTEP_PYTHON",
                str(home / "vendor" / "ACE-Step-1.5" / ".venv" / "bin" / "python"),
            )
        ).expanduser(),
        acestep_host="127.0.0.1",
        acestep_port=_int("ACESTEP_PORT", 8001, 1024, 65535),
        acestep_api_key=os.environ.get("ACESTEP_API_KEY", ""),
        model_name=os.environ.get("ACESTEP_CONFIG_PATH", "acestep-v15-turbo"),
        inference_steps=_int("ACESTEP_INFERENCE_STEPS", 8, 1, 20),
        generation_timeout_seconds=_int("AUDIO_GENERATION_TIMEOUT", 7200, 30, 86400),
        init_timeout_seconds=_int("AUDIO_INIT_TIMEOUT", 1800, 30, 86400),
        worker_poll_seconds=_float("AUDIO_WORKER_POLL_SECONDS", 2),
        google_client_secrets=Path(
            os.environ.get("AUDIO_GOOGLE_CLIENT_SECRETS", str(home / "google-client.json"))
        ).expanduser(),
        google_token_path=Path(
            os.environ.get("AUDIO_GOOGLE_TOKEN", str(home / "data" / "google-token.json"))
        ).expanduser(),
        drive_parent_id=os.environ.get("AUDIO_DRIVE_PARENT_ID", "").strip(),
        drive_scope=scope,
        studio_root=Path(studio_root_raw).expanduser() if studio_root_raw else home / "client-repo",
        sync_root=Path(
            os.environ.get("AUDIO_SYNC_ROOT", str(home / "data" / "studio-sync"))
        ).expanduser(),
        github_branch=os.environ.get("AUDIO_GITHUB_BRANCH", "").strip(),
        github_remote_url=os.environ.get("AUDIO_GITHUB_REMOTE", "").strip(),
        github_push=os.environ.get("AUDIO_GITHUB_PUSH", "false").strip().lower()
        in {"1", "true", "yes", "on"},
        bridge_poll_seconds=_float("AUDIO_BRIDGE_POLL_SECONDS", 30),
        drive_enabled=drive_enabled,
        preview_bind=preview_bind,
        preview_port=_int("AUDIO_PREVIEW_PORT", 8796, 1024, 65535),
        preview_token=os.environ.get("AUDIO_PREVIEW_TOKEN", ""),
        ffmpeg=os.environ.get("AUDIO_FFMPEG", ""),
    )
    for directory in (
        cfg.home / "data",
        cfg.library_dir,
        cfg.work_dir,
        cfg.import_dir,
        cfg.log_dir,
    ):
        directory.mkdir(parents=True, exist_ok=True)
    return cfg
