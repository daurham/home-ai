import { loadWorkoutConfig, ollamaModel } from './config.js';
import { parseModelJson } from './parseModelJson.js';
import { validateWorkoutSchema } from './schemaValidator.js';
import { validateWorkoutSemantics } from './semanticValidator.js';
import { generateWorkoutJson } from './ollama.js';

export async function transcribeWorkoutSheet({
  imageBuffer,
  model,
  env = process.env,
  generate = generateWorkoutJson,
} = {}) {
  if (!imageBuffer || !Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    const error = new Error('image is required');
    error.status = 400;
    throw error;
  }

  const config = loadWorkoutConfig();
  const usedModel = model || ollamaModel(env);
  const started = Date.now();
  const ollama = await generate({
    imageBuffer,
    model: usedModel,
    schema: config.schema,
    env,
  });
  const elapsed_ms = Date.now() - started;
  const parsed = parseModelJson(ollama.raw);

  const schema = parsed.ok
    ? validateWorkoutSchema(parsed.value, config.schema)
    : { valid: false, schemaErrors: [{ instancePath: '/', message: parsed.error, keyword: 'parse' }] };
  const semantic = parsed.ok
    ? validateWorkoutSemantics(parsed.value, config)
    : { valid: false, semanticErrors: [], warnings: [] };

  const warnings = [...(semantic.warnings || [])];
  if (parsed.ok && parsed.value?.transcription_status === 'VALID' && (!schema.valid || !semantic.valid)) {
    warnings.push({
      path: '/transcription_status',
      message: 'Model set transcription_status=VALID but schema or semantic validation failed',
    });
  }

  const validation = {
    valid: Boolean(parsed.ok && schema.valid && semantic.valid),
    schemaErrors: schema.schemaErrors,
    semanticErrors: semantic.semanticErrors,
    warnings,
  };

  return {
    ok: true,
    model: ollama.model || usedModel,
    elapsed_ms,
    raw: ollama.raw,
    workout: parsed.ok ? parsed.value : null,
    validation,
    formatMode: ollama.formatMode,
  };
}
