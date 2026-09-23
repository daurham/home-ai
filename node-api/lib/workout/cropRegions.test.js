import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadWorkoutConfig } from './config.js';
import { cropAllRegions } from './cropRegions.js';

describe('cropAllRegions', () => {
  it('crops the fixture into named regions', async () => {
    const imageBuffer = fs.readFileSync(loadWorkoutConfig().fixtureImagePath);
    const { paper, crops } = await cropAllRegions(imageBuffer);
    assert.ok(paper.width > 1000);
    assert.ok(crops.B03.buffer.length > 1000);
    assert.ok(crops.header.buffer.length > 1000);
    assert.equal(crops.B03.box.height > 100, true);
  });
});
