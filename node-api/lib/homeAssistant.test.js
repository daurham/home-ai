import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildHomeAssistantPrompt, normalizeConversationHistory } from './homeAssistant.js';

describe('normalizeConversationHistory', () => {
  it('keeps user and assistant turns and drops junk', () => {
    const history = normalizeConversationHistory([
      { role: 'user', content: '  Hello  ' },
      { role: 'system', content: 'ignore me' },
      { role: 'assistant', content: 'Hi there' },
      { role: 'user', content: '' },
      null,
      { role: 'user' },
    ]);
    assert.deepEqual(history, [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ]);
  });

  it('caps history at the last 20 turns', () => {
    const raw = Array.from({ length: 24 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `m${i}`,
    }));
    const history = normalizeConversationHistory(raw);
    assert.equal(history.length, 20);
    assert.equal(history[0].content, 'm4');
    assert.equal(history[19].content, 'm23');
  });
});

describe('buildHomeAssistantPrompt', () => {
  it('wraps a first message with the home-assistant system prompt', () => {
    const prompt = buildHomeAssistantPrompt('Turn on the lights');
    assert.match(prompt, /^You are a helpful AI home assistant\./);
    assert.match(prompt, /User: Turn on the lights\nAssistant:$/);
    assert.doesNotMatch(prompt, /Previous conversation/);
  });

  it('includes prior turns so Ollama keeps context', () => {
    const prompt = buildHomeAssistantPrompt('And the kitchen?', [
      { role: 'user', content: 'Turn on the living room lights' },
      { role: 'assistant', content: 'Done — living room lights are on.' },
    ]);
    assert.match(prompt, /Previous conversation:/);
    assert.match(prompt, /User: Turn on the living room lights/);
    assert.match(prompt, /Assistant: Done — living room lights are on\./);
    assert.match(prompt, /User: And the kitchen\?\nAssistant:$/);
  });
});
