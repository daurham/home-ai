import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { createWorkoutsRouter } from '../../routes/workouts.js';
import { V131_ERROR } from './transcribeV131.js';
import {
  JOB_ID_RE,
  JOB_STATUS,
  V131_JOB_ERROR,
  createV131JobService,
  isJobId,
  jobStoreConfig,
} from './v131Jobs.js';

const CANDIDATE = {
  schema_version: '1.3',
  transcription_status: 'VALID',
  ambiguities: [],
  workout: {
    date: '2026-04-03',
    routine: 'C',
    template_version: 'C-1.3.1',
    exercises: [{ name: 'Squat', sets: [] }],
  },
};

const REVIEW = {
  status: 'AUTO_ACCEPT',
  issues: [],
  schema_valid: true,
  semantic_valid: true,
  review_status: 'AUTO_ACCEPT',
  save_ready: true,
  blocking_issues: [],
  non_blocking_issues: [],
};

function jpegBuffer() {
  return Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
}

function tmpJobDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'workout-v131-jobs-'));
}

function successTranscribe() {
  return {
    status: 200,
    body: {
      ok: true,
      pipeline: 'workout-v1.3.1',
      elapsed_ms: 284652,
      candidate: CANDIDATE,
      review: REVIEW,
    },
  };
}

function makeService(overrides = {}) {
  const jobDir = overrides.jobDir || tmpJobDir();
  const transcribe = overrides.transcribe || (async () => successTranscribe());
  const service = createV131JobService({
    jobDir,
    transcribe,
    now: overrides.now,
    config: { pollMs: 15, ttlMs: 48 * 60 * 60 * 1000, maxTerminal: 40, ...(overrides.config || {}) },
    env: overrides.env,
  });
  return { service, jobDir, transcribe };
}

async function waitFor(fn, timeoutMs = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for condition');
}

function buildMultipart({ filename, mime, buffer, fieldName = 'image' } = {}) {
  const boundary = '----v131jobtest';
  const chunks = [];
  if (buffer) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`,
    ));
    chunks.push(buffer);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat(chunks),
  };
}

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

function requestJson({ port, method, urlPath, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: {
        ...headers,
        ...(body ? { 'content-length': Buffer.byteLength(body) } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = raw ? JSON.parse(raw) : null;
        } catch {
          json = raw;
        }
        resolve({ status: res.statusCode, body: json, raw });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('v1.3.1 job store config', () => {
  it('keeps retention and directory policy in one place', () => {
    const cfg = jobStoreConfig({
      FILE_SHARE_DIR: '/data/file-share',
      WORKOUT_V131_JOB_TTL_MS: '3600000',
      WORKOUT_V131_JOB_MAX_TERMINAL: '7',
    });
    assert.equal(cfg.dir, path.join('/data/file-share', '.internal', 'workout-v1.3-jobs'));
    assert.equal(cfg.ttlMs, 3600000);
    assert.equal(cfg.maxTerminal, 7);
    assert.equal(cfg.dir.includes('file-share'), true);
    assert.equal(cfg.dir.startsWith('/data/file-share/.internal/'), true);
  });
});

describe('v1.3.1 job service', () => {
  it('creates a queued job with an opaque random id', async () => {
    const { service, jobDir } = makeService();
    const job = await service.enqueue({ imageBuffer: jpegBuffer(), filename: 'sheet.jpg' });
    assert.equal(job.status, JOB_STATUS.QUEUED);
    assert.equal(isJobId(job.id), true);
    assert.match(job.id, JOB_ID_RE);
    assert.equal(job.id.includes(path.sep), false);
    assert.equal(JSON.stringify(job).includes(jobDir), false);
    assert.equal(service.get(job.id).status, 'queued');
  });

  it('moves queued → processing → completed and keeps the Phase 6A candidate/review', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { service, jobDir } = makeService({
      transcribe: async () => {
        await gate;
        return successTranscribe();
      },
    });
    const job = await service.enqueue({ imageBuffer: jpegBuffer(), filename: 'IMG_1326.jpeg' });
    assert.equal(job.status, 'queued');
    const processed = service.processNext();
    await waitFor(() => service.get(job.id)?.status === 'processing');
    assert.equal(service.get(job.id).status, 'processing');
    release();
    await processed;
    const done = service.get(job.id);
    assert.equal(done.status, 'completed');
    assert.equal(done.elapsed_ms, 284652);
    assert.deepEqual(done.candidate, CANDIDATE);
    assert.deepEqual(done.review, REVIEW);
    assert.equal(done.candidate.workout.routine, 'C');
    assert.equal(done.review.save_ready, true);
    const leftover = fs.readdirSync(path.join(jobDir, job.id));
    assert.deepEqual(leftover, ['job.json']);
    const serialized = JSON.stringify(done);
    assert.equal(serialized.includes(jobDir), false);
    assert.equal(serialized.includes(os.tmpdir()), false);
  });

  it('records a pipeline failure as a failed job with the sanitized error', async () => {
    const secret = `${os.tmpdir()}/secret-fixture.png`;
    const { service } = makeService({
      transcribe: async () => {
        throw new Error(`ENOENT: no such file or directory, open '${secret}'`);
      },
    });
    const job = await service.enqueue({ imageBuffer: jpegBuffer(), filename: 'sheet.jpg' });
    await service.processNext();
    const failed = service.get(job.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error.code, V131_ERROR.PIPELINE_FAILED);
    assert.equal(failed.error.message, 'Workout transcription failed.');
    const serialized = JSON.stringify(failed);
    assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes('ENOENT'), false);
    assert.equal(serialized.includes('stack'), false);
  });

  it('maps structured pipeline errors onto failed jobs without leaking paths', async () => {
    const { service, jobDir } = makeService({
      transcribe: async () => ({
        status: 422,
        body: {
          ok: false,
          error: {
            code: V131_ERROR.REGISTRATION_FAILED,
            message: 'Could not register workout sheet.',
            details: { missing_markers: [11], detected_ids: [10, 12, 13] },
          },
        },
      }),
    });
    const job = await service.enqueue({ imageBuffer: jpegBuffer(), filename: 'sheet.jpg' });
    await service.processNext();
    const failed = service.get(job.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error.code, V131_ERROR.REGISTRATION_FAILED);
    assert.deepEqual(failed.error.details.missing_markers, [11]);
    assert.equal(JSON.stringify(failed).includes(jobDir), false);
  });

  it('only runs one transcription at a time and keeps the next job queued', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let releaseFirst;
    const firstGate = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const { service } = makeService({
      transcribe: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        if (inFlight === 1) await firstGate;
        inFlight -= 1;
        return successTranscribe();
      },
    });
    const first = await service.enqueue({ imageBuffer: jpegBuffer(), filename: 'a.jpg' });
    const second = await service.enqueue({ imageBuffer: jpegBuffer(), filename: 'b.jpg' });
    const running = service.processNext();
    await waitFor(() => service.get(first.id)?.status === 'processing');
    assert.equal(service.get(second.id).status, 'queued');
    assert.equal(maxInFlight, 1);
    const extras = await Promise.all([service.processNext(), service.processNext()]);
    assert.deepEqual(extras, [false, false]);
    assert.equal(service.get(second.id).status, 'queued');
    assert.equal(maxInFlight, 1);
    releaseFirst();
    await running;
    assert.equal(service.get(first.id).status, 'completed');
    assert.equal(service.get(second.id).status, 'queued');
    await service.processNext();
    assert.equal(service.get(second.id).status, 'completed');
    assert.equal(maxInFlight, 1);
  });

  it('start() drains queued jobs without overlapping transcription', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const { service } = makeService({
      transcribe: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight -= 1;
        return successTranscribe();
      },
    });
    const first = await service.enqueue({ imageBuffer: jpegBuffer(), filename: 'a.jpg' });
    const second = await service.enqueue({ imageBuffer: jpegBuffer(), filename: 'b.jpg' });
    service.start();
    try {
      await waitFor(
        () => service.get(first.id)?.status === 'completed'
          && service.get(second.id)?.status === 'completed',
        3000,
      );
      assert.equal(maxInFlight, 1);
    } finally {
      await service.stop();
    }
  });

  it('marks interrupted processing jobs failed and retryable without auto-retry', async () => {
    const jobDir = tmpJobDir();
    const id = randomUUID();
    const dir = path.join(jobDir, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'source.jpg'), jpegBuffer());
    fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({
      id,
      status: 'processing',
      created_at: '2026-09-20T00:00:00.000Z',
      started_at: '2026-09-20T00:00:01.000Z',
      completed_at: null,
      original_filename: 'sheet.jpg',
      source_filename: 'source.jpg',
    }));
    const queuedId = randomUUID();
    const queuedDir = path.join(jobDir, queuedId);
    fs.mkdirSync(queuedDir, { recursive: true });
    fs.writeFileSync(path.join(queuedDir, 'source.jpg'), jpegBuffer());
    fs.writeFileSync(path.join(queuedDir, 'job.json'), JSON.stringify({
      id: queuedId,
      status: 'queued',
      created_at: '2026-09-20T00:00:02.000Z',
      started_at: null,
      completed_at: null,
      original_filename: 'next.jpg',
      source_filename: 'source.jpg',
    }));
    let transcribed = 0;
    const { service } = makeService({
      jobDir,
      transcribe: async () => {
        transcribed += 1;
        return successTranscribe();
      },
    });
    service.recoverInterrupted();
    const recovered = service.get(id);
    assert.equal(recovered.status, 'failed');
    assert.equal(recovered.error.code, V131_JOB_ERROR.PIPELINE_INTERRUPTED);
    assert.equal(recovered.error.details.retryable, true);
    assert.equal(fs.existsSync(path.join(dir, 'source.jpg')), false);
    assert.equal(service.get(queuedId).status, 'queued');
    assert.equal(transcribed, 0);
  });

  it('removes old completed/failed jobs but not queued or processing ones', async () => {
    const now = new Date('2026-09-20T12:00:00.000Z');
    const { service, jobDir } = makeService({
      now: () => now,
      config: { ttlMs: 60 * 60 * 1000, maxTerminal: 50 },
    });
    const staleCompleted = randomUUID();
    const staleFailed = randomUUID();
    const freshCompleted = randomUUID();
    const queuedId = randomUUID();
    const processingId = randomUUID();
    function seed(id, status, completedAt) {
      const dir = path.join(jobDir, id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({
        id,
        status,
        created_at: '2026-09-18T00:00:00.000Z',
        started_at: '2026-09-18T00:00:01.000Z',
        completed_at: completedAt,
        original_filename: 'sheet.jpg',
        source_filename: 'source.jpg',
      }));
      fs.writeFileSync(path.join(dir, 'source.jpg'), jpegBuffer());
    }
    seed(staleCompleted, 'completed', '2026-09-20T10:00:00.000Z');
    seed(staleFailed, 'failed', '2026-09-20T09:00:00.000Z');
    seed(freshCompleted, 'completed', '2026-09-20T11:30:00.000Z');
    seed(queuedId, 'queued', null);
    seed(processingId, 'processing', null);
    service.sweepRetention();
    assert.equal(service.get(staleCompleted), null);
    assert.equal(service.get(staleFailed), null);
    assert.equal(service.get(freshCompleted).status, 'completed');
    assert.equal(service.get(queuedId).status, 'queued');
    assert.equal(service.get(processingId).status, 'processing');
    assert.equal(fs.existsSync(path.join(jobDir, queuedId, 'source.jpg')), true);
  });

  it('caps the number of terminal jobs even before TTL expiry', async () => {
    const now = new Date('2026-09-20T12:00:00.000Z');
    const { service, jobDir } = makeService({
      now: () => now,
      config: { ttlMs: 48 * 60 * 60 * 1000, maxTerminal: 2 },
    });
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    ids.forEach((id, index) => {
      const dir = path.join(jobDir, id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({
        id,
        status: 'completed',
        created_at: `2026-09-20T11:0${index}:00.000Z`,
        completed_at: `2026-09-20T11:0${index}:00.000Z`,
      }));
    });
    service.sweepRetention();
    const remaining = ids.map((id) => service.get(id)).filter(Boolean);
    assert.equal(remaining.length, 2);
    assert.equal(service.get(ids[0]), null);
  });
});

describe('v1.3.1 job HTTP boundary', () => {
  const servers = [];

  after(async () => {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  });

  async function startRouter(jobService, transcribeV131) {
    const app = express();
    app.use('/api/workouts', createWorkoutsRouter({
      jobServiceFactory: () => jobService,
      transcribeV131,
    }));
    const started = await listen(app);
    servers.push(started.server);
    return started.port;
  }

  it('accepts a valid image with 202 and an opaque job id without waiting for transcription', async () => {
    let transcribeCalls = 0;
    const { service } = makeService({
      transcribe: async () => {
        transcribeCalls += 1;
        await new Promise(() => {});
      },
    });
    const port = await startRouter(service);
    const multipart = buildMultipart({
      filename: 'sheet.jpg',
      mime: 'image/jpeg',
      buffer: jpegBuffer(),
    });
    const t0 = Date.now();
    const res = await requestJson({
      port,
      method: 'POST',
      urlPath: '/api/workouts/v1.3/jobs',
      headers: multipart.headers,
      body: multipart.body,
    });
    const elapsed = Date.now() - t0;
    assert.equal(res.status, 202);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.job.status, 'queued');
    assert.equal(isJobId(res.body.job.id), true);
    assert.equal(transcribeCalls, 0);
    assert.equal(elapsed < 1000, true);
    const peek = await requestJson({
      port,
      method: 'GET',
      urlPath: `/api/workouts/v1.3/jobs/${res.body.job.id}`,
    });
    assert.equal(peek.status, 200);
    assert.equal(peek.body.job.status, 'queued');
    assert.equal(transcribeCalls, 0);
  });

  it('rejects a missing image', async () => {
    const { service } = makeService();
    const port = await startRouter(service);
    const multipart = buildMultipart();
    const res = await requestJson({
      port,
      method: 'POST',
      urlPath: '/api/workouts/v1.3/jobs',
      headers: multipart.headers,
      body: multipart.body,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, V131_ERROR.MISSING_IMAGE);
  });

  it('rejects an unsupported image', async () => {
    const { service } = makeService();
    const port = await startRouter(service);
    const multipart = buildMultipart({
      filename: 'sheet.gif',
      mime: 'image/gif',
      buffer: Buffer.from('GIF89a'),
    });
    const res = await requestJson({
      port,
      method: 'POST',
      urlPath: '/api/workouts/v1.3/jobs',
      headers: multipart.headers,
      body: multipart.body,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, V131_ERROR.UNSUPPORTED_IMAGE);
  });

  it('rejects an oversized image', async () => {
    const { service } = makeService();
    const port = await startRouter(service);
    const multipart = buildMultipart({
      filename: 'huge.jpg',
      mime: 'image/jpeg',
      buffer: Buffer.alloc(12 * 1024 * 1024 + 1, 0xff),
    });
    const res = await requestJson({
      port,
      method: 'POST',
      urlPath: '/api/workouts/v1.3/jobs',
      headers: multipart.headers,
      body: multipart.body,
    });
    assert.equal(res.status, 413);
    assert.equal(res.body.error.code, V131_ERROR.UPLOAD_TOO_LARGE);
  });

  it('returns completed candidate/review through GET and does not start work on GET', async () => {
    let transcribeCalls = 0;
    const { service } = makeService({
      transcribe: async () => {
        transcribeCalls += 1;
        return successTranscribe();
      },
    });
    const port = await startRouter(service);
    const created = await service.enqueue({ imageBuffer: jpegBuffer(), filename: 'sheet.jpg' });
    const before = await requestJson({
      port,
      method: 'GET',
      urlPath: `/api/workouts/v1.3/jobs/${created.id}`,
    });
    assert.equal(before.status, 200);
    assert.equal(before.body.job.status, 'queued');
    assert.equal(transcribeCalls, 0);
    await service.processNext();
    const done = await requestJson({
      port,
      method: 'GET',
      urlPath: `/api/workouts/v1.3/jobs/${created.id}`,
    });
    assert.equal(done.status, 200);
    assert.equal(done.body.ok, true);
    assert.equal(done.body.job.status, 'completed');
    assert.deepEqual(done.body.job.candidate, CANDIDATE);
    assert.deepEqual(done.body.job.review, REVIEW);
    assert.equal(transcribeCalls, 1);
  });

  it('returns HTTP 200 for a failed job rather than 500', async () => {
    const { service } = makeService({
      transcribe: async () => ({
        status: 500,
        body: {
          ok: false,
          error: { code: V131_ERROR.PIPELINE_FAILED, message: 'Workout transcription failed.' },
        },
      }),
    });
    const port = await startRouter(service);
    const created = await service.enqueue({ imageBuffer: jpegBuffer(), filename: 'sheet.jpg' });
    await service.processNext();
    const res = await requestJson({
      port,
      method: 'GET',
      urlPath: `/api/workouts/v1.3/jobs/${created.id}`,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.job.status, 'failed');
    assert.equal(res.body.job.error.code, V131_ERROR.PIPELINE_FAILED);
  });

  it('rejects unknown and malformed job ids', async () => {
    const { service, jobDir } = makeService();
    const port = await startRouter(service);
    const unknown = await requestJson({
      port,
      method: 'GET',
      urlPath: `/api/workouts/v1.3/jobs/${randomUUID()}`,
    });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, V131_JOB_ERROR.JOB_NOT_FOUND);
    const malformed = await requestJson({
      port,
      method: 'GET',
      urlPath: '/api/workouts/v1.3/jobs/not-a-uuid',
    });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error.code, V131_JOB_ERROR.INVALID_JOB_ID);
    const slash = await requestJson({
      port,
      method: 'GET',
      urlPath: '/api/workouts/v1.3/jobs/..%2Fjob.json',
    });
    assert.equal(slash.status, 400);
    assert.equal(slash.body.error.code, V131_JOB_ERROR.INVALID_JOB_ID);
    const serialized = JSON.stringify(malformed.body) + JSON.stringify(slash.body);
    assert.equal(serialized.includes(jobDir), false);
    assert.equal(serialized.includes('job.json'), false);
  });
});
