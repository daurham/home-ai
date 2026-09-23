import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DETECT_PY, DETECTOR_CONFIG_PATH } from './poc7/index.js';
import { FROZEN_DETECTOR_SHA256, sha256File, snapshotFrozenConfig } from './poc7b.js';
import { DETECT_PY_SHA256, POC8_ARTIFACT_DIR, parseNumericLiteral } from './poc8.js';
import { POC8B_ARTIFACT_DIR, POC8B_MODEL, loadPoc8Membership } from './poc8b.js';
import { POC8C_ARTIFACT_DIR, loadPoc8bRows } from './poc8c.js';
import {
  INDEPENDENT_MODEL_ID,
  POC8D_ARTIFACT_DIR,
  complementarityBucket,
  gateAgreement,
} from './poc8d.js';

describe('POC #8D freeze', () => {
  it('does not change the frozen detector, #8 membership, or #8B Granite score', () => {
    const snap = snapshotFrozenConfig();
    assert.equal(sha256File(DETECTOR_CONFIG_PATH), FROZEN_DETECTOR_SHA256);
    assert.equal(snap.detector_sha256, FROZEN_DETECTOR_SHA256);
    assert.equal(sha256File(DETECT_PY), DETECT_PY_SHA256);
    assert.equal(loadPoc8Membership().samples.length, 519);
    const rows = loadPoc8bRows();
    assert.equal(rows.length, 519);
    assert.equal(rows.filter((r) => r.clean === r.expected).length, 502);
    assert.equal(POC8B_MODEL, 'granite3.2-vision:2b');
    assert.equal(INDEPENDENT_MODEL_ID, 'microsoft/trocr-small-handwritten');
    assert.equal(fs.existsSync(path.join(POC8_ARTIFACT_DIR, 'REPORT.md')), true);
    assert.equal(fs.existsSync(path.join(POC8B_ARTIFACT_DIR, 'REPORT.md')), true);
    assert.equal(fs.existsSync(path.join(POC8C_ARTIFACT_DIR, 'REPORT.md')), true);
    assert.equal(POC8D_ARTIFACT_DIR.endsWith(`${path.sep}poc8d`), true);
  });
});

describe('POC #8D agreement gate (no ground truth in the policy)', () => {
  it('auto-accepts only when Granite and B are the same numeric literal', () => {
    const gate = gateAgreement('95', '95');
    assert.equal(gate.state, 'AUTO_ACCEPT');
    assert.equal(gate.value, '95');
  });

  it('reviews disagreement without substituting B even if B would be the paper value', () => {
    const gate = gateAgreement('45', '95');
    assert.equal(gate.state, 'REVIEW_REQUIRED');
    assert.equal(gate.value, null);
    const src = fs.readFileSync(new URL('./poc8d.js', import.meta.url), 'utf8');
    const start = src.indexOf('export function gateAgreement');
    const end = src.indexOf('export function complementarityBucket');
    const code = src.slice(start, end).replace(/\/\*\*[\s\S]*?\*\//g, '');
    assert.equal(/\bexpected\b/.test(code), false);
  });

  it('reviews UNKNOWN on either side', () => {
    assert.equal(gateAgreement('UNKNOWN', '50').state, 'REVIEW_REQUIRED');
    assert.equal(gateAgreement('50', 'UNKNOWN').state, 'REVIEW_REQUIRED');
    assert.equal(gateAgreement('UNKNOWN', 'UNKNOWN').state, 'REVIEW_REQUIRED');
  });

  it('parses B with the same conservative numeric literal contract', () => {
    assert.equal(parseNumericLiteral('95').value, '95');
    assert.equal(parseNumericLiteral('ninety five').value, 'UNKNOWN');
    assert.equal(parseNumericLiteral('8\n').value, '8');
  });

  it('classifies complementarity without resolving disagreements', () => {
    assert.equal(complementarityBucket('45', '95', '95'), 'granite_wrong_b_correct');
    assert.equal(complementarityBucket('6', '6', '8'), 'both_wrong_same');
    assert.equal(complementarityBucket('UNKNOWN', '50', '50'), 'granite_unknown_b_correct');
  });
});
