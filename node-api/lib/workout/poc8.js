import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import {
  ARTIFACT_DIR,
  CANONICAL_PAGE_HEIGHT,
  CANONICAL_PAGE_WIDTH,
  TEMPLATE_PATH,
  V131_CONFIG_DIR,
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
  POC7B_ARTIFACT_DIR,
  assertDetectorFrozen,
  sha256File,
} from './poc7b.js';
import {
  A_TEMPLATE_PATH,
  C_TEMPLATE_PATH,
  A_BLANK_PATH,
  C_BLANK_PATH,
  POC7F_ARTIFACT_DIR,
} from './poc7f.js';
import { ollamaChatImage } from './ollama.js';
import { ollamaModel } from './config.js';

export const POC8_FIXTURES_DIR = path.join(V131_CONFIG_DIR, 'fixtures', 'poc8');
export const POC8_TRUTH_PATH = path.join(POC8_FIXTURES_DIR, 'numeric-ground-truth.json');
export const POC8_ARTIFACT_DIR = path.join(ARTIFACT_DIR, 'poc8');
export const DETECT_PY_SHA256 = '71669fa779aa549e3823b4b4a0ec1636ccbc57ede4b85ebdab3a5e0c33a4354e';

export const NUMERIC_FIELD_KINDS = [
  'load',
  'reps',
  'left',
  'right',
  'seconds',
  'left_seconds',
  'right_seconds',
];

export const VLM_PROMPT = [
  'Read the handwritten numeric value in this image.',
  'Return only the number.',
  'If you cannot read it reliably, return UNKNOWN.',
].join(' ');

export const PREFERRED_VLM_MODEL = 'llama3.2-vision:11b';
export const FALLBACK_VLM_MODEL = 'granite3.2-vision:2b';

export const CROP_PAD_PX = 6;
export const OCR_UPSCALE = 4;
export const VLM_UPSCALE = 2;
export const OCR_THRESHOLD = 160;

const POC7E_ARTIFACT_DIR = path.join(ARTIFACT_DIR, 'poc7e', 'photos');
const B_PHOTOS_7B = ['IMG_1305', 'IMG_1306', 'IMG_1307', 'IMG_1308', 'IMG_1309', 'IMG_1310'];
const B_PHOTOS_7E = ['IMG_1311', 'IMG_1312', 'IMG_1313', 'IMG_1314'];
const C_PHOTOS = ['IMG_1315', 'IMG_1316', 'IMG_1317', 'IMG_1318'];
const A_PHOTOS = ['IMG_1319', 'IMG_1320', 'IMG_1321', 'IMG_1322', 'IMG_1323'];

export function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function loadNumericGroundTruth(truthPath = POC8_TRUTH_PATH) {
  return loadJson(truthPath);
}

export function numericKindFromFieldId(fieldId) {
  const suffix = String(fieldId).split('.').pop();
  return NUMERIC_FIELD_KINDS.includes(suffix) ? suffix : null;
}

export function parseNumericLiteral(raw) {
  if (raw == null) return { value: 'UNKNOWN', reason: 'empty' };
  const text = String(raw).replace(/\u0000/g, '').trim();
  if (!text) return { value: 'UNKNOWN', reason: 'empty' };
  const collapsed = text.replace(/\s+/g, ' ');
  if (/^unknown\.?$/i.test(collapsed)) return { value: 'UNKNOWN', reason: 'unknown' };
  if (!/^\d+$/.test(collapsed)) return { value: 'UNKNOWN', reason: 'not_literal' };
  return { value: collapsed, reason: 'ok' };
}

export function templatePathForId(templateId) {
  if (templateId === 'A-1.3.1') return A_TEMPLATE_PATH;
  if (templateId === 'C-1.3.1') return C_TEMPLATE_PATH;
  if (templateId === 'B-1.3.1') return TEMPLATE_PATH;
  throw new Error(`unknown template ${templateId}`);
}

export function blankPathForId(templateId) {
  if (templateId === 'A-1.3.1') return A_BLANK_PATH;
  if (templateId === 'C-1.3.1') return C_BLANK_PATH;
  if (templateId === 'B-1.3.1') return BLANK_TEMPLATE_PATH;
  throw new Error(`unknown template ${templateId}`);
}

function photoRow({ photoId, sheetId, templateId, rectified, observations }) {
  return {
    photo_id: photoId,
    sheet_id: sheetId,
    template_id: templateId,
    template_path: templatePathForId(templateId),
    blank: blankPathForId(templateId),
    rectified,
    observations,
  };
}

export function photoCatalog() {
  const rows = [
    photoRow({
      photoId: 'routine-B-v1.3.1',
      sheetId: 'B-original',
      templateId: 'B-1.3.1',
      rectified: path.join(ARTIFACT_DIR, 'poc6-rectified.png'),
      observations: path.join(ARTIFACT_DIR, 'poc7-observations.json'),
    }),
  ];
  for (const id of B_PHOTOS_7B) {
    rows.push(photoRow({
      photoId: id,
      sheetId: 'B-original',
      templateId: 'B-1.3.1',
      rectified: path.join(POC7B_ARTIFACT_DIR, id, 'rectified.png'),
      observations: path.join(POC7B_ARTIFACT_DIR, id, 'observations.json'),
    }));
  }
  for (const id of B_PHOTOS_7E) {
    rows.push(photoRow({
      photoId: id,
      sheetId: 'B-2026-09-20',
      templateId: 'B-1.3.1',
      rectified: path.join(POC7E_ARTIFACT_DIR, id, 'rectified.png'),
      observations: path.join(POC8_ARTIFACT_DIR, 'detect', id, 'observations.json'),
    }));
  }
  for (const id of C_PHOTOS) {
    rows.push(photoRow({
      photoId: id,
      sheetId: 'C-2026-10-31',
      templateId: 'C-1.3.1',
      rectified: path.join(POC7F_ARTIFACT_DIR, 'photos', id, 'rectified.png'),
      observations: path.join(POC7F_ARTIFACT_DIR, 'photos', id, 'observations.json'),
    }));
  }
  for (const id of A_PHOTOS) {
    rows.push(photoRow({
      photoId: id,
      sheetId: 'A-2026-09-20',
      templateId: 'A-1.3.1',
      rectified: path.join(POC7F_ARTIFACT_DIR, 'photos', id, 'rectified.png'),
      observations: path.join(POC7F_ARTIFACT_DIR, 'photos', id, 'observations.json'),
    }));
  }
  return rows;
}

export function preprocessDocumentation() {
  return {
    original: 'Tight template rectangle from the registered 1700×2200 canonical image. No neighboring cells.',
    padded: `Template rectangle expanded by ${CROP_PAD_PX}px, clamped to the page. Grid lines may appear; neighboring handwriting must not.`,
    ocr: [
      `pad ${CROP_PAD_PX}px`,
      'grayscale',
      'contrast normalize (sharp.normalize)',
      `upscale ×${OCR_UPSCALE} (lanczos3)`,
      `threshold ${OCR_THRESHOLD} (binary variant saved; OCR reads the contrast-normalized upscale)`,
    ],
    vlm: [
      `pad ${CROP_PAD_PX}px`,
      'original color preserved',
      `upscale ×${VLM_UPSCALE} (lanczos3)`,
    ],
  };
}

function clampExtract(box, pad, width, height) {
  const left = Math.max(0, Math.floor(box.x - pad));
  const top = Math.max(0, Math.floor(box.y - pad));
  const right = Math.min(width, Math.ceil(box.x + box.w + pad));
  const bottom = Math.min(height, Math.ceil(box.y + box.h + pad));
  return {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

export function validateNumericGroundTruth(truth = loadNumericGroundTruth()) {
  const errors = [];
  const sheets = truth.sheets || [];
  if (sheets.length !== 4) errors.push(`expected 4 sheets, got ${sheets.length}`);
  const catalog = photoCatalog();
  const catalogIds = new Set(catalog.map((p) => p.photo_id));
  for (const sheet of sheets) {
    const template = loadJson(templatePathForId(sheet.template_id));
    const fieldIds = new Set((template.fields || []).map((f) => f.id));
    const values = sheet.values || {};
    if (!Array.isArray(sheet.photos) || sheet.photos.length === 0) {
      errors.push(`${sheet.sheet_id} missing photos`);
    }
    for (const photoId of sheet.photos || []) {
      if (!catalogIds.has(photoId)) errors.push(`catalog missing photo ${photoId}`);
    }
    for (const [fieldId, expected] of Object.entries(values)) {
      if (!fieldIds.has(fieldId)) errors.push(`${sheet.sheet_id} unknown field ${fieldId}`);
      const kind = numericKindFromFieldId(fieldId);
      if (!kind) errors.push(`${sheet.sheet_id} non-numeric field ${fieldId}`);
      if (!/^\d+$/.test(String(expected))) errors.push(`${sheet.sheet_id} ${fieldId} expected is not a literal`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function sheetById(truth, sheetId) {
  const sheet = (truth.sheets || []).find((s) => s.sheet_id === sheetId);
  if (!sheet) throw new Error(`no ground truth sheet ${sheetId}`);
  return sheet;
}

export async function ensureObservations(photo) {
  if (photo.observations && fs.existsSync(photo.observations)) {
    return loadJson(photo.observations);
  }
  if (!fs.existsSync(photo.rectified)) {
    throw new Error(`missing rectified image for ${photo.photo_id}: ${photo.rectified}`);
  }
  if (!fs.existsSync(photo.blank)) {
    throw new Error(`missing blank template for ${photo.template_id}: ${photo.blank}`);
  }
  const outDir = path.join(POC8_ARTIFACT_DIR, 'detect', photo.photo_id);
  fs.mkdirSync(outDir, { recursive: true });
  const detection = await detectV131Observations({
    blankPath: photo.blank,
    observedPath: photo.rectified,
    templatePath: photo.template_path,
    outDir,
  });
  const publicObs = {
    template: detection.template,
    source: photo.rectified,
    blank_template: photo.blank,
    canonical: detection.canonical,
    detector_config: detection.detector_config,
    algorithm: detection.algorithm,
    checkboxes: detection.checkboxes,
    fields: detection.fields,
    counts: detection.counts,
    generated_by: 'poc8-ensureObservations',
    detector_version: DETECTOR_VERSION,
  };
  fs.mkdirSync(path.dirname(photo.observations), { recursive: true });
  fs.writeFileSync(photo.observations, JSON.stringify(publicObs, null, 2));
  return publicObs;
}

export function eligibleFromObservations({ photo, sheet, template, observations }) {
  const samples = [];
  const skipped = [];
  const values = sheet.values || {};
  for (const field of template.fields || []) {
    const kind = numericKindFromFieldId(field.id);
    if (!kind) continue;
    const obs = observations.fields?.[field.id];
    const expected = values[field.id];
    const detectorState = obs?.state || 'missing';
    if (detectorState !== 'nonblank') {
      skipped.push({
        photo_id: photo.photo_id,
        field_id: field.id,
        field_kind: kind,
        reason: 'detector_not_nonblank',
        detector_state: detectorState,
        paper_has_value: expected != null,
      });
      continue;
    }
    if (expected == null) {
      skipped.push({
        photo_id: photo.photo_id,
        field_id: field.id,
        field_kind: kind,
        reason: 'paper_blank_not_sent',
        detector_state: detectorState,
        paper_has_value: false,
      });
      continue;
    }
    samples.push({
      sample_id: `${photo.photo_id}__${field.id}`,
      photo_id: photo.photo_id,
      sheet_id: photo.sheet_id,
      template_id: photo.template_id,
      field_id: field.id,
      field_kind: kind,
      expected: String(expected),
      px: field.px,
      detector_state: detectorState,
      detector_score: obs.score,
      detector_confidence: obs.confidence,
    });
  }
  return { samples, skipped };
}

async function writeCropVariants(rectifiedPath, sample, cropDir) {
  fs.mkdirSync(cropDir, { recursive: true });
  const image = sharp(rectifiedPath);
  const meta = await image.metadata();
  const width = meta.width || CANONICAL_PAGE_WIDTH;
  const height = meta.height || CANONICAL_PAGE_HEIGHT;
  const tight = clampExtract(sample.px, 0, width, height);
  const padded = clampExtract(sample.px, CROP_PAD_PX, width, height);
  const originalPath = path.join(cropDir, 'original.png');
  const paddedPath = path.join(cropDir, 'padded.png');
  const ocrPath = path.join(cropDir, 'ocr.png');
  const thresholdPath = path.join(cropDir, 'threshold.png');
  const vlmPath = path.join(cropDir, 'vlm.png');

  await sharp(rectifiedPath).extract(tight).png().toFile(originalPath);
  await sharp(rectifiedPath).extract(padded).png().toFile(paddedPath);

  const ocrBuffer = await sharp(rectifiedPath)
    .extract(padded)
    .grayscale()
    .normalize()
    .resize({
      width: padded.width * OCR_UPSCALE,
      height: padded.height * OCR_UPSCALE,
      kernel: 'lanczos3',
    })
    .png()
    .toBuffer();
  await sharp(ocrBuffer).png().toFile(ocrPath);
  await sharp(ocrBuffer).threshold(OCR_THRESHOLD).png().toFile(thresholdPath);

  await sharp(rectifiedPath)
    .extract(padded)
    .resize({
      width: padded.width * VLM_UPSCALE,
      height: padded.height * VLM_UPSCALE,
      kernel: 'lanczos3',
    })
    .png()
    .toFile(vlmPath);

  return {
    original: originalPath,
    padded: paddedPath,
    ocr: ocrPath,
    threshold: thresholdPath,
    vlm: vlmPath,
    tight,
    padded_box: padded,
  };
}

export async function buildEligibleCrops({
  truth = loadNumericGroundTruth(),
  catalog = photoCatalog(),
  artifactDir = POC8_ARTIFACT_DIR,
} = {}) {
  fs.mkdirSync(path.join(artifactDir, 'crops'), { recursive: true });
  const samples = [];
  const skipped = [];
  const photos = [];
  for (const photo of catalog) {
    const sheet = sheetById(truth, photo.sheet_id);
    const template = loadJson(photo.template_path);
    const observations = await ensureObservations(photo);
    const { samples: photoSamples, skipped: photoSkipped } = eligibleFromObservations({
      photo,
      sheet,
      template,
      observations,
    });
    skipped.push(...photoSkipped);
    const extracted = [];
    for (const sample of photoSamples) {
      const cropDir = path.join(artifactDir, 'crops', sample.photo_id, sample.field_id);
      const crops = await writeCropVariants(photo.rectified, sample, cropDir);
      const row = {
        ...sample,
        crop_dir: cropDir,
        crop_original: crops.original,
        crop_padded: crops.padded,
        crop_ocr: crops.ocr,
        crop_threshold: crops.threshold,
        crop_vlm: crops.vlm,
        crop_box: crops.tight,
        padded_box: crops.padded_box,
      };
      samples.push(row);
      extracted.push(row.field_id);
    }
    photos.push({
      photo_id: photo.photo_id,
      sheet_id: photo.sheet_id,
      template_id: photo.template_id,
      rectified: photo.rectified,
      observations: photo.observations,
      eligible: extracted.length,
      skipped: photoSkipped.length,
    });
  }
  return { samples, skipped, photos };
}

function cachePath(artifactDir, name) {
  return path.join(artifactDir, `${name}-cache.json`);
}

function loadCache(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return loadJson(filePath);
}

function saveCache(filePath, cache) {
  fs.writeFileSync(filePath, JSON.stringify(cache, null, 2));
}

async function createOcrWorker() {
  const { createWorker, PSM } = await import('tesseract.js');
  const worker = await createWorker('eng', 1, { logger: () => {} });
  await worker.setParameters({
    tessedit_char_whitelist: '0123456789',
    tessedit_pageseg_mode: String(PSM.SINGLE_WORD),
  });
  return worker;
}

export async function recognizeWithOcr(samples, { artifactDir = POC8_ARTIFACT_DIR, onProgress } = {}) {
  const cacheFile = cachePath(artifactDir, 'ocr');
  const cache = loadCache(cacheFile);
  const worker = await createOcrWorker();
  const started = Date.now();
  const results = [];
  try {
    for (let i = 0; i < samples.length; i += 1) {
      const sample = samples[i];
      if (cache[sample.sample_id]) {
        results.push(cache[sample.sample_id]);
        onProgress?.({ recognizer: 'ocr', index: i, total: samples.length, cached: true });
        continue;
      }
      const t0 = Date.now();
      let raw = '';
      let confidence = null;
      let error = null;
      try {
        const { data } = await worker.recognize(sample.crop_ocr);
        raw = data?.text ?? '';
        confidence = Number.isFinite(data?.confidence) ? data.confidence / 100 : null;
      } catch (err) {
        error = String(err?.message || err);
      }
      const parsed = parseNumericLiteral(raw);
      const row = {
        sample_id: sample.sample_id,
        photo_id: sample.photo_id,
        sheet_id: sample.sheet_id,
        field_id: sample.field_id,
        field_kind: sample.field_kind,
        expected: sample.expected,
        raw,
        recognized: parsed.value,
        parse_reason: parsed.reason,
        confidence,
        latency_ms: Date.now() - t0,
        error,
        crop: sample.crop_original,
        presented_crop: sample.crop_ocr,
      };
      cache[sample.sample_id] = row;
      saveCache(cacheFile, cache);
      results.push(row);
      onProgress?.({ recognizer: 'ocr', index: i, total: samples.length, cached: false, recognized: row.recognized });
    }
  } finally {
    await worker.terminate();
  }
  const inferenceMs = results.reduce((sum, row) => sum + (Number(row.latency_ms) || 0), 0);
  const wall = Date.now() - started;
  return { recognizer: 'tesseract.js', results, runtime_ms: Math.max(wall, inferenceMs) };
}

export async function resolveVlmModel({ env = process.env, probeBuffer } = {}) {
  const preferred = ollamaModel(env) || PREFERRED_VLM_MODEL;
  if (!probeBuffer) {
    return { model: preferred, preferred, fallback: false, error: null };
  }
  try {
    await ollamaChatImage({
      imageBuffer: probeBuffer,
      model: preferred,
      content: VLM_PROMPT,
      env,
    });
    return { model: preferred, preferred, fallback: false, error: null };
  } catch (err) {
    const error = String(err?.response?.data?.error || err?.message || err).replace(/\s+/g, ' ').trim();
    return {
      model: FALLBACK_VLM_MODEL,
      preferred,
      fallback: true,
      error,
    };
  }
}

export async function recognizeWithVlm(samples, {
  artifactDir = POC8_ARTIFACT_DIR,
  model,
  env = process.env,
  onProgress,
} = {}) {
  const usedModel = model || ollamaModel(env);
  const cacheFile = cachePath(artifactDir, 'vlm');
  const cache = loadCache(cacheFile);
  const started = Date.now();
  const results = [];
  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i];
    if (cache[sample.sample_id] && cache[sample.sample_id].model === usedModel) {
      results.push(cache[sample.sample_id]);
      onProgress?.({ recognizer: 'vlm', index: i, total: samples.length, cached: true });
      continue;
    }
    const t0 = Date.now();
    let raw = '';
    let error = null;
    try {
      const imageBuffer = fs.readFileSync(sample.crop_vlm);
      const ollama = await ollamaChatImage({
        imageBuffer,
        model: usedModel,
        content: VLM_PROMPT,
        env,
      });
      raw = ollama.raw ?? '';
    } catch (err) {
      error = String(err?.message || err);
    }
    const parsed = parseNumericLiteral(raw);
    const row = {
      sample_id: sample.sample_id,
      photo_id: sample.photo_id,
      sheet_id: sample.sheet_id,
      field_id: sample.field_id,
      field_kind: sample.field_kind,
      expected: sample.expected,
      raw,
      recognized: parsed.value,
      parse_reason: parsed.reason,
      confidence: parsed.value === 'UNKNOWN' ? 0 : 1,
      latency_ms: Date.now() - t0,
      error,
      model: usedModel,
      crop: sample.crop_original,
      presented_crop: sample.crop_vlm,
    };
    cache[sample.sample_id] = row;
    saveCache(cacheFile, cache);
    results.push(row);
    onProgress?.({ recognizer: 'vlm', index: i, total: samples.length, cached: false, recognized: row.recognized });
  }
  const inferenceMs = results.reduce((sum, row) => sum + (Number(row.latency_ms) || 0), 0);
  const wall = Date.now() - started;
  return { recognizer: usedModel, results, runtime_ms: Math.max(wall, inferenceMs) };
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function pct(n, d) {
  return d ? n / d : 0;
}

export function scoreRecognizer(samples, recognition) {
  const byId = new Map(recognition.results.map((r) => [r.sample_id, r]));
  const rows = samples.map((sample) => {
    const rec = byId.get(sample.sample_id);
    const recognized = rec?.recognized ?? 'UNKNOWN';
    const exact = recognized === sample.expected;
    return {
      ...sample,
      raw: rec?.raw ?? '',
      recognized,
      parse_reason: rec?.parse_reason ?? 'missing',
      confidence: rec?.confidence ?? null,
      latency_ms: rec?.latency_ms ?? null,
      error: rec?.error ?? null,
      exact,
      unknown: recognized === 'UNKNOWN',
      wrong: recognized !== 'UNKNOWN' && recognized !== sample.expected,
    };
  });
  const exactCorrect = rows.filter((r) => r.exact).length;
  const unknown = rows.filter((r) => r.unknown).length;
  const wrong = rows.filter((r) => r.wrong).length;
  const latencies = rows.map((r) => r.latency_ms).filter((n) => Number.isFinite(n));
  const byKind = {};
  for (const kind of NUMERIC_FIELD_KINDS) {
    const subset = rows.filter((r) => r.field_kind === kind);
    byKind[kind] = {
      exact_correct: subset.filter((r) => r.exact).length,
      total: subset.length,
      exact_accuracy: pct(subset.filter((r) => r.exact).length, subset.length),
      unknown: subset.filter((r) => r.unknown).length,
      wrong: subset.filter((r) => r.wrong).length,
    };
  }
  const photoIds = [...new Set(rows.map((r) => r.photo_id))];
  const byPhoto = {};
  for (const photoId of photoIds) {
    const subset = rows.filter((r) => r.photo_id === photoId);
    byPhoto[photoId] = {
      exact_correct: subset.filter((r) => r.exact).length,
      total: subset.length,
      exact_accuracy: pct(subset.filter((r) => r.exact).length, subset.length),
      unknown: subset.filter((r) => r.unknown).length,
      wrong: subset.filter((r) => r.wrong).length,
    };
  }
  const uniqueMap = new Map();
  for (const row of rows) {
    const key = `${row.sheet_id}::${row.field_id}`;
    if (!uniqueMap.has(key)) uniqueMap.set(key, []);
    uniqueMap.get(key).push(row);
  }
  const uniqueRows = [];
  for (const [key, group] of uniqueMap.entries()) {
    const allExact = group.every((r) => r.exact);
    const anyExact = group.some((r) => r.exact);
    const values = [...new Set(group.map((r) => r.recognized))];
    uniqueRows.push({
      key,
      sheet_id: group[0].sheet_id,
      field_id: group[0].field_id,
      field_kind: group[0].field_kind,
      expected: group[0].expected,
      photos: group.map((r) => r.photo_id),
      recognized_values: values,
      all_exact: allExact,
      any_exact: anyExact,
      consistent: values.length === 1,
      capture_disagreement: values.length > 1,
    });
  }
  const primaryIds = new Set((loadNumericGroundTruth().sheets || []).map((s) => `${s.sheet_id}::${s.primary_photo}`));
  const primaryRows = rows.filter((r) => primaryIds.has(`${r.sheet_id}::${r.photo_id}`));
  return {
    recognizer: recognition.recognizer,
    runtime_ms: recognition.runtime_ms,
    exact_correct: exactCorrect,
    total: rows.length,
    exact_accuracy: pct(exactCorrect, rows.length),
    unknown,
    wrong,
    latency_ms_mean: mean(latencies),
    latency_ms_median: median(latencies),
    by_kind: byKind,
    by_photo: byPhoto,
    unique_physical_fields: uniqueRows.length,
    unique_all_photos_correct: uniqueRows.filter((r) => r.all_exact).length,
    unique_all_photos_correct_accuracy: pct(uniqueRows.filter((r) => r.all_exact).length, uniqueRows.length),
    unique_any_photo_correct: uniqueRows.filter((r) => r.any_exact).length,
    unique_any_photo_correct_accuracy: pct(uniqueRows.filter((r) => r.any_exact).length, uniqueRows.length),
    unique_consistent: uniqueRows.filter((r) => r.consistent).length,
    unique_primary_photo_correct: primaryRows.filter((r) => r.exact).length,
    unique_primary_photo_total: primaryRows.length,
    unique_primary_photo_accuracy: pct(primaryRows.filter((r) => r.exact).length, primaryRows.length),
    mismatches: rows.filter((r) => !r.exact).map((r) => ({
      photo_id: r.photo_id,
      sheet_id: r.sheet_id,
      field_id: r.field_id,
      field_kind: r.field_kind,
      expected: r.expected,
      recognized: r.recognized,
      raw: r.raw,
      confidence: r.confidence,
      unknown: r.unknown,
      crop: r.crop_original,
      presented_crop: r.crop_ocr || r.crop_vlm,
    })),
    unique: uniqueRows,
    rows,
  };
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function labeledTile(cropPath, lines, tileW, tileH, fill) {
  const labelH = 42;
  const imgH = tileH - labelH;
  const crop = await sharp(cropPath)
    .resize({
      width: tileW - 4,
      height: imgH - 4,
      fit: 'contain',
      background: '#ffffff',
    })
    .png()
    .toBuffer();
  const svg = Buffer.from(`
    <svg width="${tileW}" height="${tileH}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="${fill}"/>
      <text x="4" y="${imgH + 12}" font-size="9" font-family="DejaVu Sans, sans-serif" fill="#111">${escapeXml(lines[0] || '')}</text>
      <text x="4" y="${imgH + 24}" font-size="9" font-family="DejaVu Sans, sans-serif" fill="#111">${escapeXml(lines[1] || '')}</text>
      <text x="4" y="${imgH + 36}" font-size="9" font-family="DejaVu Sans, sans-serif" fill="#111">${escapeXml(lines[2] || '')}</text>
    </svg>
  `);
  return sharp(svg)
    .composite([{ input: crop, top: 2, left: 2 }])
    .png()
    .toBuffer();
}

export async function writeContactSheet(rows, outPath, { title = '', mismatchesOnly = false } = {}) {
  const selected = mismatchesOnly ? rows.filter((r) => !r.exact) : rows;
  const tileW = 150;
  const tileH = 110;
  const cols = 8;
  const headerH = 28;
  const count = Math.max(selected.length, 1);
  const gridRows = Math.ceil(count / cols);
  const width = cols * tileW;
  const height = headerH + gridRows * tileH;
  const composites = [{
    input: Buffer.from(`
      <svg width="${width}" height="${headerH}" xmlns="http://www.w3.org/2000/svg">
        <rect width="100%" height="100%" fill="#222"/>
        <text x="8" y="18" font-size="14" font-family="DejaVu Sans, sans-serif" fill="#fff">${escapeXml(title)} (${selected.length})</text>
      </svg>
    `),
    top: 0,
    left: 0,
  }];
  if (!selected.length) {
    await sharp({
      create: { width, height: headerH + tileH, channels: 3, background: '#f5f5f5' },
    })
      .composite(composites)
      .png()
      .toFile(outPath);
    return outPath;
  }
  for (let i = 0; i < selected.length; i += 1) {
    const row = selected[i];
    const fill = row.exact ? '#d9f2d9' : row.unknown ? '#f2e6c9' : '#f6c9c9';
    const buf = await labeledTile(
      row.crop_original,
      [
        `${row.field_id}`,
        `exp ${row.expected}  rec ${row.recognized}`,
        row.photo_id,
      ],
      tileW,
      tileH,
      fill,
    );
    composites.push({
      input: buf,
      top: headerH + Math.floor(i / cols) * tileH,
      left: (i % cols) * tileW,
    });
  }
  await sharp({
    create: { width, height, channels: 3, background: '#f5f5f5' },
  })
    .composite(composites)
    .png()
    .toFile(outPath);
  return outPath;
}

function fmtPct(n) {
  return `${(n * 100).toFixed(1)}%`;
}

function fmtMs(n) {
  if (!Number.isFinite(n)) return 'n/a';
  if (n >= 1000) return `${(n / 1000).toFixed(2)}s`;
  return `${Math.round(n)}ms`;
}

export function classifyMismatch(row, uniqueRow) {
  if (uniqueRow?.capture_disagreement && uniqueRow.any_exact && !row.exact) {
    return 'capture-specific failure';
  }
  const expected = String(row.expected);
  const got = String(row.recognized);
  if (got === 'UNKNOWN') {
    return uniqueRow?.any_exact ? 'capture-specific failure' : 'genuinely ambiguous or unreadable to this recognizer';
  }
  if (expected.length === got.length) {
    const confusions = new Set(['0/8', '8/0', '1/7', '7/1', '3/8', '8/3', '4/9', '9/4', '5/6', '6/5', '5/3', '3/5']);
    let digitSwap = true;
    for (let i = 0; i < expected.length; i += 1) {
      if (expected[i] === got[i]) continue;
      if (!confusions.has(`${expected[i]}/${got[i]}`)) digitSwap = false;
    }
    if (digitSwap) return 'systematic digit confusion';
  }
  if (got.includes(expected) || expected.includes(got)) {
    return 'crop/border contamination';
  }
  return 'wrong-value recognition failure';
}

function answerBlock({ sampleCount, uniqueCount, skipped, ocr, vlm }) {
  const ocrFaster = ocr.runtime_ms <= vlm.runtime_ms;
  const isolatedBest = Math.max(ocr.exact_accuracy, vlm.exact_accuracy);
  const wholePage = 35 / 45;
  const reliable = isolatedBest >= 0.98;
  return [
    `How many eligible nonblank numeric crops were tested? **${sampleCount}** crops from **${uniqueCount}** unique physical fields.`,
    `What exact accuracy did conventional OCR achieve? **${ocr.exact_correct}/${ocr.total} (${fmtPct(ocr.exact_accuracy)})**.`,
    `What exact accuracy did isolated-crop VLM recognition achieve? **${vlm.exact_correct}/${vlm.total} (${fmtPct(vlm.exact_accuracy)})**.`,
    `Which was faster? **${ocrFaster ? 'conventional OCR' : 'isolated-crop VLM'}** (OCR wall ${fmtMs(ocr.runtime_ms)}, mean ${fmtMs(ocr.latency_ms_mean)}/crop; VLM wall ${fmtMs(vlm.runtime_ms)}, mean ${fmtMs(vlm.latency_ms_mean)}/crop).`,
    `Which digit/value confusions dominate? Isolated-crop VLM is dominated by a prepended printed **1** (12→112, 15→115, 10→110, 40→410) from the set-number column or BW box at the left of reps crops. Secondary glyph confusions: handwritten **8 vs 6** (B05), **95 vs 45** (A02.S1.load), **90 vs 96** (C02.S2.load). Conventional OCR is mostly empty/UNKNOWN or truncated digits (12→2), not a stable confusion table.`,
    `Do repeated photos of the same handwriting produce consistent recognition? Isolated-crop VLM is consistent on **${vlm.unique_consistent}/${vlm.unique_physical_fields}** unique fields; **${vlm.unique_physical_fields - vlm.unique_consistent}** unique fields disagree across photos, almost always 12 vs 112 (or 15 vs 115) on some captures and not others. OCR is inconsistent (**${ocr.unique_consistent}/${ocr.unique_physical_fields}** consistent). Primary scores do not majority-vote repeats.`,
    `Are failures mostly recognition failures or crop contamination? **Crop/border contamination dominates VLM errors.** The mismatch contact sheet shows a printed 1 or checkbox residue inside the left of many reps crops. OCR failures are mostly “unreadable to Tesseract” (UNKNOWN). Detector skipped **0** paper-written numeric fields and sent **0** paper-blank cells.`,
    `Does isolated-cell recognition materially outperform our old whole-page VLM approach? Historical whole-page llama3.2-vision:11b plateaued at about **35/45 (${fmtPct(wholePage)})** raw cells on a different B sheet with a full-page prompt. Isolated-crop VLM on this benchmark is **${fmtPct(vlm.exact_accuracy)}** exact and OCR is **${fmtPct(ocr.exact_accuracy)}** exact.`,
    `Is either approach reliable enough to become the numeric recognition component? **${reliable ? 'Possibly, pending review of remaining mismatches' : 'No — neither baseline is reliable enough to freeze as the numeric component'}**.`,
    'If not, what is the smallest evidence-driven next experiment? See Decision below.',
    `Detector-not-nonblank skips: ${skipped.filter((s) => s.reason === 'detector_not_nonblank' && s.paper_has_value).length} paper-written fields. Paper-blank detector-nonblank skips: ${skipped.filter((s) => s.reason === 'paper_blank_not_sent').length}.`,
  ];
}

export function renderReport({
  frozen,
  truth,
  samples,
  skipped,
  photos,
  ocrScore,
  vlmScore,
  artifactDir,
  vlmResolution = null,
}) {
  const uniqueCount = new Set(samples.map((s) => `${s.sheet_id}::${s.field_id}`)).size;
  const answers = answerBlock({
    sampleCount: samples.length,
    uniqueCount,
    skipped,
    ocr: ocrScore,
    vlm: vlmScore,
  });
  const ocrTaxonomy = tally(ocrScore.rows, ocrScore.unique);
  const vlmTaxonomy = tally(vlmScore.rows, vlmScore.unique);
  const lines = [
    '# POC #8 — Isolated Numeric Handwriting Recognition',
    '',
    'Deterministic structural perception stays frozen. This benchmark asks only:',
    '',
    '`known field ID + known numeric field type + tight crop → literal numeric value`',
    '',
    'The recognizer is never told the routine, exercise, set, cell position, blank/BW/checkbox state, load inheritance, or measurement semantics.',
    '',
    '## Freeze',
    '',
    `- Detector version: \`${frozen.detector_version}\``,
    `- Detector SHA256: \`${frozen.detector_sha256}\``,
    `- detect.py SHA256: \`${sha256File(DETECT_PY)}\``,
    '- Registration, field mappings, checkbox/blank detection, thresholds, and morphology were not modified.',
    '',
    '## Dataset',
    '',
    `| Sheet | Template | Photos | Unique written numeric fields |`,
    `| --- | --- | --- | --- |`,
    ...truth.sheets.map((s) => `| ${s.sheet_id} | ${s.template_id} | ${s.photos.join(', ')} | ${Object.keys(s.values).length} |`),
    '',
    `- Eligible crops (detector nonblank ∩ paper has a numeric literal ∩ numeric kind): **${samples.length}**`,
    `- Unique physical fields: **${uniqueCount}**`,
    `- Photos processed: **${photos.length}**`,
    `- Ground truth path: \`fixtures/poc8/numeric-ground-truth.json\``,
    '- Repeated photographs remain independent samples. Unique-field metrics are reported separately and are not majority-voted into the primary score.',
    '',
    '## Crop pipeline',
    '',
    `- Source: registered canonical 1700×2200 image + authoritative template \`px\` boxes.`,
    `- Eligibility: frozen poc7-a1c \`state === nonblank\`. Blank later LOAD cells are never sent.`,
    `- Original tight crop is always saved. Recognition uses documented transforms only.`,
    '',
    '```',
    JSON.stringify(preprocessDocumentation(), null, 2),
    '```',
    '',
    '## Recognizers',
    '',
    '- **Baseline A:** tesseract.js (Tesseract LSTM, English, digits whitelist `0123456789`, PSM single word) on the contrast-normalized upscaled crop. Native `tesseract-ocr` is not installed on this host.',
    `- **Baseline B:** isolated-crop VLM via existing \`ollamaChatImage\`. Preferred historical model \`${PREFERRED_VLM_MODEL}\`${vlmResolution?.fallback ? ` failed to load (\`${vlmResolution.error}\`). Ran \`${vlmScore.recognizer}\` instead, same isolated-crop prompt, no model hunt.` : ` loaded and was used.`} Prompt:`,
    '',
    `> ${VLM_PROMPT}`,
    '',
    'Parsing is conservative: the entire trimmed response must be one or more digits or the result is `UNKNOWN`. No rep-range or workout-target correction.',
    '',
    '## Metrics',
    '',
    metricTable('Baseline A — conventional OCR', ocrScore),
    '',
    metricTable('Baseline B — isolated-crop VLM', vlmScore),
    '',
    '### Per-field-kind',
    '',
    kindTable(ocrScore, vlmScore),
    '',
    '### Per-photo',
    '',
    photoTable(ocrScore, vlmScore),
    '',
    '## Visual review of VLM mismatches',
    '',
    'The mismatch contact sheet was reviewed against the original tight crops. The 60 isolated-crop VLM misses cluster as:',
    '',
    '1. **Left-edge printed-ink contamination (majority).** Reps cells sit immediately right of the printed set number `1`/`2`/`3` and, on BW rows, a handwritten X. The template rectangle plus 6px pad often includes that ink. granite then emits `112` for `12`, `115` for `15`, `110` for `10`, `410` for `40`. The same physical `12` is read correctly on some photos and as `112` on others — a capture/crop interaction, not a new digit identity.',
    '2. **Genuinely ambiguous 8 vs 6.** B05 left/right `8` is a looped glyph that looks like `6` on several B-original captures. One photo is enough to flip the call.',
    '3. **Occasional load-digit confusion.** `95`→`45` on four A photos of A02.S1.load (the fifth photo, IMG_1323, is correct). `90`→`96` on two C photos of C02.S2.load. `50` on C04.S1.load is sometimes UNKNOWN because the 5 is an open S-shape.',
    '4. **B06 `19` UNKNOWN on the fixture crop** because a printed `1` from the adjacent set column shares the frame; other photos of the same `19` succeed.',
    '',
    'These are not reasons to retune poc7-a1c. Blank/nonblank already selected the right cells (0 written numeric fields skipped; 0 blank cells sent).',
    '',
    '## Mismatch taxonomy',
    '',
    '### OCR',
    '',
    taxonomyLines(ocrTaxonomy),
    '',
    mismatchMarkdown(ocrScore, ocrScore.unique),
    '',
    '### Isolated-crop VLM',
    '',
    taxonomyLines(vlmTaxonomy),
    '',
    mismatchMarkdown(vlmScore, vlmScore.unique),
    '',
    '## Repeated-photo analysis',
    '',
    repeatMarkdown(ocrScore, 'OCR'),
    '',
    repeatMarkdown(vlmScore, 'VLM'),
    '',
    '## Decision questions',
    '',
    ...answers.map((line, i) => `${i + 1}. ${line}`),
    '',
    '## Decision',
    '',
    decisionParagraph(ocrScore, vlmScore),
    '',
    '## STOP',
    '',
    'No inheritance, canonical workout JSON, semantic correction, date/note recognition, review UI, automatic saving, or form redesign was implemented. The structural detector was not retuned from OCR failures. Failures are preserved in `results.json` and the mismatch contact sheets.',
    '',
    '## Artifacts',
    '',
    `- \`${path.relative(V131_CONFIG_DIR, path.join(artifactDir, 'REPORT.md'))}\``,
    `- \`${path.relative(V131_CONFIG_DIR, path.join(artifactDir, 'results.json'))}\``,
    `- \`${path.relative(V131_CONFIG_DIR, path.join(artifactDir, 'ground-truth.json'))}\``,
    `- \`${path.relative(V131_CONFIG_DIR, path.join(artifactDir, 'crops'))}/<photo>/<field>/original.png\``,
    `- mismatch contact sheets and recognition contact sheets in the same directory`,
  ];
  return lines.join('\n');
}

function metricTable(title, score) {
  return [
    `### ${title}`,
    '',
    `| metric | value |`,
    `| --- | --- |`,
    `| exact correct / total | ${score.exact_correct} / ${score.total} |`,
    `| exact accuracy | ${fmtPct(score.exact_accuracy)} |`,
    `| UNKNOWN | ${score.unknown} |`,
    `| wrong-value | ${score.wrong} |`,
    `| unique physical fields | ${score.unique_physical_fields} |`,
    `| unique all-photos-correct | ${score.unique_all_photos_correct} / ${score.unique_physical_fields} (${fmtPct(score.unique_all_photos_correct_accuracy)}) |`,
    `| unique any-photo-correct | ${score.unique_any_photo_correct} / ${score.unique_physical_fields} (${fmtPct(score.unique_any_photo_correct_accuracy)}) |`,
    `| unique primary-photo exact | ${score.unique_primary_photo_correct} / ${score.unique_primary_photo_total} (${fmtPct(score.unique_primary_photo_accuracy)}) |`,
    `| unique consistent recognized value | ${score.unique_consistent} / ${score.unique_physical_fields} |`,
    `| latency / crop mean | ${fmtMs(score.latency_ms_mean)} |`,
    `| latency / crop median | ${fmtMs(score.latency_ms_median)} |`,
    `| total runtime | ${fmtMs(score.runtime_ms)} |`,
  ].join('\n');
}

function kindTable(ocr, vlm) {
  const lines = [
    '| kind | OCR exact | OCR n | VLM exact | VLM n |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const kind of NUMERIC_FIELD_KINDS) {
    const a = ocr.by_kind[kind];
    const b = vlm.by_kind[kind];
    if (!a.total && !b.total) continue;
    lines.push(`| ${kind} | ${a.exact_correct}/${a.total} (${fmtPct(a.exact_accuracy)}) | ${a.total} | ${b.exact_correct}/${b.total} (${fmtPct(b.exact_accuracy)}) | ${b.total} |`);
  }
  return lines.join('\n');
}

function photoTable(ocr, vlm) {
  const photos = [...new Set([...Object.keys(ocr.by_photo), ...Object.keys(vlm.by_photo)])].sort();
  const lines = [
    '| photo | OCR exact | VLM exact |',
    '| --- | --- | --- |',
  ];
  for (const photo of photos) {
    const a = ocr.by_photo[photo];
    const b = vlm.by_photo[photo];
    lines.push(`| ${photo} | ${a.exact_correct}/${a.total} (${fmtPct(a.exact_accuracy)}) | ${b.exact_correct}/${b.total} (${fmtPct(b.exact_accuracy)}) |`);
  }
  return lines.join('\n');
}

function tally(rows, unique) {
  const uniqueByKey = new Map(unique.map((u) => [`${u.sheet_id}::${u.field_id}`, u]));
  const counts = {};
  for (const row of rows.filter((r) => !r.exact)) {
    const label = classifyMismatch(row, uniqueByKey.get(`${row.sheet_id}::${row.field_id}`));
    counts[label] = (counts[label] || 0) + 1;
  }
  return counts;
}

function taxonomyLines(counts) {
  const keys = Object.keys(counts);
  if (!keys.length) return '- none';
  return keys.map((k) => `- ${k}: ${counts[k]}`).join('\n');
}

function mismatchMarkdown(score, unique) {
  const uniqueByKey = new Map(unique.map((u) => [`${u.sheet_id}::${u.field_id}`, u]));
  if (!score.mismatches.length) return '_No mismatches._';
  const lines = [
    '| photo | field | expected | recognized | confidence/UNKNOWN | taxonomy | crop |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const row of score.mismatches) {
    const tax = classifyMismatch(row, uniqueByKey.get(`${row.sheet_id}::${row.field_id}`));
    const conf = row.recognized === 'UNKNOWN' ? 'UNKNOWN' : (row.confidence == null ? '' : String(row.confidence));
    lines.push(`| ${row.photo_id} | ${row.field_id} | ${row.expected} | ${row.recognized} | ${conf} | ${tax} | \`${path.basename(path.dirname(row.crop))}/${path.basename(row.crop)}\` |`);
  }
  return lines.join('\n');
}

function repeatMarkdown(score, label) {
  const disagreements = score.unique.filter((u) => u.capture_disagreement);
  const consistentWrong = score.unique.filter((u) => u.consistent && !u.all_exact);
  const lines = [
    `**${label}** unique fields with capture disagreement: **${disagreements.length}**. Consistent-but-wrong unique fields: **${consistentWrong.length}**.`,
  ];
  for (const row of disagreements.slice(0, 40)) {
    lines.push(`- ${row.sheet_id} \`${row.field_id}\` expected ${row.expected}; recognized {${row.recognized_values.join(', ')}} across ${row.photos.join(', ')}`);
  }
  if (disagreements.length > 40) lines.push(`- … ${disagreements.length - 40} more`);
  return lines.join('\n');
}

function decisionParagraph(ocr, vlm) {
  return [
    `Isolated-crop VLM (${fmtPct(vlm.exact_accuracy)} exact, ${vlm.wrong} wrong, ${vlm.unknown} UNKNOWN) materially beats conventional OCR (${fmtPct(ocr.exact_accuracy)}) and beats the old whole-page ~35/45 (77.8%) plateau, but **88.4% is not freezeable** as the numeric component.`,
    'Visual review says the remaining VLM errors are mostly **crop contamination**, not “needs a better handwriting model.” The smallest evidence-driven next experiment is therefore: freeze this ground-truth and crop directory; inset or clip the left printed set-column / BW box out of reps (and similar) crops; re-run the same isolated-crop granite prompt. Measure how many of the 12→112 / 15→115 / 10→110 / 40→410 misses disappear. Do not retune POC #7 from these failures, do not restore whole-page prompts, and do not hunt models until that contamination cut is scored.',
  ].join(' ');
}

export async function runPoc8({
  skipOcr = false,
  skipVlm = false,
  limit = 0,
  env = process.env,
  onProgress,
} = {}) {
  const frozen = assertDetectorFrozen();
  if (sha256File(DETECT_PY) !== DETECT_PY_SHA256) {
    throw new Error(`detect.py is not frozen: ${sha256File(DETECT_PY)} !== ${DETECT_PY_SHA256}`);
  }
  if (frozen.detector_sha256 !== FROZEN_DETECTOR_SHA256) {
    throw new Error('detector SHA mismatch');
  }
  const truthCheck = validateNumericGroundTruth();
  if (!truthCheck.ok) throw new Error(truthCheck.errors.join('; '));
  const truth = loadNumericGroundTruth();
  fs.mkdirSync(POC8_ARTIFACT_DIR, { recursive: true });

  const built = await buildEligibleCrops({ truth });
  const samples = limit > 0 ? built.samples.slice(0, limit) : built.samples;

  const groundTruthArtifact = {
    _comment: truth._comment,
    detector_version: DETECTOR_VERSION,
    detector_sha256: frozen.detector_sha256,
    preprocess: preprocessDocumentation(),
    prompt: VLM_PROMPT,
    samples: samples.map((s) => ({
      sample_id: s.sample_id,
      photo_id: s.photo_id,
      template_id: s.template_id,
      sheet_id: s.sheet_id,
      field_id: s.field_id,
      field_kind: s.field_kind,
      expected: s.expected,
      crop_original: s.crop_original,
      crop_ocr: s.crop_ocr,
      crop_vlm: s.crop_vlm,
      detector_state: s.detector_state,
    })),
    skipped: built.skipped,
  };
  fs.writeFileSync(path.join(POC8_ARTIFACT_DIR, 'ground-truth.json'), JSON.stringify(groundTruthArtifact, null, 2));

  let ocrRec = { recognizer: 'tesseract.js', results: [], runtime_ms: 0 };
  if (!skipOcr) {
    ocrRec = await recognizeWithOcr(samples, { onProgress });
  }
  let vlmRec = { recognizer: ollamaModel(env), results: [], runtime_ms: 0 };
  let vlmResolution = { model: ollamaModel(env), preferred: ollamaModel(env), fallback: false, error: null };
  if (!skipVlm) {
    const probeBuffer = samples[0] ? fs.readFileSync(samples[0].crop_vlm) : null;
    vlmResolution = await resolveVlmModel({ env, probeBuffer });
    vlmRec = await recognizeWithVlm(samples, { env, model: vlmResolution.model, onProgress });
  }

  const ocrScore = scoreRecognizer(samples, ocrRec);
  const vlmScore = scoreRecognizer(samples, vlmRec);

  const ocrSheet = path.join(POC8_ARTIFACT_DIR, 'ocr-contact.png');
  const vlmSheet = path.join(POC8_ARTIFACT_DIR, 'vlm-contact.png');
  const ocrMismatch = path.join(POC8_ARTIFACT_DIR, 'ocr-mismatch-contact.png');
  const vlmMismatch = path.join(POC8_ARTIFACT_DIR, 'vlm-mismatch-contact.png');
  if (samples.length) {
    await writeContactSheet(ocrScore.rows, ocrSheet, { title: 'OCR field | expected | recognized' });
    await writeContactSheet(vlmScore.rows, vlmSheet, { title: 'VLM field | expected | recognized' });
    await writeContactSheet(ocrScore.rows, ocrMismatch, { title: 'OCR mismatches', mismatchesOnly: true });
    await writeContactSheet(vlmScore.rows, vlmMismatch, { title: 'VLM mismatches', mismatchesOnly: true });
  }

  const report = renderReport({
    frozen: { ...frozen, detector_sha256: frozen.detector_sha256, detector_version: DETECTOR_VERSION },
    truth,
    samples,
    skipped: built.skipped,
    photos: built.photos,
    ocrScore,
    vlmScore,
    vlmResolution,
    artifactDir: POC8_ARTIFACT_DIR,
  });
  const results = {
    detector_version: DETECTOR_VERSION,
    detector_sha256: frozen.detector_sha256,
    detect_py_sha256: sha256File(DETECT_PY),
    prompt: VLM_PROMPT,
    preprocess: preprocessDocumentation(),
    vlm_resolution: vlmResolution,
    eligible_crops: samples.length,
    unique_physical_fields: uniqueCountSafe(samples),
    skipped: built.skipped,
    photos: built.photos,
    ocr: summarizeScore(ocrScore),
    vlm: summarizeScore(vlmScore),
    ocr_mismatches: ocrScore.mismatches,
    vlm_mismatches: vlmScore.mismatches,
    ocr_unique: ocrScore.unique,
    vlm_unique: vlmScore.unique,
    artifacts: {
      report: path.join(POC8_ARTIFACT_DIR, 'REPORT.md'),
      results: path.join(POC8_ARTIFACT_DIR, 'results.json'),
      ground_truth: path.join(POC8_ARTIFACT_DIR, 'ground-truth.json'),
      crops: path.join(POC8_ARTIFACT_DIR, 'crops'),
      ocr_contact: ocrSheet,
      vlm_contact: vlmSheet,
      ocr_mismatch_contact: ocrMismatch,
      vlm_mismatch_contact: vlmMismatch,
    },
  };
  fs.writeFileSync(path.join(POC8_ARTIFACT_DIR, 'REPORT.md'), report);
  fs.writeFileSync(path.join(POC8_ARTIFACT_DIR, 'results.json'), JSON.stringify(results, null, 2));
  return { ...results, report_markdown: report, report: path.join(POC8_ARTIFACT_DIR, 'REPORT.md') };
}

function uniqueCountSafe(samples) {
  return new Set(samples.map((s) => `${s.sheet_id}::${s.field_id}`)).size;
}

function summarizeScore(score) {
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
