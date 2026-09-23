#!/usr/bin/env python3
"""POC #7C forensics. Reads the frozen POC #7 detector; does not change it."""
from __future__ import print_function

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
FIXTURE_DIR = os.path.join(V131, "fixtures", "poc7b")
POC7B_DIR = os.path.join(V131, "artifacts", "poc7b")
DEV_PHOTO = os.path.join(V131, "fixtures", "routine-B-v1.3.1.jpg")
DEV_RECT = os.path.join(V131, "artifacts", "poc6-rectified.png")
DEV_REG = os.path.join(V131, "artifacts", "poc6-registration.json")
OUT_DIR = os.path.join(V131, "artifacts", "poc7c")

CASES = [
    {"id": "A", "role": "failure", "photo": "IMG_1307", "field": "B04.S2.BW", "expected": "checked"},
    {"id": "B", "role": "failure", "photo": "IMG_1310", "field": "header.effort.5", "expected": "checked"},
    {"id": "C", "role": "failure", "photo": "IMG_1308", "field": "B04.S2.BW", "expected": "checked"},
    {"id": "D", "role": "failure", "photo": "IMG_1310", "field": "note.quick_note", "expected": "blank"},
    {"id": "CTRL-B04-1305", "role": "control", "photo": "IMG_1305", "field": "B04.S2.BW", "expected": "checked"},
    {"id": "CTRL-B04-1306", "role": "control", "photo": "IMG_1306", "field": "B04.S2.BW", "expected": "checked"},
    {"id": "CTRL-B04-1309", "role": "control", "photo": "IMG_1309", "field": "B04.S2.BW", "expected": "checked"},
    {"id": "CTRL-B04-1310", "role": "control", "photo": "IMG_1310", "field": "B04.S2.BW", "expected": "checked"},
    {"id": "CTRL-B04-DEV", "role": "control", "photo": "poc7-dev", "field": "B04.S2.BW", "expected": "checked"},
    {"id": "CTRL-E5-1305", "role": "control", "photo": "IMG_1305", "field": "header.effort.5", "expected": "checked"},
    {"id": "CTRL-E5-1307", "role": "control", "photo": "IMG_1307", "field": "header.effort.5", "expected": "checked"},
    {"id": "CTRL-E5-1309", "role": "control", "photo": "IMG_1309", "field": "header.effort.5", "expected": "checked"},
    {"id": "CTRL-NOTE-1305", "role": "control", "photo": "IMG_1305", "field": "note.quick_note", "expected": "blank"},
    {"id": "CTRL-NOTE-1309", "role": "control", "photo": "IMG_1309", "field": "note.quick_note", "expected": "blank"},
]


def load_json(path):
    return json.loads(open(path, "r").read())


def photo_paths(slug):
    if slug == "poc7-dev":
        return {
            "source": DEV_PHOTO,
            "rectified": DEV_RECT,
            "registration": DEV_REG,
            "oriented": os.path.join(OUT_DIR, "_oriented", "poc7-dev.jpg"),
        }
    return {
        "source": os.path.join(FIXTURE_DIR, slug + ".jpeg"),
        "rectified": os.path.join(POC7B_DIR, slug, "rectified.png"),
        "registration": os.path.join(POC7B_DIR, slug, "registration.json"),
        "oriented": os.path.join(OUT_DIR, "_oriented", slug + ".jpg"),
    }


def to_bgr_gray(path):
    bgr = cv2.imread(path, cv2.IMREAD_COLOR)
    if bgr is None:
        raise RuntimeError("cannot read " + path)
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    return bgr, gray


def colorize_mask(mask, color):
    out = np.zeros((mask.shape[0], mask.shape[1], 3), np.uint8)
    out[mask > 0] = color
    return out


def nn_scale(img, size=220):
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    h, w = img.shape[:2]
    scale = float(size) / max(h, w, 1)
    nw, nh = max(1, int(round(w * scale))), max(1, int(round(h * scale)))
    return cv2.resize(img, (nw, nh), interpolation=cv2.INTER_NEAREST)


def tile(img, title, size=220):
    scaled = nn_scale(img, size)
    canvas = np.full((size + 28, size, 3), 30, np.uint8)
    y = 26 + (size - scaled.shape[0]) // 2
    x = (size - scaled.shape[1]) // 2
    canvas[y:y + scaled.shape[0], x:x + scaled.shape[1]] = scaled
    cv2.putText(canvas, title[:42], (4, 16), cv2.FONT_HERSHEY_SIMPLEX, 0.38, (240, 240, 240), 1, cv2.LINE_AA)
    return canvas


def source_crop(oriented_bgr, homography, box, pad):
    inv = np.linalg.inv(np.array(homography, np.float64))
    pts = np.array([
        [box["x"] - pad, box["y"] - pad],
        [box["x"] + box["w"] + pad, box["y"] - pad],
        [box["x"] + box["w"] + pad, box["y"] + box["h"] + pad],
        [box["x"] - pad, box["y"] + box["h"] + pad],
    ], np.float32).reshape(-1, 1, 2)
    mapped = cv2.perspectiveTransform(pts, inv).reshape(-1, 2)
    x0 = int(max(0, np.floor(mapped[:, 0].min())))
    y0 = int(max(0, np.floor(mapped[:, 1].min())))
    x1 = int(min(oriented_bgr.shape[1] - 1, np.ceil(mapped[:, 0].max())))
    y1 = int(min(oriented_bgr.shape[0] - 1, np.ceil(mapped[:, 1].max())))
    crop = oriented_bgr[y0:y1, x0:x1].copy()
    vis = crop.copy()
    local = mapped - np.array([x0, y0], np.float32)
    cv2.polylines(vis, [np.round(local).astype(np.int32)], True, (0, 255, 255), 1, cv2.LINE_AA)
    return vis, (x0, y0, x1, y1), mapped.tolist()


def shift_search(obs_ink, tmp_ink, radius, dilate_k, dilate_iter, open_k, inset_frac):
    h = min(obs_ink.shape[0], tmp_ink.shape[0])
    w = min(obs_ink.shape[1], tmp_ink.shape[1])
    observed = obs_ink[:h, :w]
    template = tmp_ink[:h, :w]
    tcount = int(np.count_nonzero(template))
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (dilate_k, dilate_k))
    dilated = cv2.dilate(template, kernel, iterations=dilate_iter)
    open_el = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (open_k, open_k)) if open_k >= 2 else None
    candidates = []
    best_overlap = -1.0
    chosen = None
    best_residual = -1
    residual_best = None
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            matrix = np.array([[1, 0, dx], [0, 1, dy]], np.float32)
            shifted = cv2.warpAffine(observed, matrix, (w, h), flags=cv2.INTER_NEAREST, borderValue=0)
            overlap = int(np.count_nonzero((shifted > 0) & (template > 0)))
            ov_score = overlap / float(tcount + 1)
            residual = cv2.bitwise_and(shifted, cv2.bitwise_not(dilated))
            if open_el is not None:
                residual = cv2.morphologyEx(residual, cv2.MORPH_OPEN, open_el)
            core, _ = poc7.inset_view(residual, inset_frac)
            resid_n = int(np.count_nonzero(core))
            rec = {
                "dx": dx, "dy": dy,
                "overlap": overlap,
                "overlap_score": ov_score,
                "residual_after_inset": resid_n,
            }
            candidates.append(rec)
            if ov_score > best_overlap:
                best_overlap = ov_score
                chosen = rec
            if resid_n > best_residual:
                best_residual = resid_n
                residual_best = rec
    return candidates, chosen, residual_best, tcount, dilated


def heatmap(candidates, key, radius):
    n = 2 * radius + 1
    grid = np.zeros((n, n), np.float32)
    mx = max(c[key] for c in candidates) or 1.0
    for c in candidates:
        grid[c["dy"] + radius, c["dx"] + radius] = c[key] / mx
    vis = np.clip(grid * 255, 0, 255).astype(np.uint8)
    vis = cv2.applyColorMap(vis, cv2.COLORMAP_INFERNO)
    return vis


def gray_stats(arr):
    if arr.size == 0:
        return None
    return {
        "min": int(arr.min()),
        "max": int(arr.max()),
        "mean": float(arr.mean()),
        "median": float(np.median(arr)),
        "std": float(arr.std()),
        "p05": float(np.percentile(arr, 5)),
        "p95": float(np.percentile(arr, 95)),
        "n": int(arr.size),
    }


def analyze_case(case, cfg, template, blank_bgr, blank_gray, blank_ink):
    paths = photo_paths(case["photo"])
    field = next(f for f in template["fields"] if f["id"] == case["field"])
    box = field["px"]
    kind = "checkbox" if field["kind"] == "checkbox" else "text"
    inset_frac = cfg[kind]["inset_fraction"]
    pad = int(cfg["crop_pad_px"])
    page_w, page_h = cfg["canonical_width"], cfg["canonical_height"]

    rect_bgr, rect_gray = to_bgr_gray(paths["rectified"])
    oriented_bgr, _ = to_bgr_gray(paths["oriented"])
    registration = load_json(paths["registration"])
    obs_ink = poc7.adaptive_ink(rect_gray, cfg["adaptive_block_size"], cfg["adaptive_c"])

    oc, origin = poc7.crop_pad(obs_ink, box, pad, page_w, page_h)
    bc, _ = poc7.crop_pad(blank_ink, box, pad, page_w, page_h)
    og, _ = poc7.crop_pad(rect_gray, box, pad, page_w, page_h)
    ob, _ = poc7.crop_pad(rect_bgr, box, pad, page_w, page_h)
    bg, _ = poc7.crop_pad(blank_gray, box, pad, page_w, page_h)
    bb, _ = poc7.crop_pad(blank_bgr, box, pad, page_w, page_h)

    radius = int(cfg["shift_search_radius_px"])
    dilate_k = int(cfg["template_dilate_kernel_px"])
    dilate_iter = int(cfg["template_dilate_iterations"])
    open_k = int(cfg["user_open_kernel_px"])
    candidates, chosen, residual_best, tcount, dilated = shift_search(
        oc, bc, radius, dilate_k, dilate_iter, open_k, inset_frac
    )

    dx, dy = chosen["dx"], chosen["dy"]
    h, w = min(oc.shape[0], bc.shape[0]), min(oc.shape[1], bc.shape[1])
    observed = oc[:h, :w]
    template_ink = bc[:h, :w]
    gray_c = og[:h, :w]
    photo_c = ob[:h, :w]
    blank_c = bb[:h, :w]
    matrix = np.array([[1, 0, dx], [0, 1, dy]], np.float32)
    shifted = cv2.warpAffine(observed, matrix, (w, h), flags=cv2.INTER_NEAREST, borderValue=0)
    shifted_gray = cv2.warpAffine(gray_c, matrix, (w, h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)

    after_sub = cv2.bitwise_and(shifted, cv2.bitwise_not(dilated[:h, :w] if dilated.shape[:2] != (h, w) else dilated))
    # dilated from shift_search already matches template size
    after_sub = cv2.bitwise_and(shifted, cv2.bitwise_not(dilated))
    after_open = after_sub
    if open_k >= 2:
        after_open = cv2.morphologyEx(after_sub, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (open_k, open_k)))
    core, core_origin = poc7.inset_view(after_open, inset_frac)
    num, labels, stats, _ = cv2.connectedComponentsWithStats((core > 0).astype(np.uint8), 8)
    line_mask = np.zeros_like(core)
    speck_mask = np.zeros_like(core)
    kept = np.zeros_like(core)
    components = []
    ch, cw = core.shape
    for i in range(1, num):
        st = stats[i]
        area = int(st[cv2.CC_STAT_AREA])
        ww, hh = int(st[cv2.CC_STAT_WIDTH]), int(st[cv2.CC_STAT_HEIGHT])
        aspect = max(ww, hh) / float(max(min(ww, hh), 1))
        rec = {
            "id": i,
            "area": area,
            "x": int(st[cv2.CC_STAT_LEFT]),
            "y": int(st[cv2.CC_STAT_TOP]),
            "w": ww,
            "h": hh,
            "aspect": aspect,
            "reason": "kept",
        }
        if poc7.is_line_like(st, cw, ch, cfg["line_aspect_ratio"], cfg["line_span_fraction"], cfg["line_thickness_px"]):
            rec["reason"] = "line-like"
            line_mask[labels == i] = 255
        elif area < cfg["min_component_area"]:
            rec["reason"] = "speck"
            speck_mask[labels == i] = 255
        else:
            kept[labels == i] = 255
        components.append(rec)

    kept_area = int(np.count_nonzero(kept))
    frac = float(kept_area) / float(core.size) if core.size else 0.0
    if kind == "checkbox":
        state, conf = poc7.classify_checkbox(frac, kept_area, cfg["checkbox"])
    else:
        state, conf = poc7.classify_text(frac, kept_area, cfg["text"])

    src_vis, src_bounds, src_quad = source_crop(oriented_bgr, registration["homography"], box, pad)

    n_obs = int(np.count_nonzero(shifted))
    n_raw = int(np.count_nonzero((shifted > 0) & (template_ink[:h, :w] > 0)))
    n_dil = int(np.count_nonzero((shifted > 0) & (dilated > 0)))
    n_surv = int(np.count_nonzero(after_sub))
    n_open = int(np.count_nonzero(after_open))
    n_inset = int(np.count_nonzero(core))

    overlay = np.zeros((h, w, 3), np.uint8)
    overlay[template_ink[:h, :w] > 0] = (255, 180, 0)
    overlay[shifted > 0] = (0, 0, 255)
    overlay[(shifted > 0) & (template_ink[:h, :w] > 0)] = (255, 255, 255)

    dil_vis = photo_c.copy()
    dil_vis[dilated > 0] = (0, 255, 255)

    cc_vis = cv2.cvtColor(core, cv2.COLOR_GRAY2BGR)
    rng = np.random.RandomState(0)
    for i in range(1, num):
        cc_vis[labels == i] = rng.randint(40, 255, 3).tolist()

    residual_context = shifted_gray.copy()
    if residual_context.ndim == 2:
        residual_context = cv2.cvtColor(residual_context, cv2.COLOR_GRAY2BGR)
    mx0, my0 = core_origin
    residual_on_full = np.zeros((h, w), np.uint8)
    residual_on_full[my0:my0 + core.shape[0], mx0:mx0 + core.shape[1]] = np.maximum(
        residual_on_full[my0:my0 + core.shape[0], mx0:mx0 + core.shape[1]], core
    )
    residual_context[residual_on_full > 0] = (0, 0, 255)
    if components:
        interesting = max(components, key=lambda c: c["area"])
        zx = max(0, mx0 + interesting["x"] - 24)
        zy = max(0, my0 + interesting["y"] - 24)
        zw = min(w - zx, interesting["w"] + 48)
        zh = min(h - zy, interesting["h"] + 48)
        residual_zoom = residual_context[zy:zy + zh, zx:zx + zw]
    else:
        residual_zoom = residual_context

    interior_gray = shifted_gray.copy()
    mx, my = core_origin
    if kind == "checkbox":
        inner = interior_gray[my:h - my or None, mx:w - mx or None]
    else:
        inner = interior_gray
    paper = interior_gray
    # darkest 15% of interior as mark proxy vs brightest 40% as paper
    if inner.size:
        dark = inner[inner <= np.percentile(inner, 20)]
        bright = inner[inner >= np.percentile(inner, 60)]
    else:
        dark = inner
        bright = inner

    case_dir = os.path.join(OUT_DIR, "{}-{}_{}".format(case["id"], case["photo"], case["field"].replace(".", "_")))
    os.makedirs(case_dir, exist_ok=True)
    stages = [
        ("01_source_photo", src_vis, "1 source crop"),
        ("02_rectified", photo_c, "2 rectified"),
        ("03_blank_template", blank_c, "3 blank PDF"),
        ("04_photo_binary", observed, "4 photo adaptive"),
        ("05_template_binary", template_ink[:h, :w], "5 template binary"),
        ("06_shift_overlay", overlay, "6 shifted overlay"),
        ("07_dilated_template", dilated, "7 dilated template"),
        ("08_after_subtraction", after_sub, "8 after subtract"),
        ("08b_after_open", after_open, "8b after morph open"),
        ("09_after_inset", core, "9 after inset"),
        ("10_cc_before", cc_vis, "10 CC before filter"),
        ("11_line_rejected", line_mask, "11 line-like rejected"),
        ("12_speck_rejected", speck_mask, "12 specks rejected"),
        ("13_kept", kept, "13 final kept"),
        ("14b_residual_zoom", residual_zoom, "zoom residual on gray"),
    ]
    tiles = []
    for name, img, title in stages:
        path = os.path.join(case_dir, name + ".png")
        save = img if img.ndim == 3 else cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
        cv2.imwrite(path, save)
        tiles.append(tile(img, title, 200 if kind == "checkbox" else 280))
    status = "PASS" if state == case["expected"] else "FAIL {}→{}".format(case["expected"], state)
    tiles.append(tile(np.full((80, 180, 3), 40, np.uint8), "14 {}  s={:.4f}".format(status, frac), 200 if kind == "checkbox" else 280))
    heat_ov = nn_scale(heatmap(candidates, "overlap_score", radius), 200)
    heat_rs = nn_scale(heatmap(candidates, "residual_after_inset", radius), 200)
    cv2.putText(heat_ov, "overlap heatmap", (4, 16), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 255, 255), 1)
    cv2.putText(heat_rs, "residual heatmap", (4, 16), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 255, 255), 1)
    # mark chosen and residual-best
    def mark_heat(img, rec, color):
        px = int((rec["dx"] + radius + 0.5) * (img.shape[1] / float(2 * radius + 1)))
        py = int((rec["dy"] + radius + 0.5) * (img.shape[0] / float(2 * radius + 1)))
        cv2.circle(img, (px, py), 4, color, 1)
        return img
    heat_ov = mark_heat(heat_ov, chosen, (0, 255, 0))
    heat_rs = mark_heat(heat_rs, residual_best, (0, 255, 255))
    tiles.append(tile(heat_ov, "shift overlap (green=chosen)", 200))
    tiles.append(tile(heat_rs, "shift residual (cyan=max)", 200))

    cols = 4
    rows = int(np.ceil(len(tiles) / float(cols)))
    th, tw = tiles[0].shape[:2]
    panel = np.full((rows * th + 8, cols * tw + 8, 3), 18, np.uint8)
    for i, t in enumerate(tiles):
        r, c = divmod(i, cols)
        panel[4 + r * th:4 + r * th + t.shape[0], 4 + c * tw:4 + c * tw + t.shape[1]] = t
    header = np.full((36, panel.shape[1], 3), 18, np.uint8)
    cv2.putText(
        header,
        "{} {} {} expected={} got={} score={:.4f}".format(
            case["id"], case["photo"], case["field"], case["expected"], state, frac
        ),
        (8, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 220, 255), 1, cv2.LINE_AA,
    )
    panel = np.vstack([header, panel])
    cv2.imwrite(os.path.join(case_dir, "panel.png"), panel)

    kept_comp = [c for c in components if c["reason"] == "kept"]
    trace = {
        "id": case["id"],
        "role": case["role"],
        "field": case["field"],
        "photo": case["photo"],
        "expected": case["expected"],
        "observed": state,
        "kind": kind,
        "crop_bounds_canonical": {
            "x": box["x"], "y": box["y"], "w": box["w"], "h": box["h"],
            "padded_origin": {"x": origin[0], "y": origin[1]},
            "padded_size": {"w": w, "h": h},
        },
        "source_crop_bounds": {"x0": src_bounds[0], "y0": src_bounds[1], "x1": src_bounds[2], "y1": src_bounds[3]},
        "source_quad": src_quad,
        "local_alignment": {
            "chosen_dx": dx,
            "chosen_dy": dy,
            "template_overlap_score": chosen["overlap_score"],
            "template_overlap_pixels": chosen["overlap"],
            "residual_maximizing_shift": residual_best,
            "chosen_residual_after_inset": chosen["residual_after_inset"],
            "max_residual_after_inset_any_shift": residual_best["residual_after_inset"] if residual_best else 0,
            "alignment_erases_mark": bool(
                chosen["residual_after_inset"] == 0 and residual_best and residual_best["residual_after_inset"] > 0
            ),
            "candidates": candidates,
        },
        "pixel_counts": {
            "source_threshold_ink": n_obs,
            "template_ink": int(np.count_nonzero(template_ink[:h, :w])),
            "dilated_template_mask": int(np.count_nonzero(dilated)),
            "obs_overlapping_raw_template": n_raw,
            "obs_overlapping_dilated_template": n_dil,
            "remaining_after_subtraction": n_surv,
            "remaining_after_morph_open": n_open,
            "remaining_after_inset": n_inset,
            "removed_line_like": int(np.count_nonzero(line_mask)),
            "removed_specks": int(np.count_nonzero(speck_mask)),
            "final_retained": kept_area,
        },
        "components": {
            "count_before_filtering": int(num - 1),
            "items": components,
            "largest_retained": max(kept_comp, key=lambda c: c["area"]) if kept_comp else None,
        },
        "photometry_shifted_gray": {
            "full_crop": gray_stats(shifted_gray),
            "inset": gray_stats(inner),
            "darkest_20pct_inset": gray_stats(dark),
            "brightest_40pct_inset": gray_stats(bright),
            "contrast_p95_minus_p05": float(np.percentile(inner, 95) - np.percentile(inner, 5)) if inner.size else None,
        },
        "binary_present_before_subtraction": n_obs > 0,
        "binary_survives_subtraction": n_surv > 0,
        "binary_survives_open": n_open > 0,
        "binary_survives_inset": n_inset > 0,
        "final": {
            "user_ink_area": kept_area,
            "user_ink_frac": frac,
            "score": frac,
            "confidence": conf,
            "classification": state,
        },
        "panel": os.path.join(case_dir, "panel.png"),
    }
    return trace


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    cfg = load_json(CFG_PATH)
    template = load_json(TEMPLATE_PATH)
    blank_bgr, blank_gray = to_bgr_gray(BLANK_PATH)
    blank_ink = poc7.adaptive_ink(blank_gray, cfg["adaptive_block_size"], cfg["adaptive_c"])
    traces = []
    for case in CASES:
        traces.append(analyze_case(case, cfg, template, blank_bgr, blank_gray, blank_ink))
        sys.stderr.write("traced {} {} {}\n".format(case["id"], case["photo"], case["field"]))
    payload = {
        "detector_config": CFG_PATH,
        "cases": traces,
    }
    json.dump(payload, open(os.path.join(OUT_DIR, "traces.json"), "w"), indent=2)
    print(json.dumps({
        "ok": True,
        "n": len(traces),
        "out": OUT_DIR,
        "summary": [
            {
                "id": t["id"],
                "photo": t["photo"],
                "field": t["field"],
                "expected": t["expected"],
                "observed": t["observed"],
                "score": t["final"]["score"],
                "shift": [t["local_alignment"]["chosen_dx"], t["local_alignment"]["chosen_dy"]],
                "alignment_erases_mark": t["local_alignment"]["alignment_erases_mark"],
                "n_obs": t["pixel_counts"]["source_threshold_ink"],
                "n_surv": t["pixel_counts"]["remaining_after_subtraction"],
                "n_open": t["pixel_counts"]["remaining_after_morph_open"],
                "n_inset": t["pixel_counts"]["remaining_after_inset"],
                "n_kept": t["pixel_counts"]["final_retained"],
                "max_alt_residual": t["local_alignment"]["max_residual_after_inset_any_shift"],
            }
            for t in traces
        ],
    }, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
