import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getExpenseWeekRange,
  getExpenseMonthRange,
  DEFAULT_EXPENSE_TIMEZONE,
} from './expenseWeek.js';

const TZ = DEFAULT_EXPENSE_TIMEZONE;

describe('getExpenseWeekRange', () => {
  it('assigns Friday 00:00 local to that week', () => {
    // 2026-09-11 is Friday. Midnight PDT = 07:00 UTC.
    const midnightFriday = new Date('2026-09-11T07:00:00.000Z');
    const range = getExpenseWeekRange(midnightFriday, TZ);
    assert.equal(range.weekKey, '2026-09-11');
    assert.equal(range.weekStartDate, '2026-09-11');
    assert.equal(range.weekEndDate, '2026-09-17');
    assert.equal(range.weekStart.toISOString(), '2026-09-11T07:00:00.000Z');
  });

  it('assigns Thursday 23:59 local to that same week', () => {
    // 2026-09-17 23:59:59.999 PDT = 2026-09-18T06:59:59.999Z
    const endThursday = new Date('2026-09-18T06:59:59.999Z');
    const range = getExpenseWeekRange(endThursday, TZ);
    assert.equal(range.weekKey, '2026-09-11');
    assert.equal(range.weekEnd.toISOString(), '2026-09-18T06:59:59.999Z');
  });

  it('assigns Friday after midnight to the next week', () => {
    const nextFriday = new Date('2026-09-18T07:00:00.000Z');
    const range = getExpenseWeekRange(nextFriday, TZ);
    assert.equal(range.weekKey, '2026-09-18');
    assert.equal(range.weekStartDate, '2026-09-18');
    assert.equal(range.weekEndDate, '2026-09-24');
  });

  it('treats YYYY-MM-DD occurred_on as that calendar day', () => {
    assert.equal(getExpenseWeekRange('2026-09-11', TZ).weekKey, '2026-09-11');
    assert.equal(getExpenseWeekRange('2026-09-17', TZ).weekKey, '2026-09-11');
    assert.equal(getExpenseWeekRange('2026-09-18', TZ).weekKey, '2026-09-18');
  });

  it('keeps a week that crosses a month boundary as one weekKey', () => {
    // Fri Oct 30 2026 – Thu Nov 5 2026.
    // Expected: week bucket is the Friday; month bucket is the calendar month
    // of occurred_on, so Oct 30 is 2026-10 and Nov 1 is 2026-11.
    const friday = getExpenseWeekRange('2026-10-30', TZ);
    const thursday = getExpenseWeekRange('2026-11-05', TZ);
    const novFirst = getExpenseWeekRange('2026-11-01', TZ);

    assert.equal(friday.weekKey, '2026-10-30');
    assert.equal(thursday.weekKey, '2026-10-30');
    assert.equal(novFirst.weekKey, '2026-10-30');
    assert.equal(getExpenseMonthRange('2026-10-30', TZ).monthKey, '2026-10');
    assert.equal(getExpenseMonthRange('2026-11-01', TZ).monthKey, '2026-11');
  });

  it('survives the spring-forward DST edge in America/Los_Angeles', () => {
    // 2026-03-08 is Sunday of week Fri Mar 6 – Thu Mar 12; clocks skip 2am.
    const range = getExpenseWeekRange('2026-03-08', TZ);
    assert.equal(range.weekKey, '2026-03-06');
    assert.equal(range.weekEndDate, '2026-03-12');
    const fridayStart = getExpenseWeekRange('2026-03-06', TZ);
    assert.equal(fridayStart.weekStart.toISOString(), '2026-03-06T08:00:00.000Z'); // PST
  });
});
