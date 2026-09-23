import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {
  ARUCO_ROLES,
  CANONICAL_DPI,
  CANONICAL_PAGE_HEIGHT,
  CANONICAL_PAGE_WIDTH,
  FIXTURE_PHOTO,
  REQUIRED_ARUCO_IDS,
  loadB131Template,
  registerV131Photo,
  templateCoordinateFingerprint,
  validateB131Template,
} from './poc6/index.js';

const FROZEN_FINGERPRINT_SHA256 = 'b6bc883ef2a3d1d453318d58cbc0c466d871a056c56530383da653be712e5645';

describe('POC #6 B-1.3.1 template', () => {
  it('defines every required writable field inside the canonical page', () => {
    const template = loadB131Template();
    const check = validateB131Template(template);
    assert.equal(check.ok, true, check.errors.join('; '));
    assert.equal(check.fieldCount, 72);
    assert.equal(template.page.canonical_width, CANONICAL_PAGE_WIDTH);
    assert.equal(template.page.canonical_height, CANONICAL_PAGE_HEIGHT);
    assert.equal(template.page.canonical_dpi, CANONICAL_DPI);
    assert.deepEqual(template.aruco.required_ids, REQUIRED_ARUCO_IDS);
    assert.equal(template.aruco.orientation[10], 'TL');
    assert.equal(ARUCO_ROLES[12], 'BR');
    assert.equal(template.aruco.markers['10'].px.w, 112);
    assert.equal(template.aruco.inset_in, 0.28);
    assert.equal(template.aruco.size_in, 0.56);
  });

  it('keeps field rectangles stable (catch accidental coordinate edits)', () => {
    const fp = templateCoordinateFingerprint();
    assert.equal(fp.split('|').length, 72);
    assert.equal(fp.includes('B03.S1.load:'), true);
    assert.equal(fp.includes('B07.S1.left_seconds:'), true);
    assert.equal(createHash('sha256').update(fp).digest('hex'), FROZEN_FINGERPRINT_SHA256);
  });

  it('has the expected exercise/set region counts', () => {
    const ids = loadB131Template().fields.map((f) => f.id);
    const count = (prefix) => ids.filter((id) => id.startsWith(prefix)).length;
    assert.equal(count('B01.'), 9);
    assert.equal(count('B02.'), 9);
    assert.equal(count('B03.'), 9);
    assert.equal(count('B04.'), 9);
    assert.equal(count('B05.'), 8);
    assert.equal(count('B06.'), 6);
    assert.equal(count('B07.'), 8);
    assert.equal(count('header.effort.'), 5);
    assert.equal(count('header.pain.'), 4);
  });
});

describe('POC #6 fixture registration', () => {
  it('detects IDs 10-13 on the v1.3.1 photo and warps to 1700x2200', async () => {
    assert.equal(fs.existsSync(FIXTURE_PHOTO), true);
    const result = await registerV131Photo({ outDir: '/tmp/poc6-test-artifacts' });
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.detected_ids.slice().sort((a, b) => a - b), [10, 11, 12, 13]);
    assert.equal(result.all_four_required_detected, true);
    assert.equal(result.canonical_width, 1700);
    assert.equal(result.canonical_height, 2200);
    const byId = Object.fromEntries(result.markers.map((m) => [m.id, m]));
    assert.equal(byId[10].role, 'TL');
    assert.equal(byId[11].role, 'TR');
    assert.equal(byId[12].role, 'BR');
    assert.equal(byId[13].role, 'BL');
    assert.equal(result.image_width, 1152);
    assert.equal(result.image_height, 1536);
    for (const name of ['registration_debug', 'rectified', 'field_overlay', 'field_crops']) {
      assert.equal(fs.existsSync(result.artifacts[name]), true, name);
    }
  });

  it('stops without guessing corners when a required marker is missing', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poc6-missing-'));
    const croppedPath = path.join(tmpDir, 'missing-bl-br.jpg');
    await sharp(FIXTURE_PHOTO).extract({ left: 0, top: 0, width: 1152, height: 900 }).jpeg().toFile(croppedPath);
    const result = await registerV131Photo({ imagePath: croppedPath, outDir: tmpDir });
    assert.equal(result.ok, false);
    assert.equal(result.exit_code, 2);
    assert.match(result.error || '', /10\/11\/12\/13/);
    assert.equal(result.all_four_required_detected, false);
    assert.equal(result.homography, undefined);
    assert.equal(fs.existsSync(path.join(tmpDir, 'poc6-registration-debug.png')), true);
  });
});
