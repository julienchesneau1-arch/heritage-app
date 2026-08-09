-- Rollback 0003

DROP TABLE IF EXISTS session_turns;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS entity_aliases;

DROP INDEX IF EXISTS memories_content_digest_idx;
DROP INDEX IF EXISTS memories_embedding_idx;
DROP INDEX IF EXISTS memories_search_vector_idx;

ALTER TABLE memories DROP CONSTRAINT IF EXISTS embedding_has_model;
ALTER TABLE memories DROP COLUMN IF EXISTS content_digest;
ALTER TABLE memories DROP COLUMN IF EXISTS search_vector;
ALTER TABLE memories DROP COLUMN IF EXISTS embedding_model;
ALTER TABLE memories DROP COLUMN IF EXISTS embedding;

-- L'extension vector est laissée en place : la retirer casserait toute autre
-- base du même cluster qui en dépendrait.
