import { ollamaModel } from './config.js';
import { normalizeRawTranscription } from './normalizeRaw.js';
import { validateWorkoutSchema } from './schemaValidator.js';
import { validateWorkoutSemantics } from './semanticValidator.js';
import { compareFixture } from './compareFixture.js';
import { loadWorkoutConfig } from './config.js';
import { extractCroppedRegions, extractWholePage } from './extractRaw.js';
import { mentionsForbiddenDomain } from './extractPrompts.js';

export async function transcribePoc2({
  imageBuffer,
  variant = 'whole-page',
  model,
  env = process.env,
  post,
  extractWhole = extractWholePage,
  extractCrops = extractCroppedRegions,
} = {}) {
  if (!imageBuffer || !Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    const error = new Error('image is required');
    error.status = 400;
    throw error;
  }

  const usedModel = model || ollamaModel(env);
  const extract = variant === 'crops' ? extractCrops : extractWhole;
  const extracted = await extract({
    imageBuffer,
    model: usedModel,
    env,
    post,
  });

  const config = loadWorkoutConfig();
  const workout = extracted.raw ? normalizeRawTranscription(extracted.raw, config) : null;
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
    poc: 2,
    variant: extracted.variant,
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
    benchmark: benchmarkSlice(extracted.raw, workout, comparison),
    promptUsedPack: mentionsForbiddenDomain(extracted.rawText) || mentionsForbiddenDomain(extracted.parts?.page?.raw),
    parts: extracted.parts,
  };
}

export function benchmarkSlice(raw, workout, comparison) {
  const b03 = Array.isArray(raw?.B03) ? raw.B03 : [];
  const expectedB03 = [
    { weight: 40, reps: 10 },
    { weight: 40, reps: 8 },
    { weight: 45, reps: 9 },
  ];
  const b03_exact = jsonEqual(b03, expectedB03);
  return {
    b03_exact,
    b03_actual: b03,
    exactMatch: comparison ? comparison.match : false,
    highSeverityMismatches: comparison?.highSeverity || [],
    lowSeverityMismatches: comparison?.lowSeverity || [],
    schemaValid: Boolean(workout),
  };
}

function jsonEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
