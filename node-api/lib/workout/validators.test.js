import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadWorkoutConfig } from './config.js';
import { validateWorkoutSchema } from './schemaValidator.js';
import { validateWorkoutSemantics } from './semanticValidator.js';

function cloneExpected() {
  return structuredClone(loadWorkoutConfig().expectedRoutineB);
}

describe('v1.2 validators', () => {
  it('accepts the Routine B expected fixture', () => {
    const record = cloneExpected();
    const schema = validateWorkoutSchema(record);
    const semantic = validateWorkoutSemantics(record);
    assert.equal(schema.valid, true, JSON.stringify(schema.schemaErrors, null, 2));
    assert.equal(semantic.valid, true, JSON.stringify(semantic.semanticErrors, null, 2));
  });

  it('rejects a slot from the wrong routine', () => {
    const record = cloneExpected();
    record.workout.exercises[0].slot_id = 'A01';
    const semantic = validateWorkoutSemantics(record);
    assert.equal(semantic.valid, false);
    assert.ok(semantic.semanticErrors.some((e) => e.id === 'SV01'));
  });

  it('rejects a slot/exercise mismatch', () => {
    const record = cloneExpected();
    record.workout.exercises[0].exercise_id = 'EX01';
    const semantic = validateWorkoutSemantics(record);
    assert.equal(semantic.valid, false);
    assert.ok(semantic.semanticErrors.some((e) => e.id === 'SV02'));
  });

  it('rejects the wrong template_version', () => {
    const record = cloneExpected();
    record.workout.template_version = 'B-1.1';
    const semantic = validateWorkoutSemantics(record);
    assert.equal(semantic.valid, false);
    assert.ok(semantic.semanticErrors.some((e) => e.id === 'SV03'));
  });

  it('rejects duplicate set numbers', () => {
    const record = cloneExpected();
    record.workout.exercises[0].sets[1].set_number = 1;
    const semantic = validateWorkoutSemantics(record);
    assert.equal(semantic.valid, false);
    assert.ok(semantic.semanticErrors.some((e) => e.id === 'SV04'));
  });

  it('rejects bilateral reps on a unilateral exercise', () => {
    const record = cloneExpected();
    const lunge = record.workout.exercises.find((ex) => ex.slot_id === 'B05');
    delete lunge.sets[0].left_reps;
    delete lunge.sets[0].right_reps;
    lunge.sets[0].reps = 8;
    const semantic = validateWorkoutSemantics(record);
    assert.equal(semantic.valid, false);
    assert.ok(semantic.semanticErrors.some((e) => e.id === 'SV05'));
  });

  it('rejects date=null without a date ambiguity', () => {
    const record = cloneExpected();
    record.ambiguities = [];
    const semantic = validateWorkoutSemantics(record);
    assert.equal(semantic.valid, false);
    assert.ok(semantic.semanticErrors.some((e) => e.id === 'SV13'));
  });

  it('rejects workout_id in transcription output', () => {
    const record = cloneExpected();
    record.workout_id = 'invented';
    const semantic = validateWorkoutSemantics(record);
    assert.equal(semantic.valid, false);
    assert.ok(semantic.semanticErrors.some((e) => e.id === 'SV14'));
  });

  it('rejects bodyweight sets with a numeric weight', () => {
    const record = cloneExpected();
    record.workout.exercises[0].sets[0].weight_lb = 192;
    const semantic = validateWorkoutSemantics(record);
    assert.equal(semantic.valid, false);
  });
});
