import { loadWorkoutConfig } from './config.js';
import { ROUTINE_ID, SLOT_LAYOUT } from './rawSchema.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function normalizeRawTranscription(raw, config = loadWorkoutConfig()) {
  const routine = config.routinesById[ROUTINE_ID];
  if (!routine) throw new Error(`Routine ${ROUTINE_ID} is missing from templates`);

  const ambiguities = [];
  const dateWritten = blankToNull(raw?.date_written);
  let date = null;
  let transcription_status = 'VALID';

  if (dateWritten == null) {
    transcription_status = 'REVIEW_REQUIRED';
    ambiguities.push({
      location: 'workout.date',
      field: 'date',
      detected_value: null,
      reason: 'Date cell is blank; full ISO date cannot be determined without inference.',
    });
  } else if (ISO_DATE.test(String(dateWritten).trim())) {
    date = String(dateWritten).trim();
  } else {
    transcription_status = 'REVIEW_REQUIRED';
    date = null;
    ambiguities.push({
      location: 'workout.date',
      field: 'date',
      detected_value: String(dateWritten).trim(),
      reason: 'Year is not written; full ISO date cannot be determined without inference.',
    });
  }

  const exercises = routine.slots.map((slot) => {
    const layout = SLOT_LAYOUT[slot.slot_id];
    const libEx = config.exercisesById[slot.exercise_id];
    const rows = Array.isArray(raw?.[slot.slot_id]) ? raw[slot.slot_id] : [];
    return {
      slot_id: slot.slot_id,
      exercise_id: slot.exercise_id,
      sets: normalizeSets(rows, layout, libEx),
      notes: null,
    };
  }).filter((exercise) => exercise.sets.length > 0);

  return {
    schema_version: '1.2',
    transcription_status,
    ambiguities,
    workout: {
      date,
      routine: ROUTINE_ID,
      template_version: routine.template_version,
      duration_min: null,
      effort: toIntOrNull(raw?.effort),
      pain: {
        level: toIntOrNull(raw?.pain),
        areas: [],
        notes: null,
      },
      bodyweight_lb: toNumberOrNull(raw?.bodyweight),
      notes: blankToNull(raw?.note),
      exercises,
    },
  };
}

export function normalizeSets(rows, layout, libEx) {
  const sets = [];
  let inherited = null;
  const planned = layout?.planned || rows.length;

  for (let i = 0; i < Math.max(rows.length, planned); i += 1) {
    const row = rows[i];
    if (!row || typeof row !== 'object') continue;
    if (!rowHasPerformance(row, layout)) continue;

    const parsedWeight = parseWeight(row.weight);
    let load;
    if (parsedWeight.kind === 'bw') {
      load = { load_state: 'bodyweight', weight_lb: null };
    } else if (parsedWeight.kind === 'numeric') {
      load = { load_state: 'external', weight_lb: parsedWeight.value };
    } else if (inherited) {
      load = { ...inherited };
    } else {
      load = { load_state: 'unknown', weight_lb: null };
    }
    inherited = load;

    const set = {
      set_number: i + 1,
      type: 'working',
      weight_lb: load.weight_lb,
      load_state: load.load_state,
      notes: null,
    };
    assignMeasurement(set, row, layout, libEx);
    sets.push(set);
  }
  return sets;
}

export function parseWeight(value) {
  if (value == null || value === '') return { kind: 'blank' };
  if (typeof value === 'number' && Number.isFinite(value)) return { kind: 'numeric', value };
  const text = String(value).trim();
  if (!text) return { kind: 'blank' };
  const upper = text.toUpperCase().replace(/\s+/g, '');
  if (upper === 'BW' || upper === 'BODYWEIGHT' || upper === 'BODYWT') return { kind: 'bw' };
  const numeric = Number(text.replace(/[^\d.-]/g, ''));
  if (Number.isFinite(numeric) && /[\d]/.test(text)) return { kind: 'numeric', value: numeric };
  return { kind: 'blank' };
}

function rowHasPerformance(row, layout) {
  if (layout?.kind === 'unilateral_reps') {
    return row.left != null || row.right != null;
  }
  if (layout?.kind === 'unilateral_time') {
    return row.left_sec != null || row.right_sec != null;
  }
  return row.reps != null;
}

function assignMeasurement(set, row, layout, libEx) {
  const measurement = libEx?.measurement || layout?.kind;
  if (measurement === 'reps_per_side' || layout?.kind === 'unilateral_reps') {
    if (row.left != null) set.left_reps = toIntOrNull(row.left);
    if (row.right != null) set.right_reps = toIntOrNull(row.right);
    return;
  }
  if (measurement === 'duration_per_side' || layout?.kind === 'unilateral_time') {
    if (row.left_sec != null) set.left_duration_sec = toNumberOrNull(row.left_sec);
    if (row.right_sec != null) set.right_duration_sec = toNumberOrNull(row.right_sec);
    return;
  }
  if (measurement === 'duration' || layout?.kind === 'bilateral_time') {
    if (row.duration_sec != null) set.duration_sec = toNumberOrNull(row.duration_sec);
    return;
  }
  if (row.reps != null) set.reps = toIntOrNull(row.reps);
}

function blankToNull(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function toIntOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : (Number.isFinite(n) ? Math.round(n) : null);
}

function toNumberOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
