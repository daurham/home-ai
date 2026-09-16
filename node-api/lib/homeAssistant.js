const MAX_HISTORY = 20;

export function normalizeConversationHistory(raw, { limit = MAX_HISTORY } = {}) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const role = item.role === 'assistant' ? 'assistant' : item.role === 'user' ? 'user' : null;
    const content = typeof item.content === 'string' ? item.content.trim() : '';
    if (!role || !content) continue;
    out.push({ role, content });
  }
  return out.slice(-limit);
}

export function buildHomeAssistantPrompt(message, conversationHistory = []) {
  const text = typeof message === 'string' ? message.trim() : '';
  const history = normalizeConversationHistory(conversationHistory);

  let prompt = 'You are a helpful AI home assistant.\n';
  if (history.length > 0) {
    prompt += '\nPrevious conversation:\n';
    for (const msg of history) {
      prompt += `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}\n`;
    }
  }
  prompt += `\nUser: ${text}\nAssistant:`;
  return prompt;
}

export function pipeOllamaStream(ollamaStream, res) {
  ollamaStream.on('data', (chunk) => {
    try {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        const data = JSON.parse(line);
        if (data.response) res.write(data.response);
        if (data.done) {
          res.end();
          return;
        }
      }
    } catch (parseErr) {
      console.error('Error parsing streaming response:', parseErr);
    }
  });

  ollamaStream.on('end', () => {
    if (!res.writableEnded) res.end();
  });

  ollamaStream.on('error', (streamErr) => {
    console.error('Stream error:', streamErr);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Ollama request failed', details: streamErr.message });
      return;
    }
    if (!res.writableEnded) res.end();
  });
}
