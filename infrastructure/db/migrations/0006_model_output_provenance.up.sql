-- ==========================================================================
-- 0006 — `MODEL_OUTPUT` : une déduction de modèle n'est pas le noyau
--
-- Référence : ADR-024, invariant S1, audit `docs/11` — défaut CRIT-2.
--
-- LE DÉFAUT CORRIGÉ ICI
-- ---------------------
-- `provenanceOf('MODEL_INFERRED')` rendait `'SYSTEM'`, c'est-à-dire une
-- provenance FIABLE — la même que ce que le noyau produit lui-même. Une valeur
-- déduite par un modèle pouvait donc alimenter un paramètre sensible sans
-- confirmation, exactement l'inverse de l'invariant S1 :
--
--     « La sortie d'un modèle est une entrée non fiable. »
--
-- Le second axe, lui, faisait son travail : `SOURCE_CEILING.MODEL_INFERRED`
-- plafonnait déjà la confiance à 0,7. C'était l'axe SÉCURITÉ qui était faux,
-- pas l'axe épistémique — d'où la difficulté à le voir en relisant.
--
-- POURQUOI UNE VALEUR DISTINCTE PLUTÔT QUE RANGER DANS `EXTERNAL_UNTRUSTED`
-- ------------------------------------------------------------------------
-- Les deux sont non fiables, mais pas pour la même raison, et la confusion
-- coûterait cher plus tard :
--   `EXTERNAL_UNTRUSTED` — un tiers a écrit ce texte, il peut être hostile ;
--   `MODEL_OUTPUT`       — personne n'est hostile, mais rien ne garantit que
--                          la déduction soit exacte.
-- Les distinguer permettra un jour de traiter différemment « un email me dit
-- X » et « le modèle en déduit X ». Les confondre serait irréversible : on ne
-- peut pas reconstruire après coup une distinction qu'on n'a pas écrite.
--
-- Aucune ligne n'est migrée : aucun modèle n'a jamais tourné, donc aucune
-- mémoire ne porte `MODEL_INFERRED` aujourd'hui. On élargit la contrainte
-- avant que ce soit le cas.
-- ==========================================================================

ALTER TABLE memories DROP CONSTRAINT memories_provenance_check;
ALTER TABLE memories ADD CONSTRAINT memories_provenance_check CHECK (
    provenance IN ('USER','SYSTEM','MEMORY','TOOL_OUTPUT','MODEL_OUTPUT','EXTERNAL_UNTRUSTED')
);

ALTER TABLE memory_candidates DROP CONSTRAINT memory_candidates_provenance_check;
ALTER TABLE memory_candidates ADD CONSTRAINT memory_candidates_provenance_check CHECK (
    provenance IN ('USER','SYSTEM','MEMORY','TOOL_OUTPUT','MODEL_OUTPUT','EXTERNAL_UNTRUSTED')
);

-- La cohérence des deux axes reste imposée par la base, et non par le seul
-- code applicatif : une origine ne peut pas se voir attribuer une provenance
-- qui la blanchirait.
ALTER TABLE memories DROP CONSTRAINT source_matches_provenance;
ALTER TABLE memories ADD CONSTRAINT source_matches_provenance CHECK (
    (source_type = 'EXTERNAL_SOURCE') = (provenance = 'EXTERNAL_UNTRUSTED')
    AND
    (source_type = 'MODEL_INFERRED') = (provenance = 'MODEL_OUTPUT')
);
