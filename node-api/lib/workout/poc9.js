import fs from 'node:fs';
import path from 'node:path';
import {
  ARTIFACT_DIR,
  V131_CONFIG_DIR,
} from './poc6/index.js';
import {
  DETECT_PY,
  DETECTOR_CONFIG_PATH,
} from './poc7/index.js';
import {
  DETECTOR_VERSION,
  FROZEN_DETECTOR_SHA256,
  assertDetectorFrozen,
  sha256File,
} from './poc7b.js';
import {
  DETECT_PY_SHA256,
  loadJson,
  loadNumericGroundTruth,
  numericKindFromFieldId,
  parseNumericLiteral,
  photoCatalog,
  templatePathForId,
} from './poc8.js';
import { POC8B_MODEL, loadPoc8Membership } from './poc8b.js';
import { loadPoc8bRows } from './poc8c.js';
import { loadWorkoutConfig } from './config.js';
import { validateWorkoutSchema } from './schemaValidator.js';

export const POC9_ARTIFACT_DIR = path.join(ARTIFACT_DIR, 'poc9');
export const RECOGNIZER_ID = POC8B_MODEL;
export const CROP_PROFILE = 'poc8b-clean';
export const SCHEMA_VERSION = '1.2';

export const REVIEW_STATUS = {
  AUTO_ACCEPT: 'AUTO_ACCEPT',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED',
  INVALID: 'INVALID',
};

export const ISSUE = {
  UNREADABLE_NUMERIC: 'UNREADABLE_NUMERIC',
  MISSING_INITIAL_LOAD: 'MISSING_INITIAL_LOAD',
  CONFLICTING_LOAD_STATE: 'CONFLICTING_LOAD_STATE',
  INCOMPLETE_MEASUREMENT: 'INCOMPLETE_MEASUREMENT',
  NON_POSITIVE_MEASUREMENT: 'NON_POSITIVE_MEASUREMENT',
  EXTREME_MEASUREMENT: 'EXTREME_MEASUREMENT',
  MULTIPLE_EFFORT_SELECTIONS: 'MULTIPLE_EFFORT_SELECTIONS',
  MULTIPLE_PAIN_SELECTIONS: 'MULTIPLE_PAIN_SELECTIONS',
  STRUCTURAL_CHECKBOX_UNCERTAIN: 'STRUCTURAL_CHECKBOX_UNCERTAIN',
  STRUCTURAL_PAPER_UNCERTAIN: 'STRUCTURAL_PAPER_UNCERTAIN',
};

/**
 * Broad data-integrity limits, not coaching targets and not tuned to #8B misses.
 * 410s Farmer Carry (the remaining extra-digit OCR) is below duration_sec_max and must survive.
 */
export const INTEGRITY_BOUNDS = {
  weight_lb_max: 1000,
  reps_max: 100,
  duration_sec_max: 600,
  rationale: {
    weight_lb_max:
      'A single logged implement above 1000 lb is outside a representable gym-session load on this form. Not an exercise-specific target.',
    reps_max:
      'A single working set above 100 reps is treated as OCR/log corruption. Real fixture B06 S1 is 19; this is not a 6–12 coaching range.',
    duration_sec_max:
      'One timed set longer than 10 minutes exceeds what a compact 30–45 minute session log can represent. Not a 30–45s carry target. 410s is below this bound on purpose.',
  },
};

export const PAPER = {
  BLANK: 'BLANK',
  NONBLANK: 'NONBLANK',
  UNCERTAIN: 'UNCERTAIN',
  NA: 'NA',
};

export const RECOGNITION = {
  NUMERIC: 'NUMERIC',
  UNKNOWN: 'UNKNOWN',
  NOT_RUN: 'NOT_RUN',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  STRUCTURAL_CHECKBOX: 'STRUCTURAL_CHECKBOX',
};

const SET_FIELD_RE = /^([ABC])(\d{2})\.S(\d+)\.(load|BW|reps|left|right|seconds|left_seconds|right_seconds)$/;
const EFFORT_IDS = ['header.effort.1', 'header.effort.2', 'header.effort.3', 'header.effort.4', 'header.effort.5'];
const PAIN_IDS = ['header.pain.0', 'header.pain.1', 'header.pain.2', 'header.pain.3'];

const MEASUREMENT_BY_LIBRARY = {
  reps: {
    kind: 'bilateral_reps',
    paper: ['reps'],
    canonical: { reps: 'reps' },
  },
  reps_per_side: {
    kind: 'unilateral_reps',
    paper: ['left', 'right'],
    canonical: { left: 'left_reps', right: 'right_reps' },
  },
  duration: {
    kind: 'bilateral_timed',
    paper: ['seconds'],
    canonical: { seconds: 'duration_sec' },
  },
  duration_per_side: {
    kind: 'unilateral_timed',
    paper: ['left_seconds', 'right_seconds'],
    canonical: { left_seconds: 'left_duration_sec', right_seconds: 'right_duration_sec' },
  },
};

const SHEET_TRUTH_PATHS = {
  'A-2026-09-20': path.join(V131_CONFIG_DIR, 'fixtures', 'poc7f', 'A-sheet-truth.json'),
  'C-2026-10-31': path.join(V131_CONFIG_DIR, 'fixtures', 'poc7f', 'C-sheet-truth.json'),
  'B-original': path.join(V131_CONFIG_DIR, 'fixtures', 'poc7-benchmark-truth.json'),
  'B-2026-09-20': path.join(V131_CONFIG_DIR, 'fixtures', 'poc7e', 'checkbox-truth.json'),
};

export function parseSetFieldId(fieldId) {
  const m = String(fieldId).match(SET_FIELD_RE);
  if (!m) return null;
  return {
    routine: m[1],
    slotId: `${m[1]}${m[2]}`,
    setNumber: Number(m[3]),
    kind: m[4],
    fieldId: String(fieldId),
  };
}

export function routineFromTemplateId(templateId) {
  const letter = String(templateId || '').charAt(0);
  if (letter === 'A' || letter === 'B' || letter === 'C') return letter;
  throw new Error(`cannot derive routine from template ${templateId}`);
}

export function measurementSpecForExercise(exercise) {
  const spec = MEASUREMENT_BY_LIBRARY[exercise?.measurement];
  if (!spec) throw new Error(`unsupported measurement ${exercise?.measurement} for ${exercise?.exercise_id}`);
  return spec;
}

export function slotMapForRoutine(routineId, config = loadWorkoutConfig()) {
  const routine = config.routinesById[routineId];
  if (!routine) throw new Error(`unknown routine ${routineId}`);
  return Object.fromEntries((routine.slots || []).map((slot) => [slot.slot_id, slot]));
}

function paperStateFromDetector(state) {
  if (state === 'blank') return PAPER.BLANK;
  if (state === 'nonblank') return PAPER.NONBLANK;
  if (state === 'uncertain') return PAPER.UNCERTAIN;
  return PAPER.UNCERTAIN;
}

function checkboxValue(state) {
  if (state === 'checked' || state === 'unchecked' || state === 'uncertain') return state;
  return 'uncertain';
}

export function makeNumericObservation({
  fieldId,
  paperState,
  recognitionState,
  recognizedValue = null,
  recognizer = RECOGNIZER_ID,
  cropProfile = CROP_PROFILE,
}) {
  return {
    field_id: fieldId,
    paper_state: paperState,
    recognition_state: recognitionState,
    recognized_value: recognizedValue,
    recognizer: recognitionState === RECOGNITION.NOT_RUN || recognitionState === RECOGNITION.NOT_IMPLEMENTED
      ? null
      : recognizer,
    crop_profile: recognitionState === RECOGNITION.NUMERIC || recognitionState === RECOGNITION.UNKNOWN
      ? cropProfile
      : null,
  };
}

export function makeCheckboxObservation(fieldId, state) {
  return {
    field_id: fieldId,
    paper_state: PAPER.NA,
    recognition_state: RECOGNITION.STRUCTURAL_CHECKBOX,
    recognized_value: checkboxValue(state),
    recognizer: 'poc7-a1c',
    crop_profile: null,
  };
}

export function graniteIndex(rows = loadPoc8bRows()) {
  const map = new Map();
  for (const row of rows) {
    map.set(`${row.photo_id}::${row.field_id}`, row);
  }
  return map;
}

export function ingestRawObservations({
  photoId,
  sheetId,
  templateId,
  detectorObservations,
  graniteByField,
  recognizer = RECOGNIZER_ID,
  cropProfile = CROP_PROFILE,
}) {
  const template = loadJson(templatePathForId(templateId));
  const checkboxes = detectorObservations.checkboxes || {};
  const fields = detectorObservations.fields || {};
  const observations = {};

  for (const field of template.fields || []) {
    const id = field.id;
    if (field.kind === 'checkbox') {
      const rec = checkboxes[id];
      observations[id] = makeCheckboxObservation(id, rec?.state);
      continue;
    }
    const kind = numericKindFromFieldId(id);
    const paper = paperStateFromDetector(fields[id]?.state);
    if (!kind) {
      observations[id] = makeNumericObservation({
        fieldId: id,
        paperState: paper,
        recognitionState: RECOGNITION.NOT_IMPLEMENTED,
        recognizedValue: null,
      });
      continue;
    }
    if (paper === PAPER.BLANK) {
      observations[id] = makeNumericObservation({
        fieldId: id,
        paperState: PAPER.BLANK,
        recognitionState: RECOGNITION.NOT_RUN,
        recognizedValue: null,
      });
      continue;
    }
    const granite = graniteByField.get(`${photoId}::${id}`);
    const parsed = granite ? parseNumericLiteral(granite.clean) : { value: 'UNKNOWN', reason: 'missing_frozen' };
    if (parsed.value === 'UNKNOWN') {
      observations[id] = makeNumericObservation({
        fieldId: id,
        paperState: paper,
        recognitionState: RECOGNITION.UNKNOWN,
        recognizedValue: null,
        recognizer,
        cropProfile,
      });
    } else {
      observations[id] = makeNumericObservation({
        fieldId: id,
        paperState: paper,
        recognitionState: RECOGNITION.NUMERIC,
        recognizedValue: Number(parsed.value),
        recognizer,
        cropProfile,
      });
    }
  }

  return {
    photo_id: photoId,
    sheet_id: sheetId,
    template_id: templateId,
    routine: routineFromTemplateId(templateId),
    template_version: templateId,
    recognizer,
    crop_profile: cropProfile,
    observations,
  };
}

function obs(raw, fieldId) {
  return raw.observations[fieldId] || null;
}

function isChecked(raw, fieldId) {
  return obs(raw, fieldId)?.recognized_value === 'checked';
}

function isUnchecked(raw, fieldId) {
  const o = obs(raw, fieldId);
  if (!o) return true;
  return o.recognized_value === 'unchecked';
}

export function syntheticRaw({
  photoId = 'synthetic',
  sheetId = 'synthetic',
  templateId = 'B-1.3.1',
  observations = {},
} = {}) {
  return {
    photo_id: photoId,
    sheet_id: sheetId,
    template_id: templateId,
    routine: routineFromTemplateId(templateId),
    template_version: templateId,
    recognizer: RECOGNIZER_ID,
    crop_profile: CROP_PROFILE,
    observations,
  };
}

function isPaperBlank(raw, fieldId) {
  return obs(raw, fieldId)?.paper_state === PAPER.BLANK;
}

function hasHandwriting(raw, fieldId) {
  const o = obs(raw, fieldId);
  if (!o) return false;
  return o.paper_state === PAPER.NONBLANK || o.paper_state === PAPER.UNCERTAIN;
}

function exclusiveGroup(raw, ids) {
  const checked = ids.filter((id) => isChecked(raw, id));
  const uncertain = ids.filter((id) => obs(raw, id)?.recognized_value === 'uncertain');
  return { checked, uncertain };
}

function issue(code, {
  fieldId = null,
  exerciseSlot = null,
  setNumber = null,
  observedValue = null,
  message = null,
} = {}) {
  return {
    code,
    field_id: fieldId,
    exercise_slot: exerciseSlot,
    set_number: setNumber,
    observed_value: observedValue,
    message,
  };
}

function slotSetNumbers(template, slotId) {
  const nums = new Set();
  for (const field of template.fields || []) {
    const parsed = parseSetFieldId(field.id);
    if (parsed && parsed.slotId === slotId) nums.add(parsed.setNumber);
  }
  return [...nums].sort((a, b) => a - b);
}

function rowTouched(raw, slotId, setNumber, spec) {
  const bwId = `${slotId}.S${setNumber}.BW`;
  const loadId = `${slotId}.S${setNumber}.load`;
  if (!isUnchecked(raw, bwId)) return true;
  if (hasHandwriting(raw, loadId)) return true;
  for (const kind of spec.paper) {
    if (hasHandwriting(raw, `${slotId}.S${setNumber}.${kind}`)) return true;
  }
  return false;
}

function resolveLoad(raw, slotId, setNumber, previousResolved, issues) {
  const bwId = `${slotId}.S${setNumber}.BW`;
  const loadId = `${slotId}.S${setNumber}.load`;
  const bw = obs(raw, bwId);
  const load = obs(raw, loadId);
  const bwChecked = bw?.recognized_value === 'checked';
  const bwUncertain = bw?.recognized_value === 'uncertain';
  const loadHandwriting = hasHandwriting(raw, loadId);
  const loadNumeric = load?.recognition_state === RECOGNITION.NUMERIC;
  const loadUnknown = load?.recognition_state === RECOGNITION.UNKNOWN;

  if (bwUncertain) {
    issues.push(issue(ISSUE.STRUCTURAL_CHECKBOX_UNCERTAIN, {
      fieldId: bwId,
      exerciseSlot: slotId,
      setNumber,
      observedValue: 'uncertain',
    }));
  }
  if (load?.paper_state === PAPER.UNCERTAIN) {
    issues.push(issue(ISSUE.STRUCTURAL_PAPER_UNCERTAIN, {
      fieldId: loadId,
      exerciseSlot: slotId,
      setNumber,
      observedValue: null,
    }));
  }

  if (bwChecked && loadHandwriting) {
    issues.push(issue(ISSUE.CONFLICTING_LOAD_STATE, {
      fieldId: loadId,
      exerciseSlot: slotId,
      setNumber,
      observedValue: loadNumeric ? load.recognized_value : null,
      message: 'BW checked and load cell also contains handwriting. Neither value is preferred.',
    }));
    if (loadUnknown) {
      issues.push(issue(ISSUE.UNREADABLE_NUMERIC, {
        fieldId: loadId,
        exerciseSlot: slotId,
        setNumber,
        observedValue: null,
      }));
    }
    return {
      load_state: 'unknown',
      weight_lb: loadNumeric ? load.recognized_value : null,
      provenance: {
        field_id: loadId,
        resolved_value: loadNumeric ? load.recognized_value : null,
        load_state: 'unknown',
        resolution: 'CONFLICT',
      },
      resolved: false,
    };
  }

  if (bwChecked) {
    return {
      load_state: 'bodyweight',
      weight_lb: null,
      provenance: {
        field_id: loadId,
        resolved_value: null,
        load_state: 'bodyweight',
        resolution: 'BW_CHECKBOX',
      },
      resolved: true,
    };
  }

  if (loadNumeric) {
    return {
      load_state: 'external',
      weight_lb: load.recognized_value,
      provenance: {
        field_id: loadId,
        resolved_value: load.recognized_value,
        load_state: 'external',
        resolution: 'RECOGNIZED',
      },
      resolved: true,
    };
  }

  if (loadUnknown) {
    issues.push(issue(ISSUE.UNREADABLE_NUMERIC, {
      fieldId: loadId,
      exerciseSlot: slotId,
      setNumber,
      observedValue: null,
    }));
    return {
      load_state: 'unknown',
      weight_lb: null,
      provenance: {
        field_id: loadId,
        resolved_value: null,
        load_state: 'unknown',
        resolution: 'UNKNOWN',
      },
      resolved: false,
    };
  }

  if (previousResolved) {
    const originFieldId = previousResolved.provenance.source_field_id || previousResolved.provenance.field_id;
    const originResolution = previousResolved.provenance.source_resolution || previousResolved.provenance.resolution;
    return {
      load_state: previousResolved.load_state,
      weight_lb: previousResolved.weight_lb,
      provenance: {
        field_id: loadId,
        resolved_value: previousResolved.weight_lb,
        load_state: previousResolved.load_state,
        resolution: 'INHERITED',
        source_field_id: originFieldId,
        source_resolution: originResolution,
      },
      resolved: true,
    };
  }

  issues.push(issue(ISSUE.MISSING_INITIAL_LOAD, {
    fieldId: loadId,
    exerciseSlot: slotId,
    setNumber,
    observedValue: null,
    message: 'Completed set has blank load, BW unchecked, and no prior same-exercise load to inherit.',
  }));
  return {
    load_state: 'unknown',
    weight_lb: null,
    provenance: {
      field_id: loadId,
      resolved_value: null,
      load_state: 'unknown',
      resolution: 'UNKNOWN',
    },
    resolved: false,
  };
}

function resolveMeasurements(raw, slotId, setNumber, spec, issues) {
  const values = {};
  const provenance = {};
  let present = 0;
  let missing = 0;
  for (const kind of spec.paper) {
    const fieldId = `${slotId}.S${setNumber}.${kind}`;
    const canonicalKey = spec.canonical[kind];
    const o = obs(raw, fieldId);
    if (o?.paper_state === PAPER.UNCERTAIN) {
      issues.push(issue(ISSUE.STRUCTURAL_PAPER_UNCERTAIN, {
        fieldId,
        exerciseSlot: slotId,
        setNumber,
        observedValue: null,
      }));
    }
    if (o?.recognition_state === RECOGNITION.NUMERIC) {
      values[canonicalKey] = o.recognized_value;
      provenance[canonicalKey] = {
        field_id: fieldId,
        resolved_value: o.recognized_value,
        resolution: 'RECOGNIZED',
      };
      present += 1;
      continue;
    }
    if (o?.recognition_state === RECOGNITION.UNKNOWN || (hasHandwriting(raw, fieldId) && o?.recognition_state !== RECOGNITION.NUMERIC)) {
      issues.push(issue(ISSUE.UNREADABLE_NUMERIC, {
        fieldId,
        exerciseSlot: slotId,
        setNumber,
        observedValue: null,
      }));
      provenance[canonicalKey] = {
        field_id: fieldId,
        resolved_value: null,
        resolution: 'UNKNOWN',
      };
      missing += 1;
      continue;
    }
    provenance[canonicalKey] = {
      field_id: fieldId,
      resolved_value: null,
      resolution: 'PAPER_BLANK',
    };
    missing += 1;
  }
  if (missing > 0) {
    issues.push(issue(ISSUE.INCOMPLETE_MEASUREMENT, {
      fieldId: `${slotId}.S${setNumber}.${spec.paper[0]}`,
      exerciseSlot: slotId,
      setNumber,
      observedValue: present === 0 ? null : values,
      message: `${spec.kind}: ${present} of ${spec.paper.length} measurement cells recognized.`,
    }));
  }
  return { values, provenance, present, missing };
}

function applyIntegrity(slotId, setNumber, load, measurements, issues) {
  if (load.load_state === 'external' && load.weight_lb != null) {
    if (load.weight_lb <= 0) {
      issues.push(issue(ISSUE.NON_POSITIVE_MEASUREMENT, {
        fieldId: load.provenance.field_id,
        exerciseSlot: slotId,
        setNumber,
        observedValue: load.weight_lb,
      }));
    } else if (load.weight_lb > INTEGRITY_BOUNDS.weight_lb_max) {
      issues.push(issue(ISSUE.EXTREME_MEASUREMENT, {
        fieldId: load.provenance.field_id,
        exerciseSlot: slotId,
        setNumber,
        observedValue: load.weight_lb,
        message: `external load ${load.weight_lb} > ${INTEGRITY_BOUNDS.weight_lb_max} lb integrity bound`,
      }));
    }
  }
  for (const [key, value] of Object.entries(measurements.values)) {
    if (value == null) continue;
    const fieldId = measurements.provenance[key]?.field_id;
    if (value <= 0) {
      issues.push(issue(ISSUE.NON_POSITIVE_MEASUREMENT, {
        fieldId,
        exerciseSlot: slotId,
        setNumber,
        observedValue: value,
      }));
      continue;
    }
    const isDuration = key.includes('duration');
    const max = isDuration ? INTEGRITY_BOUNDS.duration_sec_max : INTEGRITY_BOUNDS.reps_max;
    if (value > max) {
      issues.push(issue(ISSUE.EXTREME_MEASUREMENT, {
        fieldId,
        exerciseSlot: slotId,
        setNumber,
        observedValue: value,
        message: `${key} ${value} > ${max} integrity bound`,
      }));
    }
  }
}

function resolveHeader(raw, issues) {
  const effortGroup = exclusiveGroup(raw, EFFORT_IDS);
  const painGroup = exclusiveGroup(raw, PAIN_IDS);
  for (const id of [...effortGroup.uncertain, ...painGroup.uncertain]) {
    issues.push(issue(ISSUE.STRUCTURAL_CHECKBOX_UNCERTAIN, {
      fieldId: id,
      observedValue: 'uncertain',
    }));
  }
  let effort = null;
  let effortResolution = 'MISSING';
  if (effortGroup.checked.length === 1) {
    effort = Number(effortGroup.checked[0].slice(-1));
    effortResolution = 'CHECKBOX';
  } else if (effortGroup.checked.length > 1) {
    issues.push(issue(ISSUE.MULTIPLE_EFFORT_SELECTIONS, {
      fieldId: 'header.effort',
      observedValue: effortGroup.checked,
      message: 'Mutually exclusive effort checkboxes; none selected.',
    }));
    effortResolution = 'CONFLICT';
  }
  let painLevel = null;
  let painResolution = 'MISSING';
  if (painGroup.checked.length === 1) {
    painLevel = Number(painGroup.checked[0].slice(-1));
    painResolution = 'CHECKBOX';
  } else if (painGroup.checked.length > 1) {
    issues.push(issue(ISSUE.MULTIPLE_PAIN_SELECTIONS, {
      fieldId: 'header.pain',
      observedValue: painGroup.checked,
      message: 'Mutually exclusive pain checkboxes; none selected.',
    }));
    painResolution = 'CONFLICT';
  }
  return {
    effort,
    effort_resolution: effortResolution,
    pain_level: painLevel,
    pain_resolution: painResolution,
    pain_areas: [],
  };
}

export function resolveTranscription(raw, config = loadWorkoutConfig()) {
  const issues = [];
  const template = loadJson(templatePathForId(raw.template_id));
  const slots = slotMapForRoutine(raw.routine, config);
  const header = resolveHeader(raw, issues);
  const exercises = [];

  for (const slot of Object.values(slots)) {
    const exercise = config.exercisesById[slot.exercise_id];
    const spec = measurementSpecForExercise(exercise);
    const setNumbers = slotSetNumbers(template, slot.slot_id);
    const assembled = [];
    const skipped = [];
    let previousResolved = null;

    for (const setNumber of setNumbers) {
      if (!rowTouched(raw, slot.slot_id, setNumber, spec)) {
        skipped.push({ set_number: setNumber, reason: 'BLANK_ROW' });
        continue;
      }
      const load = resolveLoad(raw, slot.slot_id, setNumber, previousResolved, issues);
      const measurements = resolveMeasurements(raw, slot.slot_id, setNumber, spec, issues);
      applyIntegrity(slot.slot_id, setNumber, load, measurements, issues);
      const resolvedSet = {
        set_number: setNumber,
        type: 'working',
        load_state: load.load_state,
        weight_lb: load.weight_lb,
        measurements: measurements.values,
        load_provenance: load.provenance,
        measurement_provenance: measurements.provenance,
        notes: null,
      };
      assembled.push(resolvedSet);
      if (load.resolved) {
        previousResolved = {
          load_state: load.load_state,
          weight_lb: load.weight_lb,
          provenance: load.provenance,
        };
      }
    }

    if (assembled.length > 0) {
      exercises.push({
        slot_id: slot.slot_id,
        exercise_id: slot.exercise_id,
        measurement: exercise.measurement,
        measurement_kind: spec.kind,
        planned_sets: slot.planned_sets,
        sets: assembled,
        skipped_rows: skipped,
        notes: null,
      });
    } else {
      exercises.push({
        slot_id: slot.slot_id,
        exercise_id: slot.exercise_id,
        measurement: exercise.measurement,
        measurement_kind: spec.kind,
        planned_sets: slot.planned_sets,
        sets: [],
        skipped_rows: skipped,
        notes: null,
        omitted: true,
      });
    }
  }

  return {
    photo_id: raw.photo_id,
    sheet_id: raw.sheet_id,
    template_id: raw.template_id,
    routine: raw.routine,
    template_version: raw.template_version,
    header,
    exercises,
    issues_during_resolution: issues,
  };
}

export function toCanonicalCandidate(resolved, reviewStatus) {
  const transcriptionStatus = reviewStatus === REVIEW_STATUS.AUTO_ACCEPT
    ? 'VALID'
    : reviewStatus === REVIEW_STATUS.INVALID
      ? 'INVALID'
      : 'REVIEW_REQUIRED';
  const exercises = resolved.exercises
    .filter((ex) => (ex.sets || []).length > 0)
    .map((ex) => ({
      slot_id: ex.slot_id,
      exercise_id: ex.exercise_id,
      sets: ex.sets.map((set) => {
        const canonical = {
          set_number: set.set_number,
          type: set.type,
          weight_lb: set.weight_lb,
          load_state: set.load_state,
          notes: null,
        };
        for (const [key, value] of Object.entries(set.measurements || {})) {
          if (value != null) canonical[key] = value;
        }
        return canonical;
      }),
      notes: null,
    }));
  return {
    schema_version: SCHEMA_VERSION,
    transcription_status: transcriptionStatus,
    workout: {
      date: null,
      routine: resolved.routine,
      template_version: resolved.template_version,
      duration_min: null,
      effort: resolved.header.effort,
      pain: {
        level: resolved.header.pain_level,
        areas: [],
        notes: null,
      },
      bodyweight_lb: null,
      notes: null,
      exercises,
    },
  };
}

export function finalizeReview(resolvedIssues) {
  const issues = [...resolvedIssues];
  let status = REVIEW_STATUS.AUTO_ACCEPT;
  if (issues.length > 0) status = REVIEW_STATUS.REVIEW_REQUIRED;
  return { status, issues };
}

export function recognizedValuesUnchanged(raw, resolved) {
  const rewritten = [];
  for (const ex of resolved.exercises) {
    for (const set of ex.sets) {
      const loadObs = obs(raw, `${ex.slot_id}.S${set.set_number}.load`);
      if (loadObs?.recognition_state === RECOGNITION.NUMERIC && set.load_provenance?.resolution === 'RECOGNIZED') {
        if (set.weight_lb !== loadObs.recognized_value) {
          rewritten.push({
            field_id: loadObs.field_id,
            recognized: loadObs.recognized_value,
            assembled: set.weight_lb,
          });
        }
      }
      for (const [key, prov] of Object.entries(set.measurement_provenance || {})) {
        const o = obs(raw, prov.field_id);
        if (o?.recognition_state === RECOGNITION.NUMERIC && set.measurements[key] !== o.recognized_value) {
          rewritten.push({
            field_id: o.field_id,
            recognized: o.recognized_value,
            assembled: set.measurements[key],
          });
        }
      }
    }
  }
  return rewritten;
}

export function assembleFromRaw(raw, config = loadWorkoutConfig()) {
  const resolved = resolveTranscription(raw, config);
  const review = finalizeReview(resolved.issues_during_resolution);
  const canonical = toCanonicalCandidate(resolved, review.status);
  const schema = validateWorkoutSchema(canonical);
  const rewritten = recognizedValuesUnchanged(raw, resolved);
  return { raw, resolved, review, canonical, schema, rewritten };
}

export function assemblePhoto(photo, {
  granite = graniteIndex(),
  config = loadWorkoutConfig(),
} = {}) {
  const detector = loadJson(photo.observations);
  const raw = ingestRawObservations({
    photoId: photo.photo_id,
    sheetId: photo.sheet_id,
    templateId: photo.template_id,
    detectorObservations: detector,
    graniteByField: granite,
  });
  return assembleFromRaw(raw, config);
}

function loadSheetTruth(sheetId) {
  const p = SHEET_TRUTH_PATHS[sheetId];
  if (!p || !fs.existsSync(p)) return null;
  return loadJson(p);
}

export function expectedSetsFromTruth(sheet, config = loadWorkoutConfig()) {
  const truth = loadSheetTruth(sheet.sheet_id) || { checkboxes: {}, fields: {} };
  const template = loadJson(templatePathForId(sheet.template_id));
  const slots = slotMapForRoutine(routineFromTemplateId(sheet.template_id), config);
  const numeric = sheet.values || {};
  const exercises = [];

  for (const slot of Object.values(slots)) {
    const exercise = config.exercisesById[slot.exercise_id];
    const spec = measurementSpecForExercise(exercise);
    const setNumbers = slotSetNumbers(template, slot.slot_id);
    const sets = [];
    let previous = null;
    for (const setNumber of setNumbers) {
      const bwId = `${slot.slot_id}.S${setNumber}.BW`;
      const loadId = `${slot.slot_id}.S${setNumber}.load`;
      const bwChecked = truth.checkboxes?.[bwId] === 'checked';
      const loadWritten = Object.prototype.hasOwnProperty.call(numeric, loadId)
        || truth.fields?.[loadId] === 'nonblank';
      const measurements = {};
      let anyMeasurement = false;
      for (const kind of spec.paper) {
        const fieldId = `${slot.slot_id}.S${setNumber}.${kind}`;
        if (Object.prototype.hasOwnProperty.call(numeric, fieldId)) {
          measurements[spec.canonical[kind]] = Number(numeric[fieldId]);
          anyMeasurement = true;
        }
      }
      const touched = bwChecked || loadWritten || anyMeasurement;
      if (!touched) continue;
      let loadState = 'unknown';
      let weight = null;
      let resolution = 'UNKNOWN';
      if (bwChecked) {
        loadState = 'bodyweight';
        weight = null;
        resolution = 'BW_CHECKBOX';
      } else if (Object.prototype.hasOwnProperty.call(numeric, loadId)) {
        loadState = 'external';
        weight = Number(numeric[loadId]);
        resolution = 'RECOGNIZED';
      } else if (previous) {
        loadState = previous.load_state;
        weight = previous.weight_lb;
        resolution = 'INHERITED';
      }
      const resolvedSet = {
        set_number: setNumber,
        load_state: loadState,
        weight_lb: weight,
        measurements,
        resolution,
      };
      sets.push(resolvedSet);
      if (loadState === 'external' || loadState === 'bodyweight') {
        previous = resolvedSet;
      }
    }
    if (sets.length) {
      exercises.push({
        slot_id: slot.slot_id,
        exercise_id: slot.exercise_id,
        measurement_kind: spec.kind,
        sets,
      });
    }
  }
  return { sheet_id: sheet.sheet_id, template_id: sheet.template_id, exercises };
}

function setKey(slotId, setNumber) {
  return `${slotId}.S${setNumber}`;
}

function compareAssemblyToExpected(assembled, expected) {
  const mismatches = [];
  const expectedSets = new Map();
  for (const ex of expected.exercises) {
    for (const set of ex.sets) {
      expectedSets.set(setKey(ex.slot_id, set.set_number), { slot_id: ex.slot_id, ...set, measurement_kind: ex.measurement_kind });
    }
  }
  const actualSets = new Map();
  for (const ex of assembled.resolved.exercises) {
    for (const set of ex.sets) {
      actualSets.set(setKey(ex.slot_id, set.set_number), { slot_id: ex.slot_id, ...set });
    }
  }
  for (const key of expectedSets.keys()) {
    if (!actualSets.has(key)) mismatches.push({ key, kind: 'missing_set' });
  }
  for (const key of actualSets.keys()) {
    if (!expectedSets.has(key)) mismatches.push({ key, kind: 'extra_set' });
  }
  for (const [key, exp] of expectedSets) {
    const act = actualSets.get(key);
    if (!act) continue;
    if (act.load_state !== exp.load_state) {
      mismatches.push({ key, kind: 'load_state', expected: exp.load_state, actual: act.load_state });
    }
    if (act.weight_lb !== exp.weight_lb) {
      mismatches.push({ key, kind: 'weight_lb', expected: exp.weight_lb, actual: act.weight_lb });
    }
    for (const [mKey, mVal] of Object.entries(exp.measurements || {})) {
      if (act.measurements?.[mKey] !== mVal) {
        mismatches.push({ key, kind: mKey, expected: mVal, actual: act.measurements?.[mKey] });
      }
    }
  }
  return mismatches;
}

function compareAssemblyIgnoringRecognizerErrors(assembled, expected, graniteMissFields) {
  const miss = new Set(graniteMissFields);
  return compareAssemblyToExpected(assembled, expected).filter((row) => {
    if (row.kind === 'weight_lb' || row.kind === 'load_state') {
      return !miss.has(`${row.key}.load`);
    }
    const paperKind = {
      reps: 'reps',
      left_reps: 'left',
      right_reps: 'right',
      duration_sec: 'seconds',
      left_duration_sec: 'left_seconds',
      right_duration_sec: 'right_seconds',
    }[row.kind];
    if (paperKind) return !miss.has(`${row.key}.${paperKind}`);
    return true;
  });
}

function issuesForField(review, fieldId) {
  return review.issues.filter((item) => item.field_id === fieldId);
}

function classifyGraniteMiss(row, assembled) {
  const fieldIssues = issuesForField(assembled.review, row.field_id);
  const codes = fieldIssues.map((item) => item.code);
  if (row.clean === 'UNKNOWN' || codes.includes(ISSUE.UNREADABLE_NUMERIC)) {
    return {
      bucket: 'caught_unreadable',
      caught: true,
      codes,
    };
  }
  if (codes.includes(ISSUE.EXTREME_MEASUREMENT) || codes.includes(ISSUE.NON_POSITIVE_MEASUREMENT)) {
    return {
      bucket: 'caught_integrity',
      caught: true,
      codes,
    };
  }
  if (fieldIssues.length > 0) {
    return {
      bucket: 'caught_other_field_issue',
      caught: true,
      codes,
    };
  }
  return {
    bucket: 'silent_survives',
    caught: false,
    codes: [],
  };
}

function reviewFieldIds(review) {
  return new Set(review.issues.map((item) => item.field_id).filter(Boolean));
}

function countNumericFlow(raw, resolved, review) {
  const reviewed = reviewFieldIds(review);
  let paperNumeric = 0;
  let auto = 0;
  let flagged = 0;
  for (const [fieldId, o] of Object.entries(raw.observations)) {
    const kind = numericKindFromFieldId(fieldId);
    if (!kind) continue;
    if (o.paper_state !== PAPER.NONBLANK && o.paper_state !== PAPER.UNCERTAIN) continue;
    paperNumeric += 1;
    if (reviewed.has(fieldId) || o.recognition_state === RECOGNITION.UNKNOWN) {
      flagged += 1;
    } else {
      auto += 1;
    }
  }
  const inherited = [];
  for (const ex of resolved.exercises) {
    for (const set of ex.sets) {
      if (set.load_provenance?.resolution === 'INHERITED') inherited.push(set.load_provenance);
    }
  }
  return { paperNumeric, auto, flagged, inherited: inherited.length };
}

export function schemaIncompatibilities() {
  return [
    {
      id: 'template_version_pattern',
      schema_pattern: '^[ABC]-[0-9]+\\.[0-9]+$',
      emitted: 'A-1.3.1 / B-1.3.1 / C-1.3.1',
      production_schema_changed: false,
      note: 'v1.3.1 form identifiers have three numeric segments. The frozen v1.2 schema pattern only allows two (A-1.2). Candidates emit the real form id and fail this pattern. Schema was not changed.',
    },
    {
      id: 'sv03_v1_2_template_library',
      production_semantic_rule: 'SV03 template_version must equal routine-templates.json (A-1.2 / B-1.2 / C-1.2)',
      production_schema_changed: false,
      note: 'POC #9 maps v1.3.1 paper slots onto the same exercise library, but does not rewrite template_version to v1.2. Existing semanticValidator is not used as the #9 AUTO_ACCEPT gate.',
    },
    {
      id: 'sv13_date_ocr',
      production_semantic_rule: 'date=null requires transcription_status REVIEW_REQUIRED|INVALID and a non-empty date ambiguity detected_value',
      production_schema_changed: false,
      note: 'Date handwriting is out of scope. Candidates leave date null and do not fabricate a visible-date ambiguity. #9 AUTO_ACCEPT ignores SV13; a production save path that still runs SV13 would force review until date OCR exists.',
    },
    {
      id: 'header_text_unrecognized',
      fields: ['date', 'bodyweight_lb', 'duration_min', 'notes', 'pain.areas'],
      note: 'Schema allows null / empty for these. They remain unresolved. No fabricated values.',
    },
  ];
}

function pickExample(assemblies, photoId) {
  return assemblies.find((row) => row.photo_id === photoId) || assemblies[0];
}

function stripHeavy(obj) {
  return JSON.parse(JSON.stringify(obj));
}

export function evaluatePoc9({
  catalog = photoCatalog(),
  graniteRows = loadPoc8bRows(),
  truth = loadNumericGroundTruth(),
  config = loadWorkoutConfig(),
} = {}) {
  const frozen = assertDetectorFrozen();
  const granite = graniteIndex(graniteRows);
  const sheets = Object.fromEntries((truth.sheets || []).map((s) => [s.sheet_id, s]));
  const assemblies = [];
  for (const photo of catalog) {
    const assembled = assemblePhoto(photo, { granite, config });
    assemblies.push({
      photo_id: photo.photo_id,
      sheet_id: photo.sheet_id,
      template_id: photo.template_id,
      primary: sheets[photo.sheet_id]?.primary_photo === photo.photo_id,
      ...assembled,
    });
  }

  const graniteMisses = graniteRows.filter((row) => row.clean !== row.expected);
  const accounting = graniteMisses.map((row) => {
    const assembled = assemblies.find((a) => a.photo_id === row.photo_id);
    const classified = classifyGraniteMiss(row, assembled);
    return {
      sample_id: row.sample_id,
      photo_id: row.photo_id,
      sheet_id: row.sheet_id,
      field_id: row.field_id,
      expected: row.expected,
      granite: row.clean,
      review_status: assembled.review.status,
      ...classified,
    };
  });

  const exactRows = graniteRows.filter((row) => row.clean === row.expected);
  const falseReviewExact = exactRows.filter((row) => {
    const assembled = assemblies.find((a) => a.photo_id === row.photo_id);
    return issuesForField(assembled.review, row.field_id).length > 0;
  }).map((row) => {
    const assembled = assemblies.find((a) => a.photo_id === row.photo_id);
    return {
      sample_id: row.sample_id,
      field_id: row.field_id,
      value: row.clean,
      codes: issuesForField(assembled.review, row.field_id).map((item) => item.code),
    };
  });

  const photoResults = assemblies.map((row) => {
    const sheet = sheets[row.sheet_id];
    const expected = expectedSetsFromTruth(sheet, config);
    const missFields = graniteMisses.filter((g) => g.photo_id === row.photo_id).map((g) => g.field_id);
    const allMismatches = compareAssemblyToExpected(row, expected);
    const structuralMismatches = compareAssemblyIgnoringRecognizerErrors(row, expected, missFields);
    const flow = countNumericFlow(row.raw, row.resolved, row.review);
    return {
      photo_id: row.photo_id,
      sheet_id: row.sheet_id,
      template_id: row.template_id,
      primary: row.primary,
      review_status: row.review.status,
      issue_codes: [...new Set(row.review.issues.map((i) => i.code))],
      issue_count: row.review.issues.length,
      schema_valid: row.schema.valid,
      schema_errors: row.schema.schemaErrors.map((e) => `${e.instancePath} ${e.message}`),
      rewritten_recognition: row.rewritten,
      expected_sets: expected.exercises.reduce((n, ex) => n + ex.sets.length, 0),
      assembled_sets: row.resolved.exercises.reduce((n, ex) => n + ex.sets.length, 0),
      assembly_mismatches_including_granite: allMismatches.length,
      assembly_mismatches_excluding_granite_misses: structuralMismatches.length,
      structural_mismatches: structuralMismatches,
      numeric_flow: flow,
      exercises: row.canonical.workout.exercises.map((ex) => ({
        slot_id: ex.slot_id,
        exercise_id: ex.exercise_id,
        sets: ex.sets.length,
      })),
    };
  });

  const uniqueSheets = [];
  for (const sheet of truth.sheets || []) {
    const photos = photoResults.filter((p) => p.sheet_id === sheet.sheet_id);
    const primary = photos.find((p) => p.photo_id === sheet.primary_photo) || photos[0];
    const statuses = [...new Set(photos.map((p) => p.review_status))];
    uniqueSheets.push({
      sheet_id: sheet.sheet_id,
      template_id: sheet.template_id,
      photos: photos.length,
      primary_photo: sheet.primary_photo,
      primary_review_status: primary.review_status,
      primary_issue_codes: primary.issue_codes,
      primary_issue_count: primary.issue_count,
      photo_review_statuses: Object.fromEntries(photos.map((p) => [p.photo_id, p.review_status])),
      statuses_agree: statuses.length === 1,
      numeric_gt_fields: Object.keys(sheet.values || {}).length,
      primary_numeric_flow: primary.numeric_flow,
      primary_schema_valid: primary.schema_valid,
      primary_structural_mismatches: primary.assembly_mismatches_excluding_granite_misses,
    });
  }

  const buckets = {
    caught_unreadable: accounting.filter((a) => a.bucket === 'caught_unreadable').length,
    caught_integrity: accounting.filter((a) => a.bucket === 'caught_integrity').length,
    caught_other_field_issue: accounting.filter((a) => a.bucket === 'caught_other_field_issue').length,
    silent_survives: accounting.filter((a) => a.bucket === 'silent_survives').length,
  };
  const uniqueSilent = [];
  const seenSilent = new Set();
  for (const row of accounting.filter((a) => a.bucket === 'silent_survives')) {
    const key = `${row.sheet_id}:${row.field_id}:${row.expected}→${row.granite}`;
    if (seenSilent.has(key)) continue;
    seenSilent.add(key);
    uniqueSilent.push({
      sheet_id: row.sheet_id,
      field_id: row.field_id,
      expected: row.expected,
      granite: row.granite,
      photo_ids: accounting.filter((a) => (
        a.sheet_id === row.sheet_id && a.field_id === row.field_id && a.granite === row.granite && a.bucket === 'silent_survives'
      )).map((a) => a.photo_id),
    });
  }

  const primaryFlow = uniqueSheets.reduce((acc, s) => {
    acc.paperNumeric += s.primary_numeric_flow.paperNumeric;
    acc.auto += s.primary_numeric_flow.auto;
    acc.flagged += s.primary_numeric_flow.flagged;
    acc.inherited += s.primary_numeric_flow.inherited;
    return acc;
  }, { paperNumeric: 0, auto: 0, flagged: 0, inherited: 0 });

  const rewrittenAny = assemblies.flatMap((a) => a.rewritten);
  const schemaErrorKinds = [...new Set(photoResults.flatMap((p) => p.schema_errors))];

  return {
    frozen: {
      detector_version: DETECTOR_VERSION,
      detector_sha256: frozen.detector_sha256,
      detect_py_sha256: sha256File(DETECT_PY),
      granite_model: RECOGNIZER_ID,
      crop_profile: CROP_PROFILE,
      numeric_observations: graniteRows.length,
      granite_exact: graniteRows.filter((r) => r.clean === r.expected).length,
    },
    integrity_bounds: INTEGRITY_BOUNDS,
    schema_incompatibilities: schemaIncompatibilities(),
    photo_results: photoResults,
    unique_sheets: uniqueSheets,
    granite_miss_accounting: accounting,
    granite_miss_buckets: buckets,
    silent_survivors_unique: uniqueSilent,
    false_review_of_exact_granite: falseReviewExact,
    primary_numeric_flow: primaryFlow,
    recognized_values_rewritten: rewrittenAny,
    schema_error_kinds: schemaErrorKinds,
    assemblies,
  };
}

function fmtPct(n) {
  if (!n && n !== 0) return 'n/a';
  return `${(n * 100).toFixed(1)}%`;
}

export function renderPoc9Report(evalResult) {
  const f = evalResult.frozen;
  const b = evalResult.granite_miss_buckets;
  const silent = evalResult.silent_survivors_unique;
  const falseReview = evalResult.false_review_of_exact_granite;
  const flow = evalResult.primary_numeric_flow;
  const autoShare = flow.paperNumeric ? flow.auto / flow.paperNumeric : 0;
  const uniqueLines = evalResult.unique_sheets.map((s) => (
    `| ${s.sheet_id} | ${s.photos} | ${s.primary_photo} | ${s.primary_review_status} | ${s.statuses_agree} | ${s.primary_issue_count} | ${s.primary_issue_codes.join(', ') || '—'} | ${s.primary_numeric_flow.auto}/${s.primary_numeric_flow.paperNumeric} | ${s.primary_structural_mismatches} | ${s.primary_schema_valid} |`
  ));
  const photoReview = evalResult.photo_results.filter((p) => p.review_status === REVIEW_STATUS.REVIEW_REQUIRED)
    .map((p) => `${p.photo_id} (${p.sheet_id}: ${p.issue_codes.join(', ')})`);
  const silentLines = silent.length
    ? silent.map((s) => `- \`${s.field_id}\` on ${s.sheet_id}: Granite **${s.granite}** vs paper **${s.expected}** (photos: ${s.photo_ids.join(', ')})`)
    : ['- none'];
  const falseLines = falseReview.length
    ? falseReview.map((s) => `- \`${s.field_id}\` ${s.sample_id}: ${s.value} flagged ${s.codes.join(',')}`)
    : ['- none'];
  const schemaLines = evalResult.schema_incompatibilities.map((s) => `- **${s.id}**: ${s.note}`);
  const boundLines = Object.entries(INTEGRITY_BOUNDS.rationale).map(([k, v]) => `- **${k}** = ${INTEGRITY_BOUNDS[k]} — ${v}`);
  const photoAuto = evalResult.photo_results.filter((p) => p.review_status === REVIEW_STATUS.AUTO_ACCEPT).length;
  const caught = b.caught_unreadable + b.caught_integrity + b.caught_other_field_issue;

  return [
    '# POC #9 — Deterministic Workout Assembly + Semantic Review',
    '',
    'Frozen structural detector + frozen Granite #8B literals → deterministic set assembly, blank-load inheritance, BW semantics, canonical candidates, and conservative review. No handwriting is rewritten. No new recognizer is used.',
    '',
    '## Freeze',
    '',
    `| item | value |`,
    `| --- | --- |`,
    `| detector | ${f.detector_version} |`,
    `| detector SHA256 | \`${f.detector_sha256}\` |`,
    `| detect.py SHA256 | \`${f.detect_py_sha256}\` |`,
    `| numeric observations | ${f.numeric_observations} |`,
    `| Granite #8B exact | ${f.granite_exact}/${f.numeric_observations} |`,
    `| recognizer | ${f.granite_model} |`,
    `| crop profile | ${f.crop_profile} |`,
    '',
    'Granite values are **literal raw observations**, not trusted workout data.',
    '',
    '## Layers',
    '',
    '1. **Raw observations** — detector blank/nonblank + checkbox states + frozen Granite digits (or UNKNOWN).',
    '2. **Resolved transcription** — BW, blank-load inheritance (same exercise, previous resolved load only), measurement-type mapping, provenance.',
    '3. **Canonical workout candidate** — application schema shape. Review metadata is a sibling object, not mixed into set fields.',
    '',
    '## Integrity bounds',
    '',
    ...boundLines,
    '',
    'These are general data-integrity limits. They are not exercise-performance expectations and were not chosen to clear the #8B residual list.',
    '',
    '## Unique physical sheets',
    '',
    '| sheet | photos | primary | primary review | all photos agree | issues | codes | numeric auto/paper | structural mismatches vs GT (excl. Granite misses) | schema valid |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...uniqueLines,
    '',
    `Photo-level AUTO_ACCEPT: **${photoAuto}/${evalResult.photo_results.length}**. Repeated photos of one sheet are not independent workouts.`,
    `Photo-level REVIEW_REQUIRED: ${photoReview.join('; ') || 'none'}.`,
    '',
    '## Granite #8B non-exact accounting (17 observations)',
    '',
    `| bucket | n |`,
    `| --- | --- |`,
    `| caught UNREADABLE_NUMERIC | ${b.caught_unreadable} |`,
    `| caught EXTREME/NON_POSITIVE | ${b.caught_integrity} |`,
    `| caught other field issue | ${b.caught_other_field_issue} |`,
    `| silent plausible wrong | ${b.silent_survives} |`,
    `| **caught total** | **${caught}/17** |`,
    '',
    '### Surviving silent errors (unique physical fields)',
    '',
    ...silentLines,
    '',
    '### Exact Granite values unnecessarily flagged at field level',
    '',
    ...falseLines,
    '',
    `Primary-photo numeric flow (unique sheets, detector-nonblank numeric cells): **${flow.auto}/${flow.paperNumeric}** (${fmtPct(autoShare)}) proceed without a field-level review issue. Inherited blank loads on those sheets: **${flow.inherited}**.`,
    '',
    '## Schema',
    '',
    'Candidates use the frozen v1.2 canonical shape and leave unrecognized headers null. They do **not** pass `validateWorkoutSchema` today because `template_version` `A-1.3.1` fails `^[ABC]-[0-9]+\\.[0-9]+$`. Production schema was not modified.',
    '',
    ...schemaLines,
    '',
    `Distinct schema error strings: ${evalResult.schema_error_kinds.join('; ') || 'none'}`,
    '',
    `Recognized handwriting rewritten during assembly: **${evalResult.recognized_values_rewritten.length}** (must be 0).`,
    '',
    '## Answers',
    '',
    '1. **Can frozen structural + numeric observations be deterministically assembled into workout sets?** Yes. A/B/C slot maps come from routine-templates + exercise-library. Blank rows become no set object. Completed rows become working sets with the correct measurement family.',
    '2. **Does blank-load inheritance work without AI?** Yes. Same-exercise previous resolved load only. Provenance `INHERITED` with `source_field_id`. No look-forward, no cross-exercise copy.',
    '3. **Are BW load states resolved correctly?** Yes. Checked BW + blank load → `load_state=bodyweight`, `weight_lb=null`. BW + written load → `CONFLICTING_LOAD_STATE` review; neither value is preferred.',
    '4. **Are A/B/C measurement types assembled correctly?** Yes. Bilateral reps (`reps`), unilateral reps (`left_reps`/`right_reps`), bilateral timed (`duration_sec`), unilateral timed (`left_duration_sec`/`right_duration_sec`). Farmer Carry stays bilateral timed; Suitcase Carry stays unilateral timed.',
    '5. **Can candidates pass the existing schema without fabricating header data?** No. Headers stay null as specified; the blocking incompatibility is `template_version` pattern vs `*-1.3.1`. Exercise/set payload otherwise matches the canonical shape.',
    '6. **Exact schema incompatibility:** `workout.template_version` pattern `^[ABC]-[0-9]+\\.[0-9]+$` rejects `A-1.3.1`. Independently, production `semanticValidator` SV03 expects `A-1.2` and SV13 requires a non-empty date ambiguity when `date=null`. Schema files were not changed.',
    '7. **Deterministic semantic rules:** UNREADABLE_NUMERIC, MISSING_INITIAL_LOAD, CONFLICTING_LOAD_STATE, INCOMPLETE_MEASUREMENT, NON_POSITIVE_MEASUREMENT, EXTREME_MEASUREMENT (documented bounds), MULTIPLE_EFFORT_SELECTIONS, MULTIPLE_PAIN_SELECTIONS, plus uncertain detector states.',
    '8. **Which rules cause REVIEW_REQUIRED?** Any issue above. AUTO_ACCEPT only when structure, load resolution, and integrity checks are clean. No Granite self-confidence, no #8C, no TrOCR.',
    `9. **Of the 17 known Granite non-exacts, how many are caught?** ${caught}/17 (${b.caught_unreadable} UNKNOWN, ${b.caught_integrity} integrity, ${b.caught_other_field_issue} other). C07 410s is **not** caught by EXTREME_MEASUREMENT (410 < 600). It may share a C photo that is already REVIEW_REQUIRED for C04 UNKNOWN; the 410 value itself would still AUTO_ACCEPT.`,
    `10. **How many plausible-but-wrong Granite values survive?** ${b.silent_survives}/17 photo-level; ${silent.length} unique physical field/value pairs.`,
    `11. **Surviving values:** ${silent.length ? silent.map((s) => `${s.field_id} ${s.granite}≠${s.expected}`).join('; ') : 'none'}.`,
    `12. **Correct recognized values unnecessarily flagged (field-level)?** ${falseReview.length}. IMG_1321 is a photo-level REVIEW_REQUIRED from effort-checkbox detector uncertainty/multiple-selection, not from a correct Granite digit.`,
    '13. **Review burden per unique sheet:** see table. Unique-sheet status uses the primary photo. C is reviewed because C04.S1.load is UNKNOWN. A and B-original AUTO_ACCEPT on primary photos despite surviving glyph errors. B-2026-09-20 AUTO_ACCEPT with inheritance from 40 lb. A’s IMG_1321 capture disagrees (effort checkboxes).',
    `14. **Numeric data without review (primary unique sheets):** ${fmtPct(autoShare)} of detector-nonblank numeric cells (${flow.auto}/${flow.paperNumeric}).`,
    '15. **Are semantic rules benchmark-specific or handwriting-specific?** No. Bounds are general integrity limits. 410 seconds is intentionally below `duration_sec_max=600` so the residual extra-digit error is not specially targeted.',
    '16. **Is raw → resolved → canonical clean enough for production architecture?** Yes, as an ingestion contract: detector/recognizer literals stay immutable; inheritance is explicit provenance; review is a sibling document; canonical mapping does not invent header text. Remaining production blockers are schema versioning for 1.3.1, date OCR or an explicit “date unresolved” status that SV13 accepts, and a review UI / save path.',
    '17. **What remains before an actual workout can be saved?** Date (and optionally bodyweight, duration, notes, pain areas) recognition or an agreed unresolved-header policy; a `template_version` schema that accepts `*-1.3.1`; human review of REVIEW_REQUIRED fields; workout_id assignment; API persistence. Do not add another numeric recognizer to chase the surviving 45/95, 6/8, 96/90, 410/40 families — make those visible or accept them as residual risk.',
    '',
    '## Architectural decision',
    '',
    'The pipeline **photo → geometry → structure → isolated numeric recognition → deterministic assembly → semantic validation → tiny human review → canonical workout** is viable. Numeric recognition does not need to be perfect. This layer already prevents UNKNOWN and conflicting load states from silent save. Plausible glyph errors still reach AUTO_ACCEPT; catching them with coaching-style neighbor/range rules would overfit and is rejected here.',
    '',
    '## STOP',
    '',
    'POC #9 stops here. Detector, crops, Granite, date/bodyweight/duration/notes OCR, review UI, persistence, and POC #10 were not started.',
    '',
  ].join('\n');
}

export function runPoc9() {
  const evalResult = evaluatePoc9();
  fs.mkdirSync(POC9_ARTIFACT_DIR, { recursive: true });
  const report = renderPoc9Report(evalResult);

  const primaryB = evalResult.assemblies.find((a) => a.photo_id === 'routine-B-v1.3.1');
  const primaryC = evalResult.assemblies.find((a) => a.photo_id === 'IMG_1315');
  const inheritB = evalResult.assemblies.find((a) => a.photo_id === 'IMG_1311');

  const rawExample = {
    _comment: 'Raw observations for Routine B original (primary photo). Literals only.',
    photo_id: primaryB.raw.photo_id,
    sheet_id: primaryB.raw.sheet_id,
    template_id: primaryB.raw.template_id,
    observations: Object.fromEntries(
      Object.entries(primaryB.raw.observations).filter(([id]) => (
        id.startsWith('B03.') || id.startsWith('B01.S1.') || id.startsWith('header.effort') || id.startsWith('header.pain')
      )),
    ),
  };
  const resolvedExample = {
    _comment: 'Resolved transcription excerpt: B01 BW, B03 inherited load, provenance.',
    photo_id: primaryB.resolved.photo_id,
    header: primaryB.resolved.header,
    exercises: primaryB.resolved.exercises
      .filter((ex) => ex.slot_id === 'B01' || ex.slot_id === 'B03' || ex.slot_id === 'B07')
      .map((ex) => ({
        slot_id: ex.slot_id,
        exercise_id: ex.exercise_id,
        measurement_kind: ex.measurement_kind,
        skipped_rows: ex.skipped_rows,
        sets: ex.sets,
      })),
  };
  const canonicalExample = stripHeavy(primaryB.canonical);
  const reviewExample = {
    _comment: 'Routine C primary photo: C04.S1.load UNKNOWN requires review. 410s is not rewritten.',
    photo_id: primaryC.photo_id,
    status: primaryC.review.status,
    issues: primaryC.review.issues,
    c07_s2: primaryC.resolved.exercises.find((ex) => ex.slot_id === 'C07')?.sets.find((s) => s.set_number === 2),
  };

  const results = {
    detector_version: DETECTOR_VERSION,
    detector_sha256: evalResult.frozen.detector_sha256,
    detect_py_sha256: evalResult.frozen.detect_py_sha256,
    recognizer: RECOGNIZER_ID,
    crop_profile: CROP_PROFILE,
    eligible_crops: evalResult.frozen.numeric_observations,
    granite_exact: evalResult.frozen.granite_exact,
    integrity_bounds: INTEGRITY_BOUNDS,
    schema_incompatibilities: evalResult.schema_incompatibilities,
    photo_results: evalResult.photo_results,
    unique_sheets: evalResult.unique_sheets,
    granite_miss_buckets: evalResult.granite_miss_buckets,
    silent_survivors_unique: evalResult.silent_survivors_unique,
    false_review_of_exact_granite: evalResult.false_review_of_exact_granite,
    primary_numeric_flow: evalResult.primary_numeric_flow,
    recognized_values_rewritten: evalResult.recognized_values_rewritten.length,
    schema_error_kinds: evalResult.schema_error_kinds,
    inherit_demo_photo: inheritB.photo_id,
    inherit_demo: inheritB.resolved.exercises.find((ex) => ex.slot_id === 'B03')?.sets.map((s) => ({
      set_number: s.set_number,
      weight_lb: s.weight_lb,
      load_state: s.load_state,
      resolution: s.load_provenance.resolution,
      source_field_id: s.load_provenance.source_field_id || null,
    })),
    artifacts: {
      report: path.join(POC9_ARTIFACT_DIR, 'REPORT.md'),
      results: path.join(POC9_ARTIFACT_DIR, 'results.json'),
      raw_example: path.join(POC9_ARTIFACT_DIR, 'raw-observation-example.json'),
      resolved_example: path.join(POC9_ARTIFACT_DIR, 'resolved-transcription-example.json'),
      canonical_example: path.join(POC9_ARTIFACT_DIR, 'canonical-candidate-example.json'),
      review_example: path.join(POC9_ARTIFACT_DIR, 'review-required-example.json'),
      accounting: path.join(POC9_ARTIFACT_DIR, 'semantic-error-accounting.json'),
    },
  };

  const accounting = {
    detector_sha256: evalResult.frozen.detector_sha256,
    granite_non_exact: evalResult.granite_miss_accounting.length,
    buckets: evalResult.granite_miss_buckets,
    observations: evalResult.granite_miss_accounting,
    silent_survivors_unique: evalResult.silent_survivors_unique,
    false_review_of_exact_granite: evalResult.false_review_of_exact_granite,
    integrity_bounds: INTEGRITY_BOUNDS,
  };

  fs.writeFileSync(path.join(POC9_ARTIFACT_DIR, 'REPORT.md'), report);
  fs.writeFileSync(path.join(POC9_ARTIFACT_DIR, 'results.json'), JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(POC9_ARTIFACT_DIR, 'raw-observation-example.json'), JSON.stringify(rawExample, null, 2));
  fs.writeFileSync(path.join(POC9_ARTIFACT_DIR, 'resolved-transcription-example.json'), JSON.stringify(resolvedExample, null, 2));
  fs.writeFileSync(path.join(POC9_ARTIFACT_DIR, 'canonical-candidate-example.json'), JSON.stringify(canonicalExample, null, 2));
  fs.writeFileSync(path.join(POC9_ARTIFACT_DIR, 'review-required-example.json'), JSON.stringify(reviewExample, null, 2));
  fs.writeFileSync(path.join(POC9_ARTIFACT_DIR, 'semantic-error-accounting.json'), JSON.stringify(accounting, null, 2));

  return { ...results, report_markdown: report, report: results.artifacts.report };
}
