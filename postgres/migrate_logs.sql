-- Household log books and dated entries for looking back later
-- (maintenance, and any other log the household adds).
-- init.sql only runs on a fresh Postgres volume; apply this by hand:
--   docker compose exec -T postgres psql -U homeai -d homeai < postgres/migrate_logs.sql

CREATE TABLE IF NOT EXISTS log_books (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TRIGGER update_log_books_updated_at BEFORE UPDATE ON log_books
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS log_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    book_id UUID NOT NULL REFERENCES log_books(id) ON DELETE CASCADE,
    occurred_on DATE NOT NULL,
    body TEXT NOT NULL,
    amount_cents INT CHECK (amount_cents IS NULL OR amount_cents > 0),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_log_entries_book_occurred
    ON log_entries(book_id, occurred_on DESC, created_at DESC);

CREATE TRIGGER update_log_entries_updated_at BEFORE UPDATE ON log_entries
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

INSERT INTO log_books (name, slug, sort_order)
VALUES ('Maintenance', 'maintenance', 0)
ON CONFLICT (slug) DO NOTHING;
