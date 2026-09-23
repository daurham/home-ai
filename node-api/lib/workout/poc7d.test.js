import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ARTIFACT_DIR } from './poc6/index.js';
import { DETECTOR_CONFIG_PATH } from './poc7/index.js';
import { FROZEN_DETECTOR_SHA256, PREVIOUS_FROZEN_DETECTOR_SHA256, sha256File, snapshotFrozenConfig } from './poc7b.js';

const POC7D_DIR = path.join(ARTIFACT_DIR, 'poc7d');
const RESULTS_PATH = path.join(POC7D_DIR, 'results.json');
const REPORT_PATH = path.join(POC7D_DIR, 'REPORT.md');

describe('POC #7D ablation freeze', () => {
  it('does not change the frozen detector config', () => {
    const snap = snapshotFrozenConfig();
    assert.equal(sha256File(DETECTOR_CONFIG_PATH), FROZEN_DETECTOR_SHA256);
    assert.equal(snap.detector_sha256, FROZEN_DETECTOR_SHA256);
  });

  it('writes ablation results without promoting a production config', () => {
    assert.equal(fs.existsSync(RESULTS_PATH), true, 'run npm run poc7d first');
    assert.equal(fs.existsSync(REPORT_PATH), true, 'run npm run poc7d first');
    const results = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf8'));
    assert.equal(results.frozen_sha256, PREVIOUS_FROZEN_DETECTOR_SHA256);
    assert.equal(results.detector_sha256_after, PREVIOUS_FROZEN_DETECTOR_SHA256);
    assert.equal(Array.isArray(results.variants), true);
    assert.equal(results.variants.some((v) => v.id === 'A0'), true);
    assert.equal(results.variants.some((v) => v.id === 'A1'), true);
    const cfg = fs.readFileSync(DETECTOR_CONFIG_PATH, 'utf8');
    assert.equal(cfg.includes('"user_open_kernel_px": 3'), true);
    assert.equal(cfg.includes('"template_dilate_iterations": 2'), true);
  });
});
