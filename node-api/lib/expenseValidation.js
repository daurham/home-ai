import { todayYmd } from './expenseWeek.js';

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_NOTE = 500;
export const MAX_PAID_BY = 40;
export const MAX_AMOUNT_CENTS = 999_999_999;

export function parseAmountCents(body) {
  if (body.amount_cents !== undefined && body.amount_cents !== null) {
    const n = Number(body.amount_cents);
    if (!Number.isInteger(n)) return { error: 'amount_cents must be an integer' };
    return { value: n };
  }
  if (body.amount !== undefined && body.amount !== null && body.amount !== '') {
    const n = Number(body.amount);
    if (!Number.isFinite(n)) return { error: 'amount must be a number' };
    return { value: Math.round(n * 100) };
  }
  return { value: undefined };
}

export function validateAmountCents(value) {
  if (value === undefined) return 'amount_cents is required';
  if (value <= 0) return 'amount must be greater than 0';
  if (value > MAX_AMOUNT_CENTS) return 'amount is too large';
  return null;
}

export function validateOccurredOn(occurredOn, timeZone) {
  if (!DATE_RE.test(occurredOn)) {
    return 'occurred_on must be YYYY-MM-DD';
  }
  const [year, month, day] = occurredOn.split('-').map(Number);
  const asUtc = new Date(Date.UTC(year, month - 1, day));
  if (asUtc.getUTCFullYear() !== year || asUtc.getUTCMonth() + 1 !== month || asUtc.getUTCDate() !== day) {
    return 'occurred_on is not a valid calendar date';
  }
  if (occurredOn < '2000-01-01') {
    return 'occurred_on is too far in the past';
  }
  const today = todayYmd(timeZone);
  const [ty, tm, td] = today.split('-').map(Number);
  const limit = new Date(Date.UTC(ty, tm - 1, td + 366));
  const maxDate = `${limit.getUTCFullYear()}-${String(limit.getUTCMonth() + 1).padStart(2, '0')}-${String(limit.getUTCDate()).padStart(2, '0')}`;
  if (occurredOn > maxDate) {
    return 'occurred_on is too far in the future';
  }
  return null;
}

export function validateNote(note) {
  if (note != null && String(note).length > MAX_NOTE) {
    return `note must be at most ${MAX_NOTE} characters`;
  }
  return null;
}

export function validatePaidBy(paidBy) {
  if (paidBy != null && String(paidBy).length > MAX_PAID_BY) {
    return `paid_by must be at most ${MAX_PAID_BY} characters`;
  }
  return null;
}
