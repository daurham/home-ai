import { loadV131WorkoutConfig } from './v131Config.js';

const BILATERAL_REP = ['reps'];
const UNILATERAL_REP = ['left_reps', 'right_reps'];
const BILATERAL_TIME = ['duration_sec'];
const UNILATERAL_TIME = ['left_duration_sec', 'right_duration_sec'];
const ALL_MEASUREMENT_FIELDS = [
  ...BILATERAL_REP,
  ...UNILATERAL_REP,
  ...BILATERAL_TIME,
  ...UNILATERAL_TIME,
];

export const DATE_ISSUE_CODES = {
  BLANK_DATE: 'BLANK_DATE',
  PARTIAL_DATE: 'PARTIAL_DATE',
  UNREADABLE_DATE: 'UNREADABLE_DATE',
  INVALID_DATE: 'INVALID_DATE',
};

/**
 * v1.3.1 semantic validator. SV03 uses A/B/C-1.3.1 templates.
 * SV13 classifies null dates instead of requiring a fabricated ambiguity for every null.
 * v1.2 validateWorkoutSemantics is unchanged.
 */
export function validateWorkoutSemanticsV13(record, {
  review = { issues: [] },
  config = loadV131WorkoutConfig(),
} = {}) {
  const errors = [];
  const warnings = [];
  if (!record || typeof record !== 'object') {
    return { valid: false, semanticErrors: [{ path: '/', message: 'Record is not an object' }], warnings };
  }

  if (hasOwn(record, 'workout_id')) {
    errors.push({
      id: 'SV14',
      path: '/workout_id',
      message: 'Transcription output must not include workout_id',
    });
  }

  const workout = record.workout;
  if (!workout || typeof workout !== 'object') {
    return { valid: errors.length === 0, semanticErrors: errors, warnings };
  }

  if (hasOwn(workout, 'workout_id')) {
    errors.push({
      id: 'SV14',
      path: '/workout/workout_id',
      message: 'Transcription output must not include workout_id',
    });
  }

  const routine = workout.routine;
  const selected = config.routinesById[routine];
  if (!selected) {
    errors.push({
      id: 'SV03',
      path: '/workout/routine',
      message: `Unknown routine ${String(routine)}`,
    });
  } else if (workout.template_version !== selected.template_version) {
    errors.push({
      id: 'SV03',
      path: '/workout/template_version',
      message: `template_version ${workout.template_version} does not match ${selected.template_version}`,
    });
  }

  validateDateSemantics(record, review, errors);

  const slotMap = Object.fromEntries((selected?.slots || []).map((s) => [s.slot_id, s]));
  const exercises = Array.isArray(workout.exercises) ? workout.exercises : [];
  exercises.forEach((exercise, exIndex) => {
    const exPath = `/workout/exercises/${exIndex}`;
    if (!exercise || typeof exercise !== 'object') return;

    if (routine && exercise.slot_id && String(exercise.slot_id)[0] !== String(routine)) {
      errors.push({
        id: 'SV01',
        path: `${exPath}/slot_id`,
        message: `slot_id ${exercise.slot_id} does not match routine ${routine}`,
      });
    }

    const expectedSlot = slotMap[exercise.slot_id];
    if (exercise.slot_id && selected && !expectedSlot) {
      errors.push({
        id: 'SV02',
        path: `${exPath}/slot_id`,
        message: `slot_id ${exercise.slot_id} is not in routine ${routine}`,
      });
    } else if (expectedSlot && exercise.exercise_id !== expectedSlot.exercise_id) {
      errors.push({
        id: 'SV02',
        path: `${exPath}/exercise_id`,
        message: `slot ${exercise.slot_id} must be ${expectedSlot.exercise_id}, got ${exercise.exercise_id}`,
      });
    }

    const libEx = config.exercisesById[exercise.exercise_id];
    const sets = Array.isArray(exercise.sets) ? exercise.sets : [];
    const seenSetNumbers = new Set();
    sets.forEach((set, setIndex) => {
      const setPath = `${exPath}/sets/${setIndex}`;
      if (!set || typeof set !== 'object') return;
      if (seenSetNumbers.has(set.set_number)) {
        errors.push({
          id: 'SV04',
          path: `${setPath}/set_number`,
          message: `Duplicate set_number ${set.set_number} in ${exercise.slot_id || 'exercise'}`,
        });
      }
      seenSetNumbers.add(set.set_number);
      validateLoadState(set, setPath, errors);
      if (libEx) validateMeasurement(set, libEx, setPath, errors);
    });
  });

  return {
    valid: errors.length === 0,
    semanticErrors: errors,
    warnings,
  };
}

function validateDateSemantics(record, review, errors) {
  const workout = record.workout;
  const issues = Array.isArray(review?.issues) ? review.issues : [];
  const dateCodes = new Set(
    issues.filter((i) => i && Object.values(DATE_ISSUE_CODES).includes(i.code)).map((i) => i.code),
  );
  const ambiguities = Array.isArray(record.ambiguities) ? record.ambiguities : [];
  const dateAmbiguity = ambiguities.find((item) => isDateAmbiguity(item));

  if (workout.date != null) {
    if (dateCodes.has(DATE_ISSUE_CODES.PARTIAL_DATE)
      || dateCodes.has(DATE_ISSUE_CODES.BLANK_DATE)
      || dateCodes.has(DATE_ISSUE_CODES.UNREADABLE_DATE)
      || dateCodes.has(DATE_ISSUE_CODES.INVALID_DATE)) {
      errors.push({
        id: 'SV13',
        path: '/workout/date',
        message: 'Complete ISO date must not carry a null-date classification issue',
      });
    }
    return;
  }

  if (dateCodes.has(DATE_ISSUE_CODES.PARTIAL_DATE)) {
    if (!dateAmbiguity || dateAmbiguity.detected_value == null || dateAmbiguity.detected_value === '') {
      errors.push({
        id: 'SV13',
        path: '/ambiguities',
        message: 'PARTIAL_DATE requires an ambiguity that preserves the visible month/day literal in detected_value',
      });
    }
    return;
  }

  if (dateCodes.has(DATE_ISSUE_CODES.INVALID_DATE)) {
    const issue = issues.find((i) => i.code === DATE_ISSUE_CODES.INVALID_DATE);
    if (issue && (issue.observed_value == null || issue.observed_value === '')) {
      errors.push({
        id: 'SV13',
        path: '/workout/date',
        message: 'INVALID_DATE must preserve the recognized literal',
      });
    }
    return;
  }

  if (dateCodes.has(DATE_ISSUE_CODES.UNREADABLE_DATE)) {
    if (dateAmbiguity && (dateAmbiguity.detected_value == null || dateAmbiguity.detected_value === '')) {
      errors.push({
        id: 'SV13',
        path: '/ambiguities',
        message: 'UNREADABLE_DATE must not fabricate an empty date ambiguity detected_value',
      });
    }
    return;
  }

  if (dateCodes.has(DATE_ISSUE_CODES.BLANK_DATE) || dateCodes.size === 0) {
    if (dateAmbiguity) {
      errors.push({
        id: 'SV13',
        path: '/ambiguities',
        message: 'PAPER_BLANK date must not fabricate a date ambiguity (SV12 missing data is not an ambiguity)',
      });
    }
    return;
  }

  errors.push({
    id: 'SV13',
    path: '/workout/date',
    message: 'date=null is unclassified; expected BLANK_DATE, PARTIAL_DATE, UNREADABLE_DATE, or INVALID_DATE',
  });
}

function validateLoadState(set, setPath, errors) {
  if (set.load_state === 'external') {
    if (typeof set.weight_lb !== 'number') {
      errors.push({
        id: 'SV15',
        path: `${setPath}/weight_lb`,
        message: 'load_state=external requires a numeric weight_lb',
      });
    }
  } else if (set.load_state === 'bodyweight' || set.load_state === 'unknown') {
    if (set.weight_lb != null) {
      errors.push({
        id: 'SV11',
        path: `${setPath}/weight_lb`,
        message: `load_state=${set.load_state} requires weight_lb=null`,
      });
    }
  }
}

function validateMeasurement(set, libEx, setPath, errors) {
  const measurement = libEx.measurement;
  const allowed = allowedFields(measurement);
  if (!allowed) return;
  const present = ALL_MEASUREMENT_FIELDS.filter((field) => hasValue(set, field));
  const unexpected = present.filter((field) => !allowed.includes(field));
  if (unexpected.length) {
    errors.push({
      id: 'SV05',
      path: setPath,
      message: `${libEx.exercise_id} (${measurement}) must not include ${unexpected.join(', ')}`,
    });
  }
  const hasAllowed = present.some((field) => allowed.includes(field));
  if (!hasAllowed) {
    errors.push({
      id: 'SV05',
      path: setPath,
      message: `${libEx.exercise_id} (${measurement}) requires ${allowed.join(' or ')}`,
    });
  }
}

function allowedFields(measurement) {
  switch (measurement) {
    case 'reps':
      return BILATERAL_REP;
    case 'reps_per_side':
      return UNILATERAL_REP;
    case 'duration':
      return BILATERAL_TIME;
    case 'duration_per_side':
      return UNILATERAL_TIME;
    default:
      return null;
  }
}

function isDateAmbiguity(item) {
  if (!item || typeof item !== 'object') return false;
  const field = String(item.field || '').toLowerCase();
  const location = String(item.location || '').toLowerCase();
  return field === 'date' || location.includes('date');
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function hasValue(obj, key) {
  return hasOwn(obj, key) && obj[key] != null;
}
