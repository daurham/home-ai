import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DETECT_PY, DETECTOR_CONFIG_PATH } from './poc7/index.js';
import { FROZEN_DETECTOR_SHA256, sha256File, snapshotFrozenConfig } from './poc7b.js';
import {
  DETECT_PY_SHA256,
  POC8_ARTIFACT_DIR,
  VLM_PROMPT,
} from './poc8.js';
import { POC8B_ARTIFACT_DIR, POC8B_MODEL, loadPoc8Membership } from './poc8b.js';
import {
  CONFIDENCE_POLICY,
  GENERATION_SETTINGS,
  POC8C_ARTIFACT_DIR,
  evaluatePolicy,
  gateMajority,
  gateUnanimous,
  loadPoc8bRows,
  policyOutputs,
  proposeObservation,
} from './poc8c.js';

describe('POC #8C freeze', () => {
  it('does not change the frozen poc7-a1c detector, mappings, or #8/#8B artifacts', () => {
    const snap = snapshotFrozenConfig();
    assert.equal(sha256File(DETECTOR_CONFIG_PATH), FROZEN_DETECTOR_SHA256);
    assert.equal(snap.detector_sha256, FROZEN_DETECTOR_SHA256);
    assert.equal(sha256File(DETECT_PY), DETECT_PY_SHA256);
    assert.equal(loadPoc8Membership().samples.length, 519);
    assert.equal(loadPoc8bRows().filter((r) => r.clean === r.expected).length, 502);
    assert.equal(fs.existsSync(path.join(POC8_ARTIFACT_DIR, 'REPORT.md')), true);
    assert.equal(fs.existsSync(path.join(POC8B_ARTIFACT_DIR, 'REPORT.md')), true);
    assert.equal(POC8B_MODEL, 'granite3.2-vision:2b');
    assert.equal(GENERATION_SETTINGS.temperature, 0);
    assert.equal(GENERATION_SETTINGS.stream, false);
    assert.equal(GENERATION_SETTINGS.prompt, VLM_PROMPT);
    assert.equal(POC8C_ARTIFACT_DIR.endsWith(`${path.sep}poc8c`), true);
  });
});

describe('POC #8C gate (no ground truth in the policy)', () => {
  it('auto-accepts only unanimous numeric agreement', () => {
    const gate = gateUnanimous(['95', '95', '95']);
    assert.equal(gate.state, 'AUTO_ACCEPT');
    assert.equal(gate.value, '95');
    assert.equal(gate.agreement_count, 3);
    assert.equal(gate.unknown_count, 0);
    assert.deepEqual(gate.distinct_outputs, ['95']);
  });

  it('sends disagreements to review without majority-voting a correction', () => {
    const gate = gateUnanimous(['95', '45', '95']);
    assert.equal(gate.state, 'REVIEW_REQUIRED');
    assert.equal(gate.value, null);
    assert.equal(gate.reason, 'disagreement');
    assert.equal(gate.agreement_count, 2);
    assert.deepEqual(gate.outputs, ['95', '45', '95']);
    const majority = gateMajority(['95', '45', '95']);
    assert.equal(majority.state, 'AUTO_ACCEPT');
    assert.equal(majority.value, '95');
  });

  it('sends any UNKNOWN to review even if the other runs agree', () => {
    const allUnknown = gateUnanimous(['UNKNOWN', 'UNKNOWN', 'UNKNOWN']);
    assert.equal(allUnknown.state, 'REVIEW_REQUIRED');
    assert.equal(allUnknown.value, null);
    const mixed = gateUnanimous(['40', 'UNKNOWN', '40']);
    assert.equal(mixed.state, 'REVIEW_REQUIRED');
    assert.equal(mixed.value, null);
    assert.equal(mixed.reason, 'unknown');
  });

  it('never reads expected values — scoring is a separate function', () => {
    const src = fs.readFileSync(new URL('./poc8c.js', import.meta.url), 'utf8');
    const start = src.indexOf('export function gateUnanimous');
    const end = src.indexOf('export function gateMajority');
    const code = src.slice(start, end).replace(/\/\*\*[\s\S]*?\*\//g, '');
    assert.equal(/\bexpected\b/.test(code), false);
    assert.equal(/\bgroundTruth\b/.test(code), false);
    assert.equal(/\breps should\b/.test(code), false);
    const rows = [
      { sample_id: 'a', expected: '95', clean: '45' },
      { sample_id: 'b', expected: '12', clean: '12' },
      { sample_id: 'c', expected: '50', clean: 'UNKNOWN' },
    ];
    const policy = evaluatePolicy(rows, (r) => [r.clean, r.clean, r.clean], { name: 'test' });
    assert.equal(policy.auto_accepted.count, 2);
    assert.equal(policy.auto_accepted.wrong, 1);
    assert.equal(policy.auto_accepted.correct, 1);
    assert.equal(policy.review_required.unknowns_caught, 1);
    assert.equal(policy.error_capture.routed_to_review, 1);
    assert.equal(policy.false_review.unnecessarily_reviewed, 0);
  });

  it('proposes observation metadata without canonical workout JSON', () => {
    const auto = proposeObservation({
      field_id: 'A02.S1.load',
      field_kind: 'load',
      original: '95',
      gray: '95',
      contrast: '95',
      gate: gateUnanimous(['95', '95', '95']),
    });
    assert.equal(auto.state, 'AUTO_ACCEPT');
    assert.equal(auto.value, 95);
    assert.equal(auto.field_kind, 'load');
    assert.equal(auto.recognition.agreement, 1);
    assert.equal(auto.recognition.confidence_policy, CONFIDENCE_POLICY);
    assert.deepEqual(auto.recognition.outputs, { original: '95', gray: '95', contrast: '95' });
    const review = proposeObservation({
      field_id: 'A02.S1.load',
      field_kind: 'load',
      original: '95',
      gray: '45',
      contrast: '95',
      gate: gateUnanimous(['95', '45', '95']),
    });
    assert.equal(review.state, 'REVIEW_REQUIRED');
    assert.equal(review.value, null);
    assert.equal(review.recognition.outputs.gray, '45');
  });

  it('treats original+gray pairwise agreement as a predefined comparison, not a 2-of-3 correction', () => {
    const row = { original: '45', gray: '95', contrast: '95', expected: '95', clean: '45' };
    assert.deepEqual(policyOutputs(row, 'B'), ['45', '95', '95']);
    const strict = gateUnanimous(policyOutputs(row, 'B'));
    assert.equal(strict.state, 'REVIEW_REQUIRED');
    assert.equal(strict.value, null);
    const og = gateUnanimous(policyOutputs(row, 'C'));
    assert.equal(og.state, 'REVIEW_REQUIRED');
  });
});
