import fs from 'node:fs';
import { loadWorkoutConfig, ollamaModel } from '../lib/workout/config.js';
import { transcribeWorkoutSheet } from '../lib/workout/transcribe.js';
import { compareFixture } from '../lib/workout/compareFixture.js';

const config = loadWorkoutConfig();
const imageBuffer = fs.readFileSync(config.fixtureImagePath);
const started = Date.now();

console.log(`Model: ${ollamaModel()}`);
console.log(`Fixture: ${config.fixtureImagePath}`);

const result = await transcribeWorkoutSheet({ imageBuffer });
const comparison = result.workout
  ? compareFixture(config.expectedRoutineB, result.workout)
  : { match: false, mismatches: [{ path: '/', kind: 'missing', expected: config.expectedRoutineB, actual: null, severity: 'high' }], highSeverity: [], lowSeverity: [] };

const report = {
  model: result.model,
  elapsed_ms: result.elapsed_ms,
  wall_ms: Date.now() - started,
  schemaValid: result.validation.schemaErrors.length === 0 && result.workout != null,
  semanticValid: result.validation.semanticErrors.length === 0 && result.workout != null,
  overallValid: result.validation.valid,
  exactMatch: comparison.match,
  highSeverityMismatches: comparison.highSeverity || comparison.mismatches.filter((m) => m.severity === 'high'),
  lowSeverityMismatches: comparison.lowSeverity || comparison.mismatches.filter((m) => m.severity === 'low'),
  schemaErrors: result.validation.schemaErrors,
  semanticErrors: result.validation.semanticErrors,
  warnings: result.validation.warnings,
};

console.log(JSON.stringify(report, null, 2));
if (!result.validation.valid || !comparison.match) process.exitCode = 1;
