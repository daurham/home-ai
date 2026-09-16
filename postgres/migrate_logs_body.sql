-- Each log is a shared growing document (note.txt), not a list of cards.
-- Flatten any existing dated entries into the book's body.
--   docker compose exec -T postgres psql -U homeai -d homeai < postgres/migrate_logs_body.sql

ALTER TABLE log_books ADD COLUMN IF NOT EXISTS body TEXT NOT NULL DEFAULT '';

UPDATE log_books AS b
SET body = src.doc
FROM (
    SELECT
        book_id,
        string_agg(stamp || E'\n' || body, E'\n\n' ORDER BY occurred_on ASC, created_at ASC) AS doc
    FROM (
        SELECT
            book_id,
            occurred_on,
            created_at,
            body,
            to_char(occurred_on, 'FMMM/FMDD/YYYY') AS stamp
        FROM log_entries
    ) e
    GROUP BY book_id
) src
WHERE b.id = src.book_id
  AND b.body = ''
  AND src.doc IS NOT NULL;
