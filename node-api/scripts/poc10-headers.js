import { runPoc10 } from '../lib/workout/poc10.js';

const result = await runPoc10({
  onProgress: ({ photo_id, field_id, cached, recognized }) => {
    if (photo_id) {
      console.error(`${cached ? 'cache' : 'vlm'} ${photo_id} ${field_id} ${recognized || ''}`.trim());
    }
  },
});

console.log(JSON.stringify({
  detector_sha256: result.detector_sha256,
  schema_version: result.schema_version,
  numeric_freeze: result.numeric_freeze,
  header_score: result.header_score.by_field,
  primary_sheets: result.primary_sheets.map((s) => ({
    sheet_id: s.sheet_id,
    date_literal: s.date_literal,
    canonical_date: s.canonical_date,
    bodyweight_lb: s.bodyweight_lb,
    schema_valid: s.schema_valid,
    semantic_valid: s.semantic_valid,
    review_status: s.review_status,
    save_ready: s.save_ready,
    blocking_issues: s.blocking_issues,
  })),
  report: result.report,
}, null, 2));
