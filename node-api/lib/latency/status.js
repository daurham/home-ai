const FLAP_WINDOW = 4;

/**
 * @param {{ ok: boolean, latencyMs: number | null, degradedThresholdMs: number, samples: Array<number | null> }} args
 * @returns {'up' | 'degraded' | 'down'}
 */
export function deriveStatus({ ok, latencyMs, degradedThresholdMs, samples }) {
  if (!ok) return 'down';
  if (latencyMs != null && latencyMs >= degradedThresholdMs) return 'degraded';

  const recent = samples.slice(-FLAP_WINDOW);
  if (recent.length >= 3) {
    const fails = recent.filter((s) => s == null).length;
    const oks = recent.filter((s) => s != null).length;
    if (fails >= 1 && oks >= 1) return 'degraded';
  }

  return 'up';
}
