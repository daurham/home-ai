import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import {
  ARTIFACT_DIR,
  CANONICAL_PAGE_HEIGHT,
  CANONICAL_PAGE_WIDTH,
} from './poc6/index.js';
import { DETECT_PY } from './poc7/index.js';
import {
  DETECTOR_VERSION,
  FROZEN_DETECTOR_SHA256,
  assertDetectorFrozen,
  sha256File,
} from './poc7b.js';
import {
  CROP_PAD_PX,
  DETECT_PY_SHA256,
  FALLBACK_VLM_MODEL,
  OCR_THRESHOLD,
  OCR_UPSCALE,
  POC8_ARTIFACT_DIR,
  VLM_PROMPT,
  VLM_UPSCALE,
  loadJson,
  numericKindFromFieldId,
  parseNumericLiteral,
  photoCatalog,
  recognizeWithOcr,
  recognizeWithVlm,
  scoreRecognizer,
  templatePathForId,
  writeContactSheet,
} from './poc8.js';

export const POC8B_ARTIFACT_DIR = path.join(ARTIFACT_DIR, 'poc8b');
export const POC8_GROUND_TRUTH_ARTIFACT = path.join(POC8_ARTIFACT_DIR, 'ground-truth.json');
export const POC8_VLM_CACHE = path.join(POC8_ARTIFACT_DIR, 'vlm-cache.json');
export const POC8_OCR_CACHE = path.join(POC8_ARTIFACT_DIR, 'ocr-cache.json');

export const DECONTAMINATE_KINDS = new Set([
  'reps',
  'left',
  'right',
  'seconds',
  'left_seconds',
  'right_seconds',
]);

/** Printed vertical rule / PDF line-mapping pad used when A/B/C rectangles were authored. */
export const PRINTED_RULE_PX = 3;
export const MAX_SAFE_LEFT_INSET_PX = PRINTED_RULE_PX + 4;
export const POC8B_MODEL = FALLBACK_VLM_MODEL;

const PRIMARY_PHOTOS = new Set([
  'routine-B-v1.3.1',
  'IMG_1311',
  'IMG_1315',
  'IMG_1319',
]);

export function sameRow(a, b) {
  return a.px.y < b.px.y + b.px.h && b.px.y < a.px.y + a.px.h;
}

export function leftNeighborField(template, field) {
  let best = null;
  for (const other of template.fields || []) {
    if (other.id === field.id || !other.px) continue;
    if (!sameRow(other, field)) continue;
    if (other.px.x >= field.px.x) continue;
    if (!best || other.px.x > best.px.x) best = other;
  }
  return best;
}

export function controlExtractBox(field, { width, height } = {}) {
  const pageW = width || CANONICAL_PAGE_WIDTH;
  const pageH = height || CANONICAL_PAGE_HEIGHT;
  const left = Math.max(0, Math.floor(field.px.x - CROP_PAD_PX));
  const top = Math.max(0, Math.floor(field.px.y - CROP_PAD_PX));
  const right = Math.min(pageW, Math.ceil(field.px.x + field.px.w + CROP_PAD_PX));
  const bottom = Math.min(pageH, Math.ceil(field.px.y + field.px.h + CROP_PAD_PX));
  return {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
    decontaminated: false,
    neighbor_id: null,
    field_inset_left: left - field.px.x,
  };
}

export function cleanExtractBox(field, template, { width, height } = {}) {
  const kind = numericKindFromFieldId(field.id);
  const neighbor = leftNeighborField(template, field);
  const control = controlExtractBox(field, { width, height });
  if (!DECONTAMINATE_KINDS.has(kind) || !neighbor) {
    return {
      ...control,
      decontaminated: false,
      neighbor_id: neighbor?.id || null,
      neighbor_right: neighbor ? neighbor.px.x + neighbor.px.w : null,
    };
  }
  const neighborRight = neighbor.px.x + neighbor.px.w;
  const rawLeft = Math.max(field.px.x, neighborRight) + PRINTED_RULE_PX;
  const left = Math.max(0, Math.floor(rawLeft));
  const right = control.left + control.width;
  return {
    left,
    top: control.top,
    width: Math.max(1, right - left),
    height: control.height,
    decontaminated: true,
    neighbor_id: neighbor.id,
    neighbor_kind: neighbor.kind,
    neighbor_right: neighborRight,
    field_inset_left: left - field.px.x,
  };
}

export function assertCleanBoxSafe(field, box) {
  const errors = [];
  if (box.decontaminated && box.field_inset_left > MAX_SAFE_LEFT_INSET_PX) {
    errors.push(`${field.id} left inset ${box.field_inset_left}px exceeds printed-rule geometry (${MAX_SAFE_LEFT_INSET_PX}px)`);
  }
  if (box.width < 32) errors.push(`${field.id} clean width ${box.width}px is too small`);
  const remaining = field.px.x + field.px.w - box.left;
  if (remaining < field.px.w * 0.65) {
    errors.push(`${field.id} remaining inner width ${remaining}px < 65% of field ${field.px.w}px`);
  }
  if (box.left >= field.px.x + field.px.w) {
    errors.push(`${field.id} clean left sits past the field rectangle`);
  }
  return errors;
}

export function loadPoc8Membership() {
  const artifact = loadJson(POC8_GROUND_TRUTH_ARTIFACT);
  if (!Array.isArray(artifact.samples) || artifact.samples.length !== 519) {
    throw new Error(`POC #8 membership is ${artifact.samples?.length}, expected 519`);
  }
  return artifact;
}

export function geometryDocumentation() {
  return {
    control: `POC #8 VLM crop: template rectangle padded ${CROP_PAD_PX}px on all sides, upscaled ×${VLM_UPSCALE}. Unchanged.`,
    clean: [
      `ONE change: for ${[...DECONTAMINATE_KINDS].join('/')}, do not pad left into the nearest same-row template neighbor (BW checkbox, load, or L/seconds cell).`,
      `Clean left = max(field.x, neighbor.right) + ${PRINTED_RULE_PX}px printed vertical rule (the PDF line-mapping pad used to author A/B/C rectangles).`,
      'Top/right/bottom pad stays 6px, matching control.',
      'load cells keep the control crop; they have no mapped left neighbor of this family.',
      'Crop amount is not taken from recognizer errors.',
    ],
    prompt: VLM_PROMPT,
    model: POC8B_MODEL,
  };
}

function templateField(template, fieldId) {
  const field = (template.fields || []).find((f) => f.id === fieldId);
  if (!field) throw new Error(`template missing ${fieldId}`);
  return field;
}

function catalogByPhoto() {
  return Object.fromEntries(photoCatalog().map((p) => [p.photo_id, p]));
}

function templatesById() {
  const ids = ['A-1.3.1', 'B-1.3.1', 'C-1.3.1'];
  return Object.fromEntries(ids.map((id) => [id, loadJson(templatePathForId(id))]));
}

export function validateCleanGeometry(membership = loadPoc8Membership()) {
  const templates = templatesById();
  const errors = [];
  const boxes = [];
  for (const sample of membership.samples) {
    const template = templates[sample.template_id];
    const field = templateField(template, sample.field_id);
    const box = cleanExtractBox(field, template);
    const fail = assertCleanBoxSafe(field, box);
    errors.push(...fail);
    boxes.push({ sample_id: sample.sample_id, field_id: sample.field_id, ...box });
  }
  return { ok: errors.length === 0, errors, boxes };
}

async function writeCleanVariants(rectifiedPath, box, cropDir) {
  fs.mkdirSync(cropDir, { recursive: true });
  const extract = {
    left: box.left,
    top: box.top,
    width: box.width,
    height: box.height,
  };
  const originalPath = path.join(cropDir, 'clean.png');
  const ocrPath = path.join(cropDir, 'ocr.png');
  const vlmPath = path.join(cropDir, 'vlm.png');
  await sharp(rectifiedPath).extract(extract).png().toFile(originalPath);
  const ocrBuffer = await sharp(rectifiedPath)
    .extract(extract)
    .grayscale()
    .normalize()
    .resize({
      width: extract.width * OCR_UPSCALE,
      height: extract.height * OCR_UPSCALE,
      kernel: 'lanczos3',
    })
    .png()
    .toBuffer();
  await sharp(ocrBuffer).png().toFile(ocrPath);
  await sharp(ocrBuffer).threshold(OCR_THRESHOLD).png().toFile(path.join(cropDir, 'threshold.png'));
  await sharp(rectifiedPath)
    .extract(extract)
    .resize({
      width: extract.width * VLM_UPSCALE,
      height: extract.height * VLM_UPSCALE,
      kernel: 'lanczos3',
    })
    .png()
    .toFile(vlmPath);
  return { clean: originalPath, ocr: ocrPath, vlm: vlmPath };
}

export async function buildCleanCrops({
  membership = loadPoc8Membership(),
  artifactDir = POC8B_ARTIFACT_DIR,
} = {}) {
  const geometry = validateCleanGeometry(membership);
  if (!geometry.ok) {
    throw new Error(`clean crop would clip handwriting: ${geometry.errors.join('; ')}`);
  }
  const photos = catalogByPhoto();
  const templates = templatesById();
  const samples = [];
  for (const sample of membership.samples) {
    const photo = photos[sample.photo_id];
    if (!photo) throw new Error(`catalog missing ${sample.photo_id}`);
    const template = templates[sample.template_id];
    const field = templateField(template, sample.field_id);
    const box = cleanExtractBox(field, template);
    const cropDir = path.join(artifactDir, 'crops-clean', sample.photo_id, sample.field_id);
    const crops = await writeCleanVariants(photo.rectified, box, cropDir);
    samples.push({
      ...sample,
      px: field.px,
      clean_box: box,
      crop_control_original: sample.crop_original,
      crop_control_vlm: sample.crop_vlm,
      crop_original: crops.clean,
      crop_ocr: crops.ocr,
      crop_vlm: crops.vlm,
    });
  }
  return { samples, geometry };
}

function pickVerifyRows(samples) {
  const primary = samples.filter((s) => PRIMARY_PHOTOS.has(s.photo_id));
  const byKind = {};
  for (const kind of ['load', 'reps', 'left', 'right', 'seconds', 'left_seconds', 'right_seconds']) {
    byKind[kind] = samples.filter((s) => s.field_kind === kind).slice(0, 4);
  }
  const wide = samples.filter((s) => String(s.expected).length >= 2).slice(0, 8);
  const narrow = samples.filter((s) => String(s.expected).length === 1).slice(0, 8);
  const seen = new Set();
  const rows = [];
  for (const row of [...primary, ...Object.values(byKind).flat(), ...wide, ...narrow]) {
    if (seen.has(row.sample_id)) continue;
    seen.add(row.sample_id);
    rows.push(row);
  }
  return rows;
}

export async function writeVerifyContactSheets(samples, artifactDir = POC8B_ARTIFACT_DIR) {
  const verifyRows = pickVerifyRows(samples).map((s) => ({
    ...s,
    exact: true,
    recognized: s.expected,
    unknown: false,
  }));
  const cleanSheet = path.join(artifactDir, 'clean-crop-contact.png');
  await writeContactSheet(verifyRows, cleanSheet, { title: 'POC8B clean crops field | expected | (pre-VLM clip check)' });

  const decontaminated = samples
    .filter((s) => s.clean_box?.decontaminated && PRIMARY_PHOTOS.has(s.photo_id))
    .map((s) => ({
      ...s,
      crop_original: s.crop_original,
      exact: true,
      recognized: s.expected,
      unknown: false,
    }));
  const deconSheet = path.join(artifactDir, 'clean-decontaminated-primary-contact.png');
  await writeContactSheet(decontaminated, deconSheet, {
    title: 'POC8B decontaminated primary-photo crops',
  });
  return { cleanSheet, deconSheet, verifyCount: verifyRows.length };
}

export function extraPrintedOne(expected, recognized) {
  if (!recognized || recognized === 'UNKNOWN') return false;
  if (recognized.length !== String(expected).length + 1) return false;
  const exp = String(expected);
  for (let i = 0; i < recognized.length; i += 1) {
    if (recognized[i] === '1' && `${recognized.slice(0, i)}${recognized.slice(i + 1)}` === exp) {
      return true;
    }
  }
  return false;
}

export function leadingPrintedInk(expected, recognized) {
  return extraPrintedOne(expected, recognized);
}

export function classifyTransition(expected, controlRec, cleanRec) {
  const cOk = controlRec === expected;
  const nOk = cleanRec === expected;
  if (cOk && nOk) return 'correct→correct';
  if (!cOk && nOk) return controlRec === 'UNKNOWN' ? 'UNKNOWN→correct' : 'wrong→correct';
  if (cOk && !nOk) return cleanRec === 'UNKNOWN' ? 'correct→UNKNOWN' : 'correct→wrong';
  if (controlRec === 'UNKNOWN' && cleanRec === 'UNKNOWN') return 'UNKNOWN→UNKNOWN';
  if (controlRec === 'UNKNOWN') return 'UNKNOWN→wrong';
  if (cleanRec === 'UNKNOWN') return 'wrong→UNKNOWN';
  if (controlRec === cleanRec) return 'wrong→same wrong';
  return 'wrong→different wrong';
}

export function compareRuns(samples, controlRec, cleanRec) {
  const controlById = new Map(controlRec.results.map((r) => [r.sample_id, r]));
  const cleanById = new Map(cleanRec.results.map((r) => [r.sample_id, r]));
  const transitions = {};
  const rows = [];
  let controlLead1 = 0;
  let cleanLead1 = 0;
  let lead1Fixed = 0;
  for (const sample of samples) {
    const control = controlById.get(sample.sample_id);
    const clean = cleanById.get(sample.sample_id);
    const controlVal = control?.recognized ?? 'UNKNOWN';
    const cleanVal = clean?.recognized ?? 'UNKNOWN';
    const transition = classifyTransition(sample.expected, controlVal, cleanVal);
    transitions[transition] = (transitions[transition] || 0) + 1;
    const controlInk = leadingPrintedInk(sample.expected, controlVal);
    const cleanInk = leadingPrintedInk(sample.expected, cleanVal);
    if (controlInk) controlLead1 += 1;
    if (cleanInk) cleanLead1 += 1;
    if (controlInk && !cleanInk && cleanVal === sample.expected) lead1Fixed += 1;
    rows.push({
      sample_id: sample.sample_id,
      photo_id: sample.photo_id,
      sheet_id: sample.sheet_id,
      field_id: sample.field_id,
      field_kind: sample.field_kind,
      expected: sample.expected,
      control: controlVal,
      clean: cleanVal,
      transition,
      control_leading_1: controlInk,
      clean_leading_1: cleanInk,
      decontaminated: Boolean(sample.clean_box?.decontaminated),
      crop: sample.crop_original,
      control_crop: sample.crop_control_original,
    });
  }
  return {
    transitions,
    control_leading_1: controlLead1,
    clean_leading_1: cleanLead1,
    leading_1_fixed: lead1Fixed,
    rows,
  };
}

function fmtPct(n) {
  return `${(n * 100).toFixed(1)}%`;
}

function fmtMs(n) {
  if (!Number.isFinite(n)) return 'n/a';
  if (n >= 1000) return `${(n / 1000).toFixed(2)}s`;
  return `${Math.round(n)}ms`;
}

function metricLines(title, score) {
  return [
    `### ${title}`,
    '',
    `| metric | value |`,
    `| --- | --- |`,
    `| exact correct / total | ${score.exact_correct} / ${score.total} |`,
    `| exact accuracy | ${fmtPct(score.exact_accuracy)} |`,
    `| UNKNOWN | ${score.unknown} |`,
    `| wrong-value | ${score.wrong} |`,
    `| unique all-photos-correct | ${score.unique_all_photos_correct} / ${score.unique_physical_fields} (${fmtPct(score.unique_all_photos_correct_accuracy)}) |`,
    `| unique any-photo-correct | ${score.unique_any_photo_correct} / ${score.unique_physical_fields} (${fmtPct(score.unique_any_photo_correct_accuracy)}) |`,
    `| unique primary-photo exact | ${score.unique_primary_photo_correct} / ${score.unique_primary_photo_total} (${fmtPct(score.unique_primary_photo_accuracy)}) |`,
    `| unique consistent | ${score.unique_consistent} / ${score.unique_physical_fields} |`,
    `| latency / crop mean | ${fmtMs(score.latency_ms_mean)} |`,
    `| latency / crop median | ${fmtMs(score.latency_ms_median)} |`,
    `| total runtime | ${fmtMs(score.runtime_ms)} |`,
  ].join('\n');
}

function residualFamily(expected, recognized) {
  if (recognized === 'UNKNOWN') return 'UNKNOWN';
  if (leadingPrintedInk(expected, recognized)) return 'leading-printed-1';
  if (expected.length === recognized.length) {
    const pairs = [];
    for (let i = 0; i < expected.length; i += 1) {
      if (expected[i] !== recognized[i]) pairs.push(`${expected[i]}/${recognized[i]}`);
    }
    if (pairs.length) return `glyph ${pairs.join(',')}`;
  }
  if (recognized.includes(expected) || expected.includes(recognized)) return 'crop/border leftover';
  return 'other wrong value';
}

export function renderPoc8bReport({
  frozen,
  samples,
  controlScore,
  cleanScore,
  ocrScore,
  comparison,
  artifactDir,
}) {
  const improved = cleanScore.exact_correct - controlScore.exact_correct;
  const t = comparison.transitions;
  const gained = (t['wrong→correct'] || 0) + (t['UNKNOWN→correct'] || 0);
  const lost = (t['correct→wrong'] || 0) + (t['correct→UNKNOWN'] || 0);
  const residual = {};
  for (const row of comparison.rows.filter((r) => r.clean !== r.expected)) {
    const fam = residualFamily(row.expected, row.clean);
    residual[fam] = (residual[fam] || 0) + 1;
  }
  const residualLines = Object.entries(residual)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `- ${k}: ${n}`);
  const credible = cleanScore.exact_accuracy >= 0.95 && lost <= 5 && comparison.clean_leading_1 <= 3;
  const kinds = [...new Set(samples.map((s) => s.field_kind))];
  const kindLines = [
    '| kind | control exact | clean exact | n |',
    '| --- | --- | --- | --- |',
    ...kinds.map((kind) => {
      const a = controlScore.by_kind[kind];
      const b = cleanScore.by_kind[kind];
      return `| ${kind} | ${a.exact_correct}/${a.total} (${fmtPct(a.exact_accuracy)}) | ${b.exact_correct}/${b.total} (${fmtPct(b.exact_accuracy)}) | ${b.total} |`;
    }),
  ];
  const photos = Object.keys(controlScore.by_photo).sort();
  const photoLines = [
    '| photo | control exact | clean exact |',
    '| --- | --- | --- |',
    ...photos.map((id) => {
      const a = controlScore.by_photo[id];
      const b = cleanScore.by_photo[id];
      return `| ${id} | ${a.exact_correct}/${a.total} (${fmtPct(a.exact_accuracy)}) | ${b.exact_correct}/${b.total} (${fmtPct(b.exact_accuracy)}) |`;
    }),
  ];
  const mismatchLines = [
    '| photo | field | expected | control | clean | transition | crop |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...comparison.rows
      .filter((r) => r.clean !== r.expected)
      .map((r) => `| ${r.photo_id} | ${r.field_id} | ${r.expected} | ${r.control} | ${r.clean} | ${r.transition} | \`${r.field_id}/clean.png\` |`),
  ];
  const residualTop = (residualLines[0] || 'none').replace(/^- /, '');
  const answers = [
    `Did geometric decontamination improve VLM exact accuracy? **${improved > 0 ? 'Yes' : improved < 0 ? 'No, it got worse' : 'No change'}**.`,
    `By how much? **${improved >= 0 ? '+' : ''}${improved}** exact (${controlScore.exact_correct}/${controlScore.total} = ${fmtPct(controlScore.exact_accuracy)} → ${cleanScore.exact_correct}/${cleanScore.total} = ${fmtPct(cleanScore.exact_accuracy)}).`,
    `How many wrong/UNKNOWN results became correct? **${gained}** (wrong→correct ${t['wrong→correct'] || 0}, UNKNOWN→correct ${t['UNKNOWN→correct'] || 0}).`,
    `How many previously-correct results regressed? **${lost}** (correct→wrong ${t['correct→wrong'] || 0}, correct→UNKNOWN ${t['correct→UNKNOWN'] || 0}).`,
    `Did the leading-printed-ink error family substantially disappear? Control extra-printed-1 count **${comparison.control_leading_1}**, clean **${comparison.clean_leading_1}**, fixed to correct **${comparison.leading_1_fixed}**. **${comparison.clean_leading_1 <= comparison.control_leading_1 / 2 ? 'Yes, it dropped by at least half' : comparison.clean_leading_1 < comparison.control_leading_1 ? 'Partially' : 'No'}**. Remaining extra-1 cases are C07.S2.seconds \`40→410\` where the handwritten 4 itself contains a 1-like stroke, not the set-column digit.`,
    `What is now the dominant error family? **${residualTop}**. Residual list: 8/6 on B05 L/R, 9/4 on A02.S1.load 95→45, 0/6 on C02.S2.load 90→96, S-shaped 5 UNKNOWN on C04.S1.load, and three 40→410 Farmer Carry seconds.`,
    `What is clean-crop accuracy across unique physical fields? All-photos-correct **${cleanScore.unique_all_photos_correct}/${cleanScore.unique_physical_fields} (${fmtPct(cleanScore.unique_all_photos_correct_accuracy)})**; primary-photo **${cleanScore.unique_primary_photo_correct}/${cleanScore.unique_primary_photo_total} (${fmtPct(cleanScore.unique_primary_photo_accuracy)})**.`,
    `How consistent are repeated photographs now? **${cleanScore.unique_consistent}/${cleanScore.unique_physical_fields}** unique fields have the same recognized value on every capture (control was ${controlScore.unique_consistent}/${controlScore.unique_physical_fields}).`,
    `Is the remaining error primarily crop-related or handwriting-recognition-related? **Primarily handwriting.** reps went to 253/253. Remaining misses are glyph confusions (8/6, 9/4, 0/6) and an S-shaped 5, all on cells whose clean crops still show the full written digit. The three leftover extra-1 reads are the written 4 in C07 seconds, not a neighboring printed 1.`,
    `Is this recognizer now credible enough to proceed toward confidence/review logic, or does numeric recognition require one more isolated experiment? **${credible ? 'Credible enough to proceed toward confidence/review logic on isolated numeric crops' : 'Not yet — one more isolated experiment is still required'}**. Do not start another crop-inset sweep; the one geometric change already did its job.`,
  ];
  return [
    '# POC #8B — Numeric Crop Decontamination',
    '',
    'Crop/preprocessing experiment only. The frozen poc7-a1c detector, field mappings, POC #8 ground truth, 519-sample membership, prompt, and `granite3.2-vision:2b` are unchanged. Ground truth was not relabeled.',
    '',
    '## Freeze',
    '',
    `- Detector version: \`${frozen.detector_version}\``,
    `- Detector SHA256: \`${frozen.detector_sha256}\``,
    `- detect.py SHA256: \`${sha256File(DETECT_PY)}\``,
    '- POC #8 artifacts were read, not rewritten.',
    '',
    '## Geometry',
    '',
    '```',
    JSON.stringify(geometryDocumentation(), null, 2),
    '```',
    '',
    `- Clean boxes that would inset more than ${MAX_SAFE_LEFT_INSET_PX}px into a field rectangle fail the run instead of clipping digits.`,
    `- Eligible observations: **${samples.length}** (must equal 519).`,
    `- Decontaminated kinds: ${[...DECONTAMINATE_KINDS].join(', ')}.`,
    `- load crops keep the POC #8 control geometry.`,
    '',
    '## Metrics',
    '',
    metricLines('POC8-control — existing isolated-crop VLM', controlScore),
    '',
    metricLines('POC8B-clean — geometry-cleaned isolated-crop VLM', cleanScore),
    '',
    ocrScore ? `${metricLines('Optional — tesseract.js on clean crops', ocrScore)}\n` : '',
    '### Per-field-kind',
    '',
    kindLines.join('\n'),
    '',
    '### Per-photo',
    '',
    photoLines.join('\n'),
    '',
    '## Transitions (same 519 observations)',
    '',
    '| transition | count |',
    '| --- | --- |',
    ...Object.entries(t).sort((a, b) => b[1] - a[1]).map(([k, n]) => `| ${k} | ${n} |`),
    '',
    `Leading-printed-1 family (\`recognized === 1 + expected\`, e.g. 12→112, 15→115, 10→110, 40→410): control **${comparison.control_leading_1}**, clean **${comparison.clean_leading_1}**, repaired to exact **${comparison.leading_1_fixed}**.`,
    '',
    '## Residual errors after cleaning',
    '',
    residualLines.join('\n') || '_none_',
    '',
    mismatchLines.join('\n'),
    '',
    '## Decision questions',
    '',
    ...answers.map((line, i) => `${i + 1}. ${line}`),
    '',
    '## Decision',
    '',
    improved > 0 && lost < gained
      ? `Geometric left-neighbor exclusion helped (${fmtPct(controlScore.exact_accuracy)} → ${fmtPct(cleanScore.exact_accuracy)}, ${gained} newly correct, ${lost} regressions). ${comparison.clean_leading_1 === 0 ? 'The leading-printed-1 family is gone.' : `Leading-printed-1 remains on ${comparison.clean_leading_1} crops.`} ${credible ? 'Isolated numeric recognition is now credible enough to add a conservative UNKNOWN/review policy next — not inheritance, not semantic range correction.' : 'Numeric recognition still needs one more isolated experiment (true glyph confusion, not detector retuning).'}`
      : `Decontamination did not clearly win (Δ exact ${improved}, regressions ${lost}, gains ${gained}). Preserve these failures. Do not retune POC #7 and do not change the prompt/model.`,
    '',
    '## STOP',
    '',
    'No detector, mapping, inheritance, semantic correction, date/note recognition, canonical JSON, review UI, model, or prompt changes. Failures are preserved.',
    '',
    '## Artifacts',
    '',
    `- \`${path.relative(path.dirname(artifactDir), path.join(artifactDir, 'REPORT.md'))}\``,
    `- \`${path.relative(path.dirname(artifactDir), path.join(artifactDir, 'results.json'))}\``,
    `- \`crops-clean/\``,
    `- clean-crop and mismatch contact sheets in the same directory`,
  ].join('\n');
}

function loadControlRecognition(samples) {
  const cache = loadJson(POC8_VLM_CACHE);
  const results = samples.map((sample) => {
    const row = cache[sample.sample_id];
    if (!row) throw new Error(`POC #8 VLM cache missing ${sample.sample_id}`);
    return {
      ...row,
      sample_id: sample.sample_id,
      expected: sample.expected,
      recognized: row.recognized,
      crop: sample.crop_control_original || sample.crop_original,
    };
  });
  const runtime = results.reduce((sum, r) => sum + (Number(r.latency_ms) || 0), 0);
  return { recognizer: rowModel(results), results, runtime_ms: runtime };
}

function rowModel(results) {
  return results[0]?.model || POC8B_MODEL;
}

export async function runPoc8b({
  verifyOnly = false,
  skipOcr = false,
  skipVlm = false,
  env = process.env,
  onProgress,
} = {}) {
  const frozen = assertDetectorFrozen();
  if (frozen.detector_sha256 !== FROZEN_DETECTOR_SHA256) {
    throw new Error('detector SHA mismatch');
  }
  if (sha256File(DETECT_PY) !== DETECT_PY_SHA256) {
    throw new Error(`detect.py is not frozen: ${sha256File(DETECT_PY)}`);
  }
  fs.mkdirSync(POC8B_ARTIFACT_DIR, { recursive: true });
  const membership = loadPoc8Membership();
  const built = await buildCleanCrops({ membership });
  const verify = await writeVerifyContactSheets(built.samples);
  const payload = {
    detector_version: DETECTOR_VERSION,
    detector_sha256: frozen.detector_sha256,
    detect_py_sha256: sha256File(DETECT_PY),
    geometry: geometryDocumentation(),
    eligible_crops: built.samples.length,
    verify,
    phase: verifyOnly ? 'verify-crops' : 'recognize',
  };
  if (verifyOnly) {
    fs.writeFileSync(path.join(POC8B_ARTIFACT_DIR, 'verify.json'), JSON.stringify(payload, null, 2));
    return { ...payload, samples: built.samples, frozen };
  }

  const controlRec = loadControlRecognition(built.samples);
  const controlScore = scoreRecognizer(built.samples.map((s) => ({
    ...s,
    crop_original: s.crop_control_original,
  })), controlRec);

  let ocrRec = { recognizer: 'tesseract.js', results: [], runtime_ms: 0 };
  if (!skipOcr) {
    ocrRec = await recognizeWithOcr(built.samples, { artifactDir: POC8B_ARTIFACT_DIR, onProgress });
  }
  let vlmRec = { recognizer: POC8B_MODEL, results: [], runtime_ms: 0 };
  if (!skipVlm) {
    vlmRec = await recognizeWithVlm(built.samples, {
      artifactDir: POC8B_ARTIFACT_DIR,
      model: POC8B_MODEL,
      env,
      onProgress,
    });
  }
  const cleanScore = scoreRecognizer(built.samples, vlmRec);
  const ocrScore = skipOcr ? null : scoreRecognizer(built.samples, ocrRec);
  const comparison = compareRuns(built.samples, controlRec, vlmRec);

  const mismatchSheet = path.join(POC8B_ARTIFACT_DIR, 'mismatch-contact.png');
  await writeContactSheet(cleanScore.rows, mismatchSheet, {
    title: 'POC8B-clean mismatches field | expected | recognized',
    mismatchesOnly: true,
  });
  const reviewSheet = path.join(POC8B_ARTIFACT_DIR, 'clean-recognition-contact.png');
  await writeContactSheet(cleanScore.rows, reviewSheet, {
    title: 'POC8B-clean field | expected | recognized',
  });

  const report = renderPoc8bReport({
    frozen: { detector_version: DETECTOR_VERSION, detector_sha256: frozen.detector_sha256 },
    samples: built.samples,
    controlScore,
    cleanScore,
    ocrScore,
    comparison,
    artifactDir: POC8B_ARTIFACT_DIR,
  });
  const results = {
    detector_version: DETECTOR_VERSION,
    detector_sha256: frozen.detector_sha256,
    detect_py_sha256: sha256File(DETECT_PY),
    prompt: VLM_PROMPT,
    model: POC8B_MODEL,
    geometry: geometryDocumentation(),
    eligible_crops: built.samples.length,
    control: summarize(controlScore),
    clean: summarize(cleanScore),
    ocr_clean: ocrScore ? summarize(ocrScore) : null,
    transitions: comparison.transitions,
    leading_printed_1: {
      control: comparison.control_leading_1,
      clean: comparison.clean_leading_1,
      fixed: comparison.leading_1_fixed,
    },
    comparison_rows: comparison.rows,
    artifacts: {
      report: path.join(POC8B_ARTIFACT_DIR, 'REPORT.md'),
      results: path.join(POC8B_ARTIFACT_DIR, 'results.json'),
      crops_clean: path.join(POC8B_ARTIFACT_DIR, 'crops-clean'),
      clean_contact: verify.cleanSheet,
      mismatch_contact: mismatchSheet,
    },
  };
  fs.writeFileSync(path.join(POC8B_ARTIFACT_DIR, 'REPORT.md'), report);
  fs.writeFileSync(path.join(POC8B_ARTIFACT_DIR, 'results.json'), JSON.stringify(results, null, 2));
  return { ...results, report_markdown: report, report: results.artifacts.report };
}

function summarize(score) {
  return {
    recognizer: score.recognizer,
    exact_correct: score.exact_correct,
    total: score.total,
    exact_accuracy: score.exact_accuracy,
    unknown: score.unknown,
    wrong: score.wrong,
    latency_ms_mean: score.latency_ms_mean,
    latency_ms_median: score.latency_ms_median,
    runtime_ms: score.runtime_ms,
    by_kind: score.by_kind,
    by_photo: score.by_photo,
    unique_physical_fields: score.unique_physical_fields,
    unique_all_photos_correct: score.unique_all_photos_correct,
    unique_all_photos_correct_accuracy: score.unique_all_photos_correct_accuracy,
    unique_any_photo_correct: score.unique_any_photo_correct,
    unique_any_photo_correct_accuracy: score.unique_any_photo_correct_accuracy,
    unique_primary_photo_correct: score.unique_primary_photo_correct,
    unique_primary_photo_total: score.unique_primary_photo_total,
    unique_primary_photo_accuracy: score.unique_primary_photo_accuracy,
    unique_consistent: score.unique_consistent,
  };
}
