import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTunnelGuard, isViaCloudflare } from './externalAccess.js';

function run(guard, { path = '/api/expenses', headers = {} } = {}) {
  const result = { nexted: false, status: null, body: null };
  const res = {
    status(code) {
      result.status = code;
      return res;
    },
    json(payload) {
      result.body = payload;
      return res;
    },
  };
  guard({ path, headers }, res, () => {
    result.nexted = true;
  });
  return result;
}

const guard = createTunnelGuard({ apiKey: 'secret-key' });
const TUNNEL = { 'cf-ray': '8f2b1c0d1234-SJC' };

describe('isViaCloudflare', () => {
  it('detects Cloudflare-added headers', () => {
    assert.equal(isViaCloudflare({ 'cf-ray': 'abc-SJC' }), true);
    assert.equal(isViaCloudflare({ 'cf-connecting-ip': '203.0.113.7' }), true);
    assert.equal(isViaCloudflare({ host: '192.168.1.161:3000' }), false);
    assert.equal(isViaCloudflare(), false);
  });
});

describe('tunnel guard', () => {
  it('leaves LAN requests alone', () => {
    const result = run(guard, { headers: { host: '192.168.1.161:3000' } });
    assert.equal(result.nexted, true);
    assert.equal(result.status, null);
  });

  it('rejects tunnel requests to data routes without the key', () => {
    const result = run(guard, { headers: TUNNEL });
    assert.equal(result.nexted, false);
    assert.equal(result.status, 403);
    assert.match(result.body.error, /API key/);
  });

  it('allows tunnel requests that carry the key', () => {
    const result = run(guard, { headers: { ...TUNNEL, 'x-api-key': 'secret-key' } });
    assert.equal(result.nexted, true);
  });

  it('rejects a wrong key', () => {
    const result = run(guard, { headers: { ...TUNNEL, 'x-api-key': 'nope' } });
    assert.equal(result.status, 403);
  });

  it('keeps health open so the tunnel probe still works', () => {
    assert.equal(run(guard, { path: '/api/health', headers: TUNNEL }).nexted, true);
    assert.equal(run(guard, { path: '/api/health/', headers: TUNNEL }).nexted, true);
  });

  it('fails closed when no API key is configured', () => {
    const keyless = createTunnelGuard({});
    assert.equal(run(keyless, { headers: TUNNEL }).status, 403);
    // Health stays reachable so monitoring does not go dark.
    assert.equal(run(keyless, { path: '/api/health', headers: TUNNEL }).nexted, true);
  });

  it('does not treat a path that merely starts with an open path as open', () => {
    assert.equal(run(guard, { path: '/api/health-secrets', headers: TUNNEL }).status, 403);
  });
});
