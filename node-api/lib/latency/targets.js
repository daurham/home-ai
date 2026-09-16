export const MIN_INTERVAL_MS = 10_000;
export const DEFAULT_INTERVAL_MS = 30_000;
export const DEFAULT_TIMEOUT_MS = 3_000;
export const MIN_TIMEOUT_MS = 500;
export const MAX_TIMEOUT_MS = 10_000;
export const DEFAULT_DEGRADED_MS = 1_000;
export const DEFAULT_SAMPLE_CAPACITY = 90;
export const DEFAULT_CONCURRENCY = 5;
export const ALLOWED_TYPES = new Set(['http', 'tcp', 'postgres', 'ollama']);

/**
 * @typedef {object} LatencyTargetInput
 * @property {string} id
 * @property {string} name
 * @property {'http' | 'tcp' | 'postgres' | 'ollama'} type
 * @property {number} [intervalMs]
 * @property {number} [timeoutMs]
 * @property {number} [degradedThresholdMs]
 * @property {number} [sampleCapacity]
 * @property {string} [url]
 * @property {string} [method]
 * @property {number[]} [expectStatus]
 * @property {string} [expectBodyIncludes]
 * @property {string} [host]
 * @property {number} [port]
 * @property {string} [connectionStringEnv]
 */

function clamp(n, min, max, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.round(v)));
}

function asNonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

const BLOCKED_HOSTS = new Set(['metadata.google.internal']);

/**
 * Link-local addresses host cloud instance metadata. Targets can now come from the
 * dashboard, so refuse them wherever a host or URL is accepted.
 */
export function isBlockedHost(hostname) {
  const host = asNonEmptyString(hostname).toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return false;
  if (BLOCKED_HOSTS.has(host)) return true;
  return host.startsWith('169.254.') || host === 'fe80::a9fe:a9fe';
}

/**
 * @param {LatencyTargetInput} raw
 * @param {Set<string>} seenIds
 */
export function normalizeTarget(raw, seenIds = new Set()) {
  if (!raw || typeof raw !== 'object') return { error: 'target must be an object' };

  const id = asNonEmptyString(raw.id);
  if (!id) return { error: 'id is required' };
  if (seenIds.has(id)) return { error: `duplicate id "${id}"` };

  const name = asNonEmptyString(raw.name) || id;
  const type = asNonEmptyString(raw.type);
  if (!ALLOWED_TYPES.has(type)) {
    return { error: `id "${id}" has invalid type "${type}"` };
  }

  const intervalMs = clamp(raw.intervalMs, MIN_INTERVAL_MS, 10 * 60_000, DEFAULT_INTERVAL_MS);
  const timeoutMs = clamp(raw.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const degradedThresholdMs = clamp(raw.degradedThresholdMs, 50, 60_000, DEFAULT_DEGRADED_MS);
  const sampleCapacity = clamp(raw.sampleCapacity, 2, 240, DEFAULT_SAMPLE_CAPACITY);

  /** @type {Record<string, unknown>} */
  const target = {
    id,
    name,
    type,
    intervalMs,
    timeoutMs,
    degradedThresholdMs,
    sampleCapacity,
  };

  if (type === 'http' || type === 'ollama') {
    const url = asNonEmptyString(raw.url);
    if (!url) return { error: `id "${id}" requires url` };
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { error: `id "${id}" url must be http(s)` };
      }
      if (isBlockedHost(parsed.hostname)) {
        return { error: `id "${id}" url host is not allowed` };
      }
    } catch {
      return { error: `id "${id}" has invalid url` };
    }
    target.url = url;
    const method = asNonEmptyString(raw.method).toUpperCase() || 'GET';
    if (!['GET', 'POST'].includes(method)) {
      return { error: `id "${id}" method must be GET or POST` };
    }
    target.method = method;
    const statuses = Array.isArray(raw.expectStatus)
      ? raw.expectStatus.map(Number).filter((n) => Number.isInteger(n) && n >= 100 && n <= 599)
      : [];
    target.expectStatus = statuses.length ? statuses : [200];
    if (typeof raw.expectBodyIncludes === 'string' && raw.expectBodyIncludes) {
      target.expectBodyIncludes = raw.expectBodyIncludes;
    }
  }

  if (type === 'tcp') {
    const host = asNonEmptyString(raw.host);
    const port = Number(raw.port);
    if (!host) return { error: `id "${id}" requires host` };
    if (isBlockedHost(host)) return { error: `id "${id}" host is not allowed` };
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { error: `id "${id}" requires a valid port` };
    }
    target.host = host;
    target.port = port;
  }

  if (type === 'postgres') {
    const envName = asNonEmptyString(raw.connectionStringEnv);
    if (!envName) return { error: `id "${id}" requires connectionStringEnv` };
    if (!/^[A-Z][A-Z0-9_]*$/.test(envName)) {
      return { error: `id "${id}" connectionStringEnv is not a valid env name` };
    }
    target.connectionStringEnv = envName;
  }

  seenIds.add(id);
  return { target };
}

/**
 * @param {LatencyTargetInput[]} list
 */
export function loadTargets(list) {
  const seenIds = new Set();
  const targets = [];
  const errors = [];

  for (const raw of Array.isArray(list) ? list : []) {
    const result = normalizeTarget(raw, seenIds);
    if (result.error) {
      errors.push(result.error);
      console.warn(`[latency] skipping target: ${result.error}`);
      continue;
    }
    targets.push(result.target);
  }

  return { targets, errors };
}
