import { ISSUE } from './poc9.js';
import { DATE_ISSUE_CODES } from './semanticValidatorV13.js';

export const HEADER_ISSUE = {
  ...DATE_ISSUE_CODES,
  UNREADABLE_BODYWEIGHT: 'UNREADABLE_BODYWEIGHT',
  UNREADABLE_DURATION: 'UNREADABLE_DURATION',
  OPTIONAL_TEXT_NOT_IMPLEMENTED: 'OPTIONAL_TEXT_NOT_IMPLEMENTED',
};

export const BLOCKING_ISSUE_CODES = new Set([
  ISSUE.UNREADABLE_NUMERIC,
  ISSUE.MISSING_INITIAL_LOAD,
  ISSUE.CONFLICTING_LOAD_STATE,
  ISSUE.INCOMPLETE_MEASUREMENT,
  ISSUE.NON_POSITIVE_MEASUREMENT,
  ISSUE.EXTREME_MEASUREMENT,
  ISSUE.MULTIPLE_EFFORT_SELECTIONS,
  ISSUE.MULTIPLE_PAIN_SELECTIONS,
  ISSUE.STRUCTURAL_CHECKBOX_UNCERTAIN,
  ISSUE.STRUCTURAL_PAPER_UNCERTAIN,
  HEADER_ISSUE.BLANK_DATE,
  HEADER_ISSUE.PARTIAL_DATE,
  HEADER_ISSUE.UNREADABLE_DATE,
  HEADER_ISSUE.INVALID_DATE,
]);

export const NON_BLOCKING_ISSUE_CODES = new Set([
  HEADER_ISSUE.UNREADABLE_BODYWEIGHT,
  HEADER_ISSUE.UNREADABLE_DURATION,
  HEADER_ISSUE.OPTIONAL_TEXT_NOT_IMPLEMENTED,
]);

/**
 * Layers:
 * 1. schema_valid — JSON contract
 * 2. semantic_valid — routine/template/measurement/date classification
 * 3. review_status — AUTO_ACCEPT | REVIEW_REQUIRED | INVALID
 * 4. save_ready — schema + semantic + complete date + no blocking issues
 *
 * save_ready does NOT mean transcription is guaranteed correct.
 */
export function evaluateSaveReadiness({
  schema = { valid: false },
  semantic = { valid: false },
  review = { status: 'REVIEW_REQUIRED', issues: [] },
  canonical = null,
} = {}) {
  const issues = Array.isArray(review.issues) ? review.issues : [];
  const blocking = issues.filter((i) => BLOCKING_ISSUE_CODES.has(i.code));
  const nonBlocking = issues.filter((i) => NON_BLOCKING_ISSUE_CODES.has(i.code));
  const date = canonical?.workout?.date ?? null;
  const saveReady = Boolean(
    schema.valid
    && semantic.valid
    && date != null
    && blocking.length === 0
    && review.status !== 'INVALID',
  );
  return {
    schema_valid: Boolean(schema.valid),
    semantic_valid: Boolean(semantic.valid),
    review_status: review.status || 'REVIEW_REQUIRED',
    save_ready: saveReady,
    blocking_issues: [...new Set(blocking.map((i) => i.code))],
    non_blocking_issues: [...new Set(nonBlocking.map((i) => i.code))],
    date,
  };
}
