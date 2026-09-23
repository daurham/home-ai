import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadWorkoutConfig } from './config.js';
import { EXPECTED_RAW_ROUTINE_B, SLOT_LAYOUT } from './rawSchema.js';
import { normalizeRawTranscription, normalizeSets, parseWeight } from './normalizeRaw.js';
import { validateWorkoutSchema } from './schemaValidator.js';
import { validateWorkoutSemantics } from './semanticValidator.js';
import { compareFixture } from './compareFixture.js';

describe('parseWeight', () => {
  it('treats BW as bodyweight', () => {
    assert.deepEqual(parseWeight('BW'), { kind: 'bw' });
    assert.deepEqual(parseWeight('bw'), { kind: 'bw' });
  });

  it('keeps numeric loads', () => {
    assert.deepEqual(parseWeight(40), { kind: 'numeric', value: 40 });
    assert.deepEqual(parseWeight('25'), { kind: 'numeric', value: 25 });
  });

  it('treats blanks as blanks', () => {
    assert.deepEqual(parseWeight(null), { kind: 'blank' });
    assert.deepEqual(parseWeight(''), { kind: 'blank' });
  });
});

describe('normalizeSets', () => {
  it('inherits blank weights within one exercise only', () => {
    const sets = normalizeSets(
      [
        { weight: 25, reps: 10 },
        { weight: null, reps: 10 },
        { weight: null, reps: 10 },
      ],
      SLOT_LAYOUT.B02,
      { measurement: 'reps' },
    );
    assert.deepEqual(sets.map((s) => s.weight_lb), [25, 25, 25]);
    assert.ok(sets.every((s) => s.load_state === 'external'));
  });

  it('inherits BW as bodyweight with null weight_lb', () => {
    const sets = normalizeSets(
      [
        { weight: 'BW', reps: 10 },
        { weight: null, reps: 10 },
      ],
      SLOT_LAYOUT.B01,
      { measurement: 'reps' },
    );
    assert.ok(sets.every((s) => s.load_state === 'bodyweight' && s.weight_lb == null));
  });

  it('drops a fully blank row', () => {
    const sets = normalizeSets(
      [
        { weight: 40, reps: 15 },
        { weight: null, reps: null },
        { weight: 30, reps: 15 },
      ],
      SLOT_LAYOUT.B06,
      { measurement: 'reps' },
    );
    assert.equal(sets.length, 2);
    assert.deepEqual(sets.map((s) => s.set_number), [1, 3]);
  });
});

describe('normalizeRawTranscription', () => {
  it('turns the known Routine B raw sheet into the expected v1.2 record', () => {
    const workout = normalizeRawTranscription(EXPECTED_RAW_ROUTINE_B);
    const schema = validateWorkoutSchema(workout);
    const semantic = validateWorkoutSemantics(workout);
    const comparison = compareFixture(loadWorkoutConfig().expectedRoutineB, workout);
    assert.equal(schema.valid, true, JSON.stringify(schema.schemaErrors, null, 2));
    assert.equal(semantic.valid, true, JSON.stringify(semantic.semanticErrors, null, 2));
    assert.equal(comparison.match, true, JSON.stringify(comparison.mismatches, null, 2));
  });

  it('does not invent a year for 4-12', () => {
    const workout = normalizeRawTranscription(EXPECTED_RAW_ROUTINE_B);
    assert.equal(workout.workout.date, null);
    assert.equal(workout.transcription_status, 'REVIEW_REQUIRED');
    assert.equal(workout.ambiguities[0].detected_value, '4-12');
  });

  it('assigns B-1.2 and template exercise ids without the model', () => {
    const workout = normalizeRawTranscription(EXPECTED_RAW_ROUTINE_B);
    assert.equal(workout.workout.template_version, 'B-1.2');
    assert.deepEqual(
      workout.workout.exercises.map((ex) => [ex.slot_id, ex.exercise_id]),
      [['B01', 'EX08'], ['B02', 'EX09'], ['B03', 'EX03'], ['B04', 'EX10'], ['B05', 'EX11'], ['B06', 'EX12'], ['B07', 'EX13']],
    );
  });
});
