import fs from 'node:fs';
import { loadWorkoutConfig, ollamaModel } from '../lib/workout/config.js';
import { transcribePoc2 } from '../lib/workout/poc2.js';

const variant = process.argv[2] === 'crops' ? 'crops' : 'whole-page';
const config = loadWorkoutConfig();
const imageBuffer = fs.readFileSync(config.fixtureImagePath);

console.log(`POC #2 variant=${variant} model=${ollamaModel()}`);
const result = await transcribePoc2({ imageBuffer, variant });
const report = {
  poc: result.poc,
  variant: result.variant,
  model: result.model,
  elapsed_ms: result.elapsed_ms,
  calls: result.calls,
  promptUsedPack: result.promptUsedPack,
  b03_exact: result.benchmark.b03_exact,
  b03_actual: result.benchmark.b03_actual,
  exactMatch: result.benchmark.exactMatch,
  schemaValid: result.validation.valid,
  schemaErrors: result.validation.schemaErrors,
  semanticErrors: result.validation.semanticErrors,
  highSeverityMismatches: result.benchmark.highSeverityMismatches,
  lowSeverityMismatches: result.benchmark.lowSeverityMismatches,
  rawTranscription: result.rawTranscription,
  workout: result.workout,
};
console.log(JSON.stringify(report, null, 2));
if (!result.benchmark.b03_exact || !result.validation.valid || !result.benchmark.exactMatch) {
  process.exitCode = 1;
}
