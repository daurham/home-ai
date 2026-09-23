import { runPoc8d } from '../lib/workout/poc8d.js';

const result = await runPoc8d({
  onProgress: ({ line }) => {
    if (line) console.error(line);
  },
});

console.log(JSON.stringify({
  detector_sha256: result.detector_sha256,
  eligible_crops: result.eligible_crops,
  granite_exact: result.granite_exact,
  independent_exact: result.independent_exact,
  agreement_precision: result.agreement_precision,
  report: result.report,
  artifacts: result.artifacts,
}, null, 2));
