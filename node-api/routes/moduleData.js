import express from 'express';
import { query } from '../db.js';

const router = express.Router();

// Get all data records for a module instance
router.get('/instance/:instanceId', async (req, res) => {
  try {
    const result = await query(
      'SELECT * FROM module_data_records WHERE module_instance_id = $1 ORDER BY created_at',
      [req.params.instanceId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching module data records:', error);
    res.status(500).json({ error: 'Failed to fetch module data records', details: error.message });
  }
});

// Get single data record by ID
router.get('/:id', async (req, res) => {
  try {
    const result = await query('SELECT * FROM module_data_records WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Module data record not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching module data record:', error);
    res.status(500).json({ error: 'Failed to fetch module data record', details: error.message });
  }
});

// Get or create data record for a module instance (most modules have one data record per instance)
router.get('/instance/:instanceId/single', async (req, res) => {
  try {
    const result = await query(
      'SELECT * FROM module_data_records WHERE module_instance_id = $1 ORDER BY created_at LIMIT 1',
      [req.params.instanceId]
    );
    
    if (result.rows.length === 0) {
      // Create a default empty data record
      const createResult = await query(
        'INSERT INTO module_data_records (module_instance_id, data) VALUES ($1, $2) RETURNING *',
        [req.params.instanceId, JSON.stringify({})]
      );
      return res.json(createResult.rows[0]);
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching/creating module data record:', error);
    res.status(500).json({ error: 'Failed to fetch/create module data record', details: error.message });
  }
});

// Create module data record
router.post('/', async (req, res) => {
  try {
    const { module_instance_id, data } = req.body;
    
    if (!module_instance_id) {
      return res.status(400).json({ error: 'module_instance_id is required' });
    }

    const result = await query(
      'INSERT INTO module_data_records (module_instance_id, data) VALUES ($1, $2) RETURNING *',
      [module_instance_id, JSON.stringify(data || {})]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating module data record:', error);
    res.status(500).json({ error: 'Failed to create module data record', details: error.message });
  }
});

// Update module data record (full replacement)
router.put('/:id', async (req, res) => {
  try {
    const { data } = req.body;
    
    if (data === undefined) {
      return res.status(400).json({ error: 'data is required' });
    }

    const result = await query(
      'UPDATE module_data_records SET data = $1 WHERE id = $2 RETURNING *',
      [JSON.stringify(data), req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Module data record not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating module data record:', error);
    res.status(500).json({ error: 'Failed to update module data record', details: error.message });
  }
});

// Patch module data record (partial update using JSONB operations)
router.patch('/:id', async (req, res) => {
  try {
    const { path, value } = req.body; // e.g., path: ['transactions', '0', 'amount'], value: 100
    
    if (!path || value === undefined) {
      return res.status(400).json({ error: 'path and value are required' });
    }

    // Build JSONB path string
    const jsonbPath = '{' + path.join(',') + '}';
    
    const result = await query(
      `UPDATE module_data_records 
       SET data = jsonb_set(data, $1, $2::jsonb, true) 
       WHERE id = $3 
       RETURNING *`,
      [jsonbPath, JSON.stringify(value), req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Module data record not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error patching module data record:', error);
    res.status(500).json({ error: 'Failed to patch module data record', details: error.message });
  }
});

// Delete module data record
router.delete('/:id', async (req, res) => {
  try {
    const result = await query('DELETE FROM module_data_records WHERE id = $1 RETURNING *', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Module data record not found' });
    }
    res.json({ message: 'Module data record deleted successfully', record: result.rows[0] });
  } catch (error) {
    console.error('Error deleting module data record:', error);
    res.status(500).json({ error: 'Failed to delete module data record', details: error.message });
  }
});

export default router;

