-- ==========================================================================
-- 0011 — Les rappels
--
-- Référence : `docs/02 §Phase 3`, ADR-048.
--
-- L'ARBITRAGE QUI PRÉCÈDE CETTE TABLE
-- ------------------------------------
-- `docs/02` liste `reminder_create` parmi les dix outils de Phase 3. Or
-- **aucun ordonnanceur n'existe dans le dépôt, et aucun canal de
-- notification** : mesuré avant d'écrire, il n'y a ni tâche planifiée, ni
-- minuterie applicative, ni sortie vers un téléphone.
--
-- Un « rappel » qui ne sonne pas est un mensonge porté par son nom — la
-- règle 3 (« jamais de succès non vérifié ») appliquée à une promesse plutôt
-- qu'à un effet.
--
-- La table existe quand même, pour une raison qui se mesure : `briefing_generate`
-- existe. Un rappel dont l'échéance tombe aujourd'hui apparaît quand on
-- demande « prépare ma journée ». Il ne SONNE pas, il SE PRÉSENTE — et l'outil
-- le dit avec ces mots plutôt que de laisser croire au contraire.
--
-- Le jour où un ordonnanceur arrivera, les rappels seront déjà là.
-- ==========================================================================

CREATE TABLE reminders (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    text          TEXT NOT NULL CHECK (length(text) > 0),
    remind_at     TIMESTAMPTZ NOT NULL,

    state         TEXT NOT NULL DEFAULT 'PENDING'
                      CHECK (state IN ('PENDING','DONE','CANCELLED')),

    -- Clé d'idempotence, comme `tasks` et `notes` : deux créations issues du
    -- même énoncé n'en font qu'une.
    operation_id  TEXT UNIQUE,

    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Le briefing lit « ce qui tombe aujourd'hui » : c'est l'accès qui compte.
CREATE INDEX reminders_due_idx ON reminders (state, remind_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON reminders TO jarvis_app;
