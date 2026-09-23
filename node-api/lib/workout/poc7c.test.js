import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ARTIFACT_DIR } from './poc6/index.js';
import { DETECTOR_CONFIG_PATH } from './poc7/index.js';
import { FROZEN_DETECTOR_SHA256, sha256File, snapshotFrozenConfig } from './poc7b.js';

const POC7C_DIR = path.join(ARTIFACT_DIR, 'poc7c');
const TRACES_PATH = path.join(POC7C_DIR, 'traces.json');
const REPORT_PATH = path.join(POC7C_DIR, 'REPORT.md');

describe('POC #7C forensics freeze', () => {
  it('does not change the frozen detector config', () => {
    const snap = snapshotFrozenConfig();
    assert.equal(sha256File(DETECTOR_CONFIG_PATH), FROZEN_DETECTOR_SHA256);
    assert.equal(snap.detector_sha256, FROZEN_DETECTOR_SHA256);
  });

  it('writes diagnostic traces and a report without encoding production answers', () => {
    assert.equal(fs.existsSync(TRACES_PATH), true, 'run npm run poc7c first');
    assert.equal(fs.existsSync(REPORT_PATH), true, 'run npm run poc7c first');
    const traces = JSON.parse(fs.readFileSync(TRACES_PATH, 'utf8'));
    assert.equal(Array.isArray(traces.cases), true);
    assert.equal(traces.cases.length, 14);
    for (const item of traces.cases) {
      assert.equal(typeof item.field, 'string');
      assert.equal(typeof item.photo, 'string');
      assert.equal(typeof item.local_alignment.chosen_dx, 'number');
      assert.equal(Array.isArray(item.local_alignment.candidates), true);
      assert.equal(typeof item.pixel_counts.final_retained, 'number');
      assert.equal(fs.existsSync(item.panel), true);
    }
  });
});
