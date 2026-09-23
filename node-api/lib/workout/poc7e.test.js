import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ARTIFACT_DIR } from './poc6/index.js';
import { DETECTOR_CONFIG_PATH } from './poc7/index.js';
import { FROZEN_DETECTOR_SHA256, PREVIOUS_FROZEN_DETECTOR_SHA256, sha256File, snapshotFrozenConfig } from './poc7b.js';

const POC7E_DIR = path.join(ARTIFACT_DIR, 'poc7e');
const RESULTS_PATH = path.join(POC7E_DIR, 'results.json');
const REPORT_PATH = path.join(POC7E_DIR, 'REPORT.md');

describe('POC #7E A1c confirmation freeze', () => {
  it('does not change the frozen detector config', () => {
    const snap = snapshotFrozenConfig();
    assert.equal(sha256File(DETECTOR_CONFIG_PATH), FROZEN_DETECTOR_SHA256);
    assert.equal(snap.detector_sha256, FROZEN_DETECTOR_SHA256);
  });

  it('keeps the pre-promotion confirmation artifact SHA distinct from the A1c freeze', () => {
    assert.equal(fs.existsSync(RESULTS_PATH), true, 'run npm run poc7e first');
    assert.equal(fs.existsSync(REPORT_PATH), true, 'run npm run poc7e first');
    const results = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf8'));
    assert.equal(results.frozen_sha256, PREVIOUS_FROZEN_DETECTOR_SHA256);
    assert.equal(typeof results.promotion.recommend, 'boolean');
    const cfg = fs.readFileSync(DETECTOR_CONFIG_PATH, 'utf8');
    assert.equal(cfg.includes('"user_open_kernel_px": 3'), true);
    assert.equal(cfg.includes('"checkbox_user_open_kernel_px": 0'), true);
    assert.equal(cfg.includes('"text_user_open_kernel_px": 3'), true);
  });
});
