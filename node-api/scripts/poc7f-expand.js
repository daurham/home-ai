import { runPoc7f } from '../lib/workout/poc7f.js';

const result = await runPoc7f();
console.log(result.report);
console.log(JSON.stringify({
  frozen_sha256: result.frozen_sha256,
  registration: result.totals.combined.registration,
  A: {
    checkboxes: result.totals.A.checkboxes_correct,
    text: result.totals.A.text_correct,
  },
  C: {
    checkboxes: result.totals.C.checkboxes_correct,
    text: result.totals.C.text_correct,
  },
  combined: {
    checkboxes: result.totals.combined.checkboxes_correct,
    text: result.totals.combined.text_correct,
  },
  report: result.report_markdown,
  artifacts: result.artifact_dir,
}, null, 2));
