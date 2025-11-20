import express from 'express';
import { query } from '../db.js';

const router = express.Router();

// Get all modules
router.get('/', async (req, res) => {
  try {
    const result = await query('SELECT * FROM modules ORDER BY created_at');
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching modules:', error);
    res.status(500).json({ error: 'Failed to fetch modules', details: error.message });
  }
});

// Get module by ID
router.get('/:id', async (req, res) => {
  try {
    const result = await query('SELECT * FROM modules WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Module not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching module:', error);
    res.status(500).json({ error: 'Failed to fetch module', details: error.message });
  }
});

// Get module by name
router.get('/name/:name', async (req, res) => {
  try {
    const result = await query('SELECT * FROM modules WHERE name = $1', [req.params.name]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Module not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching module by name:', error);
    res.status(500).json({ error: 'Failed to fetch module', details: error.message });
  }
});

// Create module
router.post('/', async (req, res) => {
  try {
    const { name, description, version, config_schema, data_schema } = req.body;
    const result = await query(
      'INSERT INTO modules (name, description, version, config_schema, data_schema) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [name, description, version || 1, JSON.stringify(config_schema || {}), JSON.stringify(data_schema || {})]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating module:', error);
    res.status(500).json({ error: 'Failed to create module', details: error.message });
  }
});

// Update module
router.put('/:id', async (req, res) => {
  try {
    const { description, version, config_schema, data_schema } = req.body;
    const updates = [];
    const values = [];
    let paramCount = 1;

    if (description !== undefined) {
      updates.push(`description = $${paramCount++}`);
      values.push(description);
    }
    if (version !== undefined) {
      updates.push(`version = $${paramCount++}`);
      values.push(version);
    }
    if (config_schema !== undefined) {
      updates.push(`config_schema = $${paramCount++}`);
      values.push(JSON.stringify(config_schema));
    }
    if (data_schema !== undefined) {
      updates.push(`data_schema = $${paramCount++}`);
      values.push(JSON.stringify(data_schema));
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(req.params.id);
    const result = await query(
      `UPDATE modules SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Module not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating module:', error);
    res.status(500).json({ error: 'Failed to update module', details: error.message });
  }
});

// Delete module
router.delete('/:id', async (req, res) => {
  try {
    const result = await query('DELETE FROM modules WHERE id = $1 RETURNING *', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Module not found' });
    }
    res.json({ message: 'Module deleted successfully', module: result.rows[0] });
  } catch (error) {
    console.error('Error deleting module:', error);
    res.status(500).json({ error: 'Failed to delete module', details: error.message });
  }
});

export default router;

