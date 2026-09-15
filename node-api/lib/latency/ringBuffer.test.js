import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRingBuffer } from './ringBuffer.js';

describe('createRingBuffer', () => {
  it('stores values in insertion order and drops the oldest past capacity', () => {
    const buf = createRingBuffer(3);
    buf.push(10);
    buf.push(20);
    buf.push(30);
    buf.push(40);
    assert.deepEqual(buf.toArray(), [20, 30, 40]);
  });

  it('stores failed ticks as null so sparklines can gap', () => {
    const buf = createRingBuffer(5);
    buf.push(12);
    buf.push(null);
    buf.push(Number.NaN);
    buf.push(undefined);
    buf.push(8);
    assert.deepEqual(buf.toArray(), [12, null, null, null, 8]);
  });
});
