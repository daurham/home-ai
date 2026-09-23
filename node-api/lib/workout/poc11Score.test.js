import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DETECT_PY, DETECTOR_CONFIG_PATH } from './poc7/index.js';
import { FROZEN_DETECTOR_SHA256, sha256File } from './poc7b.js';
import { DETECT_PY_SHA256 } from './poc8.js';
import { loadPoc8bRows } from './poc8c.js';
import { POC11_ARTIFACT_DIR, POC11_BLIND_DIR } from './poc11.js';
import {
  EXPECTED_BLIND_SHA256,
  HUMAN_APPROVED_GT,
  POC11_GT_PATH,
  verifyBlindChecksum,
} from './poc11Score.js';

describe('POC #11 Phase 2/3 freeze', () => {
  it('keeps detector, historical Granite, and the Phase 1 blind checksum', () => {
    assert.equal(sha256File(DETECTOR_CONFIG_PATH), FROZEN_DETECTOR_SHA256);
    assert.equal(sha256File(DETECT_PY), DETECT_PY_SHA256);
    const rows = loadPoc8bRows();
    assert.equal(rows.length, 519);
    assert.equal(rows.filter((r) => r.clean === r.expected).length, 502);
    const check = verifyBlindChecksum();
    assert.equal(check.ok, true, JSON.stringify(check));
    assert.equal(check.fileHash, EXPECTED_BLIND_SHA256);
  });

  it('stores human paper GT separately from frozen resolved inheritance', () => {
    assert.equal(HUMAN_APPROVED_GT.sheets.length, 6);
    const c01s2 = HUMAN_APPROVED_GT.sheets[0].sets.find((s) => s.slot_id === 'C01' && s.set_number === 2);
    assert.equal(c01s2.load_paper, 'blank');
    assert.equal(c01s2.load, null);
    assert.equal(c01s2.bw, 'unchecked');
    assert.equal(c01s2.measurements.reps, 10);
    assert.equal(fs.existsSync(POC11_GT_PATH), true);
    const gt = JSON.parse(fs.readFileSync(POC11_GT_PATH, 'utf8'));
    const sheet = gt.sheets.find((s) => s.photo_id === 'IMG_1326');
    const paper = sheet.paper_sets.find((s) => s.slot_id === 'C01' && s.set_number === 2);
    const resolved = sheet.expected_resolved_sets.find((s) => s.slot_id === 'C01' && s.set_number === 2);
    assert.equal(paper.load_paper, 'blank');
    assert.equal(resolved.load_state, 'bodyweight');
    assert.equal(resolved.load_provenance.resolution, 'INHERITED');
    assert.equal(sheet.expected_date.iso, '2026-09-20');
  });

  it('does not infer missing years and records IMG_1331 as registration-only', () => {
    const scoredPath = path.join(POC11_ARTIFACT_DIR, 'scored-results.json');
    const silentPath = path.join(POC11_ARTIFACT_DIR, 'silent-errors.json');
    assert.equal(fs.existsSync(scoredPath), true);
    assert.equal(fs.existsSync(silentPath), true);
    const scored = JSON.parse(fs.readFileSync(scoredPath, 'utf8'));
    assert.equal(scored.date.missing_year_inference, 0);
    assert.equal(scored.assembly.incorrect_inheritance_total, 0);
    assert.equal(scored.registration.failures[0].photo_id, 'IMG_1331');
    const sha = fs.readFileSync(path.join(POC11_BLIND_DIR, 'blind-results.sha256'), 'utf8').trim();
    assert.equal(sha, EXPECTED_BLIND_SHA256);
    assert.equal(sha256File(path.join(POC11_BLIND_DIR, 'blind-results.json')), EXPECTED_BLIND_SHA256);
  });
});
