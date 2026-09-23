import { parseModelJson } from './parseModelJson.js';
import { ollamaChatImage } from './ollama.js';
import {
  HEADER_SCHEMA,
  LITERAL_RAW_TRANSCRIPTION_SCHEMA,
  NOTE_SCHEMA,
  RAW_TRANSCRIPTION_SCHEMA,
  SLOT_IDS,
  slotSchema,
} from './rawSchema.js';
import { cropAllRegions, orientImage } from './cropRegions.js';
import {
  WHOLE_PAGE_PROMPT,
  WHOLE_PAGE_PROMPT_POC3,
  headerPrompt,
  notePrompt,
  slotPrompt,
} from './extractPrompts.js';

export async function extractWholePage({
  imageBuffer,
  model,
  env,
  post,
  content = WHOLE_PAGE_PROMPT,
  format = RAW_TRANSCRIPTION_SCHEMA,
  variant = 'whole-page',
}) {
  const started = Date.now();
  const oriented = await orientImage(imageBuffer);
  const ollama = await ollamaChatImage({
    imageBuffer: oriented,
    model,
    content,
    format,
    env,
    post,
  });
  const parsed = parseModelJson(ollama.raw);
  return {
    variant,
    model: ollama.model,
    elapsed_ms: Date.now() - started,
    calls: 1,
    rawText: ollama.raw,
    raw: parsed.ok ? parsed.value : null,
    parseError: parsed.ok ? null : parsed.error,
    prompt: content,
    parts: { page: { raw: ollama.raw, parsed: parsed.value, error: parsed.error } },
  };
}

export function extractWholePagePoc3(args) {
  return extractWholePage({
    ...args,
    content: WHOLE_PAGE_PROMPT_POC3,
    format: LITERAL_RAW_TRANSCRIPTION_SCHEMA,
    variant: 'whole-page-poc3',
  });
}

export async function extractCroppedRegions({
  imageBuffer,
  model,
  env,
  post,
  crop = cropAllRegions,
}) {
  const started = Date.now();
  const { paper, crops } = await crop(imageBuffer);
  const parts = {};
  const raw = emptyRaw();

  const header = await extractPart({
    imageBuffer: crops.header.buffer,
    model,
    env,
    post,
    content: headerPrompt(),
    format: HEADER_SCHEMA,
  });
  parts.header = header;
  if (header.parsed) Object.assign(raw, pick(header.parsed, ['date_written', 'bodyweight', 'effort', 'pain']));

  const note = await extractPart({
    imageBuffer: crops.note.buffer,
    model,
    env,
    post,
    content: notePrompt(),
    format: NOTE_SCHEMA,
  });
  parts.note = note;
  if (note.parsed && Object.prototype.hasOwnProperty.call(note.parsed, 'note')) {
    raw.note = note.parsed.note;
  }

  for (const slotId of SLOT_IDS) {
    const part = await extractPart({
      imageBuffer: crops[slotId].buffer,
      model,
      env,
      post,
      content: slotPrompt(slotId),
      format: slotSchema(slotId),
    });
    parts[slotId] = part;
    raw[slotId] = Array.isArray(part.parsed?.rows) ? part.parsed.rows : [];
  }

  return {
    variant: 'crops',
    model: header.model || model,
    elapsed_ms: Date.now() - started,
    calls: 2 + SLOT_IDS.length,
    paper,
    rawText: JSON.stringify(parts, null, 2),
    raw,
    parseError: Object.values(parts).find((p) => p.error)?.error || null,
    parts,
  };
}

async function extractPart({ imageBuffer, model, env, post, content, format }) {
  try {
    const ollama = await ollamaChatImage({
      imageBuffer,
      model,
      content,
      format,
      env,
      post,
    });
    const parsed = parseModelJson(ollama.raw);
    return {
      model: ollama.model,
      raw: ollama.raw,
      parsed: parsed.ok ? parsed.value : null,
      error: parsed.ok ? null : parsed.error,
    };
  } catch (error) {
    return {
      model,
      raw: '',
      parsed: null,
      error: error.message,
    };
  }
}

function emptyRaw() {
  const raw = {
    date_written: null,
    bodyweight: null,
    effort: null,
    pain: null,
    note: null,
  };
  for (const slotId of SLOT_IDS) raw[slotId] = [];
  return raw;
}

function pick(obj, keys) {
  const out = {};
  for (const key of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, key)) out[key] = obj[key];
  }
  return out;
}
