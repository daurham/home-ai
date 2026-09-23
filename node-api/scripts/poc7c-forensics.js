import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { ARTIFACT_DIR, FIXTURE_PHOTO, V131_CONFIG_DIR } from '../lib/workout/poc6/index.js';
import { FROZEN_DETECTOR_SHA256, POC7B_FIXTURES_DIR, sha256File, snapshotFrozenConfig } from '../lib/workout/poc7b.js';
import { DETECTOR_CONFIG_PATH } from '../lib/workout/poc7/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FORENSICS_PY = path.resolve(HERE, '../lib/workout/poc7c/forensics.py');
const OUT_DIR = path.join(ARTIFACT_DIR, 'poc7c');
const ORIENTED_DIR = path.join(OUT_DIR, '_oriented');

const PHOTOS = [
  ['IMG_1305', path.join(POC7B_FIXTURES_DIR, 'IMG_1305.jpeg')],
  ['IMG_1306', path.join(POC7B_FIXTURES_DIR, 'IMG_1306.jpeg')],
  ['IMG_1307', path.join(POC7B_FIXTURES_DIR, 'IMG_1307.jpeg')],
  ['IMG_1308', path.join(POC7B_FIXTURES_DIR, 'IMG_1308.jpeg')],
  ['IMG_1309', path.join(POC7B_FIXTURES_DIR, 'IMG_1309.jpeg')],
  ['IMG_1310', path.join(POC7B_FIXTURES_DIR, 'IMG_1310.jpeg')],
  ['poc7-dev', FIXTURE_PHOTO],
];

const before = snapshotFrozenConfig();
if (before.detector_sha256 !== FROZEN_DETECTOR_SHA256) {
  throw new Error('detector is not frozen');
}

fs.mkdirSync(ORIENTED_DIR, { recursive: true });
for (const [slug, src] of PHOTOS) {
  const dest = path.join(ORIENTED_DIR, `${slug}.jpg`);
  await sharp(src).rotate().jpeg({ quality: 95 }).toFile(dest);
}

const proc = spawnSync(process.env.POC7_PYTHON || 'python3', [FORENSICS_PY], {
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
  throw new Error('forensics mutated detector config');
}
console.log(JSON.stringify({
  detector_sha256_before: before.detector_sha256,
  detector_sha256_after: after,
  out: path.join(V131_CONFIG_DIR, 'artifacts', 'poc7c'),
}, null, 2));
