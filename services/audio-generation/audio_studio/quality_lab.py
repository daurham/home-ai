"""Fixed, read-only Phase 5 comparisons. No library import and no free paths."""

from __future__ import annotations

import json
from pathlib import Path

_ITEMS = (
    {
        "id": "phase5-a",
        "file": "A-dit.wav",
        "meta": "A-dit.json",
        "title": "A · Turbo baseline",
        "summary": "Current generator. Eight steps, no planner, and no separate tempo or key field.",
    },
    {
        "id": "phase5-b",
        "file": "B-planner.wav",
        "meta": "B-planner.json",
        "title": "B · 0.6B planner",
        "summary": "Same prompt and seed with thinking on. The planner is not available for new tracks.",
    },
    {
        "id": "phase5-c",
        "file": "C-structure.wav",
        "meta": "C-structure.json",
        "title": "C · Tempo, key, and sections",
        "summary": "Same Turbo model with BPM 96, D minor, 4/4, and section tags.",
    },
)
_BY_ID = {item["id"]: item for item in _ITEMS}
_META_KEYS = (
    "prompt",
    "seed_requested",
    "seed_returned",
    "init_seconds",
    "generation_seconds",
    "peak_rss_bytes",
    "swap_growth_bytes",
    "dit_model",
    "planner",
)


def lab_dir(config) -> Path:
    return (Path(config.home) / "data" / "quality-lab" / "phase5").resolve()


def catalog(config) -> list[dict]:
    root = lab_dir(config)
    items = []
    for item in _ITEMS:
        path = _contained(root, item["file"])
        meta = _read_meta(root, item["meta"])
        items.append(
            {
                "id": item["id"],
                "title": item["title"],
                "summary": item["summary"],
                "audio": f"/quality-lab/{item['id']}",
                "available": path is not None,
                "prompt": meta.get("prompt") or "",
                "seed": str(meta.get("seed_returned") or meta.get("seed_requested") or ""),
                "model": meta.get("dit_model") or "acestep-v15-turbo",
                "planner": bool(meta.get("planner")),
                "init_seconds": meta.get("init_seconds"),
                "generation_seconds": meta.get("generation_seconds"),
                "peak_rss_bytes": meta.get("peak_rss_bytes"),
                "swap_growth_bytes": meta.get("swap_growth_bytes"),
                "bpm": (meta.get("metas") or {}).get("bpm"),
                "key_scale": (meta.get("metas") or {}).get("keyscale") or "",
                "time_signature": (meta.get("metas") or {}).get("timesignature") or "",
                "duration_seconds": (meta.get("metas") or {}).get("duration") or 30,
            }
        )
    return items


def lab_audio(config, item_id: str) -> Path | None:
    item = _BY_ID.get(item_id)
    if not item:
        return None
    return _contained(lab_dir(config), item["file"])


def _contained(root: Path, name: str) -> Path | None:
    if "/" in name or "\\" in name or name.startswith("."):
        return None
    path = (root / name).resolve()
    if path.parent != root or not path.is_file():
        return None
    return path


def _read_meta(root: Path, name: str) -> dict:
    path = _contained(root, name)
    if path is None:
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(data, dict):
        return {}
    kept = {key: data.get(key) for key in _META_KEYS}
    metas = data.get("metas") if isinstance(data.get("metas"), dict) else {}
    kept["metas"] = {
        "bpm": metas.get("bpm"),
        "keyscale": metas.get("keyscale") or "",
        "timesignature": metas.get("timesignature") or "",
        "duration": metas.get("duration"),
    }
    return kept
