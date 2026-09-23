import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ARTIFACT_DIR, V131_CONFIG_DIR } from '../lib/workout/poc6/index.js';
import { FROZEN_DETECTOR_SHA256, sha256File, snapshotFrozenConfig } from '../lib/workout/poc7b.js';
import { DETECTOR_CONFIG_PATH } from '../lib/workout/poc7/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ABLATE_PY = path.resolve(HERE, '../lib/workout/poc7d/ablate.py');
const OUT_DIR = path.join(ARTIFACT_DIR, 'poc7d');

const before = snapshotFrozenConfig();
if (before.detector_sha256 !== FROZEN_DETECTOR_SHA256) {
  throw new Error('detector is not frozen');
}

const proc = spawnSync(process.env.POC7_PYTHON || 'python3', [ABLATE_PY], {
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
});
if (proc.status !== 0) {
  console.error(proc.stderr || proc.stdout);
  process.exit(proc.status || 1);
}
console.log(proc.stderr);
console.log(proc.stdout);

const after = sha256File(DETECTOR_CONFIG_PATH);
if (after !== FROZEN_DETECTOR_SHA256) {
  throw new Error('ablation mutated detector config');
}

const resultsPath = path.join(OUT_DIR, 'results.json');
const results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
results.detector_sha256_after = after;
fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));

console.log(JSON.stringify({
  detector_sha256_before: before.detector_sha256,
  detector_sha256_after: after,
  out: path.join(V131_CONFIG_DIR, 'artifacts', 'poc7d'),
  variants: results.variants.map((v) => v.id),
  safe: results.selection.safe_candidates,
  winner: results.selection.winner_on_this_set,
  keep_frozen: results.selection.keep_frozen,
}, null, 2));
