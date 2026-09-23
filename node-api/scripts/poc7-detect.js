import fs from 'node:fs';
import {
  ARTIFACT_DIR,
  BLANK_TEMPLATE_PATH,
  OBSERVATIONS_PATH,
  RECTIFIED_PATH,
  detectV131Observations,
  formatBenchmarkReport,
  loadBenchmarkTruth,
  renderBlankTemplate,
  scoreObservations,
  validateBenchmarkTruth,
  validateObservations,
} from '../lib/workout/poc7/index.js';
import { loadB131Template } from '../lib/workout/poc6/index.js';

const outDir = process.argv[2] || ARTIFACT_DIR;

const truthCheck = validateBenchmarkTruth();
if (!truthCheck.ok) {
  console.error(truthCheck);
  process.exit(1);
}

const blank = await renderBlankTemplate({ outPath: `${outDir}/poc7-blank-template.png` });
if (!fs.existsSync(RECTIFIED_PATH)) {
  console.error(`missing ${RECTIFIED_PATH}; run npm run poc6 first`);
  process.exit(1);
}

const result = await detectV131Observations({
  blankPath: blank.path,
  observedPath: RECTIFIED_PATH,
  outDir,
});
if (!result.ok) {
  console.error(result);
  process.exit(2);
}

const check = validateObservations(result, loadB131Template());
if (!check.ok) {
  console.error(check);
  process.exit(1);
}

const observationsPath = outDir === ARTIFACT_DIR ? OBSERVATIONS_PATH : `${outDir}/poc7-observations.json`;
const publicObs = {
  template: result.template,
  source: result.source,
  blank_template: result.blank_template,
  canonical: result.canonical,
  detector_config: result.detector_config,
  algorithm: result.algorithm,
  checkboxes: result.checkboxes,
  fields: result.fields,
  counts: result.counts,
};
fs.writeFileSync(observationsPath, JSON.stringify(publicObs, null, 2));

const score = scoreObservations(result, loadBenchmarkTruth());
const report = formatBenchmarkReport(score);
fs.writeFileSync(`${outDir}/poc7-benchmark.json`, JSON.stringify({ ...score, report }, null, 2));
console.log(report);
console.log(JSON.stringify({
  observations: observationsPath,
  blank_template: blank.path,
  artifacts: result.artifacts,
  counts: result.counts,
}, null, 2));
