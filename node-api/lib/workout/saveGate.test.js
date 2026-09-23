import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ISSUE, REVIEW_STATUS } from './poc9.js';
import { HEADER_ISSUE, evaluateSaveReadiness } from './saveGate.js';

const schemaOk = { valid: true };
const semanticOk = { valid: true };
const canonicalDated = { workout: { date: '2026-09-20' } };

describe('save gate', () => {
  it('is save_ready when schema-valid, semantic-valid, dated, and unblocked', () => {
    const save = evaluateSaveReadiness({
      schema: schemaOk,
      semantic: semanticOk,
      review: { status: REVIEW_STATUS.AUTO_ACCEPT, issues: [] },
      canonical: canonicalDated,
    });
    assert.equal(save.save_ready, true);
    assert.deepEqual(save.blocking_issues, []);
  });

  it('blocks a partial date even when schema-valid', () => {
    const save = evaluateSaveReadiness({
      schema: schemaOk,
      semantic: semanticOk,
      review: {
        status: REVIEW_STATUS.REVIEW_REQUIRED,
        issues: [{ code: HEADER_ISSUE.PARTIAL_DATE, field_id: 'header.date', observed_value: '9-20' }],
      },
      canonical: { workout: { date: null } },
    });
    assert.equal(save.save_ready, false);
    assert.equal(save.blocking_issues.includes(HEADER_ISSUE.PARTIAL_DATE), true);
  });

  it('blocks an unreadable required numeric', () => {
    const save = evaluateSaveReadiness({
      schema: schemaOk,
      semantic: semanticOk,
      review: {
        status: REVIEW_STATUS.REVIEW_REQUIRED,
        issues: [{ code: ISSUE.UNREADABLE_NUMERIC, field_id: 'C04.S1.load' }],
      },
      canonical: canonicalDated,
    });
    assert.equal(save.save_ready, false);
  });

  it('does not block an optional unrecognized note', () => {
    const save = evaluateSaveReadiness({
      schema: schemaOk,
      semantic: semanticOk,
      review: {
        status: REVIEW_STATUS.REVIEW_REQUIRED,
        issues: [{ code: HEADER_ISSUE.OPTIONAL_TEXT_NOT_IMPLEMENTED, field_id: 'note.quick_note' }],
      },
      canonical: canonicalDated,
    });
    assert.equal(save.save_ready, true);
    assert.equal(save.non_blocking_issues.includes(HEADER_ISSUE.OPTIONAL_TEXT_NOT_IMPLEMENTED), true);
  });

  it('does not block blank optional bodyweight/duration (no issue)', () => {
    const save = evaluateSaveReadiness({
      schema: schemaOk,
      semantic: semanticOk,
      review: { status: REVIEW_STATUS.AUTO_ACCEPT, issues: [] },
      canonical: { workout: { date: '2026-09-20', bodyweight_lb: null, duration_min: null } },
    });
    assert.equal(save.save_ready, true);
  });

  it('blocks a blank required date without needing a fabricated ambiguity', () => {
    const save = evaluateSaveReadiness({
      schema: schemaOk,
      semantic: semanticOk,
      review: {
        status: REVIEW_STATUS.REVIEW_REQUIRED,
        issues: [{ code: HEADER_ISSUE.BLANK_DATE, field_id: 'header.date' }],
      },
      canonical: { workout: { date: null } },
    });
    assert.equal(save.save_ready, false);
    assert.equal(save.schema_valid, true);
  });
});
