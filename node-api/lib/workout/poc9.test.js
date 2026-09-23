import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DETECT_PY, DETECTOR_CONFIG_PATH } from './poc7/index.js';
import { FROZEN_DETECTOR_SHA256, sha256File, snapshotFrozenConfig } from './poc7b.js';
import { DETECT_PY_SHA256 } from './poc8.js';
import { POC8B_MODEL, loadPoc8Membership } from './poc8b.js';
import { loadPoc8bRows } from './poc8c.js';
import {
  CROP_PROFILE,
  INTEGRITY_BOUNDS,
  ISSUE,
  PAPER,
  POC9_ARTIFACT_DIR,
  RECOGNITION,
  RECOGNIZER_ID,
  REVIEW_STATUS,
  assembleFromRaw,
  makeCheckboxObservation,
  makeNumericObservation,
  parseSetFieldId,
  syntheticRaw,
} from './poc9.js';

function numeric(fieldId, value) {
  return makeNumericObservation({
    fieldId,
    paperState: PAPER.NONBLANK,
    recognitionState: RECOGNITION.NUMERIC,
    recognizedValue: value,
  });
}

function blank(fieldId) {
  return makeNumericObservation({
    fieldId,
    paperState: PAPER.BLANK,
    recognitionState: RECOGNITION.NOT_RUN,
    recognizedValue: null,
  });
}

function unknown(fieldId) {
  return makeNumericObservation({
    fieldId,
    paperState: PAPER.NONBLANK,
    recognitionState: RECOGNITION.UNKNOWN,
    recognizedValue: null,
  });
}

function bw(fieldId, checked) {
  return makeCheckboxObservation(fieldId, checked ? 'checked' : 'unchecked');
}

function assembleB(observations) {
  return assembleFromRaw(syntheticRaw({ templateId: 'B-1.3.1', observations }));
}

function assembleA(observations) {
  return assembleFromRaw(syntheticRaw({ templateId: 'A-1.3.1', observations }));
}

function assembleC(observations) {
  return assembleFromRaw(syntheticRaw({ templateId: 'C-1.3.1', observations }));
}

function slot(result, slotId) {
  return result.resolved.exercises.find((ex) => ex.slot_id === slotId);
}

function codes(result) {
  return result.review.issues.map((i) => i.code);
}

describe('POC #9 freeze', () => {
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
    assert.equal(RECOGNIZER_ID, 'granite3.2-vision:2b');
    assert.equal(CROP_PROFILE, 'poc8b-clean');
  });

  it('writes POC #9 artifacts from frozen observations only', () => {
    const required = [
      'REPORT.md',
      'results.json',
      'raw-observation-example.json',
      'resolved-transcription-example.json',
      'canonical-candidate-example.json',
      'review-required-example.json',
      'semantic-error-accounting.json',
    ];
    for (const name of required) {
      assert.equal(fs.existsSync(path.join(POC9_ARTIFACT_DIR, name)), true, name);
    }
    const results = JSON.parse(fs.readFileSync(path.join(POC9_ARTIFACT_DIR, 'results.json'), 'utf8'));
    assert.equal(results.detector_sha256, FROZEN_DETECTOR_SHA256);
    assert.equal(results.eligible_crops, 519);
    assert.equal(results.granite_exact, 502);
    assert.equal(results.recognized_values_rewritten, 0);
    assert.equal(results.granite_miss_buckets.caught_unreadable, 4);
    assert.equal(results.granite_miss_buckets.silent_survives, 13);
  });
});

describe('POC #9 field identity', () => {
  it('parses v1.3.1 set field ids without inferring exercise from handwriting', () => {
    assert.deepEqual(parseSetFieldId('C07.S2.seconds'), {
      routine: 'C',
      slotId: 'C07',
      setNumber: 2,
      kind: 'seconds',
      fieldId: 'C07.S2.seconds',
    });
    assert.equal(parseSetFieldId('header.date'), null);
  });
});

describe('POC #9 assembly (no Ollama)', () => {
  it('assembles explicit external load onto a bilateral rep set', () => {
    const result = assembleB({
      'B02.S1.BW': bw('B02.S1.BW', false),
      'B02.S1.load': numeric('B02.S1.load', 25),
      'B02.S1.reps': numeric('B02.S1.reps', 10),
    });
    const set = slot(result, 'B02').sets[0];
    assert.equal(set.load_state, 'external');
    assert.equal(set.weight_lb, 25);
    assert.equal(set.measurements.reps, 10);
    assert.equal(set.load_provenance.resolution, 'RECOGNIZED');
    const canonical = result.canonical.workout.exercises.find((ex) => ex.slot_id === 'B02').sets[0];
    assert.equal(canonical.reps, 10);
    assert.equal(canonical.weight_lb, 25);
    assert.equal(result.review.status, REVIEW_STATUS.AUTO_ACCEPT);
  });

  it('resolves BW checked as bodyweight with null weight', () => {
    const result = assembleB({
      'B01.S1.BW': bw('B01.S1.BW', true),
      'B01.S1.load': blank('B01.S1.load'),
      'B01.S1.reps': numeric('B01.S1.reps', 12),
    });
    const set = slot(result, 'B01').sets[0];
    assert.equal(set.load_state, 'bodyweight');
    assert.equal(set.weight_lb, null);
    assert.equal(set.load_provenance.resolution, 'BW_CHECKBOX');
    assert.equal(result.review.status, REVIEW_STATUS.AUTO_ACCEPT);
  });

  it('inherits external load from the previous completed set of the same exercise', () => {
    const result = assembleB({
      'B03.S1.BW': bw('B03.S1.BW', false),
      'B03.S1.load': numeric('B03.S1.load', 45),
      'B03.S1.reps': numeric('B03.S1.reps', 12),
      'B03.S2.BW': bw('B03.S2.BW', false),
      'B03.S2.load': blank('B03.S2.load'),
      'B03.S2.reps': numeric('B03.S2.reps', 12),
      'B03.S3.BW': bw('B03.S3.BW', false),
      'B03.S3.load': blank('B03.S3.load'),
      'B03.S3.reps': numeric('B03.S3.reps', 10),
    });
    const sets = slot(result, 'B03').sets;
    assert.equal(sets.length, 3);
    assert.deepEqual(sets.map((s) => s.weight_lb), [45, 45, 45]);
    assert.equal(sets[1].load_provenance.resolution, 'INHERITED');
    assert.equal(sets[1].load_provenance.source_field_id, 'B03.S1.load');
    assert.equal(sets[2].load_provenance.source_field_id, 'B03.S1.load');
    assert.equal(result.review.status, REVIEW_STATUS.AUTO_ACCEPT);
  });

  it('inherits bodyweight when a later completed set has blank load and BW unchecked after an explicit BW set', () => {
    const result = assembleB({
      'B01.S1.BW': bw('B01.S1.BW', true),
      'B01.S1.load': blank('B01.S1.load'),
      'B01.S1.reps': numeric('B01.S1.reps', 12),
      'B01.S2.BW': bw('B01.S2.BW', false),
      'B01.S2.load': blank('B01.S2.load'),
      'B01.S2.reps': numeric('B01.S2.reps', 10),
    });
    const sets = slot(result, 'B01').sets;
    assert.equal(sets[1].load_state, 'bodyweight');
    assert.equal(sets[1].weight_lb, null);
    assert.equal(sets[1].load_provenance.resolution, 'INHERITED');
    assert.equal(sets[1].load_provenance.source_field_id, 'B01.S1.load');
  });

  it('flags first completed set with blank load and BW unchecked', () => {
    const result = assembleB({
      'B03.S1.BW': bw('B03.S1.BW', false),
      'B03.S1.load': blank('B03.S1.load'),
      'B03.S1.reps': numeric('B03.S1.reps', 12),
    });
    const set = slot(result, 'B03').sets[0];
    assert.equal(set.load_state, 'unknown');
    assert.equal(set.weight_lb, null);
    assert.equal(result.review.status, REVIEW_STATUS.REVIEW_REQUIRED);
    assert.equal(codes(result).includes(ISSUE.MISSING_INITIAL_LOAD), true);
  });

  it('creates no set object for an untouched blank row', () => {
    const result = assembleA({
      'A04.S1.BW': bw('A04.S1.BW', false),
      'A04.S1.load': numeric('A04.S1.load', 35),
      'A04.S1.reps': numeric('A04.S1.reps', 10),
      'A04.S2.BW': bw('A04.S2.BW', false),
      'A04.S2.load': numeric('A04.S2.load', 35),
      'A04.S2.reps': numeric('A04.S2.reps', 10),
      'A04.S3.BW': bw('A04.S3.BW', false),
      'A04.S3.load': blank('A04.S3.load'),
      'A04.S3.reps': blank('A04.S3.reps'),
    });
    const sets = slot(result, 'A04').sets;
    assert.deepEqual(sets.map((s) => s.set_number), [1, 2]);
    assert.equal(slot(result, 'A04').skipped_rows.some((r) => r.set_number === 3 && r.reason === 'BLANK_ROW'), true);
  });

  it('assembles unilateral reps as left_reps/right_reps', () => {
    const result = assembleB({
      'B05.S1.BW': bw('B05.S1.BW', true),
      'B05.S1.load': blank('B05.S1.load'),
      'B05.S1.left': numeric('B05.S1.left', 8),
      'B05.S1.right': numeric('B05.S1.right', 8),
    });
    const set = slot(result, 'B05').sets[0];
    assert.equal(slot(result, 'B05').measurement_kind, 'unilateral_reps');
    assert.equal(set.measurements.left_reps, 8);
    assert.equal(set.measurements.right_reps, 8);
    assert.equal(set.measurements.reps, undefined);
    const canonical = result.canonical.workout.exercises.find((ex) => ex.slot_id === 'B05').sets[0];
    assert.equal(canonical.left_reps, 8);
    assert.equal(canonical.right_reps, 8);
    assert.equal(canonical.reps, undefined);
  });

  it('assembles bilateral timed Farmer Carry as duration_sec', () => {
    const result = assembleA({
      'A07.S1.BW': bw('A07.S1.BW', false),
      'A07.S1.load': numeric('A07.S1.load', 50),
      'A07.S1.seconds': numeric('A07.S1.seconds', 45),
    });
    const set = slot(result, 'A07').sets[0];
    assert.equal(slot(result, 'A07').measurement_kind, 'bilateral_timed');
    assert.equal(set.measurements.duration_sec, 45);
    assert.equal(set.measurements.reps, undefined);
    assert.equal(result.canonical.workout.exercises.find((ex) => ex.slot_id === 'A07').sets[0].duration_sec, 45);
  });

  it('assembles unilateral timed Suitcase Carry as left/right duration_sec', () => {
    const result = assembleB({
      'B07.S1.BW': bw('B07.S1.BW', false),
      'B07.S1.load': numeric('B07.S1.load', 35),
      'B07.S1.left_seconds': numeric('B07.S1.left_seconds', 45),
      'B07.S1.right_seconds': numeric('B07.S1.right_seconds', 45),
      'B07.S2.BW': bw('B07.S2.BW', false),
      'B07.S2.load': blank('B07.S2.load'),
      'B07.S2.left_seconds': numeric('B07.S2.left_seconds', 45),
      'B07.S2.right_seconds': numeric('B07.S2.right_seconds', 45),
    });
    const sets = slot(result, 'B07').sets;
    assert.equal(slot(result, 'B07').measurement_kind, 'unilateral_timed');
    assert.equal(sets[0].measurements.left_duration_sec, 45);
    assert.equal(sets[1].weight_lb, 35);
    assert.equal(sets[1].load_provenance.resolution, 'INHERITED');
    const canonical = result.canonical.workout.exercises.find((ex) => ex.slot_id === 'B07').sets[0];
    assert.equal(canonical.left_duration_sec, 45);
    assert.equal(canonical.right_duration_sec, 45);
  });

  it('flags UNKNOWN numeric handwriting without inventing a value', () => {
    const result = assembleC({
      'C04.S1.BW': bw('C04.S1.BW', false),
      'C04.S1.load': unknown('C04.S1.load'),
      'C04.S1.reps': numeric('C04.S1.reps', 10),
    });
    const set = slot(result, 'C04').sets[0];
    assert.equal(set.load_state, 'unknown');
    assert.equal(set.weight_lb, null);
    assert.equal(set.measurements.reps, 10);
    assert.equal(codes(result).includes(ISSUE.UNREADABLE_NUMERIC), true);
    assert.equal(result.review.status, REVIEW_STATUS.REVIEW_REQUIRED);
  });

  it('flags conflicting BW checkbox plus written load without preferring either', () => {
    const result = assembleB({
      'B02.S1.BW': bw('B02.S1.BW', true),
      'B02.S1.load': numeric('B02.S1.load', 25),
      'B02.S1.reps': numeric('B02.S1.reps', 10),
    });
    const set = slot(result, 'B02').sets[0];
    assert.equal(set.load_state, 'unknown');
    assert.equal(set.weight_lb, 25);
    assert.equal(set.load_provenance.resolution, 'CONFLICT');
    assert.equal(codes(result).includes(ISSUE.CONFLICTING_LOAD_STATE), true);
    assert.equal(result.review.status, REVIEW_STATUS.REVIEW_REQUIRED);
  });

  it('flags incomplete unilateral measurement and does not invent the missing side', () => {
    const result = assembleC({
      'C05.S1.BW': bw('C05.S1.BW', false),
      'C05.S1.load': numeric('C05.S1.load', 30),
      'C05.S1.left': numeric('C05.S1.left', 12),
      'C05.S1.right': blank('C05.S1.right'),
    });
    const set = slot(result, 'C05').sets[0];
    assert.equal(set.measurements.left_reps, 12);
    assert.equal(set.measurements.right_reps, undefined);
    assert.equal(codes(result).includes(ISSUE.INCOMPLETE_MEASUREMENT), true);
  });

  it('flags multiple effort selections and does not pick one', () => {
    const result = assembleB({
      'header.effort.1': makeCheckboxObservation('header.effort.1', 'checked'),
      'header.effort.5': makeCheckboxObservation('header.effort.5', 'checked'),
      'B01.S1.BW': bw('B01.S1.BW', true),
      'B01.S1.reps': numeric('B01.S1.reps', 12),
    });
    assert.equal(result.resolved.header.effort, null);
    assert.equal(result.canonical.workout.effort, null);
    assert.equal(codes(result).includes(ISSUE.MULTIPLE_EFFORT_SELECTIONS), true);
  });

  it('flags multiple pain selections and does not pick one', () => {
    const result = assembleB({
      'header.pain.0': makeCheckboxObservation('header.pain.0', 'checked'),
      'header.pain.2': makeCheckboxObservation('header.pain.2', 'checked'),
      'B01.S1.BW': bw('B01.S1.BW', true),
      'B01.S1.reps': numeric('B01.S1.reps', 12),
    });
    assert.equal(result.resolved.header.pain_level, null);
    assert.equal(result.canonical.workout.pain.level, null);
    assert.equal(codes(result).includes(ISSUE.MULTIPLE_PAIN_SELECTIONS), true);
  });

  it('emits semantic review issues without rewriting recognized handwriting', () => {
    const result = assembleA({
      'A07.S1.BW': bw('A07.S1.BW', false),
      'A07.S1.load': numeric('A07.S1.load', 40),
      'A07.S1.seconds': numeric('A07.S1.seconds', 410),
    });
    assert.equal(slot(result, 'A07').sets[0].measurements.duration_sec, 410);
    assert.equal(result.rewritten.length, 0);
    assert.equal(410 > INTEGRITY_BOUNDS.duration_sec_max, false);
    assert.equal(codes(result).includes(ISSUE.EXTREME_MEASUREMENT), false);
    const extreme = assembleB({
      'B02.S1.BW': bw('B02.S1.BW', false),
      'B02.S1.load': numeric('B02.S1.load', 1500),
      'B02.S1.reps': numeric('B02.S1.reps', 10),
    });
    assert.equal(slot(extreme, 'B02').sets[0].weight_lb, 1500);
    assert.equal(codes(extreme).includes(ISSUE.EXTREME_MEASUREMENT), true);
  });

  it('preserves provenance for recognized, inherited, and BW resolutions', () => {
    const result = assembleB({
      'B03.S1.BW': bw('B03.S1.BW', false),
      'B03.S1.load': numeric('B03.S1.load', 40),
      'B03.S1.reps': numeric('B03.S1.reps', 12),
      'B03.S2.BW': bw('B03.S2.BW', false),
      'B03.S2.load': blank('B03.S2.load'),
      'B03.S2.reps': numeric('B03.S2.reps', 12),
      'B01.S1.BW': bw('B01.S1.BW', true),
      'B01.S1.reps': numeric('B01.S1.reps', 12),
    });
    assert.equal(slot(result, 'B03').sets[0].load_provenance.resolution, 'RECOGNIZED');
    assert.equal(slot(result, 'B03').sets[1].load_provenance.resolution, 'INHERITED');
    assert.equal(slot(result, 'B01').sets[0].load_provenance.resolution, 'BW_CHECKBOX');
    assert.equal('load_provenance' in result.canonical.workout.exercises[0].sets[0], false);
  });

  it('does not inherit load across exercises', () => {
    const result = assembleB({
      'B02.S1.BW': bw('B02.S1.BW', false),
      'B02.S1.load': numeric('B02.S1.load', 25),
      'B02.S1.reps': numeric('B02.S1.reps', 10),
      'B03.S1.BW': bw('B03.S1.BW', false),
      'B03.S1.load': blank('B03.S1.load'),
      'B03.S1.reps': numeric('B03.S1.reps', 12),
    });
    assert.equal(slot(result, 'B03').sets[0].weight_lb, null);
    assert.equal(slot(result, 'B03').sets[0].load_state, 'unknown');
    assert.equal(codes(result).includes(ISSUE.MISSING_INITIAL_LOAD), true);
  });

  it('does not look forward to fill an earlier blank load', () => {
    const result = assembleB({
      'B03.S1.BW': bw('B03.S1.BW', false),
      'B03.S1.load': blank('B03.S1.load'),
      'B03.S1.reps': numeric('B03.S1.reps', 12),
      'B03.S2.BW': bw('B03.S2.BW', false),
      'B03.S2.load': numeric('B03.S2.load', 45),
      'B03.S2.reps': numeric('B03.S2.reps', 12),
    });
    const sets = slot(result, 'B03').sets;
    assert.equal(sets[0].weight_lb, null);
    assert.equal(sets[0].load_state, 'unknown');
    assert.equal(sets[1].weight_lb, 45);
    assert.equal(sets[1].load_provenance.resolution, 'RECOGNIZED');
  });

  it('maps routine/template from the form identity and leaves unrecognized headers null', () => {
    const result = assembleC({
      'C01.S1.BW': bw('C01.S1.BW', true),
      'C01.S1.reps': numeric('C01.S1.reps', 10),
      'header.effort.5': makeCheckboxObservation('header.effort.5', 'checked'),
      'header.pain.3': makeCheckboxObservation('header.pain.3', 'checked'),
    });
    assert.equal(result.canonical.schema_version, '1.2');
    assert.equal(result.canonical.workout.routine, 'C');
    assert.equal(result.canonical.workout.template_version, 'C-1.3.1');
    assert.equal(result.canonical.workout.date, null);
    assert.equal(result.canonical.workout.bodyweight_lb, null);
    assert.equal(result.canonical.workout.duration_min, null);
    assert.equal(result.canonical.workout.notes, null);
    assert.equal(result.canonical.workout.effort, 5);
    assert.equal(result.canonical.workout.pain.level, 3);
    assert.deepEqual(result.canonical.workout.pain.areas, []);
    assert.equal(result.canonical.workout.exercises[0].exercise_id, 'EX01');
    assert.equal('workout_id' in result.canonical, false);
  });
});
