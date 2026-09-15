import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { probeHttp, probeTcp } from './probes.js';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

describe('probeHttp', () => {
  it('records success latency for 200 JSON', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    const port = await listen(server);
    try {
      const result = await probeHttp({
        url: `http://127.0.0.1:${port}/health`,
        method: 'GET',
        timeoutMs: 2000,
        expectStatus: [200],
      });
      assert.equal(result.ok, true);
      assert.equal(typeof result.latencyMs, 'number');
      assert.ok(result.latencyMs >= 0);
      assert.equal(result.error, null);
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('fails on unexpected status without inventing latency', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(503);
      res.end('nope');
    });
    const port = await listen(server);
    try {
      const result = await probeHttp({
        url: `http://127.0.0.1:${port}/health`,
        method: 'GET',
        timeoutMs: 2000,
        expectStatus: [200],
      });
      assert.equal(result.ok, false);
      assert.equal(result.latencyMs, null);
      assert.equal(result.error, 'status 503');
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('times out against a hanging server', async () => {
    const server = http.createServer(() => {
      // never respond
    });
    const port = await listen(server);
    try {
      const result = await probeHttp({
        url: `http://127.0.0.1:${port}/health`,
        method: 'GET',
        timeoutMs: 80,
        expectStatus: [200],
      });
      assert.equal(result.ok, false);
      assert.equal(result.latencyMs, null);
      assert.equal(result.error, 'timeout');
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('probeTcp', () => {
  it('succeeds when a port accepts connections', async () => {
    const server = net.createServer((socket) => socket.end());
    const port = await listen(server);
    try {
      const result = await probeTcp({ host: '127.0.0.1', port, timeoutMs: 1000 });
      assert.equal(result.ok, true);
      assert.equal(typeof result.latencyMs, 'number');
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('fails with connection refused on a closed port', async () => {
    const result = await probeTcp({ host: '127.0.0.1', port: 1, timeoutMs: 500 });
    assert.equal(result.ok, false);
    assert.equal(result.latencyMs, null);
    assert.ok(result.error === 'connection refused' || result.error === 'timeout');
  });
});
