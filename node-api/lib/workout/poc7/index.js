import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  ARTIFACT_DIR,
  CANONICAL_DPI,
  CANONICAL_PAGE_HEIGHT,
  CANONICAL_PAGE_WIDTH,
  FIXTURE_PDF,
  TEMPLATE_PATH,
  V131_CONFIG_DIR,
  loadB131Template,
} from '../poc6/index.js';

export {
  ARTIFACT_DIR,
  CANONICAL_DPI,
  CANONICAL_PAGE_HEIGHT,
  CANONICAL_PAGE_WIDTH,
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DETECT_PY = path.join(HERE, 'detect.py');
export const DETECTOR_CONFIG_PATH = path.join(V131_CONFIG_DIR, 'poc7-detector.json');
export const BENCHMARK_TRUTH_PATH = path.join(V131_CONFIG_DIR, 'fixtures', 'poc7-benchmark-truth.json');
export const BLANK_TEMPLATE_PATH = path.join(ARTIFACT_DIR, 'poc7-blank-template.png');
export const RECTIFIED_PATH = path.join(ARTIFACT_DIR, 'poc6-rectified.png');
export const OBSERVATIONS_PATH = path.join(ARTIFACT_DIR, 'poc7-observations.json');

export const CHECKBOX_STATES = new Set(['checked', 'unchecked', 'uncertain']);
export const FIELD_STATES = new Set(['blank', 'nonblank', 'uncertain']);

export function loadDetectorConfig(configPath = DETECTOR_CONFIG_PATH) {
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

export function loadBenchmarkTruth(truthPath = BENCHMARK_TRUTH_PATH) {
  return JSON.parse(fs.readFileSync(truthPath, 'utf8'));
}

export function fieldsByKind(template = loadB131Template()) {
  const checkboxes = [];
  const fields = [];
  for (const item of template.fields || []) {
    if (item.kind === 'checkbox') checkboxes.push(item.id);
    else fields.push(item.id);
  }
  return { checkboxes, fields };
}

export function validateBenchmarkTruth(truth = loadBenchmarkTruth(), template = loadB131Template()) {
  const { checkboxes, fields } = fieldsByKind(template);
  const checkboxSet = new Set(checkboxes);
  const fieldSet = new Set(fields);
  const errors = [];
  for (const id of Object.keys(truth.checkboxes || {})) {
    if (!checkboxSet.has(id)) errors.push(`truth checkbox unknown: ${id}`);
  }
  for (const id of Object.keys(truth.fields || {})) {
    if (!fieldSet.has(id)) errors.push(`truth field unknown: ${id}`);
  }
  for (const id of checkboxes) {
    if (!Object.prototype.hasOwnProperty.call(truth.checkboxes || {}, id)) {
      errors.push(`truth missing checkbox: ${id}`);
    }
  }
  for (const id of fields) {
    if (!Object.prototype.hasOwnProperty.call(truth.fields || {}, id)) {
      errors.push(`truth missing field: ${id}`);
    }
  }
  return { ok: errors.length === 0, errors, checkboxCount: checkboxes.length, fieldCount: fields.length };
}

export async function renderBlankTemplate({
  pdfPath = FIXTURE_PDF,
  outPath = BLANK_TEMPLATE_PATH,
} = {}) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const prefix = path.join(path.dirname(outPath), '.poc7-pdftoppm');
  const proc = spawnSync('pdftoppm', ['-r', String(CANONICAL_DPI), '-png', pdfPath, prefix], {
    encoding: 'utf8',
  });
  if (proc.status !== 0) {
    throw new Error(proc.stderr || `pdftoppm exited ${proc.status}`);
  }
  const produced = `${prefix}-1.png`;
  if (!fs.existsSync(produced)) {
    throw new Error(`pdftoppm did not write ${produced}`);
  }
  const image = sharp(produced);
  const meta = await image.metadata();
  if (meta.width !== CANONICAL_PAGE_WIDTH || meta.height !== CANONICAL_PAGE_HEIGHT) {
    throw new Error(`blank raster ${meta.width}x${meta.height}, expected ${CANONICAL_PAGE_WIDTH}x${CANONICAL_PAGE_HEIGHT}`);
  }
  await image.png().toFile(outPath);
  fs.unlinkSync(produced);
  return { path: outPath, width: meta.width, height: meta.height, dpi: CANONICAL_DPI };
}

export async function detectV131Observations({
  blankPath = BLANK_TEMPLATE_PATH,
  observedPath = RECTIFIED_PATH,
  templatePath = TEMPLATE_PATH,
  configPath = DETECTOR_CONFIG_PATH,
  outDir = ARTIFACT_DIR,
  pythonBin = process.env.POC7_PYTHON || process.env.POC6_PYTHON || 'python3',
} = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const proc = spawnSync(pythonBin, [
    DETECT_PY,
    '--blank', blankPath,
    '--observed', observedPath,
    '--template', templatePath,
    '--config', configPath,
    '--out', outDir,
  ], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (proc.error) throw proc.error;
  if (proc.status !== 0 && !proc.stdout) {
    throw new Error(proc.stderr || `detect.py exited ${proc.status}`);
  }
  const result = JSON.parse(proc.stdout);
  result.exit_code = proc.status;
  result.stderr = proc.stderr || '';
  return result;
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function validateObservations(obs, template = loadB131Template()) {
  const { checkboxes, fields } = fieldsByKind(template);
  const errors = [];
  for (const id of checkboxes) {
    const rec = obs.checkboxes?.[id];
    if (!rec) errors.push(`missing checkbox ${id}`);
    else {
      if (!CHECKBOX_STATES.has(rec.state)) errors.push(`bad checkbox state ${id}=${rec.state}`);
      if (!finiteNumber(rec.score)) errors.push(`non-finite score ${id}`);
      if (!finiteNumber(rec.confidence) || rec.confidence < 0 || rec.confidence > 1) {
        errors.push(`bad confidence ${id}=${rec.confidence}`);
      }
    }
  }
  for (const id of fields) {
    const rec = obs.fields?.[id];
    if (!rec) errors.push(`missing field ${id}`);
    else {
      if (!FIELD_STATES.has(rec.state)) errors.push(`bad field state ${id}=${rec.state}`);
      if (!finiteNumber(rec.score)) errors.push(`non-finite score ${id}`);
      if (!finiteNumber(rec.confidence) || rec.confidence < 0 || rec.confidence > 1) {
        errors.push(`bad confidence ${id}=${rec.confidence}`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

function tally(pairs) {
  const mismatches = [];
  let correct = 0;
  let uncertain = 0;
  const confusion = {};
  for (const [id, expected, got] of pairs) {
    const key = `${expected}→${got}`;
    confusion[key] = (confusion[key] || 0) + 1;
    if (got === 'uncertain') uncertain += 1;
    if (got === expected) correct += 1;
    else mismatches.push({ id, expected, got });
  }
  const total = pairs.length;
  return {
    correct,
    total,
    percent: total ? (100 * correct) / total : 0,
    uncertain,
    mismatches,
    confusion,
  };
}

export function scoreObservations(obs, truth = loadBenchmarkTruth()) {
  const checkboxPairs = Object.entries(truth.checkboxes || {}).map(([id, expected]) => [
    id, expected, obs.checkboxes?.[id]?.state,
  ]);
  const fieldPairs = Object.entries(truth.fields || {}).map(([id, expected]) => [
    id, expected, obs.fields?.[id]?.state,
  ]);
  const checkboxes = tally(checkboxPairs);
  const fields = tally(fieldPairs);
  return {
    checkboxes: {
      ...checkboxes,
      checked_to_unchecked: checkboxes.confusion['checked→unchecked'] || 0,
      unchecked_to_checked: checkboxes.confusion['unchecked→checked'] || 0,
      checked_to_uncertain: checkboxes.confusion['checked→uncertain'] || 0,
      unchecked_to_uncertain: checkboxes.confusion['unchecked→uncertain'] || 0,
    },
    fields: {
      ...fields,
      blank_to_nonblank: fields.confusion['blank→nonblank'] || 0,
      nonblank_to_blank: fields.confusion['nonblank→blank'] || 0,
      blank_to_uncertain: fields.confusion['blank→uncertain'] || 0,
      nonblank_to_uncertain: fields.confusion['nonblank→uncertain'] || 0,
    },
  };
}

export function formatBenchmarkReport(score) {
  const lines = [];
  lines.push('POC #7 benchmark (single v1.3.1 fixture; not a generalization claim)');
  lines.push(`CHECKBOXES: ${score.checkboxes.correct}/${score.checkboxes.total} (${score.checkboxes.percent.toFixed(1)}%)  uncertain=${score.checkboxes.uncertain}`);
  lines.push(`  checked→unchecked=${score.checkboxes.checked_to_unchecked}  unchecked→checked=${score.checkboxes.unchecked_to_checked}`);
  lines.push(`  checked→uncertain=${score.checkboxes.checked_to_uncertain}  unchecked→uncertain=${score.checkboxes.unchecked_to_uncertain}`);
  lines.push(`BLANK/NONBLANK: ${score.fields.correct}/${score.fields.total} (${score.fields.percent.toFixed(1)}%)  uncertain=${score.fields.uncertain}`);
  lines.push(`  blank→nonblank=${score.fields.blank_to_nonblank}  nonblank→blank=${score.fields.nonblank_to_blank}`);
  lines.push(`  blank→uncertain=${score.fields.blank_to_uncertain}  nonblank→uncertain=${score.fields.nonblank_to_uncertain}`);
  const misses = [...score.checkboxes.mismatches, ...score.fields.mismatches];
  if (misses.length === 0) {
    lines.push('MISMATCHES: none');
  } else {
    lines.push('MISMATCHES:');
    for (const m of misses) {
      lines.push(`  ${m.id}: expected ${m.expected}, got ${m.got}`);
    }
  }
  return lines.join('\n');
}
