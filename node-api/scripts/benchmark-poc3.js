import fs from 'node:fs';
import { loadWorkoutConfig, ollamaModel } from '../lib/workout/config.js';
import { runPoc3Reliability } from '../lib/workout/poc3.js';

const outPath = process.argv[2] || '/tmp/poc3-reliability.json';
const config = loadWorkoutConfig();
const imageBuffer = fs.readFileSync(config.fixtureImagePath);
const partial = [];

function writePartial(extra = {}) {
  fs.writeFileSync(outPath, JSON.stringify({
    poc: 3,
    variant: 'whole-page',
    model: ollamaModel(),
    partial: true,
    results: partial,
    ...extra,
  }, null, 2));
}

console.log(`POC #3 reliability model=${ollamaModel()} image=${config.fixtureImagePath}`);
const report = await runPoc3Reliability({
  imageBuffer,
  runs: 3,
  onRun: (entry) => {
    partial.push({
      run: entry.run,
      ok: entry.ok,
      elapsed_ms: entry.elapsed_ms,
      exactMatch: entry.exactMatch,
      b03_exact: entry.b03_exact,
      schemaValid: entry.validation?.valid,
      parseError: entry.parseError,
      rawTranscription: entry.rawTranscription,
    });
    writePartial();
    console.error(`run ${entry.run} ok=${entry.ok} exact=${entry.exactMatch} b03=${entry.b03_exact} ms=${entry.elapsed_ms}`);
  },
});

const summary = {
  poc: report.poc,
  variant: report.variant,
  model: report.model,
  runs: report.runs,
  elapsed_ms: report.elapsed_ms,
  canonicalExactMatchCount: report.canonicalExactMatchCount,
  schemaValidCount: report.schemaValidCount,
  b03ExactCount: report.b03ExactCount,
  consistentCount: report.comparison.consistentCount,
  fieldCount: report.comparison.fieldCount,
  expectedMatchCount: report.comparison.expectedMatchCount,
  focus: report.comparison.focus,
  mismatches: report.comparison.mismatches,
  fields: report.comparison.fields,
  results: report.results.map((result) => ({
    run: result.run,
    ok: result.ok,
    elapsed_ms: result.elapsed_ms,
    exactMatch: result.exactMatch,
    b03_exact: result.b03_exact,
    schemaValid: result.validation?.valid,
    parseError: result.parseError,
    highSeverityMismatches: result.highSeverityMismatches,
    rawTranscription: result.rawTranscription,
  })),
};

fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
console.log(JSON.stringify({
  outPath,
  canonicalExactMatchCount: summary.canonicalExactMatchCount,
  schemaValidCount: summary.schemaValidCount,
  b03ExactCount: summary.b03ExactCount,
  consistentCount: summary.consistentCount,
  fieldCount: summary.fieldCount,
  expectedMatchCount: summary.expectedMatchCount,
  focus: summary.focus,
  mismatchCount: summary.mismatches.length,
}, null, 2));

if (summary.canonicalExactMatchCount < 3 || summary.mismatches.length > 0) {
  process.exitCode = 1;
}
