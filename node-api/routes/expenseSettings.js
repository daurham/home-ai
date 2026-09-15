import express from 'express';
import {
  getExpenseSettings,
  parseWeeklyBudgetCents,
  validateWeeklyBudgetCents,
} from '../lib/expenseSettings.js';
import { query } from '../db.js';

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const settings = await getExpenseSettings();
    res.json(settings);
  } catch (error) {
    console.error('Error fetching expense settings:', error);
    res.status(500).json({ error: 'Failed to fetch expense settings', details: error.message });
  }
});

router.patch('/', async (req, res) => {
  try {
    const parsed = parseWeeklyBudgetCents(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const budgetError = validateWeeklyBudgetCents(parsed.value);
    if (budgetError) return res.status(400).json({ error: budgetError });

    await getExpenseSettings();
    const updated = await query(
      `UPDATE expense_settings
       SET weekly_budget_cents = $1
       WHERE id = 1
       RETURNING id, weekly_budget_cents, currency, updated_at`,
      [parsed.value]
    );
    res.json(updated.rows[0]);
  } catch (error) {
    console.error('Error updating expense settings:', error);
    res.status(500).json({ error: 'Failed to update expense settings', details: error.message });
  }
});

export default router;
