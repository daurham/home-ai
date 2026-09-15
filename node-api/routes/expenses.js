import express from 'express';
import { query } from '../db.js';
import {
  getExpenseMonthRange,
  getExpenseWeekRange,
  iterateMonthKeys,
  iterateWeekKeys,
  resolveTimeZone,
  todayYmd,
} from '../lib/expenseWeek.js';
import {
  DATE_RE,
  parseAmountCents,
  validateAmountCents,
  validateNote,
  validateOccurredOn,
  validatePaidBy,
} from '../lib/expenseValidation.js';
import { getExpenseSettings } from '../lib/expenseSettings.js';

const router = express.Router();

const MONTH_RE = /^\d{4}-\d{2}$/;

const EXPENSE_SELECT = `
  SELECT
    e.id,
    e.amount_cents,
    e.currency,
    e.category_id,
    e.note,
    e.paid_by,
    e.occurred_on::text AS occurred_on,
    e.created_at,
    e.updated_at,
    e.deleted_at,
    c.name AS category_name,
    c.color AS category_color
  FROM expenses e
  JOIN expense_categories c ON c.id = e.category_id
`;

function isUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function getActiveCategory(id) {
  const result = await query(
    'SELECT * FROM expense_categories WHERE id = $1',
    [id]
  );
  return result.rows[0] || null;
}

function fridayRangeFromWeekKey(weekKey, timeZone) {
  const range = getExpenseWeekRange(weekKey, timeZone);
  return { from: range.weekStartDate, to: range.weekEndDate };
}

function monthRangeFromKey(monthKey, timeZone) {
  const range = getExpenseMonthRange(`${monthKey}-01`, timeZone);
  return { from: range.monthStartDate, to: range.monthEndDate };
}

function resolveListRange(queryParams, timeZone) {
  const { from, to, weekKey, month } = queryParams;
  if (weekKey) {
    if (!DATE_RE.test(weekKey)) {
      return { error: 'weekKey must be YYYY-MM-DD of the Friday week start' };
    }
    return fridayRangeFromWeekKey(weekKey, timeZone);
  }
  if (month) {
    if (!MONTH_RE.test(month)) {
      return { error: 'month must be YYYY-MM' };
    }
    return monthRangeFromKey(month, timeZone);
  }
  if ((from && !DATE_RE.test(from)) || (to && !DATE_RE.test(to))) {
    return { error: 'from and to must be YYYY-MM-DD' };
  }
  if (from || to) {
    const current = getExpenseWeekRange(todayYmd(timeZone), timeZone);
    return {
      from: from || current.weekStartDate,
      to: to || current.weekEndDate,
    };
  }
  const current = getExpenseWeekRange(todayYmd(timeZone), timeZone);
  return { from: current.weekStartDate, to: current.weekEndDate };
}

// GET /api/expenses/summary  — must be registered before /:id
router.get('/summary', async (req, res) => {
  try {
    const timeZone = resolveTimeZone(req.query.timeZone);
    const grain = req.query.grain === 'month' ? 'month' : 'week';
    const today = todayYmd(timeZone);
    const currentWeek = getExpenseWeekRange(today, timeZone);
    const currentMonth = getExpenseMonthRange(today, timeZone);

    let from = req.query.from;
    let to = req.query.to;
    if (from && !DATE_RE.test(from)) {
      return res.status(400).json({ error: 'from must be YYYY-MM-DD' });
    }
    if (to && !DATE_RE.test(to)) {
      return res.status(400).json({ error: 'to must be YYYY-MM-DD' });
    }

    if (grain === 'week') {
      if (!from) {
        const [y, m, d] = currentWeek.weekStartDate.split('-').map(Number);
        const past = new Date(Date.UTC(y, m - 1, d - 7 * 7));
        from = `${past.getUTCFullYear()}-${String(past.getUTCMonth() + 1).padStart(2, '0')}-${String(past.getUTCDate()).padStart(2, '0')}`;
      }
      if (!to) to = currentWeek.weekEndDate;
    } else {
      if (!from) {
        const [y, m] = currentMonth.monthKey.split('-').map(Number);
        let startMonth = m - 5;
        let startYear = y;
        while (startMonth <= 0) {
          startMonth += 12;
          startYear -= 1;
        }
        from = `${startYear}-${String(startMonth).padStart(2, '0')}-01`;
      }
      if (!to) to = currentMonth.monthEndDate;
    }

    const selectedWeekKey = req.query.weekKey || currentWeek.weekKey;
    const selectedMonth = req.query.month || currentMonth.monthKey;
    const selectedRange = grain === 'week'
      ? fridayRangeFromWeekKey(selectedWeekKey, timeZone)
      : monthRangeFromKey(selectedMonth, timeZone);

    const periodSql = grain === 'week'
      ? `to_char((occurred_on - (((EXTRACT(DOW FROM occurred_on)::int - 5 + 7) % 7) * INTERVAL '1 day'))::date, 'YYYY-MM-DD')`
      : `to_char(occurred_on, 'YYYY-MM')`;

    const periodRows = await query(
      `SELECT ${periodSql} AS period_key, COALESCE(SUM(amount_cents), 0)::int AS total_cents
       FROM expenses
       WHERE deleted_at IS NULL
         AND occurred_on >= $1::date
         AND occurred_on <= $2::date
       GROUP BY period_key
       ORDER BY period_key`,
      [from, to]
    );

    const totalsByKey = Object.fromEntries(periodRows.rows.map((row) => [row.period_key, row.total_cents]));
    const keys = grain === 'week'
      ? iterateWeekKeys(from, to, timeZone)
      : iterateMonthKeys(from, to, timeZone);

    const periods = keys.map((key) => {
      if (grain === 'week') {
        const range = getExpenseWeekRange(key, timeZone);
        return {
          key,
          start: range.weekStartDate,
          end: range.weekEndDate,
          total_cents: totalsByKey[key] || 0,
        };
      }
      const range = getExpenseMonthRange(`${key}-01`, timeZone);
      return {
        key,
        start: range.monthStartDate,
        end: range.monthEndDate,
        total_cents: totalsByKey[key] || 0,
      };
    });

    const categoryRows = await query(
      `SELECT c.id AS category_id, c.name, c.color, COALESCE(SUM(e.amount_cents), 0)::int AS total_cents
       FROM expenses e
       JOIN expense_categories c ON c.id = e.category_id
       WHERE e.deleted_at IS NULL
         AND e.occurred_on >= $1::date
         AND e.occurred_on <= $2::date
       GROUP BY c.id, c.name, c.color
       HAVING COALESCE(SUM(e.amount_cents), 0) > 0
       ORDER BY total_cents DESC`,
      [selectedRange.from, selectedRange.to]
    );

    const selectedTotal = categoryRows.rows.reduce((sum, row) => sum + row.total_cents, 0);
    const settings = await getExpenseSettings();
    const weeklyBudgetCents = settings.weekly_budget_cents;
    const remainingCents = grain === 'week' ? weeklyBudgetCents - selectedTotal : null;

    res.json({
      grain,
      timeZone,
      from,
      to,
      selected: grain === 'week'
        ? { weekKey: selectedWeekKey, ...selectedRange }
        : { month: selectedMonth, ...selectedRange },
      selected_period_total_cents: selectedTotal,
      weekly_budget_cents: weeklyBudgetCents,
      remaining_cents: remainingCents,
      periods,
      categories: categoryRows.rows,
    });
  } catch (error) {
    console.error('Error fetching expense summary:', error);
    res.status(500).json({ error: 'Failed to fetch expense summary', details: error.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const timeZone = resolveTimeZone(req.query.timeZone);
    const range = resolveListRange(req.query, timeZone);
    if (range.error) {
      return res.status(400).json({ error: range.error });
    }

    const result = await query(
      `${EXPENSE_SELECT}
       WHERE e.deleted_at IS NULL
         AND e.occurred_on >= $1::date
         AND e.occurred_on <= $2::date
       ORDER BY e.occurred_on DESC, e.created_at DESC`,
      [range.from, range.to]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching expenses:', error);
    res.status(500).json({ error: 'Failed to fetch expenses', details: error.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const result = await query(
      `${EXPENSE_SELECT} WHERE e.id = $1 AND e.deleted_at IS NULL`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Expense not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching expense:', error);
    res.status(500).json({ error: 'Failed to fetch expense', details: error.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const timeZone = resolveTimeZone(req.body.timeZone || req.query.timeZone);
    const { category_id, note, paid_by, currency } = req.body;
    const occurredOn = req.body.occurred_on || todayYmd(timeZone);
    const amount = parseAmountCents(req.body);

    if (amount.error) return res.status(400).json({ error: amount.error });
    const amountError = validateAmountCents(amount.value);
    if (amountError) return res.status(400).json({ error: amountError });
    if (!isUuid(category_id)) return res.status(400).json({ error: 'category_id is required' });

    const occurredError = validateOccurredOn(occurredOn, timeZone);
    if (occurredError) return res.status(400).json({ error: occurredError });

    const noteError = validateNote(note);
    if (noteError) return res.status(400).json({ error: noteError });
    const paidByError = validatePaidBy(paid_by);
    if (paidByError) return res.status(400).json({ error: paidByError });

    const category = await getActiveCategory(category_id);
    if (!category) return res.status(400).json({ error: 'Unknown category' });
    if (category.archived_at) return res.status(400).json({ error: 'Category is archived' });

    const currencyCode = (currency || 'USD').toUpperCase();
    if (!/^[A-Z]{3}$/.test(currencyCode)) {
      return res.status(400).json({ error: 'currency must be a 3-letter code' });
    }

    const insert = await query(
      `INSERT INTO expenses (amount_cents, currency, category_id, note, paid_by, occurred_on)
       VALUES ($1, $2, $3, $4, $5, $6::date)
       RETURNING id`,
      [
        amount.value,
        currencyCode,
        category_id,
        note ? String(note).trim() || null : null,
        paid_by ? String(paid_by).trim() || null : null,
        occurredOn,
      ]
    );

    const created = await query(`${EXPENSE_SELECT} WHERE e.id = $1`, [insert.rows[0].id]);
    res.status(201).json(created.rows[0]);
  } catch (error) {
    console.error('Error creating expense:', error);
    res.status(500).json({ error: 'Failed to create expense', details: error.message });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const timeZone = resolveTimeZone(req.body.timeZone || req.query.timeZone);
    const existing = await query(
      'SELECT * FROM expenses WHERE id = $1 AND deleted_at IS NULL',
      [req.params.id]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Expense not found' });
    }

    const updates = [];
    const values = [];
    let paramCount = 1;
    const body = req.body;

    if (body.amount_cents !== undefined || body.amount !== undefined) {
      const amount = parseAmountCents(body);
      if (amount.error) return res.status(400).json({ error: amount.error });
      const amountError = validateAmountCents(amount.value);
      if (amountError) return res.status(400).json({ error: amountError });
      updates.push(`amount_cents = $${paramCount++}`);
      values.push(amount.value);
    }

    if (body.currency !== undefined) {
      const currencyCode = String(body.currency).toUpperCase();
      if (!/^[A-Z]{3}$/.test(currencyCode)) {
        return res.status(400).json({ error: 'currency must be a 3-letter code' });
      }
      updates.push(`currency = $${paramCount++}`);
      values.push(currencyCode);
    }

    if (body.category_id !== undefined) {
      if (!isUuid(body.category_id)) return res.status(400).json({ error: 'category_id is invalid' });
      const category = await getActiveCategory(body.category_id);
      if (!category) return res.status(400).json({ error: 'Unknown category' });
      updates.push(`category_id = $${paramCount++}`);
      values.push(body.category_id);
    }

    if (body.note !== undefined) {
      const noteError = validateNote(body.note);
      if (noteError) return res.status(400).json({ error: noteError });
      updates.push(`note = $${paramCount++}`);
      values.push(body.note ? String(body.note).trim() || null : null);
    }

    if (body.paid_by !== undefined) {
      const paidByError = validatePaidBy(body.paid_by);
      if (paidByError) return res.status(400).json({ error: paidByError });
      updates.push(`paid_by = $${paramCount++}`);
      values.push(body.paid_by ? String(body.paid_by).trim() || null : null);
    }

    if (body.occurred_on !== undefined) {
      const occurredError = validateOccurredOn(body.occurred_on, timeZone);
      if (occurredError) return res.status(400).json({ error: occurredError });
      updates.push(`occurred_on = $${paramCount++}::date`);
      values.push(body.occurred_on);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(req.params.id);
    await query(
      `UPDATE expenses SET ${updates.join(', ')} WHERE id = $${paramCount} AND deleted_at IS NULL`,
      values
    );

    const updated = await query(`${EXPENSE_SELECT} WHERE e.id = $1`, [req.params.id]);
    res.json(updated.rows[0]);
  } catch (error) {
    console.error('Error updating expense:', error);
    res.status(500).json({ error: 'Failed to update expense', details: error.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await query(
      `UPDATE expenses SET deleted_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING id`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Expense not found' });
    }
    res.json({ message: 'Expense deleted', id: result.rows[0].id });
  } catch (error) {
    console.error('Error deleting expense:', error);
    res.status(500).json({ error: 'Failed to delete expense', details: error.message });
  }
});

router.post('/:id/restore', async (req, res) => {
  try {
    const restored = await query(
      `UPDATE expenses SET deleted_at = NULL
       WHERE id = $1 AND deleted_at IS NOT NULL
       RETURNING id`,
      [req.params.id]
    );
    if (restored.rows.length === 0) {
      return res.status(404).json({ error: 'Expense not found' });
    }
    const row = await query(`${EXPENSE_SELECT} WHERE e.id = $1`, [req.params.id]);
    res.json(row.rows[0]);
  } catch (error) {
    console.error('Error restoring expense:', error);
    res.status(500).json({ error: 'Failed to restore expense', details: error.message });
  }
});

export default router;
