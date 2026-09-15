import express from 'express';
import { forceLatencyCheck, getLatencySnapshot } from '../lib/latency/index.js';

const router = express.Router();

router.get('/snapshot', (_req, res) => {
  res.json(getLatencySnapshot());
});

router.post('/check/:id', async (req, res) => {
  const id = typeof req.params.id === 'string' ? req.params.id : '';
  if (!id) {
    return res.status(400).json({ error: 'id is required' });
  }

  try {
    const result = await forceLatencyCheck(id);
    if (!result) {
      return res.status(404).json({ error: 'Unknown target' });
    }
    res.json(result);
  } catch (err) {
    console.error('[latency] force check failed:', err?.message || err);
    res.status(500).json({ error: 'Check failed' });
  }
});

export default router;
