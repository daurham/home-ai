import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { storageDir } from '../fileShare.js';
import { transcribeWorkoutV131, V131_ERROR } from './transcribeV131.js';

export const JOB_STATUS = {
  QUEUED: 'queued',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
};

export const V131_JOB_ERROR = {
  INVALID_JOB_ID: 'INVALID_JOB_ID',
  JOB_NOT_FOUND: 'JOB_NOT_FOUND',
  PIPELINE_INTERRUPTED: 'PIPELINE_INTERRUPTED',
};

/** UUID v4 from crypto.randomUUID — opaque, non-sequential, not a filesystem path. */
export const JOB_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const TERMINAL = new Set([JOB_STATUS.COMPLETED, JOB_STATUS.FAILED]);
const DEFAULT_TTL_MS = 48 * 60 * 60 * 1000;
const DEFAULT_MAX_TERMINAL = 40;
const DEFAULT_POLL_MS = 250;

export function isJobId(value) {
  return typeof value === 'string' && JOB_ID_RE.test(value);
}

/**
 * Central job-store policy. Override with env:
 *   WORKOUT_V131_JOB_DIR          filesystem root (not an HTTP identifier)
 *   WORKOUT_V131_JOB_TTL_MS       age after which completed/failed metadata is removed
 *   WORKOUT_V131_JOB_MAX_TERMINAL extra cap on completed+failed jobs kept
 *   WORKOUT_V131_JOB_POLL_MS      worker idle poll interval
 *
 * Default directory: <FILE_SHARE_DIR>/.internal/workout-v1.3-jobs
 * (sibling-hidden under the existing file-share volume so a process restart
 * keeps completed results; the files API addresses rows by UUID basename and
 * does not list this folder.)
 */
export function jobStoreConfig(env = process.env) {
  const ttlMs = positiveInt(env.WORKOUT_V131_JOB_TTL_MS, DEFAULT_TTL_MS);
  const maxTerminal = positiveInt(env.WORKOUT_V131_JOB_MAX_TERMINAL, DEFAULT_MAX_TERMINAL);
  const pollMs = nonNegativeInt(env.WORKOUT_V131_JOB_POLL_MS, DEFAULT_POLL_MS);
  const dir = env.WORKOUT_V131_JOB_DIR
    || path.join(storageDir(env), '.internal', 'workout-v1.3-jobs');
  return { dir, ttlMs, maxTerminal, pollMs };
}

function positiveInt(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function nonNegativeInt(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function imageExtension(filename, buffer) {
  const name = String(filename || '').toLowerCase();
  if (name.endsWith('.png')) return '.png';
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return '.jpg';
  if (buffer?.[0] === 0x89 && buffer?.[1] === 0x50) return '.png';
  return '.jpg';
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJsonAtomic(filePath, value) {
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, filePath);
}

function sanitizeError(error) {
  if (!error || typeof error !== 'object') {
    return {
      code: V131_ERROR.PIPELINE_FAILED,
      message: 'Workout transcription failed.',
    };
  }
  const out = {
    code: typeof error.code === 'string' && error.code
      ? error.code
      : V131_ERROR.PIPELINE_FAILED,
    message: typeof error.message === 'string' && error.message
      ? error.message
      : 'Workout transcription failed.',
  };
  if (error.details && typeof error.details === 'object' && !Array.isArray(error.details)) {
    out.details = error.details;
  }
  return out;
}

function interruptedError() {
  return {
    code: V131_JOB_ERROR.PIPELINE_INTERRUPTED,
    message: 'Transcription was interrupted before completion.',
    details: { retryable: true },
  };
}

/**
 * HTTP-facing job object. Timestamps, filenames, and store paths stay on disk only.
 */
export function publicJob(record) {
  if (!record) return null;
  const job = {
    id: record.id,
    status: record.status,
  };
  if (record.status === JOB_STATUS.COMPLETED) {
    job.elapsed_ms = Number(record.elapsed_ms) || 0;
    job.candidate = record.candidate;
    job.review = record.review;
  }
  if (record.status === JOB_STATUS.FAILED) {
    job.error = sanitizeError(record.error);
  }
  return job;
}

export function createV131JobService(options = {}) {
  const env = options.env || process.env;
  const defaults = jobStoreConfig(env);
  const config = { ...defaults, ...(options.config || {}) };
  const jobRoot = options.jobDir || config.dir;
  const transcribe = options.transcribe || transcribeWorkoutV131;
  const now = options.now || (() => new Date());

  let busy = false;
  let started = false;
  let loopPromise = null;
  let sleepTimer = null;
  let sleepResolve = null;

  function jobDir(id) {
    if (!isJobId(id)) {
      throw new Error('invalid job id');
    }
    return path.join(jobRoot, id);
  }

  function jobFile(id) {
    return path.join(jobDir(id), 'job.json');
  }

  function readRecord(id) {
    if (!isJobId(id)) return null;
    const filePath = jobFile(id);
    if (!fs.existsSync(filePath)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!parsed || parsed.id !== id) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function writeRecord(record) {
    const dir = ensureDir(jobDir(record.id));
    writeJsonAtomic(path.join(dir, 'job.json'), record);
    return record;
  }

  function removeSourceFiles(id) {
    const dir = jobDir(id);
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      if (name === 'job.json') continue;
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    }
  }

  function removeJob(id) {
    if (!isJobId(id)) return;
    fs.rmSync(jobDir(id), { recursive: true, force: true });
  }

  function listIds() {
    if (!fs.existsSync(jobRoot)) return [];
    return fs.readdirSync(jobRoot).filter(isJobId);
  }

  function listRecords() {
    return listIds().map(readRecord).filter(Boolean);
  }

  function oldestQueued() {
    return listRecords()
      .filter((job) => job.status === JOB_STATUS.QUEUED)
      .sort((a, b) => {
        const byTime = String(a.created_at).localeCompare(String(b.created_at));
        return byTime !== 0 ? byTime : String(a.id).localeCompare(String(b.id));
      })[0] || null;
  }

  function sweepRetention(nowDate = now()) {
    const nowMs = nowDate.getTime();
    const terminal = listRecords().filter((job) => TERMINAL.has(job.status));
    for (const job of terminal) {
      const stamp = Date.parse(job.completed_at || job.created_at);
      if (!Number.isFinite(stamp)) continue;
      if (nowMs - stamp >= config.ttlMs) {
        removeJob(job.id);
      }
    }
    const remaining = listRecords()
      .filter((job) => TERMINAL.has(job.status))
      .sort((a, b) => String(a.completed_at || a.created_at).localeCompare(String(b.completed_at || b.created_at)));
    while (remaining.length > config.maxTerminal) {
      const extra = remaining.shift();
      removeJob(extra.id);
    }
  }

  async function enqueue({ imageBuffer, filename = 'upload.jpg' } = {}) {
    if (!imageBuffer || !Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
      const err = new Error('missing image');
      err.upload = {
        status: 400,
        body: {
          ok: false,
          error: {
            code: V131_ERROR.MISSING_IMAGE,
            message: 'multipart field "image" is required (JPG or PNG).',
          },
        },
      };
      throw err;
    }
    ensureDir(jobRoot);
    sweepRetention();
    const id = randomUUID();
    const dir = ensureDir(jobDir(id));
    const sourceName = `source${imageExtension(filename, imageBuffer)}`;
    fs.writeFileSync(path.join(dir, sourceName), imageBuffer);
    const record = writeRecord({
      id,
      status: JOB_STATUS.QUEUED,
      created_at: now().toISOString(),
      started_at: null,
      completed_at: null,
      original_filename: path.basename(String(filename || 'upload.jpg')),
      source_filename: sourceName,
    });
    wake();
    return publicJob(record);
  }

  function get(id) {
    if (!isJobId(id)) return undefined;
    const record = readRecord(id);
    return record ? publicJob(record) : null;
  }

  function failInterrupted(record) {
    const failed = writeRecord({
      ...record,
      status: JOB_STATUS.FAILED,
      completed_at: now().toISOString(),
      error: interruptedError(),
    });
    removeSourceFiles(record.id);
    return failed;
  }

  /**
   * Conservative crash recovery: processing jobs are marked failed/retryable.
   * They are not retried automatically. Queued jobs are left queued.
   */
  function recoverInterrupted() {
    ensureDir(jobRoot);
    for (const id of listIds()) {
      const record = readRecord(id);
      if (!record) {
        removeJob(id);
        continue;
      }
      if (record.status === JOB_STATUS.PROCESSING) {
        failInterrupted(record);
      }
    }
    sweepRetention();
  }

  async function runJob(record) {
    const running = writeRecord({
      ...record,
      status: JOB_STATUS.PROCESSING,
      started_at: record.started_at || now().toISOString(),
    });
    const sourcePath = path.join(jobDir(running.id), running.source_filename || 'source.jpg');
    let result;
    try {
      if (!fs.existsSync(sourcePath)) {
        result = {
          status: 500,
          body: {
            ok: false,
            error: {
              code: V131_ERROR.PIPELINE_FAILED,
              message: 'Workout transcription failed.',
            },
          },
        };
      } else {
        const imageBuffer = fs.readFileSync(sourcePath);
        result = await transcribe({
          imageBuffer,
          filename: running.original_filename || running.source_filename,
        });
      }
    } catch (error) {
      console.error('[workout-v1.3.1 jobs]', error?.message || error);
      result = {
        status: 500,
        body: {
          ok: false,
          error: {
            code: V131_ERROR.PIPELINE_FAILED,
            message: 'Workout transcription failed.',
          },
        },
      };
    }

    const completedAt = now().toISOString();
    if (result?.body?.ok) {
      writeRecord({
        ...running,
        status: JOB_STATUS.COMPLETED,
        completed_at: completedAt,
        elapsed_ms: Number(result.body.elapsed_ms) || 0,
        candidate: result.body.candidate,
        review: result.body.review,
      });
    } else {
      writeRecord({
        ...running,
        status: JOB_STATUS.FAILED,
        completed_at: completedAt,
        error: sanitizeError(result?.body?.error),
      });
    }
    removeSourceFiles(running.id);
    sweepRetention();
  }

  async function processNext() {
    if (busy) return false;
    const queued = oldestQueued();
    if (!queued) return false;
    busy = true;
    try {
      await runJob(queued);
      return true;
    } finally {
      busy = false;
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      sleepResolve = resolve;
      sleepTimer = setTimeout(() => {
        sleepTimer = null;
        sleepResolve = null;
        resolve();
      }, ms);
    });
  }

  function wake() {
    if (sleepTimer) {
      clearTimeout(sleepTimer);
      sleepTimer = null;
    }
    if (sleepResolve) {
      const resolve = sleepResolve;
      sleepResolve = null;
      resolve();
    }
  }

  async function loop() {
    while (started) {
      let did = false;
      try {
        did = await processNext();
      } catch (error) {
        console.error('[workout-v1.3.1 jobs]', error?.message || error);
      }
      if (!started) break;
      if (!did) await sleep(config.pollMs);
    }
  }

  function start() {
    if (started) return;
    started = true;
    loopPromise = loop();
  }

  async function stop() {
    started = false;
    wake();
    if (loopPromise) {
      await loopPromise;
      loopPromise = null;
    }
  }

  return {
    config,
    jobRoot,
    enqueue,
    get,
    processNext,
    recoverInterrupted,
    sweepRetention,
    start,
    stop,
    isBusy: () => busy,
  };
}

let defaultService = null;

export function getDefaultV131JobService() {
  if (!defaultService) {
    defaultService = createV131JobService();
  }
  return defaultService;
}

export function resetDefaultV131JobServiceForTests() {
  defaultService = null;
}
