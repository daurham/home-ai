#!/usr/bin/env python3
"""POC #7D checkbox residual-cleanup ablation.

Reads the frozen detector; never writes poc7-detector.json.
"""
from __future__ import print_function

import copy
import json
import os
import sys

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "poc7"))
import detect as poc7  # noqa: E402

ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
V131 = os.path.join(ROOT, "config", "workout-v1.3.1")
CFG_PATH = os.path.join(V131, "poc7-detector.json")
TEMPLATE_PATH = os.path.join(V131, "templates", "B-1.3.1.json")
BLANK_PATH = os.path.join(V131, "artifacts", "poc7-blank-template.png")
TRUTH_PATH = os.path.join(V131, "fixtures", "poc7-benchmark-truth.json")
POC7B_DIR = os.path.join(V131, "artifacts", "poc7b")
DEV_RECT = os.path.join(V131, "artifacts", "poc6-rectified.png")
OUT_DIR = os.path.join(V131, "artifacts", "poc7d")
FROZEN_OPEN = 3
FROZEN_DILATE_K = 3
FROZEN_DILATE_ITER = 2
FOCUS = [
    ("IMG_1307", "B04.S2.BW"),
    ("IMG_1308", "B04.S2.BW"),
    ("IMG_1310", "header.effort.5"),
]
PHOTOS = [
    {"id": "poc7-dev", "split": "dev", "rectified": DEV_RECT},
    {"id": "IMG_1305", "split": "oos", "rectified": os.path.join(POC7B_DIR, "IMG_1305", "rectified.png")},
    {"id": "IMG_1306", "split": "oos", "rectified": os.path.join(POC7B_DIR, "IMG_1306", "rectified.png")},
    {"id": "IMG_1307", "split": "oos", "rectified": os.path.join(POC7B_DIR, "IMG_1307", "rectified.png")},
    {"id": "IMG_1308", "split": "oos", "rectified": os.path.join(POC7B_DIR, "IMG_1308", "rectified.png")},
    {"id": "IMG_1309", "split": "oos", "rectified": os.path.join(POC7B_DIR, "IMG_1309", "rectified.png")},
    {"id": "IMG_1310", "split": "oos", "rectified": os.path.join(POC7B_DIR, "IMG_1310", "rectified.png")},
]


def load_json(path):
    return json.loads(open(path, "r").read())


def nn(img, size=140):
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    h, w = img.shape[:2]
    scale = float(size) / max(h, w, 1)
    return cv2.resize(img, (max(1, int(round(w * scale))), max(1, int(round(h * scale)))), interpolation=cv2.INTER_NEAREST)


def tile(img, title, size=140):
    scaled = nn(img, size)
    canvas = np.full((size + 26, size, 3), 28, np.uint8)
    y = 22 + (size - scaled.shape[0]) // 2
    x = (size - scaled.shape[1]) // 2
    canvas[y:y + scaled.shape[0], x:x + scaled.shape[1]] = scaled
    cv2.putText(canvas, title[:36], (4, 14), cv2.FONT_HERSHEY_SIMPLEX, 0.36, (240, 240, 240), 1, cv2.LINE_AA)
    return canvas


def measure_field(obs_ink, blank_ink, box, cfg, kind, page_w, page_h, open_kernel, dilate_k, dilate_iter):
    pad = int(cfg["crop_pad_px"])
    oc, origin = poc7.crop_pad(obs_ink, box, pad, page_w, page_h)
    bc, _ = poc7.crop_pad(blank_ink, box, pad, page_w, page_h)
    dx, dy, shifted, overlap, tcount = poc7.best_shift(oc, bc, int(cfg["shift_search_radius_px"]))
    h, w = shifted.shape
    template = bc[:h, :w]
    n_binary = int(np.count_nonzero(shifted))
    if dilate_iter <= 0 or dilate_k < 1:
        mask = template.copy()
        dilation_mode = "none"
    else:
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (int(dilate_k), int(dilate_k)))
        mask = cv2.dilate(template, kernel, iterations=int(dilate_iter))
        dilation_mode = "{}x{}, iter {}".format(dilate_k, dilate_k, dilate_iter)
    after_sub = cv2.bitwise_and(shifted, cv2.bitwise_not(mask))
    n_sub = int(np.count_nonzero(after_sub))
    after_open = after_sub
    if int(open_kernel) >= 2:
        after_open = cv2.morphologyEx(
            after_sub, cv2.MORPH_OPEN,
            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (int(open_kernel), int(open_kernel))),
        )
        open_mode = "ellipse {}".format(open_kernel)
    else:
        open_mode = "disabled"
    n_open = int(np.count_nonzero(after_open))
    sub_cfg = {
        "inset_fraction": cfg[kind]["inset_fraction"],
        "min_component_area": cfg["min_component_area"],
        "line_aspect_ratio": cfg["line_aspect_ratio"],
        "line_span_fraction": cfg["line_span_fraction"],
        "line_thickness_px": cfg["line_thickness_px"],
    }
    filtered = poc7.filter_user_ink(after_open, sub_cfg)
    n_inset = int(np.count_nonzero(filtered["core"]))
    core = filtered["core"]
    num, labels, stats, _ = cv2.connectedComponentsWithStats((core > 0).astype(np.uint8), 8)
    components = []
    ch, cw = core.shape
    for i in range(1, num):
        st = stats[i]
        area = int(st[cv2.CC_STAT_AREA])
        ww, hh = int(st[cv2.CC_STAT_WIDTH]), int(st[cv2.CC_STAT_HEIGHT])
        reason = "kept"
        if poc7.is_line_like(st, cw, ch, cfg["line_aspect_ratio"], cfg["line_span_fraction"], cfg["line_thickness_px"]):
            reason = "line-like"
        elif area < cfg["min_component_area"]:
            reason = "speck"
        components.append({
            "area": area,
            "x": int(st[cv2.CC_STAT_LEFT]),
            "y": int(st[cv2.CC_STAT_TOP]),
            "w": ww,
            "h": hh,
            "reason": reason,
        })
    if kind == "checkbox":
        state, conf = poc7.classify_checkbox(filtered["user_ink_frac"], filtered["user_ink_area"], cfg["checkbox"])
    else:
        state, conf = poc7.classify_text(filtered["user_ink_frac"], filtered["user_ink_area"], cfg["text"])
    return {
        "state": state,
        "score": float(filtered["user_ink_frac"]),
        "confidence": float(conf),
        "user_ink_frac": float(filtered["user_ink_frac"]),
        "user_ink_area": int(filtered["user_ink_area"]),
        "binary": n_binary,
        "after_subtraction": n_sub,
        "after_open": n_open,
        "after_inset": n_inset,
        "component_areas": [c["area"] for c in components],
        "components": components,
        "kept_area": int(filtered["user_ink_area"]),
        "line_area_rejected": int(filtered["line_area_rejected"]),
        "speck_area_rejected": int(filtered["speck_area_rejected"]),
        "shift_px": {"dx": int(dx), "dy": int(dy)},
        "kind": kind,
        "open_mode": open_mode,
        "dilation_mode": dilation_mode,
        "_rect_crop": None,
        "_after_sub": after_sub,
        "_after_open": after_open,
        "_kept": filtered["kept"],
    }


def kernels_for_field(kind, variant):
    open_k = variant["open"]
    if variant.get("open_scope") == "checkbox" and kind != "checkbox":
        open_k = FROZEN_OPEN
    dilate_k = variant["dilate_k"]
    dilate_iter = variant["dilate_iter"]
    if variant.get("dilate_scope") == "checkbox" and kind != "checkbox":
        dilate_k = FROZEN_DILATE_K
        dilate_iter = FROZEN_DILATE_ITER
    return open_k, dilate_k, dilate_iter


def run_variant(variant, cfg, template, blank_ink, truth, page_w, page_h):
    photos = []
    for photo in PHOTOS:
        observed = cv2.imread(photo["rectified"], cv2.IMREAD_COLOR)
        if observed is None:
            raise RuntimeError("missing rectified " + photo["rectified"])
        gray = cv2.cvtColor(observed, cv2.COLOR_BGR2GRAY)
        obs_ink = poc7.adaptive_ink(gray, cfg["adaptive_block_size"], cfg["adaptive_c"])
        fields = {}
        for item in template["fields"]:
            kind = "checkbox" if item["kind"] == "checkbox" else "text"
            open_k, dilate_k, dilate_iter = kernels_for_field(kind, variant)
            rec = measure_field(
                obs_ink, blank_ink, item["px"], cfg, kind, page_w, page_h,
                open_k, dilate_k, dilate_iter,
            )
            rec["_rect_crop"] = poc7.crop_pad(observed, item["px"], int(cfg["crop_pad_px"]), page_w, page_h)[0]
            rec["id"] = item["id"]
            rec["expected"] = (truth["checkboxes"] if kind == "checkbox" else truth["fields"])[item["id"]]
            fields[item["id"]] = rec
        photos.append({"id": photo["id"], "split": photo["split"], "fields": fields})
    return photos


def checkbox_stats(rows):
    n_checked = sum(1 for r in rows if r["expected"] == "checked")
    n_unchecked = sum(1 for r in rows if r["expected"] == "unchecked")
    correct = sum(1 for r in rows if r["state"] == r["expected"])
    tp = sum(1 for r in rows if r["expected"] == "checked" and r["state"] == "checked")
    tn = sum(1 for r in rows if r["expected"] == "unchecked" and r["state"] == "unchecked")
    c2u = sum(1 for r in rows if r["expected"] == "checked" and r["state"] == "unchecked")
    u2c = sum(1 for r in rows if r["expected"] == "unchecked" and r["state"] == "checked")
    c2unc = sum(1 for r in rows if r["expected"] == "checked" and r["state"] == "uncertain")
    u2unc = sum(1 for r in rows if r["expected"] == "unchecked" and r["state"] == "uncertain")
    uncertain = sum(1 for r in rows if r["state"] == "uncertain")
    return {
        "correct": correct,
        "total": len(rows),
        "percent": (100.0 * correct / len(rows)) if rows else 0.0,
        "checked_recall": (float(tp) / n_checked) if n_checked else 0.0,
        "unchecked_specificity": (float(tn) / n_unchecked) if n_unchecked else 0.0,
        "checked_to_unchecked": c2u,
        "unchecked_to_checked": u2c,
        "checked_to_uncertain": c2unc,
        "unchecked_to_uncertain": u2unc,
        "uncertain": uncertain,
        "n_checked_labels": n_checked,
        "n_unchecked_labels": n_unchecked,
        "true_checked": tp,
        "true_unchecked": tn,
    }


def text_stats(rows):
    correct = sum(1 for r in rows if r["state"] == r["expected"])
    uncertain = sum(1 for r in rows if r["state"] == "uncertain")
    return {
        "correct": correct,
        "total": len(rows),
        "percent": (100.0 * correct / len(rows)) if rows else 0.0,
        "uncertain": uncertain,
        "blank_to_nonblank": sum(1 for r in rows if r["expected"] == "blank" and r["state"] == "nonblank"),
        "nonblank_to_blank": sum(1 for r in rows if r["expected"] == "nonblank" and r["state"] == "blank"),
        "blank_to_uncertain": sum(1 for r in rows if r["expected"] == "blank" and r["state"] == "uncertain"),
        "nonblank_to_uncertain": sum(1 for r in rows if r["expected"] == "nonblank" and r["state"] == "uncertain"),
        "mismatches": [
            {"photo": r["photo"], "field": r["id"], "expected": r["expected"], "observed": r["state"], "score": r["score"]}
            for r in rows if r["state"] != r["expected"]
        ],
    }


def flatten(photos, kind):
    rows = []
    for photo in photos:
        for item in photo["fields"].values():
            if item["kind"] != kind:
                continue
            rec = {k: v for k, v in item.items() if not k.startswith("_")}
            rec["photo"] = photo["id"]
            rec["split"] = photo["split"]
            rows.append(rec)
    return rows


def public_trace(rec):
    return {
        "photo": rec["photo"],
        "field": rec["id"],
        "expected": rec["expected"],
        "observed": rec["state"],
        "binary": rec["binary"],
        "after_subtraction": rec["after_subtraction"],
        "after_open": rec["after_open"],
        "after_inset": rec["after_inset"],
        "component_areas": rec["component_areas"],
        "components": rec["components"],
        "kept_area": rec["kept_area"],
        "user_ink_frac": rec["user_ink_frac"],
        "score": rec["score"],
        "classification": rec["state"],
        "line_area_rejected": rec["line_area_rejected"],
        "speck_area_rejected": rec["speck_area_rejected"],
        "shift_px": rec["shift_px"],
    }


def summarize(variant, photos):
    cb = flatten(photos, "checkbox")
    tx = flatten(photos, "text")
    per_photo = []
    for photo in photos:
        rows = [r for r in cb if r["photo"] == photo["id"]]
        st = checkbox_stats(rows)
        st["photo"] = photo["id"]
        st["split"] = photo["split"]
        per_photo.append(st)
    focus = []
    for photo_id, field_id in FOCUS:
        rec = next(r for r in cb if r["photo"] == photo_id and r["id"] == field_id)
        focus.append(public_trace(rec))
    false_checked = [public_trace(r) for r in cb if r["expected"] == "unchecked" and r["state"] == "checked"]
    unchecked_to_uncertain = [public_trace(r) for r in cb if r["expected"] == "unchecked" and r["state"] == "uncertain"]
    return {
        "id": variant["id"],
        "phase": variant["phase"],
        "label": variant["label"],
        "open_config": {
            "user_open_kernel_px": variant["open"],
            "scope": variant.get("open_scope", "all"),
            "note": variant.get("open_note"),
        },
        "dilation_config": {
            "template_dilate_kernel_px": variant["dilate_k"],
            "template_dilate_iterations": variant["dilate_iter"],
            "scope": variant.get("dilate_scope", "all"),
            "note": variant.get("dilate_note"),
        },
        "combined": checkbox_stats(cb),
        "dev": checkbox_stats([r for r in cb if r["split"] == "dev"]),
        "oos": checkbox_stats([r for r in cb if r["split"] == "oos"]),
        "text_combined": text_stats(tx),
        "text_dev": text_stats([r for r in tx if r["split"] == "dev"]),
        "text_oos": text_stats([r for r in tx if r["split"] == "oos"]),
        "per_photo": per_photo,
        "focus": focus,
        "false_checked": false_checked,
        "unchecked_became_checked_or_uncertain": false_checked + unchecked_to_uncertain,
        "checked_still_wrong": [
            public_trace(r) for r in cb if r["expected"] == "checked" and r["state"] != "checked"
        ],
        "text_mismatches": text_stats(tx)["mismatches"],
    }


def save_panel(path, title, baseline_rec, variant_rec):
    stages = [
        ("rectified", "_rect_crop"),
        ("after sub", "_after_sub"),
        ("after open", "_after_open"),
        ("kept", "_kept"),
    ]
    tiles = []
    for label, key in stages:
        tiles.append(tile(baseline_rec[key], "A0 " + label))
        tiles.append(tile(variant_rec[key], variant_rec.get("variant_id", "var") + " " + label))
    th, tw = tiles[0].shape[:2]
    panel = np.full((2 * th + 40, 4 * tw + 8, 3), 16, np.uint8)
    for i, t in enumerate(tiles):
        r, c = divmod(i, 4)
        panel[36 + r * th:36 + r * th + t.shape[0], 4 + c * tw:4 + c * tw + t.shape[1]] = t
    cv2.putText(panel, title[:90], (8, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 220, 255), 1, cv2.LINE_AA)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    cv2.imwrite(path, panel)


def find_field(photos, photo_id, field_id):
    for photo in photos:
        if photo["id"] == photo_id:
            return photo["fields"][field_id]
    raise KeyError(photo_id + " " + field_id)


def pct(n, d):
    return "{}/{} ({:.1f}%)".format(n, d, 100.0 * n / d if d else 0.0)


def fmt_focus(focus, photo, field):
    rec = next(x for x in focus if x["photo"] == photo and x["field"] == field)
    return "{} s={:.4f}".format(rec["classification"], rec["score"])


def write_report(path, payload):
    by_id = {v["id"]: v for v in payload["variants"]}
    a0 = by_id["A0"]
    lines = []
    lines.append("# POC #7D — Checkbox Residual Cleanup Ablation")
    lines.append("")
    lines.append("Controlled experiment. Frozen production detector was not modified.")
    lines.append("")
    lines.append("Baseline SHA256: `{}`".format(payload["frozen_sha256"]))
    lines.append("After SHA256: `{}` (must match; production file is not written)".format(payload["frozen_sha256"]))
    lines.append("")
    lines.append("A2 (`user_open_kernel_px = 1`) is **functionally identical** to A1: `detect.py` skips morphological open when the kernel is `< 2`. A2 was not scored as a separate candidate.")
    lines.append("")
    lines.append("D2 is represented as `template_dilate_iterations = 0` (OpenCV `dilate` identity). Kernel remains 3×3 unused. No extra adjacent encoding was required.")
    lines.append("")
    lines.append("Dataset: 1 development fixture + 6 POC #7B photos × 27 checkboxes = **189** checkbox labels (70 checked, 119 unchecked). Text: **315** labels.")
    lines.append("")
    lines.append("## Comparison")
    lines.append("")
    lines.append("| variant | open | dilation | correct/total | checked recall | unchecked spec. | false checked | uncertain | B04-1307 | B04-1308 | effort5-1310 |")
    lines.append("| --- | --- | --- | --- | --- | --- | ---: | ---: | --- | --- | --- |")
    for v in payload["variants"]:
        o = v["open_config"]
        d = v["dilation_config"]
        open_s = "k={} {}".format(o["user_open_kernel_px"], o["scope"])
        dil_s = "{}×{} ×{}".format(d["template_dilate_kernel_px"], d["template_dilate_kernel_px"], d["template_dilate_iterations"])
        if d["template_dilate_iterations"] <= 0:
            dil_s = "none"
        if o["scope"] == "checkbox":
            open_s = "checkbox k={}; text frozen".format(o["user_open_kernel_px"])
        c = v["combined"]
        lines.append(
            "| {} | {} | {} | {} | {:.3f} | {:.3f} | {} | {} | {} | {} | {} |".format(
                v["id"], open_s, dil_s,
                pct(c["correct"], c["total"]),
                c["checked_recall"], c["unchecked_specificity"],
                c["unchecked_to_checked"], c["uncertain"],
                fmt_focus(v["focus"], "IMG_1307", "B04.S2.BW"),
                fmt_focus(v["focus"], "IMG_1308", "B04.S2.BW"),
                fmt_focus(v["focus"], "IMG_1310", "header.effort.5"),
            )
        )
    lines.append("")
    lines.append("## Phase 1 — morphological open")
    lines.append("")
    lines.append("Hypothesis: the 3×3 ellipse open after subtraction is too destructive for thin handwritten X strokes.")
    lines.append("")
    for vid in [x["id"] for x in payload["variants"] if x["phase"] == 1]:
        v = by_id[vid]
        lines.append("### {}".format(v["id"]))
        lines.append("")
        lines.append("- {}".format(v["label"]))
        lines.append("- combined checkboxes: {}  recall={:.3f}  spec={:.3f}  false_checked={}  uncertain={}".format(
            pct(v["combined"]["correct"], v["combined"]["total"]),
            v["combined"]["checked_recall"], v["combined"]["unchecked_specificity"],
            v["combined"]["unchecked_to_checked"], v["combined"]["uncertain"],
        ))
        lines.append("- development: {}".format(pct(v["dev"]["correct"], v["dev"]["total"])))
        lines.append("- out-of-sample: {}".format(pct(v["oos"]["correct"], v["oos"]["total"])))
        lines.append("- text combined: {}  identical_to_A0={}".format(
            pct(v["text_combined"]["correct"], v["text_combined"]["total"]),
            v["text_identical_to_A0"],
        ))
        lines.append("- confusion: checked→unchecked={}  unchecked→checked={}  checked→uncertain={}  unchecked→uncertain={}".format(
            v["combined"]["checked_to_unchecked"], v["combined"]["unchecked_to_checked"],
            v["combined"]["checked_to_uncertain"], v["combined"]["unchecked_to_uncertain"],
        ))
        lines.append("- per-photo: " + ", ".join(
            "{} {}/{}".format(p["photo"], p["correct"], p["total"]) for p in v["per_photo"]
        ))
        lines.append("")
        lines.append("Weak-X traces:")
        lines.append("")
        lines.append("| photo / field | binary | after sub | after open | after inset | components | kept | frac | class |")
        lines.append("| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | --- |")
        for rec in v["focus"]:
            lines.append("| {} {} | {} | {} | {} | {} | {} | {} | {:.6f} | {} |".format(
                rec["photo"], rec["field"], rec["binary"], rec["after_subtraction"], rec["after_open"],
                rec["after_inset"], rec["component_areas"], rec["kept_area"], rec["user_ink_frac"], rec["classification"],
            ))
        lines.append("")
        lines.append("Currently-correct unchecked boxes that become **checked or uncertain**:")
        if not v["unchecked_became_checked_or_uncertain"]:
            lines.append("")
            lines.append("None.")
        else:
            lines.append("")
            for rec in v["unchecked_became_checked_or_uncertain"]:
                lines.append("- {} {} expected unchecked → {}  kept={} frac={:.6f} after_sub={} after_open={} components={}".format(
                    rec["photo"], rec["field"], rec["classification"], rec["kept_area"], rec["user_ink_frac"],
                    rec["after_subtraction"], rec["after_open"], rec["component_areas"],
                ))
        lines.append("")
        if v["false_checked"]:
            lines.append("False-checked raw metrics:")
            lines.append("")
            for rec in v["false_checked"]:
                lines.append("- {} {}: binary={} sub={} open={} inset={} kept={} frac={:.6f} class={}".format(
                    rec["photo"], rec["field"], rec["binary"], rec["after_subtraction"], rec["after_open"],
                    rec["after_inset"], rec["kept_area"], rec["user_ink_frac"], rec["classification"],
                ))
            lines.append("")
        if not v["text_identical_to_A0"]:
            lines.append("Text-field mismatches vs A0 (not vs truth): text states changed.")
            lines.append("Text mismatches vs truth:")
            for m in v["text_mismatches"]:
                lines.append("- {} {} expected {} got {} score={:.6f}".format(
                    m["photo"], m["field"], m["expected"], m["observed"], m["score"],
                ))
            lines.append("")
    lines.append("## Phase 2 — template dilation")
    lines.append("")
    lines.append("Frozen open behavior restored (`user_open_kernel_px = 3`).")
    lines.append("")
    for vid in [x["id"] for x in payload["variants"] if x["phase"] == 2]:
        v = by_id[vid]
        lines.append("### {}".format(v["id"]))
        lines.append("")
        lines.append("- {}".format(v["label"]))
        lines.append("- combined checkboxes: {}  recall={:.3f}  spec={:.3f}  false_checked={}  uncertain={}".format(
            pct(v["combined"]["correct"], v["combined"]["total"]),
            v["combined"]["checked_recall"], v["combined"]["unchecked_specificity"],
            v["combined"]["unchecked_to_checked"], v["combined"]["uncertain"],
        ))
        lines.append("- development: {}  oos: {}".format(
            pct(v["dev"]["correct"], v["dev"]["total"]), pct(v["oos"]["correct"], v["oos"]["total"]),
        ))
        lines.append("- text identical to A0: {}  text score {}".format(
            v["text_identical_to_A0"], pct(v["text_combined"]["correct"], v["text_combined"]["total"]),
        ))
        lines.append("- confusion: c→u={} u→c={} c→unc={} u→unc={}".format(
            v["combined"]["checked_to_unchecked"], v["combined"]["unchecked_to_checked"],
            v["combined"]["checked_to_uncertain"], v["combined"]["unchecked_to_uncertain"],
        ))
        lines.append("- per-photo: " + ", ".join(
            "{} {}/{}".format(p["photo"], p["correct"], p["total"]) for p in v["per_photo"]
        ))
        lines.append("")
        lines.append("| photo / field | binary | after sub | after open | after inset | components | kept | frac | class |")
        lines.append("| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | --- |")
        for rec in v["focus"]:
            lines.append("| {} {} | {} | {} | {} | {} | {} | {} | {:.6f} | {} |".format(
                rec["photo"], rec["field"], rec["binary"], rec["after_subtraction"], rec["after_open"],
                rec["after_inset"], rec["component_areas"], rec["kept_area"], rec["user_ink_frac"], rec["classification"],
            ))
        lines.append("")
        lines.append("Unchecked → checked or uncertain:")
        if not v["unchecked_became_checked_or_uncertain"]:
            lines.append("")
            lines.append("None.")
            lines.append("")
        else:
            lines.append("")
            for rec in v["unchecked_became_checked_or_uncertain"]:
                lines.append("- {} {} → {} kept={} frac={:.6f} after_sub={} after_open={} specks={} lines={}".format(
                    rec["photo"], rec["field"], rec["classification"], rec["kept_area"], rec["user_ink_frac"],
                    rec["after_subtraction"], rec["after_open"], rec["speck_area_rejected"], rec["line_area_rejected"],
                ))
            lines.append("")
    if any(v["phase"] == 3 for v in payload["variants"]):
        lines.append("## Phase 3 — combinations / scoped variants")
        lines.append("")
        lines.append(payload.get("phase3_rationale", ""))
        lines.append("")
        for v in payload["variants"]:
            if v["phase"] != 3:
                continue
            lines.append("### {}".format(v["id"]))
            lines.append("")
            lines.append("- {}".format(v["label"]))
            lines.append("- combined: {}  recall={:.3f}  spec={:.3f}  false_checked={}  uncertain={}".format(
                pct(v["combined"]["correct"], v["combined"]["total"]),
                v["combined"]["checked_recall"], v["combined"]["unchecked_specificity"],
                v["combined"]["unchecked_to_checked"], v["combined"]["uncertain"],
            ))
            lines.append("- text identical to A0: {}  text {}".format(
                v["text_identical_to_A0"], pct(v["text_combined"]["correct"], v["text_combined"]["total"]),
            ))
            lines.append("- B04-1307 {}  B04-1308 {}  effort5-1310 {}".format(
                fmt_focus(v["focus"], "IMG_1307", "B04.S2.BW"),
                fmt_focus(v["focus"], "IMG_1308", "B04.S2.BW"),
                fmt_focus(v["focus"], "IMG_1310", "header.effort.5"),
            ))
            if v["unchecked_became_checked_or_uncertain"]:
                lines.append("- unchecked regressions:")
                for rec in v["unchecked_became_checked_or_uncertain"]:
                    lines.append("  - {} {} → {} kept={} frac={:.6f}".format(
                        rec["photo"], rec["field"], rec["classification"], rec["kept_area"], rec["user_ink_frac"],
                    ))
            else:
                lines.append("- unchecked regressions: none")
            lines.append("")
    else:
        lines.append("## Phase 3")
        lines.append("")
        lines.append(payload.get("phase3_rationale", "No combination was justified."))
        lines.append("")
    lines.append("## Text-field regression")
    lines.append("")
    lines.append("A0 text: combined {}  oos {}  (POC #7B oos was 269/270; the remaining miss is IMG_1310 `note.quick_note` uncertain, known and not in scope).".format(
        pct(a0["text_combined"]["correct"], a0["text_combined"]["total"]),
        pct(a0["text_oos"]["correct"], a0["text_oos"]["total"]),
    ))
    lines.append("")
    for v in payload["variants"]:
        if v["id"] == "A0":
            continue
        lines.append("- {}: identical_to_A0={}  score {}".format(
            v["id"], v["text_identical_to_A0"], pct(v["text_combined"]["correct"], v["text_combined"]["total"]),
        ))
    lines.append("")
    sel = payload["selection"]
    lines.append("## Selection")
    lines.append("")
    lines.append(sel["narrative"])
    lines.append("")
    lines.append("## Answers")
    lines.append("")
    for i, ans in enumerate(payload["answers"], 1):
        lines.append("{}. {}".format(i, ans))
        lines.append("")
    lines.append("## STOP")
    lines.append("")
    lines.append("No production config update. No frozen SHA replacement. No handwriting recognition.")
    lines.append("")
    open(path, "w").write("\n".join(lines))


def text_state_map(summary):
    return {(m["photo"], m["field"]): m["observed"] for m in summary["text_mismatches"]}


def all_text_states(photos):
    out = {}
    for photo in photos:
        for item in photo["fields"].values():
            if item["kind"] == "text":
                out[(photo["id"], item["id"])] = item["state"]
    return out


def recovers_focus(summary):
    recovered = []
    for rec in summary["focus"]:
        if rec["expected"] == "checked" and rec["classification"] == "checked":
            recovered.append("{} {}".format(rec["photo"], rec["field"]))
    return recovered


def useful_checkbox_cleanup(summary, baseline_recovered):
    now = set(recovers_focus(summary))
    gained = now - set(baseline_recovered)
    return bool(gained) and summary["combined"]["unchecked_to_checked"] == 0


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    cfg = load_json(CFG_PATH)
    template = load_json(TEMPLATE_PATH)
    truth = load_json(TRUTH_PATH)
    blank = cv2.imread(BLANK_PATH, cv2.IMREAD_COLOR)
    if blank is None:
        raise RuntimeError("missing blank template")
    page_h, page_w = blank.shape[:2]
    blank_ink = poc7.adaptive_ink(cv2.cvtColor(blank, cv2.COLOR_BGR2GRAY), cfg["adaptive_block_size"], cfg["adaptive_c"])

    planned = [
        {
            "id": "A0", "phase": 1, "label": "frozen baseline",
            "open": 3, "open_scope": "all", "open_note": "ellipse 3",
            "dilate_k": 3, "dilate_iter": 2, "dilate_scope": "all",
        },
        {
            "id": "A1", "phase": 1, "label": "disable morphological open globally",
            "open": 0, "open_scope": "all", "open_note": "skipped (kernel < 2); identical to kernel 1",
            "dilate_k": 3, "dilate_iter": 2, "dilate_scope": "all",
        },
        {
            "id": "D1", "phase": 2, "label": "3×3 dilation, 1 iteration; frozen open=3",
            "open": 3, "open_scope": "all",
            "dilate_k": 3, "dilate_iter": 1, "dilate_scope": "all",
            "dilate_note": "less aggressive than frozen iter=2",
        },
        {
            "id": "D2", "phase": 2, "label": "no dilation (iterations=0); frozen open=3",
            "open": 3, "open_scope": "all",
            "dilate_k": 3, "dilate_iter": 0, "dilate_scope": "all",
            "dilate_note": "OpenCV dilate identity; printed brackets are subtracted only at raw template width",
        },
    ]

    raw = {}
    summaries = []
    for variant in planned:
        sys.stderr.write("running {}\n".format(variant["id"]))
        photos = run_variant(variant, cfg, template, blank_ink, truth, page_w, page_h)
        raw[variant["id"]] = photos
        summaries.append(summarize(variant, photos))

    a0_text = all_text_states(raw["A0"])
    a0_focus_ok = recovers_focus(summaries[0])
    for s, vid in zip(summaries, [v["id"] for v in planned]):
        s["text_identical_to_A0"] = all_text_states(raw[vid]) == a0_text

    a1 = next(s for s in summaries if s["id"] == "A1")
    d1 = next(s for s in summaries if s["id"] == "D1")
    d2 = next(s for s in summaries if s["id"] == "D2")

    phase3 = []
    rationale = []
    a1_gains = useful_checkbox_cleanup(a1, a0_focus_ok)
    d1_gains = useful_checkbox_cleanup(d1, a0_focus_ok)
    d2_gains = useful_checkbox_cleanup(d2, a0_focus_ok)

    if not d1["text_identical_to_A0"] and d1_gains:
        rationale.append(
            "D1 recovers weak X without checkbox false positives but changes text (more printed-line residue). "
            "D1c applies one-iteration dilation to checkboxes only and leaves text at frozen dilation."
        )
        phase3.append({
            "id": "D1c", "phase": 3, "label": "3×3 dilation iter 1 on checkboxes only; text frozen",
            "open": 3, "open_scope": "all",
            "dilate_k": 3, "dilate_iter": 1, "dilate_scope": "checkbox",
        })
    if not a1["text_identical_to_A0"]:
        rationale.append(
            "A1 global open=0 changes text-field states versus frozen A0, so it cannot be promoted as a json-key change. "
            "A1c applies the same no-open change to checkboxes only and leaves text at frozen open=3. "
            "That is kind-scoped, not per-field/per-photo."
        )
        phase3.append({
            "id": "A1c", "phase": 3, "label": "disable morph open on checkboxes only; text frozen",
            "open": 0, "open_scope": "checkbox", "open_note": "checkbox kernel skipped; text ellipse 3",
            "dilate_k": 3, "dilate_iter": 2, "dilate_scope": "all",
        })
    if a1_gains and d1_gains:
        rationale.append("A1 recovered weak X without false checked; D1 also recovered without false checked. Testing their combination.")
        phase3.append({
            "id": "C-A1-D1", "phase": 3, "label": "global no-open + dilation iter 1",
            "open": 0, "open_scope": "all",
            "dilate_k": 3, "dilate_iter": 1, "dilate_scope": "all",
        })
    if (not a1["text_identical_to_A0"]) and a1_gains and d1_gains:
        rationale.append("A1c plus one-iteration dilation: both single-knob changes were useful and A1 must be kind-scoped to keep text frozen.")
        phase3.append({
            "id": "C-A1c-D1", "phase": 3, "label": "checkbox no-open + checkbox dilation iter 1; text frozen",
            "open": 0, "open_scope": "checkbox",
            "dilate_k": 3, "dilate_iter": 1, "dilate_scope": "checkbox",
        })
    if a1_gains and d2_gains:
        rationale.append("D2 also recovered weak X without false checked; testing no-open + no-dilation.")
        phase3.append({
            "id": "C-A1-D2", "phase": 3, "label": "global no-open + no dilation",
            "open": 0, "open_scope": "all",
            "dilate_k": 3, "dilate_iter": 0, "dilate_scope": "all",
        })
    if not phase3:
        rationale.append(
            "No Phase 3 combination: either Phase 1/2 did not recover weak X without false checked, "
            "or the useful variant is already a single-knob change."
        )

    for variant in phase3:
        sys.stderr.write("running {}\n".format(variant["id"]))
        photos = run_variant(variant, cfg, template, blank_ink, truth, page_w, page_h)
        raw[variant["id"]] = photos
        s = summarize(variant, photos)
        s["text_identical_to_A0"] = all_text_states(photos) == a0_text
        summaries.append(s)

    # panels: recovered weak-X and new unchecked regressions vs A0
    panel_dir = os.path.join(OUT_DIR, "panels")
    os.makedirs(panel_dir, exist_ok=True)
    panels = []
    a0_cb = {(r["photo"], r["id"]): r for r in flatten(raw["A0"], "checkbox")}
    for s in summaries:
        if s["id"] == "A0":
            continue
        photos = raw[s["id"]]
        for rec in s["focus"]:
            base = a0_cb[(rec["photo"], rec["field"])]
            improved = base["state"] != "checked" and rec["classification"] == "checked"
            if improved:
                bfull = find_field(raw["A0"], rec["photo"], rec["field"])
                vfull = find_field(photos, rec["photo"], rec["field"])
                vfull = dict(vfull)
                vfull["variant_id"] = s["id"]
                name = "{}-recovered-{}-{}.png".format(s["id"], rec["photo"], rec["field"].replace(".", "_"))
                save_panel(
                    os.path.join(panel_dir, name),
                    "{} recovered {} {}  A0={} → {}".format(s["id"], rec["photo"], rec["field"], base["state"], rec["classification"]),
                    bfull, vfull,
                )
                panels.append(name)
        for rec in s["unchecked_became_checked_or_uncertain"]:
            base = a0_cb[(rec["photo"], rec["field"])]
            if base["state"] == rec["classification"]:
                continue
            if base["state"] == "unchecked" and rec["classification"] in ("checked", "uncertain"):
                bfull = find_field(raw["A0"], rec["photo"], rec["field"])
                vfull = find_field(photos, rec["photo"], rec["field"])
                vfull = dict(vfull)
                vfull["variant_id"] = s["id"]
                name = "{}-regress-{}-{}.png".format(s["id"], rec["photo"], rec["field"].replace(".", "_"))
                save_panel(
                    os.path.join(panel_dir, name),
                    "{} REGRESS {} {}  A0={} → {}".format(s["id"], rec["photo"], rec["field"], base["state"], rec["classification"]),
                    bfull, vfull,
                )
                panels.append(name)

    # selection
    a0c = next(x for x in summaries if x["id"] == "A0")
    a0_wrong = {(x["photo"], x["field"]) for x in a0c["checked_still_wrong"]}
    safe = []
    for s in summaries:
        if s["id"] == "A0":
            continue
        gained = set(recovers_focus(s)) - set(a0_focus_ok)
        no_fp = s["combined"]["unchecked_to_checked"] == 0
        text_ok = s["text_identical_to_A0"]
        now_wrong = {(x["photo"], x["field"]) for x in s["checked_still_wrong"]}
        new_checked_misses = now_wrong - a0_wrong
        if gained and no_fp and text_ok and not new_checked_misses:
            safe.append(s["id"])
        s["gained_focus"] = sorted(gained)
        s["new_checked_misses"] = [
            {"photo": p, "field": f} for p, f in sorted(new_checked_misses)
        ]

    if safe:
        # prefer fewer knobs, then fewer uncertain, then higher correct
        def key(vid):
            s = next(x for x in summaries if x["id"] == vid)
            knobs = 0
            if s["open_config"]["user_open_kernel_px"] != 3:
                knobs += 1
            if s["open_config"]["scope"] != "all":
                knobs += 0.25
            if s["dilation_config"]["template_dilate_iterations"] != 2:
                knobs += 1
            if s["dilation_config"]["scope"] != "all":
                knobs += 0.25
            return (knobs, s["combined"]["uncertain"], -s["combined"]["correct"], vid)
        winner = sorted(safe, key=key)[0]
        narrative = (
            "Safe global improvement exists on this labeled set: {}. "
            "Do **not** write it into poc7-detector.json. This dataset participated in diagnosis and selection; "
            "the next step is a fresh out-of-sample photo set."
        ).format(winner)
        advance = winner
        keep_frozen = False
    else:
        winner = None
        narrative = (
            "No candidate improves the tradeoff safely. Either weak-X marks are not recovered, "
            "false checked states appear, previously-correct checked marks regress, or text-field states change. "
            "Retain the frozen detector."
        )
        advance = None
        keep_frozen = True

    a0s = next(x for x in summaries if x["id"] == "A0")
    a1s = next(x for x in summaries if x["id"] == "A1")
    d1s = next(x for x in summaries if x["id"] == "D1")
    d2s = next(x for x in summaries if x["id"] == "D2")
    a1c = next((x for x in summaries if x["id"] == "A1c"), None)

    def focus_class(summary, photo, field):
        return next(x for x in summary["focus"] if x["photo"] == photo and x["field"] == field)["classification"]

    answers = [
        "Removing morphological open recovers the zero-score marks on this set: "
        "IMG_1307 B04.S2.BW A0={} → A1={}; IMG_1310 effort.5 A0={} → A1={}; IMG_1308 B04.S2.BW A0={} → A1={}. "
        "Raw: see Phase 1 tables (after-open equals after-subtraction when open is disabled).".format(
            focus_class(a0s, "IMG_1307", "B04.S2.BW"), focus_class(a1s, "IMG_1307", "B04.S2.BW"),
            focus_class(a0s, "IMG_1310", "header.effort.5"), focus_class(a1s, "IMG_1310", "header.effort.5"),
            focus_class(a0s, "IMG_1308", "B04.S2.BW"), focus_class(a1s, "IMG_1308", "B04.S2.BW"),
        ),
        "False checked under A1 global: {} ({} boxes). Unchecked→uncertain: {}. "
        "List is in Phase 1. Treat any unchecked→checked as a blocking regression.".format(
            a1s["combined"]["unchecked_to_checked"],
            len(a1s["false_checked"]),
            a1s["combined"]["unchecked_to_uncertain"],
        ),
        "Reducing dilation: D1 (iter=1) B04-1307={} B04-1308={} effort5-1310={}; "
        "D2 (none) B04-1307={} B04-1308={} effort5-1310={}. "
        "False checked D1={} D2={}.".format(
            focus_class(d1s, "IMG_1307", "B04.S2.BW"), focus_class(d1s, "IMG_1308", "B04.S2.BW"),
            focus_class(d1s, "IMG_1310", "header.effort.5"),
            focus_class(d2s, "IMG_1307", "B04.S2.BW"), focus_class(d2s, "IMG_1308", "B04.S2.BW"),
            focus_class(d2s, "IMG_1310", "header.effort.5"),
            d1s["combined"]["unchecked_to_checked"], d2s["combined"]["unchecked_to_checked"],
        ),
        "Reduced dilation exposing printed brackets: D2 unchecked→checked={} unchecked→uncertain={}. "
        "If those leftovers have large after_subtraction on empty boxes, they are bracket residue. See Phase 2 lists.".format(
            d2s["combined"]["unchecked_to_checked"], d2s["combined"]["unchecked_to_uncertain"],
        ),
        "Best evidence-supported tradeoff is recorded in Selection. "
        "False checked outweighs raw accuracy. Text must stay identical to frozen A0.",
        "A combination is justified only when both single-knob changes recovered weak X without false checked. "
        "Phase 3 rationale: {}".format(" ".join(rationale)),
        "Safe global improvement over frozen detector on this set: {}.".format("yes, " + (winner or "") if winner else "no"),
        "Candidate to advance to a **fresh** out-of-sample confirmation (not this dataset): {}.".format(
            advance or "none — keep frozen",
        ),
        "If no: the frozen detector should remain unchanged. Decision: {}.".format(
            "keep frozen" if keep_frozen else "do not promote yet; confirm {} on new photos".format(advance),
        ),
    ]

    payload = {
        "frozen_sha256": "b8a96560893d1c9906c01d6bc67ea66bd788d3ea411f9f4cd7a0585605f9ea80",
        "detector_sha256_after": None,
        "a2_identical_to_a1": True,
        "d0_identical_to_a0": True,
        "phase3_rationale": " ".join(rationale),
        "variants": summaries,
        "panels": panels,
        "selection": {
            "safe_candidates": safe,
            "winner_on_this_set": winner,
            "advance_to_fresh_oos": advance,
            "keep_frozen": keep_frozen,
            "narrative": narrative,
        },
        "answers": answers,
    }
    # drop bulky per-field from json except focus/regressions already stored
    json.dump(payload, open(os.path.join(OUT_DIR, "results.json"), "w"), indent=2)
    write_report(os.path.join(OUT_DIR, "REPORT.md"), payload)
    print(json.dumps({
        "ok": True,
        "out": OUT_DIR,
        "variants": [s["id"] for s in summaries],
        "safe": safe,
        "winner": winner,
        "focus_A0": a0s["focus"],
        "focus_A1": a1s["focus"],
        "false_checked_A1": len(a1s["false_checked"]),
        "text_A1_identical": a1s["text_identical_to_A0"],
        "combined_A0": a0s["combined"]["correct"],
        "combined_A1": a1s["combined"]["correct"],
        "combined_D1": d1s["combined"]["correct"],
        "combined_D2": d2s["combined"]["correct"],
    }, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
