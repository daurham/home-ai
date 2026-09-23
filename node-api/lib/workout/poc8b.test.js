import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DETECT_PY, DETECTOR_CONFIG_PATH } from './poc7/index.js';
import { FROZEN_DETECTOR_SHA256, sha256File, snapshotFrozenConfig } from './poc7b.js';
import {
  DETECT_PY_SHA256,
  VLM_PROMPT,
  loadJson,
  templatePathForId,
} from './poc8.js';
import {
  DECONTAMINATE_KINDS,
  POC8B_MODEL,
  POC8_GROUND_TRUTH_ARTIFACT,
  PRINTED_RULE_PX,
  assertCleanBoxSafe,
  classifyTransition,
  cleanExtractBox,
  leadingPrintedInk,
  leftNeighborField,
  loadPoc8Membership,
  validateCleanGeometry,
} from './poc8b.js';

describe('POC #8B freeze', () => {
  it('does not change the frozen poc7-a1c detector', () => {
    const snap = snapshotFrozenConfig();
    assert.equal(sha256File(DETECTOR_CONFIG_PATH), FROZEN_DETECTOR_SHA256);
    assert.equal(snap.detector_sha256, FROZEN_DETECTOR_SHA256);
    assert.equal(sha256File(DETECT_PY), DETECT_PY_SHA256);
  });

  it('reuses the frozen POC #8 519-sample membership and prompt', () => {
    const membership = loadPoc8Membership();
    assert.equal(membership.samples.length, 519);
    assert.equal(fs.existsSync(POC8_GROUND_TRUTH_ARTIFACT), true);
    assert.equal(membership.prompt, VLM_PROMPT);
    assert.equal(POC8B_MODEL, 'granite3.2-vision:2b');
    const ids = membership.samples.map((s) => s.sample_id);
    assert.equal(new Set(ids).size, 519);
  });
});

describe('POC #8B geometric decontamination', () => {
  it('excludes the BW checkbox from B reps without eating the writing box', () => {
    const template = loadJson(templatePathForId('B-1.3.1'));
    const reps = template.fields.find((f) => f.id === 'B01.S1.reps');
    const neighbor = leftNeighborField(template, reps);
    assert.equal(neighbor.id, 'B01.S1.BW');
    const box = cleanExtractBox(reps, template);
    assert.equal(box.decontaminated, true);
    assert.equal(box.left >= neighbor.px.x + neighbor.px.w, true);
    assert.equal(box.field_inset_left, PRINTED_RULE_PX);
    assert.equal(assertCleanBoxSafe(reps, box).length, 0);
    assert.equal(box.left > reps.px.x - 6, true);
  });

  it('keeps load cells on the control padded geometry', () => {
    const template = loadJson(templatePathForId('A-1.3.1'));
    const load = template.fields.find((f) => f.id === 'A02.S1.load');
    const box = cleanExtractBox(load, template);
    assert.equal(DECONTAMINATE_KINDS.has('load'), false);
    assert.equal(box.decontaminated, false);
    assert.equal(box.left, load.px.x - 6);
  });

  it('excludes L from R and BW from seconds using neighbor geometry', () => {
    const b = loadJson(templatePathForId('B-1.3.1'));
    const right = b.fields.find((f) => f.id === 'B05.S1.right');
    const left = leftNeighborField(b, right);
    assert.equal(left.id, 'B05.S1.left');
    const rightBox = cleanExtractBox(right, b);
    assert.equal(rightBox.left >= left.px.x + left.px.w, true);

    const a = loadJson(templatePathForId('A-1.3.1'));
    const seconds = a.fields.find((f) => f.id === 'A07.S1.seconds');
    const bw = leftNeighborField(a, seconds);
    assert.equal(bw.id, 'A07.S1.BW');
    const secBox = cleanExtractBox(seconds, a);
    assert.equal(secBox.decontaminated, true);
    assert.equal(secBox.left, seconds.px.x + PRINTED_RULE_PX);
  });

  it('rejects a geometry that would clip the writing area', () => {
    const field = { id: 'X.S1.reps', px: { x: 100, y: 10, w: 80, h: 40 } };
    const bad = {
      decontaminated: true,
      left: 150,
      width: 20,
      field_inset_left: 50,
    };
    const errors = assertCleanBoxSafe(field, bad);
    assert.equal(errors.length > 0, true);
  });

  it('passes the frozen 519-sample geometry check', () => {
    const check = validateCleanGeometry();
    assert.equal(check.ok, true, check.errors.join('; '));
  });

  it('classifies control/clean transitions and leading-1 contamination', () => {
    assert.equal(leadingPrintedInk('12', '112'), true);
    assert.equal(leadingPrintedInk('40', '410'), true);
    assert.equal(leadingPrintedInk('15', '115'), true);
    assert.equal(leadingPrintedInk('10', '110'), true);
    assert.equal(leadingPrintedInk('12', '12'), false);
    assert.equal(leadingPrintedInk('12', '18'), false);
    assert.equal(classifyTransition('12', '112', '12'), 'wrong→correct');
    assert.equal(classifyTransition('12', 'UNKNOWN', '12'), 'UNKNOWN→correct');
    assert.equal(classifyTransition('12', '12', '112'), 'correct→wrong');
    assert.equal(classifyTransition('12', '12', 'UNKNOWN'), 'correct→UNKNOWN');
    assert.equal(classifyTransition('12', '112', '115'), 'wrong→different wrong');
  });
});
