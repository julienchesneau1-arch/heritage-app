-- ==========================================================================
-- 0007 — Journal d'intention
--
-- Référence : ADR-027, `docs/12 §5`, matrice adversariale ligne C2.
--
-- LE DÉFAUT CORRIGÉ ICI
-- ---------------------
-- `tool_operations` n'était écrit qu'APRÈS l'exécution. Un timeout, une
-- coupure réseau ou un arrêt du processus pendant l'appel ne laissait donc
-- aucune ligne — et un rejeu avec la même clé, ne trouvant rien, RÉEXÉCUTAIT.
--
-- Nul pour les cinq outils actuels : ils écrivent dans PostgreSQL, de façon
-- transactionnelle. Double envoi pour un outil d'email.
--
-- LA PROPRIÉTÉ QUE CETTE MIGRATION REND POSSIBLE
-- ----------------------------------------------
--   « Le système ne doit jamais déduire "non exécuté" de "aucune trace". »
--
-- Cette règle n'est tenable QUE si la trace précède tout effet externe. C'est
-- l'objet du cycle de vie ci-dessous : l'absence de ligne devient une
-- information fiable, parce qu'aucun appel n'a jamais lieu avant l'écriture.
--
--   PLANNED                  décidée, rien de tenté
--       ↓
--   COMMITTED_TO_EXECUTION   barrière de durabilité, appel imminent
--       ↓
--   EXECUTING                l'appel est parti — un effet est POSSIBLE
--       ↓
--   SUCCEEDED │ FAILED │ UNKNOWN
--
-- `EXECUTING` est l'état qui coûte cher et qui justifie tout le reste : c'est
-- le seul depuis lequel Jarvis ignore si le monde a changé.
-- ==========================================================================

ALTER TABLE tool_operations
    ADD COLUMN state TEXT NOT NULL DEFAULT 'SUCCEEDED' CHECK (state IN (
        'PLANNED', 'COMMITTED_TO_EXECUTION', 'EXECUTING',
        'SUCCEEDED', 'FAILED', 'UNKNOWN')),

    -- Horodatages des transitions. Ils rendent le déroulé rejouable après
    -- coup : sans eux, on connaît l'état final mais pas le chemin.
    ADD COLUMN committed_at TIMESTAMPTZ,
    ADD COLUMN executing_at TIMESTAMPTZ,
    ADD COLUMN observed_at  TIMESTAMPTZ,

    -- Nombre d'exécutions RÉELLEMENT lancées. Doit rester à 1. S'il monte,
    -- c'est que le journal d'intention a été contourné.
    ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts >= 0),

    -- Ce que la reprise a pu constater, en clair. Jamais de donnée sensible.
    ADD COLUMN recovery_detail TEXT;

-- `status` est le verdict du Verification Engine : il n'existe pas tant que
-- rien n'a été observé. Il devient donc facultatif.
ALTER TABLE tool_operations ALTER COLUMN status DROP NOT NULL;

-- Les lignes antérieures n'étaient écrites qu'après succès : leur état final
-- est connu, et leur observation date de leur création.
UPDATE tool_operations
   SET observed_at = created_at,
       state = CASE status
                 WHEN 'FAILED'  THEN 'FAILED'
                 WHEN 'UNKNOWN' THEN 'UNKNOWN'
                 ELSE 'SUCCEEDED'
               END
 WHERE observed_at IS NULL;

-- Un état terminal a toujours été observé ; un état non terminal ne peut pas
-- porter de verdict. La base refuse l'incohérence plutôt que de compter sur
-- la discipline du code appelant.
ALTER TABLE tool_operations ADD CONSTRAINT terminal_states_are_observed CHECK (
    (state IN ('SUCCEEDED', 'FAILED', 'UNKNOWN')) = (observed_at IS NOT NULL)
);

ALTER TABLE tool_operations ADD CONSTRAINT verdict_only_when_observed CHECK (
    status IS NULL OR observed_at IS NOT NULL
);

-- Reprise après redémarrage : retrouver les opérations laissées en suspens.
CREATE INDEX tool_operations_pending_idx
    ON tool_operations (state, created_at)
    WHERE state NOT IN ('SUCCEEDED', 'FAILED', 'UNKNOWN');
