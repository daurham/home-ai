#!/usr/bin/env python3
"""POC #7E: A0 vs A1c confirmation. Does not write poc7-detector.json."""
from __future__ import print_function

import json
import os
import sys

import cv2

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "poc7d"))
import ablate  # noqa: E402
sys.path.insert(0, os.path.join(HERE, "..", "poc7"))
import detect as poc7  # noqa: E402

ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
V131 = os.path.join(ROOT, "config", "workout-v1.3.1")
CFG_PATH = os.path.join(V131, "poc7-detector.json")
TEMPLATE_PATH = os.path.join(V131, "templates", "B-1.3.1.json")
BLANK_PATH = os.path.join(V131, "artifacts", "poc7-blank-template.png")
HIST_TRUTH = os.path.join(V131, "fixtures", "poc7-benchmark-truth.json")
FRESH_TRUTH = os.path.join(V131, "fixtures", "poc7e", "checkbox-truth.json")
MANIFEST = os.path.join(V131, "fixtures", "poc7e", "manifest.json")
OUT_DIR = os.path.join(V131, "artifacts", "poc7e")

A0 = {
    "id": "A0",
    "open": 3, "open_scope": "all",
    "dilate_k": 3, "dilate_iter": 2, "dilate_scope": "all",
}
A1C = {
    "id": "A1c",
    "open": 0, "open_scope": "checkbox",
    "dilate_k": 3, "dilate_iter": 2, "dilate_scope": "all",
}


def load_json(path):
    return json.loads(open(path, "r").read())


def public_trace(photo, rec):
    return {
        "photo": photo,
        "field": rec["id"],
        "kind": rec["kind"],
        "expected": rec.get("expected"),
        "classification": rec["state"],
        "score": rec["score"],
        "binary": rec["binary"],
        "after_subtraction": rec["after_subtraction"],
        "after_open": rec["after_open"],
        "after_inset": rec["after_inset"],
        "component_areas": rec["component_areas"],
        "kept_area": rec["kept_area"],
        "user_ink_frac": rec["user_ink_frac"],
    }


def detect_photo(rectified_path, cfg, template, blank_ink, page_w, page_h, variant, checkbox_truth):
    observed = cv2.imread(rectified_path, cv2.IMREAD_COLOR)
    if observed is None:
        raise RuntimeError("missing rectified " + rectified_path)
    gray = cv2.cvtColor(observed, cv2.COLOR_BGR2GRAY)
    obs_ink = poc7.adaptive_ink(gray, cfg["adaptive_block_size"], cfg["adaptive_c"])
    fields = {}
    for item in template["fields"]:
        kind = "checkbox" if item["kind"] == "checkbox" else "text"
        open_k, dilate_k, dilate_iter = ablate.kernels_for_field(kind, variant)
        rec = ablate.measure_field(
            obs_ink, blank_ink, item["px"], cfg, kind, page_w, page_h,
            open_k, dilate_k, dilate_iter,
        )
        rec["_rect_crop"] = poc7.crop_pad(observed, item["px"], int(cfg["crop_pad_px"]), page_w, page_h)[0]
        rec["id"] = item["id"]
        if kind == "checkbox":
            rec["expected"] = checkbox_truth[item["id"]]
        fields[item["id"]] = rec
    return fields


def flatten_cb(photo_id, fields):
    rows = []
    for rec in fields.values():
        if rec["kind"] != "checkbox":
            continue
        item = {k: v for k, v in rec.items() if not k.startswith("_")}
        item["photo"] = photo_id
        rows.append(item)
    return rows


def text_map(fields):
    return {fid: rec["state"] for fid, rec in fields.items() if rec["kind"] == "text"}


def score_rows(rows):
    st = ablate.checkbox_stats(rows)
    st["false_checked"] = st["unchecked_to_checked"]
    st["false_unchecked"] = st["checked_to_unchecked"]
    return st


def disagreement(a0, a1c, photo_id):
    rows = []
    for fid, rec0 in a0.items():
        rec1 = a1c[fid]
        if rec0["state"] == rec1["state"] and rec0["kind"] != "checkbox":
            continue
        if rec0["kind"] == "checkbox" and rec0["state"] == rec1["state"]:
            continue
        if rec0["kind"] != "checkbox":
            if rec0["state"] != rec1["state"]:
                rows.append({
                    "photo": photo_id,
                    "field": fid,
                    "kind": "text",
                    "A0": rec0["state"],
                    "A0_score": rec0["score"],
                    "A1c": rec1["state"],
                    "A1c_score": rec1["score"],
                })
            continue
        rows.append({
            "photo": photo_id,
            "field": fid,
            "kind": "checkbox",
            "ground_truth": rec0["expected"],
            "A0_classification": rec0["state"],
            "A0_score": rec0["score"],
            "A1c_classification": rec1["state"],
            "A1c_score": rec1["score"],
            "A0": public_trace(photo_id, rec0),
            "A1c": public_trace(photo_id, rec1),
        })
    return rows


def a1c_errors(photo_id, fields):
    out = []
    for rec in fields.values():
        if rec["kind"] != "checkbox":
            continue
        if rec["state"] != rec["expected"]:
            out.append(public_trace(photo_id, rec))
    return out


def write_panel(path, title, rec0, rec1):
    rec1 = dict(rec1)
    rec1["variant_id"] = "A1c"
    ablate.save_panel(path, title, rec0, rec1)


def fmt_stats(st):
    return {
        "correct": "{}/{}".format(st["correct"], st["total"]),
        "checked_recall": st["checked_recall"],
        "unchecked_specificity": st["unchecked_specificity"],
        "false_checked": st["false_checked"],
        "false_unchecked": st["false_unchecked"],
        "uncertain": st["uncertain"],
        "checked_to_unchecked": st["checked_to_unchecked"],
        "unchecked_to_checked": st["unchecked_to_checked"],
        "checked_to_uncertain": st["checked_to_uncertain"],
        "unchecked_to_uncertain": st["unchecked_to_uncertain"],
    }


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    cfg = load_json(CFG_PATH)
    template = load_json(TEMPLATE_PATH)
    fresh_truth = load_json(FRESH_TRUTH)
    hist_truth = load_json(HIST_TRUTH)
    manifest = load_json(MANIFEST)
    blank = cv2.imread(BLANK_PATH, cv2.IMREAD_COLOR)
    page_h, page_w = blank.shape[:2]
    blank_ink = poc7.adaptive_ink(cv2.cvtColor(blank, cv2.COLOR_BGR2GRAY), cfg["adaptive_block_size"], cfg["adaptive_c"])

    photo_status = json.loads(open(os.path.join(OUT_DIR, "registration-status.json")).read()) if os.path.exists(os.path.join(OUT_DIR, "registration-status.json")) else {}

    fresh_a0_rows = []
    fresh_a1c_rows = []
    per_photo = []
    disagreements = []
    errors_a1c = []
    text_identical = True
    text_diffs = []
    panels = []
    panel_dir = os.path.join(OUT_DIR, "panels")
    os.makedirs(panel_dir, exist_ok=True)

    for slug in fresh_truth["photos"]:
        rect = os.path.join(OUT_DIR, "photos", slug, "rectified.png")
        reg = photo_status.get(slug, {})
        if not reg.get("ok"):
            per_photo.append({
                "photo": slug,
                "registration": "FAIL",
                "A0": None,
                "A1c": None,
                "error": reg.get("error") or "registration failed",
            })
            continue
        a0_fields = detect_photo(rect, cfg, template, blank_ink, page_w, page_h, A0, fresh_truth["checkboxes"])
        a1c_fields = detect_photo(rect, cfg, template, blank_ink, page_w, page_h, A1C, fresh_truth["checkboxes"])
        if text_map(a0_fields) != text_map(a1c_fields):
            text_identical = False
            for fid in text_map(a0_fields):
                if a0_fields[fid]["state"] != a1c_fields[fid]["state"]:
                    text_diffs.append({
                        "photo": slug, "field": fid,
                        "A0": a0_fields[fid]["state"], "A1c": a1c_fields[fid]["state"],
                    })
        r0 = flatten_cb(slug, a0_fields)
        r1 = flatten_cb(slug, a1c_fields)
        fresh_a0_rows.extend(r0)
        fresh_a1c_rows.extend(r1)
        dis = disagreement(a0_fields, a1c_fields, slug)
        disagreements.extend(dis)
        err = a1c_errors(slug, a1c_fields)
        errors_a1c.extend(err)
        for item in dis:
            if item["kind"] != "checkbox":
                continue
            name = "disagree-{}-{}.png".format(slug, item["field"].replace(".", "_"))
            write_panel(
                os.path.join(panel_dir, name),
                "{} {} GT={} A0={} A1c={}".format(
                    slug, item["field"], item["ground_truth"],
                    item["A0_classification"], item["A1c_classification"],
                ),
                a0_fields[item["field"]], a1c_fields[item["field"]],
            )
            panels.append(name)
        for rec in err:
            name = "a1c-error-{}-{}.png".format(slug, rec["field"].replace(".", "_"))
            if name in panels:
                continue
            write_panel(
                os.path.join(panel_dir, name),
                "{} {} GT={} A1c={}".format(slug, rec["field"], rec["expected"], rec["classification"]),
                a0_fields[rec["field"]], a1c_fields[rec["field"]],
            )
            panels.append(name)
        per_photo.append({
            "photo": slug,
            "registration": "PASS",
            "A0": score_rows(r0),
            "A1c": score_rows(r1),
        })

    hist_a0 = []
    hist_a1c = []
    hist_text_identical = True
    for photo in ablate.PHOTOS:
        a0_fields = detect_photo(photo["rectified"], cfg, template, blank_ink, page_w, page_h, A0, hist_truth["checkboxes"])
        a1c_fields = detect_photo(photo["rectified"], cfg, template, blank_ink, page_w, page_h, A1C, hist_truth["checkboxes"])
        if text_map(a0_fields) != text_map(a1c_fields):
            hist_text_identical = False
        hist_a0.extend(flatten_cb(photo["id"], a0_fields))
        hist_a1c.extend(flatten_cb(photo["id"], a1c_fields))

    a0s = score_rows(fresh_a0_rows)
    a1s = score_rows(fresh_a1c_rows)
    hist_a0s = score_rows(hist_a0)
    hist_a1s = score_rows(hist_a1c)

    a0_ok = {(r["photo"], r["id"]) for r in fresh_a0_rows if r["state"] == r["expected"]}
    a1_ok = {(r["photo"], r["id"]) for r in fresh_a1c_rows if r["state"] == r["expected"]}
    lost = sorted(a0_ok - a1_ok)
    recovered = sorted(a1_ok - a0_ok)
    false_checked_a1c = [public_trace(r["photo"], r) for r in fresh_a1c_rows if r["expected"] == "unchecked" and r["state"] == "checked"]
    new_false_checked_vs_a0 = [
        public_trace(r["photo"], r) for r in fresh_a1c_rows
        if r["expected"] == "unchecked" and r["state"] == "checked"
        and next(x for x in fresh_a0_rows if x["photo"] == r["photo"] and x["id"] == r["id"])["state"] != "checked"
    ]

    promote = (
        len(new_false_checked_vs_a0) == 0
        and a1s["unchecked_specificity"] >= a0s["unchecked_specificity"]
        and len(lost) == 0
        and text_identical
        and hist_a1s["correct"] == 189
        and hist_a1s["unchecked_to_checked"] == 0
        and hist_a1s["uncertain"] == 0
        and hist_text_identical
    )
    block = []
    if new_false_checked_vs_a0:
        block.append("A1c introduced false checked states relative to A0")
    if a1s["unchecked_specificity"] < a0s["unchecked_specificity"]:
        block.append("unchecked specificity dropped")
    if lost:
        block.append("A1c lost checkbox(es) A0 got right: " + ", ".join("{} {}".format(p, f) for p, f in lost))
    if not text_identical:
        block.append("text outputs differ — A1c implementation bug")
    if not (hist_a1s["correct"] == 189 and hist_a1s["unchecked_to_checked"] == 0 and hist_a1s["uncertain"] == 0 and hist_text_identical):
        block.append("historical A1c regression failed (expected 189/189, 0 false checked, 0 uncertain, text identical)")

    payload = {
        "frozen_sha256": "b8a96560893d1c9906c01d6bc67ea66bd788d3ea411f9f4cd7a0585605f9ea80",
        "manifest": manifest,
        "fresh": {
            "photos_attempted": fresh_truth["photos"],
            "photos_registered": [p["photo"] for p in per_photo if p["registration"] == "PASS"],
            "checkbox_labels": a0s["total"],
            "checked_labels": a0s["n_checked_labels"],
            "unchecked_labels": a0s["n_unchecked_labels"],
            "A0": a0s,
            "A1c": a1s,
            "per_photo": per_photo,
            "disagreements": disagreements,
            "a1c_errors": errors_a1c,
            "lost_vs_A0": [{"photo": p, "field": f} for p, f in lost],
            "recovered_vs_A0": [{"photo": p, "field": f} for p, f in recovered],
            "false_checked_A1c": false_checked_a1c,
            "new_false_checked_vs_A0": new_false_checked_vs_a0,
            "text_identical": text_identical,
            "text_diffs": text_diffs,
        },
        "historical": {
            "A0": hist_a0s,
            "A1c": hist_a1s,
            "text_identical": hist_text_identical,
            "expected_a1c_correct": 189,
        },
        "promotion": {
            "recommend": promote,
            "blockers": block,
        },
        "panels": panels,
    }
    json.dump(payload, open(os.path.join(OUT_DIR, "results.json"), "w"), indent=2)

    lines = []
    lines.append("# POC #7E — Fresh-Photo Confirmation of A1c")
    lines.append("")
    lines.append("Production detector was not modified. SHA256 `{}`.".format(payload["frozen_sha256"]))
    lines.append("")
    lines.append("Fresh photos (Routine B scored): {}".format(len(payload["fresh"]["photos_registered"])))
    lines.append("Fresh checkbox labels: {}".format(a0s["total"]))
    lines.append("Fresh checked labels: {}".format(a0s["n_checked_labels"]))
    lines.append("Fresh unchecked labels: {}".format(a0s["n_unchecked_labels"]))
    lines.append("")
    lines.append("Excluded (wrong routine for B-1.3.1 detector): " + ", ".join(
        "{} ({})".format(x["photo"], x["routine"]) for x in manifest["excluded_from_confirmation"]
    ))
    lines.append("")
    lines.append("| | A0 | A1c |")
    lines.append("| --- | --- | --- |")
    lines.append("| correct | {}/{} | {}/{} |".format(a0s["correct"], a0s["total"], a1s["correct"], a1s["total"]))
    lines.append("| checked recall | {:.3f} | {:.3f} |".format(a0s["checked_recall"], a1s["checked_recall"]))
    lines.append("| unchecked specificity | {:.3f} | {:.3f} |".format(a0s["unchecked_specificity"], a1s["unchecked_specificity"]))
    lines.append("| false checked | {} | {} |".format(a0s["false_checked"], a1s["false_checked"]))
    lines.append("| false unchecked | {} | {} |".format(a0s["false_unchecked"], a1s["false_unchecked"]))
    lines.append("| uncertain | {} | {} |".format(a0s["uncertain"], a1s["uncertain"]))
    lines.append("")
    lines.append("## Per-photo")
    lines.append("")
    for p in per_photo:
        lines.append("### {}".format(p["photo"]))
        if p["registration"] != "PASS":
            lines.append("")
            lines.append("Registration FAIL: {}".format(p.get("error")))
            lines.append("")
            continue
        lines.append("")
        lines.append("- A0 {} recall={:.3f} spec={:.3f} false_checked={} uncertain={}".format(
            "{}/{}".format(p["A0"]["correct"], p["A0"]["total"]),
            p["A0"]["checked_recall"], p["A0"]["unchecked_specificity"],
            p["A0"]["false_checked"], p["A0"]["uncertain"],
        ))
        lines.append("- A1c {} recall={:.3f} spec={:.3f} false_checked={} uncertain={}".format(
            "{}/{}".format(p["A1c"]["correct"], p["A1c"]["total"]),
            p["A1c"]["checked_recall"], p["A1c"]["unchecked_specificity"],
            p["A1c"]["false_checked"], p["A1c"]["uncertain"],
        ))
        lines.append("")
    lines.append("## A0 vs A1c disagreements")
    lines.append("")
    if not disagreements:
        lines.append("None.")
        lines.append("")
    else:
        for d in disagreements:
            if d["kind"] == "text":
                lines.append("- TEXT {} {} A0={} A1c={}".format(d["photo"], d["field"], d["A0"], d["A1c"]))
                continue
            lines.append(
                "- {} {} GT={} A0={} ({:.4f}) A1c={} ({:.4f}) sub={} open0={} open1c={} kept0={} kept1c={}".format(
                    d["photo"], d["field"], d["ground_truth"],
                    d["A0_classification"], d["A0_score"], d["A1c_classification"], d["A1c_score"],
                    d["A0"]["after_subtraction"], d["A0"]["after_open"], d["A1c"]["after_open"],
                    d["A0"]["kept_area"], d["A1c"]["kept_area"],
                )
            )
        lines.append("")
    lines.append("## Historical regression (not in confirmation score)")
    lines.append("")
    lines.append("- A0 checkboxes {}  A1c {}".format(
        "{}/{}".format(hist_a0s["correct"], hist_a0s["total"]),
        "{}/{}".format(hist_a1s["correct"], hist_a1s["total"]),
    ))
    lines.append("- A1c false checked {} uncertain {} text_identical {}".format(
        hist_a1s["unchecked_to_checked"], hist_a1s["uncertain"], hist_text_identical,
    ))
    lines.append("")
    lines.append("## Answers")
    lines.append("")
    lines.append("1. Did A1c introduce any false checked states? {}".format(
        "Yes: " + json.dumps([x["photo"] + " " + x["field"] for x in new_false_checked_vs_a0]) if new_false_checked_vs_a0 else "No."
    ))
    lines.append("")
    lines.append("2. Did A1c lose any checkbox that A0 got right? {}".format(
        "Yes: " + ", ".join("{} {}".format(p, f) for p, f in lost) if lost else "No."
    ))
    lines.append("")
    lines.append("3. Did A1c recover any checkbox that A0 missed? {}".format(
        "Yes: " + ", ".join("{} {}".format(p, f) for p, f in recovered) if recovered else "No."
    ))
    lines.append("")
    lines.append("4. Are text outputs exactly identical? {}".format("Yes." if text_identical else "NO — " + json.dumps(text_diffs)))
    lines.append("")
    lines.append("5. Did historical regression behavior remain intact? {}".format(
        "Yes (A1c {}/189, false_checked={}, uncertain={}, text_identical={}).".format(
            hist_a1s["correct"], hist_a1s["unchecked_to_checked"], hist_a1s["uncertain"], hist_text_identical,
        ) if hist_a1s["correct"] == 189 and hist_a1s["unchecked_to_checked"] == 0 and hist_a1s["uncertain"] == 0 and hist_text_identical
        else "No: A1c {}/189 false_checked={} uncertain={} text_identical={}.".format(
            hist_a1s["correct"], hist_a1s["unchecked_to_checked"], hist_a1s["uncertain"], hist_text_identical,
        )
    ))
    lines.append("")
    lines.append("6. Does the fresh evidence support promoting A1c? {}".format("Yes, recommend promotion review." if promote else "No."))
    lines.append("")
    lines.append("7. If not, what exact failure blocks promotion? {}".format(
        "; ".join(block) if block else "Nothing on this set; still do not auto-promote — review first."
    ))
    lines.append("")
    if promote:
        lines.append("## Proposed production change (NOT APPLIED)")
        lines.append("")
        lines.append("Keep a frozen open kernel for text; skip morphological open only when `kind == checkbox`.")
        lines.append("")
        lines.append("Proposed `poc7-detector.json` addition:")
        lines.append("")
        lines.append("```json")
        lines.append('{')
        lines.append('  "user_open_kernel_px": 3,')
        lines.append('  "checkbox_user_open_kernel_px": 0,')
        lines.append('  "text_user_open_kernel_px": 3')
        lines.append('}')
        lines.append("```")
        lines.append("")
        lines.append("Implementation in `detect.py` `measure_field`: after template subtraction, apply ellipse open iff `int(cfg[kind + '_user_open_kernel_px'] if present else cfg['user_open_kernel_px']) >= 2`. Checkbox uses 0 (skip); text uses 3 (frozen).")
        lines.append("")
        lines.append("Tests to add: SHA256 of the new config; A1c vs A0 text identity on the 7D fixtures; 189/189 historical checkboxes; freeze-check that `text_user_open_kernel_px` stays 3.")
        lines.append("")
        lines.append("Versioning: compute a new frozen SHA256 **after** review approval; do not reuse the A0 hash. Bump an explicit detector version comment in the json.")
        lines.append("")
    lines.append("## STOP")
    lines.append("")
    lines.append("No production config change. No frozen SHA replacement. No handwriting recognition.")
    lines.append("")
    open(os.path.join(OUT_DIR, "REPORT.md"), "w").write("\n".join(lines))
    print(json.dumps({
        "ok": True,
        "fresh_correct_A0": a0s["correct"],
        "fresh_correct_A1c": a1s["correct"],
        "fresh_total": a0s["total"],
        "text_identical": text_identical,
        "promote": promote,
        "hist_A1c": hist_a1s["correct"],
        "recovered": recovered,
        "lost": lost,
        "false_checked": len(false_checked_a1c),
    }, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
