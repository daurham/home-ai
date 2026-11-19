"""One-at-a-time worker. Upload retries never regenerate audio."""

from __future__ import annotations

import json
import shutil
import time
import uuid
from pathlib import Path

from .backends import AceStepBackend, BackendError, Cancelled, FakeBackend
from .db import Database, utcnow
from .drive import DriveClient, DriveNotConfigured, DriveUploadError
from .cleanup import asset_updates, prepare_listening_copy
from .media import find_ffmpeg, sha256_file, transcode_mp3, wav_duration
from .schema import genre_folder


class Worker:
    def __init__(self, config, db: Database, backend=None, drive=None):
        self.config = config
        self.db = db
        self.backend = backend or self._default_backend()
        self.drive = drive if drive is not None else DriveClient(config)
        self.ffmpeg = find_ffmpeg(config.ffmpeg)

    def _default_backend(self):
        from .backends import AceStepBackend, DisabledBackend, FakeBackend

        if self.config.backend == "fake":
            return FakeBackend()
        if self.config.backend == "disabled":
            return DisabledBackend(self.config.backend_reason)
        return AceStepBackend(self.config)

    def recover(self) -> list[str]:
        return self.db.recover(self.config.max_generation_attempts)

    def run_forever(self, stop) -> None:
        self.recover()
        while not stop():
            self.run_once()
            if stop():
                return
            time.sleep(self.config.worker_poll_seconds)

    def run_once(self) -> bool:
        free = shutil.disk_usage(self.config.home).free
        if free < self.config.min_free_bytes:
            return False
        job = self.db.claim_next()
        if not job:
            return False
        if job["state"] == "running":
            self._generate(job)
        elif job["state"] == "uploading":
            self._upload(job)
        return True

    def _generate(self, job: dict) -> None:
        if self.db.cancel_flag(job["id"]):
            self._cancel(job["id"])
            return
        work = self.config.work_dir / job["id"]
        if work.exists():
            shutil.rmtree(work)
        work.mkdir(parents=True)
        try:
            result = self.backend.generate(
                job, work, lambda: self.db.cancel_flag(job["id"])
            )
            duration = wav_duration(Path(result.wav_path))
            payload = {
                "wav_path": result.wav_path,
                "duration_seconds": duration,
                "seed": result.seed,
                "model": result.model,
                "generator": result.generator,
                "init_seconds": result.init_seconds,
                "generation_seconds": result.generation_seconds,
                "peak_rss_bytes": result.peak_rss_bytes,
                "cpu_seconds": result.cpu_seconds,
                "license_note": result.license_note,
                "provider_cost_usd": 0,
                "electricity_cost_usd": None,
            }
            self.db.mark(job["id"], state="uploading", result=payload, error=None)
            self.db.add_event(job["id"], "info", "generation finished; storing audio")
            self._upload(self.db.job(job["id"]))
        except Cancelled:
            self._cancel(job["id"])
            shutil.rmtree(work, ignore_errors=True)
        except BackendError as exc:
            self._fail_generation(job, str(exc))
        except Exception as exc:
            self._fail_generation(job, f"{type(exc).__name__}: {exc}"[:500])

    def _fail_generation(self, job: dict, message: str) -> None:
        fresh = self.db.job(job["id"])
        if fresh["attempts"] >= self.config.max_generation_attempts:
            self.db.mark(
                job["id"], state="failed", error=message, finished_at=utcnow()
            )
            self.db.add_event(job["id"], "error", message)
        else:
            self.db.mark(job["id"], state="queued", error=message)
            self.db.add_event(job["id"], "error", f"will retry: {message}")

    def _upload(self, job: dict) -> None:
        if self.db.cancel_flag(job["id"]):
            self._cancel(job["id"])
            return
        result = dict(job["result"] or {})
        wav = Path(result.get("wav_path") or "")
        if not wav.is_file():
            self.db.mark(
                job["id"],
                state="failed",
                error="upload requested but the wav file is missing",
                finished_at=utcnow(),
            )
            return
        try:
            asset = self._store_local(job, result, wav)
            if not self.config.drive_enabled:
                self._finish_local(job, asset, result)
                return
            if not self.drive.configured:
                raise DriveNotConfigured("Google Drive is enabled but not authorized")
            uploaded = self._push(job, asset)
            asset = self.db.asset(asset["id"])
            self.db.update_asset(
                asset["id"],
                drive_file_id=uploaded["audio"]["id"],
                drive_url=uploaded["audio"]["url"],
                drive_folder=uploaded["folder"],
                metadata_drive_file_id=uploaded["metadata"]["id"],
                metadata_drive_url=uploaded["metadata"]["url"],
            )
            if asset.get("mp3_path"):
                pass
            final = self.db.asset(asset["id"])
            manifest = self._manifest(job, final, result, "completed", "verified")
            self.db.mark(
                job["id"],
                state="completed",
                asset_id=final["id"],
                result={**result, "manifest": manifest},
                error=None,
                finished_at=utcnow(),
                provider_cost_usd=0,
            )
            self.db.add_event(job["id"], "info", "upload verified")
            self._cleanup_work(job["id"], keep=Path(final["wav_path"]))
        except DriveNotConfigured as exc:
            self.db.mark(job["id"], state="uploading", error=str(exc))
            if (job.get("error") or "") != str(exc):
                self.db.add_event(job["id"], "blocked", str(exc))
        except DriveUploadError as exc:
            self._fail_upload(job, str(exc))
        except Exception as exc:
            self._fail_upload(job, f"{type(exc).__name__}: {exc}"[:500])

    def _fail_upload(self, job: dict, message: str) -> None:
        fresh = self.db.job(job["id"])
        attempts = fresh["upload_attempts"] + 1
        if attempts >= self.config.max_upload_attempts:
            self.db.mark(
                job["id"],
                state="failed",
                error=message,
                upload_attempts=attempts,
                finished_at=utcnow(),
            )
        else:
            self.db.mark(
                job["id"], state="uploading", error=message, upload_attempts=attempts
            )
        self.db.add_event(job["id"], "error", message)

    def _store_local(self, job: dict, result: dict, wav: Path) -> dict:
        existing = job.get("asset_id")
        if existing and self.db.asset(existing):
            return self.db.asset(existing)
        asset_id = "ast_" + uuid.uuid4().hex
        library_wav = self.config.library_dir / f"{asset_id}.wav"
        if wav.resolve() != library_wav.resolve():
            shutil.copy2(wav, library_wav)
        mp3_path = None
        if self.ffmpeg:
            candidate = self.config.library_dir / f"{asset_id}.mp3"
            if transcode_mp3(library_wav, candidate, self.ffmpeg):
                mp3_path = str(candidate)
        digest = sha256_file(library_wav)
        meta_path = self.config.library_dir / f"{asset_id}.json"
        record = {
            "id": asset_id,
            "job_id": job["id"],
            "type": job["type"],
            "episode": job["episode"],
            "prompt": job["prompt"],
            "genre": job["genre"],
            "mood": job["mood"],
            "tags": job["tags"],
            "duration_seconds": result.get("duration_seconds"),
            "seed": result.get("seed"),
            "generator": result.get("generator") or self.backend.name,
            "model": result.get("model") or "",
            "license_note": result.get("license_note") or "",
            "approval_status": "pending",
            "wav_path": str(library_wav),
            "mp3_path": mp3_path,
            "sha256": digest,
            "size_bytes": library_wav.stat().st_size,
            "created_at": utcnow(),
        }
        meta_path.write_text(json.dumps(record, indent=2), encoding="utf-8")
        stored = self.db.insert_asset(record)
        self._attach_listening_copy(stored, library_wav)
        self.db.mark(job["id"], asset_id=asset_id, result={**result, "wav_path": str(library_wav)})
        return self.db.asset(asset_id)

    def _attach_listening_copy(self, asset: dict, library_wav: Path) -> None:
        try:
            report = prepare_listening_copy(library_wav, self.config.library_dir, asset["id"])
        except Exception as exc:
            self.db.add_event(asset["job_id"], "error", f"listening copy skipped: {exc}"[:240])
            return
        self.db.update_asset(asset["id"], **asset_updates(report))
        self.db.add_event(asset["job_id"], "info", report["reason"][:240])

    def _push(self, job: dict, asset: dict) -> dict:
        segments = genre_folder(asset["genre"], asset["type"])
        props = {
            "audio_job_id": job["id"],
            "audio_role": "wav",
            "audio_asset_id": asset["id"],
            "audio_sha256": asset["sha256"],
        }
        audio = self.drive.upload(
            Path(asset["wav_path"]), segments, f"{asset['id']}.wav", props
        )
        meta_props = {**props, "audio_role": "metadata"}
        metadata_path = Path(asset["wav_path"]).with_suffix(".json")
        sidecar = json.loads(metadata_path.read_text(encoding="utf-8"))
        sidecar["drive_file_id"] = audio["id"]
        sidecar["drive_url"] = audio["url"]
        sidecar["drive_folder"] = "/".join(segments)
        metadata_path.write_text(json.dumps(sidecar, indent=2), encoding="utf-8")
        metadata = self.drive.upload(
            metadata_path, segments, f"{asset['id']}.json", meta_props
        )
        if asset.get("mp3_path"):
            self.drive.upload(
                Path(asset["mp3_path"]),
                segments,
                f"{asset['id']}.mp3",
                {**props, "audio_role": "mp3"},
            )
        verified = self.drive.verify(audio["id"])
        if verified["id"] != audio["id"]:
            raise DriveUploadError("verification id mismatch")
        return {
            "audio": audio,
            "metadata": metadata,
            "folder": "/".join(segments),
        }

    def _finish_local(self, job: dict, asset: dict, result: dict) -> None:
        path = Path(asset["wav_path"])
        library = self.config.library_dir.resolve()
        if path.resolve().parent != library:
            raise RuntimeError("refusing to publish audio outside the library")
        if not path.is_file() or path.stat().st_size <= 44:
            raise RuntimeError("local wav is missing or empty")
        digest = sha256_file(path)
        if digest != asset["sha256"]:
            raise RuntimeError("local wav checksum does not match the library record")
        duration = wav_duration(path)
        final = self.db.asset(asset["id"])
        manifest = self._manifest(job, final, result, "local_ready", "disabled")
        manifest["duration_seconds"] = duration
        self.db.mark(
            job["id"],
            state="local_ready",
            asset_id=final["id"],
            result={**result, "wav_path": str(path), "manifest": manifest},
            error=None,
            finished_at=utcnow(),
            provider_cost_usd=0,
        )
        self.db.add_event(job["id"], "info", "local wav verified; drive upload disabled")
        self._cleanup_work(job["id"], keep=path)

    def _manifest(self, job: dict, asset: dict, result: dict, state: str, drive_status: str) -> dict:
        drive_verified = drive_status == "verified"
        return {
            "job_id": job["id"],
            "request_id": job["request_id"],
            "state": state,
            "publishing_authorized": False,
            "production_deliverable": False,
            "experimental": True,
            "narration_mix": "not_applied",
            "stem": "music",
            "asset_id": asset["id"],
            "reuse": {"asset_id": asset["id"], "requires_approval": asset["approval_status"] != "approved"},
            "episode": job["episode"],
            "prompt": job["prompt"],
            "genre": job["genre"],
            "mood": job["mood"],
            "tags": job["tags"],
            "duration_seconds": asset["duration_seconds"],
            "seed": asset["seed"],
            "generator": asset["generator"],
            "model": asset["model"],
            "license": asset["license_note"],
            "approval_status": asset["approval_status"],
            "sha256": asset["sha256"],
            "size_bytes": asset["size_bytes"],
            "listening": {
                "method": "lan-preview",
                "note": "Open the home-network preview. This manifest does not include a file path.",
            },
            "drive": {
                "status": drive_status,
                "file_id": asset["drive_file_id"] if drive_verified else None,
                "url": asset["drive_url"] if drive_verified else None,
                "metadata_file_id": asset["metadata_drive_file_id"] if drive_verified else None,
                "metadata_url": asset["metadata_drive_url"] if drive_verified else None,
                "folder": asset["drive_folder"] if drive_verified else None,
                "verified": drive_verified,
            },
            "metrics": {
                "init_seconds": result.get("init_seconds"),
                "generation_seconds": result.get("generation_seconds"),
                "peak_rss_bytes": result.get("peak_rss_bytes"),
                "provider_cost_usd": 0,
                "provider_cost_basis": "included",
                "electricity_cost_usd": None,
            },
            "finished_at": utcnow(),
        }

    def _cancel(self, job_id: str) -> None:
        self.db.mark(job_id, state="cancelled", finished_at=utcnow(), error=None)
        self.db.add_event(job_id, "info", "cancelled")

    def _cleanup_work(self, job_id: str, keep: Path) -> None:
        work = self.config.work_dir / job_id
        if work.is_dir():
            shutil.rmtree(work, ignore_errors=True)
        if keep.is_file():
            return
