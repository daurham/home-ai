/**
 * Parse model text into JSON without repairing field values.
 * Fence stripping / first-object extraction is decode only.
 */
export function parseModelJson(raw) {
  if (raw == null) {
    return { ok: false, error: 'empty model output', value: null };
  }
  const text = String(raw).trim();
  if (!text) {
    return { ok: false, error: 'empty model output', value: null };
  }

  const attempts = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) attempts.push(fenced[1].trim());
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) attempts.push(text.slice(start, end + 1));

  const seen = new Set();
  let lastError = 'Model output is not JSON';
  for (const candidate of attempts) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      return { ok: true, error: null, value: JSON.parse(candidate) };
    } catch (err) {
      lastError = err.message;
    }
  }
  return { ok: false, error: lastError, value: null };
}
