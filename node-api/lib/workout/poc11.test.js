import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DETECT_PY, DETECTOR_CONFIG_PATH } from './poc7/index.js';
import { FROZEN_DETECTOR_SHA256, sha256File, snapshotFrozenConfig } from './poc7b.js';
import { DETECT_PY_SHA256, VLM_PROMPT, photoCatalog } from './poc8.js';
import { POC8B_MODEL, loadPoc8Membership } from './poc8b.js';
import { loadPoc8bRows } from './poc8c.js';
import { DATE_PROMPT, BODYWEIGHT_PROMPT, DURATION_PROMPT } from './poc10.js';
import {
  HISTORICAL_PHOTO_IDS,
  IDENTITY_CROP,
  POC11_BLIND_DIR,
  POC11_MANIFEST_PATH,
  TEMPLATE_SPECS,
  assertPoc11PhotosFresh,
  frozenHistoricalUnchanged,
  identifyPrintedTemplate,
  loadPoc11Manifest,
  poc11Photos,
} from './poc11.js';

describe('POC #11 freeze', () => {
  it('does not change detector, numeric membership, or historical catalog', () => {
    const snap = snapshotFrozenConfig();
    const frozen = frozenHistoricalUnchanged();
    assert.equal(sha256File(DETECTOR_CONFIG_PATH), FROZEN_DETECTOR_SHA256);
    assert.equal(snap.detector_sha256, FROZEN_DETECTOR_SHA256);
    assert.equal(sha256File(DETECT_PY), DETECT_PY_SHA256);
    assert.equal(frozen.membership, 519);
    assert.equal(loadPoc8Membership().samples.length, 519);
    assert.equal(frozen.granite_exact, 502);
    assert.equal(loadPoc8bRows().filter((r) => r.clean === r.expected).length, 502);
    assert.equal(frozen.historical_catalog, 20);
    assert.equal(photoCatalog().length, 20);
    assert.equal(POC8B_MODEL, 'granite3.2-vision:2b');
    assert.equal(VLM_PROMPT.includes('Return only the number.'), true);
    assert.match(DATE_PROMPT, /Do not add a year/);
    assert.match(BODYWEIGHT_PROMPT, /Return only the number/);
    assert.match(DURATION_PROMPT, /UNKNOWN/);
  });
});

describe('POC #11 fresh photo catalog', () => {
  it('uses six fileshare photos that were not in POCs #7–#10', () => {
    assert.equal(fs.existsSync(POC11_MANIFEST_PATH), true);
    const photos = poc11Photos();
    const check = assertPoc11PhotosFresh(photos);
    assert.equal(check.ok, true, check.errors.join('; '));
    const ids = photos.map((p) => p.photo_id);
    assert.deepEqual(ids, ['IMG_1326', 'IMG_1327', 'IMG_1328', 'IMG_1330', 'IMG_1331', 'IMG_1332']);
    for (const id of ids) {
      assert.equal(HISTORICAL_PHOTO_IDS.has(id), false, id);
    }
    const manifest = loadPoc11Manifest();
    assert.match(manifest._comment, /not from this manifest/i);
  });
});

describe('POC #11 printed template identity', () => {
  it('matches A/B/C blank rasters to themselves from the printed title crop', async () => {
    assert.equal(IDENTITY_CROP.width > 100, true);
    for (const spec of Object.values(TEMPLATE_SPECS)) {
      const identity = await identifyPrintedTemplate(spec.blank_path);
      assert.equal(identity.template_id, spec.template_id, spec.template_id);
      assert.equal(identity.uncertain, false);
      assert.equal(identity.ncc > 0.99, true, `${spec.template_id} ncc=${identity.ncc}`);
    }
  });
});

describe('POC #11 frozen blind checksum', () => {
  it('does not rewrite Phase 1 blind-results after freeze', () => {
    const resultsPath = path.join(POC11_BLIND_DIR, 'blind-results.json');
    const shaPath = path.join(POC11_BLIND_DIR, 'blind-results.sha256');
    if (!fs.existsSync(resultsPath) || !fs.existsSync(shaPath)) return;
    const expected = fs.readFileSync(shaPath, 'utf8').trim();
    assert.equal(sha256File(resultsPath), expected);
    assert.equal(expected, 'd62637ff535cb6f95d8929a8dff86212c9ee2c9aa1b69eef73638db0016867b6');
  });
});
