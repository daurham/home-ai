import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadWorkoutConfig } from './config.js';
import { compareFixture } from './compareFixture.js';
import { transcribeWorkoutSheet } from './transcribe.js';

describe('compareFixture', () => {
  it('matches the expected record against itself', () => {
    const expected = loadWorkoutConfig().expectedRoutineB;
    const result = compareFixture(expected, structuredClone(expected));
    assert.equal(result.match, true);
  });

  it('treats note capitalization as low severity', () => {
    const expected = loadWorkoutConfig().expectedRoutineB;
    const actual = structuredClone(expected);
    actual.workout.notes = String(expected.workout.notes).toUpperCase();
    const result = compareFixture(expected, actual);
    assert.equal(result.match, false);
    assert.equal(result.highSeverity.length, 0);
    assert.equal(result.lowSeverity.length, 1);
  });

  it('treats a reps mismatch as high severity', () => {
    const expected = loadWorkoutConfig().expectedRoutineB;
    const actual = structuredClone(expected);
    actual.workout.exercises[0].sets[0].reps = 99;
    const result = compareFixture(expected, actual);
    assert.ok(result.highSeverity.some((m) => m.path.includes('reps')));
  });
});

describe('transcribeWorkoutSheet', () => {
  it('returns parse/schema errors instead of repairing invalid model text', async () => {
    const result = await transcribeWorkoutSheet({
      imageBuffer: Buffer.from('fake-image'),
      generate: async () => ({ model: 'test-model', raw: 'not json', formatMode: 'json' }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.workout, null);
    assert.equal(result.validation.valid, false);
    assert.ok(result.validation.schemaErrors.some((e) => e.keyword === 'parse'));
  });

  it('validates a perfect model response against v1.2 rules', async () => {
    const expected = loadWorkoutConfig().expectedRoutineB;
    const result = await transcribeWorkoutSheet({
      imageBuffer: Buffer.from('fake-image'),
      generate: async () => ({
        model: 'test-model',
        raw: JSON.stringify(expected),
        formatMode: 'json-schema',
      }),
    });
    assert.equal(result.validation.valid, true, JSON.stringify(result.validation, null, 2));
    assert.equal(result.workout.workout.routine, 'B');
  });
});
