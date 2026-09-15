import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeError } from './sanitizeError.js';

describe('sanitizeError', () => {
  it('maps common syscall codes', () => {
    assert.equal(sanitizeError({ code: 'ECONNREFUSED' }), 'connection refused');
    assert.equal(sanitizeError({ code: 'ETIMEDOUT' }), 'timeout');
    assert.equal(sanitizeError(null, { status: 503 }), 'status 503');
    assert.equal(sanitizeError({ name: 'AbortError' }), 'timeout');
  });

  it('does not leak connection strings or credentials', () => {
    assert.equal(
      sanitizeError(new Error('password authentication failed for user "homeai"')),
      'connection error',
    );
    assert.equal(
      sanitizeError(new Error('connect postgresql://homeai:secret@db:5432/homeai')),
      'connection error',
    );
  });

  it('maps fetch failures including nested syscall codes', () => {
    assert.equal(sanitizeError({ message: 'fetch failed' }), 'connection error');
    assert.equal(sanitizeError({ message: 'fetch failed', cause: { code: 'ECONNREFUSED' } }), 'connection refused');
  });

  it('redacts urls from generic messages', () => {
    assert.equal(
      sanitizeError(new Error('request failed http://127.0.0.1:3000/api/health')),
      'request failed [url]',
    );
  });
});
