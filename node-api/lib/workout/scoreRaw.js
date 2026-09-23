import {
  EXPECTED_RAW_ROUTINE_B_LITERAL,
  SLOT_IDS,
  SLOT_LAYOUT,
} from './rawSchema.js';
import {
  compareRawRuns,
  getCell,
  listRawFieldPaths,
  semanticCellEqual,
} from './rawCompare.js';

export const BLANK_WEIGHT_PATHS = [
  'B01[1].weight',
  'B01[2].weight',
  'B02[1].weight',
  'B02[2].weight',
  'B04[1].weight',
  'B04[2].weight',
];

export const BW_PATHS = ['B01[0].weight', 'B04[0].weight'];

const B03_LEAK_WEIGHTS = new Set([40, 45]);
const B03_LEAK_REPS = new Set([8, 9]);

export function scoreRawTranscription(raw, expected = EXPECTED_RAW_ROUTINE_B_LITERAL) {
  const comparison = compareRawRuns([raw], expected);
  const fieldCount = comparison.fieldCount;
  const correct = comparison.fields.filter((field) => field.matchesExpected[0]).length;
  const mismatches = comparison.fields
    .filter((field) => !field.matchesExpected[0])
    .map((field) => ({
      path: field.path,
      expected: field.expected,
      actual: field.runs[0],
    }));

  const header = {
    date: headerFieldCorrect(raw, expected, 'date_written'),
    bodyweight: headerFieldCorrect(raw, expected, 'bodyweight'),
    effort: headerFieldCorrect(raw, expected, 'effort'),
    pain: headerFieldCorrect(raw, expected, 'pain'),
    note: headerFieldCorrect(raw, expected, 'note'),
  };

  const exercises = {};
  for (const slotId of SLOT_IDS) {
    exercises[slotId] = slotExact(raw, expected, slotId);
  }

  return {
    fieldCount,
    rawFieldsCorrect: correct,
    rawAccuracyPct: fieldCount === 0 ? 0 : Math.round((correct / fieldCount) * 1000) / 10,
    mismatches,
    header,
    exercises,
    difficult: {
      bw_recognition: featurePass(BW_PATHS, raw, expected),
      blank_weight_preservation: featurePass(BLANK_WEIGHT_PATHS, raw, expected),
      no_cross_table_leakage: !hasCrossTableLeakage(raw),
      printed_vs_handwritten: printedVsHandwrittenPass(raw, expected, header),
    },
    fields: comparison.fields,
  };
}

export function slotExact(raw, expected, slotId) {
  const layout = SLOT_LAYOUT[slotId];
  const actualRows = Array.isArray(raw?.[slotId]) ? raw[slotId] : [];
  if (actualRows.length > layout.planned) {
    const extras = actualRows.slice(layout.planned);
    const extraHasValues = extras.some((row) => row && layout.fields.some((field) => {
      const value = row[field];
      return value != null && String(value).trim() !== '';
    }));
    if (extraHasValues) return false;
  }
  for (let i = 0; i < layout.planned; i += 1) {
    for (const field of layout.fields) {
      const path = `${slotId}[${i}].${field}`;
      if (!semanticCellEqual(getCell(raw, path), getCell(expected, path))) return false;
    }
  }
  return true;
}

export function expectedFieldCount(expected = EXPECTED_RAW_ROUTINE_B_LITERAL) {
  return listRawFieldPaths([expected]).length;
}

function headerFieldCorrect(raw, expected, field) {
  return semanticCellEqual(raw?.[field], expected?.[field]);
}

function featurePass(paths, raw, expected) {
  return paths.every((path) => semanticCellEqual(getCell(raw, path), getCell(expected, path)));
}

function hasCrossTableLeakage(raw) {
  const b01 = Array.isArray(raw?.B01) ? raw.B01 : [];
  const b04 = Array.isArray(raw?.B04) ? raw.B04 : [];
  const b01Leak = b01.some((row) => {
    const weight = Number(row?.weight);
    const reps = Number(row?.reps);
    return B03_LEAK_WEIGHTS.has(weight) || B03_LEAK_REPS.has(reps);
  });
  const b04Leak = b04.some((row) => B03_LEAK_WEIGHTS.has(Number(row?.weight)));
  return b01Leak || b04Leak || b01.length > SLOT_LAYOUT.B01.planned;
}

function printedVsHandwrittenPass(raw, expected, header) {
  return header.effort
    && header.pain
    && featurePass(BLANK_WEIGHT_PATHS, raw, expected)
    && featurePass(BW_PATHS, raw, expected);
}
