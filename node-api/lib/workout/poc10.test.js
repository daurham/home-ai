import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DETECT_PY, DETECTOR_CONFIG_PATH } from './poc7/index.js';
import { FROZEN_DETECTOR_SHA256, sha256File, snapshotFrozenConfig } from './poc7b.js';
import { DETECT_PY_SHA256 } from './poc8.js';
import { loadPoc8Membership } from './poc8b.js';
import { loadPoc8bRows } from './poc8c.js';
import { ISSUE, PAPER, RECOGNITION, assembleFromRaw, makeCheckboxObservation, makeNumericObservation, syntheticRaw } from './poc9.js';
import {
  BODYWEIGHT_PROMPT,
  DATE_PROMPT,
  DURATION_PROMPT,
  HEADER_PROMPTS,
  POC10_GT_PATH,
  loadHeaderGroundTruth,
  parseHeaderRecognizerOutput,
  poc9Regression,
  resolveHeaders,
  toV131Canonical,
} from './poc10.js';
import { HEADER_ISSUE, evaluateSaveReadiness } from './saveGate.js';
import { loadV131WorkoutConfig } from './v131Config.js';
import { validateWorkoutSchema } from './schemaValidator.js';
import { validateWorkoutSemanticsV13 } from './semanticValidatorV13.js';
import { finalizeReview } from './poc9.js';

function bw(id, checked) {
  return makeCheckboxObservation(id, checked ? 'checked' : 'unchecked');
}
function numeric(id, value) {
  return makeNumericObservation({
    fieldId: id,
    paperState: PAPER.NONBLANK,
    recognitionState: RECOGNITION.NUMERIC,
    recognizedValue: value,
  });
}
function blank(id) {
  return makeNumericObservation({
    fieldId: id,
    paperState: PAPER.BLANK,
    recognitionState: RECOGNITION.NOT_RUN,
    recognizedValue: null,
  });
}

describe('POC #10 freeze', () => {
  it('does not change detector, numeric membership, or #9 error accounting', () => {
    const snap = snapshotFrozenConfig();
    assert.equal(sha256File(DETECTOR_CONFIG_PATH), FROZEN_DETECTOR_SHA256);
    assert.equal(snap.detector_sha256, FROZEN_DETECTOR_SHA256);
    assert.equal(sha256File(DETECT_PY), DETECT_PY_SHA256);
    assert.equal(loadPoc8Membership().samples.length, 519);
    const rows = loadPoc8bRows();
    assert.equal(rows.length, 519);
    assert.equal(rows.filter((r) => r.clean === r.expected).length, 502);
    const reg = poc9Regression();
    assert.equal(reg.poc9_unreadable, 4);
    assert.equal(reg.poc9_silent, 13);
    assert.equal(reg.poc9_rewritten, 0);
  });

  it('keeps header prompts free of expected values and workout context', () => {
    const joined = `${DATE_PROMPT}\n${BODYWEIGHT_PROMPT}\n${DURATION_PROMPT}`;
    assert.equal(/2026|9-20|10-31|routine|exercise|bodyweight 185|today|current year/i.test(joined), false);
    assert.equal(HEADER_PROMPTS['header.date'], DATE_PROMPT);
    assert.match(DATE_PROMPT, /Do not add a year/);
    assert.match(DATE_PROMPT, /UNKNOWN/);
  });
});

describe('POC #10 header resolution (offline)', () => {
  it('resolves blank optional bodyweight and duration without review', () => {
    const raw = syntheticRaw({
      templateId: 'B-1.3.1',
      observations: {
        'header.date': blank('header.date'),
        'header.bodyweight': blank('header.bodyweight'),
        'header.duration': blank('header.duration'),
        'B01.S1.BW': bw('B01.S1.BW', true),
        'B01.S1.reps': numeric('B01.S1.reps', 12),
      },
    });
    raw.observations['header.date'].paper_state = PAPER.NONBLANK;
    const header = resolveHeaders(raw, { 'header.date': '9-20-26' });
    assert.equal(header.bodyweight_lb, null);
    assert.equal(header.duration_min, null);
    assert.equal(header.issues.some((i) => i.code === HEADER_ISSUE.UNREADABLE_BODYWEIGHT), false);
    assert.equal(header.issues.some((i) => i.code === HEADER_ISSUE.UNREADABLE_DURATION), false);
  });

  it('accepts numeric bodyweight and flags UNKNOWN bodyweight without blocking save when date is complete', () => {
    const raw = syntheticRaw({
      templateId: 'C-1.3.1',
      observations: {
        'header.date': { field_id: 'header.date', paper_state: PAPER.NONBLANK, recognition_state: RECOGNITION.NOT_IMPLEMENTED, recognized_value: null },
        'header.bodyweight': { field_id: 'header.bodyweight', paper_state: PAPER.NONBLANK, recognition_state: RECOGNITION.NOT_IMPLEMENTED, recognized_value: null },
        'header.duration': blank('header.duration'),
        'C01.S1.BW': bw('C01.S1.BW', true),
        'C01.S1.reps': numeric('C01.S1.reps', 10),
      },
    });
    const ok = resolveHeaders(raw, { 'header.date': '10-31-26', 'header.bodyweight': '185' });
    assert.equal(ok.bodyweight_lb, 185);
    assert.equal(ok.date, '2026-10-31');
    const unread = resolveHeaders(raw, { 'header.date': '10-31-26', 'header.bodyweight': 'UNKNOWN' });
    assert.equal(unread.bodyweight_lb, null);
    assert.equal(unread.issues.some((i) => i.code === HEADER_ISSUE.UNREADABLE_BODYWEIGHT), true);
    const assembled = assembleFromRaw(raw);
    const review = finalizeReview([...assembled.review.issues, ...unread.issues]);
    const canonical = toV131Canonical(assembled.resolved, review.status, unread);
    const config = loadV131WorkoutConfig();
    const schema = validateWorkoutSchema(canonical, config.schema);
    const semantic = validateWorkoutSemanticsV13(canonical, { review, config });
    const save = evaluateSaveReadiness({ schema, semantic, review, canonical });
    assert.equal(save.save_ready, true);
  });

  it('flags UNKNOWN duration as optional review', () => {
    const raw = syntheticRaw({
      templateId: 'B-1.3.1',
      observations: {
        'header.date': { field_id: 'header.date', paper_state: PAPER.NONBLANK, recognition_state: RECOGNITION.NOT_IMPLEMENTED, recognized_value: null },
        'header.duration': { field_id: 'header.duration', paper_state: PAPER.NONBLANK, recognition_state: RECOGNITION.NOT_IMPLEMENTED, recognized_value: null },
        'B01.S1.BW': bw('B01.S1.BW', true),
        'B01.S1.reps': numeric('B01.S1.reps', 12),
      },
    });
    const header = resolveHeaders(raw, { 'header.date': '9-20-26', 'header.duration': 'UNKNOWN' });
    assert.equal(header.duration_min, null);
    assert.equal(header.issues.some((i) => i.code === HEADER_ISSUE.UNREADABLE_DURATION), true);
  });

  it('maps a complete date into a v1.3 canonical candidate without rewriting set numbers', () => {
    const raw = syntheticRaw({
      templateId: 'B-1.3.1',
      observations: {
        'header.date': { field_id: 'header.date', paper_state: PAPER.NONBLANK, recognition_state: RECOGNITION.NOT_IMPLEMENTED, recognized_value: null },
        'header.bodyweight': blank('header.bodyweight'),
        'header.duration': blank('header.duration'),
        'B02.S1.BW': bw('B02.S1.BW', false),
        'B02.S1.load': numeric('B02.S1.load', 25),
        'B02.S1.reps': numeric('B02.S1.reps', 10),
      },
    });
    const assembled = assembleFromRaw(raw);
    const header = resolveHeaders(raw, { 'header.date': '9-20-26' });
    const review = finalizeReview([...assembled.review.issues, ...header.issues]);
    const canonical = toV131Canonical(assembled.resolved, review.status, header);
    assert.equal(canonical.schema_version, '1.3');
    assert.equal(canonical.workout.template_version, 'B-1.3.1');
    assert.equal(canonical.workout.date, '2026-09-20');
    assert.equal(canonical.workout.exercises[0].sets[0].weight_lb, 25);
    const config = loadV131WorkoutConfig();
    assert.equal(validateWorkoutSchema(canonical, config.schema).valid, true);
    assert.equal(validateWorkoutSemanticsV13(canonical, { review, config }).valid, true);
    assert.equal(evaluateSaveReadiness({
      schema: { valid: true },
      semantic: { valid: true },
      review,
      canonical,
    }).save_ready, true);
  });

  it('keeps partial dates null and records the literal', () => {
    const raw = syntheticRaw({
      templateId: 'A-1.3.1',
      observations: {
        'header.date': { field_id: 'header.date', paper_state: PAPER.NONBLANK, recognition_state: RECOGNITION.NOT_IMPLEMENTED, recognized_value: null },
        'A01.S1.BW': bw('A01.S1.BW', true),
        'A01.S1.reps': numeric('A01.S1.reps', 10),
      },
    });
    const header = resolveHeaders(raw, { 'header.date': '9-20' });
    assert.equal(header.date, null);
    assert.equal(header.date_literal, '9-20');
    assert.equal(header.issues.some((i) => i.code === HEADER_ISSUE.PARTIAL_DATE), true);
    assert.equal(header.ambiguities[0].detected_value, '9-20');
  });

  it('does not treat an unreadable required numeric as save-ready even with a complete date', () => {
    const raw = syntheticRaw({
      templateId: 'C-1.3.1',
      observations: {
        'header.date': { field_id: 'header.date', paper_state: PAPER.NONBLANK, recognition_state: RECOGNITION.NOT_IMPLEMENTED, recognized_value: null },
        'C04.S1.BW': bw('C04.S1.BW', false),
        'C04.S1.load': makeNumericObservation({
          fieldId: 'C04.S1.load',
          paperState: PAPER.NONBLANK,
          recognitionState: RECOGNITION.UNKNOWN,
          recognizedValue: null,
        }),
        'C04.S1.reps': numeric('C04.S1.reps', 10),
      },
    });
    const assembled = assembleFromRaw(raw);
    const header = resolveHeaders(raw, { 'header.date': '10-31-26' });
    const review = finalizeReview([...assembled.review.issues, ...header.issues]);
    const canonical = toV131Canonical(assembled.resolved, review.status, header);
    const save = evaluateSaveReadiness({
      schema: { valid: true },
      semantic: { valid: true },
      review,
      canonical,
    });
    assert.equal(assembled.review.issues.some((i) => i.code === ISSUE.UNREADABLE_NUMERIC), true);
    assert.equal(save.save_ready, false);
  });

  it('loads human header ground truth for the four unique sheets', () => {
    assert.equal(fs.existsSync(POC10_GT_PATH), true);
    const gt = loadHeaderGroundTruth();
    assert.equal(gt.sheets.length, 4);
    assert.equal(gt.sheets.find((s) => s.sheet_id === 'B-original').values['header.date'].literal, '9-19');
    assert.equal(gt.sheets.find((s) => s.sheet_id === 'A-2026-09-20').values['header.date'].kind, 'partial');
    assert.equal(gt.sheets.find((s) => s.sheet_id === 'B-2026-09-20').values['header.date'].canonical_date, '2026-09-20');
    assert.equal(gt.sheets.find((s) => s.sheet_id === 'C-2026-10-31').values['header.bodyweight'].canonical, 185);
  });

  it('parses recognizer output conservatively', () => {
    assert.equal(parseHeaderRecognizerOutput('header.bodyweight', '185').value, 185);
    assert.equal(parseHeaderRecognizerOutput('header.bodyweight', '185 lb').kind, 'UNKNOWN');
    assert.equal(parseHeaderRecognizerOutput('header.date', '9-20-26').literal, '9-20-26');
  });
});
