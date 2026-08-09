-- 0002 — Event Ledger append-only, chaîné par hash
--
-- Référence : ADR-012, 03 §2 (S6, S7), 00 §I4.
--
-- Le journal est la seule source de vérité quand le modèle affirme avoir fait
-- quelque chose. S'il est modifiable, la propriété « Jarvis répond depuis son
-- journal » ne vaut rien. L'immuabilité est donc imposée à DEUX niveaux :
--
--   1. PERMISSIONS  — le rôle applicatif n'a ni UPDATE ni DELETE. C'est la
--                     garantie exigée par ADR-012 : elle tient même si tout le
--                     code applicatif est compromis.
--   2. TRIGGER      — refuse UPDATE/DELETE/TRUNCATE quel que soit le rôle,
--                     y compris le propriétaire. Défense en profondeur contre
--                     l'erreur humaine et l'accident de maintenance.
--
-- Le journal ne stocke JAMAIS le contenu métier, seulement son empreinte
-- (`payload_digest`). C'est ce qui permet à 03 §12 d'exiger une suppression de
-- mémoire qui laisse une trace d'audit sans conserver la donnée supprimée.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jarvis_app') THEN
        RAISE EXCEPTION
            'Le rôle jarvis_app est absent. Exécuter `pnpm db:bootstrap` avant les migrations.';
    END IF;
END
$$;

CREATE TABLE event_ledger (
    seq             BIGSERIAL PRIMARY KEY,
    event_id        UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    actor           TEXT NOT NULL CHECK (actor IN (
                        'USER','JARVIS','SYSTEM','AUTOMATION','EXTERNAL_SERVICE')),
    event_type      TEXT NOT NULL CHECK (length(event_type) > 0),

    intent          TEXT,
    tool            TEXT,

    -- Décision de politique ayant autorisé (ou refusé) l'action.
    policy_decision TEXT CHECK (policy_decision IN ('ALLOW','DENY','CONFIRM')),
    autonomy_level  TEXT CHECK (autonomy_level IN ('L0','L1','L2','L3','L4')),

    -- Honnêteté systémique : ces quatre états ne se promeuvent jamais l'un vers
    -- l'autre après écriture, puisque la ligne est immuable.
    status          TEXT NOT NULL CHECK (status IN (
                        'CONFIRMED','PROBABLE','UNKNOWN','FAILED')),
    -- Preuve fournie par le fournisseur : identifiant de message, etc.
    proof           TEXT,

    model           TEXT,
    cost_eur        NUMERIC(12,6) NOT NULL DEFAULT 0 CHECK (cost_eur >= 0),

    -- S6 — toute mutation porte un identifiant d'opération.
    operation_id    TEXT,

    -- Empreinte du contenu, jamais le contenu (03 §12).
    payload_digest  TEXT NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),

    -- Chaînage. La ligne de genèse porte prev_hash = 64 zéros.
    prev_hash       TEXT NOT NULL CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
    hash            TEXT NOT NULL UNIQUE CHECK (hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX event_ledger_occurred_at_idx  ON event_ledger (occurred_at DESC);
CREATE INDEX event_ledger_event_type_idx   ON event_ledger (event_type);
CREATE INDEX event_ledger_operation_id_idx ON event_ledger (operation_id)
    WHERE operation_id IS NOT NULL;

-- --------------------------------------------------------------------------
-- Niveau 2 : le trigger. S'applique à tous les rôles, propriétaire compris.
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION event_ledger_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION
        'event_ledger est append-only (ADR-012) : % refusé.', TG_OP
        USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER event_ledger_no_update
    BEFORE UPDATE ON event_ledger
    FOR EACH ROW EXECUTE FUNCTION event_ledger_immutable();

CREATE TRIGGER event_ledger_no_delete
    BEFORE DELETE ON event_ledger
    FOR EACH ROW EXECUTE FUNCTION event_ledger_immutable();

CREATE TRIGGER event_ledger_no_truncate
    BEFORE TRUNCATE ON event_ledger
    FOR EACH STATEMENT EXECUTE FUNCTION event_ledger_immutable();

-- --------------------------------------------------------------------------
-- Niveau 1 : les permissions. C'est la garantie exigée par ADR-012.
-- --------------------------------------------------------------------------

-- Moindre privilège sur l'ensemble du schéma : rien par défaut, puis on ouvre.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM jarvis_app;

GRANT USAGE ON SCHEMA public TO jarvis_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON
    entities, relations, memories, projects, tasks, preferences, rules, decisions
    TO jarvis_app;

-- Le journal : lecture et ajout uniquement. Jamais UPDATE, jamais DELETE.
GRANT SELECT, INSERT ON event_ledger TO jarvis_app;
GRANT USAGE, SELECT ON SEQUENCE event_ledger_seq_seq TO jarvis_app;

-- Verrou d'ordonnancement du chaînage (voir src/core/ledger/ledger.ts).
-- pg_advisory_xact_lock est exécutable par tout rôle connecté ; aucune
-- permission supplémentaire n'est requise.
