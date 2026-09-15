/**
 * Small in-memory ring of sparkline samples. Failed ticks are stored as null (gaps).
 * Arrays stay tiny (default ~90); shift() is fine at this size.
 */
export function createRingBuffer(capacity = 90) {
  const cap = Math.max(2, Math.min(Number(capacity) || 90, 240));
  /** @type {Array<number | null>} */
  const data = [];

  return {
    get capacity() {
      return cap;
    },
    push(value) {
      const sample = value == null || !Number.isFinite(value) ? null : value;
      data.push(sample);
      if (data.length > cap) {
        data.shift();
      }
    },
    toArray() {
      return data.slice();
    },
  };
}
