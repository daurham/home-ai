"""Listening-copy and Music Studio interface tests. No model is started."""

from __future__ import annotations

import json
import struct
import threading
import unittest
import urllib.error
import urllib.request
import wave
from pathlib import Path

from audio_studio.api import AudioAPI
from audio_studio.cleanup import detect_trailing_silence, prepare_listening_copy, analyze_wav
from audio_studio.db import Database
from audio_studio.preview import PreviewServer
from test_service import config


def _pcm(path: Path, seconds: float, rate: int = 8000, amplitude: int = 8000, channels: int = 1) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    frames = int(seconds * rate)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(channels)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        chunk = struct.pack("<" + "h" * channels, *([amplitude] * channels))
        handle.writeframes(chunk * frames)


def _silence(path: Path, loud_seconds: float, quiet_seconds: float, rate: int = 8000) -> None:
    frames_loud = int(loud_seconds * rate)
    frames_quiet = int(quiet_seconds * rate)
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(struct.pack("<h", 9000) * frames_loud)
        handle.writeframes(struct.pack("<h", 0) * frames_quiet)


class CleanupTests(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_trailing_silence_becomes_a_separate_file(self):
        source = self.root / "library" / ("ast_" + "ab" * 16 + ".wav")
        asset_id = source.stem
        _silence(source, 2.5, 2.0)
        before = source.read_bytes()
        report = prepare_listening_copy(source, self.root / "library", asset_id)
        self.assertEqual(source.read_bytes(), before)
        self.assertTrue(report["substantial"])
        self.assertTrue(report["trimmed"])
        self.assertGreater(report["silence_start_seconds"], 2.0)
        self.assertAlmostEqual(report["silence_end_seconds"], 4.5, places=2)
        self.assertNotEqual(report["original_sha256"], report["clean_sha256"])
        self.assertLess(report["clean_duration_seconds"], report["original_duration_seconds"])
        clean = self.root / "library" / f"{asset_id}.clean.wav"
        self.assertTrue(clean.is_file())

    def test_internal_rest_and_short_tail_stay(self):
        internal = self.root / "internal.wav"
        _silence(internal, 1.0, 2.0)
        # Add a loud ending after the gap by appending is harder; build explicitly.
        rate = 8000
        with wave.open(str(internal), "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(rate)
            handle.writeframes(struct.pack("<h", 9000) * rate)
            handle.writeframes(struct.pack("<h", 0) * rate * 2)
            handle.writeframes(struct.pack("<h", 9000) * rate)
        decision = detect_trailing_silence(analyze_wav(internal))
        self.assertFalse(decision["substantial"])
        short = self.root / "short.wav"
        _silence(short, 2.5, 0.4)
        decision = detect_trailing_silence(analyze_wav(short))
        self.assertFalse(decision["substantial"])
        self.assertIsNotNone(decision["silence_start"])

    def test_quiet_piece_is_not_treated_as_silence(self):
        quiet = self.root / "quiet.wav"
        _pcm(quiet, 4.0, amplitude=20)
        decision = detect_trailing_silence(analyze_wav(quiet))
        self.assertFalse(decision["substantial"])


class StudioTests(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.cfg = config(self.root)
        self.db = Database(self.cfg.db_path)
        self.api = AudioAPI(self.cfg, self.db)
        self.api_server = self.api.make_server()
        self.api_thread = threading.Thread(target=self.api_server.serve_forever, daemon=True)
        self.api_thread.start()
        self.cfg.api_base = f"http://127.0.0.1:{self.api_server.server_address[1]}"
        self.preview = PreviewServer(self.cfg, self.db).make_server()
        self.preview_thread = threading.Thread(target=self.preview.serve_forever, daemon=True)
        self.preview_thread.start()
        self.base = f"http://127.0.0.1:{self.preview.server_address[1]}"

    def tearDown(self):
        self.preview.shutdown()
        self.preview.server_close()
        self.api_server.shutdown()
        self.api_server.server_close()
        self.tmp.cleanup()

    def _session(self):
        class Jar(urllib.request.HTTPCookieProcessor):
            pass
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor())
        with opener.open(self.base + "/", timeout=5) as response:
            page = response.read().decode()
        cookie = ""
        for header in response.headers.get_all("Set-Cookie") or []:
            if header.startswith("studio_csrf="):
                cookie = header.split(";", 1)[0].split("=", 1)[1]
        self.assertTrue(cookie)
        self.assertNotIn(self.cfg.api_token, page)
        return opener, cookie

    def _post(self, opener, cookie, path, payload, origin=True):
        headers = {"Content-Type": "application/json", "X-CSRF-Token": cookie}
        if origin:
            headers["Origin"] = self.base
        request = urllib.request.Request(
            self.base + path,
            data=json.dumps(payload).encode(),
            headers=headers,
            method="POST",
        )
        return opener.open(request, timeout=5)

    def test_browser_can_queue_without_seeing_the_token(self):
        opener, cookie = self._session()
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self._post(opener, cookie, "/api/jobs", {"prompt": "short"}, origin=False)
        self.assertEqual(caught.exception.code, 403)
        body = {
            "prompt": "Warm analog pads and a slow drum machine",
            "duration_seconds": 30,
            "genre": "ambient",
            "mood": ["calm"],
            "bpm": 90,
            "key_scale": "D minor",
            "time_signature": "4",
            "seed": 95212137,
            "instrumental": True,
        }
        with self._post(opener, cookie, "/api/jobs", body) as response:
            payload = json.loads(response.read().decode())
            self.assertEqual(response.status, 202)
        self.assertEqual(payload["job"]["state"], "queued")
        self.assertNotIn("Target tempo", payload["job"]["prompt"])
        self.assertEqual(payload["job"]["bpm"], 90)
        self.assertEqual(payload["job"]["key_scale"], "D minor")
        self.assertEqual(payload["job"]["time_signature"], "4")
        self.assertEqual(payload["job"]["seed"], 95212137)
        self.assertFalse(payload["job"]["planner"])
        self.assertIn("Instrumental only, no vocals.", payload["job"]["prompt"])
        self.assertNotIn(self.cfg.api_token, json.dumps(payload))
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self._post(opener, cookie, "/api/jobs", body)
        self.assertEqual(caught.exception.code, 409)
        jobs = self.db.list_jobs()
        self.assertEqual(len(jobs), 1)
        with self._post(opener, cookie, f"/api/jobs/{payload['job']['job_id']}/cancel", {}) as response:
            cancelled = json.loads(response.read().decode())
        self.assertEqual(cancelled["job"]["state"], "cancelled")
        reopened = Database(self.cfg.db_path)
        self.assertEqual(reopened.job(payload["job"]["job_id"])["state"], "cancelled")

    def test_library_actions_do_not_replace_audio(self):
        asset_id = "ast_" + "cd" * 16
        wav = self.root / "library" / f"{asset_id}.wav"
        _pcm(wav, 0.2)
        before = wav.read_bytes()
        self.db.insert_asset({
            "id": asset_id,
            "job_id": "job_studio",
            "type": "music",
            "episode": "music-studio",
            "prompt": "library card prompt for the studio test",
            "genre": "ambient",
            "mood": ["calm"],
            "tags": [],
            "duration_seconds": 0.2,
            "seed": 3,
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
        opener, cookie = self._session()
        with opener.open(self.base + "/api/library?q=library+card", timeout=5) as response:
            listed = json.loads(response.read().decode())
        self.assertEqual(listed["assets"][0]["id"], asset_id)
        self.assertNotIn("wav_path", listed["assets"][0])
        with self._post(opener, cookie, f"/api/library/{asset_id}/favorite", {"favorite": True}) as response:
            favored = json.loads(response.read().decode())
        self.assertTrue(favored["asset"]["favorite"])
        with self._post(opener, cookie, f"/api/library/{asset_id}/approval", {"approved": True}) as response:
            approved = json.loads(response.read().decode())
        self.assertEqual(approved["asset"]["approval_status"], "approved")
        with self._post(opener, cookie, "/api/jobs", {"reuse_asset_id": asset_id, "prompt": "ignored"}) as response:
            reused = json.loads(response.read().decode())
        self.assertTrue(reused["job"]["result"]["reused"])
        self.assertEqual(reused["job"]["asset_id"], asset_id)
        self.assertEqual(wav.read_bytes(), before)
        with opener.open(self.base + f"/audio/{asset_id}", timeout=5) as response:
            self.assertEqual(response.read(4), b"RIFF")


if __name__ == "__main__":
    unittest.main()
