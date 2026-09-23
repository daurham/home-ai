import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { ARTIFACT_DIR, FIXTURE_PHOTO } from './poc6/index.js';
import { BENCHMARK_TRUTH_PATH, DETECTOR_CONFIG_PATH } from './poc7/index.js';
import {
  FROZEN_DETECTOR_SHA256,
  POC7B_ARTIFACT_DIR,
  POC7B_FIXTURES_DIR,
  assertDetectorFrozen,
  discoverPoc7bPhotos,
  runOnePoc7bPhoto,
  sha256File,
  snapshotFrozenConfig,
} from './poc7b.js';

describe('POC #7B frozen detector', () => {
  it('keeps poc7-detector.json at the approved SHA256', () => {
    const snap = snapshotFrozenConfig();
    assert.equal(sha256File(DETECTOR_CONFIG_PATH), FROZEN_DETECTOR_SHA256);
    assert.equal(snap.detector_sha256, FROZEN_DETECTOR_SHA256);
    assertDetectorFrozen(snap);
  });

  it('reuses the existing POC #7 sheet truth rather than per-photo answers', () => {
    assert.equal(BENCHMARK_TRUTH_PATH.endsWith('poc7-benchmark-truth.json'), true);
    const truth = JSON.parse(fs.readFileSync(BENCHMARK_TRUTH_PATH, 'utf8'));
    assert.equal(Object.keys(truth.checkboxes).length, 27);
    assert.equal(Object.keys(truth.fields).length, 45);
    assert.equal(snapTruthPath(), BENCHMARK_TRUTH_PATH);
  });

  it('discovers the six out-of-sample photographs', () => {
    const photos = discoverPoc7bPhotos();
    assert.equal(photos.length, 6);
    const names = photos.map((p) => path.basename(p));
    assert.deepEqual(names, [
      'IMG_1305.jpeg',
      'IMG_1306.jpeg',
      'IMG_1307.jpeg',
      'IMG_1308.jpeg',
      'IMG_1309.jpeg',
      'IMG_1310.jpeg',
    ]);
    assert.equal(POC7B_FIXTURES_DIR.includes('fixtures/poc7b'), true);
    assert.equal(POC7B_ARTIFACT_DIR.startsWith(ARTIFACT_DIR), true);
    assert.equal(POC7B_ARTIFACT_DIR.endsWith(`${path.sep}poc7b`) || POC7B_ARTIFACT_DIR.endsWith('/poc7b'), true);
  });

  it('records a registration failure without guessing corners or writing POC #6 artifacts', async () => {
    const beforeRectified = fs.statSync(path.join(ARTIFACT_DIR, 'poc6-rectified.png')).mtimeMs;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'poc7b-missing-'));
    const cropped = path.join(tmp, 'missing.jpg');
    await sharp(FIXTURE_PHOTO).extract({ left: 0, top: 0, width: 1152, height: 900 }).jpeg().toFile(cropped);
    const result = await runOnePoc7bPhoto({ imagePath: cropped, outDir: tmp });
    assert.equal(result.registration.status, 'FAIL');
    assert.equal(result.detection, null);
    assert.equal(result.score, null);
    assert.equal(fs.existsSync(path.join(tmp, 'registration-debug.png')), true);
    const afterRectified = fs.statSync(path.join(ARTIFACT_DIR, 'poc6-rectified.png')).mtimeMs;
    assert.equal(afterRectified, beforeRectified);
  });
});

function snapTruthPath() {
  return snapshotFrozenConfig().truth_path;
}
