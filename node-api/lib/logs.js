const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const MAX_LOG_BODY = 2000;
export const MAX_BOOK_NAME = 40;
export const MAX_AMOUNT_CENTS = 999_999_999;

export function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function slugify(name) {
  const slug = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'log';
}

export function isValidOccurredOn(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const asUtc = new Date(Date.UTC(year, month - 1, day));
  return asUtc.getUTCFullYear() === year && asUtc.getUTCMonth() + 1 === month && asUtc.getUTCDate() === day;
}

export function normalizeBookInput(body = {}, { partial = false } = {}) {
  const errors = [];
  const out = {};

  if (!partial || body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) errors.push('name is required');
    else if (name.length > MAX_BOOK_NAME) errors.push(`name must be ${MAX_BOOK_NAME} characters or fewer`);
    else {
      out.name = name;
      out.slug = slugify(name);
    }
  }

  return { value: out, error: errors[0] || null };
}

function parseOptionalAmountCents(body) {
  if (body.amountCents === null || body.amount_cents === null) return { value: null };
  if (body.amountCents !== undefined) {
    const n = Number(body.amountCents);
    if (!Number.isInteger(n) || n <= 0) return { error: 'amountCents must be a positive integer' };
    if (n > MAX_AMOUNT_CENTS) return { error: 'amount is too large' };
    return { value: n };
  }
  if (body.amount_cents !== undefined) {
    const n = Number(body.amount_cents);
    if (!Number.isInteger(n) || n <= 0) return { error: 'amount_cents must be a positive integer' };
    if (n > MAX_AMOUNT_CENTS) return { error: 'amount is too large' };
    return { value: n };
  }
  if (body.amount !== undefined && body.amount !== null && body.amount !== '') {
    const n = Number(body.amount);
    if (!Number.isFinite(n) || n <= 0) return { error: 'amount must be a positive number' };
    const cents = Math.round(n * 100);
    if (cents > MAX_AMOUNT_CENTS) return { error: 'amount is too large' };
    return { value: cents };
  }
  return { value: undefined };
}

export function normalizeEntryInput(body = {}, { partial = false } = {}) {
  const errors = [];
  const out = {};

  const occurredOn = body.occurredOn ?? body.occurred_on;
  if (!partial || occurredOn !== undefined) {
    if (!isValidOccurredOn(occurredOn)) errors.push('occurredOn must be a valid YYYY-MM-DD date');
    else if (occurredOn < '2000-01-01') errors.push('occurredOn is too far in the past');
    else out.occurred_on = occurredOn;
  }

  if (!partial || body.body !== undefined) {
    const text = typeof body.body === 'string' ? body.body.trim() : '';
    if (!text) errors.push('body is required');
    else if (text.length > MAX_LOG_BODY) errors.push(`body must be ${MAX_LOG_BODY} characters or fewer`);
    else out.body = text;
  }

  const amount = parseOptionalAmountCents(body);
  if (amount.error) errors.push(amount.error);
  else if (!partial || amount.value !== undefined) {
    if (amount.value !== undefined) out.amount_cents = amount.value;
  }

  return { value: out, error: errors[0] || null };
}

export function rowToBook(row) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    sortOrder: row.sort_order,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

export function rowToEntry(row) {
  return {
    id: row.id,
    bookId: row.book_id,
    occurredOn: row.occurred_on instanceof Date
      ? row.occurred_on.toISOString().slice(0, 10)
      : String(row.occurred_on).slice(0, 10),
    body: row.body,
    amountCents: row.amount_cents == null ? null : Number(row.amount_cents),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}
