export const ROUTINE_ID = 'B';

export const SLOT_LAYOUT = {
  B01: { kind: 'bilateral_reps', planned: 3, columns: 'Set / Weight / Reps', fields: ['weight', 'reps'] },
  B02: { kind: 'bilateral_reps', planned: 3, columns: 'Set / Weight / Reps', fields: ['weight', 'reps'] },
  B03: { kind: 'bilateral_reps', planned: 3, columns: 'Set / Weight / Reps', fields: ['weight', 'reps'] },
  B04: { kind: 'bilateral_reps', planned: 3, columns: 'Set / Weight / Reps', fields: ['weight', 'reps'] },
  B05: { kind: 'unilateral_reps', planned: 2, columns: 'Set / Weight / L / R', fields: ['weight', 'left', 'right'] },
  B06: { kind: 'bilateral_reps', planned: 2, columns: 'Set / Weight / Reps', fields: ['weight', 'reps'] },
  B07: { kind: 'unilateral_time', planned: 2, columns: 'Set / Weight / L sec / R sec', fields: ['weight', 'left_sec', 'right_sec'] },
};

export const SLOT_IDS = Object.keys(SLOT_LAYOUT);
export const HEADER_FIELDS = ['date_written', 'bodyweight', 'effort', 'pain', 'note'];
export const UNREADABLE_TOKEN = 'unreadable';

const bilateralSet = {
  type: 'object',
  additionalProperties: false,
  required: ['weight', 'reps'],
  properties: {
    weight: { type: ['number', 'string', 'null'] },
    reps: { type: ['integer', 'null'] },
  },
};

const unilateralRepSet = {
  type: 'object',
  additionalProperties: false,
  required: ['weight', 'left', 'right'],
  properties: {
    weight: { type: ['number', 'string', 'null'] },
    left: { type: ['integer', 'null'] },
    right: { type: ['integer', 'null'] },
  },
};

const unilateralTimeSet = {
  type: 'object',
  additionalProperties: false,
  required: ['weight', 'left_sec', 'right_sec'],
  properties: {
    weight: { type: ['number', 'string', 'null'] },
    left_sec: { type: ['number', 'null'] },
    right_sec: { type: ['number', 'null'] },
  },
};

export const RAW_TRANSCRIPTION_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Routine B raw handwritten extraction',
  type: 'object',
  additionalProperties: false,
  required: ['date_written', 'bodyweight', 'effort', 'pain', 'note', ...SLOT_IDS],
  properties: {
    date_written: { type: ['string', 'null'] },
    bodyweight: { type: ['number', 'null'] },
    effort: { type: ['integer', 'null'], minimum: 1, maximum: 5 },
    pain: { type: ['integer', 'null'], minimum: 0, maximum: 3 },
    note: { type: ['string', 'null'] },
    B01: { type: 'array', items: bilateralSet },
    B02: { type: 'array', items: bilateralSet },
    B03: { type: 'array', items: bilateralSet },
    B04: { type: 'array', items: bilateralSet },
    B05: { type: 'array', items: unilateralRepSet },
    B06: { type: 'array', items: bilateralSet },
    B07: { type: 'array', items: unilateralTimeSet },
  },
};

export const HEADER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['date_written', 'bodyweight', 'effort', 'pain'],
  properties: {
    date_written: { type: ['string', 'null'] },
    bodyweight: { type: ['number', 'null'] },
    effort: { type: ['integer', 'null'], minimum: 1, maximum: 5 },
    pain: { type: ['integer', 'null'], minimum: 0, maximum: 3 },
  },
};

export const NOTE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['note'],
  properties: {
    note: { type: ['string', 'null'] },
  },
};

export function slotSchema(slotId) {
  const layout = SLOT_LAYOUT[slotId];
  const items = layout.kind === 'unilateral_reps'
    ? unilateralRepSet
    : layout.kind === 'unilateral_time'
      ? unilateralTimeSet
      : bilateralSet;
  return {
    type: 'object',
    additionalProperties: false,
    required: ['rows'],
    properties: {
      rows: { type: 'array', maxItems: layout.planned, items },
    },
  };
}

export const EXPECTED_RAW_ROUTINE_B = {
  date_written: '4-12',
  bodyweight: 192,
  effort: 5,
  pain: 1,
  note: 'Went easy on left leg',
  B01: [
    { weight: 'BW', reps: 10 },
    { weight: null, reps: 10 },
    { weight: null, reps: 10 },
  ],
  B02: [
    { weight: 25, reps: 10 },
    { weight: null, reps: 10 },
    { weight: null, reps: 10 },
  ],
  B03: [
    { weight: 40, reps: 10 },
    { weight: 40, reps: 8 },
    { weight: 45, reps: 9 },
  ],
  B04: [
    { weight: 'BW', reps: 15 },
    { weight: null, reps: 15 },
    { weight: null, reps: 15 },
  ],
  B05: [
    { weight: 10, left: 4, right: 8 },
    { weight: 10, left: 3, right: 7 },
  ],
  B06: [
    { weight: 40, reps: 15 },
    { weight: 30, reps: 15 },
  ],
  B07: [
    { weight: 25, left_sec: 45, right_sec: 45 },
    { weight: 35, left_sec: 45, right_sec: 45 },
  ],
};

const literalCell = { type: ['string', 'null'] };

const literalBilateralSet = {
  type: 'object',
  additionalProperties: false,
  required: ['weight', 'reps'],
  properties: {
    weight: literalCell,
    reps: literalCell,
  },
};

const literalUnilateralRepSet = {
  type: 'object',
  additionalProperties: false,
  required: ['weight', 'left', 'right'],
  properties: {
    weight: literalCell,
    left: literalCell,
    right: literalCell,
  },
};

const literalUnilateralTimeSet = {
  type: 'object',
  additionalProperties: false,
  required: ['weight', 'left_sec', 'right_sec'],
  properties: {
    weight: literalCell,
    left_sec: literalCell,
    right_sec: literalCell,
  },
};

function literalSlotArray(kind, planned) {
  const items = kind === 'unilateral_reps'
    ? literalUnilateralRepSet
    : kind === 'unilateral_time'
      ? literalUnilateralTimeSet
      : literalBilateralSet;
  return { type: 'array', minItems: planned, maxItems: planned, items };
}

export const LITERAL_RAW_TRANSCRIPTION_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Routine B literal handwritten cells',
  type: 'object',
  additionalProperties: false,
  required: [...HEADER_FIELDS, ...SLOT_IDS],
  properties: {
    date_written: literalCell,
    bodyweight: literalCell,
    effort: literalCell,
    pain: literalCell,
    note: literalCell,
    B01: literalSlotArray('bilateral_reps', 3),
    B02: literalSlotArray('bilateral_reps', 3),
    B03: literalSlotArray('bilateral_reps', 3),
    B04: literalSlotArray('bilateral_reps', 3),
    B05: literalSlotArray('unilateral_reps', 2),
    B06: literalSlotArray('bilateral_reps', 2),
    B07: literalSlotArray('unilateral_time', 2),
  },
};

export function toLiteralCell(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  const text = String(value).trim();
  return text ? text : null;
}

export function toLiteralRaw(raw) {
  const out = {};
  for (const field of HEADER_FIELDS) {
    out[field] = toLiteralCell(raw?.[field]);
  }
  for (const slotId of SLOT_IDS) {
    const layout = SLOT_LAYOUT[slotId];
    const rows = Array.isArray(raw?.[slotId]) ? raw[slotId] : [];
    out[slotId] = [];
    for (let i = 0; i < layout.planned; i += 1) {
      const row = rows[i] && typeof rows[i] === 'object' ? rows[i] : {};
      const literalRow = {};
      for (const field of layout.fields) {
        literalRow[field] = toLiteralCell(row[field]);
      }
      out[slotId].push(literalRow);
    }
  }
  return out;
}

export const EXPECTED_RAW_ROUTINE_B_LITERAL = toLiteralRaw(EXPECTED_RAW_ROUTINE_B);

export function isUnreadableToken(value) {
  if (value == null) return false;
  const text = String(value).trim().toLowerCase();
  return text === UNREADABLE_TOKEN || text === 'uncertain' || text === '?';
}
