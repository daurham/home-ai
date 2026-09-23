import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ARTIFACT_DIR, V131_CONFIG_DIR, registerV131Photo } from '../lib/workout/poc6/index.js';
import { FROZEN_DETECTOR_SHA256, sha256File, snapshotFrozenConfig } from '../lib/workout/poc7b.js';
import { DETECTOR_CONFIG_PATH } from '../lib/workout/poc7/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIRM_PY = path.resolve(HERE, '../lib/workout/poc7e/confirm.py');
const FIXTURES = path.join(V131_CONFIG_DIR, 'fixtures', 'poc7e');
const OUT_DIR = path.join(ARTIFACT_DIR, 'poc7e');
const TRUTH = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'checkbox-truth.json'), 'utf8'));

const before = snapshotFrozenConfig();
if (before.detector_sha256 !== FROZEN_DETECTOR_SHA256) {
  throw new Error('detector is not frozen');
}

const registrationStatus = {};
for (const slug of TRUTH.photos) {
  const imagePath = path.join(FIXTURES, `${slug}.jpeg`);
  const outDir = path.join(OUT_DIR, 'photos', slug);
  fs.mkdirSync(outDir, { recursive: true });
  const registration = await registerV131Photo({ imagePath, outDir });
  const ok = Boolean(registration.ok && registration.all_four_required_detected);
  if (ok) {
    const src = path.join(outDir, 'poc6-rectified.png');
    fs.copyFileSync(src, path.join(outDir, 'rectified.png'));
  }
  fs.writeFileSync(path.join(outDir, 'registration.json'), JSON.stringify(registration, null, 2));
  registrationStatus[slug] = {
    ok,
    detected_ids: registration.detected_ids || [],
    error: registration.error || null,
  };
  console.error(`register ${slug} ${ok ? 'PASS' : 'FAIL'} ids=${(registration.detected_ids || []).join(',')}`);
}
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'registration-status.json'), JSON.stringify(registrationStatus, null, 2));

const proc = spawnSync(process.env.POC7_PYTHON || 'python3', [CONFIRM_PY], {
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
  throw new Error('confirmation mutated detector config');
}

const resultsPath = path.join(OUT_DIR, 'results.json');
const results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
results.detector_sha256_after = after;
fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));

console.log(JSON.stringify({
  detector_sha256_before: before.detector_sha256,
  detector_sha256_after: after,
  out: path.join(V131_CONFIG_DIR, 'artifacts', 'poc7e'),
  promote: results.promotion.recommend,
  blockers: results.promotion.blockers,
}, null, 2));
