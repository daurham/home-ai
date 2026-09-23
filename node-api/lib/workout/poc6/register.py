#!/usr/bin/env python3
"""POC #6 ArUco registration helper. Invoked by Node; not a transcription pipeline."""
from __future__ import print_function

import argparse
import json
import math
import os
import sys

import cv2
import numpy as np


REQUIRED_IDS = (10, 11, 12, 13)
ROLE = {10: "TL", 11: "TR", 12: "BR", 13: "BL"}
CANONICAL_W = 1700
CANONICAL_H = 2200
CANONICAL_DPI = 200
DICT_NAME = "DICT_4X4_50"
MARKER_COLORS = {
    10: (0, 200, 0),
    11: (255, 140, 0),
    12: (0, 0, 255),
    13: (255, 0, 255),
}


def detect_markers(bgr):
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    dictionary = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
    params = cv2.aruco.DetectorParameters()
    if hasattr(cv2.aruco, "ArucoDetector"):
        detector = cv2.aruco.ArucoDetector(dictionary, params)
        corners, ids, rejected = detector.detectMarkers(gray)
    else:
        corners, ids, rejected = cv2.aruco.detectMarkers(gray, dictionary, parameters=params)
    found = {}
    if ids is not None:
        for marker_id, corner in zip(ids.flatten().tolist(), corners):
            pts = corner.reshape(-1, 2).astype(np.float64)
            found[int(marker_id)] = pts
    return found, 0 if rejected is None else len(rejected)


def marker_payload(found, image_shape):
    h, w = image_shape[:2]
    markers = []
    for marker_id in sorted(found):
        pts = found[marker_id]
        center = pts.mean(axis=0)
        markers.append({
            "id": marker_id,
            "role": ROLE.get(marker_id),
            "corners": [[float(x), float(y)] for x, y in pts],
            "center": [float(center[0]), float(center[1])],
            "width_px": float(np.linalg.norm(pts[0] - pts[1])),
            "height_px": float(np.linalg.norm(pts[0] - pts[3])),
        })
    return {
        "image_width": int(w),
        "image_height": int(h),
        "detected_ids": [m["id"] for m in markers],
        "all_four_required_detected": all(i in found for i in REQUIRED_IDS),
        "markers": markers,
    }


def template_dest_points(template):
    dest = []
    src_order = []
    for marker_id in REQUIRED_IDS:
        corners = template["aruco"]["markers"][str(marker_id)]["corners"]
        dest.append(np.array(corners, dtype=np.float64))
        src_order.append(marker_id)
    return src_order, np.concatenate(dest).astype(np.float32)


def compute_homography(found, template):
    src_ids, dest = template_dest_points(template)
    src = np.concatenate([found[i] for i in src_ids]).astype(np.float32)
    matrix, _mask = cv2.findHomography(src, dest, 0)
    if matrix is None:
        raise RuntimeError("findHomography failed")
    return matrix, src, dest


def draw_registration_debug(bgr, found, matrix, template):
    vis = bgr.copy()
    for marker_id, pts in found.items():
        color = MARKER_COLORS.get(marker_id, (0, 255, 255))
        poly = np.round(pts).astype(np.int32)
        cv2.polylines(vis, [poly], True, color, 3, cv2.LINE_AA)
        center = tuple(np.round(pts.mean(axis=0)).astype(int))
        cv2.circle(vis, center, 6, color, -1, cv2.LINE_AA)
        label = "{} {}".format(marker_id, ROLE.get(marker_id, "?"))
        cv2.putText(vis, label, (center[0] + 10, center[1] - 10),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.8, color, 2, cv2.LINE_AA)
    page = np.array([
        [0, 0],
        [CANONICAL_W - 1, 0],
        [CANONICAL_W - 1, CANONICAL_H - 1],
        [0, CANONICAL_H - 1],
    ], dtype=np.float32).reshape(-1, 1, 2)
    inv = np.linalg.inv(matrix)
    mapped = cv2.perspectiveTransform(page, inv).reshape(-1, 2)
    cv2.polylines(vis, [np.round(mapped).astype(np.int32)], True, (0, 255, 255), 2, cv2.LINE_AA)
    cv2.putText(vis, "page quad via ArUco homography", (20, 40),
                cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 255, 255), 2, cv2.LINE_AA)
    return vis


def draw_field_overlay(rectified, template):
    vis = rectified.copy()
    for item in template["fields"]:
        box = item["px"]
        x, y, w, h = box["x"], box["y"], box["w"], box["h"]
        color = (0, 180, 0) if item["kind"] == "checkbox" else (0, 0, 220)
        cv2.rectangle(vis, (x, y), (x + w, y + h), color, 2, cv2.LINE_AA)
        label = item["id"]
        ty = y - 4 if y > 18 else y + h + 16
        cv2.putText(vis, label, (x, ty), cv2.FONT_HERSHEY_SIMPLEX, 0.38, color, 1, cv2.LINE_AA)
    return vis


def draw_contact_sheet(rectified, template, cols=8, cell_w=190, cell_h=110):
    fields = template["fields"]
    rows = int(math.ceil(float(len(fields)) / cols))
    sheet = np.full((rows * cell_h + 20, cols * cell_w + 20, 3), 245, dtype=np.uint8)
    rh, rw = rectified.shape[:2]
    for i, item in enumerate(fields):
        r, c = divmod(i, cols)
        box = item["px"]
        x, y, w, h = box["x"], box["y"], box["w"], box["h"]
        x0 = max(0, x)
        y0 = max(0, y)
        x1 = min(rw, x + w)
        y1 = min(rh, y + h)
        crop = rectified[y0:y1, x0:x1]
        if crop.size == 0:
            crop = np.full((40, 80, 3), 200, dtype=np.uint8)
        ox = 10 + c * cell_w
        oy = 10 + r * cell_h
        cv2.rectangle(sheet, (ox, oy), (ox + cell_w - 6, oy + cell_h - 6), (210, 210, 210), -1)
        cv2.putText(sheet, item["id"], (ox + 4, oy + 14),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.35, (20, 20, 20), 1, cv2.LINE_AA)
        avail_w = cell_w - 14
        avail_h = cell_h - 28
        ch, cw = crop.shape[:2]
        scale = min(float(avail_w) / max(cw, 1), float(avail_h) / max(ch, 1))
        nw, nh = max(1, int(cw * scale)), max(1, int(ch * scale))
        resized = cv2.resize(crop, (nw, nh), interpolation=cv2.INTER_AREA)
        px = ox + 4
        py = oy + 20
        sheet[py:py + nh, px:px + nw] = resized
    return sheet


def run(image_path, template_path, out_dir):
    template = json.loads(open(template_path, "r").read())
    bgr = cv2.imread(image_path, cv2.IMREAD_COLOR)
    if bgr is None:
        raise RuntimeError("could not read image: {}".format(image_path))

    found, n_rejected = detect_markers(bgr)
    detection = marker_payload(found, bgr.shape)
    detection["dictionary"] = DICT_NAME
    detection["rejected_candidates"] = n_rejected
    detection["canonical"] = {
        "width": CANONICAL_W,
        "height": CANONICAL_H,
        "dpi": CANONICAL_DPI,
    }

    os.makedirs(out_dir, exist_ok=True)
    debug_path = os.path.join(out_dir, "poc6-registration-debug.png")

    if not detection["all_four_required_detected"]:
        vis = bgr.copy()
        for marker_id, pts in found.items():
            color = MARKER_COLORS.get(marker_id, (0, 255, 255))
            cv2.polylines(vis, [np.round(pts).astype(np.int32)], True, color, 3)
            center = tuple(np.round(pts.mean(axis=0)).astype(int))
            cv2.putText(vis, str(marker_id), center, cv2.FONT_HERSHEY_SIMPLEX, 1.0, color, 2)
        cv2.putText(vis, "MISSING MARKERS: {}".format(
            [i for i in REQUIRED_IDS if i not in found]
        ), (20, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 0, 255), 2)
        cv2.imwrite(debug_path, vis)
        detection["ok"] = False
        detection["error"] = "required ArUco IDs 10/11/12/13 not all detected"
        detection["debug_image"] = debug_path
        return detection

    matrix, _src, _dest = compute_homography(found, template)
    rectified = cv2.warpPerspective(
        bgr, matrix, (CANONICAL_W, CANONICAL_H),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(0, 0, 0),
    )
    debug = draw_registration_debug(bgr, found, matrix, template)
    overlay = draw_field_overlay(rectified, template)
    crops = draw_contact_sheet(rectified, template)

    rect_path = os.path.join(out_dir, "poc6-rectified.png")
    overlay_path = os.path.join(out_dir, "poc6-field-overlay.png")
    crops_path = os.path.join(out_dir, "poc6-field-crops.png")
    cv2.imwrite(debug_path, debug)
    cv2.imwrite(rect_path, rectified)
    cv2.imwrite(overlay_path, overlay)
    cv2.imwrite(crops_path, crops)

    rh, rw = rectified.shape[:2]
    detection.update({
        "ok": True,
        "homography": [[float(v) for v in row] for row in matrix],
        "homography_method": "16-point findHomography mapping observed marker corners to PDF template corners",
        "canonical_width": rw,
        "canonical_height": rh,
        "field_count": len(template["fields"]),
        "artifacts": {
            "registration_debug": debug_path,
            "rectified": rect_path,
            "field_overlay": overlay_path,
            "field_crops": crops_path,
        },
    })
    return detection


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--template", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args(argv)
    result = run(args.image, args.template, args.out)
    json.dump(result, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0 if result.get("ok") else 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
