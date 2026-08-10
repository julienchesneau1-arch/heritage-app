-- Retour à l'état antérieur : `MODEL_OUTPUT` disparaît, `MODEL_INFERRED`
-- redevient `SYSTEM`.
--
-- ⚠ Cette descente RÉINTRODUIT le défaut CRIT-2. Elle n'existe que parce que
-- `docs/02` exige que toute migration soit réversible, et parce que la
-- réversibilité est vérifiée à chaque exécution de la suite de tests. Elle ne
-- doit jamais être appliquée en exploitation.

UPDATE memories SET provenance = 'SYSTEM' WHERE provenance = 'MODEL_OUTPUT';
UPDATE memory_candidates SET provenance = 'SYSTEM' WHERE provenance = 'MODEL_OUTPUT';

ALTER TABLE memories DROP CONSTRAINT source_matches_provenance;
ALTER TABLE memories ADD CONSTRAINT source_matches_provenance CHECK (
    (source_type = 'EXTERNAL_SOURCE') = (provenance = 'EXTERNAL_UNTRUSTED')
);

ALTER TABLE memories DROP CONSTRAINT memories_provenance_check;
ALTER TABLE memories ADD CONSTRAINT memories_provenance_check CHECK (
    provenance IN ('USER','SYSTEM','MEMORY','TOOL_OUTPUT','EXTERNAL_UNTRUSTED')
);

ALTER TABLE memory_candidates DROP CONSTRAINT memory_candidates_provenance_check;
ALTER TABLE memory_candidates ADD CONSTRAINT memory_candidates_provenance_check CHECK (
    provenance IN ('USER','SYSTEM','MEMORY','TOOL_OUTPUT','EXTERNAL_UNTRUSTED')
);
