import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHabitInput, rowToHabit } from './habits.js';

describe('normalizeHabitInput', () => {
  it('keeps only YYYY-MM-DD completions that are truthy', () => {
    const { value, error } = normalizeHabitInput({
      name: '  Water  ',
      completions: { '2026-09-10': true, '2026-09-11': false, skip: true },
    });
    assert.equal(error, null);
    assert.equal(value.name, 'Water');
    assert.deepEqual(value.completions, { '2026-09-10': true });
  });

  it('requires a name', () => {
    assert.equal(normalizeHabitInput({ name: '' }).error, 'name is required');
  });
});

describe('rowToHabit', () => {
  it('exposes the dashboard shape', () => {
    const habit = rowToHabit({
      id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      name: 'Water',
      completions: { '2026-09-10': true },
      created_at: '2026-09-01T12:00:00.000Z',
    });
    assert.equal(habit.name, 'Water');
    assert.deepEqual(habit.completions, { '2026-09-10': true });
  });
});
