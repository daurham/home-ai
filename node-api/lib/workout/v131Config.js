import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const V131_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../config/workout-v1.3.1');
const V12_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../config/workout-v1.2');

let cache = null;

export function v131ConfigDir() {
  return V131_DIR;
}

export function loadV131WorkoutConfig(dir = V131_DIR) {
  if (cache && cache.dir === dir) return cache;
  const read = (base, name) => fs.readFileSync(path.join(base, name), 'utf8');
  const schema = JSON.parse(read(dir, 'workout-record.schema.json'));
  const templates = JSON.parse(read(dir, 'routine-templates.json'));
  const semanticRules = JSON.parse(read(dir, 'semantic-validation-rules.json'));
  const library = JSON.parse(read(V12_DIR, 'exercise-library.json'));
  const exercisesById = Object.fromEntries((library.exercises || []).map((ex) => [ex.exercise_id, ex]));
  const routinesById = Object.fromEntries((templates.routines || []).map((r) => [r.routine_id, r]));
  cache = {
    dir,
    schema,
    templates,
    semanticRules,
    library,
    exercisesById,
    routinesById,
    schema_version: '1.3',
    paper_template_library: '1.3.1',
  };
  return cache;
}

export function clearV131WorkoutConfigCache() {
  cache = null;
}
