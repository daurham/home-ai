-- Additive migration for existing home-ai databases.
-- init.sql only runs on a fresh Postgres volume; apply this by hand:
--   psql "$DATABASE_URL" -f postgres/migrate_expenses.sql
--
-- Household timezone used by the API is America/Los_Angeles unless
-- EXPENSE_TIMEZONE is set. Week assignment uses occurred_on (a calendar date),
-- so DST does not move an expense between weeks.

CREATE TABLE IF NOT EXISTS expense_categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#8E8B86',
    sort_order INT NOT NULL DEFAULT 0,
    archived_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_expense_categories_active_name
    ON expense_categories (lower(name))
    WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS expenses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    amount_cents INT NOT NULL CHECK (amount_cents > 0),
    currency CHAR(3) NOT NULL DEFAULT 'USD',
    category_id UUID NOT NULL REFERENCES expense_categories(id),
    note TEXT,
    paid_by TEXT,
    occurred_on DATE NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    deleted_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_expenses_occurred_on ON expenses(occurred_on) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_expenses_category_id ON expenses(category_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_expenses_occurred_on_category ON expenses(occurred_on, category_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_expenses_paid_by ON expenses(paid_by) WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS update_expense_categories_updated_at ON expense_categories;
CREATE TRIGGER update_expense_categories_updated_at BEFORE UPDATE ON expense_categories
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_expenses_updated_at ON expenses;
CREATE TRIGGER update_expenses_updated_at BEFORE UPDATE ON expenses
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

INSERT INTO expense_categories (name, color, sort_order)
SELECT v.name, v.color, v.sort_order
FROM (VALUES
    ('Groceries', '#8A9A7B', 1),
    ('Dining',    '#C4A484', 2),
    ('Transport', '#7A92A8', 3),
    ('Home',      '#B5A394', 4),
    ('Health',    '#6F9E8F', 5),
    ('Fun',       '#9B8AA8', 6),
    ('Shopping',  '#B08999', 7),
    ('Other',     '#8E8B86', 8)
) AS v(name, color, sort_order)
WHERE NOT EXISTS (
    SELECT 1 FROM expense_categories c
    WHERE lower(c.name) = lower(v.name) AND c.archived_at IS NULL
);
