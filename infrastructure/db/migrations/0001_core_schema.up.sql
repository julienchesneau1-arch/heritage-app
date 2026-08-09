-- 0001 — Schéma mémoire initial
--
-- Référence : 00 §13 (modèle relationnel dans PostgreSQL), ADR-001.
-- Une seule base de vérité : entités, relations, mémoires, tâches, projets,
-- préférences, règles, décisions.
--
-- Les énumérations sont exprimées par CHECK plutôt que par des types ENUM :
-- une contrainte se modifie et se rollback sans réécriture de table.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- --------------------------------------------------------------------------
-- Entités et relations
-- --------------------------------------------------------------------------

CREATE TABLE entities (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind          TEXT NOT NULL CHECK (kind IN (
                      'PERSON','ORGANIZATION','PROJECT','PLACE','PRODUCT',
                      'DOCUMENT','EVENT','TASK','OBJECT','DEVICE','ACCOUNT')),
    display_name  TEXT NOT NULL CHECK (length(display_name) > 0),
    attributes    JSONB NOT NULL DEFAULT '{}'::jsonb,
    privacy_class TEXT NOT NULL DEFAULT 'ORANGE'
                      CHECK (privacy_class IN ('RED','ORANGE','GREEN')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX entities_kind_idx ON entities (kind);
CREATE INDEX entities_name_idx ON entities (lower(display_name));

CREATE TABLE relations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_id  UUID NOT NULL REFERENCES entities (id) ON DELETE CASCADE,
    predicate   TEXT NOT NULL CHECK (predicate IN (
                    'owns','knows','works_with','belongs_to','depends_on',
                    'related_to','mentioned_in','scheduled_for','created_by',
                    'assigned_to','located_at','prefers','prohibits')),
    object_id   UUID NOT NULL REFERENCES entities (id) ON DELETE CASCADE,
    confidence  REAL NOT NULL DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (subject_id, predicate, object_id)
);

CREATE INDEX relations_subject_idx ON relations (subject_id);
CREATE INDEX relations_object_idx  ON relations (object_id);

-- --------------------------------------------------------------------------
-- Mémoire
--
-- `kind` porte la distinction de 03 §11 : une affirmation externe est un
-- EXTERNAL_CLAIM, jamais un FACT. C'est une contrainte de base de données,
-- pas une convention applicative.
-- --------------------------------------------------------------------------

CREATE TABLE memories (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind             TEXT NOT NULL CHECK (kind IN (
                         'FACT','INFERENCE','HYPOTHESIS','EXTERNAL_CLAIM')),
    memory_type      TEXT NOT NULL CHECK (memory_type IN (
                         'EPISODIC','SEMANTIC','PREFERENCE','RULE',
                         'INTENT','DECISION')),
    content          TEXT NOT NULL CHECK (length(content) > 0),
    confidence       REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    source           TEXT NOT NULL,
    provenance       TEXT NOT NULL CHECK (provenance IN (
                         'USER','SYSTEM','MEMORY','TOOL_OUTPUT','EXTERNAL_UNTRUSTED')),
    privacy_class    TEXT NOT NULL DEFAULT 'ORANGE'
                         CHECK (privacy_class IN ('RED','ORANGE','GREEN')),
    state            TEXT NOT NULL DEFAULT 'ACTIVE'
                         CHECK (state IN ('ACTIVE','DORMANT','ARCHIVED','DELETED')),
    subject_entity_id UUID REFERENCES entities (id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_verified_at TIMESTAMPTZ,
    expires_at       TIMESTAMPTZ,

    -- Une affirmation externe ne peut pas naître confirmée. Si cette contrainte
    -- se déclenche, c'est une tentative d'empoisonnement de mémoire (T4).
    CONSTRAINT external_claim_never_verified
        CHECK (kind <> 'EXTERNAL_CLAIM' OR last_verified_at IS NULL)
);

CREATE INDEX memories_type_state_idx ON memories (memory_type, state);
CREATE INDEX memories_kind_idx       ON memories (kind);
CREATE INDEX memories_subject_idx    ON memories (subject_entity_id);

-- --------------------------------------------------------------------------
-- Projets et tâches
-- --------------------------------------------------------------------------

CREATE TABLE projects (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL UNIQUE CHECK (length(name) > 0),
    state       TEXT NOT NULL DEFAULT 'ACTIVE'
                    CHECK (state IN ('ACTIVE','DORMANT','ARCHIVED')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tasks (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title        TEXT NOT NULL CHECK (length(title) > 0),
    state        TEXT NOT NULL DEFAULT 'OPEN'
                     CHECK (state IN ('OPEN','DONE','CANCELLED')),
    due_at       TIMESTAMPTZ,
    project_id   UUID REFERENCES projects (id) ON DELETE SET NULL,
    -- Clé d'idempotence : deux créations issues du même énoncé n'en font qu'une.
    operation_id TEXT UNIQUE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX tasks_state_idx ON tasks (state);

-- --------------------------------------------------------------------------
-- Préférences, règles, décisions
-- --------------------------------------------------------------------------

CREATE TABLE preferences (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key         TEXT NOT NULL UNIQUE,
    value       JSONB NOT NULL,
    confidence  REAL NOT NULL DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
    -- Une préférence naît d'une confirmation, jamais d'une lecture (03 §11).
    confirmed_by_user BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE rules (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    statement   TEXT NOT NULL CHECK (length(statement) > 0),
    -- Rang dans la hiérarchie de 03 §5. Une règle apprise (USER/CONTEXTUAL)
    -- ne peut jamais assouplir une règle SYSTEM : c'est le Policy Gate qui
    -- l'applique, cette colonne le rend seulement explicite et auditable.
    tier        TEXT NOT NULL CHECK (tier IN ('SYSTEM','USER','CONTEXTUAL')),
    active      BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE decisions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    statement   TEXT NOT NULL CHECK (length(statement) > 0),
    rationale   TEXT,
    decided_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    project_id  UUID REFERENCES projects (id) ON DELETE SET NULL
);
