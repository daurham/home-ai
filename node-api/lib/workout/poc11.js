import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import {
  ARTIFACT_DIR,
  TEMPLATE_PATH,
  V131_CONFIG_DIR,
  registerV131Photo,
} from './poc6/index.js';
import {
  BLANK_TEMPLATE_PATH,
  DETECT_PY,
  DETECTOR_CONFIG_PATH,
  detectV131Observations,
} from './poc7/index.js';
import {
  DETECTOR_VERSION,
  FROZEN_DETECTOR_SHA256,
  assertDetectorFrozen,
  sha256File,
} from './poc7b.js';
import {
  A_BLANK_PATH,
  A_TEMPLATE_PATH,
  C_BLANK_PATH,
  C_TEMPLATE_PATH,
} from './poc7f.js';
import {
  DETECT_PY_SHA256,
  NUMERIC_FIELD_KINDS,
  OCR_THRESHOLD,
  OCR_UPSCALE,
  VLM_PROMPT,
  VLM_UPSCALE,
  loadJson,
  numericKindFromFieldId,
  photoCatalog,
  recognizeWithVlm,
} from './poc8.js';
import {
  POC8B_MODEL,
  assertCleanBoxSafe,
  cleanExtractBox,
  loadPoc8Membership,
} from './poc8b.js';
import { loadPoc8bRows } from './poc8c.js';
import { CROP_PROFILE, RECOGNIZER_ID } from './poc9.js';
import {
  HEADER_PROMPTS,
  SCHEMA_VERSION,
  assembleV131Photo,
  parseHeaderRecognizerOutput,
  poc9Regression,
  writeHeaderCrop,
} from './poc10.js';
import { ollamaChatImage } from './ollama.js';
import { loadV131WorkoutConfig } from './v131Config.js';

export const POC11_FIXTURES_DIR = path.join(V131_CONFIG_DIR, 'fixtures', 'poc11');
export const POC11_MANIFEST_PATH = path.join(POC11_FIXTURES_DIR, 'manifest.json');
export const POC11_ARTIFACT_DIR = path.join(ARTIFACT_DIR, 'poc11');
export const POC11_BLIND_DIR = path.join(POC11_ARTIFACT_DIR, 'blind');
export const HEADER_RECOGNIZE_FIELDS = ['header.date', 'header.bodyweight', 'header.duration'];
export const HISTORICAL_PHOTO_IDS = new Set(photoCatalog().map((p) => p.photo_id));

/** Printed title band. Contains ROUTINE A/B/C and the unique subtitle. No handwriting cells. */
export const IDENTITY_CROP = {
  left: 180,
  top: 170,
  width: 920,
  height: 100,
};

export const TEMPLATE_SPECS = {
  'A-1.3.1': { template_id: 'A-1.3.1', routine: 'A', template_path: A_TEMPLATE_PATH, blank_path: A_BLANK_PATH },
  'B-1.3.1': { template_id: 'B-1.3.1', routine: 'B', template_path: TEMPLATE_PATH, blank_path: BLANK_TEMPLATE_PATH },
  'C-1.3.1': { template_id: 'C-1.3.1', routine: 'C', template_path: C_TEMPLATE_PATH, blank_path: C_BLANK_PATH },
};

const IDENTITY_MARGIN = 0.04;

function copyNamed(src, dest) {
  if (!fs.existsSync(src)) return false;
  fs.copyFileSync(src, dest);
  return true;
}

export function loadPoc11Manifest(manifestPath = POC11_MANIFEST_PATH) {
  return loadJson(manifestPath);
}

export function poc11Photos(manifest = loadPoc11Manifest()) {
  return (manifest.photos || []).map((row) => ({
    ...row,
    image_path: path.join(POC11_FIXTURES_DIR, row.filename),
  }));
}

export function assertPoc11PhotosFresh(photos = poc11Photos()) {
  const errors = [];
  if (photos.length !== 6) errors.push(`expected 6 photos, got ${photos.length}`);
  for (const photo of photos) {
    if (HISTORICAL_PHOTO_IDS.has(photo.photo_id)) {
      errors.push(`${photo.photo_id} was used in POCs #7–#10`);
    }
    if (!fs.existsSync(photo.image_path)) errors.push(`missing ${photo.image_path}`);
  }
  return { ok: errors.length === 0, errors };
}

function ncc(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < a.length; i += 1) {
    meanA += a[i];
    meanB += b[i];
  }
  meanA /= a.length;
  meanB /= b.length;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i += 1) {
    const xa = a[i] - meanA;
    const xb = b[i] - meanB;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  const denom = Math.sqrt(da * db);
  return denom === 0 ? 0 : num / denom;
}

export async function extractIdentityPatch(imagePath, crop = IDENTITY_CROP) {
  const { data } = await sharp(imagePath)
    .extract(crop)
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return data;
}

export async function identifyPrintedTemplate(rectifiedPath, {
  crop = IDENTITY_CROP,
  specs = TEMPLATE_SPECS,
} = {}) {
  const observed = await extractIdentityPatch(rectifiedPath, crop);
  const scores = [];
  for (const spec of Object.values(specs)) {
    const reference = await extractIdentityPatch(spec.blank_path, crop);
    scores.push({
      template_id: spec.template_id,
      routine: spec.routine,
      ncc: ncc(observed, reference),
    });
  }
  scores.sort((a, b) => b.ncc - a.ncc);
  const best = scores[0];
  const second = scores[1];
  const margin = best.ncc - (second?.ncc ?? 0);
  return {
    method: 'printed-title-ncc-vs-blank-rasters',
    crop,
    template_id: best.template_id,
    routine: best.routine,
    ncc: best.ncc,
    margin,
    uncertain: margin < IDENTITY_MARGIN,
    scores,
  };
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

function checkboxSummary(checkboxes = {}) {
  const rows = Object.entries(checkboxes).map(([field_id, rec]) => ({
    field_id,
    state: rec?.state || 'missing',
    score: rec?.score ?? null,
    confidence: rec?.confidence ?? null,
  }));
  const counts = { checked: 0, unchecked: 0, uncertain: 0, missing: 0 };
  for (const row of rows) counts[row.state] = (counts[row.state] || 0) + 1;
  return { counts, rows };
}

function fieldSummary(fields = {}) {
  const rows = Object.entries(fields).map(([field_id, rec]) => ({
    field_id,
    state: rec?.state || 'missing',
    score: rec?.score ?? null,
    confidence: rec?.confidence ?? null,
    numeric: NUMERIC_FIELD_KINDS.includes(numericKindFromFieldId(field_id)),
  }));
  const counts = { blank: 0, nonblank: 0, uncertain: 0, missing: 0 };
  for (const row of rows) counts[row.state] = (counts[row.state] || 0) + 1;
  return { counts, rows };
}

function structuralStatus(checkboxes, fields) {
  if ((checkboxes.counts.uncertain || 0) + (fields.counts.uncertain || 0) > 0) return 'UNCERTAIN';
  return 'OK';
}

function publicObservations(detection, imagePath, blankPath) {
  return {
    template: detection.template,
    source: imagePath,
    blank_template: blankPath,
    canonical: detection.canonical,
    detector_config: detection.detector_config,
    algorithm: detection.algorithm,
    checkboxes: detection.checkboxes,
    fields: detection.fields,
    counts: detection.counts,
  };
}

function graniteMapFromNumeric(rows) {
  const map = new Map();
  for (const row of rows) {
    map.set(`${row.photo_id}::${row.field_id}`, {
      photo_id: row.photo_id,
      field_id: row.field_id,
      clean: row.recognized,
      recognized: row.recognized,
      raw: row.raw,
      latency_ms: row.latency_ms,
    });
  }
  return map;
}

function headerLiteralsFromRows(rows) {
  const out = {};
  for (const row of rows) {
    if (!row.invoked) continue;
    out[row.field_id] = row.recognized;
  }
  return out;
}

async function recognizeHeadersForPhoto(photo, template, detector, outDir, onProgress) {
  const fieldsById = Object.fromEntries((template.fields || []).map((f) => [f.id, f]));
  const results = [];
  for (const fieldId of HEADER_RECOGNIZE_FIELDS) {
    const paper = detector.fields?.[fieldId]?.state;
    const sampleId = `${photo.photo_id}__${fieldId}`;
    if (paper !== 'nonblank') {
      results.push({
        sample_id: sampleId,
        photo_id: photo.photo_id,
        field_id: fieldId,
        paper_state: paper || 'blank',
        invoked: false,
        raw: null,
        recognized: 'BLANK',
        latency_ms: 0,
        model: POC8B_MODEL,
        prompt: HEADER_PROMPTS[fieldId],
      });
      continue;
    }
    const crop = path.join(outDir, 'headers', fieldId, 'vlm.png');
    await writeHeaderCrop(photo, fieldsById[fieldId], crop);
    const t0 = Date.now();
    let raw = '';
    let error = null;
    try {
      const ollama = await ollamaChatImage({
        imageBuffer: fs.readFileSync(crop),
        model: POC8B_MODEL,
        content: HEADER_PROMPTS[fieldId],
      });
      raw = ollama.raw ?? '';
    } catch (err) {
      error = String(err?.message || err);
    }
    const parsed = parseHeaderRecognizerOutput(fieldId, raw);
    const recognized = parsed.kind === 'NUMERIC' ? String(parsed.value) : parsed.literal;
    const row = {
      sample_id: sampleId,
      photo_id: photo.photo_id,
      field_id: fieldId,
      paper_state: 'nonblank',
      invoked: true,
      raw,
      recognized,
      parse_kind: parsed.kind,
      latency_ms: Date.now() - t0,
      error,
      model: POC8B_MODEL,
      crop,
      prompt: HEADER_PROMPTS[fieldId],
    };
    results.push(row);
    onProgress?.({ photo_id: photo.photo_id, field_id: fieldId, recognized: row.recognized, cached: false });
  }
  return results;
}

function failedPhotoRecord(photo, registration, timings, extra = {}) {
  return {
    original_filename: photo.filename,
    photo_id: photo.photo_id,
    fileshare_id: photo.fileshare_id,
    image_sha256: photo.sha256,
    registration: {
      success: false,
      detected_ids: registration?.detected_ids || [],
      error: registration?.error || 'required markers missing',
    },
    detected_template: null,
    identity: extra.identity || null,
    structural_status: 'NOT_RUN',
    recognized_date_literal: null,
    canonical_date: null,
    effort: null,
    pain: null,
    completed_sets: 0,
    numeric_fields_processed: 0,
    inherited_load_values: 0,
    review_issue_count: 0,
    review_issue_codes: [],
    schema_valid: false,
    semantic_valid: false,
    review_status: 'NOT_RUN',
    save_ready: false,
    processing_time_ms: timings.total_ms,
    latency: timings,
    ...extra,
  };
}

export async function processBlindPhoto(photo, {
  blindDir = POC11_BLIND_DIR,
  onProgress,
} = {}) {
  const outDir = path.join(blindDir, photo.photo_id);
  fs.mkdirSync(outDir, { recursive: true });
  const timings = {
    registration_ms: 0,
    identity_ms: 0,
    structure_ms: 0,
    numeric_granite_ms: 0,
    header_granite_ms: 0,
    assembly_ms: 0,
    total_ms: 0,
  };
  const wall0 = Date.now();

  const tReg0 = Date.now();
  const firstReg = await registerV131Photo({
    imagePath: photo.image_path,
    templatePath: TEMPLATE_PATH,
    outDir,
  });
  copyNamed(path.join(outDir, 'poc6-registration-debug.png'), path.join(outDir, 'registration-debug.png'));
  fs.writeFileSync(path.join(outDir, 'registration.json'), JSON.stringify(firstReg, null, 2));
  timings.registration_ms += Date.now() - tReg0;

  if (!firstReg.ok || !firstReg.all_four_required_detected) {
    timings.total_ms = Date.now() - wall0;
    const record = failedPhotoRecord(photo, firstReg, timings);
    fs.writeFileSync(path.join(outDir, 'photo-result.json'), JSON.stringify(record, null, 2));
    return record;
  }

  copyNamed(path.join(outDir, 'poc6-rectified.png'), path.join(outDir, 'rectified.png'));
  const tId0 = Date.now();
  const identity = await identifyPrintedTemplate(path.join(outDir, 'rectified.png'));
  timings.identity_ms = Date.now() - tId0;
  fs.writeFileSync(path.join(outDir, 'template-identity.json'), JSON.stringify(identity, null, 2));
  const spec = TEMPLATE_SPECS[identity.template_id];

  const tReg1 = Date.now();
  const registration = await registerV131Photo({
    imagePath: photo.image_path,
    templatePath: spec.template_path,
    outDir,
  });
  copyNamed(path.join(outDir, 'poc6-registration-debug.png'), path.join(outDir, 'registration-debug.png'));
  copyNamed(path.join(outDir, 'poc6-rectified.png'), path.join(outDir, 'rectified.png'));
  copyNamed(path.join(outDir, 'poc6-field-overlay.png'), path.join(outDir, 'field-overlay.png'));
  fs.writeFileSync(path.join(outDir, 'registration.json'), JSON.stringify({
    ...registration,
    identity,
    first_pass_ok: firstReg.ok,
  }, null, 2));
  timings.registration_ms += Date.now() - tReg1;

  const tDet0 = Date.now();
  const detection = await detectV131Observations({
    blankPath: spec.blank_path,
    observedPath: path.join(outDir, 'rectified.png'),
    templatePath: spec.template_path,
    outDir,
  });
  copyNamed(path.join(outDir, 'poc7-checkbox-debug.png'), path.join(outDir, 'checkbox-debug.png'));
  copyNamed(path.join(outDir, 'poc7-blank-debug.png'), path.join(outDir, 'blank-debug.png'));
  copyNamed(path.join(outDir, 'poc7-difference-debug.png'), path.join(outDir, 'difference-debug.png'));
  const observations = publicObservations(detection, photo.image_path, spec.blank_path);
  const observationsPath = path.join(outDir, 'observations.json');
  fs.writeFileSync(observationsPath, JSON.stringify(observations, null, 2));
  timings.structure_ms = Date.now() - tDet0;

  const template = loadJson(spec.template_path);
  const checkboxes = checkboxSummary(observations.checkboxes);
  const fields = fieldSummary(observations.fields);
  fs.writeFileSync(path.join(outDir, 'checkbox-observations.json'), JSON.stringify(checkboxes, null, 2));
  fs.writeFileSync(path.join(outDir, 'field-observations.json'), JSON.stringify(fields, null, 2));

  const catalogPhoto = {
    photo_id: photo.photo_id,
    sheet_id: photo.photo_id,
    template_id: spec.template_id,
    template_path: spec.template_path,
    blank: spec.blank_path,
    rectified: path.join(outDir, 'rectified.png'),
    observations: observationsPath,
  };

  const numericSamples = [];
  for (const field of template.fields || []) {
    const kind = numericKindFromFieldId(field.id);
    if (!kind) continue;
    if (observations.fields?.[field.id]?.state !== 'nonblank') continue;
    const box = cleanExtractBox(field, template);
    const safety = assertCleanBoxSafe(field, box);
    if (safety.length) {
      fs.appendFileSync(
        path.join(outDir, 'crop-safety-failures.jsonl'),
        `${JSON.stringify({ photo_id: photo.photo_id, field_id: field.id, errors: safety })}\n`,
      );
      continue;
    }
    const cropDir = path.join(outDir, 'numeric-crops', field.id);
    const crops = await writeCleanVariants(catalogPhoto.rectified, box, cropDir);
    numericSamples.push({
      sample_id: `${photo.photo_id}__${field.id}`,
      photo_id: photo.photo_id,
      sheet_id: photo.photo_id,
      template_id: spec.template_id,
      field_id: field.id,
      field_kind: kind,
      expected: null,
      px: field.px,
      clean_box: box,
      crop_original: crops.clean,
      crop_ocr: crops.ocr,
      crop_vlm: crops.vlm,
    });
  }

  const tNum0 = Date.now();
  const numericRun = numericSamples.length
    ? await recognizeWithVlm(numericSamples, {
      artifactDir: blindDir,
      model: POC8B_MODEL,
      onProgress: (evt) => onProgress?.({ stage: 'numeric', photo_id: photo.photo_id, ...evt }),
    })
    : { results: [], runtime_ms: 0 };
  timings.numeric_granite_ms = numericRun.results.reduce((sum, row) => sum + (Number(row.latency_ms) || 0), 0)
    || (Date.now() - tNum0);
  fs.writeFileSync(path.join(outDir, 'numeric-recognition.json'), JSON.stringify({
    model: POC8B_MODEL,
    prompt: VLM_PROMPT,
    crop_profile: CROP_PROFILE,
    count: numericRun.results.length,
    results: numericRun.results,
  }, null, 2));

  const tHdr0 = Date.now();
  const headerRows = await recognizeHeadersForPhoto(
    catalogPhoto,
    template,
    observations,
    outDir,
    (evt) => onProgress?.({ stage: 'header', ...evt }),
  );
  timings.header_granite_ms = headerRows.reduce((sum, row) => sum + (Number(row.latency_ms) || 0), 0)
    || (Date.now() - tHdr0);
  fs.writeFileSync(path.join(outDir, 'header-recognition.json'), JSON.stringify({
    model: POC8B_MODEL,
    prompts: HEADER_PROMPTS,
    results: headerRows,
  }, null, 2));

  const tAsm0 = Date.now();
  const granite = graniteMapFromNumeric(numericRun.results);
  const headerLiterals = headerLiteralsFromRows(headerRows);
  const assembled = assembleV131Photo(catalogPhoto, {
    granite,
    headerLiterals,
    config: loadV131WorkoutConfig(),
  });
  timings.assembly_ms = Date.now() - tAsm0;

  const inherited = [];
  let completedSets = 0;
  for (const ex of assembled.resolved.exercises || []) {
    for (const set of ex.sets || []) {
      completedSets += 1;
      if (set.load_provenance?.resolution === 'INHERITED') {
        inherited.push({
          slot_id: ex.slot_id,
          set_number: set.set_number,
          weight_lb: set.weight_lb,
          source_field_id: set.load_provenance.source_field_id,
        });
      }
    }
  }

  fs.writeFileSync(path.join(outDir, 'resolved-transcription.json'), JSON.stringify(assembled.resolved, null, 2));
  fs.writeFileSync(path.join(outDir, 'canonical-candidate.json'), JSON.stringify(assembled.canonical, null, 2));
  fs.writeFileSync(path.join(outDir, 'review-save-gate.json'), JSON.stringify({
    review: assembled.review,
    schema: assembled.schema,
    semantic: {
      valid: assembled.semantic.valid,
      errors: assembled.semantic.semanticErrors || assembled.semantic.errors || [],
    },
    save: assembled.save,
  }, null, 2));

  timings.total_ms = Date.now() - wall0;
  const issueCodes = [...new Set((assembled.review.issues || []).map((i) => i.code))];
  const record = {
    original_filename: photo.filename,
    photo_id: photo.photo_id,
    fileshare_id: photo.fileshare_id,
    image_sha256: photo.sha256,
    sheet_id: photo.photo_id,
    registration: {
      success: true,
      detected_ids: registration.detected_ids,
      error: null,
    },
    detected_template: spec.template_id,
    detected_routine: spec.routine,
    identity,
    structural_status: structuralStatus(checkboxes, fields),
    checkbox_counts: checkboxes.counts,
    blank_nonblank_counts: fields.counts,
    recognized_date_literal: assembled.header.date_literal,
    date_status: assembled.header.date_status,
    canonical_date: assembled.header.date,
    bodyweight_lb: assembled.header.bodyweight_lb,
    duration_min: assembled.header.duration_min,
    effort: assembled.canonical.workout.effort,
    pain: assembled.canonical.workout.pain?.level ?? null,
    completed_sets: completedSets,
    numeric_fields_processed: numericRun.results.length,
    numeric_unknown: numericRun.results.filter((r) => r.recognized === 'UNKNOWN').length,
    inherited_load_values: inherited.length,
    inherited_loads: inherited,
    review_issue_count: (assembled.review.issues || []).length,
    review_issue_codes: issueCodes,
    schema_valid: Boolean(assembled.save.schema_valid),
    semantic_valid: Boolean(assembled.save.semantic_valid),
    review_status: assembled.save.review_status,
    save_ready: Boolean(assembled.save.save_ready),
    blocking_issues: assembled.save.blocking_issues,
    non_blocking_issues: assembled.save.non_blocking_issues,
    processing_time_ms: timings.total_ms,
    latency: {
      registration_structure_ms: timings.registration_ms + timings.identity_ms + timings.structure_ms,
      registration_ms: timings.registration_ms,
      identity_ms: timings.identity_ms,
      structure_ms: timings.structure_ms,
      numeric_granite_ms: timings.numeric_granite_ms,
      header_granite_ms: timings.header_granite_ms,
      assembly_ms: timings.assembly_ms,
      total_ms: timings.total_ms,
    },
    artifacts: {
      registration_debug: path.join(outDir, 'registration-debug.png'),
      rectified: path.join(outDir, 'rectified.png'),
      field_overlay: path.join(outDir, 'field-overlay.png'),
      observations: observationsPath,
      numeric_recognition: path.join(outDir, 'numeric-recognition.json'),
      header_recognition: path.join(outDir, 'header-recognition.json'),
      resolved_transcription: path.join(outDir, 'resolved-transcription.json'),
      canonical_candidate: path.join(outDir, 'canonical-candidate.json'),
      review_save_gate: path.join(outDir, 'review-save-gate.json'),
    },
  };
  fs.writeFileSync(path.join(outDir, 'photo-result.json'), JSON.stringify(record, null, 2));
  return record;
}

function phase1Report(summary) {
  const lines = [
    '# POC #11 — Phase 1 Blind Run (STOP POINT A)',
    '',
    'Frozen production-candidate stack. No ground truth. No scoring. No tuning.',
    '',
    '## Freeze',
    '',
    `- Form: v1.3.1`,
    `- Detector: ${summary.freeze.detector_version} SHA256 \`${summary.freeze.detector_sha256}\``,
    `- Numeric: ${summary.freeze.recognizer} / ${summary.freeze.crop_profile} historical ${summary.freeze.granite_exact}/${summary.freeze.granite_total}`,
    `- Assembly: POC #9 deterministic assembler`,
    `- Header/schema/save-gate: POC #10, schema_version ${summary.freeze.schema_version}`,
    `- detect.py SHA256 \`${summary.freeze.detect_py_sha256}\``,
    '',
    '## Photos',
    '',
    'Six fresh fileshare photographs unused in POCs #7–#10:',
    '',
    ...summary.photos.map((p) => `- \`${p.original_filename}\` (\`${p.photo_id}\`)`),
    '',
    'Template identity is printed-title NCC against frozen A/B/C blank rasters. Handwriting was not inspected and was not used to choose a template.',
    '',
    `Blind results checksum: \`${summary.blind_results_sha256}\``,
    '',
    '## Per-photograph operational results',
    '',
    '| Photo | Registration | Template | Structural | Date literal | Canonical date | Effort | Pain | Sets | Numeric fields | Inherited loads | Review issues | Codes | schema_valid | semantic_valid | review_status | save_ready | Time (ms) |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const p of summary.photos) {
    lines.push([
      p.photo_id,
      p.registration.success ? 'PASS' : 'FAIL',
      p.detected_template || '—',
      p.structural_status,
      p.recognized_date_literal ?? '—',
      p.canonical_date ?? '—',
      p.effort ?? '—',
      p.pain ?? '—',
      p.completed_sets,
      p.numeric_fields_processed,
      p.inherited_load_values,
      p.review_issue_count,
      (p.review_issue_codes || []).join(', ') || '—',
      p.schema_valid,
      p.semantic_valid,
      p.review_status,
      p.save_ready,
      p.processing_time_ms,
    ].join(' | ').replace(/^/, '| ').concat(' |'));
  }
  lines.push(
    '',
    '## Totals (operational, not accuracy)',
    '',
    `- Registration success: ${summary.totals.registration_success}/6`,
    `- First-pass save_ready: ${summary.totals.save_ready}/6`,
    `- Review required: ${summary.totals.review_required}/6`,
    `- Mean total latency: ${summary.latency.mean_ms} ms`,
    `- Median total latency: ${summary.latency.median_ms} ms`,
    `- Min/max total latency: ${summary.latency.min_ms} / ${summary.latency.max_ms} ms`,
    '',
    'Recognition accuracy is **not claimed**. Ground truth has not been supplied.',
    '',
    '## STOP POINT A',
    '',
    'Phase 1 outputs under `artifacts/poc11/blind/` are frozen. They must not be modified after ground truth is known.',
    '',
    'Human ground truth is now required for the six physical sheets. For each photograph please provide/approve what is actually written:',
    '',
    '- template/routine',
    '- date literal as written (do not normalize)',
    '- bodyweight, duration, effort, pain',
    '- each completed set',
    '- explicit written load vs blank load intended for inheritance',
    '- BW checkboxes',
    '- reps / left/right reps / seconds / left/right seconds',
    '- optional text presence',
    '',
    'Do not change pipeline outputs to match the paper. Phase 2/3 will score the immutable blind results against that ground truth.',
    '',
  );
  return lines.join('\n');
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

export async function runPoc11Blind({ onProgress } = {}) {
  const freezeSnap = assertDetectorFrozen();
  const numeric = poc9Regression();
  if (freezeSnap.detector_sha256 !== FROZEN_DETECTOR_SHA256) {
    throw new Error('detector hash mismatch');
  }
  if (sha256File(DETECT_PY) !== DETECT_PY_SHA256) {
    throw new Error('detect.py hash mismatch');
  }
  if (numeric.membership !== 519 || numeric.granite_exact !== 502) {
    throw new Error('numeric freeze mismatch');
  }
  const photos = poc11Photos();
  const fresh = assertPoc11PhotosFresh(photos);
  if (!fresh.ok) throw new Error(fresh.errors.join('; '));

  fs.mkdirSync(POC11_BLIND_DIR, { recursive: true });
  const records = [];
  for (const photo of photos) {
    onProgress?.({ stage: 'photo', photo_id: photo.photo_id });
    records.push(await processBlindPhoto(photo, { onProgress }));
  }

  const totalsMs = records.map((r) => r.processing_time_ms);
  const freeze = {
    detector_version: DETECTOR_VERSION,
    detector_sha256: freezeSnap.detector_sha256,
    detect_py_sha256: sha256File(DETECT_PY),
    recognizer: RECOGNIZER_ID,
    crop_profile: CROP_PROFILE,
    schema_version: SCHEMA_VERSION,
    granite_exact: numeric.granite_exact,
    granite_total: numeric.granite_total,
    numeric_prompt: VLM_PROMPT,
    header_prompts: HEADER_PROMPTS,
    identity_method: 'printed-title-ncc-vs-blank-rasters',
  };

  const results = {
    poc: 11,
    phase: 1,
    status: 'BLIND_FROZEN',
    captured_at: new Date().toISOString(),
    freeze,
    photos: records,
  };
  const resultsPath = path.join(POC11_BLIND_DIR, 'blind-results.json');
  fs.writeFileSync(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
  const sha = sha256File(resultsPath);
  fs.writeFileSync(path.join(POC11_BLIND_DIR, 'blind-results.sha256'), `${sha}\n`);

  const summary = {
    poc: 11,
    phase: 1,
    status: 'BLIND_FROZEN',
    freeze,
    blind_results_sha256: sha,
    photos: records.map((p) => ({
      original_filename: p.original_filename,
      photo_id: p.photo_id,
      registration: p.registration,
      detected_template: p.detected_template,
      detected_routine: p.detected_routine,
      identity_ncc: p.identity?.ncc ?? null,
      identity_uncertain: p.identity?.uncertain ?? null,
      structural_status: p.structural_status,
      recognized_date_literal: p.recognized_date_literal,
      canonical_date: p.canonical_date,
      effort: p.effort,
      pain: p.pain,
      completed_sets: p.completed_sets,
      numeric_fields_processed: p.numeric_fields_processed,
      inherited_load_values: p.inherited_load_values,
      review_issue_count: p.review_issue_count,
      review_issue_codes: p.review_issue_codes,
      schema_valid: p.schema_valid,
      semantic_valid: p.semantic_valid,
      review_status: p.review_status,
      save_ready: p.save_ready,
      processing_time_ms: p.processing_time_ms,
      latency: p.latency,
    })),
    totals: {
      registration_success: records.filter((r) => r.registration.success).length,
      save_ready: records.filter((r) => r.save_ready).length,
      review_required: records.filter((r) => r.review_status === 'REVIEW_REQUIRED').length,
      auto_accept: records.filter((r) => r.review_status === 'AUTO_ACCEPT').length,
    },
    latency: {
      mean_ms: totalsMs.length ? Math.round(totalsMs.reduce((a, b) => a + b, 0) / totalsMs.length) : 0,
      median_ms: median(totalsMs),
      min_ms: totalsMs.length ? Math.min(...totalsMs) : 0,
      max_ms: totalsMs.length ? Math.max(...totalsMs) : 0,
    },
  };
  fs.writeFileSync(path.join(POC11_BLIND_DIR, 'blind-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  const report = phase1Report(summary);
  fs.writeFileSync(path.join(POC11_ARTIFACT_DIR, 'REPORT.md'), report);
  fs.writeFileSync(path.join(POC11_BLIND_DIR, 'PHASE1-BLIND-REPORT.md'), report);
  return summary;
}

export function frozenHistoricalUnchanged() {
  return {
    detector_sha256: sha256File(DETECTOR_CONFIG_PATH),
    detect_py_sha256: sha256File(DETECT_PY),
    membership: loadPoc8Membership().samples.length,
    granite_exact: loadPoc8bRows().filter((r) => r.clean === r.expected).length,
    historical_catalog: photoCatalog().length,
  };
}
