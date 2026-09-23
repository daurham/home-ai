import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ARTIFACT_DIR,
  CANONICAL_PAGE_HEIGHT,
  CANONICAL_PAGE_WIDTH,
  loadB131Template,
} from './poc6/index.js';
import {
  BLANK_TEMPLATE_PATH,
  CHECKBOX_STATES,
  DETECTOR_CONFIG_PATH,
  FIELD_STATES,
  RECTIFIED_PATH,
  detectV131Observations,
  fieldsByKind,
  loadBenchmarkTruth,
  loadDetectorConfig,
  renderBlankTemplate,
  scoreObservations,
  validateBenchmarkTruth,
  validateObservations,
} from './poc7/index.js';

describe('POC #7 detector config and truth', () => {
  it('keeps tunable thresholds in an explicit config file', () => {
    const cfg = loadDetectorConfig();
    assert.equal(cfg.detector_version, 'poc7-a1c');
    assert.equal(cfg.canonical_width, 1700);
    assert.equal(cfg.canonical_height, 2200);
    assert.equal(cfg.canonical_dpi, 200);
    assert.equal(cfg.user_open_kernel_px, 3);
    assert.equal(cfg.checkbox_user_open_kernel_px, 0);
    assert.equal(cfg.text_user_open_kernel_px, 3);
    assert.equal(cfg.template_dilate_kernel_px, 3);
    assert.equal(cfg.template_dilate_iterations, 2);
    assert.equal(cfg.shift_search_radius_px, 8);
    assert.equal(typeof cfg.checkbox.checked_min_frac, 'number');
    assert.equal(typeof cfg.text.nonblank_min_frac, 'number');
    assert.equal(fs.existsSync(DETECTOR_CONFIG_PATH), true);
  });

  it('has 27 checkboxes and 45 writable text fields on B-1.3.1', () => {
    const { checkboxes, fields } = fieldsByKind(loadB131Template());
    assert.equal(checkboxes.length, 27);
    assert.equal(fields.length, 45);
    assert.equal(checkboxes.length + fields.length, 72);
  });

  it('references only valid B-1.3.1 fields in benchmark truth', () => {
    const check = validateBenchmarkTruth();
    assert.equal(check.ok, true, check.errors.join('; '));
    assert.equal(check.checkboxCount, 27);
    assert.equal(check.fieldCount, 45);
    const truth = loadBenchmarkTruth();
    assert.equal(Object.keys(truth.checkboxes).length, 27);
    assert.equal(Object.keys(truth.fields).length, 45);
  });
});

describe('POC #7 blank template', () => {
  it('renders the PDF to exactly 1700x2200', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'poc7-blank-'));
    const outPath = path.join(tmp, 'blank.png');
    const rendered = await renderBlankTemplate({ outPath });
    assert.equal(rendered.width, CANONICAL_PAGE_WIDTH);
    assert.equal(rendered.height, CANONICAL_PAGE_HEIGHT);
    assert.equal(fs.existsSync(outPath), true);
  });
});

describe('POC #7 fixture detection', () => {
  it('returns a valid observation for every expected field', async () => {
    assert.equal(fs.existsSync(RECTIFIED_PATH), true, 'run npm run poc6 first');
    if (!fs.existsSync(BLANK_TEMPLATE_PATH)) {
      await renderBlankTemplate();
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'poc7-detect-'));
    const obs = await detectV131Observations({ outDir: tmp });
    assert.equal(obs.ok, true);
    const template = loadB131Template();
    const check = validateObservations(obs, template);
    assert.equal(check.ok, true, check.errors.join('; '));
    const { checkboxes, fields } = fieldsByKind(template);
    assert.equal(Object.keys(obs.checkboxes).length, checkboxes.length);
    assert.equal(Object.keys(obs.fields).length, fields.length);
    for (const rec of Object.values(obs.checkboxes)) {
      assert.equal(CHECKBOX_STATES.has(rec.state), true);
      assert.equal(Number.isFinite(rec.score), true);
      assert.equal(rec.confidence >= 0 && rec.confidence <= 1, true);
    }
    for (const rec of Object.values(obs.fields)) {
      assert.equal(FIELD_STATES.has(rec.state), true);
      assert.equal(Number.isFinite(rec.score), true);
      assert.equal(rec.confidence >= 0 && rec.confidence <= 1, true);
    }
    for (const name of ['checkbox_debug', 'blank_debug', 'difference_debug']) {
      assert.equal(fs.existsSync(obs.artifacts[name]), true, name);
    }
    const score = scoreObservations(obs);
    assert.equal(score.checkboxes.total, 27);
    assert.equal(score.fields.total, 45);
    assert.equal(score.checkboxes.correct, 27, JSON.stringify(score.checkboxes.mismatches));
    assert.equal(score.fields.correct, 45, JSON.stringify(score.fields.mismatches));
    assert.equal(ARTIFACT_DIR.endsWith('workout-v1.3.1/artifacts'), true);
  });
});
