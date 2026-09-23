#!/usr/bin/env python3
"""POC #7: deterministic checkbox + blank/nonblank detection.

Compares a rectified photo crop against the known blank PDF raster.
Printed ink is masked; leftover blobs are treated as user marks.
No OCR, no neural nets, no Ollama.
"""
from __future__ import print_function

import argparse
import json
import math
import os
import sys

import cv2
import numpy as np


def adaptive_ink(gray, block, c):
    block = int(block)
    if block % 2 == 0:
        block += 1
    return cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, block, float(c)
    )


def crop_pad(img, box, pad, page_w, page_h):
    x0 = max(0, int(box["x"]) - pad)
    y0 = max(0, int(box["y"]) - pad)
    x1 = min(page_w, int(box["x"]) + int(box["w"]) + pad)
    y1 = min(page_h, int(box["y"]) + int(box["h"]) + pad)
    return img[y0:y1, x0:x1], (x0, y0, x1, y1)


def best_shift(obs_ink, tmp_ink, radius):
    h = min(obs_ink.shape[0], tmp_ink.shape[0])
    w = min(obs_ink.shape[1], tmp_ink.shape[1])
    observed = obs_ink[:h, :w]
    template = tmp_ink[:h, :w]
    tcount = int(np.count_nonzero(template))
    best_score = -1.0
    best = (0, 0, observed)
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            matrix = np.array([[1, 0, dx], [0, 1, dy]], np.float32)
            shifted = cv2.warpAffine(
                observed, matrix, (w, h), flags=cv2.INTER_NEAREST, borderValue=0
            )
            overlap = int(np.count_nonzero((shifted > 0) & (template > 0)))
            score = overlap / float(tcount + 1)
            if score > best_score:
                best_score = score
                best = (dx, dy, shifted)
    return best[0], best[1], best[2], float(best_score), tcount


def is_line_like(stat, field_w, field_h, aspect, span_frac, thickness):
    _x, _y, w, h, area = stat
    if w <= 0 or h <= 0:
        return True
    ratio = max(w, h) / float(max(min(w, h), 1))
    if ratio >= aspect:
        return True
    if h <= thickness and w >= span_frac * field_w:
        return True
    if w <= thickness and h >= span_frac * field_h:
        return True
    return False


def inset_view(mask, fraction):
    ih, iw = mask.shape
    mx = max(1, int(round(iw * fraction)))
    my = max(1, int(round(ih * fraction)))
    if ih - 2 * my < 2 or iw - 2 * mx < 2:
        return mask, (0, 0)
    return mask[my:ih - my, mx:iw - mx], (mx, my)


def filter_user_ink(user, cfg):
    core, origin = inset_view(user, cfg["inset_fraction"])
    num, labels, stats, _ = cv2.connectedComponentsWithStats((core > 0).astype(np.uint8), 8)
    kept = np.zeros_like(core)
    kept_area = 0
    largest = 0
    line_area = 0
    specks = 0
    ch, cw = core.shape
    for i in range(1, num):
        st = stats[i]
        area = int(st[cv2.CC_STAT_AREA])
        if is_line_like(
            st, cw, ch,
            cfg["line_aspect_ratio"],
            cfg["line_span_fraction"],
            cfg["line_thickness_px"],
        ):
            line_area += area
            continue
        if area < cfg["min_component_area"]:
            specks += area
            continue
        kept[labels == i] = 255
        kept_area += area
        largest = max(largest, area)
    frac = float(kept_area) / float(core.size) if core.size else 0.0
    return {
        "core": core,
        "kept": kept,
        "origin": origin,
        "user_ink_area": kept_area,
        "user_ink_frac": frac,
        "largest_component_area": largest,
        "line_area_rejected": line_area,
        "speck_area_rejected": specks,
        "core_pixels": int(core.size),
    }


def clamp01(value):
    return float(max(0.0, min(1.0, value)))


def classify_checkbox(frac, area, spec):
    if area >= spec["checked_min_area"] and frac >= spec["checked_min_frac"]:
        state = "checked"
        conf = 0.55 + 0.45 * clamp01((frac - spec["checked_min_frac"]) / 0.08)
    elif area <= spec["unchecked_max_area"] and frac <= spec["unchecked_max_frac"]:
        state = "unchecked"
        conf = 0.55 + 0.45 * clamp01(1.0 - frac / max(spec["unchecked_max_frac"], 1e-6))
    else:
        state = "uncertain"
        conf = 0.40
    return state, conf


def classify_text(frac, area, spec):
    if area >= spec["nonblank_min_area"] and frac >= spec["nonblank_min_frac"]:
        state = "nonblank"
        conf = 0.55 + 0.45 * clamp01((frac - spec["nonblank_min_frac"]) / 0.08)
    elif area <= spec["blank_max_area"] and frac <= spec["blank_max_frac"]:
        state = "blank"
        conf = 0.55 + 0.45 * clamp01(1.0 - frac / max(spec["blank_max_frac"], 1e-6))
    else:
        state = "uncertain"
        conf = 0.40
    return state, conf


def open_kernel_px(cfg, kind):
    scoped = "{}_user_open_kernel_px".format(kind)
    if scoped in cfg and cfg[scoped] is not None:
        return int(cfg[scoped])
    return int(cfg["user_open_kernel_px"])


def measure_field(obs_ink, blank_ink, box, cfg, kind, page_w, page_h):
    pad = int(cfg["crop_pad_px"])
    oc, origin = crop_pad(obs_ink, box, pad, page_w, page_h)
    bc, _ = crop_pad(blank_ink, box, pad, page_w, page_h)
    dx, dy, shifted, overlap, tcount = best_shift(oc, bc, int(cfg["shift_search_radius_px"]))
    h, w = shifted.shape
    template = bc[:h, :w]
    k = int(cfg["template_dilate_kernel_px"])
    dilate = cv2.getStructuringElement(cv2.MORPH_RECT, (k, k))
    mask = cv2.dilate(template, dilate, iterations=int(cfg["template_dilate_iterations"]))
    user = cv2.bitwise_and(shifted, cv2.bitwise_not(mask))
    ok = open_kernel_px(cfg, kind)
    if ok >= 2:
        user = cv2.morphologyEx(user, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (ok, ok)))
    sub_cfg = {
        "inset_fraction": cfg[kind]["inset_fraction"],
        "min_component_area": cfg["min_component_area"],
        "line_aspect_ratio": cfg["line_aspect_ratio"],
        "line_span_fraction": cfg["line_span_fraction"],
        "line_thickness_px": cfg["line_thickness_px"],
    }
    filtered = filter_user_ink(user, sub_cfg)
    if kind == "checkbox":
        state, conf = classify_checkbox(filtered["user_ink_frac"], filtered["user_ink_area"], cfg["checkbox"])
        score = filtered["user_ink_frac"]
    else:
        state, conf = classify_text(filtered["user_ink_frac"], filtered["user_ink_area"], cfg["text"])
        score = filtered["user_ink_frac"]
    return {
        "state": state,
        "score": float(score),
        "confidence": float(conf),
        "user_ink_frac": float(filtered["user_ink_frac"]),
        "user_ink_area": int(filtered["user_ink_area"]),
        "largest_component_area": int(filtered["largest_component_area"]),
        "line_area_rejected": int(filtered["line_area_rejected"]),
        "speck_area_rejected": int(filtered["speck_area_rejected"]),
        "template_overlap": float(overlap),
        "template_ink_pixels": int(tcount),
        "shift_px": {"dx": int(dx), "dy": int(dy)},
        "crop_origin": {"x": int(origin[0]), "y": int(origin[1])},
        "kind": kind,
        "_kept": filtered["kept"],
        "_core_origin": filtered["origin"],
        "_user": user,
        "_shifted": shifted,
    }


def paint_user_overlay(observed_bgr, results, fields):
    gray = cv2.cvtColor(observed_bgr, cv2.COLOR_BGR2GRAY)
    vis = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
    overlay = vis.copy()
    for item in fields:
        rec = results[item["id"]]
        kept = rec["_kept"]
        ox, oy = rec["_core_origin"]
        dx = rec["shift_px"]["dx"]
        dy = rec["shift_px"]["dy"]
        x0 = rec["crop_origin"]["x"]
        y0 = rec["crop_origin"]["y"]
        ys, xs = np.where(kept > 0)
        color = (0, 0, 255) if item["kind"] == "checkbox" else (0, 140, 255)
        for y, x in zip(ys, xs):
            py = y0 + oy + int(y) - dy
            px = x0 + ox + int(x) - dx
            if 0 <= py < overlay.shape[0] and 0 <= px < overlay.shape[1]:
                overlay[py, px] = color
    return cv2.addWeighted(vis, 0.55, overlay, 0.45, 0)


def stack_difference(blank_bgr, observed_bgr, user_overlay):
    def label(img, text):
        out = img.copy()
        cv2.putText(out, text, (24, 48), cv2.FONT_HERSHEY_SIMPLEX, 1.3, (0, 200, 255), 3, cv2.LINE_AA)
        return out
    return np.hstack([
        label(blank_bgr, "blank PDF 1700x2200"),
        label(observed_bgr, "observed rectified"),
        label(user_overlay, "user-ink (template subtracted)"),
    ])


def contact_sheet(observed_bgr, fields, results, cols, cell_w, cell_h):
    rows = int(math.ceil(float(len(fields)) / cols))
    sheet = np.full((rows * cell_h + 24, cols * cell_w + 24, 3), 245, dtype=np.uint8)
    rh, rw = observed_bgr.shape[:2]
    for i, item in enumerate(fields):
        rec = results[item["id"]]
        r, c = divmod(i, cols)
        box = item["px"]
        x0 = max(0, box["x"])
        y0 = max(0, box["y"])
        x1 = min(rw, box["x"] + box["w"])
        y1 = min(rh, box["y"] + box["h"])
        crop = observed_bgr[y0:y1, x0:x1]
        if crop.size == 0:
            crop = np.full((40, 80, 3), 180, dtype=np.uint8)
        ox = 12 + c * cell_w
        oy = 12 + r * cell_h
        state = rec["state"]
        if state in ("checked", "nonblank"):
            border = (40, 160, 40)
        elif state in ("unchecked", "blank"):
            border = (160, 160, 160)
        else:
            border = (0, 160, 255)
        cv2.rectangle(sheet, (ox, oy), (ox + cell_w - 8, oy + cell_h - 8), (230, 230, 230), -1)
        cv2.rectangle(sheet, (ox, oy), (ox + cell_w - 8, oy + cell_h - 8), border, 2)
        cv2.putText(sheet, item["id"], (ox + 6, oy + 16), cv2.FONT_HERSHEY_SIMPLEX, 0.38, (20, 20, 20), 1, cv2.LINE_AA)
        label = "{}  s={:.3f}  c={:.2f}".format(state, rec["score"], rec["confidence"])
        cv2.putText(sheet, label, (ox + 6, oy + 32), cv2.FONT_HERSHEY_SIMPLEX, 0.36, border, 1, cv2.LINE_AA)
        avail_w = cell_w - 18
        avail_h = cell_h - 46
        ch, cw = crop.shape[:2]
        scale = min(float(avail_w) / max(cw, 1), float(avail_h) / max(ch, 1))
        nw, nh = max(1, int(cw * scale)), max(1, int(ch * scale))
        resized = cv2.resize(crop, (nw, nh), interpolation=cv2.INTER_AREA)
        sheet[oy + 38:oy + 38 + nh, ox + 6:ox + 6 + nw] = resized
    return sheet


def public_record(rec):
    return {
        "state": rec["state"],
        "score": rec["score"],
        "confidence": rec["confidence"],
        "user_ink_frac": rec["user_ink_frac"],
        "user_ink_area": rec["user_ink_area"],
        "largest_component_area": rec["largest_component_area"],
        "line_area_rejected": rec["line_area_rejected"],
        "speck_area_rejected": rec["speck_area_rejected"],
        "template_overlap": rec["template_overlap"],
        "template_ink_pixels": rec["template_ink_pixels"],
        "shift_px": rec["shift_px"],
        "kind": rec["kind"],
    }


def run(blank_path, observed_path, template_path, config_path, out_dir):
    cfg = json.loads(open(config_path, "r").read())
    template = json.loads(open(template_path, "r").read())
    blank = cv2.imread(blank_path, cv2.IMREAD_COLOR)
    observed = cv2.imread(observed_path, cv2.IMREAD_COLOR)
    if blank is None:
        raise RuntimeError("could not read blank template: {}".format(blank_path))
    if observed is None:
        raise RuntimeError("could not read observed image: {}".format(observed_path))
    bh, bw = blank.shape[:2]
    oh, ow = observed.shape[:2]
    if (bw, bh) != (cfg["canonical_width"], cfg["canonical_height"]):
        raise RuntimeError("blank template is {}x{}, expected {}x{}".format(
            bw, bh, cfg["canonical_width"], cfg["canonical_height"]))
    if (ow, oh) != (cfg["canonical_width"], cfg["canonical_height"]):
        raise RuntimeError("observed image is {}x{}, expected {}x{}".format(
            ow, oh, cfg["canonical_width"], cfg["canonical_height"]))

    blank_gray = cv2.cvtColor(blank, cv2.COLOR_BGR2GRAY)
    obs_gray = cv2.cvtColor(observed, cv2.COLOR_BGR2GRAY)
    blank_ink = adaptive_ink(blank_gray, cfg["adaptive_block_size"], cfg["adaptive_c"])
    obs_ink = adaptive_ink(obs_gray, cfg["adaptive_block_size"], cfg["adaptive_c"])

    results = {}
    checkboxes = []
    texts = []
    for item in template["fields"]:
        kind = "checkbox" if item["kind"] == "checkbox" else "text"
        rec = measure_field(obs_ink, blank_ink, item["px"], cfg, kind, bw, bh)
        results[item["id"]] = rec
        if kind == "checkbox":
            checkboxes.append(item)
        else:
            texts.append(item)

    os.makedirs(out_dir, exist_ok=True)
    user_overlay = paint_user_overlay(observed, results, template["fields"])
    diff = stack_difference(blank, observed, user_overlay)
    checkbox_sheet = contact_sheet(observed, checkboxes, results, cols=6, cell_w=230, cell_h=150)
    blank_sheet = contact_sheet(observed, texts, results, cols=6, cell_w=230, cell_h=150)

    checkbox_path = os.path.join(out_dir, "poc7-checkbox-debug.png")
    blank_debug_path = os.path.join(out_dir, "poc7-blank-debug.png")
    diff_path = os.path.join(out_dir, "poc7-difference-debug.png")
    cv2.imwrite(checkbox_path, checkbox_sheet)
    cv2.imwrite(blank_debug_path, blank_sheet)
    cv2.imwrite(diff_path, diff)

    payload = {
        "ok": True,
        "template": template.get("template_id", "B-1.3.1"),
        "source": observed_path,
        "blank_template": blank_path,
        "canonical": {
            "width": int(bw),
            "height": int(bh),
            "dpi": int(cfg["canonical_dpi"]),
        },
        "detector_config": os.path.abspath(config_path),
        "algorithm": (
            "Per-field adaptive-threshold ink vs PDF blank raster. Integer translation "
            "maximizes overlap with known printed ink; dilated template mask is subtracted; "
            "checkbox residuals skip morphological open (poc7-a1c); text residuals keep "
            "the frozen 3x3 ellipse open; thin line-like leftovers are rejected; "
            "remaining blob area/fraction is scored."
        ),
        "checkboxes": {item["id"]: public_record(results[item["id"]]) for item in checkboxes},
        "fields": {item["id"]: public_record(results[item["id"]]) for item in texts},
        "counts": {
            "checkboxes": len(checkboxes),
            "fields": len(texts),
        },
        "artifacts": {
            "blank_template": os.path.abspath(blank_path),
            "checkbox_debug": os.path.abspath(checkbox_path),
            "blank_debug": os.path.abspath(blank_debug_path),
            "difference_debug": os.path.abspath(diff_path),
        },
    }
    return payload


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("--blank", required=True)
    parser.add_argument("--observed", required=True)
    parser.add_argument("--template", required=True)
    parser.add_argument("--config", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args(argv)
    result = run(args.blank, args.observed, args.template, args.config, args.out)
    json.dump(result, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0 if result.get("ok") else 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
