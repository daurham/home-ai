import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseWeeklyBudgetCents, validateWeeklyBudgetCents } from './expenseSettings.js';

describe('weekly budget validation', () => {
  it('defaults to $150.00 in cents and accepts dollars', () => {
    assert.deepEqual(parseWeeklyBudgetCents({ weekly_budget: 150 }), { value: 15000 });
    assert.deepEqual(parseWeeklyBudgetCents({ weekly_budget_cents: 15000 }), { value: 15000 });
  });

  it('rejects non-positive and oversized budgets', () => {
    assert.equal(validateWeeklyBudgetCents(0), 'weekly budget must be greater than 0');
    assert.equal(validateWeeklyBudgetCents(15000), null);
    assert.equal(validateWeeklyBudgetCents(1_000_001), 'weekly budget is too large');
  });
});
