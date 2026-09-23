import { runPoc9 } from '../lib/workout/poc9.js';

const result = runPoc9();
console.log(JSON.stringify({
  detector_sha256: result.detector_sha256,
  eligible_crops: result.eligible_crops,
  granite_exact: result.granite_exact,
  granite_miss_buckets: result.granite_miss_buckets,
  silent_survivors_unique: result.silent_survivors_unique,
  false_review_of_exact_granite: result.false_review_of_exact_granite.length,
  recognized_values_rewritten: result.recognized_values_rewritten,
  unique_sheets: result.unique_sheets.map((s) => ({
    sheet_id: s.sheet_id,
    status: s.primary_review_status,
    issues: s.primary_issue_count,
    codes: s.primary_issue_codes,
    schema_valid: s.primary_schema_valid,
    structural_mismatches: s.primary_structural_mismatches,
  })),
  inherit_demo: result.inherit_demo,
  report: result.report,
}, null, 2));
