import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EXPECTED_RAW_ROUTINE_B_LITERAL } from './rawSchema.js';
import { scoreRawTranscription, expectedFieldCount } from './scoreRaw.js';

const llamaWarmish = {
  date_written: '4-12',
  bodyweight: '192',
  effort: 'Yes (4/5)',
  pain: '0 (0/3)',
  note: 'Went easy on left leg',
  B01: [
    { weight: '10', reps: '10' },
    { weight: '10', reps: '10' },
    { weight: '10', reps: '10' },
  ],
  B02: [
    { weight: '25', reps: '10' },
    { weight: '10', reps: '10' },
    { weight: '10', reps: '10' },
  ],
  B03: [
    { weight: '40', reps: '10' },
    { weight: '40', reps: '8' },
    { weight: '45', reps: '9' },
  ],
  B04: [
    { weight: '15', reps: '15' },
    { weight: '15', reps: '15' },
    { weight: '15', reps: '15' },
  ],
  B05: [
    { weight: '10', left: '4', right: '8' },
    { weight: '10', left: '3', right: '7' },
  ],
  B06: [
    { weight: '40', reps: '15' },
    { weight: '30', reps: '15' },
  ],
  B07: [
    { weight: '25', left_sec: '45', right_sec: '45' },
    { weight: '35', left_sec: '45', right_sec: '45' },
  ],
};

describe('scoreRawTranscription', () => {
  it('scores a perfect literal extraction as 45/45 without using the canonical fixture', () => {
    const score = scoreRawTranscription(EXPECTED_RAW_ROUTINE_B_LITERAL);
    assert.equal(expectedFieldCount(), 45);
    assert.equal(score.fieldCount, 45);
    assert.equal(score.rawFieldsCorrect, 45);
    assert.equal(score.rawAccuracyPct, 100);
    assert.equal(score.header.pain, true);
    assert.equal(score.exercises.B03, true);
    assert.equal(score.difficult.bw_recognition, true);
    assert.equal(score.difficult.blank_weight_preservation, true);
    assert.equal(score.mismatches.length, 0);
  });

  it('does not let JS inheritance hide blank-weight and BW mistakes', () => {
    const score = scoreRawTranscription(llamaWarmish);
    assert.equal(score.exercises.B03, true);
    assert.equal(score.exercises.B05, true);
    assert.equal(score.exercises.B01, false);
    assert.equal(score.exercises.B02, false);
    assert.equal(score.exercises.B04, false);
    assert.equal(score.header.effort, false);
    assert.equal(score.header.pain, false);
    assert.equal(score.difficult.bw_recognition, false);
    assert.equal(score.difficult.blank_weight_preservation, false);
    assert.equal(score.rawFieldsCorrect, 35);
    assert.ok(score.mismatches.some((row) => row.path === 'B04[0].weight' && row.expected === 'BW'));
  });

  it('flags B03 values leaking into B01', () => {
    const leaked = {
      ...EXPECTED_RAW_ROUTINE_B_LITERAL,
      B01: [
        { weight: 'BW', reps: '10' },
        { weight: '40', reps: '10' },
        { weight: '40', reps: '8' },
        { weight: '45', reps: '9' },
      ],
    };
    const score = scoreRawTranscription(leaked);
    assert.equal(score.difficult.no_cross_table_leakage, false);
    assert.equal(score.exercises.B01, false);
  });
});
