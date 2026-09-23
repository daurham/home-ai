import fs from 'node:fs';
import path from 'node:path';
import { DETECT_PY, DETECTOR_CONFIG_PATH } from './poc7/index.js';
import { DETECTOR_VERSION, FROZEN_DETECTOR_SHA256, sha256File } from './poc7b.js';
import { DETECT_PY_SHA256, loadJson, numericKindFromFieldId, templatePathForId } from './poc8.js';
import { loadPoc8bRows } from './poc8c.js';
import {
  ISSUE,
  PAPER,
  RECOGNITION,
  finalizeReview,
  ingestRawObservations,
  measurementSpecForExercise,
  parseSetFieldId,
  resolveTranscription,
  slotMapForRoutine,
} from './poc9.js';
import { loadWorkoutConfig } from './config.js';
import { DATE_PARSE, parseDateLiteral } from './dateParser.js';
import {
  resolveHeaders,
  toV131Canonical,
} from './poc10.js';
import { loadV131WorkoutConfig } from './v131Config.js';
import { validateWorkoutSchema } from './schemaValidator.js';
import { validateWorkoutSemanticsV13 } from './semanticValidatorV13.js';
import { BLOCKING_ISSUE_CODES, evaluateSaveReadiness } from './saveGate.js';
import {
  POC11_ARTIFACT_DIR,
  POC11_BLIND_DIR,
  TEMPLATE_SPECS,
} from './poc11.js';

export const EXPECTED_BLIND_SHA256 = 'd62637ff535cb6f95d8929a8dff86212c9ee2c9aa1b69eef73638db0016867b6';
export const POC11_GT_PATH = path.join(POC11_ARTIFACT_DIR, 'ground-truth.json');

const EFFORT_IDS = ['header.effort.1', 'header.effort.2', 'header.effort.3', 'header.effort.4', 'header.effort.5'];
const PAIN_IDS = ['header.pain.0', 'header.pain.1', 'header.pain.2', 'header.pain.3'];
const OPTIONAL_TEXT = ['header.pain_area', 'note.quick_note'];
const HEADER_NUMERIC = ['header.bodyweight', 'header.duration'];

function np(slot, n) {
  return {
    slot_id: slot,
    set_number: n,
    performed: false,
    bw: 'unchecked',
    load_paper: 'blank',
    load: null,
    measurements: {},
  };
}
function bwSet(slot, n, measurements = {}) {
  return {
    slot_id: slot,
    set_number: n,
    performed: true,
    bw: 'checked',
    load_paper: 'blank',
    load: null,
    measurements,
  };
}
function blankLoad(slot, n, measurements = {}) {
  return {
    slot_id: slot,
    set_number: n,
    performed: true,
    bw: 'unchecked',
    load_paper: 'blank',
    load: null,
    measurements,
  };
}
function explicit(slot, n, load, measurements = {}) {
  return {
    slot_id: slot,
    set_number: n,
    performed: true,
    bw: 'unchecked',
    load_paper: 'explicit',
    load,
    measurements,
  };
}

function header({
  date_literal,
  bodyweight = null,
  duration = null,
  effort = null,
  pain = null,
  pain_area = null,
  quick_note = null,
}) {
  return {
    date_literal,
    bodyweight,
    duration,
    effort,
    pain,
    pain_area: pain_area == null
      ? { paper: 'blank', literal: null }
      : { paper: 'nonblank', literal: String(pain_area) },
    quick_note: quick_note == null
      ? { paper: 'blank', literal: null }
      : { paper: 'nonblank', literal: String(quick_note) },
  };
}

export const HUMAN_APPROVED_GT = {
  approved: true,
  source: 'human-reviewed physical/photo forms for POC #11 Phase 2',
  sheets: [
    {
      photo_id: 'IMG_1326',
      routine: 'C',
      template_id: 'C-1.3.1',
      header: header({ date_literal: '9/20/26', effort: 1, pain: 2 }),
      sets: [
        bwSet('C01', 1, { reps: 10 }), blankLoad('C01', 2, { reps: 10 }), explicit('C01', 3, 25, { reps: 8 }),
        explicit('C02', 1, 35, { reps: 10 }), blankLoad('C02', 2, { reps: 12 }), blankLoad('C02', 3, { reps: 10 }),
        explicit('C03', 1, 20, { reps: 12 }), explicit('C03', 2, 40, { reps: 12 }), explicit('C03', 3, 60, { reps: 10 }),
        explicit('C04', 1, 20, { reps: 10 }), explicit('C04', 2, 25, { reps: 10 }), explicit('C04', 3, 30, { reps: 10 }),
        explicit('C05', 1, 35, { left: 12, right: 12 }), blankLoad('C05', 2, { left: 10, right: 9 }),
        np('C06', 1), np('C06', 2),
        explicit('C07', 1, 50, { seconds: 45 }), blankLoad('C07', 2, { seconds: 30 }),
      ],
    },
    {
      photo_id: 'IMG_1327',
      routine: 'C',
      template_id: 'C-1.3.1',
      header: header({
        date_literal: '9-20', bodyweight: 182, duration: 42, effort: 5, pain: 3, pain_area: 'Leg',
      }),
      sets: [
        bwSet('C01', 1), bwSet('C01', 2), bwSet('C01', 3),
        explicit('C02', 1, 45, { reps: 8 }), explicit('C02', 2, 50, { reps: 10 }), explicit('C02', 3, 55, { reps: 12 }),
        explicit('C03', 1, 50, { reps: 12 }), explicit('C03', 2, 50, { reps: 12 }), explicit('C03', 3, 60, { reps: 10 }),
        bwSet('C04', 1, { reps: 10 }), explicit('C04', 2, 20, { reps: 8 }), explicit('C04', 3, 30, { reps: 5 }),
        np('C05', 1), np('C05', 2),
        explicit('C06', 1, 20, { reps: 10 }), explicit('C06', 2, 25, { reps: 15 }),
        explicit('C07', 1, 35, { seconds: 30 }), explicit('C07', 2, 50, { seconds: 45 }),
      ],
    },
    {
      photo_id: 'IMG_1328',
      routine: 'A',
      template_id: 'A-1.3.1',
      header: header({
        date_literal: '9/20', bodyweight: 190, effort: null, pain: 0, quick_note: 'Arm',
      }),
      sets: [
        bwSet('A01', 1, { reps: 10 }), blankLoad('A01', 2, { reps: 10 }), blankLoad('A01', 3, { reps: 10 }),
        explicit('A02', 1, 105, { reps: 6 }), blankLoad('A02', 2, { reps: 6 }), explicit('A02', 3, 110, { reps: 5 }),
        explicit('A03', 1, 50, { reps: 12 }), blankLoad('A03', 2, { reps: 12 }), explicit('A03', 3, 60, { reps: 12 }),
        explicit('A04', 1, 50, { reps: 10 }), blankLoad('A04', 2, { reps: 10 }), blankLoad('A04', 3, { reps: 8 }),
        explicit('A05', 1, 35, { reps: 20 }), blankLoad('A05', 2, { reps: 5 }),
        explicit('A06', 1, 20, { reps: 15 }), explicit('A06', 2, 15, { reps: 10 }),
        explicit('A07', 1, 50, { seconds: 30 }), explicit('A07', 2, 45, { seconds: 45 }),
      ],
    },
    {
      photo_id: 'IMG_1330',
      routine: 'A',
      template_id: 'A-1.3.1',
      header: header({
        date_literal: '9/1/26', bodyweight: 201, duration: 73, effort: 4, pain: 2, pain_area: 'Arm',
      }),
      sets: [
        bwSet('A01', 1, { reps: 6 }), blankLoad('A01', 2, { reps: 7 }), explicit('A01', 3, 10, { reps: 8 }),
        explicit('A02', 1, 45, { reps: 15 }), explicit('A02', 2, 95, { reps: 6 }), explicit('A02', 3, 95, { reps: 5 }),
        explicit('A03', 1, 40, { reps: 4 }), explicit('A03', 2, 35, { reps: 8 }), explicit('A03', 3, 25, { reps: 10 }),
        bwSet('A04', 1, { reps: 10 }), explicit('A04', 2, 30, { reps: 10 }), explicit('A04', 3, 25, { reps: 12 }),
        explicit('A05', 1, 10, { reps: 15 }), explicit('A05', 2, 15, { reps: 12 }),
        explicit('A06', 1, 40, { reps: 15 }), blankLoad('A06', 2, { reps: 8 }),
        explicit('A07', 1, 15, { seconds: 45 }), blankLoad('A07', 2, { seconds: 30 }),
      ],
    },
    {
      photo_id: 'IMG_1331',
      routine: 'B',
      template_id: 'B-1.3.1',
      header: header({
        date_literal: '9-19-26', effort: 5, pain: 0, quick_note: 'None',
      }),
      sets: [
        bwSet('B01', 1, { reps: 12 }), explicit('B01', 2, 20, { reps: 10 }), explicit('B01', 3, 20, { reps: 8 }),
        explicit('B02', 1, 50, { reps: 10 }), blankLoad('B02', 2, { reps: 10 }), blankLoad('B02', 3, { reps: 12 }),
        explicit('B03', 1, 50, { reps: 12 }), explicit('B03', 2, 45, { reps: 10 }), explicit('B03', 3, 30, { reps: 8 }),
        bwSet('B04', 1, { reps: 15 }), explicit('B04', 2, 10, { reps: 15 }), explicit('B04', 3, 20, { reps: 10 }),
        bwSet('B05', 1, { left: 8, right: 5 }), blankLoad('B05', 2, { left: 8, right: 5 }),
        explicit('B06', 1, 15, { reps: 15 }), explicit('B06', 2, 20, { reps: 12 }),
        explicit('B07', 1, 45, { left_seconds: 45, right_seconds: 45 }),
        explicit('B07', 2, 30, { left_seconds: 45, right_seconds: 30 }),
      ],
    },
    {
      photo_id: 'IMG_1332',
      routine: 'B',
      template_id: 'B-1.3.1',
      header: header({
        date_literal: '9-21-26', bodyweight: 180, effort: 1, pain: 2, pain_area: 'None',
      }),
      sets: [
        explicit('B01', 1, 15, { reps: 10 }), blankLoad('B01', 2, { reps: 10 }), blankLoad('B01', 3, { reps: 9 }),
        explicit('B02', 1, 40, { reps: 12 }), blankLoad('B02', 2, { reps: 10 }), blankLoad('B02', 3, { reps: 8 }),
        explicit('B03', 1, 50, { reps: 9 }), blankLoad('B03', 2, { reps: 9 }), blankLoad('B03', 3, { reps: 9 }),
        bwSet('B04', 1, { reps: 15 }), blankLoad('B04', 2, { reps: 12 }), np('B04', 3),
        bwSet('B05', 1, { left: 7, right: 8 }), explicit('B05', 2, 10, { left: 6, right: 9 }),
        explicit('B06', 1, 20, { reps: 10 }), blankLoad('B06', 2, { reps: 10 }),
        np('B07', 1), np('B07', 2),
      ],
    },
  ],
};

export function verifyBlindChecksum() {
  const resultsPath = path.join(POC11_BLIND_DIR, 'blind-results.json');
  const shaPath = path.join(POC11_BLIND_DIR, 'blind-results.sha256');
  if (!fs.existsSync(resultsPath) || !fs.existsSync(shaPath)) {
    throw new Error('Phase 1 blind artifacts missing');
  }
  const fileHash = sha256File(resultsPath);
  const recorded = fs.readFileSync(shaPath, 'utf8').trim();
  return {
    ok: fileHash === EXPECTED_BLIND_SHA256 && recorded === EXPECTED_BLIND_SHA256,
    fileHash,
    recorded,
    expected: EXPECTED_BLIND_SHA256,
  };
}

function templateFor(templateId) {
  return loadJson(templatePathForId(templateId));
}

function setKey(slot, n) {
  return `${slot}.S${n}`;
}

function sheetByPhoto(gt = HUMAN_APPROVED_GT) {
  return Object.fromEntries(gt.sheets.map((s) => [s.photo_id, s]));
}

function expandPaper(sheet) {
  const template = templateFor(sheet.template_id);
  const setMap = Object.fromEntries(sheet.sets.map((s) => [setKey(s.slot_id, s.set_number), s]));
  const checkboxes = {};
  const fields = {};
  const writtenNumeric = [];

  for (const id of EFFORT_IDS) {
    const n = Number(id.slice(-1));
    checkboxes[id] = sheet.header.effort === n ? 'checked' : 'unchecked';
  }
  for (const id of PAIN_IDS) {
    const n = Number(id.slice(-1));
    checkboxes[id] = sheet.header.pain === n ? 'checked' : 'unchecked';
  }

  fields['header.date'] = 'nonblank';
  fields['header.bodyweight'] = sheet.header.bodyweight == null ? 'blank' : 'nonblank';
  fields['header.duration'] = sheet.header.duration == null ? 'blank' : 'nonblank';
  fields['header.pain_area'] = sheet.header.pain_area.paper;
  fields['note.quick_note'] = sheet.header.quick_note.paper;
  if (sheet.header.bodyweight != null) {
    writtenNumeric.push({ field_id: 'header.bodyweight', kind: 'bodyweight', value: String(sheet.header.bodyweight) });
  }
  if (sheet.header.duration != null) {
    writtenNumeric.push({ field_id: 'header.duration', kind: 'duration', value: String(sheet.header.duration) });
  }

  for (const field of template.fields || []) {
    const parsed = parseSetFieldId(field.id);
    if (!parsed) continue;
    const row = setMap[setKey(parsed.slotId, parsed.setNumber)];
    if (!row) continue;
    if (parsed.kind === 'BW') {
      checkboxes[field.id] = row.bw;
      continue;
    }
    if (parsed.kind === 'load') {
      const nonblank = row.performed && row.load_paper === 'explicit';
      fields[field.id] = nonblank ? 'nonblank' : 'blank';
      if (nonblank) writtenNumeric.push({ field_id: field.id, kind: 'load', value: String(row.load) });
      continue;
    }
    const written = row.performed && row.measurements[parsed.kind] != null;
    fields[field.id] = written ? 'nonblank' : 'blank';
    if (written) {
      writtenNumeric.push({
        field_id: field.id,
        kind: parsed.kind,
        value: String(row.measurements[parsed.kind]),
      });
    }
  }

  return { checkboxes, fields, writtenNumeric, setMap, template };
}

function expectedResolvedFromPaper(sheet) {
  const expanded = expandPaper(sheet);
  const detector = { checkboxes: {}, fields: {} };
  for (const [id, state] of Object.entries(expanded.checkboxes)) {
    detector.checkboxes[id] = { state };
  }
  for (const [id, state] of Object.entries(expanded.fields)) {
    detector.fields[id] = { state };
  }
  const granite = new Map();
  for (const row of expanded.writtenNumeric) {
    if (row.field_id.startsWith('header.')) continue;
    granite.set(`${sheet.photo_id}::${row.field_id}`, { clean: row.value });
  }
  const raw = ingestRawObservations({
    photoId: sheet.photo_id,
    sheetId: sheet.photo_id,
    templateId: sheet.template_id,
    detectorObservations: detector,
    graniteByField: granite,
  });
  const headerLiterals = { 'header.date': sheet.header.date_literal };
  if (sheet.header.bodyweight != null) headerLiterals['header.bodyweight'] = String(sheet.header.bodyweight);
  if (sheet.header.duration != null) headerLiterals['header.duration'] = String(sheet.header.duration);
  const resolved = resolveTranscription(raw);
  const header = resolveHeaders(raw, headerLiterals);
  const review = finalizeReview([...resolved.issues_during_resolution, ...header.issues]);
  const canonical = toV131Canonical(resolved, review.status, header);
  const config = loadV131WorkoutConfig();
  const schema = validateWorkoutSchema(canonical, config.schema);
  const semantic = validateWorkoutSemanticsV13(canonical, { review, config });
  const save = evaluateSaveReadiness({ schema, semantic, review, canonical });
  return {
    expanded,
    resolved,
    header,
    review,
    canonical,
    schema,
    semantic,
    save,
  };
}

function loadFrozenPhoto(photoId) {
  const dir = path.join(POC11_BLIND_DIR, photoId);
  const photo = loadJson(path.join(dir, 'photo-result.json'));
  const observations = fs.existsSync(path.join(dir, 'observations.json'))
    ? loadJson(path.join(dir, 'observations.json'))
    : null;
  const numeric = fs.existsSync(path.join(dir, 'numeric-recognition.json'))
    ? loadJson(path.join(dir, 'numeric-recognition.json'))
    : { results: [] };
  const headerRec = fs.existsSync(path.join(dir, 'header-recognition.json'))
    ? loadJson(path.join(dir, 'header-recognition.json'))
    : { results: [] };
  const canonical = fs.existsSync(path.join(dir, 'canonical-candidate.json'))
    ? loadJson(path.join(dir, 'canonical-candidate.json'))
    : null;
  const gate = fs.existsSync(path.join(dir, 'review-save-gate.json'))
    ? loadJson(path.join(dir, 'review-save-gate.json'))
    : null;
  const resolved = fs.existsSync(path.join(dir, 'resolved-transcription.json'))
    ? loadJson(path.join(dir, 'resolved-transcription.json'))
    : null;
  return { photo, observations, numeric, headerRec, canonical, gate, resolved };
}

function checkboxScore(gtMap, obsMap) {
  const rows = [];
  let correct = 0;
  let falseChecked = 0;
  let falseUnchecked = 0;
  let uncertain = 0;
  for (const [id, expected] of Object.entries(gtMap)) {
    const got = obsMap?.[id]?.state || 'missing';
    let status = 'correct';
    if (got === 'uncertain') {
      uncertain += 1;
      status = 'uncertain';
    } else if (got === expected) {
      correct += 1;
    } else if (expected === 'unchecked' && got === 'checked') {
      falseChecked += 1;
      status = 'false_checked';
    } else if (expected === 'checked' && got === 'unchecked') {
      falseUnchecked += 1;
      status = 'false_unchecked';
    } else {
      status = `mismatch:${got}`;
    }
    rows.push({ field_id: id, expected, observed: got, status });
  }
  return {
    total: rows.length,
    correct,
    false_checked: falseChecked,
    false_unchecked: falseUnchecked,
    uncertain,
    accuracy: rows.length ? correct / rows.length : 0,
    rows,
  };
}

function blankScore(gtMap, obsMap) {
  const rows = [];
  let correct = 0;
  let falseBlank = 0;
  let falseNonblank = 0;
  let uncertain = 0;
  let expectedBlank = 0;
  let expectedNonblank = 0;
  let blankCorrect = 0;
  let nonblankCorrect = 0;
  for (const [id, expected] of Object.entries(gtMap)) {
    const got = obsMap?.[id]?.state || 'missing';
    if (expected === 'blank') expectedBlank += 1;
    if (expected === 'nonblank') expectedNonblank += 1;
    let status = 'correct';
    if (got === 'uncertain') {
      uncertain += 1;
      status = 'uncertain';
    } else if (got === expected) {
      correct += 1;
      if (expected === 'blank') blankCorrect += 1;
      if (expected === 'nonblank') nonblankCorrect += 1;
    } else if (expected === 'nonblank' && got === 'blank') {
      falseBlank += 1;
      status = 'false_blank';
    } else if (expected === 'blank' && got === 'nonblank') {
      falseNonblank += 1;
      status = 'false_nonblank';
    } else {
      status = `mismatch:${got}`;
    }
    rows.push({ field_id: id, expected, observed: got, status });
  }
  return {
    total: rows.length,
    correct,
    false_blank: falseBlank,
    false_nonblank: falseNonblank,
    uncertain,
    expected_blank: expectedBlank,
    expected_nonblank: expectedNonblank,
    blank_specificity: expectedBlank ? blankCorrect / expectedBlank : 1,
    nonblank_recall: expectedNonblank ? nonblankCorrect / expectedNonblank : 1,
    accuracy: rows.length ? correct / rows.length : 0,
    rows,
  };
}

function numericKindLabel(kind) {
  if (kind === 'left') return 'left_reps';
  if (kind === 'right') return 'right_reps';
  if (kind === 'left_seconds') return 'left_seconds';
  if (kind === 'right_seconds') return 'right_seconds';
  return kind;
}

function issuesForField(issues, fieldId) {
  return (issues || []).filter((i) => i.field_id === fieldId
    || (fieldId.startsWith('header.effort') && i.field_id === 'header.effort')
    || (fieldId.startsWith('header.pain') && i.field_id === 'header.pain'));
}

function classifyNumeric(gtValue, recognized) {
  if (recognized == null || recognized === '' || recognized === 'BLANK') return 'UNKNOWN';
  if (recognized === 'UNKNOWN') return 'UNKNOWN';
  if (String(recognized) === String(gtValue)) return 'exact';
  if (!/^\d+$/.test(String(recognized))) return 'UNKNOWN';
  return 'wrong';
}

function canonicalSetMap(canonical) {
  const map = new Map();
  for (const ex of canonical?.workout?.exercises || []) {
    for (const set of ex.sets || []) {
      map.set(`${ex.slot_id}.S${set.set_number}`, { exercise: ex, set });
    }
  }
  return map;
}

function setSignature(set) {
  if (!set) return null;
  const meas = {};
  for (const key of ['reps', 'left_reps', 'right_reps', 'duration_sec', 'left_duration_sec', 'right_duration_sec']) {
    if (set[key] != null) meas[key] = set[key];
  }
  return {
    load_state: set.load_state,
    weight_lb: set.weight_lb,
    measurements: meas,
  };
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

export function writeGroundTruthArtifact(gt = HUMAN_APPROVED_GT) {
  const sheets = gt.sheets.map((sheet) => {
    const expected = expectedResolvedFromPaper(sheet);
    const parsedDate = parseDateLiteral(sheet.header.date_literal);
    const resolvedSets = [];
    for (const ex of expected.resolved.exercises || []) {
      for (const set of ex.sets || []) {
        resolvedSets.push({
          slot_id: ex.slot_id,
          set_number: set.set_number,
          load_state: set.load_state,
          weight_lb: set.weight_lb,
          measurements: set.measurements,
          load_provenance: set.load_provenance,
        });
      }
    }
    const omitted = sheet.sets.filter((s) => !s.performed).map((s) => ({
      slot_id: s.slot_id,
      set_number: s.set_number,
      reason: 'NOT_PERFORMED',
    }));
    return {
      photo_id: sheet.photo_id,
      routine: sheet.routine,
      template_id: sheet.template_id,
      header: sheet.header,
      paper_sets: sheet.sets,
      expected_date: {
        literal: sheet.header.date_literal,
        status: parsedDate.status,
        iso: parsedDate.iso,
      },
      paper_fields: expected.expanded,
      expected_resolved_sets: resolvedSets,
      expected_omitted_rows: omitted,
      expected_canonical: expected.canonical,
      expected_review: expected.review,
      expected_save: expected.save,
      expected_schema_valid: expected.schema.valid,
      expected_semantic_valid: expected.semantic.valid,
    };
  });
  const artifact = {
    poc: 11,
    phase: 2,
    approved: true,
    _comment: 'Human-approved paper ground truth. paper_* is physical. expected_resolved_* is frozen #9/#10 semantics applied to paper, including previous-only blank-load inheritance. Blind recognition was not used.',
    sheets,
  };
  fs.mkdirSync(POC11_ARTIFACT_DIR, { recursive: true });
  fs.writeFileSync(POC11_GT_PATH, `${JSON.stringify(artifact, null, 2)}\n`);
  return artifact;
}

export function scorePoc11() {
  const checksum = verifyBlindChecksum();
  if (!checksum.ok) {
    return { status: 'STOP', reason: 'blind checksum mismatch', checksum };
  }
  const freeze = {
    detector_version: DETECTOR_VERSION,
    detector_sha256: sha256File(DETECTOR_CONFIG_PATH),
    detect_py_sha256: sha256File(DETECT_PY),
    granite_exact: loadPoc8bRows().filter((r) => r.clean === r.expected).length,
    granite_total: loadPoc8bRows().length,
    tests_at_phase1: 244,
  };
  const gtArtifact = writeGroundTruthArtifact();
  const blind = loadJson(path.join(POC11_BLIND_DIR, 'blind-results.json'));
  const gtSheets = sheetByPhoto();

  const registration = {
    success: 0,
    fail: 0,
    failures: [],
    template_correct: 0,
    template_scored: 0,
  };
  const checkboxAgg = {
    total: 0, correct: 0, false_checked: 0, false_unchecked: 0, uncertain: 0,
  };
  const blankAgg = {
    total: 0, correct: 0, false_blank: 0, false_nonblank: 0, uncertain: 0,
    expected_blank: 0, expected_nonblank: 0, blank_correct: 0, nonblank_correct: 0,
  };
  const numericRows = [];
  const dateRows = [];
  const assemblyRows = [];
  const silent = [];
  const caught = [];
  const falseReview = [];
  const outOfScope = [];
  const photoScores = [];
  const reviewBurden = [];

  for (const sheet of HUMAN_APPROVED_GT.sheets) {
    const frozen = loadFrozenPhoto(sheet.photo_id);
    const expected = expectedResolvedFromPaper(sheet);
    const registered = Boolean(frozen.photo.registration?.success);
    if (registered) registration.success += 1;
    else {
      registration.fail += 1;
      registration.failures.push({
        photo_id: sheet.photo_id,
        detected_ids: frozen.photo.registration?.detected_ids || [],
        error: frozen.photo.registration?.error,
        note: sheet.photo_id === 'IMG_1331'
          ? 'missing ArUco 11 (TR). No downstream transcription scored as OCR.'
          : 'registration failure',
      });
    }

    if (!registered) {
      photoScores.push({
        photo_id: sheet.photo_id,
        registered: false,
        template_id_gt: sheet.template_id,
        detected_template: null,
        skip_reason: 'registration_failure',
      });
      reviewBurden.push({
        photo_id: sheet.photo_id,
        first_pass: {
          registration: 'FAIL',
          review_status: 'NOT_RUN',
          save_ready: false,
          blocking_issue_count: 0,
          surfaced_field_count: 0,
        },
        allowed_action: 'retake photo',
        can_become_save_ready_from_this_photo: false,
        silent_errors_remaining_after_review: [],
        notes: 'Root failure is registration (missing ArUco 11). Downstream fields are not OCR errors.',
      });
      continue;
    }

    registration.template_scored += 1;
    const templateOk = frozen.photo.detected_template === sheet.template_id;
    if (templateOk) registration.template_correct += 1;

    const cb = checkboxScore(expected.expanded.checkboxes, frozen.observations.checkboxes);
    const bn = blankScore(expected.expanded.fields, frozen.observations.fields);
    checkboxAgg.total += cb.total;
    checkboxAgg.correct += cb.correct;
    checkboxAgg.false_checked += cb.false_checked;
    checkboxAgg.false_unchecked += cb.false_unchecked;
    checkboxAgg.uncertain += cb.uncertain;
    blankAgg.total += bn.total;
    blankAgg.correct += bn.correct;
    blankAgg.false_blank += bn.false_blank;
    blankAgg.false_nonblank += bn.false_nonblank;
    blankAgg.uncertain += bn.uncertain;
    blankAgg.expected_blank += bn.expected_blank;
    blankAgg.expected_nonblank += bn.expected_nonblank;
    blankAgg.blank_correct += bn.rows.filter((r) => r.expected === 'blank' && r.status === 'correct').length;
    blankAgg.nonblank_correct += bn.rows.filter((r) => r.expected === 'nonblank' && r.status === 'correct').length;

    const graniteByField = Object.fromEntries((frozen.numeric.results || []).map((r) => [r.field_id, r]));
    const headerByField = Object.fromEntries((frozen.headerRec.results || []).map((r) => [r.field_id, r]));
    const issues = frozen.gate?.review?.issues || frozen.photo.review_issue_codes || [];
    const issueObjs = frozen.gate?.review?.issues || [];

    for (const written of expected.expanded.writtenNumeric) {
      const kind = numericKindLabel(written.kind);
      if (written.field_id.startsWith('header.')) {
        const rec = headerByField[written.field_id];
        if (!rec?.invoked) {
          numericRows.push({
            photo_id: sheet.photo_id,
            field_id: written.field_id,
            kind,
            gt: written.value,
            recognized: null,
            status: 'not_invoked_structural',
          });
          continue;
        }
        const status = classifyNumeric(written.value, rec.recognized);
        numericRows.push({
          photo_id: sheet.photo_id,
          field_id: written.field_id,
          kind,
          gt: written.value,
          recognized: rec.recognized,
          status: status === 'exact' ? 'exact' : status,
        });
        continue;
      }
      const rec = graniteByField[written.field_id];
      if (!rec) {
        numericRows.push({
          photo_id: sheet.photo_id,
          field_id: written.field_id,
          kind,
          gt: written.value,
          recognized: null,
          status: 'not_invoked_structural',
        });
        continue;
      }
      const status = classifyNumeric(written.value, rec.recognized);
      numericRows.push({
        photo_id: sheet.photo_id,
        field_id: written.field_id,
        kind,
        gt: written.value,
        recognized: rec.recognized,
        raw: rec.raw,
        status,
      });
    }

    const dateParsedGt = parseDateLiteral(sheet.header.date_literal);
    const dateLit = frozen.photo.recognized_date_literal;
    const dateParsedBlind = parseDateLiteral(dateLit);
    const literalExact = dateLit === sheet.header.date_literal;
    const canonicalExact = (frozen.photo.canonical_date || null) === (dateParsedGt.iso || null)
      && (dateParsedGt.status !== DATE_PARSE.PARTIAL || frozen.photo.canonical_date == null);
    const partialPreserved = dateParsedGt.status === DATE_PARSE.PARTIAL
      && frozen.photo.canonical_date == null
      && (frozen.photo.date_status === DATE_PARSE.PARTIAL || (issueObjs.some((i) => i.code === 'PARTIAL_DATE')));
    const inferredYear = dateParsedGt.status === DATE_PARSE.PARTIAL && frozen.photo.canonical_date != null;
    dateRows.push({
      photo_id: sheet.photo_id,
      gt_literal: sheet.header.date_literal,
      gt_status: dateParsedGt.status,
      gt_iso: dateParsedGt.iso,
      blind_literal: dateLit,
      blind_status: frozen.photo.date_status,
      blind_iso: frozen.photo.canonical_date,
      literal_exact: literalExact,
      canonical_exact: dateParsedGt.status === DATE_PARSE.PARTIAL
        ? frozen.photo.canonical_date == null && !inferredYear
        : (frozen.photo.canonical_date || null) === (dateParsedGt.iso || null) && literalExact === false
          ? (frozen.photo.canonical_date || null) === (dateParsedGt.iso || null)
          : (frozen.photo.canonical_date || null) === (dateParsedGt.iso || null),
      partial_preserved: dateParsedGt.status === DATE_PARSE.PARTIAL
        ? frozen.photo.canonical_date == null && !inferredYear
        : null,
      missing_year_inference: inferredYear,
      unreadble: issueObjs.some((i) => i.code === 'UNREADABLE_DATE'),
    });
    dateRows[dateRows.length - 1].canonical_exact = dateParsedGt.status === DATE_PARSE.COMPLETE
      ? frozen.photo.canonical_date === dateParsedGt.iso
      : dateParsedGt.status === DATE_PARSE.PARTIAL
        ? frozen.photo.canonical_date == null && !inferredYear
        : frozen.photo.canonical_date == null;

    const expSets = canonicalSetMap(expected.canonical);
    const blindSets = canonicalSetMap(frozen.canonical);
    const allSetKeys = new Set([...expSets.keys(), ...blindSets.keys()]);
    let assemblyCorrect = 0;
    let assemblyTotal = 0;
    let incorrectInheritance = 0;
    const assemblyMismatches = [];
    for (const key of allSetKeys) {
      assemblyTotal += 1;
      const exp = setSignature(expSets.get(key)?.set);
      const got = setSignature(blindSets.get(key)?.set);
      const equal = JSON.stringify(exp) === JSON.stringify(got);
      if (equal) assemblyCorrect += 1;
      else {
        assemblyMismatches.push({ key, expected: exp, blind: got });
        const expProv = expected.resolved.exercises
          ?.flatMap((ex) => (ex.sets || []).map((s) => ({ ex, s })))
          .find((x) => `${x.ex.slot_id}.S${x.s.set_number}` === key);
        const blindProv = frozen.resolved?.exercises
          ?.flatMap((ex) => (ex.sets || []).map((s) => ({ ex, s })))
          .find((x) => `${x.ex.slot_id}.S${x.s.set_number}` === key);
        const expRes = expProv?.s.load_provenance?.resolution;
        const gotRes = blindProv?.s.load_provenance?.resolution;
        if (expRes === 'INHERITED' && gotRes && gotRes !== 'INHERITED' && gotRes !== 'UNKNOWN') {
          incorrectInheritance += 1;
        }
      }
    }
    const omittedOk = sheet.sets.filter((s) => !s.performed).every((s) => !blindSets.has(setKey(s.slot_id, s.set_number)));
    assemblyRows.push({
      photo_id: sheet.photo_id,
      set_pairs: assemblyTotal,
      matching_sets: assemblyCorrect,
      omitted_unused_rows: omittedOk,
      incorrect_inheritance: incorrectInheritance,
      mismatches: assemblyMismatches,
    });

    const discrepancies = [];
    for (const row of numericRows.filter((r) => r.photo_id === sheet.photo_id)) {
      if (row.status === 'exact' || row.status === 'not_invoked_structural') continue;
      const fieldIssues = issuesForField(issueObjs, row.field_id);
      const classif = fieldIssues.length ? 'CAUGHT' : 'SILENT';
      const rec = {
        photo: sheet.photo_id,
        routine: sheet.routine,
        field_id: row.field_id,
        kind: row.kind,
        physical_gt: row.gt,
        blind_literal: row.recognized,
        classification: classif,
        review_issues: fieldIssues.map((i) => i.code),
        why: fieldIssues.length
          ? `review issue(s) ${fieldIssues.map((i) => i.code).join(',')} attached to this field`
          : 'plausible or raw value accepted with no field-level review issue',
      };
      discrepancies.push(rec);
      if (classif === 'SILENT') silent.push(rec);
      else caught.push(rec);
    }

    if (!literalExact) {
      const fieldIssues = issuesForField(issueObjs, 'header.date');
      const classif = fieldIssues.length ? 'CAUGHT' : 'SILENT';
      const rec = {
        photo: sheet.photo_id,
        routine: sheet.routine,
        field_id: 'header.date',
        kind: 'date',
        physical_gt: sheet.header.date_literal,
        blind_literal: dateLit,
        resolved_blind: frozen.photo.canonical_date,
        expected_resolved: dateParsedGt.iso,
        classification: classif,
        review_issues: fieldIssues.map((i) => i.code),
        why: fieldIssues.length
          ? `date field surfaced (${fieldIssues.map((i) => i.code).join(',')})`
          : 'wrong or unreadable date with no date review issue',
      };
      discrepancies.push(rec);
      if (classif === 'SILENT') silent.push(rec);
      else caught.push(rec);
    }

    for (const row of cb.rows.filter((r) => r.status !== 'correct')) {
      const fieldIssues = issuesForField(issueObjs, row.field_id);
      const classif = fieldIssues.length || row.status === 'uncertain' ? 'CAUGHT' : 'SILENT';
      const rec = {
        photo: sheet.photo_id,
        routine: sheet.routine,
        field_id: row.field_id,
        kind: 'checkbox',
        physical_gt: row.expected,
        blind_literal: row.observed,
        classification: classif,
        review_issues: fieldIssues.map((i) => i.code),
        why: classif === 'CAUGHT'
          ? 'checkbox mismatch surfaced or marked uncertain'
          : 'checkbox mismatch with no review issue on this field',
      };
      discrepancies.push(rec);
      if (classif === 'SILENT') silent.push(rec);
      else caught.push(rec);
    }

    for (const row of bn.rows.filter((r) => r.status !== 'correct')) {
      if (OPTIONAL_TEXT.includes(row.field_id) && row.expected === 'nonblank' && row.status === 'correct') continue;
      const fieldIssues = issuesForField(issueObjs, row.field_id);
      const isOptionalText = OPTIONAL_TEXT.includes(row.field_id);
      if (isOptionalText && row.status === 'correct') continue;
      const classif = isOptionalText && (row.status === 'correct' || row.expected === 'nonblank')
        ? (row.status === 'correct' ? null : (row.status === 'false_blank' ? 'NON-BLOCKING OUT-OF-SCOPE' : 'SILENT'))
        : (fieldIssues.length || row.status === 'uncertain' ? 'CAUGHT' : 'SILENT');
      if (!classif) continue;
      const rec = {
        photo: sheet.photo_id,
        routine: sheet.routine,
        field_id: row.field_id,
        kind: isOptionalText ? 'optional_text_presence' : 'blank_nonblank',
        physical_gt: row.expected,
        blind_literal: row.observed,
        classification: classif,
        review_issues: fieldIssues.map((i) => i.code),
        why: isOptionalText
          ? 'optional free-text OCR is unimplemented; presence-only scoring'
          : (classif === 'CAUGHT' ? 'paper-state mismatch surfaced' : 'paper-state mismatch with no field-level review issue'),
      };
      discrepancies.push(rec);
      if (classif === 'SILENT') silent.push(rec);
      else if (classif === 'CAUGHT') caught.push(rec);
      else outOfScope.push(rec);
    }

    for (const m of assemblyMismatches) {
      const already = discrepancies.some((d) => d.field_id?.startsWith(m.key) || numericRows.some((n) => n.photo_id === sheet.photo_id && n.field_id.startsWith(m.key) && n.status !== 'exact' && n.status !== 'not_invoked_structural'));
      const loadField = `${m.key}.load`;
      const fieldIssues = issuesForField(issueObjs, loadField)
        .concat(issueObjs.filter((i) => i.exercise_slot && m.key.startsWith(i.exercise_slot) && String(i.set_number) === m.key.split('.S')[1]));
      const causedByNumeric = numericRows.some((n) => n.photo_id === sheet.photo_id && n.field_id.startsWith(m.key) && (n.status === 'wrong' || n.status === 'UNKNOWN'));
      const inheritedFromWrong = numericRows.some((n) => n.photo_id === sheet.photo_id && n.status === 'wrong' && n.kind === 'load' && n.field_id.startsWith(m.key.split('.S')[0]));
      if (causedByNumeric) continue;
      if (inheritedFromWrong && m.blind?.weight_lb != null && m.expected?.weight_lb != null && m.blind.weight_lb !== m.expected.weight_lb && m.blind.load_state === m.expected.load_state) {
        const rec = {
          photo: sheet.photo_id,
          routine: sheet.routine,
          field_id: m.key,
          kind: 'inherited_from_silent_source',
          physical_gt: m.expected,
          blind_literal: m.blind,
          classification: 'SILENT',
          review_issues: [],
          why: 'blank-load inheritance copied a silent OCR substitution from a previous same-exercise load; the inheritance rule itself is correct (no look-forward)',
        };
        discrepancies.push(rec);
        silent.push(rec);
        continue;
      }
      const classif = fieldIssues.length ? 'CAUGHT' : 'SILENT';
      const rec = {
        photo: sheet.photo_id,
        routine: sheet.routine,
        field_id: m.key,
        kind: 'assembly',
        physical_gt: m.expected,
        blind_literal: m.blind,
        classification: classif,
        review_issues: fieldIssues.map((i) => i.code),
        why: classif === 'CAUGHT'
          ? 'assembly mismatch has a review issue on the set'
          : 'assembly mismatch with no set-level review issue',
      };
      discrepancies.push(rec);
      if (classif === 'SILENT') silent.push(rec);
      else caught.push(rec);
    }

    for (const issue of issueObjs) {
      const gtCb = expected.expanded.checkboxes[issue.field_id];
      const gtField = expected.expanded.fields[issue.field_id];
      const written = expected.expanded.writtenNumeric.find((w) => w.field_id === issue.field_id);
      if (issue.code === 'PARTIAL_DATE' && dateParsedGt.status === DATE_PARSE.PARTIAL) continue;
      if (issue.code === 'UNREADABLE_DATE' && !literalExact) continue;
      if (issue.code === 'UNREADABLE_DURATION' && sheet.header.duration != null) continue;
      if (issue.code === 'UNREADABLE_BODYWEIGHT' && sheet.header.bodyweight != null) continue;
      if (issue.code === 'INCOMPLETE_MEASUREMENT') {
        const slot = issue.exercise_slot;
        const n = issue.set_number;
        const row = expected.expanded.setMap[setKey(slot, n)];
        if (row?.performed) {
          const spec = measurementSpecForExercise(
            loadWorkoutConfig().exercisesById[
              slotMapForRoutine(sheet.routine)[slot]?.exercise_id
            ],
          );
          const missing = spec.paper.some((k) => row.measurements[k] == null);
          if (missing) continue;
        }
      }
      if (issue.code === 'UNREADABLE_NUMERIC' && written) continue;
      if (issue.code === 'MISSING_INITIAL_LOAD') {
        const row = expected.expanded.setMap[`${issue.exercise_slot}.S${issue.set_number}`];
        if (row?.performed && row.load_paper === 'blank' && row.bw === 'unchecked') continue;
      }
      const isTrueCatch = discrepancies.some((d) => d.classification === 'CAUGHT' && (
        d.field_id === issue.field_id || (issue.field_id && String(d.field_id).startsWith(String(issue.exercise_slot || '___')))
      ));
      if (isTrueCatch) continue;
      if (['PARTIAL_DATE', 'UNREADABLE_DATE', 'UNREADABLE_DURATION', 'UNREADABLE_NUMERIC', 'INCOMPLETE_MEASUREMENT', 'MISSING_INITIAL_LOAD'].includes(issue.code)) {
        continue;
      }
      falseReview.push({
        photo: sheet.photo_id,
        field_id: issue.field_id,
        code: issue.code,
        note: 'review issue without a matching GT error on that field',
      });
    }

    for (const id of OPTIONAL_TEXT) {
      if (expected.expanded.fields[id] === 'nonblank') {
        outOfScope.push({
          photo: sheet.photo_id,
          field_id: id,
          classification: 'NON-BLOCKING OUT-OF-SCOPE',
          physical_gt: id === 'header.pain_area' ? sheet.header.pain_area.literal : sheet.header.quick_note.literal,
          note: 'optional free-text OCR unimplemented; presence scored separately',
        });
      }
    }

    const silentHere = silent.filter((s) => s.photo === sheet.photo_id);
    const surfacedFields = [...new Set(issueObjs.map((i) => i.field_id).filter(Boolean))];
    const blocking = (frozen.gate?.save?.blocking_issues || frozen.photo.blocking_issues || []);
    const canSaveAfter = simulateSaveAfterReview({
      sheet,
      frozen,
      expected,
      issueObjs,
      silentHere,
      dateParsedGt,
    });

    reviewBurden.push({
      photo_id: sheet.photo_id,
      first_pass: {
        registration: 'PASS',
        review_status: frozen.photo.review_status,
        save_ready: frozen.photo.save_ready,
        blocking_issue_count: blocking.length,
        surfaced_field_count: surfacedFields.length,
        surfaced_fields: surfacedFields,
        issue_codes: frozen.photo.review_issue_codes,
      },
      allowed_actions: canSaveAfter.actions,
      can_become_save_ready: canSaveAfter.save_ready,
      silent_errors_remaining_after_review: silentHere,
      canonical_correct_before_review: assemblyMismatches.length === 0
        && literalExact
        && frozen.photo.effort === sheet.header.effort
        && frozen.photo.pain === sheet.header.pain
        && (frozen.photo.bodyweight_lb ?? null) === (sheet.header.bodyweight ?? null)
        && (frozen.photo.duration_min ?? null) === (sheet.header.duration ?? null),
      notes: canSaveAfter.notes,
    });

    photoScores.push({
      photo_id: sheet.photo_id,
      registered: true,
      template_id_gt: sheet.template_id,
      detected_template: frozen.photo.detected_template,
      template_correct: templateOk,
      checkbox: { total: cb.total, correct: cb.correct, false_checked: cb.false_checked, false_unchecked: cb.false_unchecked, uncertain: cb.uncertain },
      blank_nonblank: {
        total: bn.total, correct: bn.correct, false_blank: bn.false_blank, false_nonblank: bn.false_nonblank,
        blank_specificity: round4(bn.blank_specificity), nonblank_recall: round4(bn.nonblank_recall),
      },
      date: dateRows[dateRows.length - 1],
      assembly: assemblyRows[assemblyRows.length - 1],
      review_status: frozen.photo.review_status,
      save_ready: frozen.photo.save_ready,
      schema_valid: frozen.photo.schema_valid,
      semantic_valid: frozen.photo.semantic_valid,
      latency: frozen.photo.latency,
    });
  }

  const numericScored = numericRows.filter((r) => r.status !== 'not_invoked_structural');
  const byKind = {};
  for (const row of numericScored) {
    byKind[row.kind] = byKind[row.kind] || { total: 0, exact: 0, UNKNOWN: 0, wrong: 0 };
    byKind[row.kind].total += 1;
    if (row.status === 'exact') byKind[row.kind].exact += 1;
    else if (row.status === 'UNKNOWN') byKind[row.kind].UNKNOWN += 1;
    else byKind[row.kind].wrong += 1;
  }
  const numericSummary = {
    denominator: 'written numeric GT fields on successfully registered photos where Granite was invoked',
    total: numericScored.length,
    exact: numericScored.filter((r) => r.status === 'exact').length,
    UNKNOWN: numericScored.filter((r) => r.status === 'UNKNOWN').length,
    wrong: numericScored.filter((r) => r.status === 'wrong').length,
    not_invoked_structural: numericRows.filter((r) => r.status === 'not_invoked_structural').length,
    by_kind: byKind,
    rows: numericScored,
  };
  numericSummary.accuracy = numericSummary.total ? numericSummary.exact / numericSummary.total : 0;

  const successfulLatency = photoScores.filter((p) => p.registered).map((p) => p.latency?.total_ms).filter((n) => n != null);
  const failLatency = blind.photos.filter((p) => !p.registration.success).map((p) => p.processing_time_ms);
  const latency = {
    successful_photos: {
      n: successfulLatency.length,
      mean_ms: successfulLatency.length ? Math.round(successfulLatency.reduce((a, b) => a + b, 0) / successfulLatency.length) : 0,
      median_ms: Math.round(median(successfulLatency)),
      min_ms: successfulLatency.length ? Math.min(...successfulLatency) : 0,
      max_ms: successfulLatency.length ? Math.max(...successfulLatency) : 0,
      components: photoScores.filter((p) => p.registered).map((p) => ({
        photo_id: p.photo_id,
        ...p.latency,
      })),
    },
    registration_failure: {
      n: failLatency.length,
      times_ms: failLatency,
      photos: registration.failures.map((f) => f.photo_id),
    },
  };

  const firstPassSave = blind.photos.filter((p) => p.save_ready).length;
  const firstPassReview = blind.photos.filter((p) => p.review_status === 'REVIEW_REQUIRED').length;
  const surfacedCounts = reviewBurden.map((r) => r.first_pass.surfaced_field_count);
  const canonicalBefore = reviewBurden.filter((r) => r.canonical_correct_before_review).length;
  const afterReviewSave = reviewBurden.filter((r) => r.can_become_save_ready).length;
  const silentAfter = reviewBurden.reduce((n, r) => n + (r.silent_errors_remaining_after_review?.length || 0), 0);

  const blankSpecificity = blankAgg.expected_blank ? blankAgg.blank_correct / blankAgg.expected_blank : 1;
  const nonblankRecall = blankAgg.expected_nonblank ? blankAgg.nonblank_correct / blankAgg.expected_nonblank : 1;

  const scored = {
    poc: 11,
    phase: 3,
    freeze,
    checksum,
    registration: {
      success: `${registration.success}/6`,
      success_n: registration.success,
      failures: registration.failures,
      template_identification: `${registration.template_correct}/${registration.template_scored}`,
    },
    structural: {
      checkboxes: {
        ...checkboxAgg,
        accuracy: checkboxAgg.total ? checkboxAgg.correct / checkboxAgg.total : 0,
      },
      blank_nonblank: {
        ...blankAgg,
        blank_specificity: blankSpecificity,
        nonblank_recall: nonblankRecall,
        accuracy: blankAgg.total ? blankAgg.correct / blankAgg.total : 0,
      },
      denominator: 'successfully registered photos only (5/6)',
    },
    numeric: numericSummary,
    date: {
      rows: dateRows,
      literal_exact: dateRows.filter((r) => r.literal_exact).length,
      canonical_exact: dateRows.filter((r) => r.canonical_exact).length,
      partial_preserved: dateRows.filter((r) => r.partial_preserved).length,
      missing_year_inference: dateRows.filter((r) => r.missing_year_inference).length,
      scored_photos: dateRows.length,
    },
    assembly: {
      rows: assemblyRows,
      incorrect_inheritance_total: assemblyRows.reduce((n, r) => n + r.incorrect_inheritance, 0),
    },
    photos: photoScores,
    discrepancies: { caught, silent, false_review: falseReview, out_of_scope: outOfScope },
    review_burden: reviewBurden,
    latency,
    product: {
      registration_success: `${registration.success}/6`,
      template_identification: `${registration.template_correct}/${registration.template_scored}`,
      checkbox_accuracy: checkboxAgg.total ? checkboxAgg.correct / checkboxAgg.total : 0,
      blank_nonblank_accuracy: blankAgg.total ? blankAgg.correct / blankAgg.total : 0,
      numeric_exact: `${numericSummary.exact}/${numericSummary.total}`,
      numeric_unknown: numericSummary.UNKNOWN,
      numeric_wrong: numericSummary.wrong,
      date_literal_exact: `${dateRows.filter((r) => r.literal_exact).length}/${dateRows.length}`,
      date_canonical_exact: `${dateRows.filter((r) => r.canonical_exact).length}/${dateRows.length}`,
      partial_dates_preserved: dateRows.filter((r) => r.partial_preserved).length,
      missing_year_inference: dateRows.filter((r) => r.missing_year_inference).length,
      incorrect_inheritance: assemblyRows.reduce((n, r) => n + r.incorrect_inheritance, 0),
      first_pass_save_ready: `${firstPassSave}/6`,
      first_pass_review_required: `${firstPassReview}/6`,
      registration_failures: `${registration.fail}/6`,
      median_surfaced_review_fields: median(surfacedCounts),
      true_errors_caught: caught.length,
      silent_errors: silent.length,
      false_review_issues: falseReview.length,
      canonically_correct_before_review: canonicalBefore,
      save_ready_after_surfaced_review: afterReviewSave,
      silent_errors_after_review: silentAfter,
    },
  };
  return scored;
}

function simulateSaveAfterReview({ sheet, frozen, expected, issueObjs, silentHere, dateParsedGt }) {
  const actions = [];
  const codes = new Set(issueObjs.map((i) => i.code));
  if (codes.has('PARTIAL_DATE')) actions.push('complete missing year on header.date');
  if (codes.has('UNREADABLE_DATE')) actions.push('enter date literal from paper on surfaced header.date');
  if (codes.has('UNREADABLE_DURATION')) actions.push('correct surfaced duration');
  if (codes.has('UNREADABLE_BODYWEIGHT')) actions.push('correct surfaced bodyweight');
  if (codes.has('UNREADABLE_NUMERIC')) actions.push('correct surfaced UNKNOWN numeric field(s)');
  if (codes.has('INCOMPLETE_MEASUREMENT')) {
    actions.push('resolve incomplete measurement (paper may actually be incomplete)');
  }
  if (codes.has('MISSING_INITIAL_LOAD')) actions.push('supply initial load on surfaced field');

  const paperIncomplete = HUMAN_APPROVED_GT.sheets
    .find((s) => s.photo_id === sheet.photo_id)
    .sets.some((row) => {
      if (!row.performed) return false;
      return false;
    });
  const gtHasIncompleteMeas = Object.values(expected.expanded.setMap).some((row) => {
    if (!row.performed) return false;
    return false;
  });
  const incompleteOnPaper = sheet.sets.some((row) => {
    if (!row.performed) return false;
    const hasMeas = Object.values(row.measurements || {}).some((v) => v != null);
    return !hasMeas;
  });

  let saveReady = true;
  const notes = [];
  if (silentHere.length) notes.push(`${silentHere.length} silent error(s) would remain because those fields are not surfaced`);
  if (dateParsedGt.status === DATE_PARSE.PARTIAL) {
    notes.push('GT date has no year; user may supply a year (allowed) to reach save_ready');
  }
  if (incompleteOnPaper) {
    notes.push('paper itself has incomplete measurements (BW marked, reps blank). Confirming paper as written leaves INCOMPLETE_MEASUREMENT blocking unless the user adds values not on the sheet or omits those sets.');
    saveReady = false;
  } else if (codes.has('INCOMPLETE_MEASUREMENT')) {
    notes.push('incomplete measurement was a recognition/detection miss; correcting the surfaced field can unblock');
  }
  if (!incompleteOnPaper) {
    saveReady = true;
  }
  if (frozen.photo.save_ready && !codes.size) {
    saveReady = true;
    if (!actions.length) actions.push('none (AUTO_ACCEPT first pass)');
  }
  return { actions, save_ready: saveReady && !incompleteOnPaper, notes: notes.join(' ') };
}

export function writePhase3Artifacts(scored) {
  const silent = (scored.discrepancies.silent || []).map((row) => ({
    photo: row.photo,
    routine: row.routine,
    field_id: row.field_id,
    kind: row.kind,
    physical_gt: row.physical_gt,
    blind_literal: row.blind_literal,
    resolved_blind_value: row.resolved_blind ?? null,
    expected_resolved_value: row.expected_resolved ?? null,
    review_issues_attached: row.review_issues || [],
    why_silent: row.why,
  }));
  fs.writeFileSync(path.join(POC11_ARTIFACT_DIR, 'silent-errors.json'), `${JSON.stringify({
    count: silent.length,
    errors: silent,
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(POC11_ARTIFACT_DIR, 'review-burden.json'), `${JSON.stringify({
    photos: scored.review_burden,
    median_surfaced_fields: scored.product.median_surfaced_review_fields,
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(POC11_ARTIFACT_DIR, 'latency.json'), `${JSON.stringify(scored.latency, null, 2)}\n`);
  fs.writeFileSync(path.join(POC11_ARTIFACT_DIR, 'scored-results.json'), `${JSON.stringify(scored, null, 2)}\n`);
  const results = {
    poc: 11,
    phase: 3,
    blind_checksum: scored.checksum,
    freeze: scored.freeze,
    product: scored.product,
    registration: scored.registration,
    numeric: {
      total: scored.numeric.total,
      exact: scored.numeric.exact,
      UNKNOWN: scored.numeric.UNKNOWN,
      wrong: scored.numeric.wrong,
      accuracy: scored.numeric.accuracy,
      by_kind: scored.numeric.by_kind,
    },
    date: {
      literal_exact: scored.date.literal_exact,
      canonical_exact: scored.date.canonical_exact,
      partial_preserved: scored.date.partial_preserved,
      missing_year_inference: scored.date.missing_year_inference,
    },
    silent_error_count: silent.length,
  };
  fs.writeFileSync(path.join(POC11_ARTIFACT_DIR, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  return { silent, results };
}
