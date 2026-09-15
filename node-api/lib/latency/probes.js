import net from 'node:net';
import { sanitizeError } from './sanitizeError.js';

const BODY_CAP = 8192;
const USER_AGENT = 'home-ai-latency-probe';

/** @type {Map<string, import('pg').Pool>} */
const postgresPools = new Map();

function elapsedMs(start) {
  return Math.max(0, Math.round(performance.now() - start));
}

function fail(err, extra) {
  return { ok: false, latencyMs: null, error: sanitizeError(err, extra) };
}

function ok(start) {
  return { ok: true, latencyMs: elapsedMs(start), error: null };
}

/**
 * GET (default) a configured URL. Success = status in expectStatus + optional body include.
 * @param {object} target
 */
export async function probeHttp(target) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), target.timeoutMs);
  const start = performance.now();

  try {
    const response = await fetch(target.url, {
      method: target.method || 'GET',
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'User-Agent': USER_AGENT,
      },
    });

    const expectStatus = target.expectStatus || [200];
    let bodyOk = true;

    if (target.expectBodyIncludes) {
      const buf = new Uint8Array(await response.arrayBuffer());
      const slice = Buffer.from(buf.subarray(0, BODY_CAP)).toString('utf8');
      bodyOk = slice.includes(target.expectBodyIncludes);
    } else if (response.body && typeof response.body.cancel === 'function') {
      try {
        await response.body.cancel();
      } catch {
        // ignore
      }
    }

    if (!expectStatus.includes(response.status)) {
      return fail(null, { status: response.status });
    }
    if (!bodyOk) {
      return { ok: false, latencyMs: null, error: 'unexpected body' };
    }
    return ok(start);
  } catch (err) {
    if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      return fail(err, { timeout: true });
    }
    return fail(err);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ollama liveness: cheap GET of / or /api/tags — never /api/generate.
 * @param {object} target
 */
export async function probeOllama(target) {
  return probeHttp(target);
}

/**
 * Dial TCP host:port; success if the handshake completes before timeout.
 * @param {object} target
 */
export function probeTcp(target) {
  const { host, port, timeoutMs } = target;
  const start = performance.now();

  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish(fail(null, { timeout: true }));
    }, timeoutMs);

    socket.once('connect', () => {
      finish(ok(start));
    });
    socket.once('error', (err) => {
      finish(fail(err));
    });
  });
}

async function getPostgresPool(target) {
  const existing = postgresPools.get(target.id);
  if (existing) return existing;

  const connectionString = process.env[target.connectionStringEnv];
  if (!connectionString) return null;

  const { default: pg } = await import('pg');
  const Pool = pg.Pool;
  const pool = new Pool({
    connectionString,
    max: 1,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: Math.min(target.timeoutMs, 5000),
    query_timeout: target.timeoutMs,
    allowExitOnIdle: true,
  });
  postgresPools.set(target.id, pool);
  return pool;
}

/**
 * SELECT 1 against an env-referenced connection string. Reuses a 1-client pool.
 * @param {object} target
 */
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' }));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function probePostgres(target) {
  const pool = await getPostgresPool(target);
  if (!pool) {
    return { ok: false, latencyMs: null, error: 'missing connection string' };
  }

  const start = performance.now();
  let client;
  let handedOff = false;
  const connecting = pool.connect();
  try {
    client = await withTimeout(connecting, target.timeoutMs);
    handedOff = true;
    await withTimeout(client.query('SELECT 1'), target.timeoutMs);
    return ok(start);
  } catch (err) {
    if (!handedOff) {
      connecting.then((late) => late.release()).catch(() => {});
    }
    if (err && (err.name === 'AbortError' || err.name === 'TimeoutError' || /timeout/i.test(err.message || ''))) {
      return fail(err, { timeout: true });
    }
    return fail(err);
  } finally {
    if (client) {
      try {
        client.release();
      } catch {
        // ignore
      }
    }
  }
}

/**
 * @param {object} target
 */
export function probeTarget(target) {
  switch (target.type) {
    case 'http':
      return probeHttp(target);
    case 'ollama':
      return probeOllama(target);
    case 'tcp':
      return probeTcp(target);
    case 'postgres':
      return probePostgres(target);
    default:
      return Promise.resolve({ ok: false, latencyMs: null, error: 'unknown type' });
  }
}

export async function closePostgresPools() {
  const closing = [...postgresPools.values()].map((pool) => pool.end().catch(() => {}));
  postgresPools.clear();
  await Promise.all(closing);
}
