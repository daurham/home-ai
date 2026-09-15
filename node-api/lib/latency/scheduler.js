import configuredTargets from '../../latency-targets.js';
import { createRingBuffer } from './ringBuffer.js';
import { deriveStatus } from './status.js';
import { loadTargets } from './targets.js';
import { probeTarget, closePostgresPools } from './probes.js';
import { DEFAULT_CONCURRENCY } from './targets.js';

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

export function startLatencyScheduler() {
  if (tickTimer) return;
  const { targets } = loadTargets(configuredTargets);
  states = targets.map(createState);
  console.log(`[latency] scheduler started with ${states.length} target(s), concurrency ${DEFAULT_CONCURRENCY}`);
  void tick();
  tickTimer = setInterval(() => {
    void tick();
  }, TICK_MS);
  if (typeof tickTimer.unref === 'function') tickTimer.unref();
}

export async function stopLatencyScheduler() {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  await closePostgresPools();
  states = [];
}
