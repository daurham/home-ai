import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadWorkoutConfig } from './config.js';
import { validateWorkoutSchema } from './schemaValidator.js';
import { validateWorkoutSemantics } from './semanticValidator.js';
import { loadV131WorkoutConfig } from './v131Config.js';
import { DATE_ISSUE_CODES, validateWorkoutSemanticsV13 } from './semanticValidatorV13.js';

function v13Record(over = {}) {
  return {
    schema_version: '1.3',
    transcription_status: over.transcription_status || 'VALID',
    ambiguities: over.ambiguities || [],
    workout: {
      date: over.date === undefined ? '2026-09-20' : over.date,
      routine: over.routine || 'B',
      template_version: over.template_version || 'B-1.3.1',
      duration_min: null,
      effort: 1,
      pain: { level: null, areas: [], notes: null },
      bodyweight_lb: over.bodyweight_lb === undefined ? null : over.bodyweight_lb,
      notes: null,
      exercises: [{
        slot_id: 'B01',
        exercise_id: 'EX08',
        notes: null,
        sets: [{
          set_number: 1,
          type: 'working',
          weight_lb: null,
          load_state: 'bodyweight',
          reps: 12,
          notes: null,
        }],
      }],
    },
  };
}

describe('v1.3.1 schema', () => {
  const config = loadV131WorkoutConfig();

  it('accepts A-1.3.1, B-1.3.1, and C-1.3.1', () => {
    for (const [routine, template] of [['A', 'A-1.3.1'], ['B', 'B-1.3.1'], ['C', 'C-1.3.1']]) {
      const record = v13Record({ routine, template_version: template });
      if (routine === 'A') {
        record.workout.exercises[0].slot_id = 'A01';
        record.workout.exercises[0].exercise_id = 'EX01';
      }
      if (routine === 'C') {
        record.workout.exercises[0].slot_id = 'C01';
        record.workout.exercises[0].exercise_id = 'EX01';
      }
      const schema = validateWorkoutSchema(record, config.schema);
      assert.equal(schema.valid, true, JSON.stringify(schema.schemaErrors));
    }
  });

  it('rejects a malformed template_version', () => {
    const record = v13Record({ template_version: 'B-latest' });
    const schema = validateWorkoutSchema(record, config.schema);
    assert.equal(schema.valid, false);
  });

  it('preserves old v1.2 schema behavior', () => {
    const v12 = loadWorkoutConfig();
    const record = structuredClone(v12.expectedRoutineB);
    const schema = validateWorkoutSchema(record, v12.schema);
    const semantic = validateWorkoutSemantics(record, v12);
    assert.equal(schema.valid, true);
    assert.equal(semantic.valid, true);
    record.workout.template_version = 'B-1.3.1';
    assert.equal(validateWorkoutSchema(record, v12.schema).valid, false);
  });
});

describe('v1.3.1 semantics', () => {
  const config = loadV131WorkoutConfig();

  it('requires routine/template consistency for v1.3.1', () => {
    const record = v13Record({ template_version: 'B-1.2' });
    const semantic = validateWorkoutSemanticsV13(record, { config });
    assert.equal(semantic.valid, false);
    assert.equal(semantic.semanticErrors.some((e) => e.id === 'SV03'), true);
  });

  it('accepts a complete date', () => {
    const record = v13Record({ date: '2026-09-20' });
    const semantic = validateWorkoutSemanticsV13(record, { review: { issues: [] }, config });
    assert.equal(semantic.valid, true, JSON.stringify(semantic.semanticErrors));
  });

  it('requires a visible-literal ambiguity for PARTIAL_DATE', () => {
    const record = v13Record({
      date: null,
      transcription_status: 'REVIEW_REQUIRED',
      ambiguities: [{ location: 'workout.date', field: 'date', detected_value: '9-20', reason: 'PARTIAL_DATE' }],
    });
    const review = { issues: [{ code: DATE_ISSUE_CODES.PARTIAL_DATE, field_id: 'header.date', observed_value: '9-20' }] };
    assert.equal(validateWorkoutSemanticsV13(record, { review, config }).valid, true);
    record.ambiguities = [];
    assert.equal(validateWorkoutSemanticsV13(record, { review, config }).valid, false);
  });

  it('accepts UNREADABLE_DATE without a fabricated detected_value', () => {
    const record = v13Record({ date: null, transcription_status: 'REVIEW_REQUIRED' });
    const review = { issues: [{ code: DATE_ISSUE_CODES.UNREADABLE_DATE, field_id: 'header.date', observed_value: null }] };
    assert.equal(validateWorkoutSemanticsV13(record, { review, config }).valid, true);
  });

  it('accepts INVALID_DATE when the literal is preserved', () => {
    const record = v13Record({ date: null, transcription_status: 'REVIEW_REQUIRED' });
    const review = { issues: [{ code: DATE_ISSUE_CODES.INVALID_DATE, field_id: 'header.date', observed_value: '2-30-26' }] };
    assert.equal(validateWorkoutSemanticsV13(record, { review, config }).valid, true);
  });

  it('allows blank date with no fabricated ambiguity', () => {
    const record = v13Record({ date: null, transcription_status: 'REVIEW_REQUIRED' });
    const review = { issues: [{ code: DATE_ISSUE_CODES.BLANK_DATE, field_id: 'header.date' }] };
    assert.equal(validateWorkoutSemanticsV13(record, { review, config }).valid, true);
    record.ambiguities = [{ location: 'workout.date', field: 'date', detected_value: 'today', reason: 'guess' }];
    assert.equal(validateWorkoutSemanticsV13(record, { review, config }).valid, false);
  });
});
