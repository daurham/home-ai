"""Request validation. Rejects anything that is not a library audio job."""

from __future__ import annotations

import re
from typing import Any

REQUEST_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,80}$")
EPISODE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
ASSET_ID = re.compile(r"^ast_[a-f0-9]{32}$")
GENRES = {"synthwave", "cinematic", "ambient", "other"}


class ValidationError(ValueError):
    def __init__(self, errors: list[str]):
        super().__init__("; ".join(errors))
        self.errors = errors


def _string_list(value: Any, field: str, errors: list[str], limit: int = 8) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > limit:
        errors.append(f"{field} must be a list of at most {limit} strings")
        return []
    out = []
    for item in value:
        if not isinstance(item, str) or not item.strip() or len(item) > 40:
            errors.append(f"{field} entries must be short strings")
            break
        out.append(item.strip().lower())
    return out


def validate_generation_request(body: dict[str, Any], config) -> dict[str, Any]:
    errors: list[str] = []
    if not isinstance(body, dict):
        raise ValidationError(["body must be a JSON object"])
    if body.get("publishing_authorized") is True:
        errors.append("publishing_authorized must not be true")
    request_id = body.get("request_id") or body.get("id")
    if not isinstance(request_id, str) or not REQUEST_ID.match(request_id):
        errors.append("request_id must match ^[a-z0-9][a-z0-9-]{0,80}$")
    kind = body.get("type")
    if kind not in {"music", "sfx"}:
        errors.append("type must be music or sfx")
    episode = body.get("episode") or ""
    if episode and (not isinstance(episode, str) or not EPISODE.match(episode)):
        errors.append("episode must be a lowercase slug")
    reuse = body.get("reuse_asset_id") or ""
    if reuse and (not isinstance(reuse, str) or not ASSET_ID.match(reuse)):
        errors.append("reuse_asset_id is not a library id")
    prompt = body.get("prompt") or ""
    if not isinstance(prompt, str):
        errors.append("prompt must be a string")
        prompt = ""
    if "\x00" in prompt:
        errors.append("prompt contains a null byte")
    if kind == "music" and not reuse and not prompt.strip():
        errors.append("prompt is required for a new music track")
    if len(prompt) > config.max_prompt_chars:
        errors.append("prompt is too long")
    duration = body.get("duration_seconds", 30)
    if isinstance(duration, bool) or not isinstance(duration, (int, float)):
        errors.append("duration_seconds must be a number")
        duration = 0
    elif kind == "music" and not reuse and (
        duration < config.min_duration_seconds or duration > config.max_duration_seconds
    ):
        errors.append(
            f"duration_seconds must be between {config.min_duration_seconds:g} "
            f"and {config.max_duration_seconds:g}"
        )
    variants = body.get("variants", 1)
    if variants != 1:
        errors.append("variants must be 1 in this release")
    genre = (body.get("genre") or "other")
    if not isinstance(genre, str):
        errors.append("genre must be a string")
        genre = "other"
    genre = genre.strip().lower()
    if genre not in GENRES:
        errors.append("genre must be synthwave, cinematic, ambient, or other")
    approval = body.get("approval")
    if kind == "music" and not reuse and approval != "GENERATE_LIBRARY_MUSIC":
        errors.append("approval must be GENERATE_LIBRARY_MUSIC")
    if kind == "sfx" and not reuse:
        errors.append(
            "sfx generation is not installed; import a licensed file or pass reuse_asset_id"
        )
    seed = body.get("seed", None)
    if seed is not None and (isinstance(seed, bool) or not isinstance(seed, int) or seed < 0 or seed > 2**31 - 1):
        errors.append("seed must be a non-negative 31-bit integer or null")
    mood = _string_list(body.get("mood"), "mood", errors)
    tags = _string_list(body.get("tags"), "tags", errors)
    if errors:
        raise ValidationError(errors)
    return {
        "request_id": request_id,
        "type": kind,
        "episode": episode,
        "prompt": prompt.strip(),
        "duration_seconds": float(duration),
        "variants": 1,
        "save_to_library": bool(body.get("save_to_library", True)),
        "genre": genre,
        "mood": mood,
        "tags": tags,
        "seed": seed,
        "reuse_asset_id": reuse,
        "approval": approval if isinstance(approval, str) else "",
        "publishing_authorized": False,
    }


def genre_folder(genre: str, kind: str) -> list[str]:
    if kind == "sfx":
        return ["Everbound Lore", "Audio Library", "Sound Effects"]
    name = {"synthwave": "Synthwave", "cinematic": "Cinematic", "ambient": "Ambient"}.get(
        genre, "Other"
    )
    return ["Everbound Lore", "Audio Library", "Music", name]
