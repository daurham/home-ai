import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../config/workout-v1.2',
);

export const DEFAULT_OLLAMA_MODEL = 'llama3.2-vision:11b';
export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';
export const DEFAULT_TRANSCRIBE_TIMEOUT_MS = 600000;

let cache = null;

export function workoutConfigDir(env = process.env) {
  return env.WORKOUT_CONFIG_DIR || DEFAULT_DIR;
}

export function loadWorkoutConfig(dir = workoutConfigDir()) {
  if (cache && cache.dir === dir) return cache;

  const read = (name) => fs.readFileSync(path.join(dir, name), 'utf8');
  const pack = read('WORKOUT-AI-TRANSCRIPTION-PACK-v1.2.txt');
  const schema = JSON.parse(read('workout-record.schema.json'));
  const templates = JSON.parse(read('routine-templates.json'));
  const library = JSON.parse(read('exercise-library.json'));
  const semanticRules = JSON.parse(read('semantic-validation-rules.json'));
  const expectedRoutineB = JSON.parse(read('routine-B-real-sheet-expected-v1.2.json'));

  const exercisesById = Object.fromEntries(
    (library.exercises || []).map((ex) => [ex.exercise_id, ex]),
  );
  const routinesById = Object.fromEntries(
    (templates.routines || []).map((r) => [r.routine_id, r]),
  );

  cache = {
    dir,
    pack,
    schema,
    templates,
    library,
    semanticRules,
    expectedRoutineB,
    exercisesById,
    routinesById,
    fixtureImagePath: path.join(dir, 'fixtures', 'routine-B-real-sheet.jpg'),
  };
  return cache;
}

export function clearWorkoutConfigCache() {
  cache = null;
}

export function ollamaBaseUrl(env = process.env) {
  if (env.OLLAMA_BASE_URL) return stripSlash(env.OLLAMA_BASE_URL);
  const raw = env.OLLAMA_URL || DEFAULT_OLLAMA_BASE_URL;
  try {
    const withScheme = raw.includes('://') ? raw : `http://${raw}`;
    const parsed = new URL(withScheme);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return DEFAULT_OLLAMA_BASE_URL;
  }
}

export function ollamaModel(env = process.env) {
  return env.OLLAMA_MODEL || DEFAULT_OLLAMA_MODEL;
}

export function transcribeTimeoutMs(env = process.env) {
  const n = Number(env.OLLAMA_TRANSCRIBE_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TRANSCRIBE_TIMEOUT_MS;
}

function stripSlash(value) {
  return String(value).replace(/\/+$/, '');
}
