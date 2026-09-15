import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deriveStatus } from './status.js';

describe('deriveStatus', () => {
  it('marks failures as down', () => {
    assert.equal(deriveStatus({ ok: false, latencyMs: null, degradedThresholdMs: 1000, samples: [1, null] }), 'down');
  });

  it('marks slow successes as degraded', () => {
    assert.equal(deriveStatus({ ok: true, latencyMs: 1500, degradedThresholdMs: 1000, samples: [1500] }), 'degraded');
  });

  it('marks fast successes as up', () => {
    assert.equal(deriveStatus({ ok: true, latencyMs: 45, degradedThresholdMs: 1000, samples: [40, 45] }), 'up');
  });

  it('marks flapping recent samples as degraded even if the latest tick succeeded', () => {
    assert.equal(
      deriveStatus({
        ok: true,
        latencyMs: 40,
        degradedThresholdMs: 1000,
        samples: [40, null, 42, 40],
      }),
      'degraded',
    );
  });
});
