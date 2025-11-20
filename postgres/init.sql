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
