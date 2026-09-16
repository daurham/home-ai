import express from 'express';
import {
  builtinTargets,
  forceLatencyCheck,
  getLatencySnapshot,
  reloadLatencyTargets,
} from '../lib/latency/index.js';
import { normalizeTarget } from '../lib/latency/targets.js';
import {
  deleteTargetRow,
  getTargetRow,
  insertTargetRow,
  listTargetRows,
  rowToApi,
  rowToTargetInput,
  slugifyId,
  uniqueId,
  updateTargetRow,
} from '../lib/latency/store.js';

const router = express.Router();

const PROBE_FIELDS = [
  'name',
  'type',
  'url',
  'method',
  'expectStatus',
  'expectBodyIncludes',
  'host',
  'port',
  'connectionStringEnv',
  'intervalMs',
  'timeoutMs',
  'degradedThresholdMs',
  'sampleCapacity',
];

function pickProbeFields(body) {
  const picked = {};
  for (const field of PROBE_FIELDS) {
    if (body?.[field] !== undefined) picked[field] = body[field];
  }
  return picked;
}

router.get('/snapshot', (_req, res) => {
  res.json(getLatencySnapshot());
});

/** Built-ins are returned too so the dashboard can show which rows it may edit. */
router.get('/targets', async (_req, res) => {
  try {
    const rows = await listTargetRows();
    res.json([
      ...builtinTargets().map((target) => ({ ...target, enabled: true, source: 'config' })),
      ...rows.map(rowToApi),
    ]);
  } catch (error) {
    console.error('[latency] failed to list targets:', error);
    res.status(500).json({ error: 'Failed to list latency targets', details: error.message });
  }
});

router.post('/targets', async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });

    const rows = await listTargetRows();
    const taken = new Set([...builtinTargets().map((target) => target.id), ...rows.map((row) => row.id)]);
    const id = uniqueId(slugifyId(req.body?.id || name), taken);

    const { target, error } = normalizeTarget({ ...pickProbeFields(req.body), id, name });
    if (error) return res.status(400).json({ error });

    const created = await insertTargetRow({ ...target, enabled: req.body?.enabled !== false });
    await reloadLatencyTargets();
    res.status(201).json(rowToApi(created));
  } catch (error) {
    console.error('[latency] failed to create target:', error);
    res.status(500).json({ error: 'Failed to create latency target', details: error.message });
  }
});

router.patch('/targets/:id', async (req, res) => {
  try {
    const existing = await getTargetRow(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Unknown target' });

    const merged = { ...rowToTargetInput(existing), ...pickProbeFields(req.body), id: existing.id };
    if (merged.name != null) merged.name = String(merged.name).trim();
    if (!merged.name) return res.status(400).json({ error: 'name is required' });

    // Switching type leaves fields from the old type behind; drop the ones that no longer apply.
    if (merged.type !== existing.type) {
      if (merged.type === 'tcp') {
        merged.url = undefined;
        merged.connectionStringEnv = undefined;
      } else if (merged.type === 'postgres') {
        merged.url = undefined;
        merged.host = undefined;
        merged.port = undefined;
      } else {
        merged.host = undefined;
        merged.port = undefined;
        merged.connectionStringEnv = undefined;
      }
    }

    const { target, error } = normalizeTarget(merged);
    if (error) return res.status(400).json({ error });

    const enabled = req.body?.enabled !== undefined ? Boolean(req.body.enabled) : existing.enabled;
    const updated = await updateTargetRow(existing.id, { ...target, enabled });
    await reloadLatencyTargets();
    res.json(rowToApi(updated));
  } catch (error) {
    console.error('[latency] failed to update target:', error);
    res.status(500).json({ error: 'Failed to update latency target', details: error.message });
  }
});

router.delete('/targets/:id', async (req, res) => {
  try {
    const deleted = await deleteTargetRow(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Unknown target' });
    await reloadLatencyTargets();
    res.json({ message: 'Target deleted', id: deleted.id });
  } catch (error) {
    console.error('[latency] failed to delete target:', error);
    res.status(500).json({ error: 'Failed to delete latency target', details: error.message });
  }
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
