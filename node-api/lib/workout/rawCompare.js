import {
  EXPECTED_RAW_ROUTINE_B_LITERAL,
  HEADER_FIELDS,
  SLOT_IDS,
  SLOT_LAYOUT,
  isUnreadableToken,
  toLiteralCell,
} from './rawSchema.js';

const FOCUS_GROUPS = ['pain', 'B01', 'B02', 'B04'];

export function cellPath(slotId, rowIndex, field) {
  return `${slotId}[${rowIndex}].${field}`;
}

export function getCell(raw, path) {
  if (!raw || typeof raw !== 'object') return undefined;
  if (HEADER_FIELDS.includes(path)) return raw[path];
  const match = path.match(/^(B\d{2})\[(\d+)\]\.(\w+)$/);
  if (!match) return undefined;
  const [, slotId, index, field] = match;
  const row = Array.isArray(raw[slotId]) ? raw[slotId][Number(index)] : undefined;
  if (!row || typeof row !== 'object') return undefined;
  return row[field];
}

export function listRawFieldPaths(raws = []) {
  const paths = [...HEADER_FIELDS];
  for (const slotId of SLOT_IDS) {
    const planned = SLOT_LAYOUT[slotId].planned;
    const extra = raws.reduce((max, raw) => {
      const len = Array.isArray(raw?.[slotId]) ? raw[slotId].length : 0;
      return Math.max(max, len);
    }, planned);
    for (let i = 0; i < extra; i += 1) {
      for (const field of SLOT_LAYOUT[slotId].fields) {
        paths.push(cellPath(slotId, i, field));
      }
    }
  }
  return paths;
}

export function groupForPath(path) {
  if (path === 'pain') return 'pain';
  const slot = path.match(/^(B\d{2})/);
  if (slot) return slot[1];
  return 'header';
}

export function normalizeCompareCell(value) {
  if (value === undefined) return undefined;
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value).trim();
  if (!text || isUnreadableToken(text)) return null;
  if (/^bw$/i.test(text) || /^body\s*wt$/i.test(text) || /^bodyweight$/i.test(text)) return 'BW';
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return text;
}

export function semanticCellEqual(a, b) {
  const na = normalizeCompareCell(a);
  const nb = normalizeCompareCell(b);
  if (na === undefined || nb === undefined) return false;
  if (na === nb) return true;
  if (typeof na === 'string' && typeof nb === 'string') {
    return na.toLowerCase() === nb.toLowerCase();
  }
  return false;
}

export function displayCell(value) {
  if (value === undefined) return '—';
  return toLiteralCell(value);
}

export function compareRawRuns(runs, expected = EXPECTED_RAW_ROUTINE_B_LITERAL) {
  const raws = runs.map((run) => (run && typeof run === 'object' ? run : null));
  const paths = listRawFieldPaths([expected, ...raws.filter(Boolean)]);
  const fields = paths.map((path) => {
    const expectedValue = getCell(expected, path);
    const values = raws.map((raw) => (raw ? getCell(raw, path) : undefined));
    const present = values.filter((value) => value !== undefined);
    const consistent = present.length === values.length
      && values.every((value) => semanticCellEqual(value, values[0]));
    const matchesExpected = values.map((value) => semanticCellEqual(value, expectedValue));
    return {
      path,
      group: groupForPath(path),
      expected: displayCell(expectedValue),
      runs: values.map(displayCell),
      consistent,
      matchesExpected,
      allMatchExpected: matchesExpected.length > 0 && matchesExpected.every(Boolean),
      anyMismatch: matchesExpected.some((ok) => !ok),
      focus: FOCUS_GROUPS.includes(groupForPath(path)),
    };
  });

  const mismatches = fields.filter((field) => field.anyMismatch);
  const consistentFields = fields.filter((field) => field.consistent);
  const focus = {};
  for (const group of FOCUS_GROUPS) {
    const groupFields = fields.filter((field) => field.group === group);
    focus[group] = {
      fieldCount: groupFields.length,
      consistent: groupFields.every((field) => field.consistent),
      allMatchExpected: groupFields.every((field) => field.allMatchExpected),
      mismatches: groupFields.filter((field) => field.anyMismatch).map((field) => field.path),
    };
  }

  return {
    fieldCount: fields.length,
    consistentCount: consistentFields.length,
    expectedMatchCount: fields.filter((field) => field.allMatchExpected).length,
    mismatches,
    focus,
    fields,
  };
}
