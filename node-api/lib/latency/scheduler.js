import getConfiguredTargets from '../../latency-targets.js';
import { createRingBuffer } from './ringBuffer.js';
import { deriveStatus } from './status.js';
import { loadTargets } from './targets.js';
import { probeTarget, closePostgresPools } from './probes.js';
import { DEFAULT_CONCURRENCY } from './targets.js';
import { listEnabledTargetInputs } from './store.js';

const TICK_MS = 1000;

function createLimiter(max) {
  let active = 0;
  /** @type {Array<() => void>} */
  const queue = [];

  return async function limit(fn) {
    if (active >= max) {
      await new Promise((resolve) => {
        queue.push(resolve);
      });
    }
    active += 1;
    try {
      return await fn();
    } finally {
      active -= 1;
      const next = queue.shift();
      if (next) next();
    }
  };
}

/** What the dashboard shows as "the thing being probed". Never a secret value. */
function targetEndpoint(target) {
  if (target.type === 'tcp') return `${target.host}:${target.port}`;
  if (target.type === 'postgres') return `${target.connectionStringEnv} (env var)`;
  return target.url || '';
}

function publicTarget(state) {
  return {
    id: state.target.id,
    name: state.target.name,
    type: state.target.type,
    status: state.status,
    latencyMs: state.latencyMs,
    checkedAt: state.checkedAt,
    error: state.error || undefined,
    samples: state.buffer.toArray(),
    intervalMs: state.target.intervalMs,
    endpoint: targetEndpoint(state.target),
  };
}

function createState(target) {
  return {
    target,
    buffer: createRingBuffer(target.sampleCapacity),
    status: 'down',
    latencyMs: null,
    checkedAt: null,
    error: 'not yet checked',
    lastStartedAt: 0,
    inFlight: false,
  };
}

/** Whether two configs probe the same thing, i.e. collected history still applies. */
function sameProbe(a, b) {
  return (
    a.type === b.type &&
    a.url === b.url &&
    a.method === b.method &&
    a.host === b.host &&
    a.port === b.port &&
    a.connectionStringEnv === b.connectionStringEnv &&
    a.expectBodyIncludes === b.expectBodyIncludes &&
    a.sampleCapacity === b.sampleCapacity
  );
}

/** Keeps samples for targets that still probe the same endpoint; drops the rest. */
function reconcileStates(previous, targets) {
  const byId = new Map(previous.map((state) => [state.target.id, state]));
  return targets.map((target) => {
    const existing = byId.get(target.id);
    if (!existing || !sameProbe(existing.target, target)) return createState(target);
    // Renames and timing tweaks keep their history.
    existing.target = target;
    return existing;
  });
}

function builtinTargetInputs() {
  return typeof getConfiguredTargets === 'function' ? getConfiguredTargets() : getConfiguredTargets;
}

/** Normalized built-in targets, i.e. the ones the dashboard cannot edit. */
export function builtinTargets() {
  const { targets } = loadTargets(builtinTargetInputs());
  return targets;
}

/**
 * Rebuilds the probe list from the built-in config plus enabled database rows.
 * Built-ins win on id collisions, and a database outage leaves them running.
 */
export async function reloadLatencyTargets() {
  let stored = [];
  try {
    stored = await listEnabledTargetInputs();
  } catch (err) {
    console.warn('[latency] could not load database targets:', err?.message || err);
  }

  const { targets, errors } = loadTargets([...builtinTargetInputs(), ...stored]);
  states = reconcileStates(states, targets);
  return { count: states.length, errors };
}

let states = [];
let tickTimer = null;
let ticking = false;
const limit = createLimiter(DEFAULT_CONCURRENCY);

async function runOne(state) {
  if (state.inFlight) return publicTarget(state);
  state.inFlight = true;
  state.lastStartedAt = Date.now();
  try {
    const result = await probeTarget(state.target);
    const latencyMs = result.ok ? result.latencyMs : null;
    state.buffer.push(latencyMs);
    state.ok = result.ok;
    state.latencyMs = latencyMs;
    state.error = result.ok ? null : (result.error || 'error');
    state.checkedAt = new Date().toISOString();
    state.status = deriveStatus({
      ok: result.ok,
      latencyMs,
      degradedThresholdMs: state.target.degradedThresholdMs,
      samples: state.buffer.toArray(),
    });
  } catch (err) {
    state.buffer.push(null);
    state.ok = false;
    state.latencyMs = null;
    state.error = 'error';
    state.checkedAt = new Date().toISOString();
    state.status = 'down';
    console.warn(`[latency] probe ${state.target.id} threw:`, err?.message || err);
  } finally {
    state.inFlight = false;
  }
  return publicTarget(state);
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const now = Date.now();
    const due = states.filter((s) => !s.inFlight && now - s.lastStartedAt >= s.target.intervalMs);
    if (!due.length) return;
    await Promise.all(due.map((s) => limit(() => runOne(s))));
  } catch (err) {
    console.warn('[latency] scheduler tick failed:', err?.message || err);
  } finally {
    ticking = false;
  }
}

export function getLatencySnapshot() {
  return {
    targets: states.map(publicTarget),
    generatedAt: new Date().toISOString(),
  };
}

export async function forceLatencyCheck(id) {
  const state = states.find((s) => s.target.id === id);
  if (!state) return null;
  return runOne(state);
}

export async function startLatencyScheduler() {
  if (tickTimer) return;
  // Claim the timer slot before awaiting so a double call cannot start two tickers.
  tickTimer = setInterval(() => {
    void tick();
  }, TICK_MS);
  if (typeof tickTimer.unref === 'function') tickTimer.unref();

  await reloadLatencyTargets();
  const ollama = states.find((s) => s.target.type === 'ollama');
  console.log(`[latency] scheduler started with ${states.length} target(s), concurrency ${DEFAULT_CONCURRENCY}`);
  if (ollama) {
    console.log(`[latency] ollama probe ${ollama.target.url}`);
  }
  void tick();
}

export async function stopLatencyScheduler() {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  await closePostgresPools();
  states = [];
}
