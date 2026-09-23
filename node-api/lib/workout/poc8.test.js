import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  DETECT_PY,
  DETECTOR_CONFIG_PATH,
} from './poc7/index.js';
import { FROZEN_DETECTOR_SHA256, sha256File, snapshotFrozenConfig } from './poc7b.js';
import {
  DETECT_PY_SHA256,
  NUMERIC_FIELD_KINDS,
  POC8_TRUTH_PATH,
  VLM_PROMPT,
  eligibleFromObservations,
  loadNumericGroundTruth,
  numericKindFromFieldId,
  parseNumericLiteral,
  photoCatalog,
  templatePathForId,
  validateNumericGroundTruth,
} from './poc8.js';

describe('POC #8 freeze and ground truth', () => {
  it('does not change the frozen poc7-a1c detector', () => {
    const snap = snapshotFrozenConfig();
    assert.equal(sha256File(DETECTOR_CONFIG_PATH), FROZEN_DETECTOR_SHA256);
    assert.equal(snap.detector_sha256, FROZEN_DETECTOR_SHA256);
    assert.equal(sha256File(DETECT_PY), DETECT_PY_SHA256);
  });

  it('keeps a human numeric ground-truth fixture that is not recognizer output', () => {
    assert.equal(fs.existsSync(POC8_TRUTH_PATH), true);
    const truth = loadNumericGroundTruth();
    const check = validateNumericGroundTruth(truth);
    assert.equal(check.ok, true, check.errors.join('; '));
    assert.match(truth._comment, /not from recognizer/i);
    const counts = Object.fromEntries(truth.sheets.map((s) => [s.sheet_id, Object.keys(s.values).length]));
    assert.equal(counts['A-2026-09-20'], 31);
    assert.equal(counts['C-2026-10-31'], 35);
    assert.equal(counts['B-original'], 28);
    assert.equal(counts['B-2026-09-20'], 7);
    assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 101);
  });

  it('never puts blank inherited loads or excluded fields into ground truth', () => {
    const truth = loadNumericGroundTruth();
    for (const sheet of truth.sheets) {
      const template = JSON.parse(fs.readFileSync(templatePathForId(sheet.template_id), 'utf8'));
      const ids = new Set(template.fields.map((f) => f.id));
      for (const fieldId of Object.keys(sheet.values)) {
        assert.equal(ids.has(fieldId), true, fieldId);
        const kind = numericKindFromFieldId(fieldId);
        assert.equal(NUMERIC_FIELD_KINDS.includes(kind), true, fieldId);
        assert.equal(['date', 'bodyweight', 'duration', 'pain_area', 'quick_note'].some((k) => fieldId.includes(k)), false);
        assert.match(fieldId, /\.(load|reps|left|right|seconds|left_seconds|right_seconds)$/);
      }
      assert.equal(sheet.values['B03.S2.load'], undefined);
      assert.equal(sheet.values['B03.S3.load'], undefined);
      assert.equal(sheet.values['B06.S2.load'], undefined);
      assert.equal(sheet.values['B07.S2.load'], undefined);
      assert.equal(sheet.values['A04.S3.load'], undefined);
      assert.equal(sheet.values['A01.S1.load'], undefined);
      assert.equal(sheet.values['C01.S1.load'], undefined);
    }
  });

  it('maps catalog photos onto validated A/B/C rectified artifacts', () => {
    const catalog = photoCatalog();
    assert.equal(catalog.length, 20);
    for (const photo of catalog) {
      assert.equal(fs.existsSync(photo.rectified), true, photo.rectified);
      assert.equal(fs.existsSync(photo.template_path), true, photo.template_path);
    }
  });
});

describe('POC #8 isolated numeric contract', () => {
  it('parses recognition output conservatively', () => {
    assert.deepEqual(parseNumericLiteral('12'), { value: '12', reason: 'ok' });
    assert.deepEqual(parseNumericLiteral(' 45\n'), { value: '45', reason: 'ok' });
    assert.deepEqual(parseNumericLiteral('UNKNOWN'), { value: 'UNKNOWN', reason: 'unknown' });
    assert.equal(parseNumericLiteral('10 reps').value, 'UNKNOWN');
    assert.equal(parseNumericLiteral('18 maybe 8').value, 'UNKNOWN');
    assert.equal(parseNumericLiteral('~10').value, 'UNKNOWN');
    assert.equal(parseNumericLiteral('10.0').value, 'UNKNOWN');
    assert.equal(parseNumericLiteral('').value, 'UNKNOWN');
  });

  it('does not silently coerce 18 to 8 from a target range', () => {
    assert.equal(parseNumericLiteral('18').value, '18');
    assert.notEqual(parseNumericLiteral('18').value, '8');
  });

  it('sends only detector-nonblank numeric cells with paper literals', () => {
    const { samples, skipped } = eligibleFromObservations({
      photo: { photo_id: 'IMG_TEST', sheet_id: 'B-original', template_id: 'B-1.3.1' },
      sheet: {
        values: {
          'B02.S1.load': '25',
          'B02.S1.reps': '10',
          'B03.S2.reps': '12',
        },
      },
      template: {
        fields: [
          { id: 'header.date', kind: 'text', px: { x: 1, y: 1, w: 2, h: 2 } },
          { id: 'B02.S1.load', kind: 'text', px: { x: 1, y: 1, w: 2, h: 2 } },
          { id: 'B02.S1.reps', kind: 'text', px: { x: 1, y: 1, w: 2, h: 2 } },
          { id: 'B03.S2.load', kind: 'text', px: { x: 1, y: 1, w: 2, h: 2 } },
          { id: 'B03.S2.reps', kind: 'text', px: { x: 1, y: 1, w: 2, h: 2 } },
          { id: 'B01.S1.BW', kind: 'checkbox', px: { x: 1, y: 1, w: 2, h: 2 } },
        ],
      },
      observations: {
        fields: {
          'header.date': { state: 'nonblank', score: 1, confidence: 1 },
          'B02.S1.load': { state: 'nonblank', score: 1, confidence: 1 },
          'B02.S1.reps': { state: 'blank', score: 0, confidence: 1 },
          'B03.S2.load': { state: 'blank', score: 0, confidence: 1 },
          'B03.S2.reps': { state: 'nonblank', score: 1, confidence: 1 },
        },
      },
    });
    assert.deepEqual(samples.map((s) => s.field_id).sort(), ['B02.S1.load', 'B03.S2.reps']);
    assert.equal(samples.some((s) => s.field_id === 'B03.S2.load'), false);
    assert.equal(samples.some((s) => s.field_id === 'header.date'), false);
    assert.equal(skipped.some((s) => s.field_id === 'B03.S2.load' && s.reason === 'detector_not_nonblank'), true);
    assert.equal(skipped.some((s) => s.field_id === 'B02.S1.reps' && s.paper_has_value), true);
  });

  it('keeps the isolated VLM prompt free of workout schema', () => {
    assert.match(VLM_PROMPT, /Return only the number/);
    assert.match(VLM_PROMPT, /UNKNOWN/);
    assert.equal(/routine|exercise|schema|reps target|inherit/i.test(VLM_PROMPT), false);
  });
});
