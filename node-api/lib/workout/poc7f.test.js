import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  CANONICAL_DPI,
  CANONICAL_PAGE_HEIGHT,
  CANONICAL_PAGE_WIDTH,
  REQUIRED_ARUCO_IDS,
  templateCoordinateFingerprint,
} from './poc6/index.js';
import { DETECTOR_CONFIG_PATH, fieldsByKind, validateBenchmarkTruth } from './poc7/index.js';
import { FROZEN_DETECTOR_SHA256, sha256File, snapshotFrozenConfig } from './poc7b.js';
import {
  A_TEMPLATE_PATH,
  A_TRUTH_PATH,
  C_TEMPLATE_PATH,
  C_TRUTH_PATH,
  POC7F_ARTIFACT_DIR,
  loadPoc7fManifest,
  loadRoutineTemplate,
  templateForPhoto,
  validateV131Template,
} from './poc7f.js';

const A_FINGERPRINT_SHA256 = '44e8471b194c0cb289a94c6e8696575bef2c8b7f4e70366f86cb12bce4cae86c';
const C_FINGERPRINT_SHA256 = 'fba13b4a0d55ed661624c214dab5048c8b3e0f6d5a74e5fff3acc5390c2d2a96';

function ids(template) {
  return template.fields.map((f) => f.id);
}

function countPrefix(template, prefix) {
  return ids(template).filter((id) => id.startsWith(prefix)).length;
}

function bwIds(template, exercise) {
  return ids(template).filter((id) => id.startsWith(`${exercise}.`) && id.endsWith('.BW'));
}

describe('POC #7F A-1.3.1 template identity', () => {
  it('maps every writable A field inside the canonical page', () => {
    const template = loadRoutineTemplate('A');
    const check = validateV131Template(template);
    assert.equal(check.ok, true, check.errors.join('; '));
    assert.equal(template.template_id, 'A-1.3.1');
    assert.equal(template.routine_id, 'A');
    assert.equal(check.fieldCount, 68);
    assert.equal(template.field_count, 68);
    assert.equal(template.page.canonical_width, CANONICAL_PAGE_WIDTH);
    assert.equal(template.page.canonical_height, CANONICAL_PAGE_HEIGHT);
    assert.equal(template.page.canonical_dpi, CANONICAL_DPI);
    assert.deepEqual(template.aruco.required_ids, REQUIRED_ARUCO_IDS);
    const { checkboxes, fields } = fieldsByKind(template);
    assert.equal(checkboxes.length, 27);
    assert.equal(fields.length, 41);
    assert.equal(new Set(ids(template)).size, 68);
  });

  it('keeps A field rectangles stable', () => {
    const fp = templateCoordinateFingerprint(loadRoutineTemplate('A'));
    assert.equal(fp.split('|').length, 68);
    assert.equal(createHash('sha256').update(fp).digest('hex'), A_FINGERPRINT_SHA256);
    assert.equal(fs.existsSync(A_TEMPLATE_PATH), true);
  });

  it('uses bilateral reps for A01–A06 and bilateral seconds for A07', () => {
    const template = loadRoutineTemplate('A');
    const set = new Set(ids(template));
    assert.equal(countPrefix(template, 'A01.'), 9);
    assert.equal(countPrefix(template, 'A02.'), 9);
    assert.equal(countPrefix(template, 'A03.'), 9);
    assert.equal(countPrefix(template, 'A04.'), 9);
    assert.equal(countPrefix(template, 'A05.'), 6);
    assert.equal(countPrefix(template, 'A06.'), 6);
    assert.equal(countPrefix(template, 'A07.'), 6);
    assert.equal(set.has('A05.S1.reps'), true);
    assert.equal(set.has('A05.S1.left'), false);
    assert.equal(set.has('A05.S1.right'), false);
    assert.equal(set.has('A07.S1.seconds'), true);
    assert.equal(set.has('A07.S1.left_seconds'), false);
    assert.equal(set.has('A07.S1.right_seconds'), false);
    assert.equal(template.exercises.A05.laterality, 'bilateral');
    assert.equal(template.exercises.A05.measure, 'reps');
    assert.equal(template.exercises.A07.laterality, 'bilateral');
    assert.equal(template.exercises.A07.measure, 'seconds');
    assert.deepEqual(bwIds(template, 'A01'), ['A01.S1.BW', 'A01.S2.BW', 'A01.S3.BW']);
    assert.deepEqual(bwIds(template, 'A05'), ['A05.S1.BW', 'A05.S2.BW']);
    assert.deepEqual(bwIds(template, 'A07'), ['A07.S1.BW', 'A07.S2.BW']);
  });
});

describe('POC #7F C-1.3.1 template identity', () => {
  it('maps every writable C field inside the canonical page', () => {
    const template = loadRoutineTemplate('C');
    const check = validateV131Template(template);
    assert.equal(check.ok, true, check.errors.join('; '));
    assert.equal(template.template_id, 'C-1.3.1');
    assert.equal(template.routine_id, 'C');
    assert.equal(check.fieldCount, 70);
    assert.equal(template.field_count, 70);
    const { checkboxes, fields } = fieldsByKind(template);
    assert.equal(checkboxes.length, 27);
    assert.equal(fields.length, 43);
    assert.equal(new Set(ids(template)).size, 70);
  });

  it('keeps C field rectangles stable', () => {
    const fp = templateCoordinateFingerprint(loadRoutineTemplate('C'));
    assert.equal(fp.split('|').length, 70);
    assert.equal(createHash('sha256').update(fp).digest('hex'), C_FINGERPRINT_SHA256);
    assert.equal(fs.existsSync(C_TEMPLATE_PATH), true);
  });

  it('uses unilateral L/R for C05 and bilateral seconds for C07', () => {
    const template = loadRoutineTemplate('C');
    const set = new Set(ids(template));
    assert.equal(countPrefix(template, 'C01.'), 9);
    assert.equal(countPrefix(template, 'C05.'), 8);
    assert.equal(countPrefix(template, 'C06.'), 6);
    assert.equal(countPrefix(template, 'C07.'), 6);
    assert.equal(set.has('C05.S1.left'), true);
    assert.equal(set.has('C05.S1.right'), true);
    assert.equal(set.has('C05.S1.reps'), false);
    assert.equal(set.has('C07.S1.seconds'), true);
    assert.equal(set.has('C07.S1.left_seconds'), false);
    assert.equal(template.exercises.C05.laterality, 'unilateral');
    assert.equal(template.exercises.C05.measure, 'reps');
    assert.equal(template.exercises.C07.measure, 'seconds');
    assert.deepEqual(bwIds(template, 'C05'), ['C05.S1.BW', 'C05.S2.BW']);
    assert.deepEqual(bwIds(template, 'C07'), ['C07.S1.BW', 'C07.S2.BW']);
  });
});

describe('POC #7F ground truth and photo routing', () => {
  it('references only real A and C fields in sheet truth', () => {
    const a = validateBenchmarkTruth(JSON.parse(fs.readFileSync(A_TRUTH_PATH, 'utf8')), loadRoutineTemplate('A'));
    const c = validateBenchmarkTruth(JSON.parse(fs.readFileSync(C_TRUTH_PATH, 'utf8')), loadRoutineTemplate('C'));
    assert.equal(a.ok, true, a.errors.join('; '));
    assert.equal(c.ok, true, c.errors.join('; '));
    assert.equal(a.checkboxCount, 27);
    assert.equal(a.fieldCount, 41);
    assert.equal(c.checkboxCount, 27);
    assert.equal(c.fieldCount, 43);
  });

  it('selects A-1.3.1 or C-1.3.1 for each of the nine photographs', () => {
    const manifest = loadPoc7fManifest();
    assert.equal(manifest.photos.length, 9);
    const expected = {
      IMG_1315: 'C-1.3.1',
      IMG_1316: 'C-1.3.1',
      IMG_1317: 'C-1.3.1',
      IMG_1318: 'C-1.3.1',
      IMG_1319: 'A-1.3.1',
      IMG_1320: 'A-1.3.1',
      IMG_1321: 'A-1.3.1',
      IMG_1322: 'A-1.3.1',
      IMG_1323: 'A-1.3.1',
    };
    for (const [photo, template] of Object.entries(expected)) {
      assert.equal(templateForPhoto(photo, manifest), template);
    }
    assert.equal(manifest.photos.filter((p) => p.routine === 'A').length, 5);
    assert.equal(manifest.photos.filter((p) => p.routine === 'C').length, 4);
  });
});

describe('POC #7F frozen detector', () => {
  it('does not change the frozen poc7-a1c SHA256', () => {
    const snap = snapshotFrozenConfig();
    assert.equal(sha256File(DETECTOR_CONFIG_PATH), FROZEN_DETECTOR_SHA256);
    assert.equal(snap.detector_sha256, '29efec983066a37008e88b3e778bdd6b8343681b689aa1a3200c28e3075bf0d4');
    assert.equal(FROZEN_DETECTOR_SHA256, '29efec983066a37008e88b3e778bdd6b8343681b689aa1a3200c28e3075bf0d4');
  });

  it('records A/C results against the frozen detector', () => {
    const resultsPath = path.join(POC7F_ARTIFACT_DIR, 'results.json');
    const reportPath = path.join(POC7F_ARTIFACT_DIR, 'REPORT.md');
    assert.equal(fs.existsSync(resultsPath), true, 'run npm run poc7f first');
    assert.equal(fs.existsSync(reportPath), true, 'run npm run poc7f first');
    const results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
    assert.equal(results.frozen_sha256, FROZEN_DETECTOR_SHA256);
    assert.equal(results.snapshot_after.detector_sha256, FROZEN_DETECTOR_SHA256);
    assert.equal(results.photos.length, 9);
    for (const photo of results.photos) {
      const expected = photo.photo <= 'IMG_1318' ? 'C-1.3.1' : 'A-1.3.1';
      assert.equal(photo.template, expected, photo.photo);
    }
  });
});
