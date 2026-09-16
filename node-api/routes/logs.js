import express from 'express';
import { query } from '../db.js';
import {
  isUuid,
  normalizeBookInput,
  normalizeEntryInput,
  rowToBook,
  rowToEntry,
} from '../lib/logs.js';

const router = express.Router();
const BOOK_COLUMNS = `id, name, slug, sort_order, body, created_at, updated_at`;
const ENTRY_COLUMNS = `id, book_id, occurred_on::text AS occurred_on, body, amount_cents, created_at, updated_at`;

async function uniqueSlug(base, excludeId = null) {
  let slug = base;
  let n = 2;
  while (true) {
    const existing = excludeId
      ? await query('SELECT id FROM log_books WHERE slug = $1 AND id <> $2', [slug, excludeId])
      : await query('SELECT id FROM log_books WHERE slug = $1', [slug]);
    if (existing.rows.length === 0) return slug;
    slug = `${base}-${n}`;
    n += 1;
  }
}

router.get('/books', async (_req, res) => {
  try {
    const result = await query(`SELECT ${BOOK_COLUMNS} FROM log_books ORDER BY sort_order ASC, created_at ASC`);
    res.json(result.rows.map(rowToBook));
  } catch (error) {
    console.error('Error listing log books:', error);
    res.status(500).json({ error: 'Failed to list logs', details: error.message });
  }
});

router.post('/books', async (req, res) => {
  try {
    const parsed = normalizeBookInput(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const slug = await uniqueSlug(parsed.value.slug);
    const maxSort = await query('SELECT COALESCE(MAX(sort_order), -1) AS max FROM log_books');
    const result = await query(
      `INSERT INTO log_books (name, slug, sort_order, body)
       VALUES ($1, $2, $3, $4)
       RETURNING ${BOOK_COLUMNS}`,
      [parsed.value.name, slug, Number(maxSort.rows[0].max) + 1, parsed.value.body ?? ''],
    );
    res.status(201).json(rowToBook(result.rows[0]));
  } catch (error) {
    console.error('Error creating log book:', error);
    res.status(500).json({ error: 'Failed to create log', details: error.message });
  }
});

router.patch('/books/:id', async (req, res) => {
  try {
    if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid log id' });
    const parsed = normalizeBookInput(req.body, { partial: true });
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const sets = [];
    const values = [];
    let i = 1;
    if (parsed.value.name) {
      const slug = await uniqueSlug(parsed.value.slug, req.params.id);
      sets.push(`name = $${i++}`, `slug = $${i++}`);
      values.push(parsed.value.name, slug);
    }
    if (parsed.value.body !== undefined) {
      sets.push(`body = $${i++}`);
      values.push(parsed.value.body);
    }
    values.push(req.params.id);
    const result = await query(
      `UPDATE log_books SET ${sets.join(', ')} WHERE id = $${i} RETURNING ${BOOK_COLUMNS}`,
      values,
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Log not found' });
    res.json(rowToBook(result.rows[0]));
  } catch (error) {
    console.error('Error renaming log book:', error);
    res.status(500).json({ error: 'Failed to rename log', details: error.message });
  }
});

router.delete('/books/:id', async (req, res) => {
  try {
    if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid log id' });
    const count = await query('SELECT COUNT(*)::int AS n FROM log_books');
    if (count.rows[0].n <= 1) {
      return res.status(400).json({ error: 'Keep at least one log' });
    }
    const result = await query(`DELETE FROM log_books WHERE id = $1 RETURNING id`, [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Log not found' });
    res.json({ message: 'Deleted', id: result.rows[0].id });
  } catch (error) {
    console.error('Error deleting log book:', error);
    res.status(500).json({ error: 'Failed to delete log', details: error.message });
  }
});

router.get('/books/:id/entries', async (req, res) => {
  try {
    if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid log id' });
    const book = await query('SELECT id FROM log_books WHERE id = $1', [req.params.id]);
    if (book.rows.length === 0) return res.status(404).json({ error: 'Log not found' });
    const result = await query(
      `SELECT ${ENTRY_COLUMNS} FROM log_entries
       WHERE book_id = $1
       ORDER BY occurred_on DESC, created_at DESC`,
      [req.params.id],
    );
    res.json(result.rows.map(rowToEntry));
  } catch (error) {
    console.error('Error listing log entries:', error);
    res.status(500).json({ error: 'Failed to list entries', details: error.message });
  }
});

router.post('/books/:id/entries', async (req, res) => {
  try {
    if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid log id' });
    const parsed = normalizeEntryInput(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const book = await query('SELECT id FROM log_books WHERE id = $1', [req.params.id]);
    if (book.rows.length === 0) return res.status(404).json({ error: 'Log not found' });
    const result = await query(
      `INSERT INTO log_entries (book_id, occurred_on, body, amount_cents)
       VALUES ($1, $2, $3, $4)
       RETURNING ${ENTRY_COLUMNS}`,
      [req.params.id, parsed.value.occurred_on, parsed.value.body, parsed.value.amount_cents ?? null],
    );
    res.status(201).json(rowToEntry(result.rows[0]));
  } catch (error) {
    console.error('Error creating log entry:', error);
    res.status(500).json({ error: 'Failed to add entry', details: error.message });
  }
});

router.patch('/entries/:id', async (req, res) => {
  try {
    if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid entry id' });
    const parsed = normalizeEntryInput(req.body, { partial: true });
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const fields = [];
    const values = [];
    let i = 1;
    for (const [column, value] of Object.entries(parsed.value)) {
      fields.push(`${column} = $${i}`);
      values.push(value);
      i += 1;
    }
    if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' });
    values.push(req.params.id);
    const result = await query(
      `UPDATE log_entries SET ${fields.join(', ')} WHERE id = $${i} RETURNING ${ENTRY_COLUMNS}`,
      values,
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Entry not found' });
    res.json(rowToEntry(result.rows[0]));
  } catch (error) {
    console.error('Error updating log entry:', error);
    res.status(500).json({ error: 'Failed to update entry', details: error.message });
  }
});

router.delete('/entries/:id', async (req, res) => {
  try {
    if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid entry id' });
    const result = await query('DELETE FROM log_entries WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Entry not found' });
    res.json({ message: 'Deleted', id: result.rows[0].id });
  } catch (error) {
    console.error('Error deleting log entry:', error);
    res.status(500).json({ error: 'Failed to delete entry', details: error.message });
  }
});

export default router;
