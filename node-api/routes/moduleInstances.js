import express from 'express';
import { query } from '../db.js';

const router = express.Router();

// Get all module instances
router.get('/', async (req, res) => {
  try {
    const result = await query(
      `SELECT mi.*, m.name as module_name, m.description as module_description 
       FROM module_instances mi 
       JOIN modules m ON mi.module_id = m.id 
       ORDER BY mi.created_at`
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching module instances:', error);
    res.status(500).json({ error: 'Failed to fetch module instances', details: error.message });
  }
});

// Get module instance by ID
router.get('/:id', async (req, res) => {
  try {
    const result = await query(
      `SELECT mi.*, m.name as module_name, m.description as module_description 
       FROM module_instances mi 
       JOIN modules m ON mi.module_id = m.id 
       WHERE mi.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Module instance not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching module instance:', error);
    res.status(500).json({ error: 'Failed to fetch module instance', details: error.message });
  }
});

// Get module instances by module name
router.get('/module/:moduleName', async (req, res) => {
  try {
    const result = await query(
      `SELECT mi.*, m.name as module_name 
       FROM module_instances mi 
       JOIN modules m ON mi.module_id = m.id 
       WHERE m.name = $1 
       ORDER BY mi.created_at`,
      [req.params.moduleName]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching module instances by module name:', error);
    res.status(500).json({ error: 'Failed to fetch module instances', details: error.message });
  }
});

// Create module instance
router.post('/', async (req, res) => {
  try {
    const { module_id, layout, settings } = req.body;
    
    if (!module_id) {
      return res.status(400).json({ error: 'module_id is required' });
    }

    const result = await query(
      'INSERT INTO module_instances (module_id, layout, settings) VALUES ($1, $2, $3) RETURNING *',
      [module_id, JSON.stringify(layout || {}), JSON.stringify(settings || {})]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating module instance:', error);
    res.status(500).json({ error: 'Failed to create module instance', details: error.message });
  }
});

// Update module instance
router.put('/:id', async (req, res) => {
  try {
    const { layout, settings } = req.body;
    const updates = [];
    const values = [];
    let paramCount = 1;

    if (layout !== undefined) {
      updates.push(`layout = $${paramCount++}`);
      values.push(JSON.stringify(layout));
    }
    if (settings !== undefined) {
      updates.push(`settings = $${paramCount++}`);
      values.push(JSON.stringify(settings));
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(req.params.id);
    const result = await query(
      `UPDATE module_instances SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Module instance not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating module instance:', error);
    res.status(500).json({ error: 'Failed to update module instance', details: error.message });
  }
});

// Delete module instance
router.delete('/:id', async (req, res) => {
  try {
    const result = await query('DELETE FROM module_instances WHERE id = $1 RETURNING *', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Module instance not found' });
    }
    res.json({ message: 'Module instance deleted successfully', instance: result.rows[0] });
  } catch (error) {
    console.error('Error deleting module instance:', error);
    res.status(500).json({ error: 'Failed to delete module instance', details: error.message });
  }
});

export default router;

