import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_OLLAMA_ORIGIN, ollamaBaseUrl } from '../../latency-targets.js';

describe('ollamaBaseUrl', () => {
  it('defaults to the Compose service hostname, not loopback', () => {
    const previous = process.env.OLLAMA_URL;
    delete process.env.OLLAMA_URL;
    try {
      assert.equal(DEFAULT_OLLAMA_ORIGIN, 'http://home-ai-ollama:11434');
      assert.equal(ollamaBaseUrl(), 'http://home-ai-ollama:11434/');
    } finally {
      if (previous === undefined) delete process.env.OLLAMA_URL;
      else process.env.OLLAMA_URL = previous;
    }
  });

  it('strips /api/generate so probes never hit the expensive path', () => {
    const previous = process.env.OLLAMA_URL;
    process.env.OLLAMA_URL = 'http://home-ai-ollama:11434/api/generate';
    try {
      assert.equal(ollamaBaseUrl(), 'http://home-ai-ollama:11434/');
    } finally {
      if (previous === undefined) delete process.env.OLLAMA_URL;
      else process.env.OLLAMA_URL = previous;
    }
  });
});
