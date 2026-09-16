import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import express from 'express';
import multer from 'multer';
import { connect, query } from '../db.js';
import {
  FILE_SHARE_LOCK_KEY,
  canAcceptUpload,
  contentDisposition,
  ensureStorageDir,
  isUuid,
  quotaBytes,
  rowToFile,
  sanitizeOriginalName,
  storedPath,
  usagePayload,
} from '../lib/fileShare.js';

const router = express.Router();
const COLUMNS = `id, original_name, stored_name, mime_type, size_bytes, created_at`;

async function usedBytes(executor = query) {
  const result = await executor('SELECT COALESCE(SUM(size_bytes), 0)::bigint AS used FROM shared_files');
  return Number(result.rows[0].used);
}

async function usage(executor = query) {
  const used = await usedBytes(executor);
  const quota = quotaBytes();
  return usagePayload(used, quota);
}

function quotaError(usageInfo, message) {
  return {
    error: message,
    ...usageInfo,
  };
}

router.get('/', async (_req, res) => {
  try {
    const [list, stats] = await Promise.all([
      query(`SELECT ${COLUMNS} FROM shared_files ORDER BY created_at DESC`),
      usage(),
    ]);
    res.json({
      files: list.rows.map(rowToFile),
      ...stats,
    });
  } catch (error) {
    console.error('Error listing shared files:', error);
    res.status(500).json({ error: 'Failed to list files', details: error.message });
  }
});

router.post('/', async (req, res) => {
  const dir = ensureStorageDir();
  const client = await connect();
  let storedName = null;
  let locked = false;

  try {
    await client.query('SELECT pg_advisory_lock($1)', [FILE_SHARE_LOCK_KEY]);
    locked = true;

    const stats = await usage((text, params) => client.query(text, params));
    if (stats.remainingBytes <= 0) {
      return res.status(413).json(quotaError(stats, 'File share is full. Delete a file to free space.'));
    }

    const headerBytes = Number(req.headers['content-length']);
    if (Number.isFinite(headerBytes) && headerBytes > stats.remainingBytes + 4096) {
      return res.status(413).json(quotaError(stats, 'This file does not fit in remaining space.'));
    }

    storedName = randomUUID();
    const upload = multer({
      storage: multer.diskStorage({
        destination: (_req, _file, cb) => cb(null, dir),
        filename: (_req, _file, cb) => cb(null, storedName),
      }),
      limits: { files: 1, fileSize: stats.remainingBytes },
    }).single('file');

    await new Promise((resolve, reject) => {
      upload(req, res, (err) => (err ? reject(err) : resolve()));
    });

    if (!req.file) {
      return res.status(400).json({ error: 'file is required' });
    }

    const incoming = req.file.size;
    const check = canAcceptUpload(stats.usedBytes, incoming, stats.quotaBytes);
    if (!check.ok) {
      await fsp.unlink(req.file.path).catch(() => {});
      storedName = null;
      const status = check.code === 'empty' ? 400 : 413;
      const message =
        check.code === 'empty'
          ? 'Empty files are not stored.'
          : 'This file does not fit in remaining space.';
      return res.status(status).json(quotaError({ ...stats, remainingBytes: check.remaining }, message));
    }

    const originalName = sanitizeOriginalName(req.file.originalname);
    const mimeType = req.file.mimetype || 'application/octet-stream';
    const result = await client.query(
      `INSERT INTO shared_files (original_name, stored_name, mime_type, size_bytes)
       VALUES ($1, $2, $3, $4)
       RETURNING ${COLUMNS}`,
      [originalName, storedName, mimeType, incoming],
    );

    const nextUsage = usagePayload(stats.usedBytes + incoming, stats.quotaBytes);
    res.status(201).json({ file: rowToFile(result.rows[0]), ...nextUsage });
  } catch (error) {
    if (storedName) {
      await fsp.unlink(storedPath(storedName, dir)).catch(() => {});
    }
    if (error?.code === 'LIMIT_FILE_SIZE') {
      const stats = await usage().catch(() => usagePayload(0, quotaBytes()));
      return res.status(413).json(quotaError(stats, 'This file does not fit in remaining space.'));
    }
    console.error('Error uploading shared file:', error);
    res.status(500).json({ error: 'Failed to upload file', details: error.message });
  } finally {
    try {
      if (locked) await client.query('SELECT pg_advisory_unlock($1)', [FILE_SHARE_LOCK_KEY]);
    } finally {
      client.release();
    }
  }
});

router.get('/:id/download', async (req, res) => {
  try {
    if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid file id' });
    const result = await query(`SELECT ${COLUMNS} FROM shared_files WHERE id = $1`, [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'File not found' });

    const row = result.rows[0];
    const filePath = storedPath(row.stored_name);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing from disk' });

    res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
    res.setHeader('Content-Length', String(row.size_bytes));
    res.setHeader('Content-Disposition', contentDisposition(row.original_name));
    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    console.error('Error downloading shared file:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to download file', details: error.message });
    }
  }
});

router.delete('/:id', async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid file id' });
  const client = await connect();
  let locked = false;
  try {
    await client.query('SELECT pg_advisory_lock($1)', [FILE_SHARE_LOCK_KEY]);
    locked = true;
    const result = await client.query(`DELETE FROM shared_files WHERE id = $1 RETURNING ${COLUMNS}`, [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'File not found' });

    const row = result.rows[0];
    await fsp.unlink(storedPath(row.stored_name)).catch(() => {});
    const stats = await usage((text, params) => client.query(text, params));
    res.json({ message: 'Deleted', id: row.id, ...stats });
  } catch (error) {
    console.error('Error deleting shared file:', error);
    res.status(500).json({ error: 'Failed to delete file', details: error.message });
  } finally {
    try {
      if (locked) await client.query('SELECT pg_advisory_unlock($1)', [FILE_SHARE_LOCK_KEY]);
    } finally {
      client.release();
    }
  }
});

export default router;
