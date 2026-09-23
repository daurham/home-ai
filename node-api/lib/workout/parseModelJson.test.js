import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseModelJson } from './parseModelJson.js';

describe('parseModelJson', () => {
  it('parses a bare object', () => {
    const result = parseModelJson('{"schema_version":"1.2"}');
    assert.equal(result.ok, true);
    assert.equal(result.value.schema_version, '1.2');
  });

  it('extracts a fenced JSON object', () => {
    const result = parseModelJson('Here\n```json\n{"a":1}\n```\n');
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, { a: 1 });
  });

  it('does not invent JSON for prose', () => {
    const result = parseModelJson('no json here');
    assert.equal(result.ok, false);
    assert.equal(result.value, null);
  });
});
