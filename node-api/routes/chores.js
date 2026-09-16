import express from 'express';
import { getClient, query } from '../db.js';
import { isUuid, normalizeChoreInput, rowToChore } from '../lib/chores.js';

const router = express.Router();

const COLUMNS = `id, title, assignee, every, unit, weekday, month_day, icon, day_specific,
  last_completed_on::text AS last_completed_on, completed_occurrences, created_at, updated_at`;

async function insertChore(executor, input) {
  if (input.id) {
    const result = await executor(
      `INSERT INTO chores (
         id, title, assignee, every, unit, weekday, month_day, icon, day_specific,
         last_completed_on, completed_occurrences, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, COALESCE($12::timestamp, NOW()))
       RETURNING ${COLUMNS}`,
      [
        input.id,
        input.title,
        input.assignee ?? '',
        input.every ?? 1,
        input.unit ?? 'days',
        input.weekday ?? 0,
        input.month_day ?? 1,
        input.icon ?? 'generic',
        input.day_specific ?? false,
        input.last_completed_on ?? null,
        JSON.stringify(input.completed_occurrences || {}),
        input.created_at || null,
      ],
    );
    return result.rows[0];
  }

  const result = await executor(
    `INSERT INTO chores (
       title, assignee, every, unit, weekday, month_day, icon, day_specific,
       last_completed_on, completed_occurrences, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, COALESCE($11::timestamp, NOW()))
     RETURNING ${COLUMNS}`,
    [
      input.title,
      input.assignee ?? '',
      input.every ?? 1,
      input.unit ?? 'days',
      input.weekday ?? 0,
      input.month_day ?? 1,
      input.icon ?? 'generic',
      input.day_specific ?? false,
      input.last_completed_on ?? null,
      JSON.stringify(input.completed_occurrences || {}),
      input.created_at || null,
    ],
  );
  return result.rows[0];
}

router.get('/', async (_req, res) => {
  try {
    const result = await query(`SELECT ${COLUMNS} FROM chores ORDER BY created_at ASC`);
    res.json(result.rows.map(rowToChore));
  } catch (error) {
    console.error('Error fetching chores:', error);
    res.status(500).json({ error: 'Failed to fetch chores', details: error.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid chore id' });
    const result = await query(`SELECT ${COLUMNS} FROM chores WHERE id = $1`, [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Chore not found' });
    res.json(rowToChore(result.rows[0]));
  } catch (error) {
    console.error('Error fetching chore:', error);
    res.status(500).json({ error: 'Failed to fetch chore', details: error.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const parsed = normalizeChoreInput(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const row = await insertChore(query, parsed.value);
    res.status(201).json(rowToChore(row));
  } catch (error) {
    console.error('Error creating chore:', error);
    res.status(500).json({ error: 'Failed to create chore', details: error.message });
  }
});

/** First-time lift from a browser's localStorage. No-ops if the table already has rows. */
router.post('/import', async (req, res) => {
  const items = Array.isArray(req.body?.chores) ? req.body.chores : null;
  if (!items) return res.status(400).json({ error: 'chores array is required' });

  const parsed = [];
  for (const item of items) {
    const next = normalizeChoreInput(item);
    if (next.error) return res.status(400).json({ error: next.error });
    parsed.push(next.value);
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE chores IN EXCLUSIVE MODE');
    const existing = await client.query(`SELECT ${COLUMNS} FROM chores ORDER BY created_at ASC`);
    if (existing.rows.length > 0) {
      await client.query('COMMIT');
      return res.json(existing.rows.map(rowToChore));
    }

    const inserted = [];
    for (const input of parsed) {
      inserted.push(await insertChore(client.query.bind(client), input));
    }
    await client.query('COMMIT');
    res.status(201).json(inserted.map(rowToChore));
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error importing chores:', error);
    res.status(500).json({ error: 'Failed to import chores', details: error.message });
  } finally {
    client.release();
  }
});

router.put('/:id', async (req, res) => {
  try {
    if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid chore id' });
    const parsed = normalizeChoreInput(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const input = parsed.value;
    const result = await query(
      `UPDATE chores SET
         title = $1, assignee = $2, every = $3, unit = $4, weekday = $5, month_day = $6,
         icon = $7, day_specific = $8, last_completed_on = $9, completed_occurrences = $10::jsonb
       WHERE id = $11
       RETURNING ${COLUMNS}`,
      [
        input.title,
        input.assignee ?? '',
        input.every ?? 1,
        input.unit ?? 'days',
        input.weekday ?? 0,
        input.month_day ?? 1,
        input.icon ?? 'generic',
        input.day_specific ?? false,
        input.last_completed_on ?? null,
        JSON.stringify(input.completed_occurrences || {}),
        req.params.id,
      ],
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Chore not found' });
    res.json(rowToChore(result.rows[0]));
  } catch (error) {
    console.error('Error updating chore:', error);
    res.status(500).json({ error: 'Failed to update chore', details: error.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid chore id' });
    const result = await query('DELETE FROM chores WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Chore not found' });
    res.json({ message: 'Chore deleted', id: result.rows[0].id });
  } catch (error) {
    console.error('Error deleting chore:', error);
    res.status(500).json({ error: 'Failed to delete chore', details: error.message });
  }
});

export default router;
