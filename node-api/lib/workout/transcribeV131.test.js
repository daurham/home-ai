import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  V131_ERROR,
  WORKOUT_V131_PIPELINE,
  transcribeWorkoutV131,
  v131UploadError,
} from './transcribeV131.js';

const CANDIDATE = {
  schema_version: '1.3',
  transcription_status: 'REVIEW_REQUIRED',
  ambiguities: [{ location: 'header.date', reason: 'PARTIAL' }],
  workout: {
    date: null,
    routine: 'B',
    template_version: 'B-1.3.1',
    exercises: [],
  },
};

const REVIEW_GATE = {
  review: {
    status: 'REVIEW_REQUIRED',
    issues: [{ code: 'PARTIAL_DATE', location: 'header.date' }],
  },
  schema: { valid: true },
  semantic: { valid: true, errors: [] },
  save: {
    schema_valid: true,
    semantic_valid: true,
    review_status: 'REVIEW_REQUIRED',
    save_ready: false,
    blocking_issues: ['PARTIAL_DATE'],
    non_blocking_issues: [],
  },
};

function jpegBuffer() {
  return Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
}

async function processSuccess(photo, { blindDir }) {
  const outDir = path.join(blindDir, photo.photo_id);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'canonical-candidate.json'), JSON.stringify(CANDIDATE));
  fs.writeFileSync(path.join(outDir, 'review-save-gate.json'), JSON.stringify(REVIEW_GATE));
  return {
    registration: { success: true, detected_ids: [10, 11, 12, 13], error: null },
    review_status: 'REVIEW_REQUIRED',
    save_ready: false,
    processing_time_ms: 42,
  };
}

describe('v1.3.1 HTTP upload mapping', () => {
  it('rejects a missing image', () => {
    const result = v131UploadError(null, null);
    assert.equal(result.status, 400);
    assert.equal(result.body.ok, false);
    assert.equal(result.body.error.code, V131_ERROR.MISSING_IMAGE);
  });

  it('rejects an unsupported upload', () => {
    const result = v131UploadError(new Error('Only JPG and PNG images are accepted'), null);
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, V131_ERROR.UNSUPPORTED_IMAGE);
  });

  it('rejects an oversized upload', () => {
    const err = new Error('File too large');
    err.code = 'LIMIT_FILE_SIZE';
    const result = v131UploadError(err, null);
    assert.equal(result.status, 413);
    assert.equal(result.body.error.code, V131_ERROR.UPLOAD_TOO_LARGE);
  });
});

describe('v1.3.1 HTTP pipeline wrapper', () => {
  it('maps a successful REVIEW_REQUIRED result to HTTP success', async () => {
    const result = await transcribeWorkoutV131({
      imageBuffer: jpegBuffer(),
      filename: 'sheet.jpg',
      processPhoto: processSuccess,
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.pipeline, WORKOUT_V131_PIPELINE);
    assert.equal(result.body.elapsed_ms, 42);
    assert.equal(result.body.candidate.transcription_status, 'REVIEW_REQUIRED');
    assert.equal(result.body.review.save_ready, false);
    assert.equal(result.body.review.review_status, 'REVIEW_REQUIRED');
    assert.deepEqual(result.body.review.blocking_issues, ['PARTIAL_DATE']);
    assert.equal(JSON.stringify(result.body).includes(os.tmpdir()), false);
  });

  it('maps a known registration failure to a structured error', async () => {
    const result = await transcribeWorkoutV131({
      imageBuffer: jpegBuffer(),
      processPhoto: async () => ({
        registration: {
          success: false,
          detected_ids: [10, 12, 13],
          error: 'required ArUco IDs 10/11/12/13 not all detected',
        },
        processing_time_ms: 9,
      }),
    });
    assert.equal(result.status, 422);
    assert.equal(result.body.ok, false);
    assert.equal(result.body.error.code, V131_ERROR.REGISTRATION_FAILED);
    assert.deepEqual(result.body.error.details.missing_markers, [11]);
    assert.deepEqual(result.body.error.details.detected_ids, [10, 12, 13]);
    assert.equal(JSON.stringify(result.body).includes('/home/'), false);
  });

  it('does not leak stack or filesystem paths from internal exceptions', async () => {
    const secret = `${os.tmpdir()}/secret-fixture.png`;
    const result = await transcribeWorkoutV131({
      imageBuffer: jpegBuffer(),
      processPhoto: async () => {
        const err = new Error(`ENOENT: no such file or directory, open '${secret}'`);
        err.stack = `${err.message}\n    at processBlindPhoto (${secret}:12:3)`;
        throw err;
      },
    });
    assert.equal(result.status, 500);
    assert.equal(result.body.ok, false);
    assert.equal(result.body.error.code, V131_ERROR.PIPELINE_FAILED);
    assert.equal(result.body.error.message, 'Workout transcription failed.');
    const serialized = JSON.stringify(result.body);
    assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes('ENOENT'), false);
    assert.equal(serialized.includes('processBlindPhoto'), false);
  });

  it('cleans the request working directory after success', async () => {
    const before = new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('workout-v131-')));
    await transcribeWorkoutV131({
      imageBuffer: jpegBuffer(),
      processPhoto: processSuccess,
    });
    const after = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('workout-v131-') && !before.has(name));
    assert.deepEqual(after, []);
  });
});
