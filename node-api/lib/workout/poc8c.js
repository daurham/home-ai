import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { ARTIFACT_DIR } from './poc6/index.js';
import { DETECT_PY, DETECTOR_CONFIG_PATH } from './poc7/index.js';
import {
  DETECTOR_VERSION,
  FROZEN_DETECTOR_SHA256,
  assertDetectorFrozen,
  sha256File,
} from './poc7b.js';
import { ollamaChatImage } from './ollama.js';
import {
  DETECT_PY_SHA256,
  VLM_PROMPT,
  VLM_UPSCALE,
  loadJson,
  parseNumericLiteral,
  writeContactSheet,
} from './poc8.js';
import {
  POC8B_ARTIFACT_DIR,
  POC8B_MODEL,
  loadPoc8Membership,
} from './poc8b.js';

export const POC8C_ARTIFACT_DIR = path.join(ARTIFACT_DIR, 'poc8c');
export const POC8B_RESULTS = path.join(POC8B_ARTIFACT_DIR, 'results.json');
export const POC8B_VLM_CACHE = path.join(POC8B_ARTIFACT_DIR, 'vlm-cache.json');
export const EXPERIMENT_A_RUNS = 3;
export const EXPERIMENT_B_VARIANTS = ['gray', 'contrast'];
export const CROP_PROFILE_CLEAN = 'poc8b-clean';
export const CONFIDENCE_POLICY = 'variant-unanimity-v1';
export const VARIANT_OPS = {
  original: 'Frozen POC #8B vlm.png: geometry-clean extract, color, Lanczos ×2. Not regenerated or re-inferred.',
  gray: 'sharp(clean.png).grayscale().resize(×2, kernel lanczos3).png() — no threshold, same bounds, no extra crop.',
  contrast: 'sharp(clean.png).normalize().resize(×2, kernel lanczos3).png() — modest histogram stretch, no threshold, same bounds, no extra crop.',
};

export const GENERATION_SETTINGS = {
  model: POC8B_MODEL,
  temperature: 0,
  stream: false,
  seed: null,
  top_p: null,
  format: null,
  prompt: VLM_PROMPT,
  crop_profile: CROP_PROFILE_CLEAN,
  note: 'chatImageBody options.temperature=0, stream=false, no seed. Same bytes + same prompt.',
};

export const RESIDUAL_FAMILIES = [
  {
    id: 'B05-8-6',
    label: 'B05 8↔6',
    match: (r) => r.field_id.startsWith('B05.S1.') && r.expected === '8' && r.clean === '6',
  },
  {
    id: 'A02-95-45',
    label: 'A02 95→45',
    match: (r) => r.field_id === 'A02.S1.load' && r.expected === '95' && r.clean === '45',
  },
  {
    id: 'C02-90-96',
    label: 'C02 90→96',
    match: (r) => r.field_id === 'C02.S2.load' && r.expected === '90' && r.clean === '96',
  },
  {
    id: 'C04-S5-UNKNOWN',
    label: 'C04 S-shaped 5→UNKNOWN',
    match: (r) => r.field_id === 'C04.S1.load' && r.clean === 'UNKNOWN',
  },
  {
    id: 'C07-40-410',
    label: 'C07 40→410',
    match: (r) => r.field_id === 'C07.S2.seconds' && r.expected === '40' && r.clean === '410',
  },
];

export function sha256Buffer(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function cachePath(artifactDir = POC8C_ARTIFACT_DIR) {
  return path.join(artifactDir, 'vlm-cache.json');
}

function loadCache(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return loadJson(filePath);
}

function saveCache(filePath, cache) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(cache, null, 2));
}

export function loadPoc8bRows() {
  const results = loadJson(POC8B_RESULTS);
  if (!Array.isArray(results.comparison_rows) || results.comparison_rows.length !== 519) {
    throw new Error(`POC #8B membership is ${results.comparison_rows?.length}, expected 519`);
  }
  return results.comparison_rows.map((row) => {
    const cropDir = path.dirname(row.crop);
    return {
      ...row,
      crop_clean: row.crop,
      crop_vlm: path.join(cropDir, 'vlm.png'),
    };
  });
}

export function loadPoc8bVlmCache() {
  return loadJson(POC8B_VLM_CACHE);
}

export function observationKey(sampleId, variant, run) {
  return `${sampleId}::${variant}::${run}`;
}

/**
 * Confidence gate. Ground truth is not an input.
 * Unanimous numeric agreement → AUTO_ACCEPT.
 * Any UNKNOWN or any disagreement → REVIEW_REQUIRED with value null.
 * Disagreements are not majority-voted into a corrected value.
 */
export function gateUnanimous(outputs) {
  const values = (outputs || []).map((raw) => parseNumericLiteral(raw).value);
  const unknownCount = values.filter((v) => v === 'UNKNOWN').length;
  const distinct = [...new Set(values)];
  const agreementCount = distinct.length
    ? Math.max(...distinct.map((d) => values.filter((v) => v === d).length))
    : 0;
  const analysis = {
    outputs: values,
    agreement_count: agreementCount,
    agreement: values.length ? agreementCount / values.length : 0,
    distinct_outputs: distinct,
    unknown_count: unknownCount,
  };
  if (!values.length) {
    return { state: 'REVIEW_REQUIRED', value: null, reason: 'empty', ...analysis };
  }
  if (unknownCount > 0) {
    return { state: 'REVIEW_REQUIRED', value: null, reason: 'unknown', ...analysis };
  }
  if (distinct.length !== 1) {
    return { state: 'REVIEW_REQUIRED', value: null, reason: 'disagreement', ...analysis };
  }
  return {
    state: 'AUTO_ACCEPT',
    value: values[0],
    reason: 'unanimous_numeric',
    ...analysis,
  };
}

/** Negative-control only. Never the primary policy. */
export function gateMajority(outputs) {
  const values = (outputs || []).map((raw) => parseNumericLiteral(raw).value);
  const unknownCount = values.filter((v) => v === 'UNKNOWN').length;
  const distinct = [...new Set(values)];
  const agreementCount = distinct.length
    ? Math.max(...distinct.map((d) => values.filter((v) => v === d).length))
    : 0;
  const analysis = {
    outputs: values,
    agreement_count: agreementCount,
    agreement: values.length ? agreementCount / values.length : 0,
    distinct_outputs: distinct,
    unknown_count: unknownCount,
  };
  if (unknownCount > 0) {
    return { state: 'REVIEW_REQUIRED', value: null, reason: 'unknown', ...analysis };
  }
  if (!values.length || agreementCount <= values.length / 2) {
    return { state: 'REVIEW_REQUIRED', value: null, reason: 'no_majority', ...analysis };
  }
  const winner = distinct.find((d) => values.filter((v) => v === d).length === agreementCount);
  return { state: 'AUTO_ACCEPT', value: winner, reason: 'majority', ...analysis };
}

export function proposeObservation({
  field_id,
  field_kind,
  original,
  gray,
  contrast,
  gate,
  method = POC8B_MODEL,
  crop_profile = CROP_PROFILE_CLEAN,
  confidence_policy = CONFIDENCE_POLICY,
}) {
  const numeric = gate.state === 'AUTO_ACCEPT' && gate.value != null && gate.value !== 'UNKNOWN';
  return {
    field_id,
    field_kind,
    state: gate.state,
    value: numeric ? Number(gate.value) : null,
    recognition: {
      method,
      crop_profile,
      confidence_policy,
      outputs: { original, gray, contrast },
      agreement: gate.agreement,
    },
  };
}

export function evaluatePolicy(rows, getOutputs, { name, method } = {}) {
  const total = rows.length;
  const auto = [];
  const review = [];
  for (const row of rows) {
    const gate = method === 'majority' ? gateMajority(getOutputs(row)) : gateUnanimous(getOutputs(row));
    const poc8bExact = row.clean === row.expected;
    const poc8bUnknown = row.clean === 'UNKNOWN';
    const poc8bWrong = !poc8bExact && !poc8bUnknown;
    const autoCorrect = gate.state === 'AUTO_ACCEPT' && String(gate.value) === String(row.expected);
    const autoWrong = gate.state === 'AUTO_ACCEPT' && String(gate.value) !== String(row.expected);
    const scored = {
      ...row,
      gate,
      poc8b_exact: poc8bExact,
      poc8b_unknown: poc8bUnknown,
      poc8b_wrong: poc8bWrong,
      auto_correct: autoCorrect,
      auto_wrong: autoWrong,
    };
    if (gate.state === 'AUTO_ACCEPT') auto.push(scored);
    else review.push(scored);
  }
  const autoCorrect = auto.filter((r) => r.auto_correct).length;
  const autoWrong = auto.filter((r) => r.auto_wrong).length;
  const reviewCorrect = review.filter((r) => r.poc8b_exact).length;
  const reviewWrong = review.filter((r) => r.poc8b_wrong).length;
  const reviewUnknown = review.filter((r) => r.poc8b_unknown).length;
  const misses = rows.filter((r) => r.clean !== r.expected);
  const missesCaught = misses.filter((r) => {
    const gate = method === 'majority' ? gateMajority(getOutputs(r)) : gateUnanimous(getOutputs(r));
    return gate.state === 'REVIEW_REQUIRED';
  }).length;
  const correct = rows.filter((r) => r.clean === r.expected);
  const falseReview = correct.filter((r) => {
    const gate = method === 'majority' ? gateMajority(getOutputs(r)) : gateUnanimous(getOutputs(r));
    return gate.state === 'REVIEW_REQUIRED';
  }).length;
  return {
    name,
    auto_accepted: {
      count: auto.length,
      total,
      pct: total ? auto.length / total : 0,
      correct: autoCorrect,
      wrong: autoWrong,
      precision: auto.length ? autoCorrect / auto.length : 0,
    },
    review_required: {
      count: review.length,
      total,
      pct: total ? review.length / total : 0,
      correct_sent_to_review: reviewCorrect,
      wrong_values_caught: reviewWrong,
      unknowns_caught: reviewUnknown,
    },
    error_capture: {
      poc8b_non_exact: misses.length,
      routed_to_review: missesCaught,
      missed: misses.length - missesCaught,
    },
    false_review: {
      poc8b_correct: correct.length,
      unnecessarily_reviewed: falseReview,
      rate: correct.length ? falseReview / correct.length : 0,
    },
    auto_rows: auto,
    review_rows: review,
  };
}

export function diagnosticPanel(rows) {
  const misses = rows.filter((r) => r.clean !== r.expected);
  const correct = rows.filter((r) => r.clean === r.expected);
  const picked = [];
  const seen = new Set();
  const take = (row) => {
    if (!row || seen.has(row.sample_id)) return;
    seen.add(row.sample_id);
    picked.push(row);
  };
  for (const miss of misses) take(miss);
  const counterparts = [
    'IMG_1323__A02.S1.load',
    'IMG_1322__A02.S1.load',
    'IMG_1317__C07.S2.seconds',
    'IMG_1315__C02.S2.load',
    'IMG_1317__C02.S2.load',
    'routine-B-v1.3.1__B05.S1.left',
    'IMG_1306__B05.S1.right',
    'IMG_1309__B05.S1.right',
    'IMG_1311__B05.S1.right',
  ];
  const byId = new Map(rows.map((r) => [r.sample_id, r]));
  for (const id of counterparts) {
    const row = byId.get(id);
    if (row && row.clean === row.expected) take(row);
  }
  const kindSeen = new Set();
  for (const row of correct) {
    const key = `${row.sheet_id}:${row.field_kind}`;
    if (kindSeen.has(key)) continue;
    kindSeen.add(key);
    take(row);
    if (picked.length >= misses.length + 20) break;
  }
  return {
    misses,
    samples: picked,
  };
}

export function experimentAUseful(aRows) {
  const disagree = aRows.filter((r) => r.distinct_outputs.length > 1).length;
  const unknownFlip = aRows.filter((r) => r.unknown_count > 0 && r.unknown_count < r.outputs.length).length;
  const vsSeed = aRows.filter((r) => r.outputs.some((v) => v !== r.outputs[0])).length;
  return {
    useful: disagree > 0 || unknownFlip > 0 || vsSeed > 0,
    disagreement_crops: disagree,
    mixed_unknown_crops: unknownFlip,
    any_run_differs: vsSeed,
    unanimous_crops: aRows.filter((r) => r.distinct_outputs.length === 1).length,
  };
}

export function variantDir(sample, artifactDir = POC8C_ARTIFACT_DIR) {
  return path.join(artifactDir, 'variants', sample.photo_id, sample.field_id);
}

export async function writeVariantCrops(sample, artifactDir = POC8C_ARTIFACT_DIR) {
  const dir = variantDir(sample, artifactDir);
  fs.mkdirSync(dir, { recursive: true });
  const meta = await sharp(sample.crop_clean).metadata();
  const width = meta.width * VLM_UPSCALE;
  const height = meta.height * VLM_UPSCALE;
  const grayPath = path.join(dir, 'gray.png');
  const contrastPath = path.join(dir, 'contrast.png');
  await sharp(sample.crop_clean)
    .grayscale()
    .resize({ width, height, kernel: 'lanczos3' })
    .png()
    .toFile(grayPath);
  await sharp(sample.crop_clean)
    .normalize()
    .resize({ width, height, kernel: 'lanczos3' })
    .png()
    .toFile(contrastPath);
  const vlmMeta = await sharp(sample.crop_vlm).metadata();
  return {
    original: sample.crop_vlm,
    gray: grayPath,
    contrast: contrastPath,
    width,
    height,
    vlm_width: vlmMeta.width,
    vlm_height: vlmMeta.height,
    geometry_match: vlmMeta.width === width && vlmMeta.height === height,
  };
}

async function recognizeOnce({
  cache,
  cacheFile,
  sample,
  variant,
  run,
  cropPath,
  env,
  onProgress,
}) {
  const key = observationKey(sample.sample_id, variant, run);
  if (cache[key] && cache[key].model === POC8B_MODEL && cache[key].recognized != null) {
    onProgress?.({
      recognizer: `vlm-${variant}`,
      index: 0,
      total: 1,
      cached: true,
      sample_id: sample.sample_id,
    });
    return cache[key];
  }
  const imageBuffer = fs.readFileSync(cropPath);
  const t0 = Date.now();
  let raw = '';
  let error = null;
  try {
    const ollama = await ollamaChatImage({
      imageBuffer,
      model: POC8B_MODEL,
      content: VLM_PROMPT,
      env,
    });
    raw = ollama.raw ?? '';
  } catch (err) {
    error = String(err?.message || err);
  }
  const parsed = parseNumericLiteral(raw);
  const row = {
    key,
    sample_id: sample.sample_id,
    photo_id: sample.photo_id,
    field_id: sample.field_id,
    variant,
    run,
    raw,
    recognized: parsed.value,
    parse_reason: parsed.reason,
    latency_ms: Date.now() - t0,
    error,
    model: POC8B_MODEL,
    crop: cropPath,
    image_sha256: sha256Buffer(imageBuffer),
    temperature: GENERATION_SETTINGS.temperature,
    stream: GENERATION_SETTINGS.stream,
    prompt: VLM_PROMPT,
  };
  cache[key] = row;
  saveCache(cacheFile, cache);
  onProgress?.({
    recognizer: `vlm-${variant}`,
    index: 0,
    total: 1,
    cached: false,
    sample_id: sample.sample_id,
    recognized: row.recognized,
  });
  return row;
}

function seedCleanFrom8b(cache, sample, eightB) {
  const key = observationKey(sample.sample_id, 'clean', 0);
  if (cache[key]) return cache[key];
  const image = fs.readFileSync(sample.crop_vlm);
  const row = {
    key,
    sample_id: sample.sample_id,
    photo_id: sample.photo_id,
    field_id: sample.field_id,
    variant: 'clean',
    run: 0,
    raw: eightB.raw,
    recognized: eightB.recognized,
    parse_reason: eightB.parse_reason,
    latency_ms: eightB.latency_ms,
    error: eightB.error || null,
    model: eightB.model || POC8B_MODEL,
    crop: sample.crop_vlm,
    image_sha256: sha256Buffer(image),
    temperature: GENERATION_SETTINGS.temperature,
    stream: GENERATION_SETTINGS.stream,
    prompt: VLM_PROMPT,
    seeded_from: 'poc8b',
  };
  cache[key] = row;
  return row;
}

function summarizeRuns(sample, observations) {
  const outputs = observations.map((o) => o.recognized);
  const gate = gateUnanimous(outputs);
  return {
    sample_id: sample.sample_id,
    photo_id: sample.photo_id,
    sheet_id: sample.sheet_id,
    field_id: sample.field_id,
    field_kind: sample.field_kind,
    expected: sample.expected,
    clean: sample.clean,
    run1: outputs[0],
    run2: outputs[1],
    run3: outputs[2],
    outputs,
    agreement_count: gate.agreement_count,
    distinct_outputs: gate.distinct_outputs,
    unknown_count: gate.unknown_count,
    image_sha256: observations[0]?.image_sha256 || null,
    same_bytes: observations.every((o) => o.image_sha256 === observations[0]?.image_sha256),
    latencies_ms: observations.map((o) => o.latency_ms),
    gate: {
      state: gate.state,
      value: gate.value,
      reason: gate.reason,
      agreement: gate.agreement,
    },
  };
}

export async function runExperimentA(samples, {
  artifactDir = POC8C_ARTIFACT_DIR,
  env = process.env,
  onProgress,
} = {}) {
  const cacheFile = cachePath(artifactDir);
  const cache = loadCache(cacheFile);
  const eightB = loadPoc8bVlmCache();
  const rows = [];
  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i];
    const seed = eightB[sample.sample_id];
    if (!seed) throw new Error(`POC #8B VLM cache missing ${sample.sample_id}`);
    seedCleanFrom8b(cache, sample, seed);
    saveCache(cacheFile, cache);
    const observations = [];
    for (let run = 0; run < EXPERIMENT_A_RUNS; run += 1) {
      const obs = await recognizeOnce({
        cache,
        cacheFile,
        sample,
        variant: 'clean',
        run,
        cropPath: sample.crop_vlm,
        env,
        onProgress: (info) => onProgress?.({
          ...info,
          recognizer: 'expA-clean',
          index: i,
          total: samples.length,
          run,
        }),
      });
      observations.push(obs);
    }
    rows.push(summarizeRuns(sample, observations));
  }
  return {
    experiment: 'A',
    generation: GENERATION_SETTINGS,
    crops: rows.length,
    rows,
    usefulness: experimentAUseful(rows),
  };
}

export async function runExperimentB(samples, {
  artifactDir = POC8C_ARTIFACT_DIR,
  env = process.env,
  onProgress,
} = {}) {
  const cacheFile = cachePath(artifactDir);
  const cache = loadCache(cacheFile);
  const eightB = loadPoc8bVlmCache();
  const rows = [];
  let geometryMismatches = 0;
  const started = Date.now();
  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i];
    const seed = eightB[sample.sample_id];
    if (!seed) throw new Error(`POC #8B VLM cache missing ${sample.sample_id}`);
    if (seed.recognized !== sample.clean) {
      throw new Error(`POC #8B cache/result mismatch ${sample.sample_id}: ${seed.recognized} vs ${sample.clean}`);
    }
    const variants = await writeVariantCrops(sample, artifactDir);
    if (!variants.geometry_match) geometryMismatches += 1;
    const original = sample.clean;
    const observations = [];
    for (const variant of EXPERIMENT_B_VARIANTS) {
      const obs = await recognizeOnce({
        cache,
        cacheFile,
        sample,
        variant,
        run: 0,
        cropPath: variants[variant],
        env,
        onProgress: (info) => onProgress?.({
          ...info,
          recognizer: `expB-${variant}`,
          index: i,
          total: samples.length,
        }),
      });
      observations.push(obs);
    }
    const gray = observations[0].recognized;
    const contrast = observations[1].recognized;
    const outputs = [original, gray, contrast];
    const gate = gateUnanimous(outputs);
    rows.push({
      sample_id: sample.sample_id,
      photo_id: sample.photo_id,
      sheet_id: sample.sheet_id,
      field_id: sample.field_id,
      field_kind: sample.field_kind,
      expected: sample.expected,
      original,
      gray,
      contrast,
      clean: original,
      outputs,
      agreement_count: gate.agreement_count,
      distinct_outputs: gate.distinct_outputs,
      unknown_count: gate.unknown_count,
      geometry_match: variants.geometry_match,
      crops: {
        original: variants.original,
        gray: variants.gray,
        contrast: variants.contrast,
      },
      gray_latency_ms: observations[0].latency_ms,
      contrast_latency_ms: observations[1].latency_ms,
      extra_latency_ms: (observations[0].latency_ms || 0) + (observations[1].latency_ms || 0),
      gray_raw: observations[0].raw,
      contrast_raw: observations[1].raw,
      gate: {
        state: gate.state,
        value: gate.value,
        reason: gate.reason,
        agreement: gate.agreement,
      },
    });
  }
  return {
    experiment: 'B',
    generation: {
      ...GENERATION_SETTINGS,
      confidence_policy: CONFIDENCE_POLICY,
      variant_ops: VARIANT_OPS,
    },
    crops: rows.length,
    geometry_mismatches: geometryMismatches,
    wall_ms: Date.now() - started,
    rows,
  };
}

export function scoreFamilies(rows, getOutputs, method) {
  return RESIDUAL_FAMILIES.map((family) => {
    const members = rows.filter((r) => family.match(r));
    const caught = members.filter((r) => {
      const gate = method === 'majority' ? gateMajority(getOutputs(r)) : gateUnanimous(getOutputs(r));
      return gate.state === 'REVIEW_REQUIRED';
    });
    const confidentWrong = members.filter((r) => {
      const gate = method === 'majority' ? gateMajority(getOutputs(r)) : gateUnanimous(getOutputs(r));
      return gate.state === 'AUTO_ACCEPT' && String(gate.value) !== String(r.expected);
    });
    return {
      id: family.id,
      label: family.label,
      members: members.length,
      caught: caught.length,
      confidently_wrong: confidentWrong.length,
      sample_ids: members.map((m) => m.sample_id),
      caught_ids: caught.map((m) => m.sample_id),
      confident_wrong_ids: confidentWrong.map((m) => m.sample_id),
    };
  });
}

export function originalColumn(row) {
  return row.original ?? row.clean;
}

export function policyOutputs(row, policyId) {
  const original = originalColumn(row);
  if (policyId === 'A') return [original];
  if (policyId === 'C') return [original, row.gray];
  if (policyId === 'D') return [original, row.contrast];
  return [original, row.gray, row.contrast];
}

export function variantPattern(row) {
  const original = originalColumn(row);
  const values = [original, row.gray, row.contrast];
  const distinct = new Set(values);
  const unknown = values.filter((v) => v === 'UNKNOWN').length;
  return {
    all_3_agree: distinct.size === 1,
    exactly_2_agree: distinct.size === 2,
    all_3_differ: distinct.size === 3,
    any_unknown: unknown > 0,
    unanimous_numeric: distinct.size === 1 && unknown === 0,
  };
}

export function originalCorrectness(row) {
  const original = originalColumn(row);
  if (original === row.expected) return 'correct';
  if (original === 'UNKNOWN') return 'unknown';
  return 'wrong';
}

export function disagreementCrosstab(rows) {
  const buckets = [
    'all_3_agree',
    'exactly_2_agree',
    'all_3_differ',
    'any_unknown',
    'unanimous_numeric',
  ];
  const cols = ['correct', 'wrong', 'unknown'];
  const table = {};
  for (const bucket of buckets) {
    table[bucket] = { correct: 0, wrong: 0, unknown: 0, total: 0 };
  }
  for (const row of rows) {
    const pattern = variantPattern(row);
    const col = originalCorrectness(row);
    for (const bucket of buckets) {
      if (pattern[bucket]) {
        table[bucket][col] += 1;
        table[bucket].total += 1;
      }
    }
  }
  return { buckets, cols, table };
}

export function scoreVariantAccuracy(rows) {
  const score = (key) => {
    const exact = rows.filter((r) => r[key] === r.expected).length;
    const unknown = rows.filter((r) => r[key] === 'UNKNOWN').length;
    const wrong = rows.length - exact - unknown;
    return { exact, unknown, wrong, accuracy: rows.length ? exact / rows.length : 0 };
  };
  return {
    original: score('original'),
    gray: score('gray'),
    contrast: score('contrast'),
  };
}

export function residualObservationDetail(rows, getOutputs = (r) => policyOutputs(r, 'B')) {
  return RESIDUAL_FAMILIES.map((family) => {
    const members = rows.filter((r) => family.match({ ...r, clean: originalColumn(r) }));
    return {
      id: family.id,
      label: family.label,
      observations: members.map((r) => {
        const gate = gateUnanimous(getOutputs(r));
        const original = originalColumn(r);
        let decision = gate.state;
        if (gate.state === 'AUTO_ACCEPT' && String(gate.value) !== String(r.expected)) {
          decision = 'AUTO_ACCEPT_WRONG';
        }
        return {
          photo_id: r.photo_id,
          field_id: r.field_id,
          expected: r.expected,
          original,
          gray: r.gray,
          contrast: r.contrast,
          decision,
        };
      }),
    };
  });
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function latencyStats(rows, eightBCache) {
  const gray = rows.map((r) => Number(r.gray_latency_ms) || 0).filter((n) => n > 0);
  const contrast = rows.map((r) => Number(r.contrast_latency_ms) || 0).filter((n) => n > 0);
  const original = Object.values(eightBCache || {}).map((r) => Number(r.latency_ms) || 0).filter((n) => n > 0);
  const extra = rows.map((r) => Number(r.extra_latency_ms) || 0);
  const originalMean = mean(original) || 8850;
  const sizes = [15, 20, 25, 30];
  return {
    original_mean_ms: originalMean,
    original_median_ms: median(original) || originalMean,
    gray_mean_ms: mean(gray),
    gray_median_ms: median(gray),
    contrast_mean_ms: mean(contrast),
    contrast_median_ms: median(contrast),
    extra_total_ms: extra.reduce((a, b) => a + b, 0),
    extra_mean_ms: mean(extra),
    vlm_calls_benchmark: rows.length * 2,
    vlm_calls_naive_production_per_field: 3,
    vlm_calls_original_only_per_field: 1,
    representative: sizes.map((n) => ({
      numeric_fields: n,
      original_only_sec: (n * originalMean) / 1000,
      three_view_sec: (n * 3 * originalMean) / 1000,
      extra_variant_sec: (n * 2 * originalMean) / 1000,
    })),
  };
}

export function loadExperimentA(artifactDir = POC8C_ARTIFACT_DIR) {
  const file = path.join(artifactDir, 'probe-a.json');
  if (!fs.existsSync(file)) {
    throw new Error('Experiment A is required as probe-a.json; do not rerun identical-crop inference');
  }
  const payload = loadJson(file);
  return payload.experimentA;
}

export function multiPhotoOracle(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.sheet_id}::${row.field_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const fields = [...groups.entries()].map(([key, members]) => {
    const originals = members.map((m) => originalColumn(m));
    const values = [...new Set(originals)];
    const anyMiss = members.some((m) => originalColumn(m) !== m.expected);
    const allExact = members.every((m) => originalColumn(m) === m.expected);
    const variantDisagree = members.filter((m) => m.gray != null && !variantPattern(m).all_3_agree).length;
    return {
      key,
      sheet_id: members[0].sheet_id,
      field_id: members[0].field_id,
      photos: members.length,
      distinct_original: values,
      disagree: values.length > 1,
      any_miss: anyMiss,
      all_exact: allExact,
      variant_disagree_photos: variantDisagree,
    };
  });
  const repeated = fields.filter((f) => f.photos > 1);
  const disagree = repeated.filter((f) => f.disagree);
  const missFields = repeated.filter((f) => f.any_miss);
  const unstableKeys = new Set(disagree.map((f) => f.key));
  let unstableObs = 0;
  let unstableVariantDisagree = 0;
  let unstableWrong = 0;
  let stableObs = 0;
  let stableVariantDisagree = 0;
  let stableWrong = 0;
  for (const row of rows) {
    const key = `${row.sheet_id}::${row.field_id}`;
    const group = groups.get(key);
    if (!group || group.length < 1) continue;
    const isRepeated = group.length > 1;
    if (!isRepeated) continue;
    const vDisagree = row.gray != null && !variantPattern(row).all_3_agree;
    const wrong = originalColumn(row) !== row.expected;
    if (unstableKeys.has(key)) {
      unstableObs += 1;
      if (vDisagree) unstableVariantDisagree += 1;
      if (wrong) unstableWrong += 1;
    } else {
      stableObs += 1;
      if (vDisagree) stableVariantDisagree += 1;
      if (wrong) stableWrong += 1;
    }
  }
  return {
    unique_repeated_fields: repeated.length,
    capture_disagreement_fields: disagree.length,
    fields_with_any_8b_miss: missFields.length,
    disagreement_and_any_miss: disagree.filter((f) => f.any_miss).length,
    disagreement_but_all_correct: disagree.filter((f) => f.all_exact).length,
    consistent_wrong_or_unknown: missFields.filter((f) => !f.disagree).length,
    disagree_fields: disagree,
    consistent_miss_fields: missFields.filter((f) => !f.disagree),
    observations_on_photo_unstable_fields: unstableObs,
    variant_disagree_on_photo_unstable: unstableVariantDisagree,
    original_miss_on_photo_unstable: unstableWrong,
    observations_on_photo_stable_repeated_fields: stableObs,
    variant_disagree_on_photo_stable: stableVariantDisagree,
    original_miss_on_photo_stable: stableWrong,
  };
}

function fmtPct(n) {
  return `${(n * 100).toFixed(1)}%`;
}

function fmtPrec(n) {
  return `${(n * 100).toFixed(2)}%`;
}

function policyMarkdown(policy) {
  const a = policy.auto_accepted;
  const r = policy.review_required;
  const total = a.total || (a.count + r.count);
  const misses = policy.error_capture.poc8b_non_exact;
  const correctN = policy.false_review.poc8b_correct;
  return [
    `### ${policy.name}`,
    '',
    `TOTAL: **${total}**`,
    '',
    'AUTO_ACCEPT',
    '',
    `- count: **${a.count}** (${fmtPct(a.pct)})`,
    `- correct: **${a.correct}**`,
    `- wrong: **${a.wrong}**`,
    `- precision: **${fmtPrec(a.precision)}**`,
    '',
    'REVIEW_REQUIRED',
    '',
    `- count: **${r.count}** (${fmtPct(r.pct)})`,
    `- correct recognitions unnecessarily reviewed: **${r.correct_sent_to_review}**`,
    `- wrong recognitions caught: **${r.wrong_values_caught}**`,
    `- UNKNOWNs caught: **${r.unknowns_caught}**`,
    '',
    `- error capture of ${misses} #8B non-exact: **${policy.error_capture.routed_to_review}/${misses}** remain AUTO_ACCEPT: **${policy.error_capture.missed}**`,
    `- false-review of ${correctN} currently-correct: **${policy.false_review.unnecessarily_reviewed}/${correctN}** (${fmtPct(policy.false_review.rate)})`,
  ].join('\n');
}

function residualMarkdown(details) {
  return details.map((family) => [
    `### ${family.label}`,
    '',
    ...family.observations.map((o) => [
      `${o.photo_id}`,
      `${o.field_id}`,
      `expected: ${o.expected}`,
      `original: ${o.original}`,
      `gray: ${o.gray}`,
      `contrast: ${o.contrast}`,
      `decision: ${o.decision}`,
    ].join('\n')),
  ].join('\n\n')).join('\n\n');
}

function crosstabMarkdown(tab) {
  const header = '| pattern | original correct | original wrong | original UNKNOWN | total |';
  const sep = '|---|---:|---:|---:|---:|';
  const labels = {
    all_3_agree: '3/3 agree',
    exactly_2_agree: 'exactly 2 agree',
    all_3_differ: 'all 3 differ',
    any_unknown: 'UNKNOWN present',
    unanimous_numeric: 'unanimous numeric',
  };
  const rows = tab.buckets.map((b) => {
    const c = tab.table[b];
    return `| ${labels[b] || b} | ${c.correct} | ${c.wrong} | ${c.unknown} | ${c.total} |`;
  });
  return [header, sep, ...rows].join('\n');
}

function exampleObservations(rows, policy) {
  const auto = policy.auto_rows[0];
  const review = policy.review_rows.find((r) => r.gate.reason === 'disagreement') || policy.review_rows[0];
  const examples = [];
  if (auto) {
    examples.push(proposeObservation({
      field_id: auto.field_id,
      field_kind: auto.field_kind,
      original: originalColumn(auto),
      gray: auto.gray,
      contrast: auto.contrast,
      gate: auto.gate,
    }));
  }
  if (review) {
    examples.push(proposeObservation({
      field_id: review.field_id,
      field_kind: review.field_kind,
      original: originalColumn(review),
      gray: review.gray,
      contrast: review.contrast,
      gate: review.gate,
    }));
  }
  return examples;
}

function stripPolicy(policy) {
  if (!policy) return null;
  const { auto_rows, review_rows, ...rest } = policy;
  return {
    ...rest,
    auto_wrong_ids: auto_rows.filter((r) => r.auto_wrong).map((r) => r.sample_id),
    review_miss_ids: review_rows.filter((r) => !r.poc8b_exact).map((r) => r.sample_id),
  };
}

export function buildReport({
  frozen,
  experimentA,
  experimentB,
  policies,
  variantAccuracy,
  crosstab,
  residualDetail,
  multiPhoto,
  latency,
  contactSheets,
}) {
  const aUse = experimentA.usefulness;
  const strict = policies.B;
  const grayAlone = variantAccuracy.gray;
  const contrastAlone = variantAccuracy.contrast;
  const unanimous = crosstab.table.unanimous_numeric;
  const unanimousCorrectRate = unanimous.total ? unanimous.correct / unanimous.total : 0;
  const remainingWrong = residualDetail.flatMap((f) => f.observations.filter((o) => o.decision === 'AUTO_ACCEPT_WRONG'));
  const cVsB = policies.C && strict
    ? `Original+gray precision ${fmtPrec(policies.C.auto_accepted.precision)} / coverage ${fmtPct(policies.C.auto_accepted.pct)} vs strict 3/3 ${fmtPrec(strict.auto_accepted.precision)} / ${fmtPct(strict.auto_accepted.pct)}.`
    : '';
  const dVsB = policies.D && strict
    ? `Original+contrast precision ${fmtPrec(policies.D.auto_accepted.precision)} / coverage ${fmtPct(policies.D.auto_accepted.pct)} vs strict 3/3 ${fmtPrec(strict.auto_accepted.precision)} / ${fmtPct(strict.auto_accepted.pct)}.`
    : '';
  const freeze = strict
    && strict.auto_accepted.precision >= 0.99
    && strict.auto_accepted.wrong === 0
    && strict.auto_accepted.pct >= 0.7;
  const unresolved = [];
  if (strict?.auto_accepted.wrong) unresolved.push(`${strict.auto_accepted.wrong} STRICT 3/3 auto-accepted values are still wrong (Granite is stable and incorrect on those crops).`);
  if (strict && strict.auto_accepted.precision < 0.99) unresolved.push('STRICT 3/3 auto-accept precision is below 99%.');
  if (strict && strict.false_review.unnecessarily_reviewed > 0.25 * 502) unresolved.push('False-review volume is large relative to a normal workout.');
  if (!remainingWrong.length && strict?.error_capture.missed === 0 && strict?.auto_accepted.wrong === 0) {
    /* residual misses all reviewed */
  } else if (remainingWrong.length) {
    unresolved.push(`Unanimously wrong residual families: ${[...new Set(remainingWrong.map((o) => `${o.field_id}`))].join(', ')}.`);
  }

  const answers = [
    `No. Experiment A: ${aUse.unanimous_crops}/${experimentA.crops} diagnostic crops were unanimous across three temperature-0 calls on identical \`vlm.png\` bytes, including every tested residual error. Identical-crop repetition is not a useful confidence signal and was not expanded.`,
    `Gray exact ${grayAlone.exact}/519 (${fmtPct(grayAlone.accuracy)}), ${grayAlone.unknown} UNKNOWN, ${grayAlone.wrong} wrong. Contrast exact ${contrastAlone.exact}/519 (${fmtPct(contrastAlone.accuracy)}), ${contrastAlone.unknown} UNKNOWN, ${contrastAlone.wrong} wrong. Original (frozen #8B) remains 502/519 (96.7%).`,
    `${crosstab.table.all_3_agree.total}/519 all three strings agree; ${crosstab.table.unanimous_numeric.total}/519 unanimous numeric.`,
    unanimous.total
      ? `${unanimous.correct}/${unanimous.total} (${fmtPct(unanimousCorrectRate)}) of unanimous-numeric triples match ground truth. ${unanimous.wrong} are unanimously wrong.`
      : 'n/a',
    strict ? fmtPrec(strict.auto_accepted.precision) : 'n/a',
    strict ? `${fmtPct(strict.auto_accepted.pct)} (${strict.auto_accepted.count}/519)` : 'n/a',
    strict ? `${strict.error_capture.routed_to_review}/17 caught; ${strict.error_capture.missed} remain AUTO_ACCEPT` : 'n/a',
    strict ? `${strict.false_review.unnecessarily_reviewed}/502` : 'n/a',
    remainingWrong.length
      ? remainingWrong.map((o) => `${o.photo_id} ${o.field_id} ${o.expected}→${o.original}`).join('; ')
      : 'none — every known residual family is REVIEW_REQUIRED under STRICT 3/3',
    (() => {
      const agreeWrong = crosstab.table.unanimous_numeric.wrong;
      const disagreeWrong = crosstab.table.exactly_2_agree.wrong + crosstab.table.all_3_differ.wrong;
      const disagreeCorrect = crosstab.table.exactly_2_agree.correct + crosstab.table.all_3_differ.correct;
      return `Unanimous-numeric still includes ${agreeWrong} original-wrong observations. Variant disagreement (2/3 or 3/3 differ) covers ${disagreeWrong} original-wrong and ${disagreeCorrect} original-correct. Disagreement is correlated with error but does not catch stable wrongs.`;
    })(),
    `${cVsB} ${dVsB} Neither pairwise rule is adopted as the production proposal if it silently auto-accepts more residual errors; STRICT 3/3 remains the primary gate. These pairwise rules were predefined, not tuned on failures.`,
    `Benchmark extra cost: ${latency.vlm_calls_benchmark} VLM calls (gray+contrast only). Gray mean ${ (latency.gray_mean_ms/1000).toFixed(2)}s (median ${(latency.gray_median_ms/1000).toFixed(2)}s); contrast mean ${(latency.contrast_mean_ms/1000).toFixed(2)}s (median ${(latency.contrast_median_ms/1000).toFixed(2)}s). Naive production 3 views × ~${(latency.original_mean_ms/1000).toFixed(2)}s/crop. 25-field workout: original-only ~${latency.representative.find((r) => r.numeric_fields === 25).original_only_sec.toFixed(0)}s vs three-view ~${latency.representative.find((r) => r.numeric_fields === 25).three_view_sec.toFixed(0)}s.`,
    freeze
      ? 'Yes — freeze STRICT 3/3 variant-unanimity as the numeric recognition *gate* on top of frozen #8B. Not a corrector, not canonical JSON, not a review UI.'
      : 'No. Do not freeze. Visual variant agreement is not a sufficient confidence signal by itself, or the precision/coverage tradeoff is not yet practical.',
    unresolved.length ? unresolved.join(' ') : 'If frozen: remaining work is review UX and later optional staged-gate cost reduction — not more visual probes in this POC.',
  ];

  const examples = experimentB && strict ? exampleObservations(experimentB.rows, strict) : [];
  const r25 = latency.representative.find((r) => r.numeric_fields === 25);

  return [
    '# POC #8C — Numeric Recognition Confidence & Review Gating',
    '',
    'Production-candidate path remains: registered page → frozen poc7-a1c nonblank numeric field → POC #8B geometry-clean crop → `granite3.2-vision:2b` → literal numeric result.',
    '',
    'This POC does **not** correct recognized numbers. It only decides `AUTO_ACCEPT` vs `REVIEW_REQUIRED`. Ground truth scores policies and is never a policy input. No workout-semantic special cases.',
    '',
    '## Freeze',
    '',
    `- Detector: **${DETECTOR_VERSION}** SHA256 \`${frozen.detector_sha256}\``,
    `- detect.py SHA256 \`${sha256File(DETECT_PY)}\``,
    `- Membership: **519** (POC #8 / #8B)`,
    `- POC #8B original exact: **502/519**`,
    `- Model: \`${POC8B_MODEL}\``,
    `- Prompt: ${VLM_PROMPT}`,
    `- Clean-crop geometry: unchanged POC #8B`,
    `- Ground truth: unchanged \`fixtures/poc8/numeric-ground-truth.json\``,
    '',
    'POC #8 and #8B artifacts are preserved. Original #8B values are reused, not recomputed.',
    '',
    '## Experiment A — completed (not rerun)',
    '',
    'Repeated temperature-0 inference on identical frozen `vlm.png` bytes.',
    '',
    `- Diagnostic crops: **${experimentA.crops}** (all 17 #8B non-exact + correct counterparts)`,
    `- Unanimous: **${aUse.unanimous_crops}/${experimentA.crops}**`,
    `- Disagreement: **${aUse.disagreement_crops}**`,
    `- Useful as a confidence signal: **no**`,
    '',
    'Granite is effectively deterministic here. Identical-crop repetition was not expanded to the remaining 482 crops and is not majority-voted.',
    '',
    '## Experiment B — fixed image-variant agreement',
    '',
    'Same crop bounds and same handwriting. No geometry change. No preprocess sweep. No ground-truth-driven transform edits.',
    '',
    '```',
    JSON.stringify({ generation: GENERATION_SETTINGS, variant_ops: VARIANT_OPS }, null, 2),
    '```',
    '',
    `- Crops: **${experimentB.crops}**`,
    `- Geometry mismatches vs frozen VLM presentation size: **${experimentB.geometry_mismatches}**`,
    '',
    '### Individual variant accuracy vs ground truth',
    '',
    `- original (frozen #8B): **${variantAccuracy.original.exact}/519** (${fmtPct(variantAccuracy.original.accuracy)})`,
    `- gray: **${variantAccuracy.gray.exact}/519** (${fmtPct(variantAccuracy.gray.accuracy)}); UNKNOWN ${variantAccuracy.gray.unknown}; wrong ${variantAccuracy.gray.wrong}`,
    `- contrast: **${variantAccuracy.contrast.exact}/519** (${fmtPct(variantAccuracy.contrast.accuracy)}); UNKNOWN ${variantAccuracy.contrast.unknown}; wrong ${variantAccuracy.contrast.wrong}`,
    '',
    'Gray and contrast are probes, not alternate recognizers to substitute.',
    '',
    '### Variant disagreement vs original correctness',
    '',
    'Rows are overlapping where noted (`UNKNOWN present` and `unanimous numeric` vs `3/3 agree`).',
    '',
    crosstabMarkdown(crosstab),
    '',
    '## Candidate policies',
    '',
    'Predefined only. Ground truth is not a policy input. Disagreements are not majority-voted into a saved value.',
    '',
    policyMarkdown(policies.A),
    '',
    policyMarkdown(policies.B),
    '',
    policyMarkdown(policies.C),
    '',
    policyMarkdown(policies.D),
    '',
    'Primary proposal under evaluation: **B. STRICT 3/3**. Pairwise A/C/D are comparisons. 2-of-3 majority vote would be ensemble *correction* and is not the production proposal.',
    '',
    '## Residual-error families (STRICT 3/3)',
    '',
    residualMarkdown(residualDetail),
    '',
    '## Repeated physical photographs (secondary oracle)',
    '',
    'Production still receives one photograph.',
    '',
    `- Unique physical fields with >1 photo: **${multiPhoto.unique_repeated_fields}**`,
    `- Capture disagreement (distinct original values across photos): **${multiPhoto.capture_disagreement_fields}**`,
    `- Fields with any #8B miss: **${multiPhoto.fields_with_any_8b_miss}**`,
    `- Disagreement ∩ any miss: **${multiPhoto.disagreement_and_any_miss}**`,
    `- Disagreement but every photo correct: **${multiPhoto.disagreement_but_all_correct}**`,
    `- Consistent wrong/UNKNOWN across photos: **${multiPhoto.consistent_wrong_or_unknown}**`,
    `- Observations on photo-unstable fields: ${multiPhoto.observations_on_photo_unstable_fields} (variant-disagree ${multiPhoto.variant_disagree_on_photo_unstable}, original miss ${multiPhoto.original_miss_on_photo_unstable})`,
    `- Observations on photo-stable repeated fields: ${multiPhoto.observations_on_photo_stable_repeated_fields} (variant-disagree ${multiPhoto.variant_disagree_on_photo_stable}, original miss ${multiPhoto.original_miss_on_photo_stable})`,
    '',
    multiPhoto.disagree_fields.length
      ? `Photo-disagreement fields: ${multiPhoto.disagree_fields.map((f) => `${f.field_id} [${f.distinct_original.join('/')}]`).join('; ')}.`
      : 'No cross-photo disagreement.',
    '',
    'Multi-photo capture is **not** a production requirement.',
    '',
    '## Latency',
    '',
    `- Original #8B Granite mean: **${(latency.original_mean_ms / 1000).toFixed(2)} sec/crop** (median ${(latency.original_median_ms / 1000).toFixed(2)}s)`,
    `- Gray mean: **${(latency.gray_mean_ms / 1000).toFixed(2)}s** (median ${(latency.gray_median_ms / 1000).toFixed(2)}s)`,
    `- Contrast mean: **${(latency.contrast_mean_ms / 1000).toFixed(2)}s** (median ${(latency.contrast_median_ms / 1000).toFixed(2)}s)`,
    `- Benchmark VLM calls (this POC): **${latency.vlm_calls_benchmark}** gray+contrast; originals reused`,
    `- Measured extra inference: **${(latency.extra_total_ms / 1000).toFixed(0)}s**`,
    '',
    'Naive production cost if all three views run for every numeric field:',
    '',
    ...latency.representative.map((w) => `- ${w.numeric_fields} fields: original-only ~${w.original_only_sec.toFixed(0)}s; three-view ~${w.three_view_sec.toFixed(0)}s (extra ~${w.extra_variant_sec.toFixed(0)}s).`),
    '',
    `Headline 25-cell sheet: original-only ~${r25.original_only_sec.toFixed(0)}s vs three-view ~${r25.three_view_sec.toFixed(0)}s.`,
    '',
    '### Optional staged-gate (not implemented)',
    '',
    'Tripling Granite (~8.85s/crop) is large enough that a later staged strategy is worth investigating: run original first, then gray/contrast only if a cheap non-semantic deterministic prefilter fires. No such prefilter is invented here (no ranges, previous sets, inheritance, or plate increments). Do not implement that optimization in this POC.',
    '',
    '## Output contract proposal (not integrated)',
    '',
    'Recognizer observation metadata stays in the transcription/review layer, not canonical workout JSON.',
    '',
    '```json',
    JSON.stringify(examples[0] || {
      field_id: 'A02.S1.load',
      field_kind: 'load',
      state: 'AUTO_ACCEPT',
      value: 95,
      recognition: {
        method: POC8B_MODEL,
        crop_profile: CROP_PROFILE_CLEAN,
        confidence_policy: CONFIDENCE_POLICY,
        outputs: { original: '95', gray: '95', contrast: '95' },
        agreement: 1.0,
      },
    }, null, 2),
    '```',
    '',
    examples[1] ? ['```json', JSON.stringify(examples[1], null, 2), '```'].join('\n') : '',
    '',
    '## Contact sheets',
    '',
    contactSheets.notes.join('\n'),
    '',
    '## Required questions',
    '',
    ...answers.map((line, i) => `${i + 1}. ${line}`),
    '',
    '## Decision',
    '',
    freeze
      ? `FREEZE STRICT 3/3 (\`${CONFIDENCE_POLICY}\`) as the numeric recognition gate. Auto-accept ${strict.auto_accepted.count}/519 at precision ${fmtPrec(strict.auto_accepted.precision)} with ${strict.auto_accepted.wrong} auto-accepted errors. Review ${strict.review_required.count}/519.`
      : `Do **not** freeze. STRICT 3/3 auto-accepts ${strict.auto_accepted.count}/519 at precision ${fmtPrec(strict.auto_accepted.precision)} with **${strict.auto_accepted.wrong}** confidently wrong values. ${remainingWrong.length ? 'Granite can be visually stable and still wrong.' : ''} That is the finding; it is not solved inside this POC.`,
    '',
    '## STOP',
    '',
    'No detector, mapping, crop-geometry, prompt, model, semantic/range correction, inheritance, canonical JSON, date/note recognition, review UI, or POC #9 work. Failures are preserved.',
    '',
    '## Artifacts',
    '',
    '- `poc8c/REPORT.md`',
    '- `poc8c/results.json`',
    '- `poc8c/variant-results.json`',
    '- `poc8c/probe-a.json`',
    '- `poc8c/variants/<photo>/<field>/{gray,contrast}.png`',
    '- contact sheets listed above',
  ].filter((line) => line !== undefined).join('\n');
}

async function maybeContactSheet(rows, outPath, title) {
  if (!rows.length) {
    return { path: null, count: 0, skipped: true };
  }
  await writeContactSheet(rows, outPath, { title });
  return { path: outPath, count: rows.length, skipped: false };
}

export async function runPoc8c({
  phase = 'B',
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
  if (sha256File(DETECTOR_CONFIG_PATH) !== FROZEN_DETECTOR_SHA256) {
    throw new Error('detector config SHA mismatch');
  }
  const membership = loadPoc8Membership();
  if (membership.samples.length !== 519) {
    throw new Error(`membership ${membership.samples.length}, expected 519`);
  }

  fs.mkdirSync(POC8C_ARTIFACT_DIR, { recursive: true });
  const rows8b = loadPoc8bRows();
  const exact8b = rows8b.filter((r) => r.clean === r.expected).length;
  if (rows8b.length !== 519 || exact8b !== 502) {
    throw new Error(`POC #8B artifact drifted: ${exact8b}/${rows8b.length}, expected 502/519`);
  }

  const experimentA = loadExperimentA();
  if (experimentA.usefulness.useful) {
    throw new Error('Experiment A was useful; this continuation assumes it is not');
  }

  if (phase === 'probe-a') {
    return { phase: 'probe-a', experimentA, frozen };
  }

  const experimentB = await runExperimentB(rows8b, { env, onProgress });
  const bRows = experimentB.rows.map((r) => ({ ...r, original: r.original, clean: r.original }));

  const policies = {
    A: evaluatePolicy(bRows, (r) => policyOutputs(r, 'A'), { name: 'A — ORIGINAL ONLY (UNKNOWN→review)' }),
    B: evaluatePolicy(bRows, (r) => policyOutputs(r, 'B'), { name: 'B — STRICT 3/3 (primary)' }),
    C: evaluatePolicy(bRows, (r) => policyOutputs(r, 'C'), { name: 'C — ORIGINAL + GRAY AGREEMENT' }),
    D: evaluatePolicy(bRows, (r) => policyOutputs(r, 'D'), { name: 'D — ORIGINAL + CONTRAST AGREEMENT' }),
  };

  const variantAccuracy = scoreVariantAccuracy(bRows);
  const crosstab = disagreementCrosstab(bRows);
  const residualDetail = residualObservationDetail(bRows);
  const multiPhoto = multiPhotoOracle(bRows);
  const latency = latencyStats(bRows, loadPoc8bVlmCache());

  const disagreeTiles = bRows.filter((r) => !variantPattern(r).all_3_agree).map((r) => ({
    field_id: r.field_id,
    expected: r.expected,
    recognized: `${r.original}|${r.gray}|${r.contrast}`,
    photo_id: r.photo_id,
    crop_original: r.crops.original,
    exact: false,
    unknown: r.unknown_count > 0,
  }));
  const autoWrongTiles = policies.B.auto_rows.filter((r) => r.auto_wrong).map((r) => ({
    field_id: r.field_id,
    expected: r.expected,
    recognized: r.gate.value,
    photo_id: r.photo_id,
    crop_original: r.crops.original,
    exact: false,
    unknown: false,
  }));
  const reviewCorrectTiles = policies.B.review_rows.filter((r) => r.poc8b_exact).map((r) => ({
    field_id: r.field_id,
    expected: r.expected,
    recognized: `${r.original}|${r.gray}|${r.contrast}`,
    photo_id: r.photo_id,
    crop_original: r.crops.original,
    exact: true,
    unknown: r.unknown_count > 0,
  }));

  const sheets = {
    disagreements: await maybeContactSheet(
      disagreeTiles,
      path.join(POC8C_ARTIFACT_DIR, 'variant-disagreements.png'),
      'POC #8C variant disagreements',
    ),
    autoWrong: await maybeContactSheet(
      autoWrongTiles,
      path.join(POC8C_ARTIFACT_DIR, 'auto-accepted-wrong.png'),
      'POC #8C STRICT 3/3 AUTO_ACCEPT wrong',
    ),
    reviewCorrect: await maybeContactSheet(
      reviewCorrectTiles,
      path.join(POC8C_ARTIFACT_DIR, 'review-required-correct.png'),
      'POC #8C STRICT 3/3 false review (original correct)',
    ),
  };
  const contactSheets = {
    sheets,
    notes: [
      sheets.disagreements.skipped
        ? '- `variant-disagreements.png`: not written (zero disagreements).'
        : `- \`variant-disagreements.png\`: ${sheets.disagreements.count} tiles.`,
      sheets.autoWrong.skipped
        ? '- `auto-accepted-wrong.png`: not written (zero STRICT 3/3 auto-accepted wrongs).'
        : `- \`auto-accepted-wrong.png\`: ${sheets.autoWrong.count} tiles.`,
      sheets.reviewCorrect.skipped
        ? '- `review-required-correct.png`: not written (zero original-correct reviews).'
        : `- \`review-required-correct.png\`: ${sheets.reviewCorrect.count} tiles.`,
    ],
  };

  const report = buildReport({
    frozen,
    experimentA,
    experimentB,
    policies,
    variantAccuracy,
    crosstab,
    residualDetail,
    multiPhoto,
    latency,
    contactSheets,
  });

  const variantResults = {
    detector_sha256: frozen.detector_sha256,
    membership: 519,
    poc8b_exact: 502,
    model: POC8B_MODEL,
    prompt: VLM_PROMPT,
    variant_ops: VARIANT_OPS,
    rows: bRows.map((r) => ({
      sample_id: r.sample_id,
      photo_id: r.photo_id,
      sheet_id: r.sheet_id,
      field_id: r.field_id,
      field_kind: r.field_kind,
      expected: r.expected,
      original: r.original,
      gray: r.gray,
      contrast: r.contrast,
      crops: r.crops,
      gray_latency_ms: r.gray_latency_ms,
      contrast_latency_ms: r.contrast_latency_ms,
    })),
  };

  const results = {
    detector_version: DETECTOR_VERSION,
    detector_sha256: frozen.detector_sha256,
    detect_py_sha256: sha256File(DETECT_PY),
    membership: 519,
    poc8b_exact: 502,
    model: POC8B_MODEL,
    prompt: VLM_PROMPT,
    generation: GENERATION_SETTINGS,
    variant_ops: VARIANT_OPS,
    experiment_a: {
      scope: 'diagnostic',
      ...experimentA.usefulness,
      crops: experimentA.crops,
    },
    policies: {
      A: stripPolicy(policies.A),
      B: stripPolicy(policies.B),
      C: stripPolicy(policies.C),
      D: stripPolicy(policies.D),
    },
    variant_accuracy: variantAccuracy,
    disagreement_crosstab: crosstab,
    residual_families: residualDetail,
    multi_photo: multiPhoto,
    latency,
    observation_examples: exampleObservations(bRows, policies.B),
    contact_sheets: contactSheets.notes,
  };

  fs.writeFileSync(path.join(POC8C_ARTIFACT_DIR, 'REPORT.md'), report);
  fs.writeFileSync(path.join(POC8C_ARTIFACT_DIR, 'results.json'), JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(POC8C_ARTIFACT_DIR, 'variant-results.json'), JSON.stringify(variantResults, null, 2));

  return {
    detector_sha256: frozen.detector_sha256,
    eligible_crops: 519,
    poc8b_exact: 502,
    experiment_a_useful: false,
    chosen_policy: 'B — STRICT 3/3 (primary)',
    policies: results.policies,
    report: path.join(POC8C_ARTIFACT_DIR, 'REPORT.md'),
    artifacts: {
      report: path.join(POC8C_ARTIFACT_DIR, 'REPORT.md'),
      results: path.join(POC8C_ARTIFACT_DIR, 'results.json'),
      variant_results: path.join(POC8C_ARTIFACT_DIR, 'variant-results.json'),
      variants: path.join(POC8C_ARTIFACT_DIR, 'variants'),
    },
  };
}

