import { query } from '../db.js';
import { parseAmountCents } from './expenseValidation.js';

export const DEFAULT_WEEKLY_BUDGET_CENTS = 15000;
export const MAX_WEEKLY_BUDGET_CENTS = 1_000_000;

export function parseWeeklyBudgetCents(body) {
  return parseAmountCents({
    amount_cents: body.weekly_budget_cents,
    amount: body.weekly_budget,
  });
}

export function validateWeeklyBudgetCents(value) {
  if (value === undefined) return 'weekly_budget_cents is required';
  if (!Number.isInteger(value)) return 'weekly_budget_cents must be an integer';
  if (value <= 0) return 'weekly budget must be greater than 0';
  if (value > MAX_WEEKLY_BUDGET_CENTS) return 'weekly budget is too large';
  return null;
}

export async function getExpenseSettings() {
  const existing = await query(
    `SELECT id, weekly_budget_cents, currency, updated_at
     FROM expense_settings
     WHERE id = 1`
  );
  if (existing.rows[0]) return existing.rows[0];

  const inserted = await query(
    `INSERT INTO expense_settings (id, weekly_budget_cents, currency)
     VALUES (1, $1, 'USD')
     ON CONFLICT (id) DO UPDATE SET id = expense_settings.id
     RETURNING id, weekly_budget_cents, currency, updated_at`,
    [DEFAULT_WEEKLY_BUDGET_CENTS]
  );
  return inserted.rows[0];
}
