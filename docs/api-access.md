# Giving an app access to the home-ai API

`ai.daurham.com` is a Cloudflare tunnel pointed straight at `node-api:3000` on the home box. It exists so external projects (`calorie-tracker`, and whatever comes next) can use the AI endpoints. It is **not** meant to expose the household database routes, which have no auth of their own.

Two layers enforce that. Understanding both is the whole job:

| Layer | Where it lives | What it asks |
| --- | --- | --- |
| Cloudflare edge allowlist | WAF custom rule on the `daurham.com` zone | "Is this path one of the few I publish?" |
| Tunnel guard | `node-api/lib/externalAccess.js` | "Did this request arrive through Cloudflare? Then show me the API key." |

The guard identifies tunnel traffic by the `CF-Ray` header, which Cloudflare always adds and an outside caller cannot strip. LAN requests never carry it, so anything on the home network — the dashboard, the latency probes — is unaffected and needs no key for the data routes.

## What is reachable from the internet today

```
/api/ai            POST   key required
/api/ai/stream     POST   key required
/api/nutrition     POST   key required
/api/home-assistant POST  key required
/api/health        GET    open (the latency probe polls it and cannot send headers)
```

Everything else — expenses, expense categories, expense settings, calendar, modules, module instances, module data, latency targets — is blocked at the edge and, if the edge rule is ever missing, rejected by the guard with `403 {"error":"Forbidden: API key required for external access"}`.

The guard fails closed: if `API_KEY` is unset in `node-api/.env`, every external request is rejected, and node-api logs a warning at startup.

## Case 1: a new app that only uses endpoints already published

**Nothing changes on the server.** This is the `calorie-tracker` case. Give the app the key and send it as `x-api-key`:

```js
// calorie-tracker/api/analyze-food.js — the pattern to copy
const AI_API_URL = 'https://ai.daurham.com/api/nutrition';
const AI_API_KEY = process.env.AI_API_KEY;

const response = await fetch(AI_API_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-api-key': AI_API_KEY },
  body: JSON.stringify({ query }), // `query` for /api/nutrition, /api/ai and /api/ai/stream; `message` for /api/home-assistant
});
```

The consumer's own domain is irrelevant. There is no per-domain allowlist and no CORS setup to do, because auth is a header, not an origin.

**Call it from server-side code only.** `calorie-tracker` does this correctly: the browser hits its own `/api/analyze-food` on Vercel, and that serverless function holds `AI_API_KEY` and calls home-ai. If you instead `fetch('https://ai.daurham.com/...')` from React, the key ships to every visitor's browser and you've handed out write access. Route it through a serverless function, a Next.js route handler, or a small proxy — every time.

Checklist for a new app:

1. Set `AI_API_KEY` in the host's environment (Vercel → Project → Settings → Environment Variables). Never commit it.
2. Call `https://ai.daurham.com/api/<endpoint>` from server-side code with the `x-api-key` header.
3. Verify: `curl -X POST https://ai.daurham.com/api/nutrition -H "x-api-key: $AI_API_KEY" -H 'Content-Type: application/json' -d '{"query":"calories in one apple"}'`

## Case 2: a new app needs a *new* endpoint

This is the case that requires touching two places. Skip either one and it fails in a confusing way.

1. **Add the route with `authenticate`** in `node-api/server.js`. The AI endpoints all use it, and it enforces the key regardless of whether the caller is on the LAN or the internet:

   ```js
   app.post('/api/my-new-thing', authenticate, async (req, res) => { /* ... */ });
   ```

2. **Publish the path at the edge** by adding it to the WAF custom rule's allowed set (see below). Until you do, Cloudflare blocks it before it ever reaches your house, and you'll be staring at a Cloudflare block page wondering why your handler never logs anything.

3. Rebuild node-api on the home box: `docker compose up -d --build node-api` — the image bakes in the source, so a plain `restart` won't pick up code changes.

4. Verify from outside, both directions:

   ```bash
   curl -o /dev/null -w '%{http_code}\n' https://ai.daurham.com/api/my-new-thing            # expect 403
   curl -o /dev/null -w '%{http_code}\n' -H "x-api-key: $AI_API_KEY" \
        -X POST https://ai.daurham.com/api/my-new-thing                                     # expect 200
   ```

If the new endpoint is for internal dashboard use only, do the opposite: mount it and add nothing at the edge. It stays LAN-only for free.

## Editing the edge allowlist

**Zone-level custom rules are on the Free plan (5 rules).** The paywall you hit was *account-level* WAF, a separate Enterprise add-on. Go to the domain, not the account:

Cloudflare dashboard → **Domains → daurham.com → Security → Security rules** → Create rule. (Older nav: Security → WAF → Custom rules.)

Action **Block**, status **Active**. Skip the Field/Operator/Value builder — click **Edit expression** above it and paste:

```
(http.host eq "ai.daurham.com") and not (http.request.uri.path in {"/api/health" "/api/ai" "/api/ai/stream" "/api/nutrition" "/api/home-assistant"})
```

The leading host check keeps the rule from touching anything else in the zone, such as the Vercel site on the apex domain.

To publish a new path, add it to that set. Matching is exact, so `/api/ai/` with a trailing slash is blocked even though Express would serve it — only a gotcha when hand-testing with curl. Exact string matching is deliberate — the Free plan has no regex support in custom rules, so `matches` is unavailable, and `starts_with()` is the only prefix tool if you ever need one path to cover a subtree.

**If the tunnel is locally managed** via a `config.yml` instead of a dashboard token, do it in the ingress rules, where `path` *is* a regex and order matters:

```yaml
ingress:
  - hostname: ai.daurham.com
    path: ^/api/(ai(/stream)?|nutrition|home-assistant|health)$
    service: http://192.168.1.161:3000
  - hostname: ai.daurham.com
    service: http_status:404
  - service: http_status:404
```

## Case 3: a new hostname or tunnel

The WAF rule is scoped to `http.host eq "ai.daurham.com"`. **A new public hostname on the tunnel silently bypasses it** — say you add `api2.daurham.com` pointing at the same node-api. The tunnel guard still demands the key, so your data isn't instantly public, but the path allowlist is gone.

So when adding a hostname, either add a matching WAF rule for it, or generalize the existing rule's host check to cover both. Same applies to standing up a second tunnel to the same box.

## Troubleshooting by symptom

| What you see | Which layer | Fix |
| --- | --- | --- |
| Cloudflare block page / HTML error, request never appears in node-api logs | Edge rule | Path isn't in the allowlist set |
| `403 {"error":"Forbidden: API key required for external access"}` | Tunnel guard | Missing or wrong `x-api-key` from an external caller |
| `403 {"error":"Forbidden: Invalid API key"}` | Endpoint's `authenticate` | Same cause, but the request got past the guard — check for a typo'd key rather than a missing one |
| `404` with an Express HTML body | Neither | Path isn't mounted, or you used the wrong method (the AI endpoints are all POST) |
| Works on LAN, 403 through the tunnel | Tunnel guard | The LAN path skips the key entirely for data routes; that's expected |
| Latency card for the tunnel goes red | — | Confirm `/api/health` is still in the allowlist set |

## Key hygiene

One shared `API_KEY` gates every external caller, so it's worth treating carefully. `calorie-tracker/test-new-ai-api.js` has a key hardcoded as `'1212'` — if that's the real value, rotate it: it's four digits and it's sitting in a repo. Rotating means updating `API_KEY` in `node-api/.env`, restarting node-api, then updating `AI_API_KEY` in every consumer's environment.

If you ever want per-app revocation instead of one shared secret, the natural next step is Cloudflare Access with a service token per app, which moves identity to the edge and lets you kill one app's access without touching the others.
