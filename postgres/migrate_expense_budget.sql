-- Household weekly budget (singleton). Default $150.00.
-- Apply on existing DBs:
--   psql "$DATABASE_URL" -f postgres/migrate_expense_budget.sql

CREATE TABLE IF NOT EXISTS expense_settings (
    id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    weekly_budget_cents INT NOT NULL DEFAULT 15000 CHECK (weekly_budget_cents > 0),
    currency CHAR(3) NOT NULL DEFAULT 'USD',
    updated_at TIMESTAMP DEFAULT NOW()
);

INSERT INTO expense_settings (id, weekly_budget_cents, currency)
VALUES (1, 15000, 'USD')
ON CONFLICT (id) DO NOTHING;

DROP TRIGGER IF EXISTS update_expense_settings_updated_at ON expense_settings;
CREATE TRIGGER update_expense_settings_updated_at BEFORE UPDATE ON expense_settings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
