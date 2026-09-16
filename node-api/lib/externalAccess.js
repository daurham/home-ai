/**
 * node-api is reachable two ways: directly on the LAN (the dashboard and the latency
 * probes) and from the internet through the Cloudflare tunnel on ai.daurham.com.
 * Only the AI endpoints are meant to be used from outside, and those already expect
 * an API key — but the database routers are mounted without one, which made expenses,
 * categories, calendar and latency targets publicly readable and writable.
 *
 * So: require the API key for anything arriving through Cloudflare. Cloudflare sets
 * CF-Ray on every origin request and an outside caller cannot strip it, so its
 * presence is a safe "this came from the tunnel" signal. LAN requests never carry it
 * and are left alone.
 */

/** Paths that stay open through the tunnel. Health is polled by a probe that cannot send headers. */
export const DEFAULT_PUBLIC_TUNNEL_PATHS = ['/api/health'];

export function isViaCloudflare(headers = {}) {
  return Boolean(headers['cf-ray'] || headers['cf-connecting-ip']);
}

function normalizePath(path) {
  const trimmed = String(path || '').replace(/\/+$/, '');
  return trimmed || '/';
}

/**
 * @param {{ apiKey?: string, publicPaths?: string[] }} options
 * @returns {(req: any, res: any, next: () => void) => void}
 */
export function createTunnelGuard({ apiKey, publicPaths = DEFAULT_PUBLIC_TUNNEL_PATHS } = {}) {
  const open = new Set(publicPaths.map(normalizePath));

  return function tunnelGuard(req, res, next) {
    if (!isViaCloudflare(req.headers)) return next();
    if (open.has(normalizePath(req.path))) return next();
    // Fails closed: with no API_KEY configured, nothing external gets through.
    if (apiKey && req.headers['x-api-key'] === apiKey) return next();

    return res.status(403).json({ error: 'Forbidden: API key required for external access' });
  };
}
