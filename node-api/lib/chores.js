const ICONS = new Set(['bins', 'vacuum', 'bath', 'plants', 'laundry', 'kitchen', 'pets', 'generic']);
const UNITS = new Set(['days', 'weeks', 'months']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function normalizeOccurrences(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [occurrence, completedOn] of Object.entries(raw)) {
    if (DATE_RE.test(occurrence) && typeof completedOn === 'string' && DATE_RE.test(completedOn)) {
      out[occurrence] = completedOn;
    }
  }
  return out;
}

function dateOrNull(value) {
  if (value == null || value === '') return null;
  const text = typeof value === 'string' ? value.slice(0, 10) : value;
  if (typeof text === 'string' && DATE_RE.test(text)) return text;
  if (text instanceof Date && Number.isFinite(text.getTime())) {
    return text.toISOString().slice(0, 10);
  }
  return null;
}

/** API/body (camelCase) -> row values ready for INSERT/UPDATE. */
export function normalizeChoreInput(body = {}, { partial = false } = {}) {
  const errors = [];
  const out = {};

  if (!partial || body.title !== undefined) {
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) errors.push('title is required');
    else out.title = title;
  }

  if (!partial || body.assignee !== undefined) {
    out.assignee = typeof body.assignee === 'string' ? body.assignee.trim() : '';
  }

  if (!partial || body.every !== undefined) {
    out.every = clampInt(body.every, 1, 365, 1);
  }

  if (!partial || body.unit !== undefined) {
    const unit = body.unit;
    if (unit != null && !UNITS.has(unit)) errors.push('unit must be days, weeks, or months');
    else out.unit = UNITS.has(unit) ? unit : 'days';
  }

  if (!partial || body.weekday !== undefined) {
    out.weekday = clampInt(body.weekday, 0, 6, 0);
  }

  if (!partial || body.monthDay !== undefined || body.month_day !== undefined) {
    out.month_day = clampInt(body.monthDay ?? body.month_day, 1, 28, 1);
  }

  if (!partial || body.icon !== undefined) {
    out.icon = ICONS.has(body.icon) ? body.icon : 'generic';
  }

  if (!partial || body.daySpecific !== undefined || body.day_specific !== undefined) {
    out.day_specific = Boolean(body.daySpecific ?? body.day_specific);
  }

  if (!partial || body.lastCompletedOn !== undefined || body.last_completed_on !== undefined) {
    const raw = body.lastCompletedOn ?? body.last_completed_on;
    if (raw != null && raw !== '' && !dateOrNull(raw)) errors.push('lastCompletedOn must be YYYY-MM-DD');
    else out.last_completed_on = dateOrNull(raw);
  }

  if (!partial || body.completedOccurrences !== undefined || body.completed_occurrences !== undefined) {
    out.completed_occurrences = normalizeOccurrences(
      body.completedOccurrences ?? body.completed_occurrences,
    );
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

/** Postgres row -> dashboard chore. */
export function rowToChore(row) {
  const last = row.last_completed_on;
  return {
    id: row.id,
    title: row.title,
    assignee: row.assignee || '',
    every: row.every,
    unit: row.unit,
    weekday: row.weekday,
    monthDay: row.month_day,
    icon: row.icon,
    daySpecific: Boolean(row.day_specific),
    lastCompletedOn: last ? String(last).slice(0, 10) : null,
    completedOccurrences: normalizeOccurrences(row.completed_occurrences),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}
