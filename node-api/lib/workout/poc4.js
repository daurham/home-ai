import fs from 'node:fs';
import { loadWorkoutConfig, ollamaModel } from './config.js';
import { transcribePoc3 } from './poc3.js';
import { scoreRawTranscription } from './scoreRaw.js';
import {
  listOllamaModels,
  ollamaLoadedModels,
  showOllamaModel,
  unloadOllamaModel,
} from './ollama.js';
import { CANDIDATES, REJECTED, recommendedFirstWave, recommendedDownloadGb } from './poc4Candidates.js';

export async function transcribePoc4({
  imageBuffer,
  model,
  env = process.env,
  post,
  get,
  extractWhole,
  sampleMemory = readHostMemory,
  unloadOthers = true,
} = {}) {
  const usedModel = model || ollamaModel(env);
  if (unloadOthers) {
    await unloadLoadedModels({ except: usedModel, env, get, post });
  }
  const memBefore = sampleMemory();
  const loadedBefore = await safeLoaded({ env, get });
  const samples = [];
  const timer = setInterval(() => {
    samples.push(sampleMemory());
  }, 2000);

  let result;
  try {
    result = await transcribePoc3({
      imageBuffer,
      model: usedModel,
      env,
      post,
      extractWhole,
    });
  } finally {
    clearInterval(timer);
  }

  const loadedAfter = await safeLoaded({ env, get });
  const memAfter = sampleMemory();
  const score = scoreRawTranscription(result.rawTranscription);
  const availableSamples = [memBefore, ...samples, memAfter]
    .map((row) => row.memAvailableKb)
    .filter((n) => Number.isFinite(n));
  const swapSamples = [memBefore, ...samples, memAfter]
    .map((row) => row.swapFreeKb)
    .filter((n) => Number.isFinite(n));

  return {
    ok: result.ok,
    poc: 4,
    variant: 'whole-page',
    model: result.model || usedModel,
    requestedModel: usedModel,
    elapsed_ms: result.elapsed_ms,
    calls: result.calls,
    promptUsedPack: result.promptUsedPack,
    raw: result.raw,
    rawTranscription: result.rawTranscription,
    workout: result.workout,
    validation: result.validation,
    canonicalExactMatch: Boolean(result.benchmark?.exactMatch),
    schemaValid: Boolean(result.validation?.schemaErrors?.length === 0) && Boolean(result.workout),
    semanticValid: Boolean(result.validation?.semanticErrors?.length === 0) && Boolean(result.workout),
    score,
    memory: {
      host_mem_available_kb_before: memBefore.memAvailableKb,
      host_mem_available_kb_after: memAfter.memAvailableKb,
      host_mem_available_kb_min: availableSamples.length ? Math.min(...availableSamples) : null,
      host_swap_free_kb_min: swapSamples.length ? Math.min(...swapSamples) : null,
      ollama_loaded_bytes_before: loadedBytes(loadedBefore),
      ollama_loaded_bytes_after: loadedBytes(loadedAfter),
      ollama_ps_after: loadedAfter,
      note: 'Approximate. /api/ps size is Ollama-reported loaded weights; host MemAvailable min is the lowest observed during the run.',
    },
    parts: result.parts,
  };
}

export function formatShootoutReport(result, meta = {}) {
  const score = result.score || scoreRawTranscription(result.rawTranscription);
  const validation = result.validation || {};
  const schemaValid = validation.schemaErrors ? validation.schemaErrors.length === 0 && Boolean(result.workout) : Boolean(validation.valid);
  const semanticValid = validation.semanticErrors ? validation.semanticErrors.length === 0 && Boolean(result.workout) : Boolean(validation.valid);
  return {
    poc: 4,
    model: result.model,
    exact_tag: result.requestedModel || result.model,
    model_download_size: meta.download_gb ?? null,
    latency_ms: result.elapsed_ms,
    raw_fields_correct: `${score.rawFieldsCorrect} / ${score.fieldCount}`,
    raw_accuracy_pct: score.rawAccuracyPct,
    canonical_exact_match: result.canonicalExactMatch ? 'yes' : 'no',
    schema_valid: schemaValid ? 'yes' : 'no',
    semantic_valid: semanticValid ? 'yes' : 'no',
    header: {
      date_correct: yn(score.header.date),
      bodyweight_correct: yn(score.header.bodyweight),
      effort_correct: yn(score.header.effort),
      pain_correct: yn(score.header.pain),
      note_correct: yn(score.header.note),
    },
    exercises: Object.fromEntries(
      Object.entries(score.exercises).map(([slot, ok]) => [slot, yn(ok)]),
    ),
    difficult_features: {
      bw_recognition: pf(score.difficult.bw_recognition),
      blank_weight_preservation: pf(score.difficult.blank_weight_preservation),
      no_cross_table_leakage: pf(score.difficult.no_cross_table_leakage),
      printed_vs_handwritten_distinction: pf(score.difficult.printed_vs_handwritten),
    },
    mismatches: score.mismatches,
    memory: result.memory || null,
    promptUsedPack: result.promptUsedPack,
  };
}

export async function preparePoc4Run({
  model,
  env = process.env,
  get,
  post,
  allowPull = false,
} = {}) {
  if (allowPull) {
    const error = new Error('POC #4 will not download models unless explicitly approved');
    error.status = 400;
    throw error;
  }
  const models = await listOllamaModels({ env, get });
  const found = models.find((entry) => entry.name === model || entry.model === model);
  if (!found) {
    const error = new Error(`Model ${model} is not installed. POC #4 does not auto-pull. Install it only after the candidate list is approved.`);
    error.status = 400;
    error.installed = models.map((entry) => entry.name);
    throw error;
  }
  let show = null;
  try {
    show = await showOllamaModel({ model, env, post });
  } catch {
    show = null;
  }
  return {
    installed: true,
    tag: found.name,
    size_bytes: found.size,
    details: found.details || show?.details || null,
  };
}

export async function unloadAfterPoc4({ model, env, post } = {}) {
  try {
    await unloadOllamaModel({ model, env, post });
  } catch {
    // Leave the model loaded rather than failing the scored run.
  }
}

export async function unloadLoadedModels({ except, env, get, post } = {}) {
  const loaded = await safeLoaded({ env, get });
  for (const entry of loaded) {
    const name = entry.name || entry.model;
    if (!name || name === except) continue;
    try {
      await unloadOllamaModel({ model: name, env, post });
    } catch {
      // Continue unloading the rest.
    }
  }
}

export function candidateCatalog() {
  return {
    poc: 4,
    hardware: {
      hostname: 'home-ai',
      cpu: 'AMD Ryzen 7 PRO 5850U',
      ram_policy: 'avoid >20–22GB runtime; do not use swap',
    },
    ollama_version_observed: '0.12.3',
    auto_download: false,
    recommended_first_wave: recommendedFirstWave(),
    recommended_download_gb: recommendedDownloadGb(),
    all_candidates: CANDIDATES,
    rejected: REJECTED,
  };
}

export function readHostMemory() {
  try {
    const text = fs.readFileSync('/proc/meminfo', 'utf8');
    const available = text.match(/^MemAvailable:\s+(\d+)/m);
    const total = text.match(/^MemTotal:\s+(\d+)/m);
    const swapFree = text.match(/^SwapFree:\s+(\d+)/m);
    return {
      memAvailableKb: available ? Number(available[1]) : null,
      memTotalKb: total ? Number(total[1]) : null,
      swapFreeKb: swapFree ? Number(swapFree[1]) : null,
    };
  } catch {
    return { memAvailableKb: null, memTotalKb: null, swapFreeKb: null };
  }
}

async function safeLoaded({ env, get }) {
  try {
    return await ollamaLoadedModels({ env, get });
  } catch {
    return [];
  }
}

function loadedBytes(models) {
  return (models || []).reduce((sum, model) => sum + (Number(model.size) || 0), 0);
}

function yn(value) {
  return value ? 'yes' : 'no';
}

function pf(value) {
  return value ? 'pass' : 'fail';
}

export function fixtureImageBuffer() {
  return fs.readFileSync(loadWorkoutConfig().fixtureImagePath);
}
