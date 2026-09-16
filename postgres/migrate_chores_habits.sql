-- Household chores and habits. Previously browser-local (Zustand persist);
-- these tables are the shared source of truth across phones, tablets, and desktops.
-- init.sql only runs on a fresh Postgres volume; apply this by hand:
--   psql "$DATABASE_URL" -f postgres/migrate_chores_habits.sql
-- or:
--   docker compose exec -T postgres psql -U homeai -d homeai < postgres/migrate_chores_habits.sql

CREATE TABLE IF NOT EXISTS chores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    assignee TEXT NOT NULL DEFAULT '',
    every INT NOT NULL DEFAULT 1 CHECK (every BETWEEN 1 AND 365),
    unit TEXT NOT NULL DEFAULT 'days' CHECK (unit IN ('days', 'weeks', 'months')),
    weekday INT NOT NULL DEFAULT 0 CHECK (weekday BETWEEN 0 AND 6),
    month_day INT NOT NULL DEFAULT 1 CHECK (month_day BETWEEN 1 AND 28),
    icon TEXT NOT NULL DEFAULT 'generic',
    day_specific BOOLEAN NOT NULL DEFAULT FALSE,
    last_completed_on DATE,
    completed_occurrences JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chores_created_at ON chores(created_at);

DROP TRIGGER IF EXISTS update_chores_updated_at ON chores;
CREATE TRIGGER update_chores_updated_at BEFORE UPDATE ON chores
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS habits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    completions JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_habits_created_at ON habits(created_at);

DROP TRIGGER IF EXISTS update_habits_updated_at ON habits;
CREATE TRIGGER update_habits_updated_at BEFORE UPDATE ON habits
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
