/**
 * Allowlisted latency probe targets for the dashboard Latency Sparklines tab.
 *
 * The browser never probes these URLs. Only home-ai's scheduler may.
 * Add/edit targets here, then restart node-api.
 *
 * Guide: home-dashboard/docs/latency-sparklines-setup.md
 *        (also copied at docs/latency-sparklines-setup.md in this repo)
 *
 * Ollama default matches server.js: Compose hostname `home-ai-ollama`, not 127.0.0.1.
 * Loopback inside the node-api container is not the Ollama service.
 */

import dotenv from 'dotenv';
dotenv.config();

/** Same fallback as server.js (minus the /api/generate path the probe must not hit). */
export const DEFAULT_OLLAMA_ORIGIN = 'http://home-ai-ollama:11434';

export function ollamaBaseUrl() {
  const raw = process.env.OLLAMA_URL || DEFAULT_OLLAMA_ORIGIN;
  try {
    const withScheme = raw.includes('://') ? raw : `http://${raw}`;
    const parsed = new URL(withScheme);
    return `${parsed.protocol}//${parsed.host}/`;
  } catch {
    return `${DEFAULT_OLLAMA_ORIGIN}/`;
  }
}

/**
 * Built at scheduler start so OLLAMA_URL is read after dotenv (ESM imports run first).
 * @returns {import('./lib/latency/targets.js').LatencyTargetInput[]}
 */
export function getLatencyTargets() {
  return [
    {
      id: 'home-ai',
      name: 'home-ai API',
      type: 'http',
      url: 'http://127.0.0.1:3000/api/health',
      intervalMs: 30000,
      timeoutMs: 3000,
    },
    {
      id: 'postgres-main',
      name: 'PostgreSQL',
      type: 'postgres',
      connectionStringEnv: 'DATABASE_URL',
      intervalMs: 30000,
      timeoutMs: 3000,
    },
    {
      id: 'ollama',
      name: 'Ollama',
      type: 'ollama',
      url: ollamaBaseUrl(),
      intervalMs: 30000,
      timeoutMs: 3000,
      expectBodyIncludes: 'Ollama is running',
    },

    // --- examples (uncomment and edit) ---

    // Local app on this machine / homelab host:
    // {
    //   id: 'local-api',
    //   name: 'Local API',
    //   type: 'http',
    //   url: 'http://127.0.0.1:3001/health',
    //   intervalMs: 30000,
    //   timeoutMs: 3000,
    // },

    // Public / Vercel hobby — keep interval at 60s to spare free-tier quotas:
    // {
    //   id: 'vercel-app',
    //   name: 'Vercel App',
    //   type: 'http',
    //   url: 'https://your-app.vercel.app/api/health',
    //   intervalMs: 60000,
    //   timeoutMs: 5000,
    // },

    // Raw TCP (Redis, MQTT, game server, published Docker port):
    // {
    //   id: 'redis-tcp',
    //   name: 'Redis',
    //   type: 'tcp',
    //   host: '127.0.0.1',
    //   port: 6379,
    //   intervalMs: 30000,
    //   timeoutMs: 2000,
    // },
  ];
}

export default getLatencyTargets;
