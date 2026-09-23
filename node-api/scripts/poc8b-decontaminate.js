import { runPoc8b } from '../lib/workout/poc8b.js';

const verifyOnly = process.argv.includes('--verify-only');
const skipOcr = process.argv.includes('--skip-ocr');
const skipVlm = process.argv.includes('--skip-vlm');

const result = await runPoc8b({
  verifyOnly,
  skipOcr,
  skipVlm,
  onProgress: ({ recognizer, index, total, cached, recognized }) => {
    const n = index + 1;
    if (cached && n % 25 !== 0 && n !== total) return;
    const rec = recognized ? ` -> ${recognized}` : cached ? ' cached' : '';
    console.error(`${recognizer} ${n}/${total}${rec}`);
  },
});

if (verifyOnly) {
  console.log(JSON.stringify({
    phase: result.phase,
    eligible_crops: result.eligible_crops,
    verify: result.verify,
    detector_sha256: result.frozen.detector_sha256,
  }, null, 2));
} else {
  console.log(result.report);
  console.log(JSON.stringify({
    detector_sha256: result.detector_sha256,
    eligible_crops: result.eligible_crops,
    control: result.control,
    clean: result.clean,
    ocr_clean: result.ocr_clean,
    transitions: result.transitions,
    leading_printed_1: result.leading_printed_1,
    report: result.report,
    artifacts: result.artifacts,
  }, null, 2));
}
