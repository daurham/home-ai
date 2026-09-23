import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  candidateCatalog,
  fixtureImageBuffer,
  formatShootoutReport,
  preparePoc4Run,
  transcribePoc4,
  unloadAfterPoc4,
} from '../lib/workout/poc4.js';
import { CANDIDATES } from '../lib/workout/poc4Candidates.js';
import { listOllamaModels } from '../lib/workout/ollama.js';
import { ollamaModel } from '../lib/workout/config.js';

const args = process.argv.slice(2);
const outPath = args.find((arg) => arg.endsWith('.json')) || '/tmp/poc4-shootout.json';
const listOnly = args.includes('--list') || args.length === 0 || (args.length === 1 && args[0].endsWith('.json'));
const modelArg = args.find((arg) => arg !== '--list' && arg !== '--unload' && !arg.endsWith('.json'));

if (listOnly && !modelArg) {
  let installed = [];
  try {
    installed = await listOllamaModels();
  } catch (error) {
    console.error(`Could not list Ollama models: ${error.message}`);
  }
  const catalog = candidateCatalog();
  const report = {
    ...catalog,
    installed: installed.map((entry) => ({
      name: entry.name,
      size_bytes: entry.size,
      parameter_size: entry.details?.parameter_size,
      quantization: entry.details?.quantization_level,
      family: entry.details?.family,
    })),
    stop: 'No models were downloaded. Approve the first-wave tags before running a live shootout.',
  };
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    outPath,
    ollama_version_observed: catalog.ollama_version_observed,
    recommended_first_wave: catalog.recommended_first_wave.map((c) => c.tag),
    recommended_download_gb: catalog.recommended_download_gb,
    installed: report.installed.map((row) => row.name),
    auto_download: false,
  }, null, 2));
  process.exit(0);
}

const model = modelArg || ollamaModel();
console.error(`POC #4 single-run model=${model} (no auto-pull; unload after)`);

let meta;
try {
  meta = await preparePoc4Run({ model, allowPull: false });
} catch (error) {
  const failed = {
    poc: 4,
    exact_tag: model,
    error: error.message,
    raw_fields_correct: '0 / 45',
    raw_accuracy_pct: 0,
    canonical_exact_match: 'no',
    schema_valid: 'no',
    semantic_valid: 'no',
  };
  fs.writeFileSync(outPath, JSON.stringify(failed, null, 2));
  console.log(JSON.stringify(failed, null, 2));
  process.exit(1);
}

function stopOllamaCli(tag) {
  const stop = spawnSync('ollama', ['stop', tag], {
    env: { ...process.env, OLLAMA_HOST: process.env.OLLAMA_HOST || '127.0.0.1:11434' },
    encoding: 'utf8',
    timeout: 30000,
  });
  if (stop.status !== 0 && stop.stderr) {
    console.error(`ollama stop ${tag}: ${stop.stderr.trim()}`);
  }
}

const imageBuffer = fixtureImageBuffer();
let result;
try {
  result = await transcribePoc4({ imageBuffer, model });
} catch (error) {
  await unloadAfterPoc4({ model });
  stopOllamaCli(model);
  const failed = {
    poc: 4,
    exact_tag: model,
    model_download_size: meta.size_bytes ? Number((meta.size_bytes / 1e9).toFixed(1)) : null,
    installed_size_bytes: meta.size_bytes,
    error: error.message,
    raw_fields_correct: '0 / 45',
    raw_accuracy_pct: 0,
    canonical_exact_match: 'no',
    schema_valid: 'no',
    semantic_valid: 'no',
    mismatches: [{ path: '(model call)', expected: 'valid frozen raw JSON', actual: error.message }],
  };
  fs.writeFileSync(outPath, JSON.stringify(failed, null, 2));
  console.log(JSON.stringify(failed, null, 2));
  process.exit(1);
}
await unloadAfterPoc4({ model });
stopOllamaCli(model);

const candidate = CANDIDATES.find((row) => row.tag === model);
const report = formatShootoutReport(result, {
  download_gb: candidate?.download_gb ?? (meta.size_bytes ? Number((meta.size_bytes / 1e9).toFixed(1)) : null),
});
report.installed_size_bytes = meta.size_bytes;
report.rawTranscription = result.rawTranscription;
report.elapsed_ms = result.elapsed_ms;
report.memory = result.memory;
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (report.raw_accuracy_pct < 100 || report.canonical_exact_match !== 'yes') {
  process.exitCode = 1;
}
