import { runPoc7bBenchmark } from '../lib/workout/poc7b.js';

const result = await runPoc7bBenchmark();
console.log(result.report);
console.log(JSON.stringify({
  photos: result.aggregate.photos,
  registration: {
    passed: result.aggregate.registration_passed,
    failed: result.aggregate.registration_failed,
  },
  checkboxes: result.aggregate.checkboxes,
  fields: result.aggregate.fields,
  detector_sha256_before: result.snapshot_before.detector_sha256,
  detector_sha256_after: result.snapshot_after.detector_sha256,
  report: result.report_markdown,
  artifacts: result.artifact_dir,
}, null, 2));
