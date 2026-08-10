-- Retour à l'état antérieur : le registre redevient une trace posthume.
--
-- ⚠ Cette descente RÉINTRODUIT la possibilité d'une double exécution après
-- crash. Elle n'existe que parce que `docs/02` exige que toute migration soit
-- réversible, et parce que cette réversibilité est vérifiée à chaque exécution
-- de la suite. Elle ne doit jamais être appliquée en exploitation.

-- Les opérations jamais observées n'ont pas d'équivalent dans l'ancien modèle,
-- où une ligne signifiait « exécutée avec succès ». On les retire plutôt que
-- de leur inventer un verdict.
DELETE FROM tool_operations WHERE observed_at IS NULL;

DROP INDEX IF EXISTS tool_operations_pending_idx;
ALTER TABLE tool_operations DROP CONSTRAINT verdict_only_when_observed;
ALTER TABLE tool_operations DROP CONSTRAINT terminal_states_are_observed;

UPDATE tool_operations SET status = 'UNKNOWN' WHERE status IS NULL;
ALTER TABLE tool_operations ALTER COLUMN status SET NOT NULL;

ALTER TABLE tool_operations
    DROP COLUMN recovery_detail,
    DROP COLUMN attempts,
    DROP COLUMN observed_at,
    DROP COLUMN executing_at,
    DROP COLUMN committed_at,
    DROP COLUMN state;
