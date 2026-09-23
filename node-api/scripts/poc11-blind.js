import { runPoc11Blind } from '../lib/workout/poc11.js';

const result = await runPoc11Blind({
  onProgress: (evt) => {
    if (evt.stage === 'photo') {
      console.error(`photo ${evt.photo_id}`);
    } else if (evt.stage === 'numeric') {
      console.error(`numeric ${evt.cached ? 'cache' : 'vlm'} ${evt.index + 1}/${evt.total} ${evt.recognized || ''}`.trim());
    } else if (evt.stage === 'header') {
      console.error(`header ${evt.photo_id} ${evt.field_id} ${evt.recognized || ''}`.trim());
    }
  },
});

console.log(JSON.stringify({
  status: result.status,
  detector_sha256: result.freeze.detector_sha256,
  blind_results_sha256: result.blind_results_sha256,
  totals: result.totals,
  latency: result.latency,
  photos: result.photos.map((p) => ({
    photo_id: p.photo_id,
    registration: p.registration.success,
    template: p.detected_template,
    structural_status: p.structural_status,
    date_literal: p.recognized_date_literal,
    canonical_date: p.canonical_date,
    effort: p.effort,
    pain: p.pain,
    completed_sets: p.completed_sets,
    numeric_fields: p.numeric_fields_processed,
    inherited: p.inherited_load_values,
    review_issue_count: p.review_issue_count,
    review_issue_codes: p.review_issue_codes,
    schema_valid: p.schema_valid,
    semantic_valid: p.semantic_valid,
    review_status: p.review_status,
    save_ready: p.save_ready,
    ms: p.processing_time_ms,
  })),
}, null, 2));
