import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  VISION_DEBUG_PROMPT,
  buildTranscribePrompt,
  chatImageBody,
  generateWorkoutJson,
  visionDebugImage,
} from './ollama.js';

describe('chatImageBody', () => {
  it('uses /api/chat multimodal fields and omits format unless asked', () => {
    const body = chatImageBody({
      model: 'llama3.2-vision:11b',
      content: 'what is this?',
      imageBase64: 'abc',
    });
    assert.equal(body.model, 'llama3.2-vision:11b');
    assert.equal(body.stream, false);
    assert.equal(body.options.temperature, 0);
    assert.equal(body.messages[0].role, 'user');
    assert.deepEqual(body.messages[0].images, ['abc']);
    assert.equal('format' in body, false);
  });
});

describe('generateWorkoutJson', () => {
  it('posts to /api/chat with the schema format and does not retry as plain json', async () => {
    const calls = [];
    await assert.rejects(
      () => generateWorkoutJson({
        imageBuffer: Buffer.from('img'),
        model: 'llama3.2-vision:11b',
        schema: { type: 'object' },
        env: { OLLAMA_BASE_URL: 'http://ollama.test' },
        post: async (url, body) => {
          calls.push({ url, body });
          throw new Error('schema rejected');
        },
      }),
      /schema rejected/,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://ollama.test/api/chat');
    assert.equal(calls[0].body.format.type, 'object');
    assert.match(calls[0].body.messages[0].content, /WORKOUT AI TRANSCRIPTION PACK/);
  });
});

describe('visionDebugImage', () => {
  it('asks a plain-language question with no pack and no schema', async () => {
    const result = await visionDebugImage({
      imageBuffer: Buffer.from('img'),
      model: 'llama3.2-vision:11b',
      env: { OLLAMA_BASE_URL: 'http://ollama.test' },
      post: async (url, body) => {
        assert.equal(url, 'http://ollama.test/api/chat');
        assert.equal('format' in body, false);
        assert.equal(body.messages[0].content, VISION_DEBUG_PROMPT);
        assert.equal(body.messages[0].content.includes('WORKOUT AI TRANSCRIPTION PACK'), false);
        assert.equal(buildTranscribePrompt().includes('WORKOUT AI TRANSCRIPTION PACK'), true);
        return {
          data: {
            model: 'llama3.2-vision:11b',
            message: { content: 'Routine B, bodyweight 192' },
          },
        };
      },
    });
    assert.equal(result.raw, 'Routine B, bodyweight 192');
    assert.equal(result.ok, true);
  });
});
