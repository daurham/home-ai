import axios from 'axios';
import { loadWorkoutConfig, ollamaBaseUrl, ollamaModel, transcribeTimeoutMs } from './config.js';

const USER_PROMPT = [
  'Transcribe the attached completed workout sheet.',
  'Return only the resulting JSON.',
  'Do not infer, normalize, or correct ambiguous data except for the explicitly',
  'defined same-exercise blank-weight carry-forward shorthand.',
].join(' ');

export const VISION_DEBUG_PROMPT = [
  'Describe exactly what you see in this image.',
  'What routine letter is printed at the top?',
  'Read the handwritten body weight, effort, pain, quick note,',
  'and every handwritten number in B01 through B07.',
  'Do not produce JSON.',
].join(' ');

export function buildTranscribePrompt(pack = loadWorkoutConfig().pack) {
  return `${pack.trim()}\n\n${USER_PROMPT}\n`;
}

export function toImageBase64(imageBuffer) {
  return Buffer.from(imageBuffer).toString('base64');
}

export function chatImageBody({ model, content, imageBase64, format, temperature = 0 }) {
  const body = {
    model,
    messages: [
      {
        role: 'user',
        content,
        images: [imageBase64],
      },
    ],
    stream: false,
    options: { temperature },
  };
  if (format !== undefined) body.format = format;
  return body;
}

export async function ollamaChatImage({
  imageBuffer,
  model,
  content,
  format,
  env = process.env,
  post = axios.post,
}) {
  const usedModel = model || ollamaModel(env);
  const url = `${ollamaBaseUrl(env)}/api/chat`;
  const body = chatImageBody({
    model: usedModel,
    content,
    imageBase64: toImageBase64(imageBuffer),
    format,
  });
  const response = await post(url, body, { timeout: transcribeTimeoutMs(env) });
  const data = response.data || {};
  return {
    model: data.model || usedModel,
    raw: data.message?.content ?? '',
    formatMode: format === undefined ? 'none' : typeof format === 'string' ? format : 'json-schema',
  };
}

export async function listOllamaModels({ env = process.env, get = axios.get } = {}) {
  const url = `${ollamaBaseUrl(env)}/api/tags`;
  const response = await get(url, { timeout: 15000 });
  return response.data?.models || [];
}

export async function showOllamaModel({ model, env = process.env, post = axios.post } = {}) {
  const url = `${ollamaBaseUrl(env)}/api/show`;
  const response = await post(url, { name: model }, { timeout: 15000 });
  return response.data || {};
}

export async function ollamaLoadedModels({ env = process.env, get = axios.get } = {}) {
  const url = `${ollamaBaseUrl(env)}/api/ps`;
  const response = await get(url, { timeout: 15000 });
  return response.data?.models || [];
}

export async function unloadOllamaModel({ model, env = process.env, post = axios.post } = {}) {
  const url = `${ollamaBaseUrl(env)}/api/generate`;
  await post(url, { model, prompt: '', keep_alive: 0 }, { timeout: 30000 });
}

export async function generateWorkoutJson({
  imageBuffer,
  model,
  schema,
  env = process.env,
  post = axios.post,
}) {
  return ollamaChatImage({
    imageBuffer,
    model,
    content: buildTranscribePrompt(),
    format: schema,
    env,
    post,
  });
}

export async function visionDebugImage({
  imageBuffer,
  model,
  env = process.env,
  post = axios.post,
}) {
  if (!imageBuffer || !Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    const error = new Error('image is required');
    error.status = 400;
    throw error;
  }

  const usedModel = model || ollamaModel(env);
  const started = Date.now();
  const ollama = await ollamaChatImage({
    imageBuffer,
    model: usedModel,
    content: VISION_DEBUG_PROMPT,
    env,
    post,
  });

  return {
    ok: true,
    model: ollama.model || usedModel,
    elapsed_ms: Date.now() - started,
    raw: ollama.raw,
    prompt: VISION_DEBUG_PROMPT,
  };
}
