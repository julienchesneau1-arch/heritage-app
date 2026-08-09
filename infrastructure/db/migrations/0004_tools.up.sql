-- 0004 — Notes et registre d'opérations
--
-- Référence : 02 Phase 2, PRD §21 (idempotence), invariant S6.

-- --------------------------------------------------------------------------
-- Notes — support de l'outil note_create
-- --------------------------------------------------------------------------

CREATE TABLE notes (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content       TEXT NOT NULL CHECK (length(content) > 0),
    privacy_class TEXT NOT NULL DEFAULT 'ORANGE'
                      CHECK (privacy_class IN ('RED','ORANGE','GREEN')),
    project_id    UUID REFERENCES projects (id) ON DELETE SET NULL,
    operation_id  TEXT UNIQUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX notes_created_at_idx ON notes (created_at DESC);

-- --------------------------------------------------------------------------
-- Registre d'opérations — l'idempotence
--
-- POURQUOI CETTE TABLE NE STOCKE PAS LE RÉSULTAT
-- -----------------------------------------------
-- La tentation naturelle est de mémoriser la réponse pour la rejouer telle
-- quelle. On s'en garde : cela reviendrait à dupliquer des données
-- potentiellement sensibles dans une table technique, et surtout à renvoyer un
-- résultat qui n'est plus forcément vrai.
--
-- On mémorise donc l'IDENTIFIANT de la ressource produite. Un rejeu relit
-- l'état réel — c'est-à-dire qu'il emprunte exactement le chemin de
-- vérification. Deux bénéfices : aucune donnée dupliquée, et un rejeu ne peut
-- pas affirmer un succès que le monde ne confirme plus.
-- --------------------------------------------------------------------------

CREATE TABLE tool_operations (
    operation_id  TEXT PRIMARY KEY CHECK (length(operation_id) > 0),
    tool_id       TEXT NOT NULL,
    tool_version  TEXT NOT NULL,

    -- État de l'exécution, au sens du Verification Engine.
    status        TEXT NOT NULL CHECK (status IN (
                      'CONFIRMED','PROBABLE','UNKNOWN','FAILED')),

    -- Ressource produite ou modifiée, quand il y en a une.
    resource_kind TEXT,
    resource_id   TEXT,

    -- Empreinte des entrées : détecte une clé réutilisée avec des arguments
    -- différents, ce qui est un défaut d'appelant, pas un rejeu.
    input_digest  TEXT NOT NULL CHECK (input_digest ~ '^[0-9a-f]{64}$'),

    actor         TEXT NOT NULL CHECK (actor IN (
                      'USER','JARVIS','SYSTEM','AUTOMATION','EXTERNAL_SERVICE')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX tool_operations_tool_idx ON tool_operations (tool_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON notes, tool_operations TO jarvis_app;
