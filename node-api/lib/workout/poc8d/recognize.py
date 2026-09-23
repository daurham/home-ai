#!/usr/bin/env python3
"""POC #8D independent recognizer: microsoft/trocr-small-handwritten.

One general pipeline for every crop:
  frozen #8B clean.png → PIL RGB → official TrOCRProcessor (384×384) → greedy generate.

No field-specific ops, no GT-guided segmentation, no Granite.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path

import torch
from PIL import Image
from transformers import TrOCRProcessor, VisionEncoderDecoderModel

MODEL_ID = "microsoft/trocr-small-handwritten"
MAX_NEW_TOKENS = 16


def sequence_confidence(gen) -> dict:
    scores = gen.scores
    if scores is None or len(scores) == 0:
        return {
            "n_tokens": 0,
            "mean_token_prob": None,
            "min_token_prob": None,
            "geom_mean_token_prob": None,
            "seq_logprob": None,
        }
    seq = gen.sequences[0]
    token_ids = seq[-len(scores) :]
    probs = []
    logps = []
    for logits, tid in zip(scores, token_ids):
        p = torch.softmax(logits[0].float(), dim=-1)
        pr = float(p[int(tid.item())])
        probs.append(pr)
        logps.append(math.log(max(pr, 1e-12)))
    geom = math.exp(sum(logps) / len(logps))
    return {
        "n_tokens": len(probs),
        "mean_token_prob": sum(probs) / len(probs),
        "min_token_prob": min(probs),
        "geom_mean_token_prob": geom,
        "seq_logprob": sum(logps),
    }


def load_model(model_id: str, device: torch.device):
    processor = TrOCRProcessor.from_pretrained(model_id, use_fast=False)
    model = VisionEncoderDecoderModel.from_pretrained(model_id)
    model.to(device)
    model.eval()
    return processor, model


def recognize_one(processor, model, crop_path: str, device: torch.device) -> dict:
    t0 = time.perf_counter()
    image = Image.open(crop_path).convert("RGB")
    pixel_values = processor(images=image, return_tensors="pt").pixel_values.to(device)
    with torch.inference_mode():
        gen = model.generate(
            pixel_values,
            max_new_tokens=MAX_NEW_TOKENS,
            num_beams=1,
            do_sample=False,
            return_dict_in_generate=True,
            output_scores=True,
        )
    raw = processor.batch_decode(gen.sequences, skip_special_tokens=True)[0]
    elapsed_ms = (time.perf_counter() - t0) * 1000.0
    return {
        "raw": raw,
        "latency_ms": elapsed_ms,
        "confidence": sequence_confidence(gen),
        "source_size": [int(image.size[0]), int(image.size[1])],
        "source_mode": image.mode,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--job", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    job = json.loads(Path(args.job).read_text())
    model_id = job.get("model_id") or MODEL_ID
    cache_path = Path(job["cache_path"])
    samples = job["samples"]
    cache = {}
    if cache_path.exists():
        cache = json.loads(cache_path.read_text())

    device = torch.device("cpu")
    torch.set_num_threads(max(1, min(8, torch.get_num_threads())))
    print(f"loading {model_id} on {device}", file=sys.stderr, flush=True)
    processor, model = load_model(model_id, device)
    print("model loaded", file=sys.stderr, flush=True)

    results = []
    started = time.perf_counter()
    for i, sample in enumerate(samples):
        sid = sample["sample_id"]
        if sid in cache and cache[sid].get("model_id") == model_id and cache[sid].get("raw") is not None:
            row = cache[sid]
            results.append(row)
            if (i + 1) % 25 == 0 or i + 1 == len(samples):
                print(f"cached {i + 1}/{len(samples)} {sid}", file=sys.stderr, flush=True)
            continue
        try:
            rec = recognize_one(processor, model, sample["crop"], device)
            row = {
                "sample_id": sid,
                "crop": sample["crop"],
                "model_id": model_id,
                "raw": rec["raw"],
                "latency_ms": rec["latency_ms"],
                "confidence": rec["confidence"],
                "source_size": rec["source_size"],
                "source_mode": rec["source_mode"],
                "error": None,
            }
        except Exception as exc:
            row = {
                "sample_id": sid,
                "crop": sample["crop"],
                "model_id": model_id,
                "raw": "",
                "latency_ms": None,
                "confidence": None,
                "source_size": None,
                "source_mode": None,
                "error": str(exc),
            }
        cache[sid] = row
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(json.dumps(cache))
        results.append(row)
        print(
            f"rec {i + 1}/{len(samples)} {sid} -> {row.get('raw')!r} {row.get('latency_ms')}",
            file=sys.stderr,
            flush=True,
        )

    payload = {
        "model_id": model_id,
        "device": str(device),
        "preprocess": {
            "crop": "frozen poc8b clean.png, geometry unchanged",
            "color": "PIL Image.convert('RGB')",
            "model_input": "TrOCRProcessor.from_pretrained(..., use_fast=False) official resize/normalize to 384x384",
            "decode": "greedy generate max_new_tokens=16, num_beams=1, do_sample=False",
            "no_field_specific_ops": True,
        },
        "runtime_ms": (time.perf_counter() - started) * 1000.0,
        "results": results,
    }
    Path(args.out).write_text(json.dumps(payload, indent=2))
    print(json.dumps({"ok": True, "n": len(results), "out": args.out}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
