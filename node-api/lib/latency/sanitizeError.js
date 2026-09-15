const CODE_MAP = {
  ECONNREFUSED: 'connection refused',
  ENOTFOUND: 'host not found',
  ENETUNREACH: 'network unreachable',
  EHOSTUNREACH: 'host unreachable',
  EAI_AGAIN: 'dns lookup failed',
  ETIMEDOUT: 'timeout',
  ECONNRESET: 'connection reset',
  EPIPE: 'connection closed',
  ECONNABORTED: 'connection aborted',
};

function looksSecret(text) {
  return /postgresql:\/\//i.test(text)
    || /postgres:\/\//i.test(text)
    || /redis:\/\//i.test(text)
    || /mongodb(\+srv)?:\/\//i.test(text)
    || /password/i.test(text)
    || /\S+:\S+@\S+/.test(text);
}

/**
 * Map probe failures to short, non-secret strings for the snapshot API.
 * @param {unknown} err
 * @param {{ status?: number, timeout?: boolean }} [extra]
 */
export function sanitizeError(err, extra = {}) {
  if (extra.timeout) return 'timeout';
  if (extra.status != null) return `status ${extra.status}`;

  const nested = err && typeof err === 'object' ? err.cause : undefined;
  const code = (err && typeof err === 'object' && err.code)
    || (nested && typeof nested === 'object' && nested.code);
  if (typeof code === 'string' && CODE_MAP[code]) return CODE_MAP[code];

  const name = err && typeof err === 'object' ? err.name : undefined;
  if (name === 'AbortError' || name === 'TimeoutError') return 'timeout';

  const raw = err instanceof Error
    ? err.message
    : (err && typeof err === 'object' && typeof err.message === 'string')
      ? err.message
      : err == null ? '' : String(err);
  const msg = raw.split('\n')[0] || '';
  if (!msg) return 'error';
  if (/timeout|aborted/i.test(msg)) return 'timeout';
  if (/^fetch failed$/i.test(msg)) return 'connection error';
  if (looksSecret(msg)) return 'connection error';

  return msg
    .replace(/https?:\/\/[^\s]+/gi, '[url]')
    .replace(/\S+:\S+@\S+/g, '[redacted]')
    .slice(0, 80);
}
