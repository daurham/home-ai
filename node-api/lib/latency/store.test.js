import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rowToApi, rowToTargetInput, slugifyId, uniqueId } from './store.js';
import { loadTargets } from './targets.js';

const row = {
  id: 'grafana',
  name: 'Grafana',
  type: 'http',
  url: 'http://127.0.0.1:3001/api/health',
  method: 'GET',
  expect_status: [200, 204],
  expect_body_includes: null,
  host: null,
  port: null,
  connection_string_env: null,
  interval_ms: 30000,
  timeout_ms: 3000,
  degraded_threshold_ms: 1000,
  sample_capacity: 90,
  enabled: true,
  created_at: '2026-09-15T00:00:00.000Z',
  updated_at: '2026-09-15T00:00:00.000Z',
};

describe('slugifyId', () => {
  it('makes url-safe ids out of names', () => {
    assert.equal(slugifyId('My Home API!'), 'my-home-api');
    assert.equal(slugifyId('  Redis  '), 'redis');
    assert.equal(slugifyId('***'), 'target');
  });
});

describe('uniqueId', () => {
  it('avoids ids that are already used, including built-ins', () => {
    assert.equal(uniqueId('redis', new Set()), 'redis');
    assert.equal(uniqueId('ollama', new Set(['ollama'])), 'ollama-2');
    assert.equal(uniqueId('ollama', new Set(['ollama', 'ollama-2'])), 'ollama-3');
  });
});

describe('rowToTargetInput', () => {
  it('produces a config the probe loader accepts', () => {
    const { targets, errors } = loadTargets([rowToTargetInput(row)]);
    assert.deepEqual(errors, []);
    assert.equal(targets.length, 1);
    assert.equal(targets[0].url, row.url);
    assert.deepEqual(targets[0].expectStatus, [200, 204]);
    assert.equal(targets[0].intervalMs, 30000);
  });

  it('drops empty columns instead of sending nulls through', () => {
    const input = rowToTargetInput(row);
    assert.equal(input.host, undefined);
    assert.equal(input.connectionStringEnv, undefined);
  });

  it('keeps postgres rows pointing at an env var name', () => {
    const pg = { ...row, id: 'pg', type: 'postgres', url: null, connection_string_env: 'DATABASE_URL' };
    const { targets, errors } = loadTargets([rowToTargetInput(pg)]);
    assert.deepEqual(errors, []);
    assert.equal(targets[0].connectionStringEnv, 'DATABASE_URL');
  });
});

describe('rowToApi', () => {
  it('marks stored targets as editable database rows', () => {
    const api = rowToApi(row);
    assert.equal(api.source, 'database');
    assert.equal(api.enabled, true);
    assert.equal(api.name, 'Grafana');
  });
});
