-- Rollback 0005

DROP TABLE IF EXISTS memory_candidates;
DROP TABLE IF EXISTS memory_derivatives;
DROP TABLE IF EXISTS action_snapshots;

ALTER TABLE memories DROP CONSTRAINT IF EXISTS sensitive_categories_are_red;
ALTER TABLE memories DROP CONSTRAINT IF EXISTS source_matches_provenance;

DROP INDEX IF EXISTS memories_data_category_idx;
DROP INDEX IF EXISTS memories_source_type_idx;

ALTER TABLE memories DROP COLUMN IF EXISTS data_category;
ALTER TABLE memories DROP COLUMN IF EXISTS source_type;
