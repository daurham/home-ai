-- Household file drop. Blobs live on a Docker volume; this table is the index.
-- init.sql only runs on a fresh Postgres volume; apply this by hand:
--   docker compose exec -T postgres psql -U homeai -d homeai < postgres/migrate_shared_files.sql

CREATE TABLE IF NOT EXISTS shared_files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL UNIQUE,
    mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shared_files_created_at ON shared_files(created_at DESC);
