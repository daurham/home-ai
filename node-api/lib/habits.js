const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

function normalizeCompletions(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [date, done] of Object.entries(raw)) {
    if (DATE_RE.test(date) && done) out[date] = true;
  }
  return out;
}

/** API/body (camelCase) -> row values ready for INSERT/UPDATE. */
export function normalizeHabitInput(body = {}, { partial = false } = {}) {
  const errors = [];
  const out = {};

  if (!partial || body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) errors.push('name is required');
    else out.name = name;
  }

  if (!partial || body.completions !== undefined) {
    out.completions = normalizeCompletions(body.completions);
  }

  if (!partial || body.createdAt !== undefined || body.created_at !== undefined) {
    const created = body.createdAt ?? body.created_at;
    if (created) out.created_at = created;
  }

  if (body.id != null) {
    if (!isUuid(body.id)) errors.push('id must be a UUID');
    else out.id = body.id;
  }

  return { value: out, error: errors[0] || null };
}

export function rowToHabit(row) {
  return {
    id: row.id,
    name: row.name,
    completions: normalizeCompletions(row.completions),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}
