import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAmountCents,
  validateAmountCents,
  validateOccurredOn,
  validateNote,
} from './expenseValidation.js';

describe('expense API validation', () => {
  it('rejects non-positive amounts', () => {
    assert.equal(validateAmountCents(0), 'amount must be greater than 0');
    assert.equal(validateAmountCents(-5), 'amount must be greater than 0');
    assert.equal(validateAmountCents(1250), null);
  });

  it('accepts dollar amounts converted to cents', () => {
    assert.deepEqual(parseAmountCents({ amount: 12.5 }), { value: 1250 });
    assert.equal(parseAmountCents({ amount_cents: 12.5 }).error, 'amount_cents must be an integer');
  });

  it('rejects invalid and far-future dates', () => {
    assert.equal(validateOccurredOn('09/11/2026', 'America/Los_Angeles'), 'occurred_on must be YYYY-MM-DD');
    assert.equal(validateOccurredOn('2026-02-30', 'America/Los_Angeles'), 'occurred_on is not a valid calendar date');
    assert.equal(validateOccurredOn('1999-12-31', 'America/Los_Angeles'), 'occurred_on is too far in the past');
    assert.equal(validateOccurredOn('2099-01-01', 'America/Los_Angeles'), 'occurred_on is too far in the future');
    assert.equal(validateOccurredOn('2026-09-11', 'America/Los_Angeles'), null);
  });

  it('caps note length', () => {
    assert.equal(validateNote('x'.repeat(501)) != null, true);
    assert.equal(validateNote('coffee'), null);
  });
});
