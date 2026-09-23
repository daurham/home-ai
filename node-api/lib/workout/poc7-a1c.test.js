import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ARTIFACT_DIR } from './poc6/index.js';
import {
  BLANK_TEMPLATE_PATH,
  DETECTOR_CONFIG_PATH,
  RECTIFIED_PATH,
  detectV131Observations,
  loadBenchmarkTruth,
  loadDetectorConfig,
  renderBlankTemplate,
  scoreObservations,
} from './poc7/index.js';
import {
  DETECTOR_VERSION,
  FROZEN_DETECTOR_SHA256,
  POC7B_ARTIFACT_DIR,
  PREVIOUS_FROZEN_DETECTOR_SHA256,
  sha256File,
  snapshotFrozenConfig,
} from './poc7b.js';

const FRESH_B_TRUTH_PATH = path.join(
  ARTIFACT_DIR,
  '..',
  'fixtures',
  'poc7e',
  'checkbox-truth.json',
);
const FRESH_B_PHOTOS = ['IMG_1311', 'IMG_1312', 'IMG_1313', 'IMG_1314'];
const HISTORICAL_PHOTOS = [
  { id: 'poc7', rectified: RECTIFIED_PATH },
  ...['IMG_1305', 'IMG_1306', 'IMG_1307', 'IMG_1308', 'IMG_1309', 'IMG_1310'].map((id) => ({
    id,
    rectified: path.join(POC7B_ARTIFACT_DIR, id, 'rectified.png'),
  })),
];

const UNCHANGED_THRESHOLDS = {
  canonical_width: 1700,
  canonical_height: 2200,
  canonical_dpi: 200,
  adaptive_block_size: 31,
  adaptive_c: 12,
  crop_pad_px: 10,
  shift_search_radius_px: 8,
  template_dilate_kernel_px: 3,
  template_dilate_iterations: 2,
  min_component_area: 8,
  line_aspect_ratio: 6,
  line_span_fraction: 0.55,
  line_thickness_px: 3,
  checkbox: {
    inset_fraction: 0.22,
    checked_min_frac: 0.015,
    checked_min_area: 10,
    unchecked_max_frac: 0.008,
    unchecked_max_area: 6,
  },
  text: {
    inset_fraction: 0.08,
    nonblank_min_frac: 0.02,
    nonblank_min_area: 80,
    blank_max_frac: 0.01,
    blank_max_area: 40,
  },
};

async function ensureBlank() {
  if (!fs.existsSync(BLANK_TEMPLATE_PATH)) {
    await renderBlankTemplate();
  }
}

async function detectOn(rectifiedPath, configPath = DETECTOR_CONFIG_PATH) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'poc7-a1c-'));
  return detectV131Observations({
    observedPath: rectifiedPath,
    configPath,
    outDir: tmp,
  });
}

function writeA0Clone(dir) {
  const cfg = loadDetectorConfig();
  delete cfg.checkbox_user_open_kernel_px;
  delete cfg.text_user_open_kernel_px;
  cfg.user_open_kernel_px = 3;
  const outPath = path.join(dir, 'a0-fallback.json');
  fs.writeFileSync(outPath, `${JSON.stringify(cfg, null, 2)}\n`);
  return outPath;
}

function textStates(obs) {
  const states = {};
  for (const [id, rec] of Object.entries(obs.fields || {})) {
    states[id] = rec.state;
  }
  return states;
}

describe('POC #7 A1c production freeze', () => {
  it('freezes the kind-scoped open kernels at a new SHA256', () => {
    const cfg = loadDetectorConfig();
    const snap = snapshotFrozenConfig();
    assert.equal(cfg.detector_version, DETECTOR_VERSION);
    assert.equal(cfg.detector_version, 'poc7-a1c');
    assert.equal(cfg.supersedes_sha256, PREVIOUS_FROZEN_DETECTOR_SHA256);
    assert.equal(cfg.user_open_kernel_px, 3);
    assert.equal(cfg.checkbox_user_open_kernel_px, 0);
    assert.equal(cfg.text_user_open_kernel_px, 3);
    assert.equal(sha256File(DETECTOR_CONFIG_PATH), FROZEN_DETECTOR_SHA256);
    assert.equal(snap.detector_sha256, FROZEN_DETECTOR_SHA256);
    assert.notEqual(FROZEN_DETECTOR_SHA256, PREVIOUS_FROZEN_DETECTOR_SHA256);
    for (const [key, expected] of Object.entries(UNCHANGED_THRESHOLDS)) {
      assert.deepEqual(cfg[key], expected, key);
    }
  });

  it('scores 189/189 historical checkboxes and keeps A0 text output', { timeout: 300000 }, async () => {
    await ensureBlank();
    const truth = loadBenchmarkTruth();
    const a0Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poc7-a1c-a0-'));
    const a0Config = writeA0Clone(a0Dir);
    let checkboxCorrect = 0;
    let checkboxTotal = 0;
    let falseChecked = 0;
    let uncertain = 0;
    const textMismatches = [];

    for (const photo of HISTORICAL_PHOTOS) {
      assert.equal(fs.existsSync(photo.rectified), true, photo.rectified);
      const a1c = await detectOn(photo.rectified);
      const a0 = await detectOn(photo.rectified, a0Config);
      const score = scoreObservations(a1c, truth);
      checkboxCorrect += score.checkboxes.correct;
      checkboxTotal += score.checkboxes.total;
      falseChecked += score.checkboxes.unchecked_to_checked;
      uncertain += score.checkboxes.uncertain;
      const a1cText = textStates(a1c);
      const a0Text = textStates(a0);
      assert.deepEqual(Object.keys(a1cText).sort(), Object.keys(a0Text).sort());
      for (const id of Object.keys(a1cText)) {
        if (a1cText[id] !== a0Text[id]) {
          textMismatches.push({ photo: photo.id, id, a1c: a1cText[id], a0: a0Text[id] });
        }
      }
    }

    assert.equal(checkboxTotal, 189);
    assert.equal(checkboxCorrect, 189, `historical checkboxes ${checkboxCorrect}/189`);
    assert.equal(falseChecked, 0);
    assert.equal(uncertain, 0);
    assert.deepEqual(textMismatches, []);
  });

  it('scores 108/108 fresh Routine B checkboxes', { timeout: 180000 }, async () => {
    await ensureBlank();
    const truth = JSON.parse(fs.readFileSync(FRESH_B_TRUTH_PATH, 'utf8'));
    let checkboxCorrect = 0;
    let checkboxTotal = 0;
    let falseChecked = 0;
    let uncertain = 0;

    for (const id of FRESH_B_PHOTOS) {
      const rectified = path.join(ARTIFACT_DIR, 'poc7e', 'photos', id, 'rectified.png');
      assert.equal(fs.existsSync(rectified), true, rectified);
      const obs = await detectOn(rectified);
      const score = scoreObservations(obs, { checkboxes: truth.checkboxes, fields: {} });
      checkboxCorrect += score.checkboxes.correct;
      checkboxTotal += score.checkboxes.total;
      falseChecked += score.checkboxes.unchecked_to_checked;
      uncertain += score.checkboxes.uncertain;
    }

    assert.equal(checkboxTotal, 108);
    assert.equal(checkboxCorrect, 108, `fresh B checkboxes ${checkboxCorrect}/108`);
    assert.equal(falseChecked, 0);
    assert.equal(uncertain, 0);
  });
});
