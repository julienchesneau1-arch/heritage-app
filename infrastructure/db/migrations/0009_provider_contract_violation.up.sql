-- ==========================================================================
-- 0009 — PROVIDER_CONTRACT_VIOLATION, et l'alignement type ↔ schéma
--
-- Référence : ADR-038, `docs/22 §9`, `docs/27`.
--
-- DEUX CHOSES, ET LA SECONDE A ÉTÉ TROUVÉE EN FAISANT LA PREMIÈRE
-- ---------------------------------------------------------------
-- 1. Un état terminal nouveau est nécessaire. `PROVIDER_CONTRACT_VIOLATION`
--    ne qualifie pas l'ACTION mais LA SOURCE, et il est plus fort
--    qu'`UNKNOWN` : on ignore ce qui s'est passé, ET on sait que la source
--    n'est plus fiable.
--
-- 2. La contrainte n'autorisait que quatre statuts :
--
--        'CONFIRMED','PROBABLE','UNKNOWN','FAILED'
--
--    alors que `VerificationStatus` en déclarait SIX depuis Foundation 3.
--    `PARTIAL` et `NOT_ATTEMPTED` auraient été REFUSÉS PAR LA BASE.
--
--    C'était une seconde raison, indépendante et non documentée, pour
--    laquelle `PARTIAL` était inatteignable — `docs/26 §4.1` n'en connaissait
--    qu'une. Un type et un schéma qui divergent en silence, c'est exactement
--    la validation aux frontières que le pack impose (ADR-016) prise en
--    défaut à l'intérieur.
-- ==========================================================================

ALTER TABLE tool_operations DROP CONSTRAINT IF EXISTS tool_operations_status_check;

ALTER TABLE tool_operations ADD CONSTRAINT tool_operations_status_check CHECK (
    status IN (
        'CONFIRMED',      -- preuve POSITIVE que l'effet a eu lieu
        'PROBABLE',       -- le fournisseur atteste, aucune relecture
        'PARTIAL',        -- certaines cibles confirmées (ADR-031)
        'UNKNOWN',        -- aucune preuve suffisante, dans un sens ni l'autre
        'FAILED',         -- preuve POSITIVE d'absence
        'NOT_ATTEMPTED',  -- rien n'a été tenté
        -- Ne qualifie pas l'action : la SOURCE. Le fournisseur a rompu un
        -- contrat qu'il annonçait tenir. On ignore l'issue de l'action, et on
        -- sait en plus qu'on ne peut plus le croire.
        'PROVIDER_CONTRACT_VIOLATION'
    )
);

-- Retrouver les ruptures de confiance sans balayer la table : c'est la
-- question « ce fournisseur a-t-il déjà menti ? », posée avant chaque action.
CREATE INDEX tool_operations_trust_breach_idx
    ON tool_operations (tool_id)
    WHERE status = 'PROVIDER_CONTRACT_VIOLATION';

-- --------------------------------------------------------------------------
-- LA MÊME DIVERGENCE, DANS LE JOURNAL — trouvée en exécutant le premier test
-- byzantin, pas en relisant le schéma.
--
-- `event_ledger.status` portait la MÊME contrainte à quatre valeurs. Le
-- registre acceptait le verdict, le journal le refusait — et l'opération
-- entière échouait en `INTERNAL`, c'est-à-dire de la pire des façons : une
-- rupture de confiance qui fait planter au lieu d'être consignée.
--
-- Le journal reste APPEND-ONLY et CHAÎNÉ : élargir un CHECK ne réécrit aucune
-- ligne et ne touche à aucun maillon de la chaîne de hachage.
-- --------------------------------------------------------------------------

ALTER TABLE event_ledger DROP CONSTRAINT IF EXISTS event_ledger_status_check;

ALTER TABLE event_ledger ADD CONSTRAINT event_ledger_status_check CHECK (
    status IN (
        'CONFIRMED','PROBABLE','PARTIAL','UNKNOWN','FAILED','NOT_ATTEMPTED',
        'PROVIDER_CONTRACT_VIOLATION'
    )
);
