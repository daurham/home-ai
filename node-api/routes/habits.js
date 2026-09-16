import express from 'express';
import { getClient, query } from '../db.js';
import { isUuid, normalizeHabitInput, rowToHabit } from '../lib/habits.js';

const router = express.Router();

const COLUMNS = `id, name, completions, created_at, updated_at`;

async function insertHabit(executor, input) {
  if (input.id) {
    const result = await executor(
      `INSERT INTO habits (id, name, completions, created_at)
       VALUES ($1, $2, $3::jsonb, COALESCE($4::timestamp, NOW()))
       RETURNING ${COLUMNS}`,
      [input.id, input.name, JSON.stringify(input.completions || {}), input.created_at || null],
    );
    return result.rows[0];
  }

  const result = await executor(
    `INSERT INTO habits (name, completions, created_at)
     VALUES ($1, $2::jsonb, COALESCE($3::timestamp, NOW()))
     RETURNING ${COLUMNS}`,
    [input.name, JSON.stringify(input.completions || {}), input.created_at || null],
  );
  return result.rows[0];
}

router.get('/', async (_req, res) => {
  try {
    const result = await query(`SELECT ${COLUMNS} FROM habits ORDER BY created_at ASC`);
    res.json(result.rows.map(rowToHabit));
  } catch (error) {
    console.error('Error fetching habits:', error);
    res.status(500).json({ error: 'Failed to fetch habits', details: error.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid habit id' });
    const result = await query(`SELECT ${COLUMNS} FROM habits WHERE id = $1`, [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Habit not found' });
    res.json(rowToHabit(result.rows[0]));
  } catch (error) {
    console.error('Error fetching habit:', error);
    res.status(500).json({ error: 'Failed to fetch habit', details: error.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const parsed = normalizeHabitInput(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const row = await insertHabit(query, parsed.value);
    res.status(201).json(rowToHabit(row));
  } catch (error) {
    console.error('Error creating habit:', error);
    res.status(500).json({ error: 'Failed to create habit', details: error.message });
  }
});

router.post('/import', async (req, res) => {
  const items = Array.isArray(req.body?.habits) ? req.body.habits : null;
  if (!items) return res.status(400).json({ error: 'habits array is required' });

  const parsed = [];
  for (const item of items) {
    const next = normalizeHabitInput(item);
    if (next.error) return res.status(400).json({ error: next.error });
    parsed.push(next.value);
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE habits IN EXCLUSIVE MODE');
    const existing = await client.query(`SELECT ${COLUMNS} FROM habits ORDER BY created_at ASC`);
    if (existing.rows.length > 0) {
      await client.query('COMMIT');
      return res.json(existing.rows.map(rowToHabit));
    }

    const inserted = [];
    for (const input of parsed) {
      inserted.push(await insertHabit(client.query.bind(client), input));
    }
    await client.query('COMMIT');
    res.status(201).json(inserted.map(rowToHabit));
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error importing habits:', error);
    res.status(500).json({ error: 'Failed to import habits', details: error.message });
  } finally {
    client.release();
  }
});

router.put('/:id', async (req, res) => {
  try {
    if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid habit id' });
    const parsed = normalizeHabitInput(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const result = await query(
      `UPDATE habits SET name = $1, completions = $2::jsonb WHERE id = $3 RETURNING ${COLUMNS}`,
      [parsed.value.name, JSON.stringify(parsed.value.completions || {}), req.params.id],
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Habit not found' });
    res.json(rowToHabit(result.rows[0]));
  } catch (error) {
    console.error('Error updating habit:', error);
    res.status(500).json({ error: 'Failed to update habit', details: error.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid habit id' });
    const result = await query('DELETE FROM habits WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Habit not found' });
    res.json({ message: 'Habit deleted', id: result.rows[0].id });
  } catch (error) {
    console.error('Error deleting habit:', error);
    res.status(500).json({ error: 'Failed to delete habit', details: error.message });
  }
});

export default router;
