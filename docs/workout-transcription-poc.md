# Workout transcription POC

Local Ollama proof of concept. Default model: **llama3.2-vision:11b** via `/api/chat`. Failures are returned, not repaired.

## POC #7B — frozen-detector multi-photo generalization (current)

POC #7 is **approved and frozen**. `poc7-detector.json` SHA256 `b8a96560893d1c9906c01d6bc67ea66bd788d3ea411f9f4cd7a0585605f9ea80` was verified before and after this run. No thresholds were retuned.

Six new photos of the **same completed sheet** (IMG_1305–1310) each independently: ArUco register → 1700×2200 → frozen detector → existing POC #7 truth.

```bash
cd node-api
npm test
npm run benchmark:poc7b
```

| | |
| --- | --- |
| Photos | 6 |
| Registration | **6/6 PASS** |
| Checkboxes | **159/162 (98.1%)**, uncertain=1 |
| Blank/nonblank | **269/270 (99.6%)**, uncertain=1 |

Mismatches (not fixed):

- `B04.S2.BW` IMG_1307: checked → unchecked (score 0)
- `B04.S2.BW` IMG_1308: checked → uncertain (score 0.0154, area below checked min)
- `header.effort.5` IMG_1310: checked → unchecked (score 0)
- `note.quick_note` IMG_1310: blank → uncertain (score 0.00061)

Recurring weak field: **B04.S2.BW** (2/6 photos). Weakest *correct* checked was `header.pain.2` on IMG_1310 at 0.0179 vs floor 0.015.

**STOP.** Do not start POC #8 or retune until this report is reviewed.

Report: `node-api/config/workout-v1.3.1/artifacts/poc7b/REPORT.md`  
Artifacts: `node-api/config/workout-v1.3.1/artifacts/poc7b/<IMG_*>/`

## POC #7 — checkbox + blank/nonblank detection

POC #6 registration is frozen. This stage classifies known crops only: **checked / unchecked / uncertain** and **blank / nonblank / uncertain**. No OCR, digits, Ollama, or canonical JSON.

**Algorithm:** rasterize the blank PDF to 1700×2200. For each B-1.3.1 field, adaptive-threshold both the blank crop and the POC #6 rectified crop. Search a small integer translation that **maximizes overlap with known printed ink**, dilate the template mask, subtract it, drop thin line-like leftovers, and score remaining blob area/fraction. Thresholds live in `config/workout-v1.3.1/poc7-detector.json` and were chosen on **this one fixture**.

```bash
cd node-api
npm test
npm run poc7
```

| Item | This fixture |
| --- | --- |
| Checkboxes | **27/27 (100%)**, uncertain=0 |
| Blank/nonblank | **45/45 (100%)**, uncertain=0 |
| Mismatches | none |
| Errors | checked→unchecked 0, unchecked→checked 0, blank→nonblank 0, nonblank→blank 0 |

This is **not** a generalization claim. Next photographs (lighting, pen, perspective) will show whether the thresholds hold.

Limitations: a faint BW X (B04 S2) sits near `checked_min_frac=0.015`. Grid-hugging handwriting (B02 S1 “10”) is nonblank because leftover printed lines are rejected, but a mark that is *only* a grid-line-shaped stroke could be dropped. Local shift search is ±8 px, not a new page homography.

**STOP** for visual approval of the original fixture. POC #7B is the out-of-sample test; do not retune `poc7-detector.json` from new photos until that report is reviewed.

Artifact paths (under `node-api/config/workout-v1.3.1/`):

- `artifacts/poc7-blank-template.png`
- `artifacts/poc7-observations.json`
- `artifacts/poc7-checkbox-debug.png`
- `artifacts/poc7-blank-debug.png`
- `artifacts/poc7-difference-debug.png`
- `poc7-detector.json`
- `fixtures/poc7-benchmark-truth.json` (scoring only; detector never reads it)

## POC #6 — v1.3.1 page registration + cell mapping

VLM whole-page transcription is frozen after POC #5 (~35/45). This experiment is **registration only**: photo → ArUco → homography → canonical 1700×2200 → known B-1.3.1 field rectangles. No OCR, checkbox scoring, blank detection, Ollama, or schema/normalizer changes.

**Approach:** Node owns the template JSON, tests, and `sharp` EXIF rotate, then spawns a small Python OpenCV helper. Robust `DICT_4X4_50` detection is not available in the Node stack without a brittle package; `opencv-contrib-python-headless` is the reliable path.

```bash
cd node-api
python3 -m pip install -r lib/workout/poc6/requirements.txt
npm test
npm run poc6
```

| Item | Value |
| --- | --- |
| Photo | `fixtures/routine-B-v1.3.1.jpg` (“1.3.1 routine b pic”), EXIF 1, **1152×1536** |
| PDF authority | `fixtures/routine-B-machine-readable-prototype-v1.3.1.pdf` rendered @ 200 px/in = **1700×2200** |
| Detected IDs | **10, 11, 12, 13** (all four). Roles from IDs, not image position: 10=TL, 11=TR, 12=BR, 13=BL |
| Photo 10 TL | corners `(56,84) (128,83) (126,154) (54,155)`, center `(91, 119)` |
| Photo 11 TR | corners `(1027,83) (1098,86) (1100,157) (1029,154)`, center `(1063.5, 120)` |
| Photo 12 BR | corners `(1033,1400) (1107,1400) (1103,1469) (1031,1470)`, center `(1068.5, 1434.75)` |
| Photo 13 BL | corners `(42,1410) (114,1414) (113,1491) (42,1486)`, center `(77.75, 1450.25)` |
| Canonical | `CANONICAL_PAGE_WIDTH=1700`, `CANONICAL_PAGE_HEIGHT=2200`, `CANONICAL_DPI=200` |
| PDF marker squares | 112×112 px (0.56"), inset 56 px (0.28"): 10 `(56,56)–(168,168)`, 11 `(1532,56)–(1644,168)`, 12 `(1532,2032)–(1644,2144)`, 13 `(56,2032)–(168,2144)` |
| Homography | 16 observed marker **corners** → 16 PDF marker corners via `cv2.findHomography` (all points). Centers are **not** page corners. |
| Fields | **72** writable cells in `templates/B-1.3.1.json` (canonical px + 0..1 norm) |
| Missing markers | **STOP** (exit 2, debug image only). No guessed corners, no VLM. |
| Deps added | `opencv-contrib-python-headless==4.8.1.78`, `numpy>=1.21.6,<2` (host Python). Node still uses existing `sharp`. |
| Tests | `lib/workout/poc6.test.js`: 72 in-bounds fields, set counts, coordinate fingerprint `sha256:b6bc883e…5645`, live 10–13 → 1700×2200, missing-marker stop. `npm test` 125/125. |

**Limitations:** global homography cannot undo local paper curl. Header write-ins sit on the printed underlines (not the labels). B02 S1 “10” still hugs the BW/reps gutter. QR is recorded in the template but unused. This POC does not read cells.

POC #6 is **approved / frozen**. Do not retune registration to help later detectors.

Artifact paths (all under `node-api/config/workout-v1.3.1/`):

- `artifacts/poc6-registration-debug.png`
- `artifacts/poc6-rectified.png`
- `artifacts/poc6-field-overlay.png`
- `artifacts/poc6-field-crops.png`
- `artifacts/poc6-registration.json`
- `templates/B-1.3.1.json`

## POC #4 — Hardware-constrained model shootout

The POC #3 whole-page pipeline is frozen. The experimental variable is `OLLAMA_MODEL`.

Do **not** auto-pull models. First list candidates, then run one installed tag at a time:

```bash
cd node-api
npm test
OLLAMA_BASE_URL=http://127.0.0.1:11434 npm run benchmark:poc4
OLLAMA_BASE_URL=http://127.0.0.1:11434 npm run benchmark:poc4 -- llama3.2-vision:11b
```

Primary metric is raw cell accuracy (`__ / 45`), not schema validity. A candidate advances to a 3-run reliability test only if it beats Llama on BW, blank weights, effort, or pain while staying inside ~20–22 GB RAM.

## POC #3 — Whole-page extraction reliability

Keep the whole-page `/api/chat` architecture. The model still does **not** receive crops, the v1.2 pack, or the canonical workout schema.

The model copies handwritten cells as `string | null` (`"unreadable"` if unsure). JavaScript still owns inheritance, IDs, dates, and canonical JSON. The existing normalizer is unchanged.

Run the Routine B fixture three times with identical settings and diff expected raw cells vs runs 1–3:

```bash
cd node-api
npm test
OLLAMA_BASE_URL=http://127.0.0.1:11434 npm run benchmark:poc3
```

## POC #2 — Fixed-form raw transcription

The model extracts handwritten cells only. It does **not** receive the v1.2 pack or canonical workout schema. JavaScript then:

- inherits blank weights within an exercise
- maps B01–B07 → exercise IDs and `B-1.2`
- maps BW → `load_state=bodyweight`
- maps numeric weight → `external`
- maps `4-12` → `date=null` + `REVIEW_REQUIRED`
- validates against v1.2 schema/semantics
- diffs `routine-B-real-sheet-expected-v1.2.json`

Two variants:

| Variant | What the model sees |
| --- | --- |
| **A whole-page** | One `/api/chat` call on the upright page |
| **B crops** | Header, each table, and the note, cropped and enlarged, then merged |

The kill-check is B03: `40×10 / 40×8 / 45×9`. If neither variant recovers that, stop optimizing this model.

```bash
cd node-api
npm test
OLLAMA_BASE_URL=http://127.0.0.1:11434 npm run benchmark:poc2
OLLAMA_BASE_URL=http://127.0.0.1:11434 npm run benchmark:poc2 -- crops
```

UI: `http://<host>/workouts` after rebuilding node-api.

## Older diagnostics

- **Vision Debug** — plain-language read, no JSON
- **Pack transcribe (POC #1)** — still available; sends the full v1.2 pack (this overwhelmed the 11B model)

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `OLLAMA_BASE_URL` | `http://localhost:11434` (Compose: `http://home-ai-ollama:11434`) | Ollama origin only |
| `OLLAMA_MODEL` | `llama3.2-vision:11b` | Vision model |
| `OLLAMA_TRANSCRIBE_TIMEOUT_MS` | `600000` | Vision calls can take minutes |
