-- Descente de 0008 — cloisonnement du bail.
DROP INDEX IF EXISTS tool_operations_lease_idx;
ALTER TABLE tool_operations DROP CONSTRAINT IF EXISTS lease_has_deadline;
ALTER TABLE tool_operations
    DROP COLUMN IF EXISTS lease_expires_at,
    DROP COLUMN IF EXISTS lease_owner,
    DROP COLUMN IF EXISTS lease_generation;
