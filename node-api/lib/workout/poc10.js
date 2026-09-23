import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { ARTIFACT_DIR, V131_CONFIG_DIR } from './poc6/index.js';
import { DETECT_PY, DETECTOR_CONFIG_PATH } from './poc7/index.js';
import {
  DETECTOR_VERSION,
  FROZEN_DETECTOR_SHA256,
  assertDetectorFrozen,
  sha256File,
} from './poc7b.js';
import {
  CROP_PAD_PX,
  DETECT_PY_SHA256,
  VLM_UPSCALE,
  loadJson,
  parseNumericLiteral,
  photoCatalog,
  templatePathForId,
} from './poc8.js';
import { POC8B_MODEL, loadPoc8Membership } from './poc8b.js';
import { loadPoc8bRows } from './poc8c.js';
import {
  ISSUE,
  PAPER,
  POC9_ARTIFACT_DIR,
  RECOGNITION,
  REVIEW_STATUS,
  assemblePhoto,
  finalizeReview,
  graniteIndex,
  toCanonicalCandidate,
} from './poc9.js';
import { ollamaChatImage } from './ollama.js';
import { DATE_PARSE, parseDateLiteral } from './dateParser.js';
import { loadV131WorkoutConfig } from './v131Config.js';
import { validateWorkoutSchema } from './schemaValidator.js';
import { DATE_ISSUE_CODES, validateWorkoutSemanticsV13 } from './semanticValidatorV13.js';
import {
  BLOCKING_ISSUE_CODES,
  HEADER_ISSUE,
  evaluateSaveReadiness,
} from './saveGate.js';

export const POC10_ARTIFACT_DIR = path.join(ARTIFACT_DIR, 'poc10');
export const POC10_GT_PATH = path.join(V131_CONFIG_DIR, 'fixtures', 'poc10', 'header-ground-truth.json');
export const HEADER_CROP_PROFILE = 'poc10-header-pad6';
export const SCHEMA_VERSION = '1.3';

export const DATE_PROMPT = [
  'Read only the handwritten date in this image.',
  'Return exactly the handwritten date characters.',
  'Do not add a year.',
  'Do not normalize the date.',
  'If blank, return BLANK.',
  'If unreadable, return UNKNOWN.',
].join(' ');

export const BODYWEIGHT_PROMPT = [
  'Read only the handwritten bodyweight number in this image.',
  'Return only the number.',
  'If blank, return BLANK.',
  'If unreadable, return UNKNOWN.',
].join(' ');

export const DURATION_PROMPT = [
  'Read only the handwritten workout duration number in this image.',
  'Return only the number.',
  'If blank, return BLANK.',
  'If unreadable, return UNKNOWN.',
].join(' ');

export const HEADER_PROMPTS = {
  'header.date': DATE_PROMPT,
  'header.bodyweight': BODYWEIGHT_PROMPT,
  'header.duration': DURATION_PROMPT,
};

const OPTIONAL_TEXT_FIELDS = ['note.quick_note', 'header.pain_area'];
const HEADER_RECOGNIZE_FIELDS = ['header.date', 'header.bodyweight', 'header.duration'];

function issue(code, extra = {}) {
  return {
    code,
    field_id: extra.fieldId ?? null,
    exercise_slot: extra.exerciseSlot ?? null,
    set_number: extra.setNumber ?? null,
    observed_value: extra.observedValue ?? null,
    message: extra.message ?? null,
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

export function loadHeaderGroundTruth(truthPath = POC10_GT_PATH) {
  return loadJson(truthPath);
}

export function stripHeaderRaw(raw) {
  if (raw == null) return '';
  return String(raw).replace(/\u0000/g, '').trim().replace(/^['"`]|['"`]$/g, '').trim();
}

export function parseHeaderRecognizerOutput(fieldId, raw) {
  const text = stripHeaderRaw(raw);
  if (!text || /^blank\.?$/i.test(text)) return { kind: 'BLANK', literal: text || 'BLANK' };
  if (/^unknown\.?$/i.test(text)) return { kind: 'UNKNOWN', literal: text };
  if (fieldId === 'header.date') return { kind: 'DATE_LITERAL', literal: text };
  const parsed = parseNumericLiteral(text);
  if (parsed.value === 'UNKNOWN') return { kind: 'UNKNOWN', literal: text };
  return { kind: 'NUMERIC', literal: parsed.value, value: Number(parsed.value) };
}

export function resolveHeaders(raw, literalsByField = {}) {
  const issues = [];
  const observations = {};
  const optionalUnrecognized = [];

  const datePaper = raw.observations['header.date']?.paper_state;
  const date = resolveDate(datePaper, literalsByField['header.date'], issues);
  observations['header.date'] = date.observation;

  const bwPaper = raw.observations['header.bodyweight']?.paper_state;
  const bw = resolveOptionalNumeric(
    'header.bodyweight',
    bwPaper,
    literalsByField['header.bodyweight'],
    HEADER_ISSUE.UNREADABLE_BODYWEIGHT,
    issues,
  );
  observations['header.bodyweight'] = bw.observation;

  const durPaper = raw.observations['header.duration']?.paper_state;
  const dur = resolveOptionalNumeric(
    'header.duration',
    durPaper,
    literalsByField['header.duration'],
    HEADER_ISSUE.UNREADABLE_DURATION,
    issues,
  );
  observations['header.duration'] = dur.observation;

  for (const fieldId of OPTIONAL_TEXT_FIELDS) {
    const paper = raw.observations[fieldId]?.paper_state;
    const present = paper === PAPER.NONBLANK || paper === PAPER.UNCERTAIN;
    observations[fieldId] = {
      field_id: fieldId,
      paper_state: paper || PAPER.BLANK,
      recognition_state: RECOGNITION.NOT_IMPLEMENTED,
      required_for_save: false,
    };
    if (present) {
      optionalUnrecognized.push({
        field_id: fieldId,
        paper_state: PAPER.NONBLANK,
        recognition_state: RECOGNITION.NOT_IMPLEMENTED,
        required_for_save: false,
      });
    }
  }

  return {
    date: date.iso,
    date_status: date.status,
    date_literal: date.literal,
    date_parsed: date.parsed,
    bodyweight_lb: bw.value,
    duration_min: dur.value,
    observations,
    issues,
    ambiguities: date.ambiguities,
    optional_unrecognized: optionalUnrecognized,
  };
}

function resolveDate(paperState, literal, issues) {
  if (paperState === PAPER.BLANK || paperState == null) {
    issues.push(issue(HEADER_ISSUE.BLANK_DATE, {
      fieldId: 'header.date',
      message: 'Paper date is blank. A complete date is required before save. Year/date is not inferred.',
    }));
    return {
      iso: null,
      status: DATE_PARSE.BLANK,
      literal: null,
      parsed: null,
      ambiguities: [],
      observation: {
        field_id: 'header.date',
        paper_state: PAPER.BLANK,
        recognition_state: RECOGNITION.NOT_RUN,
        recognized_value: null,
      },
    };
  }
  const parsedOut = literal == null
    ? { kind: 'UNKNOWN', literal: null }
    : parseHeaderRecognizerOutput('header.date', literal);
  if (parsedOut.kind === 'BLANK' || parsedOut.kind === 'UNKNOWN') {
    issues.push(issue(HEADER_ISSUE.UNREADABLE_DATE, {
      fieldId: 'header.date',
      observedValue: null,
      message: 'Paper date is nonblank but the recognizer did not return a usable date literal.',
    }));
    return {
      iso: null,
      status: DATE_PARSE.UNKNOWN,
      literal: parsedOut.literal,
      parsed: null,
      ambiguities: [],
      observation: {
        field_id: 'header.date',
        paper_state: PAPER.NONBLANK,
        recognition_state: RECOGNITION.UNKNOWN,
        recognized_value: null,
      },
    };
  }
  const parsed = parseDateLiteral(parsedOut.literal);
  if (parsed.status === DATE_PARSE.PARTIAL) {
    issues.push(issue(HEADER_ISSUE.PARTIAL_DATE, {
      fieldId: 'header.date',
      observedValue: parsed.literal,
      message: 'Month/day present; year not written. Year is not inferred.',
    }));
    return {
      iso: null,
      status: parsed.status,
      literal: parsed.literal,
      parsed: parsed.parsed,
      ambiguities: [{
        location: 'workout.date',
        field: 'date',
        detected_value: parsed.literal,
        reason: 'PARTIAL_DATE: year is not written; full ISO date cannot be determined without inference.',
      }],
      observation: {
        field_id: 'header.date',
        paper_state: PAPER.NONBLANK,
        recognition_state: 'DATE_LITERAL',
        recognized_value: parsed.literal,
      },
    };
  }
  if (parsed.status === DATE_PARSE.COMPLETE) {
    return {
      iso: parsed.iso,
      status: parsed.status,
      literal: parsed.literal,
      parsed: parsed.parsed,
      ambiguities: [],
      observation: {
        field_id: 'header.date',
        paper_state: PAPER.NONBLANK,
        recognition_state: 'DATE_LITERAL',
        recognized_value: parsed.literal,
      },
    };
  }
  if (parsed.status === DATE_PARSE.INVALID) {
    issues.push(issue(HEADER_ISSUE.INVALID_DATE, {
      fieldId: 'header.date',
      observedValue: parsed.literal,
      message: 'Structured date literal is not a real calendar date. Value is not coerced.',
    }));
    return {
      iso: null,
      status: parsed.status,
      literal: parsed.literal,
      parsed: parsed.parsed,
      ambiguities: [],
      observation: {
        field_id: 'header.date',
        paper_state: PAPER.NONBLANK,
        recognition_state: 'DATE_LITERAL',
        recognized_value: parsed.literal,
      },
    };
  }
  issues.push(issue(HEADER_ISSUE.UNREADABLE_DATE, {
    fieldId: 'header.date',
    observedValue: parsed.literal,
    message: 'Date literal is not a structured M-D / M-D-YY form.',
  }));
  return {
    iso: null,
    status: DATE_PARSE.UNPARSED,
    literal: parsed.literal,
    parsed: null,
    ambiguities: [],
    observation: {
      field_id: 'header.date',
      paper_state: PAPER.NONBLANK,
      recognition_state: RECOGNITION.UNKNOWN,
      recognized_value: parsed.literal,
    },
  };
}

function resolveOptionalNumeric(fieldId, paperState, literal, unreadCode, issues) {
  if (paperState === PAPER.BLANK || paperState == null) {
    return {
      value: null,
      observation: {
        field_id: fieldId,
        paper_state: PAPER.BLANK,
        recognition_state: RECOGNITION.NOT_RUN,
        recognized_value: null,
      },
    };
  }
  const parsed = literal == null
    ? { kind: 'UNKNOWN', literal: null }
    : parseHeaderRecognizerOutput(fieldId, literal);
  if (parsed.kind === 'NUMERIC' && parsed.value > 0) {
    return {
      value: parsed.value,
      observation: {
        field_id: fieldId,
        paper_state: PAPER.NONBLANK,
        recognition_state: RECOGNITION.NUMERIC,
        recognized_value: parsed.value,
      },
    };
  }
  issues.push(issue(unreadCode, {
    fieldId,
    observedValue: parsed.literal ?? null,
    message: `${fieldId} is nonblank but not a usable positive number. Optional; does not block save.`,
  }));
  return {
    value: null,
    observation: {
      field_id: fieldId,
      paper_state: PAPER.NONBLANK,
      recognition_state: RECOGNITION.UNKNOWN,
      recognized_value: null,
    },
  };
}

export function toV131Canonical(resolved, reviewStatus, header) {
  const canonical = toCanonicalCandidate(resolved, reviewStatus);
  canonical.schema_version = SCHEMA_VERSION;
  canonical.workout.date = header.date;
  canonical.workout.bodyweight_lb = header.bodyweight_lb;
  canonical.workout.duration_min = header.duration_min;
  if (header.ambiguities?.length) canonical.ambiguities = header.ambiguities;
  return canonical;
}

export function assembleV131Photo(photo, {
  granite = graniteIndex(),
  headerLiterals = {},
  config = loadV131WorkoutConfig(),
} = {}) {
  const assembled = assemblePhoto(photo, { granite });
  const header = resolveHeaders(assembled.raw, headerLiterals);
  const review = finalizeReview([
    ...assembled.review.issues,
    ...header.issues,
  ]);
  const canonical = toV131Canonical(assembled.resolved, review.status, header);
  const schema = validateWorkoutSchema(canonical, config.schema);
  const semantic = validateWorkoutSemanticsV13(canonical, { review, config });
  const save = evaluateSaveReadiness({ schema, semantic, review, canonical });
  return {
    photo_id: photo.photo_id,
    sheet_id: photo.sheet_id,
    template_id: photo.template_id,
    ...assembled,
    header,
    review,
    canonical,
    schema,
    semantic,
    save,
  };
}

export function poc9Regression() {
  const rows = loadPoc8bRows();
  const poc9 = loadJson(path.join(POC9_ARTIFACT_DIR, 'results.json'));
  return {
    detector_sha256: sha256File(DETECTOR_CONFIG_PATH),
    detect_py_sha256: sha256File(DETECT_PY),
    membership: loadPoc8Membership().samples.length,
    granite_exact: rows.filter((r) => r.clean === r.expected).length,
    granite_total: rows.length,
    poc9_unreadable: poc9.granite_miss_buckets.caught_unreadable,
    poc9_silent: poc9.granite_miss_buckets.silent_survives,
    poc9_rewritten: poc9.recognized_values_rewritten,
  };
}

function cachePath() {
  return path.join(POC10_ARTIFACT_DIR, 'vlm-cache.json');
}

function loadCache() {
  const p = cachePath();
  if (!fs.existsSync(p)) return {};
  return loadJson(p);
}

function saveCache(cache) {
  fs.mkdirSync(POC10_ARTIFACT_DIR, { recursive: true });
  fs.writeFileSync(cachePath(), JSON.stringify(cache, null, 2));
}

export async function writeHeaderCrop(photo, field, dest) {
  const meta = await sharp(photo.rectified).metadata();
  const box = clampExtract(field.px, CROP_PAD_PX, meta.width, meta.height);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await sharp(photo.rectified)
    .extract(box)
    .resize({
      width: box.width * VLM_UPSCALE,
      height: box.height * VLM_UPSCALE,
      kernel: 'lanczos3',
    })
    .png()
    .toFile(dest);
  return dest;
}

export async function recognizeHeaderFields({
  catalog = photoCatalog(),
  onProgress,
  env = process.env,
} = {}) {
  const cache = loadCache();
  const results = [];
  for (const photo of catalog) {
    const detector = loadJson(photo.observations);
    const template = loadJson(templatePathForId(photo.template_id));
    const fieldsById = Object.fromEntries((template.fields || []).map((f) => [f.id, f]));
    for (const fieldId of HEADER_RECOGNIZE_FIELDS) {
      const paper = detector.fields?.[fieldId]?.state;
      const sampleId = `${photo.photo_id}__${fieldId}`;
      if (paper !== 'nonblank') {
        results.push({
          sample_id: sampleId,
          photo_id: photo.photo_id,
          sheet_id: photo.sheet_id,
          field_id: fieldId,
          paper_state: paper || 'blank',
          invoked: false,
          raw: null,
          recognized: 'BLANK',
          latency_ms: 0,
          cached: false,
        });
        continue;
      }
      if (cache[sampleId] && cache[sampleId].model === POC8B_MODEL) {
        results.push({ ...cache[sampleId], cached: true, invoked: true, paper_state: 'nonblank' });
        onProgress?.({ field_id: fieldId, photo_id: photo.photo_id, cached: true });
        continue;
      }
      const crop = path.join(POC10_ARTIFACT_DIR, 'crops', photo.photo_id, fieldId, 'vlm.png');
      await writeHeaderCrop(photo, fieldsById[fieldId], crop);
      const t0 = Date.now();
      let raw = '';
      let error = null;
      try {
        const imageBuffer = fs.readFileSync(crop);
        const ollama = await ollamaChatImage({
          imageBuffer,
          model: POC8B_MODEL,
          content: HEADER_PROMPTS[fieldId],
          env,
        });
        raw = ollama.raw ?? '';
      } catch (err) {
        error = String(err?.message || err);
      }
      const parsed = parseHeaderRecognizerOutput(fieldId, raw);
      const row = {
        sample_id: sampleId,
        photo_id: photo.photo_id,
        sheet_id: photo.sheet_id,
        field_id: fieldId,
        paper_state: 'nonblank',
        invoked: true,
        raw,
        recognized: parsed.kind === 'NUMERIC' ? String(parsed.value) : parsed.literal,
        parse_kind: parsed.kind,
        latency_ms: Date.now() - t0,
        error,
        model: POC8B_MODEL,
        crop,
        prompt: HEADER_PROMPTS[fieldId],
      };
      cache[sampleId] = row;
      saveCache(cache);
      results.push({ ...row, cached: false });
      onProgress?.({ field_id: fieldId, photo_id: photo.photo_id, cached: false, recognized: row.recognized });
    }
  }
  return results;
}

function literalsFromRecognition(rows, photoId) {
  const out = {};
  for (const row of rows) {
    if (row.photo_id !== photoId || !row.invoked) continue;
    out[row.field_id] = row.recognized;
  }
  return out;
}

function scoreHeader(rows, truth) {
  const sheets = Object.fromEntries((truth.sheets || []).map((s) => [s.sheet_id, s]));
  const photoRows = [];
  for (const row of rows) {
    const sheet = sheets[row.sheet_id];
    const expected = sheet?.values?.[row.field_id];
    if (!expected) continue;
    const paperMatch = (expected.paper_state === 'blank' && !row.invoked)
      || (expected.paper_state === 'nonblank' && row.invoked);
    let literalExact = false;
    let canonicalExact = false;
    if (expected.paper_state === 'blank') {
      literalExact = !row.invoked;
      canonicalExact = true;
    } else if (row.field_id === 'header.date') {
      const rec = parseDateLiteral(row.recognized);
      literalExact = row.recognized === expected.literal;
      canonicalExact = (rec.iso || null) === (expected.canonical_date || null)
        && rec.status !== DATE_PARSE.UNKNOWN
        && rec.status !== DATE_PARSE.UNPARSED;
      if (expected.kind === 'partial') {
        canonicalExact = rec.status === DATE_PARSE.PARTIAL && rec.iso == null;
      }
    } else {
      literalExact = String(row.recognized) === String(expected.literal);
      const rec = parseHeaderRecognizerOutput(row.field_id, row.recognized);
      canonicalExact = rec.kind === 'NUMERIC' && rec.value === expected.canonical;
    }
    photoRows.push({
      ...row,
      expected_literal: expected.literal,
      expected_canonical: expected.canonical_date ?? expected.canonical ?? null,
      expected_kind: expected.kind,
      paper_match: paperMatch,
      literal_exact: literalExact,
      canonical_exact: canonicalExact,
    });
  }

  const byField = {};
  for (const fieldId of HEADER_RECOGNIZE_FIELDS) {
    const subset = photoRows.filter((r) => r.field_id === fieldId);
    const nonblank = subset.filter((r) => r.invoked);
    const blank = subset.filter((r) => !r.invoked);
    byField[fieldId] = {
      photos: subset.length,
      blank: blank.length,
      blank_correct: blank.filter((r) => r.paper_match).length,
      nonblank: nonblank.length,
      literal_exact: nonblank.filter((r) => r.literal_exact).length,
      canonical_exact: nonblank.filter((r) => r.canonical_exact).length,
      unknown: nonblank.filter((r) => String(r.recognized).toUpperCase() === 'UNKNOWN').length,
    };
  }

  const unique = [];
  for (const sheet of truth.sheets || []) {
    const rec = {};
    for (const fieldId of HEADER_RECOGNIZE_FIELDS) {
      const primary = photoRows.find((r) => r.photo_id === sheet.primary_photo && r.field_id === fieldId);
      const photos = photoRows.filter((r) => r.sheet_id === sheet.sheet_id && r.field_id === fieldId);
      rec[fieldId] = {
        expected: sheet.values[fieldId],
        primary_recognized: primary?.recognized ?? null,
        primary_literal_exact: Boolean(primary?.literal_exact),
        primary_canonical_exact: Boolean(primary?.canonical_exact),
        all_photos_literal_exact: photos.length > 0 && photos.every((p) => p.literal_exact || (!p.invoked && sheet.values[fieldId].kind === 'blank')),
      };
    }
    unique.push({ sheet_id: sheet.sheet_id, primary_photo: sheet.primary_photo, fields: rec });
  }

  return { photo_rows: photoRows, by_field: byField, unique_sheets: unique };
}

const SILENT_GRANITE_ERRORS = [
  { sheet_id: 'B-original', field_id: 'B05.S1.right', granite: '6', expected: '8' },
  { sheet_id: 'B-original', field_id: 'B05.S1.left', granite: '6', expected: '8', photos: ['IMG_1307'] },
  { sheet_id: 'A-2026-09-20', field_id: 'A02.S1.load', granite: '45', expected: '95' },
  { sheet_id: 'C-2026-10-31', field_id: 'C02.S2.load', granite: '96', expected: '90' },
  { sheet_id: 'C-2026-10-31', field_id: 'C07.S2.seconds', granite: '410', expected: '40' },
];

function schemaMigrationNotes() {
  return [
    '# POC #10 schema migration notes',
    '',
    'v1.2 files were not mutated. New files live under `config/workout-v1.3.1/`.',
    '',
    '## Versioning model',
    '',
    '- `schema_version` **1.3** is the canonical JSON *data contract* (field shapes, allowed nulls, template_version grammar).',
    '- `template_version` **A-1.3.1 / B-1.3.1 / C-1.3.1** is the *physical paper form*.',
    '- These are intentionally independent. Paper patch 1.3.1 does not imply the JSON contract is named 1.3.1.',
    '- Canonical set/workout keys remain the v1.2 shape. The contract revision exists because template_version grammar and date-null semantics changed.',
    '',
    '## template_version grammar',
    '',
    'v1.2 (unchanged): `^[ABC]-[0-9]+\\.[0-9]+$`  → A-1.2',
    'v1.3: `^[ABC]-[0-9]+\\.[0-9]+(\\.[0-9]+)?$` → A-1.2 or A-1.3.1',
    'Not an arbitrary string.',
    '',
    '## SV03',
    '',
    'v1.2 still expects A-1.2 from `config/workout-v1.2/routine-templates.json`.',
    'v1.3.1 path uses `config/workout-v1.3.1/routine-templates.json` so routine A → A-1.3.1 (same exercise slots).',
    '',
    '## SV13',
    '',
    'v1.2: any date=null requires REVIEW_REQUIRED plus a non-empty date ambiguity (partial-date contract).',
    'v1.3.1 classifies null dates:',
    '',
    '| paper | canonical date | review | ambiguity | save |',
    '| --- | --- | --- | --- | --- |',
    '| BLANK | null | BLANK_DATE | none (SV12 missing data) | not ready |',
    '| PARTIAL (9-20) | null | PARTIAL_DATE | detected_value = literal | not ready |',
    '| UNREADABLE | null | UNREADABLE_DATE | none fabricated | not ready |',
    '| INVALID (2-30-26) | null | INVALID_DATE | literal preserved on issue | not ready |',
    '| COMPLETE (9-20-26) | 2026-09-20 | none | none | allowed if nothing else blocks |',
    '',
    'Two-digit years: YY → 2000+YY. Fixed domain rule. Not `Date.now()`. Missing years are never invented.',
    '',
    '## Schema validity vs save readiness',
    '',
    '1. schema_valid — Ajv against v1.3 contract (date null is legal).',
    '2. semantic_valid — SV01–SV05, SV11, SV13-v1.3, SV14, SV15.',
    '3. review_status — any review issue including optional unreadable bodyweight.',
    '4. save_ready — schema + semantic + date != null + no blocking issues.',
    '',
    '`save_ready` is not a correctness guarantee. Known #9 glyph substitutions can still be present.',
    '',
    '## Blocking vs non-blocking',
    '',
    `Blocking: ${[...BLOCKING_ISSUE_CODES].join(', ')}`,
    `Non-blocking: ${HEADER_ISSUE.UNREADABLE_BODYWEIGHT}, ${HEADER_ISSUE.UNREADABLE_DURATION}, unimplemented optional text.`,
    '',
  ].join('\n');
}

function renderReport({ frozen, headerScore, sheets, recognition, photoSaves, injected }) {
  const date = headerScore.by_field['header.date'];
  const bw = headerScore.by_field['header.bodyweight'];
  const dur = headerScore.by_field['header.duration'];
  const sheetLines = sheets.map((s) => (
    `| ${s.sheet_id} | ${s.template_id} | ${s.header.date_literal || '—'} | ${s.canonical.workout.date || 'null'} | ${s.canonical.workout.bodyweight_lb ?? 'null'} | ${s.canonical.workout.duration_min ?? 'null'} | ${s.canonical.workout.effort} | ${s.canonical.workout.pain.level} | ${s.save.schema_valid} | ${s.save.semantic_valid} | ${s.save.review_status} | ${s.save.save_ready} | ${s.save.blocking_issues.join(', ') || '—'} |`
  ));
  const uniqueDate = headerScore.unique_sheets.map((s) => {
    const d = s.fields['header.date'];
    return `- ${s.sheet_id}: expected \`${d.expected.literal}\`/${d.expected.kind} → primary \`${d.primary_recognized}\` literal_exact=${d.primary_literal_exact} canonical_exact=${d.primary_canonical_exact}`;
  });
  const saveReadySheets = sheets.filter((s) => s.save.save_ready).map((s) => s.sheet_id);
  const invoked = recognition.filter((r) => r.invoked).length;
  const graniteReady = (photoSaves || []).filter((p) => p.save_ready);
  const wrongComplete = (photoSaves || []).filter((p) => (
    p.canonical_date && p.sheet_id === 'B-2026-09-20' && p.canonical_date !== '2026-09-20'
  ));

  return [
    '# POC #10 — Header Recognition + v1.3.1 Schema Integration',
    '',
    'Isolated Granite header crops + deterministic date parsing + a versioned v1.3 schema/save-gate. Numeric recognition and poc7-a1c are frozen. No year is invented. No numbers are rewritten.',
    '',
    '## Freeze',
    '',
    `| item | value |`,
    `| --- | --- |`,
    `| detector | ${DETECTOR_VERSION} |`,
    `| detector SHA256 | \`${frozen.detector_sha256}\` |`,
    `| detect.py SHA256 | \`${frozen.detect_py_sha256}\` |`,
    `| numeric membership | ${frozen.membership} |`,
    `| Granite #8B exact | ${frozen.granite_exact}/${frozen.granite_total} |`,
    `| #9 UNREADABLE caught | ${frozen.poc9_unreadable} |`,
    `| #9 silent survivors | ${frozen.poc9_silent} |`,
    `| #9 rewritten numbers | ${frozen.poc9_rewritten} |`,
    '',
    '## Versioning',
    '',
    '`schema_version` = **1.3** (JSON data contract). `template_version` = **A/B/C-1.3.1** (paper). They are not the same number on purpose.',
    '',
    'Two-digit year policy: **YY → 2000+YY**. Fixed. Not current year.',
    '',
    '## Header recognition',
    '',
    `Granite invoked on **${invoked}** detector-nonblank header crops (blank cells used poc7-a1c only).`,
    '',
    '| field | nonblank photos | literal exact | canonical exact | UNKNOWN | blank photos correct |',
    '| --- | --- | --- | --- | --- | --- |',
    `| date | ${date.nonblank} | ${date.literal_exact}/${date.nonblank} | ${date.canonical_exact}/${date.nonblank} | ${date.unknown} | ${date.blank_correct}/${date.blank} |`,
    `| bodyweight | ${bw.nonblank} | ${bw.literal_exact}/${bw.nonblank} | ${bw.canonical_exact}/${bw.nonblank} | ${bw.unknown} | ${bw.blank_correct}/${bw.blank} |`,
    `| duration | ${dur.nonblank} | ${dur.literal_exact}/${dur.nonblank} | ${dur.canonical_exact}/${dur.nonblank} | ${dur.unknown} | ${dur.blank_correct}/${dur.blank} |`,
    '',
    'Bodyweight written sample is one physical sheet (185 lb). Duration is blank on every v1.3.1 sheet. Do not over-read those accuracies.',
    '',
    '### Unique physical dates',
    '',
    ...uniqueDate,
    '',
    '## Primary sheets (end-to-end)',
    '',
    '| sheet | template | date literal | canonical date | BW | duration | effort | pain | schema | semantic | review | save_ready | blocking |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...sheetLines,
    '',
    `Save-ready unique primary sheets (Granite date as-is): **${saveReadySheets.join(', ') || 'none'}**.`,
    graniteReady.length
      ? `Granite photo-level save_ready: ${graniteReady.map((p) => `${p.photo_id} date=${p.canonical_date}`).join('; ')}.`
      : 'Granite photo-level save_ready: none.',
    wrongComplete.length
      ? `Wrong complete dates that the parser would accept: ${wrongComplete.map((p) => `${p.photo_id} ${p.date_literal}→${p.canonical_date}`).join('; ')}.`
      : 'No Granite header output on this set produced a complete ISO date that disagrees with unique-sheet GT.',
    `Human-confirmed date 9-20-26 on frozen B-2026-09-20 sets: save_ready=${injected?.save?.save_ready === true}.`,
    '',
    '## Known silent numeric errors (from #9, unchanged)',
    '',
    ...SILENT_GRANITE_ERRORS.map((e) => `- ${e.sheet_id} \`${e.field_id}\`: Granite **${e.granite}** vs paper **${e.expected}**`),
    '',
    '`save_ready` means no deterministic blocking condition remains. It does **not** mean the transcription is guaranteed correct.',
    '',
    '## Answers',
    '',
    `1. **Can isolated Granite reliably read the constrained date field?** Photo-level canonical ${date.canonical_exact}/${date.nonblank}. Unique primaries: B-original 9-19 and A 9-20 and C 10-31-26 succeed; B-2026 primary failed (Granite treated \`9-20-26\` plus printed DATE “E” as a math problem / prose). Residuals go to review. No model hunt.`,
    `2. **Date literal accuracy (photo-level nonblank):** ${date.literal_exact}/${date.nonblank}.`,
    `3. **Canonical parsed-date accuracy (photo-level nonblank):** ${date.canonical_exact}/${date.nonblank}. IMG_1312 \`9-26\` is parsed as PARTIAL (month=9, day=26, year=null), not as 2026-09-26. A two-digit token after one separator is a day, not a year.`,
    '4. **Unique physical-sheet dates:** see list above. Repeated photos are not independent dates. B-2026 is 0/4 literal exact.',
    '5. **Partial dates without inventing years?** Yes. `9-20` and `9-19` → date=null + PARTIAL_DATE. Parser tests include v1.2 `4-12`. Prose wrapping a date is not parsed into a year.',
    `6. **Bodyweight when present?** ${bw.literal_exact}/${bw.nonblank} photo-level exact on written cells (C sheet 185). Small n.`,
    '7. **Blank bodyweight remains null without review?** Yes.',
    '8. **Blank duration remains null without review?** Yes. All four unique sheets are blank duration.',
    '9. **Schema changes for v1.3.1?** New contract file: schema_version 1.3, template_version pattern allows three components, date=null is schema-legal. v1.2 schema file untouched.',
    '10. **v1.2 compatibility preserved?** Yes. Existing v1.2 schema + semanticValidator + Routine B fixture tests still run.',
    '11. **SV03?** v1.3.1 path checks A→A-1.3.1, B→B-1.3.1, C→C-1.3.1 against the new routine-templates file. v1.2 still checks A-1.2.',
    '12. **SV13?** Null dates are classified (BLANK / PARTIAL / UNREADABLE / INVALID). Blank does not fabricate an ambiguity. Partial preserves the visible literal. Complete ISO needs no date issue.',
    '13. **Schema vs save readiness?** Yes: schema_valid ∧ semantic_valid ∧ date≠null ∧ no blocking issues = save_ready.',
    '14. **Blocking save:** unreadable required numerics, missing initial load, conflicting BW/load, incomplete required measurements, integrity extremes/non-positive, multiple/uncertain effort-pain, blank/partial/unreadable/invalid date.',
    '15. **Non-blocking:** blank optional bodyweight/duration, unreadable optional bodyweight/duration, unimplemented quick note / pain-area text.',
    '16. **Per primary sheet:** see table. All four are schema_valid and semantic_valid. None of the Granite-primary paths is save_ready.',
    `17. **At least one real sheet save-ready without fabricated data?** Granite-as-recognized unique primaries: **no**. C has a real complete Granite date 2026-10-31 and bodyweight 185 but is blocked by C04.S1.load UNKNOWN. B-2026-09-20 has clean #9 sets; the primary date crop was unreadable. Applying the human-reviewed literal \`9-20-26\` to those frozen sets is save_ready=${injected?.save?.save_ready === true} (review confirmation, year not invented). Do not harvest dates from Granite prose.`,
    '18. **Silent survivors in a save-ready workout:** If B-original or A later become save-ready, 6≠8 and 45≠95 still survive. C 96≠90 and 410≠40 sit behind UNKNOWN load today. A wrong complete date did not slip through on this set; `9-26` stayed partial.',
    '19. **Freeze v1.3.1 canonical/save architecture?** Yes as a contract: form 1.3.1, detector poc7-a1c, numeric #8B Granite, assembly #9, schema/save-gate #10. Header Granite is usable with review; it is not a reason to hunt another model. Next phase is end-to-end validation and review UI (complete partial dates, confirm UNKNOWN), not another recognition POC.',
    '20. **Before production integration:** review UI for PARTIAL_DATE / UNREADABLE_DATE / UNKNOWN numerics; persist only when save_ready; workout_id assignment. Optional note/pain-area OCR remains out of scope. Do not use EXIF or today as the workout date.',
    '',
    '## STOP',
    '',
    'POC #10 stops here. No detector/numeric-crop/Granite-numeric retune, no note OCR, no year inference, no EXIF/current-date, no review UI, no DB/API, no POC #11.',
    '',
  ].join('\n');
}

export async function runPoc10({ onProgress } = {}) {
  const frozenSnap = assertDetectorFrozen();
  const frozen = {
    detector_sha256: frozenSnap.detector_sha256,
    ...poc9Regression(),
  };
  if (frozen.detector_sha256 !== FROZEN_DETECTOR_SHA256) {
    throw new Error('detector hash mismatch');
  }
  if (frozen.membership !== 519 || frozen.granite_exact !== 502) {
    throw new Error('numeric freeze mismatch');
  }

  fs.mkdirSync(POC10_ARTIFACT_DIR, { recursive: true });
  const truth = loadHeaderGroundTruth();
  fs.writeFileSync(path.join(POC10_ARTIFACT_DIR, 'header-ground-truth.json'), JSON.stringify(truth, null, 2));

  const recognition = await recognizeHeaderFields({ onProgress });
  const headerScore = scoreHeader(recognition, truth);
  const granite = graniteIndex();
  const config = loadV131WorkoutConfig();
  const catalog = photoCatalog();
  const assemblies = catalog.map((photo) => {
    const headerLiterals = literalsFromRecognition(recognition, photo.photo_id);
    return assembleV131Photo(photo, { granite, headerLiterals, config });
  });

  const primaryIds = new Set((truth.sheets || []).map((s) => s.primary_photo));
  const sheets = assemblies.filter((a) => primaryIds.has(a.photo_id)).map((a) => ({
    sheet_id: a.sheet_id,
    photo_id: a.photo_id,
    template_id: a.template_id,
    header: {
      date_literal: a.header.date_literal,
      date_status: a.header.date_status,
      date: a.header.date,
      bodyweight_lb: a.header.bodyweight_lb,
      duration_min: a.header.duration_min,
    },
    set_issue_codes: [...new Set(a.review.issues.filter((i) => !Object.values(DATE_ISSUE_CODES).includes(i.code) && !String(i.code).startsWith('UNREADABLE_BODY') && !String(i.code).startsWith('UNREADABLE_DUR') && i.field_id && !String(i.field_id).startsWith('header.') && i.field_id !== 'note.quick_note').map((i) => i.code))],
    header_issue_codes: [...new Set(a.review.issues.filter((i) => String(i.field_id || '').startsWith('header.') || Object.values(DATE_ISSUE_CODES).includes(i.code)).map((i) => i.code))],
    all_issue_codes: [...new Set(a.review.issues.map((i) => i.code))],
    schema: a.schema,
    semantic: { valid: a.semantic.valid, errors: a.semantic.semanticErrors },
    review: a.review,
    save: a.save,
    canonical: a.canonical,
  }));

  const saveRows = sheets.map((s) => ({
    sheet_id: s.sheet_id,
    photo_id: s.photo_id,
    template_id: s.template_id,
    date_literal: s.header.date_literal,
    canonical_date: s.header.date,
    bodyweight_lb: s.header.bodyweight_lb,
    duration_min: s.header.duration_min,
    effort: s.canonical.workout.effort,
    pain_level: s.canonical.workout.pain.level,
    schema_valid: s.save.schema_valid,
    semantic_valid: s.save.semantic_valid,
    review_status: s.save.review_status,
    save_ready: s.save.save_ready,
    blocking_issues: s.save.blocking_issues,
    non_blocking_issues: s.save.non_blocking_issues,
    all_issue_codes: s.all_issue_codes,
    silent_numeric_errors: SILENT_GRANITE_ERRORS.filter((e) => e.sheet_id === s.sheet_id),
  }));

  const allPhotoSaves = assemblies.map((a) => ({
    photo_id: a.photo_id,
    sheet_id: a.sheet_id,
    date_literal: a.header.date_literal,
    canonical_date: a.header.date,
    date_status: a.header.date_status,
    schema_valid: a.save.schema_valid,
    semantic_valid: a.save.semantic_valid,
    review_status: a.save.review_status,
    save_ready: a.save.save_ready,
    blocking_issues: a.save.blocking_issues,
  }));
  const graniteSaveReadyPhotos = allPhotoSaves.filter((p) => p.save_ready);

  const b2026Photo = catalog.find((p) => p.photo_id === 'IMG_1311');
  const b2026 = assemblies.find((a) => a.photo_id === 'IMG_1311');
  const b2026Injected = assembleV131Photo(b2026Photo, {
    granite,
    headerLiterals: { 'header.date': '9-20-26' },
    config,
  });
  const aPrimary = assemblies.find((a) => a.photo_id === 'IMG_1319');
  const bOrig = assemblies.find((a) => a.photo_id === 'routine-B-v1.3.1');

  const blankDateExample = (() => {
    const cloned = structuredClone(b2026.raw);
    cloned.observations['header.date'] = {
      field_id: 'header.date',
      paper_state: PAPER.BLANK,
      recognition_state: RECOGNITION.NOT_RUN,
      recognized_value: null,
    };
    const header = resolveHeaders(cloned, {});
    const review = finalizeReview([...b2026.review.issues.filter((i) => i.code !== HEADER_ISSUE.PARTIAL_DATE && i.code !== HEADER_ISSUE.BLANK_DATE && i.code !== HEADER_ISSUE.UNREADABLE_DATE && i.code !== HEADER_ISSUE.INVALID_DATE), ...header.issues]);
    const canonical = toV131Canonical(b2026.resolved, review.status, header);
    const schema = validateWorkoutSchema(canonical, config.schema);
    const semantic = validateWorkoutSemanticsV13(canonical, { review, config });
    const save = evaluateSaveReadiness({ schema, semantic, review, canonical });
    return { _comment: 'Synthetic: same B-2026-09-20 sets with a blank date. Schema-valid, not save-ready, no fabricated date ambiguity.', header, review, canonical, schema_valid: schema.valid, semantic_valid: semantic.valid, save };
  })();

  const invalidDateExample = (() => {
    const header = resolveHeaders(b2026.raw, { 'header.date': '2-30-26' });
    const review = finalizeReview(header.issues);
    const canonical = toV131Canonical(b2026.resolved, review.status, header);
    const schema = validateWorkoutSchema(canonical, config.schema);
    const semantic = validateWorkoutSemanticsV13(canonical, { review, config });
    const save = evaluateSaveReadiness({ schema, semantic, review, canonical });
    return { _comment: 'Synthetic invalid calendar date 2-30-26. Literal preserved. date=null. Not save-ready.', header, review, canonical, schema_valid: schema.valid, save };
  })();

  const unreadableExample = (() => {
    const header = resolveHeaders(b2026.raw, { 'header.date': 'UNKNOWN' });
    const review = finalizeReview(header.issues);
    const canonical = toV131Canonical(b2026.resolved, review.status, header);
    const schema = validateWorkoutSchema(canonical, config.schema);
    const semantic = validateWorkoutSemanticsV13(canonical, { review, config });
    const save = evaluateSaveReadiness({ schema, semantic, review, canonical });
    return { _comment: 'Synthetic UNKNOWN date on a nonblank cell. No fabricated ambiguity detected_value.', header, review, canonical, schema_valid: schema.valid, save };
  })();

  const report = renderReport({
    frozen,
    headerScore,
    sheets,
    recognition,
    photoSaves: allPhotoSaves,
    injected: b2026Injected,
  });
  const results = {
    detector_version: DETECTOR_VERSION,
    detector_sha256: frozen.detector_sha256,
    detect_py_sha256: frozen.detect_py_sha256,
    schema_version: SCHEMA_VERSION,
    template_version_grammar: '^[ABC]-[0-9]+\\.[0-9]+(\\.[0-9]+)?$',
    two_digit_year_policy: 'YY → 2000+YY',
    numeric_freeze: frozen,
    header_prompts: HEADER_PROMPTS,
    header_crop_profile: HEADER_CROP_PROFILE,
    header_score: {
      by_field: headerScore.by_field,
      unique_sheets: headerScore.unique_sheets,
    },
    primary_sheets: saveRows,
    photo_saves: allPhotoSaves,
    granite_save_ready_photos: graniteSaveReadyPhotos,
    human_date_confirmed_b2026_save_ready: b2026Injected.save.save_ready,
    silent_numeric_errors: SILENT_GRANITE_ERRORS,
    artifacts: {
      report: path.join(POC10_ARTIFACT_DIR, 'REPORT.md'),
      results: path.join(POC10_ARTIFACT_DIR, 'results.json'),
    },
  };

  fs.writeFileSync(path.join(POC10_ARTIFACT_DIR, 'REPORT.md'), report);
  fs.writeFileSync(path.join(POC10_ARTIFACT_DIR, 'results.json'), JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(POC10_ARTIFACT_DIR, 'header-recognition-results.json'), JSON.stringify({ rows: recognition, score: headerScore }, null, 2));
  fs.writeFileSync(path.join(POC10_ARTIFACT_DIR, 'schema-migration-notes.md'), schemaMigrationNotes());
  fs.writeFileSync(path.join(POC10_ARTIFACT_DIR, 'save-readiness-results.json'), JSON.stringify({
    sheets: saveRows,
    photos: allPhotoSaves,
    granite_save_ready_photos: graniteSaveReadyPhotos,
    human_confirmed_date_b2026: {
      note: 'Same IMG_1311 frozen sets as production, date literal taken from human GT 9-20-26 rather than Granite. This is the review-confirmation path, not year inference.',
      save: b2026Injected.save,
      date: b2026Injected.header.date,
    },
    blocking_codes: [...BLOCKING_ISSUE_CODES],
  }, null, 2));
  fs.writeFileSync(path.join(POC10_ARTIFACT_DIR, 'complete-date-save-ready.json'), JSON.stringify({
    _comment: 'Granite primary IMG_1311 date crop failed (prose/math refusal). This file is B-2026-09-20 sets with the human-reviewed literal 9-20-26 applied through the parser → 2026-09-20. Optional BW/duration blank. No fabricated year. This is what review confirmation produces.',
    granite_primary_date_literal: b2026.header.date_literal,
    granite_primary_save_ready: b2026.save.save_ready,
    confirmed: {
      save: b2026Injected.save,
      header: {
        date_literal: b2026Injected.header.date_literal,
        date: b2026Injected.header.date,
        bodyweight_lb: b2026Injected.header.bodyweight_lb,
        duration_min: b2026Injected.header.duration_min,
      },
      canonical: b2026Injected.canonical,
      review: b2026Injected.review,
    },
  }, null, 2));
  fs.writeFileSync(path.join(POC10_ARTIFACT_DIR, 'partial-date-review-required.json'), JSON.stringify({
    _comment: 'A primary IMG_1319 date 9-20 is partial. Year not invented. Also B-original 9-19 is partial.',
    a: { save: aPrimary.save, header: aPrimary.header, canonical: aPrimary.canonical, review: aPrimary.review },
    b_original: { save: bOrig.save, header: bOrig.header },
  }, null, 2));
  fs.writeFileSync(path.join(POC10_ARTIFACT_DIR, 'blank-date-review-required.json'), JSON.stringify(blankDateExample, null, 2));
  fs.writeFileSync(path.join(POC10_ARTIFACT_DIR, 'optional-header-fields-blank.json'), JSON.stringify({
    _comment: 'B-2026-09-20 bodyweight and duration paper-blank → null, no BW/duration review issue.',
    bodyweight_lb: b2026.canonical.workout.bodyweight_lb,
    duration_min: b2026.canonical.workout.duration_min,
    header_issues: b2026.header.issues,
    save: b2026.save,
  }, null, 2));
  fs.writeFileSync(path.join(POC10_ARTIFACT_DIR, 'unreadable-header-example.json'), JSON.stringify(unreadableExample, null, 2));
  fs.writeFileSync(path.join(POC10_ARTIFACT_DIR, 'invalid-date-example.json'), JSON.stringify(invalidDateExample, null, 2));

  return { ...results, report_markdown: report, report: results.artifacts.report };
}
