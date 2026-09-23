import express from 'express';
import multer from 'multer';
import { ollamaBaseUrl, ollamaModel } from '../lib/workout/config.js';
import { visionDebugImage } from '../lib/workout/ollama.js';
import { transcribePoc2 } from '../lib/workout/poc2.js';
import { transcribePoc3 } from '../lib/workout/poc3.js';
import { candidateCatalog, formatShootoutReport, transcribePoc4 } from '../lib/workout/poc4.js';
import { transcribeWorkoutSheet } from '../lib/workout/transcribe.js';
import {
  V131_REQUEST_TIMEOUT_MS,
  transcribeWorkoutV131,
  v131UploadError,
} from '../lib/workout/transcribeV131.js';
import {
  getDefaultV131JobService,
  isJobId,
} from '../lib/workout/v131Jobs.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = file.mimetype === 'image/jpeg' || file.mimetype === 'image/png';
    cb(ok ? null : new Error('Only JPG and PNG images are accepted'), ok);
  },
});

function optionalModel(req) {
  return typeof req.body?.model === 'string' && req.body.model.trim()
    ? req.body.model.trim()
    : undefined;
}

function withImage(handler) {
  return (req, res) => {
    upload.single('image')(req, res, async (err) => {
      if (err) {
        const status = err.message?.includes('JPG') ? 400 : 413;
        return res.status(status).json({ error: err.message });
      }
      if (!req.file) {
        return res.status(400).json({ error: 'multipart field "image" is required (JPG or PNG)' });
      }
      try {
        const result = await handler(req);
        res.json(result);
      } catch (error) {
        console.error('Workout Ollama error:', error);
        const status = error.status || 502;
        res.status(status).json({
          error: 'Workout vision request failed',
          details: error.message,
        });
      }
    });
  };
}

export function createWorkoutsRouter({
  transcribeV131 = transcribeWorkoutV131,
  jobServiceFactory = getDefaultV131JobService,
} = {}) {
  const router = express.Router();

  router.get('/meta', (_req, res) => {
    res.json({
      model: ollamaModel(),
      ollamaBaseUrl: ollamaBaseUrl(),
    });
  });

  router.post('/transcribe', withImage((req) => transcribeWorkoutSheet({
    imageBuffer: req.file.buffer,
    model: optionalModel(req),
  })));

  router.post('/v1.3/transcribe', (req, res) => {
    req.setTimeout(V131_REQUEST_TIMEOUT_MS);
    res.setTimeout(V131_REQUEST_TIMEOUT_MS);
    upload.single('image')(req, res, async (err) => {
      const uploadError = v131UploadError(err, req.file);
      if (uploadError) {
        return res.status(uploadError.status).json(uploadError.body);
      }
      try {
        const result = await transcribeV131({
          imageBuffer: req.file.buffer,
          filename: req.file.originalname,
        });
        return res.status(result.status).json(result.body);
      } catch (error) {
        console.error('workout-v1.3.1', error?.message || error);
        return res.status(500).json({
          ok: false,
          error: {
            code: 'PIPELINE_FAILED',
            message: 'Workout transcription failed.',
          },
        });
      }
    });
  });

  router.post('/v1.3/jobs', (req, res) => {
    upload.single('image')(req, res, async (err) => {
      const uploadError = v131UploadError(err, req.file);
      if (uploadError) {
        return res.status(uploadError.status).json(uploadError.body);
      }
      try {
        const job = await jobServiceFactory().enqueue({
          imageBuffer: req.file.buffer,
          filename: req.file.originalname,
        });
        return res.status(202).json({
          ok: true,
          job: {
            id: job.id,
            status: job.status,
          },
        });
      } catch (error) {
        console.error('workout-v1.3.1 jobs', error?.message || error);
        return res.status(500).json({
          ok: false,
          error: {
            code: 'PIPELINE_FAILED',
            message: 'Workout transcription failed.',
          },
        });
      }
    });
  });

  router.get('/v1.3/jobs/:id', (req, res) => {
    const id = String(req.params.id || '');
    if (!isJobId(id)) {
      return res.status(400).json({
        ok: false,
        error: {
          code: 'INVALID_JOB_ID',
          message: 'Job id is invalid.',
        },
      });
    }
    const job = jobServiceFactory().get(id);
    if (!job) {
      return res.status(404).json({
        ok: false,
        error: {
          code: 'JOB_NOT_FOUND',
          message: 'Job not found.',
        },
      });
    }
    return res.status(200).json({ ok: true, job });
  });

  router.post('/poc2', withImage((req) => transcribePoc2({
    imageBuffer: req.file.buffer,
    model: optionalModel(req),
    variant: req.body?.variant === 'crops' ? 'crops' : 'whole-page',
  })));

  router.post('/poc3', withImage((req) => transcribePoc3({
    imageBuffer: req.file.buffer,
    model: optionalModel(req),
  })));

  router.get('/poc4/candidates', (_req, res) => {
    res.json(candidateCatalog());
  });

  router.post('/poc4', withImage(async (req) => {
    const result = await transcribePoc4({
      imageBuffer: req.file.buffer,
      model: optionalModel(req),
    });
    return {
      ...result,
      report: formatShootoutReport(result),
    };
  }));

  router.post('/vision-debug', withImage((req) => visionDebugImage({
    imageBuffer: req.file.buffer,
    model: optionalModel(req),
  })));

  return router;
}

const router = createWorkoutsRouter();
export default router;
