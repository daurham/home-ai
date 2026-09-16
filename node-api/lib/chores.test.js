import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeChoreInput, rowToChore } from './chores.js';

describe('normalizeChoreInput', () => {
  it('maps camelCase fields and clamps cadence', () => {
    const { value, error } = normalizeChoreInput({
      title: '  Bins  ',
      assignee: 'Jake',
      every: 99.6,
      unit: 'weeks',
      weekday: 9,
      monthDay: 40,
      icon: 'bins',
      daySpecific: true,
      lastCompletedOn: '2026-09-10',
      completedOccurrences: { '2026-09-10': '2026-09-09', nope: 'x' },
    });
    assert.equal(error, null);
    assert.equal(value.title, 'Bins');
    assert.equal(value.every, 100);
    assert.equal(value.weekday, 6);
    assert.equal(value.month_day, 28);
    assert.equal(value.day_specific, true);
    assert.deepEqual(value.completed_occurrences, { '2026-09-10': '2026-09-09' });
  });

  it('rejects an empty title and a bad unit', () => {
    assert.equal(normalizeChoreInput({ title: '   ' }).error, 'title is required');
    assert.equal(normalizeChoreInput({ title: 'X', unit: 'years' }).error, 'unit must be days, weeks, or months');
  });
});

describe('rowToChore', () => {
  it('exposes the dashboard shape', () => {
    const chore = rowToChore({
      id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      title: 'Bins',
      assignee: 'Jake',
      every: 1,
      unit: 'weeks',
      weekday: 2,
      month_day: 1,
      icon: 'bins',
      day_specific: true,
      last_completed_on: '2026-09-10',
      completed_occurrences: { '2026-09-10': '2026-09-09' },
      created_at: new Date('2026-09-01T12:00:00.000Z'),
    });
    assert.equal(chore.monthDay, 1);
    assert.equal(chore.daySpecific, true);
    assert.equal(chore.lastCompletedOn, '2026-09-10');
    assert.equal(chore.createdAt, '2026-09-01T12:00:00.000Z');
  });
});
