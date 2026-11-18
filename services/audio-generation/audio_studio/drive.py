"""Google Drive uploads. A file counts only after files.get confirms it."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .config import Config


class DriveNotConfigured(RuntimeError):
    pass


class DriveUploadError(RuntimeError):
    pass


class DriveClient:
    def __init__(self, config: Config, service=None):
        self.config = config
        self._service = service
        self._folders: dict[str, str] = {}
        cache = config.home / "data" / "drive_folders.json"
        self._cache_path = cache
        if cache.is_file() and service is None:
            self._folders = json.loads(cache.read_text(encoding="utf-8"))

    @property
    def configured(self) -> bool:
        return self._service is not None or self.config.drive_configured

    def service(self):
        if self._service is not None:
            return self._service
        if not self.config.drive_configured:
            raise DriveNotConfigured(
                "Google Drive is not authorized. Run: audioctl auth-drive"
            )
        from google.auth.transport.requests import Request
        from google.oauth2.credentials import Credentials
        from googleapiclient.discovery import build

        creds = Credentials.from_authorized_user_file(
            str(self.config.google_token_path), [self.config.drive_scope]
        )
        if creds.expired and creds.refresh_token:
            creds.refresh(Request())
            self.config.google_token_path.write_text(creds.to_json(), encoding="utf-8")
            self.config.google_token_path.chmod(0o600)
        self._service = build("drive", "v3", credentials=creds, cache_discovery=False)
        return self._service

    def _save_cache(self) -> None:
        self._cache_path.parent.mkdir(parents=True, exist_ok=True)
        self._cache_path.write_text(json.dumps(self._folders, indent=2), encoding="utf-8")

    def ensure_folder(self, segments: list[str]) -> str:
        parent = self.config.drive_parent_id or "root"
        key_parts: list[str] = []
        for name in segments:
            key_parts.append(name)
            key = "/".join(key_parts)
            if key in self._folders:
                parent = self._folders[key]
                continue
            found = self._find_child(parent, name, folder=True)
            if found:
                parent = found
            else:
                created = self.service().files().create(
                    body={
                        "name": name,
                        "mimeType": "application/vnd.google-apps.folder",
                        "parents": [parent],
                    },
                    fields="id",
                ).execute()
                parent = created["id"]
            self._folders[key] = parent
        self._save_cache()
        return parent

    def _find_child(self, parent: str, name: str, folder: bool) -> str | None:
        safe_name = name.replace("'", "\\'")
        mime = "application/vnd.google-apps.folder"
        clause = f"mimeType = '{mime}'" if folder else f"mimeType != '{mime}'"
        query = (
            f"name = '{safe_name}' and '{parent}' in parents and trashed = false and {clause}"
        )
        listed = self.service().files().list(
            q=query, fields="files(id,name)", pageSize=5, spaces="drive"
        ).execute()
        files = listed.get("files") or []
        return files[0]["id"] if files else None

    def find_by_job(self, job_id: str, suffix: str) -> dict | None:
        if not job_id.replace("_", "").isalnum():
            raise DriveUploadError("unsafe job id")
        query = (
            "appProperties has { key='audio_job_id' and value='%s' } "
            "and appProperties has { key='audio_role' and value='%s' } "
            "and trashed = false" % (job_id, suffix)
        )
        listed = self.service().files().list(
            q=query, fields="files(id,name,size,md5Checksum,webViewLink)", pageSize=5
        ).execute()
        files = listed.get("files") or []
        return files[0] if files else None

    def verify(self, file_id: str) -> dict[str, Any]:
        if not file_id or "/" in file_id or ".." in file_id:
            raise DriveUploadError("unsafe file id")
        meta = self.service().files().get(
            fileId=file_id,
            fields="id,name,size,md5Checksum,mimeType,trashed,webViewLink,parents",
        ).execute()
        if meta.get("trashed"):
            raise DriveUploadError("Drive file is in the trash")
        if not meta.get("id"):
            raise DriveUploadError("Drive file id was not returned")
        return meta

    def upload(self, path: Path, segments: list[str], name: str, properties: dict[str, str]) -> dict:
        existing = self.find_by_job(properties["audio_job_id"], properties["audio_role"])
        if existing:
            verified = self.verify(existing["id"])
            return _public_file(verified)
        folder_id = self.ensure_folder(segments)
        from googleapiclient.http import MediaFileUpload

        media = MediaFileUpload(str(path), resumable=True)
        created = self.service().files().create(
            body={
                "name": name,
                "parents": [folder_id],
                "appProperties": properties,
            },
            media_body=media,
            fields="id,name,size,md5Checksum,webViewLink",
        ).execute()
        verified = self.verify(created["id"])
        if int(verified.get("size") or 0) <= 0:
            raise DriveUploadError("Drive reported an empty file")
        return _public_file(verified)

    def shortcut(self, target_id: str, name: str) -> dict:
        folder_id = self.ensure_folder(
            ["Everbound Lore", "Audio Library", "Approved Favorites"]
        )
        created = self.service().files().create(
            body={
                "name": name,
                "mimeType": "application/vnd.google-apps.shortcut",
                "parents": [folder_id],
                "shortcutDetails": {"targetId": target_id},
            },
            fields="id,webViewLink",
        ).execute()
        verified = self.verify(created["id"])
        return _public_file(verified)


def _public_file(meta: dict) -> dict:
    file_id = meta["id"]
    return {
        "id": file_id,
        "name": meta.get("name", ""),
        "size": int(meta.get("size") or 0),
        "md5": meta.get("md5Checksum"),
        "url": meta.get("webViewLink") or f"https://drive.google.com/file/d/{file_id}/view",
    }


def run_auth_flow(config: Config) -> None:
    if not config.google_client_secrets.is_file():
        raise SystemExit(
            "Missing OAuth client JSON. Create a Desktop client in Google Cloud, "
            f"download it to {config.google_client_secrets}, and rerun auth-drive."
        )
    from google_auth_oauthlib.flow import InstalledAppFlow

    flow = InstalledAppFlow.from_client_secrets_file(
        str(config.google_client_secrets), [config.drive_scope]
    )
    flow.redirect_uri = "http://localhost:8765/"
    url, _ = flow.authorization_url(
        access_type="offline", prompt="consent", include_granted_scopes="true"
    )
    print("Open this URL on a computer where you can sign in to Google:")
    print(url)
    print()
    print("After allowing access, the browser will fail to open localhost.")
    print("Copy the full address-bar URL (it contains ?code=) and paste it here.")
    pasted = input("Redirect URL: ").strip()
    if "code=" in pasted:
        flow.fetch_token(authorization_response=pasted)
    else:
        flow.fetch_token(code=pasted)
    config.google_token_path.parent.mkdir(parents=True, exist_ok=True)
    config.google_token_path.write_text(flow.credentials.to_json(), encoding="utf-8")
    config.google_token_path.chmod(0o600)
    print(f"Saved Drive token to {config.google_token_path}")
