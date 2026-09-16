import fs from 'node:fs';
import path from 'node:path';

export const FILE_SHARE_LOCK_KEY = 872314;
export const DEFAULT_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function quotaBytes(env = process.env) {
  const raw = env.FILE_SHARE_QUOTA_BYTES;
  const n = raw == null || raw === '' ? DEFAULT_QUOTA_BYTES : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_QUOTA_BYTES;
  return Math.floor(n);
}

export function storageDir(env = process.env) {
  return env.FILE_SHARE_DIR || path.resolve(process.cwd(), 'data', 'file-share');
}

export function ensureStorageDir(dir = storageDir()) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function storedPath(storedName, dir = storageDir()) {
  if (!storedName || String(storedName).includes('..') || path.isAbsolute(storedName)) {
    throw new Error('invalid stored name');
  }
  const base = path.basename(String(storedName));
  return path.join(dir, base);
}

export function sanitizeOriginalName(name) {
  const trimmed = String(name || '').replace(/[\u0000-\u001f]/g, '').trim();
  const base = path.basename(trimmed.replace(/\\/g, '/')) || 'file';
  return base.slice(0, 255);
}

export function remainingBytes(usedBytes, limitBytes) {
  return Math.max(0, limitBytes - usedBytes);
}

export function canAcceptUpload(usedBytes, incomingBytes, limitBytes) {
  if (!Number.isFinite(incomingBytes) || incomingBytes <= 0) {
    return { ok: false, code: 'empty', remaining: remainingBytes(usedBytes, limitBytes) };
  }
  const remaining = remainingBytes(usedBytes, limitBytes);
  if (incomingBytes > remaining) {
    return { ok: false, code: 'quota', remaining, usedBytes, limitBytes };
  }
  return { ok: true, remaining, usedBytes, limitBytes };
}

export function rowToFile(row) {
  return {
    id: row.id,
    originalName: row.original_name,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    createdAt: row.created_at,
  };
}

export function usagePayload(usedBytes, limitBytes) {
  const used = Number(usedBytes) || 0;
  const limit = limitBytes;
  return {
    usedBytes: used,
    quotaBytes: limit,
    remainingBytes: remainingBytes(used, limit),
  };
}

export function contentDisposition(originalName) {
  const fallback = sanitizeOriginalName(originalName).replace(/"/g, '');
  const encoded = encodeURIComponent(fallback);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
