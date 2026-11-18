"""Queue, auth, failure, reuse, and Drive confirmation tests."""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from types import SimpleNamespace

from audio_studio.api import AudioAPI
from audio_studio.bridge import sync_inbox
from audio_studio.db import Database
from audio_studio.drive import DriveClient, DriveUploadError
from audio_studio.github_sync import sync_remote
from audio_studio.media import write_tone
from audio_studio.preview import PreviewServer, local_preview_bind, trusted_preview_client
from audio_studio.worker import Worker


def config(root: Path, **overrides):
    values = dict(
        home=root,
        db_path=root / "audio.sqlite",
        library_dir=root / "library",
        work_dir=root / "work",
        import_dir=root / "import",
        log_dir=root / "logs",
        host="127.0.0.1",
        port=0,
        api_token="test-token",
        max_queue=4,
        max_duration_seconds=180,
        min_duration_seconds=10,
        max_prompt_chars=4000,
        max_body_bytes=65536,
        rate_limit_count=10,
        rate_limit_window_seconds=600,
        max_generation_attempts=2,
        max_upload_attempts=3,
        min_free_bytes=1,
        backend="fake",
        acestep_root=root,
        acestep_python=root / "missing-python",
        acestep_host="127.0.0.1",
        acestep_port=8001,
        acestep_api_key="",
        model_name="acestep-v15-turbo",
        inference_steps=8,
        generation_timeout_seconds=30,
        init_timeout_seconds=30,
        worker_poll_seconds=0.01,
        google_client_secrets=root / "missing-client.json",
        google_token_path=root / "missing-token.json",
        drive_parent_id="",
        drive_scope="https://www.googleapis.com/auth/drive.file",
        studio_root=root / "studio",
        sync_root=root / "sync",
        github_branch="audio-test",
        github_remote_url="",
        github_push=False,
        bridge_poll_seconds=1,
        drive_enabled=False,
        preview_bind="127.0.0.1",
        preview_port=0,
        ffmpeg="",
        drive_configured=False,
    )
    values.update(overrides)
    for name in ("library_dir", "work_dir", "import_dir", "log_dir"):
        Path(values[name]).mkdir(parents=True, exist_ok=True)
    return SimpleNamespace(**values)


def music(**overrides):
    body = {
        "request_id": "vice-city-theme-1",
        "type": "music",
        "episode": "vice-city",
        "prompt": "Dark 1980s Miami synthwave, instrumental only, no vocals",
        "duration_seconds": 30,
        "variants": 1,
        "genre": "synthwave",
        "mood": ["dark"],
        "tags": ["miami"],
        "approval": "GENERATE_LIBRARY_MUSIC",
        "save_to_library": True,
        "publishing_authorized": False,
    }
    body.update(overrides)
    return body


class Request:
    def __init__(self, payload=None, token="test-token"):
        raw = b"" if payload is None else json.dumps(payload).encode()
        self.rfile = SimpleNamespace(read=lambda _n: raw)
        self.headers = {
            "Content-Length": str(len(raw)),
            "Authorization": f"Bearer {token}",
        }


class FakeDrive:
    def __init__(self):
        self.configured = True
        self.uploads = 0
        self.failures_left = 0
        self.files = {}

    def upload(self, path, segments, name, properties):
        self.uploads += 1
        if self.failures_left:
            self.failures_left -= 1
            raise DriveUploadError("transient upload failure")
        file_id = "drv_" + properties["audio_role"] + "_" + properties["audio_job_id"][-6:]
        self.files[file_id] = path.read_bytes()
        return {
            "id": file_id,
            "name": name,
            "size": path.stat().st_size,
            "url": f"https://drive.google.com/file/d/{file_id}/view",
        }

    def verify(self, file_id):
        if file_id not in self.files or not self.files[file_id]:
            raise DriveUploadError("Drive file was not confirmed")
        return {"id": file_id, "size": len(self.files[file_id]), "trashed": False}


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.cfg = config(self.root)
        self.db = Database(self.cfg.db_path)
        self.api = AudioAPI(self.cfg, self.db)
        self.drive = FakeDrive()
        self.worker = Worker(self.cfg, self.db, drive=self.drive)

    def tearDown(self):
        self.tmp.cleanup()

    def test_auth_validation_idempotency_and_rate_limit(self):
        status, payload = self.api.handle("GET", "/v1/health", {}, Request())
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        status, payload = self.api.handle("POST", "/v1/jobs", {}, Request(music(), token="nope"))
        self.assertEqual(status, 401)
        status, payload = self.api.handle(
            "POST", "/v1/jobs", {}, Request(music(publishing_authorized=True))
        )
        self.assertEqual(status, 400)
        status, payload = self.api.handle(
            "POST", "/v1/jobs", {}, Request(music(type="sfx", approval=""))
        )
        self.assertEqual(status, 400)
        status, first = self.api.handle("POST", "/v1/jobs", {}, Request(music()))
        self.assertEqual(status, 202)
        self.assertEqual(first["job"]["state"], "queued")
        status, second = self.api.handle("POST", "/v1/jobs", {}, Request(music()))
        self.assertEqual(status, 200)
        self.assertEqual(first["job"]["job_id"], second["job"]["job_id"])
        self.cfg.rate_limit_count = 2
        limited = AudioAPI(self.cfg, Database(self.root / "rate.sqlite"))
        self.assertEqual(limited.handle("POST", "/v1/jobs", {}, Request(music(request_id="rate-one")))[0], 202)
        self.assertEqual(limited.handle("POST", "/v1/jobs", {}, Request(music(request_id="rate-two")))[0], 202)
        self.assertEqual(limited.handle("POST", "/v1/jobs", {}, Request(music(request_id="rate-three")))[0], 429)

    def test_worker_persists_restarts_and_does_not_repeat_generation(self):
        self.cfg.drive_enabled = True
        self.api.handle("POST", "/v1/jobs", {}, Request(music()))
        self.drive.failures_left = 1
        self.assertTrue(self.worker.run_once())
        job = self.db.list_jobs()[0]
        self.assertEqual(job["state"], "uploading")
        self.assertEqual(job["attempts"], 1)
        self.assertTrue(self.worker.run_once())
        job = self.db.job(job["id"])
        self.assertEqual(job["state"], "completed")
        self.assertEqual(job["attempts"], 1)
        self.assertEqual(self.drive.uploads, 4 if self.worker.ffmpeg else 3)
        manifest = job["result"]["manifest"]
        self.assertTrue(manifest["drive"]["verified"])
        self.assertEqual(manifest["provider_cost_usd"] if "provider_cost_usd" in manifest else manifest["metrics"]["provider_cost_usd"], 0)
        self.assertTrue(manifest["drive"]["url"].startswith("https://drive.google.com/file/d/"))
        asset_id = job["asset_id"]
        reopened = Database(self.cfg.db_path)
        self.assertEqual(reopened.job(job["id"])["state"], "completed")
        self.assertEqual(reopened.asset(asset_id)["sha256"], self.db.asset(asset_id)["sha256"])
        found = reopened.search_assets(query="miami", genre="synthwave")
        self.assertEqual(found[0]["id"], asset_id)
        self.assertEqual(reopened.search_assets(query="miami", approved_only=True), [])
        approved = reopened.set_approval(asset_id, True)
        self.assertEqual(approved["approval_status"], "approved")
        self.assertEqual(reopened.search_assets(episode="vice-city", approved_only=True)[0]["id"], asset_id)
        status, reused = self.api.handle(
            "POST", "/v1/jobs", {}, Request(music(request_id="vice-city-reuse-1", reuse_asset_id=asset_id))
        )
        self.assertEqual(status, 200)
        self.assertEqual(reused["job"]["state"], "completed")
        self.assertEqual(reused["job"]["asset_id"], asset_id)
        self.assertEqual(reopened.job(reused["job"]["job_id"])["attempts"], 0)

    def test_cancel_queue_and_interrupted_generation_recovery(self):
        status, created = self.api.handle("POST", "/v1/jobs", {}, Request(music(request_id="cancel-me")))
        self.assertEqual(self.api.handle("POST", f"/v1/jobs/{created['job']['job_id']}/cancel", {}, Request({}))[0], 200)
        self.worker.run_once()
        self.assertEqual(self.db.job(created["job"]["job_id"])["state"], "cancelled")
        self.assertEqual(self.drive.uploads, 0)
        kept = self.root / "library" / "partial.wav"
        write_tone(kept, 0.2)
        job = self.db.insert_job(music(request_id="interrupted-upload"))
        self.db.mark(job["id"], state="running", result={"wav_path": str(kept)})
        notes = Database(self.cfg.db_path).recover(2)
        self.assertIn("resumed upload", notes[0])
        self.assertEqual(Database(self.cfg.db_path).job(job["id"])["state"], "uploading")
        bare = self.db.insert_job(music(request_id="interrupted-retry"))
        self.db.mark(bare["id"], state="running", result={})
        with self.db.connect() as conn:
            conn.execute("UPDATE jobs SET attempts=2 WHERE id=?", (bare["id"],))
        Database(self.cfg.db_path).recover(2)
        self.assertEqual(Database(self.cfg.db_path).job(bare["id"])["state"], "failed")

    def test_drive_confirmation_is_required(self):
        class Service:
            def __init__(self):
                self.files_api = Files()

            def files(self):
                return self.files_api

        class Files:
            def __init__(self):
                self.stored = {}

            def list(self, **_kwargs):
                return Exec({"files": []})

            def create(self, body=None, media_body=None, fields=None):
                file_id = f"file{len(self.stored) + 1}"
                meta = {
                    "id": file_id,
                    "name": body["name"],
                    "size": "4",
                    "trashed": True,
                    "webViewLink": f"https://drive.google.com/file/d/{file_id}/view",
                }
                self.stored[file_id] = meta
                return Exec(meta)

            def get(self, fileId=None, fields=None):
                return Exec(self.stored[fileId])

        class Exec:
            def __init__(self, payload):
                self.payload = payload

            def execute(self):
                return self.payload

        wav = self.root / "tone.wav"
        write_tone(wav, 0.2)
        client = DriveClient(self.cfg, service=Service())
        with self.assertRaises(DriveUploadError):
            client.upload(wav, ["Everbound Lore", "Audio Library", "Music", "Other"], "tone.wav", {
                "audio_job_id": "job_abc123",
                "audio_role": "wav",
                "audio_asset_id": "ast_123",
                "audio_sha256": "abc",
            })

    def test_bridge_returns_job_id_without_waiting(self):
        server = self.api.make_server()
        self.cfg.port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        inbox = self.root / "inbox"
        inbox.mkdir()
        (inbox / "vice-city-bridge-1.json").write_text(json.dumps(music(request_id="vice-city-bridge-1")), encoding="utf-8")
        try:
            notes = sync_inbox(self.cfg, inbox, self.root / "results", self.root / "accepted")
        finally:
            server.shutdown()
            server.server_close()
        self.assertEqual(notes, ["vice-city-bridge-1"])
        result = json.loads((self.root / "results" / "vice-city-bridge-1.json").read_text())
        self.assertEqual(result["state"], "queued")
        self.assertTrue(result["job_id"].startswith("job_"))
        self.assertFalse(result["publishing_authorized"])
        self.assertTrue((self.root / "accepted" / "vice-city-bridge-1.json").is_file())

    def test_local_wav_completes_without_drive(self):
        self.api.handle("POST", "/v1/jobs", {}, Request(music(request_id="local-only-1")))
        self.assertTrue(self.worker.run_once())
        job = self.db.list_jobs()[0]
        self.assertEqual(job["state"], "local_ready")
        self.assertEqual(job["attempts"], 1)
        self.assertEqual(self.drive.uploads, 0)
        manifest = job["result"]["manifest"]
        self.assertEqual(manifest["drive"]["status"], "disabled")
        self.assertFalse(manifest["drive"]["verified"])
        self.assertIsNone(manifest["drive"]["url"])
        self.assertFalse(manifest["production_deliverable"])
        self.assertNotIn("wav_path", manifest)
        wav = self.root / "library" / f"{job['asset_id']}.wav"
        self.assertTrue(wav.is_file())
        self.assertFalse(self.worker.run_once())
        self.assertEqual(self.db.job(job["id"])["attempts"], 1)
        reopened = Database(self.cfg.db_path)
        self.assertEqual(reopened.job(job["id"])["state"], "local_ready")
        self.assertEqual(reopened.search_assets(query="miami")[0]["id"], job["asset_id"])

    def test_remote_bridge_publishes_json_once(self):
        bare = self.root / "origin.git"
        seed = self.root / "seed"
        _git(self.root, "init", "--bare", str(bare))
        _git(self.root, "init", str(seed))
        _git(seed, "checkout", "-b", "audio-test")
        _git(seed, "remote", "add", "origin", str(bare))
        inbox = seed / "audio-requests" / "inbox"
        inbox.mkdir(parents=True)
        (seed / "audio-results").mkdir()
        (inbox / "bridge-remote-1.json").write_text(
            json.dumps(music(request_id="bridge-remote-1")), encoding="utf-8"
        )
        _git(seed, "add", "audio-requests", "audio-results")
        _git(seed, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "request")
        _git(seed, "push", "-u", "origin", "HEAD")
        self.cfg.github_remote_url = str(bare)
        self.cfg.github_push = True
        self.cfg.github_branch = "audio-test"
        server = self.api.make_server()
        self.cfg.port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            sync_remote(self.cfg)
            self.assertTrue(self.worker.run_once())
            sync_remote(self.cfg)
            _git(seed, "pull", "--rebase")
            result = json.loads((seed / "audio-results" / "bridge-remote-1.json").read_text())
            self.assertEqual(result["state"], "local_ready")
            self.assertEqual(result["drive"]["status"], "disabled")
            self.assertFalse(result["drive"]["verified"])
            self.assertNotIn("wav_path", result)
            text = (seed / "audio-results" / "bridge-remote-1.json").read_text()
            self.assertNotIn("/home/", text)
            self.assertNotIn(self.cfg.api_token, text)
            job_id = result["job_id"]
            accepted = seed / "audio-requests" / "accepted" / "bridge-remote-1.json"
            inbox.mkdir(exist_ok=True)
            (inbox / "bridge-remote-1.json").write_text(accepted.read_text(), encoding="utf-8")
            _git(seed, "add", "audio-requests/inbox/bridge-remote-1.json")
            _git(seed, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "repeat")
            _git(seed, "push")
            sync_remote(self.cfg)
        finally:
            server.shutdown()
            server.server_close()
        jobs = [job for job in self.db.list_jobs(limit=20) if job["request_id"] == "bridge-remote-1"]
        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0]["id"], job_id)
        self.assertEqual(jobs[0]["attempts"], 1)
        self.assertEqual(jobs[0]["state"], "local_ready")

    def test_preview_opens_without_a_password(self):
        asset_id = "ast_" + "ab" * 16
        wav = self.root / "library" / f"{asset_id}.wav"
        write_tone(wav, 0.2)
        self.db.insert_asset({
            "id": asset_id,
            "job_id": "job_preview",
            "type": "music",
            "episode": "vice-city",
            "prompt": "preview tone",
            "genre": "ambient",
            "mood": [],
            "tags": ["preview"],
            "duration_seconds": 0.2,
            "seed": 1,
            "generator": "fake",
            "model": "tone",
            "license_note": "test",
            "approval_status": "pending",
            "wav_path": str(wav),
            "mp3_path": None,
            "sha256": "abc",
            "size_bytes": wav.stat().st_size,
            "created_at": "2026-11-18T00:00:00+00:00",
        })
        server = PreviewServer(self.cfg, self.db).make_server()
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_address[1]}"
        try:
            with urllib.request.urlopen(base + "/", timeout=5) as response:
                page = response.read().decode()
                self.assertEqual(response.status, 200)
            self.assertIn("Home AI Music Studio", page)
            self.assertNotIn("password", page.lower())
            self.assertNotIn("/login", page)
            self.assertNotIn(self.cfg.api_token, page)
            with urllib.request.urlopen(base + f"/audio/{asset_id}", timeout=5) as response:
                header = response.read(12)
                self.assertEqual(response.status, 200)
                self.assertEqual(response.headers.get("Set-Cookie"), None)
            self.assertEqual(header[:4], b"RIFF")
            with self.assertRaises(urllib.error.HTTPError) as caught:
                urllib.request.urlopen(base + "/audio/../../etc/passwd", timeout=5)
            self.assertEqual(caught.exception.code, 404)
            with self.assertRaises(urllib.error.HTTPError) as caught:
                urllib.request.urlopen(urllib.request.Request(base + "/v1/jobs", method="POST"), timeout=5)
            self.assertEqual(caught.exception.code, 405)
            denied = _FakeRequest("8.8.8.8", "/")
            PreviewServer(self.cfg, self.db)._handle(denied, "GET")
            self.assertEqual(denied.status, 403)
        finally:
            server.shutdown()
            server.server_close()

    def test_preview_accepts_only_local_clients(self):
        self.assertTrue(trusted_preview_client("127.0.0.1"))
        self.assertTrue(trusted_preview_client("192.168.1.20"))
        self.assertTrue(trusted_preview_client("::ffff:192.168.1.20"))
        self.assertTrue(trusted_preview_client("10.1.2.3"))
        self.assertTrue(trusted_preview_client("172.16.5.5"))
        self.assertFalse(trusted_preview_client("8.8.8.8"))
        self.assertFalse(trusted_preview_client("203.0.113.8"))
        self.assertFalse(trusted_preview_client("not-an-ip"))
        self.assertTrue(local_preview_bind("0.0.0.0"))
        self.assertTrue(local_preview_bind("192.168.1.161"))
        self.assertFalse(local_preview_bind("203.0.113.8"))


class _FakeRequest:
    def __init__(self, address: str, path: str):
        self.client_address = (address, 9)
        self.path = path
        self.headers = {}
        self.status = None
        self._body = bytearray()
        self.wfile = self

    def send_response(self, status: int) -> None:
        self.status = status

    def send_header(self, name: str, value: str) -> None:
        return

    def end_headers(self) -> None:
        return

    def write(self, data: bytes) -> None:
        self._body.extend(data)


def _git(cwd: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=str(cwd), check=True, capture_output=True, text=True)


if __name__ == "__main__":
    unittest.main()
