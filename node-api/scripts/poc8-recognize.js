import { runPoc8 } from '../lib/workout/poc8.js';

const skipOcr = process.argv.includes('--skip-ocr');
const skipVlm = process.argv.includes('--skip-vlm');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.slice('--limit='.length)) : 0;

const result = await runPoc8({
  skipOcr,
  skipVlm,
  limit,
  onProgress: ({ recognizer, index, total, cached, recognized }) => {
    const n = index + 1;
    if (cached && n % 25 !== 0 && n !== total) return;
    const rec = recognized ? ` -> ${recognized}` : cached ? ' cached' : '';
    console.error(`${recognizer} ${n}/${total}${rec}`);
  },
});

console.log(result.report);
console.log(JSON.stringify({
  detector_sha256: result.detector_sha256,
  eligible_crops: result.eligible_crops,
  unique_physical_fields: result.unique_physical_fields,
  ocr: result.ocr,
  vlm: result.vlm,
  report: result.report,
  artifacts: result.artifacts,
}, null, 2));
