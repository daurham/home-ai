-- Latency probe targets managed from the dashboard UI.
-- Built-in targets stay in node-api/latency-targets.js; rows here are added on top.
-- Apply on existing DBs:
--   psql "$DATABASE_URL" -f postgres/migrate_latency_targets.sql

CREATE TABLE IF NOT EXISTS latency_targets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('http', 'tcp', 'postgres', 'ollama')),
    url TEXT,
    method TEXT NOT NULL DEFAULT 'GET' CHECK (method IN ('GET', 'POST')),
    expect_status INTEGER[] NOT NULL DEFAULT '{200}',
    expect_body_includes TEXT,
    host TEXT,
    port INTEGER CHECK (port IS NULL OR (port >= 1 AND port <= 65535)),
    connection_string_env TEXT,
    interval_ms INTEGER NOT NULL DEFAULT 30000 CHECK (interval_ms >= 10000),
    timeout_ms INTEGER NOT NULL DEFAULT 3000 CHECK (timeout_ms >= 500),
    degraded_threshold_ms INTEGER NOT NULL DEFAULT 1000 CHECK (degraded_threshold_ms > 0),
    sample_capacity INTEGER NOT NULL DEFAULT 90 CHECK (sample_capacity BETWEEN 2 AND 240),
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

DROP TRIGGER IF EXISTS update_latency_targets_updated_at ON latency_targets;
CREATE TRIGGER update_latency_targets_updated_at BEFORE UPDATE ON latency_targets
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
