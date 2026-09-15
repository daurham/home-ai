import express from 'express';
import { query } from '../db.js';

const router = express.Router();

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const MAX_NAME = 40;

function isUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalizeColor(color) {
  if (!color) return '#8E8B86';
  const value = String(color).trim();
  if (!HEX_RE.test(value)) return null;
  if (value.length === 4) {
    return `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`.toUpperCase();
  }
  return value.toUpperCase();
}

router.get('/', async (req, res) => {
  try {
    const includeArchived = req.query.includeArchived === 'true';
    const result = await query(
      `SELECT id, name, color, sort_order, archived_at, created_at, updated_at
       FROM expense_categories
       ${includeArchived ? '' : 'WHERE archived_at IS NULL'}
       ORDER BY sort_order ASC, name ASC`
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching expense categories:', error);
    res.status(500).json({ error: 'Failed to fetch expense categories', details: error.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (name.length > MAX_NAME) return res.status(400).json({ error: `name must be at most ${MAX_NAME} characters` });

    const color = normalizeColor(req.body.color);
    if (!color) return res.status(400).json({ error: 'color must be a hex value like #8A9A7B' });

    const maxOrder = await query(
      'SELECT COALESCE(MAX(sort_order), 0) AS max FROM expense_categories'
    );
    const sortOrder = req.body.sort_order != null
      ? Number(req.body.sort_order)
      : maxOrder.rows[0].max + 1;

    const result = await query(
      `INSERT INTO expense_categories (name, color, sort_order)
       VALUES ($1, $2, $3)
       RETURNING id, name, color, sort_order, archived_at, created_at, updated_at`,
      [name, color, sortOrder]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'A category with that name already exists' });
    }
    console.error('Error creating expense category:', error);
    res.status(500).json({ error: 'Failed to create expense category', details: error.message });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(400).json({ error: 'Invalid category id' });
    }

    const existing = await query('SELECT * FROM expense_categories WHERE id = $1', [req.params.id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Category not found' });
    }

    const updates = [];
    const values = [];
    let paramCount = 1;
    const body = req.body;

    if (body.name !== undefined) {
      const name = String(body.name || '').trim();
      if (!name) return res.status(400).json({ error: 'name is required' });
      if (name.length > MAX_NAME) return res.status(400).json({ error: `name must be at most ${MAX_NAME} characters` });
      updates.push(`name = $${paramCount++}`);
      values.push(name);
    }

    if (body.color !== undefined) {
      const color = normalizeColor(body.color);
      if (!color) return res.status(400).json({ error: 'color must be a hex value like #8A9A7B' });
      updates.push(`color = $${paramCount++}`);
      values.push(color);
    }

    if (body.sort_order !== undefined) {
      const sortOrder = Number(body.sort_order);
      if (!Number.isInteger(sortOrder)) {
        return res.status(400).json({ error: 'sort_order must be an integer' });
      }
      updates.push(`sort_order = $${paramCount++}`);
      values.push(sortOrder);
    }

    if (body.archived === true || body.archived_at === true) {
      updates.push('archived_at = COALESCE(archived_at, NOW())');
    } else if (body.archived === false || body.archived_at === null) {
      updates.push('archived_at = NULL');
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(req.params.id);
    const result = await query(
      `UPDATE expense_categories SET ${updates.join(', ')}
       WHERE id = $${paramCount}
       RETURNING id, name, color, sort_order, archived_at, created_at, updated_at`,
      values
    );
    res.json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'A category with that name already exists' });
    }
    console.error('Error updating expense category:', error);
    res.status(500).json({ error: 'Failed to update expense category', details: error.message });
  }
});

export default router;
