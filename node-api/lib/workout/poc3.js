import { ollamaModel } from './config.js';
import { normalizeRawTranscription } from './normalizeRaw.js';
import { validateWorkoutSchema } from './schemaValidator.js';
import { validateWorkoutSemantics } from './semanticValidator.js';
import { compareFixture } from './compareFixture.js';
import { loadWorkoutConfig } from './config.js';
import { extractWholePagePoc3 } from './extractRaw.js';
import { mentionsForbiddenDomain, WHOLE_PAGE_PROMPT_POC3 } from './extractPrompts.js';
import {
  EXPECTED_RAW_ROUTINE_B_LITERAL,
  HEADER_FIELDS,
  SLOT_IDS,
  SLOT_LAYOUT,
  isUnreadableToken,
} from './rawSchema.js';
import { compareRawRuns, semanticCellEqual } from './rawCompare.js';
import { benchmarkSlice } from './poc2.js';

export async function transcribePoc3({
  imageBuffer,
  model,
  env = process.env,
  post,
  extractWhole = extractWholePagePoc3,
} = {}) {
  if (!imageBuffer || !Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    const error = new Error('image is required');
    error.status = 400;
    throw error;
  }

  const usedModel = model || ollamaModel(env);
  const extracted = await extractWhole({
    imageBuffer,
    model: usedModel,
    env,
    post,
  });

  const config = loadWorkoutConfig();
  const rawForNormalizer = extracted.raw ? coerceLiteralRaw(extracted.raw) : null;
  const workout = rawForNormalizer ? normalizeRawTranscription(rawForNormalizer, config) : null;
  const schema = workout
    ? validateWorkoutSchema(workout, config.schema)
    : { valid: false, schemaErrors: [{ instancePath: '/', message: extracted.parseError || 'no raw transcription', keyword: 'parse' }] };
  const semantic = workout
    ? validateWorkoutSemantics(workout, config)
    : { valid: false, semanticErrors: [], warnings: [] };
  const comparison = workout
    ? compareFixture(config.expectedRoutineB, workout)
    : null;

  return {
    ok: true,
    poc: 3,
    variant: extracted.variant || 'whole-page-poc3',
    model: extracted.model || usedModel,
    elapsed_ms: extracted.elapsed_ms,
    calls: extracted.calls,
    raw: extracted.rawText,
    rawTranscription: extracted.raw,
    workout,
    validation: {
      valid: Boolean(workout && schema.valid && semantic.valid),
      schemaErrors: schema.schemaErrors,
      semanticErrors: semantic.semanticErrors,
      warnings: [],
    },
    benchmark: {
      ...benchmarkSlice(extracted.raw, workout, comparison),
      b03_exact: b03LiteralExact(extracted.raw),
    },
    promptUsedPack: mentionsForbiddenDomain(extracted.prompt)
      || mentionsForbiddenDomain(extracted.rawText)
      || mentionsForbiddenDomain(WHOLE_PAGE_PROMPT_POC3),
    parts: extracted.parts,
  };
}

export async function runPoc3Reliability({
  imageBuffer,
  runs = 3,
  model,
  env = process.env,
  post,
  extractWhole,
  onRun,
} = {}) {
  const results = [];
  for (let i = 0; i < runs; i += 1) {
    const runNumber = i + 1;
    try {
      const result = await transcribePoc3({
        imageBuffer,
        model,
        env,
        post,
        extractWhole,
      });
      const entry = {
        run: runNumber,
        ok: true,
        elapsed_ms: result.elapsed_ms,
        model: result.model,
        promptUsedPack: result.promptUsedPack,
        rawTranscription: result.rawTranscription,
        workout: result.workout,
        validation: result.validation,
        exactMatch: Boolean(result.benchmark?.exactMatch),
        b03_exact: Boolean(result.benchmark?.b03_exact),
        highSeverityMismatches: result.benchmark?.highSeverityMismatches || [],
        lowSeverityMismatches: result.benchmark?.lowSeverityMismatches || [],
        parseError: null,
      };
      results.push(entry);
      if (onRun) onRun(entry);
    } catch (error) {
      const entry = {
        run: runNumber,
        ok: false,
        elapsed_ms: null,
        model: model || ollamaModel(env),
        promptUsedPack: false,
        rawTranscription: null,
        workout: null,
        validation: { valid: false, schemaErrors: [{ message: error.message }], semanticErrors: [], warnings: [] },
        exactMatch: false,
        b03_exact: false,
        highSeverityMismatches: [],
        lowSeverityMismatches: [],
        parseError: error.message,
      };
      results.push(entry);
      if (onRun) onRun(entry);
    }
  }

  const comparison = compareRawRuns(
    results.map((result) => result.rawTranscription),
    EXPECTED_RAW_ROUTINE_B_LITERAL,
  );

  return {
    poc: 3,
    variant: 'whole-page',
    model: results.find((result) => result.model)?.model || ollamaModel(env),
    runs: results.length,
    canonicalExactMatchCount: results.filter((result) => result.exactMatch).length,
    schemaValidCount: results.filter((result) => result.validation?.valid).length,
    b03ExactCount: results.filter((result) => result.b03_exact).length,
    elapsed_ms: results.reduce((sum, result) => sum + (result.elapsed_ms || 0), 0),
    comparison,
    results,
  };
}

export function coerceLiteralRaw(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  const out = {};
  for (const field of HEADER_FIELDS) {
    out[field] = coerceLiteralValue(raw[field]);
  }
  for (const slotId of SLOT_IDS) {
    const layout = SLOT_LAYOUT[slotId];
    const rows = Array.isArray(raw[slotId]) ? raw[slotId] : [];
    out[slotId] = rows.map((row) => {
      if (!row || typeof row !== 'object') return row;
      const next = { ...row };
      for (const field of layout.fields) {
        next[field] = coerceLiteralValue(row[field]);
      }
      return next;
    });
  }
  return out;
}

function coerceLiteralValue(value) {
  if (value == null) return null;
  if (typeof value === 'number') return value;
  const text = String(value).trim();
  if (!text || isUnreadableToken(text)) return null;
  return text;
}

export function b03LiteralExact(raw) {
  const expected = EXPECTED_RAW_ROUTINE_B_LITERAL.B03;
  const actual = Array.isArray(raw?.B03) ? raw.B03 : [];
  if (actual.length !== expected.length) return false;
  return expected.every((row, index) => (
    semanticCellEqual(row.weight, actual[index]?.weight)
    && semanticCellEqual(row.reps, actual[index]?.reps)
  ));
}
