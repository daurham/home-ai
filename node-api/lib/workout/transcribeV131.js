import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { processBlindPhoto } from './poc11.js';

export const WORKOUT_V131_PIPELINE = 'workout-v1.3.1';
export const REQUIRED_ARUCO_IDS = [10, 11, 12, 13];
export const V131_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

export const V131_ERROR = {
  MISSING_IMAGE: 'MISSING_IMAGE',
  UNSUPPORTED_IMAGE: 'UNSUPPORTED_IMAGE',
  UPLOAD_TOO_LARGE: 'UPLOAD_TOO_LARGE',
  INVALID_IMAGE: 'INVALID_IMAGE',
  REGISTRATION_FAILED: 'REGISTRATION_FAILED',
  PIPELINE_FAILED: 'PIPELINE_FAILED',
};

function errorBody(code, message, details) {
  const error = { code, message };
  if (details && Object.keys(details).length > 0) {
    error.details = details;
  }
  return { ok: false, error };
}

export function missingArucoIds(detectedIds = []) {
  const found = new Set(detectedIds);
  return REQUIRED_ARUCO_IDS.filter((id) => !found.has(id));
}

export function v131UploadError(multerError, file) {
  if (multerError) {
    if (multerError.code === 'LIMIT_FILE_SIZE') {
      return {
        status: 413,
        body: errorBody(V131_ERROR.UPLOAD_TOO_LARGE, 'Image is too large.'),
      };
    }
    const message = String(multerError.message || '');
    if (message.includes('JPG') || message.includes('PNG')) {
      return {
        status: 400,
        body: errorBody(V131_ERROR.UNSUPPORTED_IMAGE, 'Only JPG and PNG images are accepted.'),
      };
    }
    return {
      status: 400,
      body: errorBody(V131_ERROR.INVALID_IMAGE, 'Could not read uploaded image.'),
    };
  }
  if (!file?.buffer?.length) {
    return {
      status: 400,
      body: errorBody(
        V131_ERROR.MISSING_IMAGE,
        'multipart field "image" is required (JPG or PNG).',
      ),
    };
  }
  return null;
}

function imageExtension(filename, buffer) {
  const name = String(filename || '').toLowerCase();
  if (name.endsWith('.png')) return '.png';
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return '.jpg';
  if (buffer?.[0] === 0x89 && buffer?.[1] === 0x50) return '.png';
  return '.jpg';
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function reviewPayload(gate, record) {
  const review = gate?.review || {};
  const save = gate?.save || {};
  return {
    status: review.status || record.review_status || null,
    issues: Array.isArray(review.issues) ? review.issues : [],
    schema_valid: Boolean(save.schema_valid ?? record.schema_valid),
    semantic_valid: Boolean(save.semantic_valid ?? record.semantic_valid),
    review_status: save.review_status || record.review_status || null,
    save_ready: Boolean(save.save_ready ?? record.save_ready),
    blocking_issues: save.blocking_issues || record.blocking_issues || [],
    non_blocking_issues: save.non_blocking_issues || record.non_blocking_issues || [],
  };
}

function looksLikeInvalidImage(error) {
  const message = String(error?.message || error || '');
  return /unsupported image|input buffer|corrupt|invalid image|unsupported format/i.test(message);
}

/**
 * Run the frozen v1.3.1 pipeline on an uploaded image buffer.
 * `processPhoto` is injectable so HTTP contract tests do not invoke Granite.
 */
export async function transcribeWorkoutV131({
  imageBuffer,
  filename = 'upload.jpg',
  processPhoto = processBlindPhoto,
} = {}) {
  if (!imageBuffer || !Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    return {
      status: 400,
      body: errorBody(
        V131_ERROR.MISSING_IMAGE,
        'multipart field "image" is required (JPG or PNG).',
      ),
    };
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workout-v131-'));
  const photoId = `upload-${randomUUID()}`;
  const imagePath = path.join(workDir, `source${imageExtension(filename, imageBuffer)}`);

  try {
    fs.writeFileSync(imagePath, imageBuffer);
    const photo = {
      photo_id: photoId,
      filename: path.basename(String(filename || 'upload.jpg')),
      image_path: imagePath,
      fileshare_id: null,
      sha256: createHash('sha256').update(imageBuffer).digest('hex'),
    };
    const record = await processPhoto(photo, { blindDir: workDir });

    if (!record?.registration?.success) {
      const detectedIds = record?.registration?.detected_ids || [];
      return {
        status: 422,
        body: errorBody(
          V131_ERROR.REGISTRATION_FAILED,
          'Could not register workout sheet.',
          {
            missing_markers: missingArucoIds(detectedIds),
            detected_ids: detectedIds,
          },
        ),
      };
    }

    const outDir = path.join(workDir, photoId);
    const candidate = readJsonIfExists(path.join(outDir, 'canonical-candidate.json'));
    const gate = readJsonIfExists(path.join(outDir, 'review-save-gate.json'));
    if (!candidate || !gate) {
      console.error('workout-v1.3.1 missing candidate or review artifacts');
      return {
        status: 500,
        body: errorBody(V131_ERROR.PIPELINE_FAILED, 'Workout transcription failed.'),
      };
    }

    return {
      status: 200,
      body: {
        ok: true,
        pipeline: WORKOUT_V131_PIPELINE,
        elapsed_ms: Number(record.processing_time_ms) || 0,
        candidate,
        review: reviewPayload(gate, record),
      },
    };
  } catch (error) {
    console.error('workout-v1.3.1', error?.message || error);
    if (looksLikeInvalidImage(error)) {
      return {
        status: 400,
        body: errorBody(V131_ERROR.INVALID_IMAGE, 'Could not read uploaded image.'),
      };
    }
    return {
      status: 500,
      body: errorBody(V131_ERROR.PIPELINE_FAILED, 'Workout transcription failed.'),
    };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
