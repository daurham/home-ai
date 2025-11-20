import express from 'express';
import { query } from '../db.js';

const router = express.Router();

// Get all calendar events
router.get('/', async (req, res) => {
  try {
    const result = await query('SELECT * FROM calendar_events ORDER BY start_time');
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching calendar events:', error);
    res.status(500).json({ error: 'Failed to fetch calendar events', details: error.message });
  }
});

// Get calendar events for a date range
router.get('/range', async (req, res) => {
  try {
    const { start, end } = req.query;
    
    if (!start || !end) {
      return res.status(400).json({ error: 'start and end query parameters are required (ISO timestamp format)' });
    }

    const result = await query(
      'SELECT * FROM calendar_events WHERE start_time >= $1 AND (end_time IS NULL OR end_time <= $2) ORDER BY start_time',
      [start, end]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching calendar events by range:', error);
    res.status(500).json({ error: 'Failed to fetch calendar events', details: error.message });
  }
});

// Get calendar events for this week
router.get('/week', async (req, res) => {
  try {
    const now = new Date();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay()); // Sunday
    startOfWeek.setHours(0, 0, 0, 0);
    
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 7);
    endOfWeek.setHours(23, 59, 59, 999);

    const result = await query(
      'SELECT * FROM calendar_events WHERE start_time >= $1 AND start_time <= $2 ORDER BY start_time',
      [startOfWeek.toISOString(), endOfWeek.toISOString()]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching calendar events for week:', error);
    res.status(500).json({ error: 'Failed to fetch calendar events', details: error.message });
  }
});

// Get calendar event by ID
router.get('/:id', async (req, res) => {
  try {
    const result = await query('SELECT * FROM calendar_events WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Calendar event not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching calendar event:', error);
    res.status(500).json({ error: 'Failed to fetch calendar event', details: error.message });
  }
});

// Create calendar event
router.post('/', async (req, res) => {
  try {
    const { module_instance_id, title, description, start_time, end_time, recurrence_rule, metadata } = req.body;
    
    if (!title || !start_time) {
      return res.status(400).json({ error: 'title and start_time are required' });
    }

    const result = await query(
      'INSERT INTO calendar_events (module_instance_id, title, description, start_time, end_time, recurrence_rule, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
      [
        module_instance_id || null,
        title,
        description || null,
        start_time,
        end_time || null,
        recurrence_rule ? JSON.stringify(recurrence_rule) : null,
        metadata ? JSON.stringify(metadata) : null
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating calendar event:', error);
    res.status(500).json({ error: 'Failed to create calendar event', details: error.message });
  }
});

// Update calendar event
router.put('/:id', async (req, res) => {
  try {
    const { title, description, start_time, end_time, recurrence_rule, metadata } = req.body;
    const updates = [];
    const values = [];
    let paramCount = 1;

    if (title !== undefined) {
      updates.push(`title = $${paramCount++}`);
      values.push(title);
    }
    if (description !== undefined) {
      updates.push(`description = $${paramCount++}`);
      values.push(description);
    }
    if (start_time !== undefined) {
      updates.push(`start_time = $${paramCount++}`);
      values.push(start_time);
    }
    if (end_time !== undefined) {
      updates.push(`end_time = $${paramCount++}`);
      values.push(end_time);
    }
    if (recurrence_rule !== undefined) {
      updates.push(`recurrence_rule = $${paramCount++}`);
      values.push(recurrence_rule ? JSON.stringify(recurrence_rule) : null);
    }
    if (metadata !== undefined) {
      updates.push(`metadata = $${paramCount++}`);
      values.push(metadata ? JSON.stringify(metadata) : null);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(req.params.id);
    const result = await query(
      `UPDATE calendar_events SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Calendar event not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating calendar event:', error);
    res.status(500).json({ error: 'Failed to update calendar event', details: error.message });
  }
});

// Delete calendar event
router.delete('/:id', async (req, res) => {
  try {
    const result = await query('DELETE FROM calendar_events WHERE id = $1 RETURNING *', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Calendar event not found' });
    }
    res.json({ message: 'Calendar event deleted successfully', event: result.rows[0] });
  } catch (error) {
    console.error('Error deleting calendar event:', error);
    res.status(500).json({ error: 'Failed to delete calendar event', details: error.message });
  }
});

export default router;

