-- Home AI Database Initialization Script
-- This script runs automatically when the PostgreSQL container is first created
-- Architecture: Hybrid Schema for Extensible Modules with JSONB

-- Create extensions if needed
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- 1. Module type definitions
CREATE TABLE IF NOT EXISTS modules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,                -- "budget", "list", "canvas", etc.
    description TEXT,
    version INT NOT NULL DEFAULT 1,
    config_schema JSONB,               -- describes module settings
    data_schema JSONB,                 -- describes expected data structure
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- 2. Instances of modules placed on the dashboard
CREATE TABLE IF NOT EXISTS module_instances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    module_id UUID REFERENCES modules(id) ON DELETE CASCADE,
    layout JSONB,                      -- { x, y, width, height }
    settings JSONB,                    -- per-instance settings
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- 3. Data records for each module instance
CREATE TABLE IF NOT EXISTS module_data_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    module_instance_id UUID REFERENCES module_instances(id) ON DELETE CASCADE,
    data JSONB NOT NULL,               -- module-defined arbitrary shape
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- 4. Calendar events (structured)
CREATE TABLE IF NOT EXISTS calendar_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    module_instance_id UUID REFERENCES module_instances(id),
    title TEXT NOT NULL,
    description TEXT,
    start_time TIMESTAMP NOT NULL,
    end_time TIMESTAMP,
    recurrence_rule JSONB,             -- null or object describing RRULE-like data
    metadata JSONB,                    -- tags, color, priority
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_module_instances_module_id ON module_instances(module_id);
CREATE INDEX IF NOT EXISTS idx_module_data_records_instance_id ON module_data_records(module_instance_id);
CREATE INDEX IF NOT EXISTS idx_calendar_events_instance_id ON calendar_events(module_instance_id);
CREATE INDEX IF NOT EXISTS idx_calendar_events_start_time ON calendar_events(start_time);
CREATE INDEX IF NOT EXISTS idx_calendar_events_end_time ON calendar_events(end_time);

-- Triggers to auto-update updated_at
CREATE TRIGGER update_modules_updated_at BEFORE UPDATE ON modules
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_module_instances_updated_at BEFORE UPDATE ON module_instances
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_module_data_records_updated_at BEFORE UPDATE ON module_data_records
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_calendar_events_updated_at BEFORE UPDATE ON calendar_events
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 5. Expense categories (user-defined; unique among active rows)
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

-- 6. Household expenses (money stored as integer cents, never float)
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

CREATE TRIGGER update_expense_categories_updated_at BEFORE UPDATE ON expense_categories
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_expenses_updated_at BEFORE UPDATE ON expenses
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Starter categories (calm, distinct colors for mental accounting)
INSERT INTO expense_categories (name, color, sort_order)
SELECT v.name, v.color, v.sort_order
FROM (VALUES
    ('Groceries',     '#8A9A7B', 1),
    ('Travel',        '#7A92A8', 2),
    ('Entertainment', '#9B8AA8', 3),
    ('Home',          '#B5A394', 4)
) AS v(name, color, sort_order)
WHERE NOT EXISTS (
    SELECT 1 FROM expense_categories c
    WHERE lower(c.name) = lower(v.name) AND c.archived_at IS NULL
);

-- 7. Household weekly budget (singleton; default $150)
CREATE TABLE IF NOT EXISTS expense_settings (
    id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    weekly_budget_cents INT NOT NULL DEFAULT 15000 CHECK (weekly_budget_cents > 0),
    currency CHAR(3) NOT NULL DEFAULT 'USD',
    updated_at TIMESTAMP DEFAULT NOW()
);

INSERT INTO expense_settings (id, weekly_budget_cents, currency)
VALUES (1, 15000, 'USD')
ON CONFLICT (id) DO NOTHING;

CREATE TRIGGER update_expense_settings_updated_at BEFORE UPDATE ON expense_settings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Insert default module types
INSERT INTO modules (name, description, config_schema, data_schema) VALUES
    ('weekly-budget-tracker', 'Tracks weekly spending and income', 
     '{"fields": [{"key": "currency", "type": "string", "default": "USD"}, {"key": "showRemaining", "type": "boolean", "default": true}]}'::jsonb,
     '{"startingAmount": "number", "transactions": [{"title": "string", "amount": "number", "created": "datetime"}]}'::jsonb)
ON CONFLICT DO NOTHING;

INSERT INTO modules (name, description, config_schema, data_schema) VALUES
    ('list-maker', 'Create and manage lists with checkboxes and bullet points',
     '{"fields": [{"key": "title", "type": "string", "default": ""}, {"key": "sortOrder", "type": "string", "default": "manual"}]}'::jsonb,
     '{"entries": [{"text": "string", "type": "string", "checked": "boolean"}]}'::jsonb)
ON CONFLICT DO NOTHING;
