# Latency Sparklines — making apps probe-friendly

This dashboard’s Latency Sparklines module does not scrape random URLs from the browser. **home-ai** periodically probes an allowlisted set of targets and the UI only reads a snapshot.

Canonical copy also lives in the dashboard repo: `home-dashboard/docs/latency-sparklines-setup.md`.

**Goal of a good probe target:** cheap, idempotent, fast, no auth required on a dedicated health path (or TCP/connect checks where HTTP doesn’t apply).

**Config (the one place to add a target):** `node-api/latency-targets.js`. Restart node-api after edits.

## How the tracker works (mental model)

1. You add a target to the latency config in home-ai (`http` | `tcp` | `postgres` | `ollama`).
2. The scheduler GETs / dials / `SELECT 1`s on an interval (default ~30s; minimum 10s).
3. Latency samples live in a small in-memory ring (sparkline). Latest status is what you see on the card.
4. If a check fails or exceeds timeout → card goes down/degraded.

Do **not** point probes at expensive endpoints (homepages that hit the DB 20 times, LLM generate, admin reports, authenticated pages that 302 to login).

Hot path is memory-only. Samples are **not** written to Postgres on every tick.

## Node / Express / Fastify / generic Node server

Add a dedicated health route that does the minimum needed.

**Liveness only (process up)**

```js
// Express
app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true, service: 'my-api', ts: Date.now() });
});
```

**Readiness (process + DB)**

```js
app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({ ok: true, db: 'ok' });
  } catch {
    res.status(503).json({ ok: false, db: 'error' });
  }
});
```

Tracker config example:

```js
{
  id: 'local-api',
  name: 'Local API',
  type: 'http',
  url: 'http://127.0.0.1:3000/health',
  intervalMs: 30000,
  timeoutMs: 3000,
}
```

Tips:

- Keep the body tiny (&lt;1KB).
- Exclude `/health` from heavy middleware rate limits if they would false-fail.
- Prefer GET over HEAD (many stacks return 405 or skip middleware on HEAD).

## Vite / static / SPA (no server)

Static hosts often have no `/api`. Options:

- Probe the origin URL (`https://app.example.com/`) and treat HTTP 200 as up (measures CDN/edge + static).
- Better: add a tiny `public/health.json` → `{ "ok": true }` and probe that URL (still static, cacheable — fine for liveness of the asset host).
- If you care about API health separately, probe the API’s `/health`, not the SPA.

Note: a 200 on `index.html` does **not** prove your API or DB is healthy.

## Vercel (Next.js or static)

### Next.js App Router

```ts
// app/api/health/route.ts
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic'; // don't cache a stale ok

export async function GET() {
  // Optional: await db.$queryRaw`SELECT 1`
  return NextResponse.json(
    { ok: true, service: 'my-vercel-app', ts: new Date().toISOString() },
    { status: 200 },
  );
}
```

### If the deployment is static-only

Probe `https://your-app.vercel.app/` or `/health.json` as above.

### Tracker tips for Vercel

- Use **60s** intervals on hobby projects to reduce invocations.
- Probe `/api/health` for serverless/API truth; probe the apex URL for “edge/static up”.
- Expect cold-start spikes on sparklines — that’s useful signal, not always an outage.
- Exclude health from auth middleware.

```js
{
  id: 'vercel-app',
  name: 'Vercel App',
  type: 'http',
  url: 'https://your-app.vercel.app/api/health',
  intervalMs: 60000,
  timeoutMs: 5000,
}
```

## Locally running projects (dev machines / homelab)

- Use `http://127.0.0.1:<port>/health` when the process is on the **same machine as home-ai**.
- If the app runs on another LAN host, use that host’s LAN IP/hostname — still allowlist it in config.
- Docker: prefer probing the published port on the host, or the Docker network hostname if home-ai shares the compose network.
- If there’s no HTTP server (background worker only), either:
  - add a tiny health HTTP listener, or
  - use `tcp` against a port you know should be open, or
  - expose a heartbeat file over a minimal static server (last resort).

## Ollama

Ollama serves HTTP on port **11434** by default.

**Cheap checks (use these):**

- `GET http://127.0.0.1:11434/` → often responds with `Ollama is running`
- `GET http://127.0.0.1:11434/api/tags` → lists models (still relatively cheap)

**Do not use for health:**

`/api/generate`, `/api/chat`, embeddings — these load models / burn GPU.

```js
{
  id: 'ollama',
  name: 'Ollama',
  type: 'ollama',
  url: 'http://127.0.0.1:11434/',
  intervalMs: 30000,
  timeoutMs: 3000,
}
```

Optional stricter check: `expectBodyIncludes: 'Ollama is running'` for the `/` probe.

If node-api runs in Docker Compose, the seeded target uses `http://home-ai-ollama:11434/` (Compose DNS). Do **not** use `127.0.0.1` there — that is the node-api container itself and the card will show connection refused. The probe also strips `/api/generate` from `OLLAMA_URL` so health never hits the expensive path.

## PostgreSQL

HTTP health wrappers are optional. Prefer native checks.

### From the tracker (`postgres` probe type)

- Connect using an **env-based** connection string (`connectionStringEnv: 'DATABASE_URL'` or `MONITOR_DATABASE_URL`).
- Run `SELECT 1`.
- Reuse connections; don’t leak clients.
- Never hardcode credentials in `latency-targets.js`.

### From Docker / scripts

```sh
pg_isready -h 127.0.0.1 -p 5432 -U youruser
```

### If you must expose HTTP

Put `SELECT 1` behind your app’s `/health` readiness route (see Node section). Don’t expose Postgres to the internet for probes.

```js
{
  id: 'postgres-main',
  name: 'PostgreSQL',
  type: 'postgres',
  connectionStringEnv: 'MONITOR_DATABASE_URL',
  intervalMs: 30000,
  timeoutMs: 3000,
}
```

The seeded target uses `DATABASE_URL` (the same database home-ai already has). Use a separate `MONITOR_DATABASE_URL` if you want to watch a different instance.

## Other targets you’ll likely hit

### Redis

Best: `tcp` to 6379, or a small app route that runs `PING`.  
Avoid `MONITOR` or large `KEYS`.

### Generic TCP service (game server, MQTT, custom binary)

```js
{ id: 'svc-tcp', name: 'Custom TCP', type: 'tcp', host: '127.0.0.1', port: 8080 }
```

TCP up ≠ application logic healthy — add HTTP health when you can.

### Cloudflare / public URL

- HTTP GET to a known-stable path (`/health`, or `/cdn-cgi/trace` only if you intentionally want CF edge — prefer your health route).
- Longer timeout (5s) and 60s interval.

### Python (FastAPI / Flask)

```python
# FastAPI
@app.get("/health")
def health():
    return {"ok": True}
```

### Go

```go
http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
  w.Header().Set("Content-Type", "application/json")
  w.Write([]byte(`{"ok":true}`))
})
```

### systemd / bare process with no HTTP

Add a 10-line health server, or probe TCP if it listens. Otherwise you can’t see “down” remotely without something that answers.

### Authenticated apps

Health should be unauthenticated and return no secrets. Keep it off public internet if possible (LAN-only dashboard + LAN services), or protect at the network layer.

## Checklist: adding a new app to this tracker

1. Add a cheap `/health` (or choose `tcp` / `postgres` / `ollama` probe).
2. Verify manually:

   ```sh
   curl -sS -o /dev/null -w '%{http_code} %{time_total}\n' http://127.0.0.1:PORT/health
   ```

3. Add an allowlisted target to `node-api/latency-targets.js`.
4. Restart / reload node-api so the scheduler picks it up (`./rebuild.sh` on the server, or restart local `npm start`).
5. Open the **Latency** side tab — confirm green dot + sparkline movement.
6. Optionally stop the service once to confirm red/down behavior.

## Anti-patterns

- Probing the marketing homepage as “API health”
- Health endpoints that send email, write rows, or call Stripe
- Sub-5s intervals on Vercel hobby / paid APIs (the tracker floors interval at 10s anyway)
- Browser-side multi-tab probing
- Storing unbounded latency history in Postgres

## Privacy / security

Only probe hosts you control or have permission to monitor. Keep the allowlist in server config. The snapshot API returns sanitized errors only (`timeout`, `connection refused`, `status 503`, …) — never connection strings.

There is **no** client-supplied URL probe endpoint. `POST /api/latency/check/:id` can force a check for an **existing** allowlisted id (dev/debug only).

## Snapshot API

- `GET /api/latency/snapshot` → `{ targets: [{ id, name, type, status, latencyMs, checkedAt, error?, samples, intervalMs }], generatedAt }`
- `POST /api/latency/check/:id` — force one allowlisted check
