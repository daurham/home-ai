import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadTargets, MIN_INTERVAL_MS } from './targets.js';

describe('loadTargets', () => {
  it('normalizes http targets and floors interval to 10s', () => {
    const { targets, errors } = loadTargets([
      {
        id: 'api',
        name: 'API',
        type: 'http',
        url: 'http://127.0.0.1:3000/health',
        intervalMs: 1000,
      },
    ]);
    assert.equal(errors.length, 0);
    assert.equal(targets.length, 1);
    assert.equal(targets[0].intervalMs, MIN_INTERVAL_MS);
    assert.equal(targets[0].method, 'GET');
    assert.deepEqual(targets[0].expectStatus, [200]);
  });

  it('rejects unknown types, duplicate ids, and client-shaped postgres secrets', () => {
    const { targets, errors } = loadTargets([
      { id: 'a', name: 'A', type: 'ftp', url: 'http://x' },
      { id: 'pg', name: 'PG', type: 'postgres', connectionStringEnv: 'DATABASE_URL' },
      { id: 'pg', name: 'PG2', type: 'postgres', connectionStringEnv: 'DATABASE_URL' },
      { id: 'bad-env', name: 'Bad', type: 'postgres', connectionStringEnv: 'not-an-env' },
    ]);
    assert.equal(targets.length, 1);
    assert.equal(targets[0].id, 'pg');
    assert.ok(errors.some((e) => e.includes('invalid type')));
    assert.ok(errors.some((e) => e.includes('duplicate')));
    assert.ok(errors.some((e) => e.includes('valid env name')));
  });

  it('refuses link-local metadata hosts now that targets can come from the UI', () => {
    const { targets, errors } = loadTargets([
      { id: 'meta-http', name: 'Meta', type: 'http', url: 'http://169.254.169.254/latest/meta-data' },
      { id: 'meta-tcp', name: 'Meta TCP', type: 'tcp', host: '169.254.169.254', port: 80 },
      { id: 'ok', name: 'OK', type: 'http', url: 'http://127.0.0.1:3000/health' },
    ]);
    assert.equal(targets.length, 1);
    assert.equal(targets[0].id, 'ok');
    assert.equal(errors.filter((e) => e.includes('not allowed')).length, 2);
  });

  it('requires host/port for tcp', () => {
    const { targets } = loadTargets([
      { id: 'tcp-ok', name: 'TCP', type: 'tcp', host: '127.0.0.1', port: 6379 },
      { id: 'tcp-bad', name: 'TCP', type: 'tcp', host: '127.0.0.1' },
    ]);
    assert.equal(targets.length, 1);
    assert.equal(targets[0].port, 6379);
  });
});
