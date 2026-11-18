"""SQLite job and asset store. WAL mode keeps the API readable during writes."""

from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def utcnow() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


class Database:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        with self.connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS jobs (
                  id TEXT PRIMARY KEY,
                  request_id TEXT NOT NULL UNIQUE,
                  type TEXT NOT NULL,
                  state TEXT NOT NULL,
                  episode TEXT NOT NULL DEFAULT '',
                  prompt TEXT NOT NULL DEFAULT '',
                  duration_seconds REAL,
                  seed INTEGER,
                  genre TEXT NOT NULL DEFAULT 'other',
                  mood TEXT NOT NULL DEFAULT '[]',
                  tags TEXT NOT NULL DEFAULT '[]',
                  request_json TEXT NOT NULL,
                  result_json TEXT,
                  error TEXT,
                  attempts INTEGER NOT NULL DEFAULT 0,
                  upload_attempts INTEGER NOT NULL DEFAULT 0,
                  cancel_requested INTEGER NOT NULL DEFAULT 0,
                  asset_id TEXT,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL,
                  started_at TEXT,
                  finished_at TEXT,
                  provider_cost_usd REAL NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS assets (
                  id TEXT PRIMARY KEY,
                  job_id TEXT,
                  type TEXT NOT NULL,
                  episode TEXT NOT NULL DEFAULT '',
                  prompt TEXT NOT NULL DEFAULT '',
                  genre TEXT NOT NULL DEFAULT 'other',
                  mood TEXT NOT NULL DEFAULT '[]',
                  tags TEXT NOT NULL DEFAULT '[]',
                  duration_seconds REAL,
                  seed TEXT,
                  generator TEXT NOT NULL,
                  model TEXT NOT NULL,
                  license_note TEXT NOT NULL,
                  approval_status TEXT NOT NULL DEFAULT 'pending',
                  wav_path TEXT,
                  mp3_path TEXT,
                  sha256 TEXT,
                  size_bytes INTEGER,
                  drive_file_id TEXT,
                  drive_url TEXT,
                  drive_folder TEXT,
                  metadata_drive_file_id TEXT,
                  metadata_drive_url TEXT,
                  favorite_shortcut_id TEXT,
                  created_at TEXT NOT NULL,
                  approved_at TEXT
                );
                CREATE TABLE IF NOT EXISTS events (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  job_id TEXT,
                  at TEXT NOT NULL,
                  level TEXT NOT NULL,
                  message TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS submit_log (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state, created_at);
                CREATE INDEX IF NOT EXISTS idx_assets_approval ON assets(approval_status, type);
                """
            )
            self._ensure_asset_columns(conn)

    def _ensure_asset_columns(self, conn: sqlite3.Connection) -> None:
        present = {row[1] for row in conn.execute("PRAGMA table_info(assets)")}
        additions = {
            "clean_wav_path": "TEXT",
            "clean_sha256": "TEXT",
            "clean_size_bytes": "INTEGER",
            "clean_duration_seconds": "REAL",
            "silence_start_seconds": "REAL",
            "silence_end_seconds": "REAL",
            "fade_applied": "INTEGER NOT NULL DEFAULT 0",
            "favorite": "INTEGER NOT NULL DEFAULT 0",
            "listening_checked": "INTEGER NOT NULL DEFAULT 0",
            "listening_note": "TEXT",
        }
        for name, declaration in additions.items():
            if name not in present:
                conn.execute(f"ALTER TABLE assets ADD COLUMN {name} {declaration}")

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, timeout=30, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA busy_timeout=5000")
        return conn

    def _event(self, conn: sqlite3.Connection, job_id: str, level: str, message: str) -> None:
        conn.execute(
            "INSERT INTO events(job_id, at, level, message) VALUES (?, ?, ?, ?)",
            (job_id, utcnow(), level, message[:500]),
        )

    def job_by_request(self, request_id: str) -> dict | None:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT * FROM jobs WHERE request_id = ?", (request_id,)
            ).fetchone()
        return self._job(row) if row else None

    def job(self, job_id: str) -> dict | None:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        return self._job(row) if row else None

    def _job(self, row: sqlite3.Row) -> dict[str, Any]:
        data = dict(row)
        data["mood"] = json.loads(data.pop("mood"))
        data["tags"] = json.loads(data.pop("tags"))
        data["request"] = json.loads(data.pop("request_json"))
        raw_result = data.pop("result_json")
        data["result"] = json.loads(raw_result) if raw_result else None
        data["cancel_requested"] = bool(data["cancel_requested"])
        return data

    def insert_job(self, request: dict[str, Any]) -> dict:
        now = utcnow()
        job_id = "job_" + uuid.uuid4().hex
        with self._lock, self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                existing = conn.execute(
                    "SELECT * FROM jobs WHERE request_id = ?", (request["request_id"],)
                ).fetchone()
                if existing:
                    conn.execute("COMMIT")
                    return self._job(existing)
                state = "completed" if request.get("reuse_asset_id") else "queued"
                conn.execute(
                    """
                    INSERT INTO jobs(
                      id, request_id, type, state, episode, prompt, duration_seconds,
                      seed, genre, mood, tags, request_json, created_at, updated_at,
                      finished_at, asset_id
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        job_id,
                        request["request_id"],
                        request["type"],
                        state,
                        request["episode"],
                        request["prompt"],
                        request["duration_seconds"],
                        request.get("seed"),
                        request["genre"],
                        json.dumps(request["mood"]),
                        json.dumps(request["tags"]),
                        json.dumps(request),
                        now,
                        now,
                        now if state == "completed" else None,
                        request.get("reuse_asset_id") or None,
                    ),
                )
                self._event(conn, job_id, "info", f"accepted as {state}")
                conn.execute("COMMIT")
            except Exception:
                conn.execute("ROLLBACK")
                raise
        return self.job(job_id)

    def active_count(self) -> int:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT COUNT(*) AS n FROM jobs WHERE state IN ('queued','running','uploading')"
            ).fetchone()
        return int(row["n"])

    def allow_submit(self, limit: int, window_seconds: int) -> bool:
        now = time.time()
        with self._lock, self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute("DELETE FROM submit_log WHERE at < ?", (now - window_seconds,))
            count = conn.execute("SELECT COUNT(*) AS n FROM submit_log").fetchone()["n"]
            if count >= limit:
                conn.execute("COMMIT")
                return False
            conn.execute("INSERT INTO submit_log(at) VALUES (?)", (now,))
            conn.execute("COMMIT")
        return True

    def list_jobs(self, state: str | None = None, limit: int = 50) -> list[dict]:
        sql = "SELECT * FROM jobs"
        args: list[Any] = []
        if state:
            sql += " WHERE state = ?"
            args.append(state)
        sql += " ORDER BY created_at DESC LIMIT ?"
        args.append(limit)
        with self.connect() as conn:
            rows = conn.execute(sql, args).fetchall()
        return [self._job(row) for row in rows]

    def request_cancel(self, job_id: str) -> dict | None:
        with self._lock, self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
            if not row:
                conn.execute("COMMIT")
                return None
            if row["state"] == "queued":
                conn.execute(
                    "UPDATE jobs SET state='cancelled', updated_at=?, finished_at=?, error=NULL WHERE id=?",
                    (utcnow(), utcnow(), job_id),
                )
                self._event(conn, job_id, "info", "cancelled while queued")
            elif row["state"] in {"running", "uploading"}:
                conn.execute(
                    "UPDATE jobs SET cancel_requested=1, updated_at=? WHERE id=?",
                    (utcnow(), job_id),
                )
                self._event(conn, job_id, "info", "cancel requested")
            conn.execute("COMMIT")
        return self.job(job_id)

    def recover(self, max_generation_attempts: int) -> list[str]:
        notes = []
        with self._lock, self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            rows = conn.execute("SELECT * FROM jobs WHERE state = 'running'").fetchall()
            for row in rows:
                result = json.loads(row["result_json"] or "{}")
                wav = result.get("wav_path")
                if wav and Path(wav).is_file() and Path(wav).stat().st_size > 44:
                    conn.execute(
                        "UPDATE jobs SET state='uploading', updated_at=? WHERE id=?",
                        (utcnow(), row["id"]),
                    )
                    notes.append(f"{row['id']} resumed upload")
                    self._event(conn, row["id"], "info", "recovered audio; resuming upload")
                elif row["attempts"] >= max_generation_attempts:
                    conn.execute(
                        """
                        UPDATE jobs SET state='failed', updated_at=?, finished_at=?,
                        error='generation interrupted and retries exhausted'
                        WHERE id=?
                        """,
                        (utcnow(), utcnow(), row["id"]),
                    )
                    notes.append(f"{row['id']} failed after interrupt")
                else:
                    conn.execute(
                        "UPDATE jobs SET state='queued', updated_at=?, error='retry after interrupt' WHERE id=?",
                        (utcnow(), row["id"]),
                    )
                    notes.append(f"{row['id']} requeued")
                    self._event(conn, row["id"], "info", "requeued after interrupt")
            conn.execute("COMMIT")
        return notes

    def claim_next(self) -> dict | None:
        with self._lock, self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                """
                SELECT id FROM jobs
                WHERE state = 'queued' AND cancel_requested = 0
                ORDER BY created_at LIMIT 1
                """
            ).fetchone()
            if not row:
                upload = conn.execute(
                    """
                    SELECT id FROM jobs
                    WHERE state = 'uploading' AND cancel_requested = 0
                    ORDER BY updated_at LIMIT 1
                    """
                ).fetchone()
                conn.execute("COMMIT")
                return self.job(upload["id"]) if upload else None
            now = utcnow()
            conn.execute(
                """
                UPDATE jobs
                SET state='running', attempts=attempts+1, started_at=COALESCE(started_at, ?),
                    updated_at=?, error=NULL
                WHERE id=?
                """,
                (now, now, row["id"]),
            )
            self._event(conn, row["id"], "info", "generation started")
            conn.execute("COMMIT")
        return self.job(row["id"])

    def mark(self, job_id: str, **fields: Any) -> None:
        allowed = {
            "state", "error", "result", "asset_id", "finished_at", "upload_attempts",
            "provider_cost_usd",
        }
        sets = []
        args: list[Any] = []
        for key, value in fields.items():
            if key not in allowed:
                raise KeyError(key)
            column = "result_json" if key == "result" else key
            if key == "result" and value is not None:
                value = json.dumps(value)
            sets.append(f"{column}=?")
            args.append(value)
        sets.append("updated_at=?")
        args.append(utcnow())
        args.append(job_id)
        with self._lock, self.connect() as conn:
            conn.execute(f"UPDATE jobs SET {', '.join(sets)} WHERE id=?", args)

    def add_event(self, job_id: str, level: str, message: str) -> None:
        with self.connect() as conn:
            self._event(conn, job_id, level, message)

    def latest_event(self, job_id: str) -> str:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT message FROM events WHERE job_id = ? ORDER BY id DESC LIMIT 1",
                (job_id,),
            ).fetchone()
        return row["message"] if row else ""

    def cancel_flag(self, job_id: str) -> bool:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT cancel_requested FROM jobs WHERE id=?", (job_id,)
            ).fetchone()
        return bool(row and row["cancel_requested"])

    def insert_asset(self, asset: dict[str, Any]) -> dict:
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO assets(
                  id, job_id, type, episode, prompt, genre, mood, tags, duration_seconds,
                  seed, generator, model, license_note, approval_status, wav_path, mp3_path,
                  sha256, size_bytes, drive_file_id, drive_url, drive_folder,
                  metadata_drive_file_id, metadata_drive_url, created_at
                ) VALUES (
                  :id, :job_id, :type, :episode, :prompt, :genre, :mood, :tags, :duration_seconds,
                  :seed, :generator, :model, :license_note, :approval_status, :wav_path, :mp3_path,
                  :sha256, :size_bytes, :drive_file_id, :drive_url, :drive_folder,
                  :metadata_drive_file_id, :metadata_drive_url, :created_at
                )
                """,
                {
                    "mood": json.dumps(asset.get("mood") or []),
                    "tags": json.dumps(asset.get("tags") or []),
                    "approval_status": asset.get("approval_status", "pending"),
                    "mp3_path": asset.get("mp3_path"),
                    "drive_file_id": asset.get("drive_file_id"),
                    "drive_url": asset.get("drive_url"),
                    "drive_folder": asset.get("drive_folder"),
                    "metadata_drive_file_id": asset.get("metadata_drive_file_id"),
                    "metadata_drive_url": asset.get("metadata_drive_url"),
                    "created_at": asset.get("created_at") or utcnow(),
                    **{k: asset[k] for k in (
                        "id", "job_id", "type", "episode", "prompt", "genre",
                        "duration_seconds", "seed", "generator", "model", "license_note",
                        "wav_path", "sha256", "size_bytes",
                    )},
                },
            )
        return self.asset(asset["id"])

    def asset(self, asset_id: str) -> dict | None:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM assets WHERE id=?", (asset_id,)).fetchone()
        return self._asset(row) if row else None

    def _asset(self, row: sqlite3.Row) -> dict[str, Any]:
        data = dict(row)
        data["mood"] = json.loads(data["mood"])
        data["tags"] = json.loads(data["tags"])
        return data

    def update_asset(self, asset_id: str, **fields: Any) -> None:
        allowed = {
            "approval_status", "approved_at", "drive_file_id", "drive_url", "drive_folder",
            "metadata_drive_file_id", "metadata_drive_url", "favorite_shortcut_id",
            "mp3_path", "sha256", "size_bytes",
            "clean_wav_path", "clean_sha256", "clean_size_bytes", "clean_duration_seconds",
            "silence_start_seconds", "silence_end_seconds", "fade_applied", "favorite",
            "listening_checked", "listening_note",
        }
        sets = []
        args: list[Any] = []
        for key, value in fields.items():
            if key not in allowed:
                raise KeyError(key)
            sets.append(f"{key}=?")
            args.append(value)
        args.append(asset_id)
        with self.connect() as conn:
            conn.execute(f"UPDATE assets SET {', '.join(sets)} WHERE id=?", args)

    def search_assets(
        self,
        *,
        query: str = "",
        genre: str = "",
        mood: str = "",
        episode: str = "",
        kind: str = "",
        approved_only: bool = False,
        favorite_only: bool = False,
        min_duration: float | None = None,
        max_duration: float | None = None,
        limit: int = 50,
    ) -> list[dict]:
        sql = "SELECT * FROM assets WHERE 1=1"
        args: list[Any] = []
        if approved_only:
            sql += " AND approval_status = 'approved'"
        if favorite_only:
            sql += " AND favorite = 1"
        if genre:
            sql += " AND genre = ?"
            args.append(genre)
        if episode:
            sql += " AND episode = ?"
            args.append(episode)
        if kind:
            sql += " AND type = ?"
            args.append(kind)
        if min_duration is not None:
            sql += " AND duration_seconds >= ?"
            args.append(min_duration)
        if max_duration is not None:
            sql += " AND duration_seconds <= ?"
            args.append(max_duration)
        if mood:
            sql += " AND mood LIKE ?"
            args.append(f'%"{mood.lower()}"%')
        if query:
            sql += " AND (prompt LIKE ? OR tags LIKE ? OR genre LIKE ? OR episode LIKE ? OR id LIKE ?)"
            like = f"%{query}%"
            args.extend([like, like, like, like, like])
        sql += " ORDER BY created_at DESC LIMIT ?"
        args.append(limit)
        with self.connect() as conn:
            rows = conn.execute(sql, args).fetchall()
        return [self._asset(row) for row in rows]

    def set_approval(self, asset_id: str, approved: bool) -> dict | None:
        if not self.asset(asset_id):
            return None
        if approved:
            self.update_asset(
                asset_id, approval_status="approved", approved_at=utcnow()
            )
        else:
            self.update_asset(asset_id, approval_status="pending", approved_at=None)
        return self.asset(asset_id)

    def set_favorite(self, asset_id: str, favorite: bool) -> dict | None:
        if not self.asset(asset_id):
            return None
        self.update_asset(asset_id, favorite=1 if favorite else 0)
        return self.asset(asset_id)
