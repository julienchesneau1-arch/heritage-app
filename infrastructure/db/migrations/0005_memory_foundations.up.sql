-- 0005 — Fondations de données irrattrapables
--
-- Référence : 09 §2.1. Les cinq décisions que reporter coûte cher, parce
-- qu'elles portent toutes sur la mémoire — la seule partie du système qui
-- accumule des données qu'on ne peut pas régénérer.
--
-- Cette migration ne construit AUCUNE interface. Elle pose uniquement ce qui
-- doit exister avant la première donnée réelle.

-- ==========================================================================
-- 1. TAXONOMIE DE SOURCE  (09 §2.1 / proposition n°10)
--
-- DEUX AXES DISTINCTS, ET LA DISTINCTION EST LE POINT
-- ---------------------------------------------------
--   `provenance`  — axe de SÉCURITÉ. Répond à « cette valeur peut-elle
--                   alimenter un paramètre sensible ? ». Consommé par le
--                   Policy Gate. On n'y touche pas : c'est un mécanisme de
--                   défense éprouvé (03 §3).
--
--   `source_type` — axe ÉPISTÉMIQUE. Répond à « comment le sait-on ? ».
--                   Nouveau. C'est lui qui manquait.
--
-- Sans ce second axe, « Julien préfère le matin » déclaré par Julien et
-- « Julien préfère le matin » déduit de ses propos sont indistinguables une
-- fois écrits. Dans six mois, impossible de savoir lequel des deux on lit.
-- ==========================================================================

ALTER TABLE memories ADD COLUMN source_type TEXT
    CHECK (source_type IN (
        'USER_EXPLICIT',    -- Julien l'a dit, et confirmé
        'USER_INFERRED',    -- déduit de ses propos, non confirmé
        'MODEL_INFERRED',   -- déduit par un modèle
        'TOOL_VERIFIED',    -- constaté par un outil contre l'état réel
        'EXTERNAL_SOURCE',  -- affirmé par un email, un PDF, une page web
        'SYSTEM'            -- produit par le noyau lui-même
    ));

-- Reprise des lignes existantes depuis l'axe de sécurité. La reprise est
-- volontairement PESSIMISTE : `USER` devient `USER_INFERRED`, jamais
-- `USER_EXPLICIT`. On ne peut pas savoir rétroactivement si la confirmation
-- avait eu lieu, et inventer une certitude serait exactement le défaut que
-- cette colonne existe pour corriger.
UPDATE memories SET source_type = CASE provenance
    WHEN 'USER'               THEN 'USER_INFERRED'
    WHEN 'TOOL_OUTPUT'        THEN 'TOOL_VERIFIED'
    WHEN 'EXTERNAL_UNTRUSTED' THEN 'EXTERNAL_SOURCE'
    WHEN 'SYSTEM'             THEN 'SYSTEM'
    WHEN 'MEMORY'             THEN 'SYSTEM'
    ELSE 'MODEL_INFERRED'
END
WHERE source_type IS NULL;

ALTER TABLE memories ALTER COLUMN source_type SET NOT NULL;

CREATE INDEX memories_source_type_idx ON memories (source_type);

-- Cohérence entre les deux axes : une source externe ne peut pas être portée
-- par une provenance de confiance, et réciproquement. La base refuse la
-- combinaison incohérente plutôt que de la laisser s'installer.
ALTER TABLE memories ADD CONSTRAINT source_matches_provenance CHECK (
    (source_type = 'EXTERNAL_SOURCE') = (provenance = 'EXTERNAL_UNTRUSTED')
);


-- ==========================================================================
-- 2. CATÉGORIE DE DONNÉE  (09 §2.1 / proposition n°4)
--
-- Clé de la future Data Policy. La proposition demandait une table
-- « donnée × local/cloud » ; cette table est facile à ajouter plus tard, mais
-- elle a besoin d'une clé — et cette clé doit être renseignée À L'ÉCRITURE.
-- Une mémoire écrite sans catégorie restera sans catégorie.
-- ==========================================================================

ALTER TABLE memories ADD COLUMN data_category TEXT NOT NULL DEFAULT 'OTHER'
    CHECK (data_category IN (
        'WEATHER', 'TASK', 'CALENDAR', 'CONTACT', 'LOCATION',
        'EMAIL', 'MESSAGE', 'DOCUMENT',
        'FINANCIAL', 'HEALTH', 'CREDENTIAL',
        'PERSONAL_MEMORY', 'PROJECT', 'OTHER'
    ));

CREATE INDEX memories_data_category_idx ON memories (data_category);

-- Garde-fou de classification : certaines catégories ne peuvent pas être
-- classées autrement que RED. La règle « les secrets ne sortent jamais »
-- devient une contrainte de base, pas une convention applicative.
ALTER TABLE memories ADD CONSTRAINT sensitive_categories_are_red CHECK (
    data_category NOT IN ('CREDENTIAL', 'FINANCIAL', 'HEALTH')
    OR privacy_class = 'RED'
);


-- ==========================================================================
-- 3. CAPTURE D'ÉTAT ANTÉRIEUR  (09 §2.1 / proposition n°6)
--
-- Fondation de l'Undo Engine. L'INTERFACE viendra plus tard ; la CAPTURE ne
-- se rattrape pas. Une action exécutée sans capture est définitivement non
-- annulable.
--
-- DEUX MÉCANIQUES, ET LA DISTINCTION ÉVITE DE DUPLIQUER DES DONNÉES
-- ------------------------------------------------------------------
--   INVERSE_OPERATION — pour une création. Annuler = supprimer. On stocke
--                       l'appel inverse, aucune donnée métier n'est copiée.
--   STATE_RESTORE     — pour une modification. Annuler exige les anciennes
--                       valeurs : là, et seulement là, on les copie.
--
-- Cette distinction n'est pas cosmétique : elle évite de dupliquer le contenu
-- de chaque création dans une table technique, avec les problèmes de
-- confidentialité et de suppression que cela poserait.
-- ==========================================================================

CREATE TABLE action_snapshots (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    operation_id  TEXT NOT NULL UNIQUE,

    resource_kind TEXT NOT NULL,
    resource_id   TEXT NOT NULL,

    undo_kind     TEXT NOT NULL CHECK (undo_kind IN (
                      'INVERSE_OPERATION',
                      'STATE_RESTORE',
                      'NOT_UNDOABLE')),

    -- Pour INVERSE_OPERATION : l'appel qui défait.
    inverse_tool_id TEXT,
    inverse_input   JSONB,

    -- Pour STATE_RESTORE : les valeurs antérieures. Porte sa propre classe de
    -- confidentialité, car elle peut contenir de la donnée sensible.
    prior_state     JSONB,
    privacy_class   TEXT NOT NULL DEFAULT 'ORANGE'
                        CHECK (privacy_class IN ('RED','ORANGE','GREEN')),

    -- Un instantané n'est pas un archivage : il expire. Sinon la table
    -- devient une copie permanente et non gouvernée de la base.
    expires_at    TIMESTAMPTZ NOT NULL,

    undone_at         TIMESTAMPTZ,
    undo_operation_id TEXT,

    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Chaque mécanique exige ses champs. Une capture incomplète est une
    -- capture inutilisable : autant le refuser à l'écriture.
    CONSTRAINT inverse_operation_is_complete CHECK (
        undo_kind <> 'INVERSE_OPERATION'
        OR (inverse_tool_id IS NOT NULL AND inverse_input IS NOT NULL)
    ),
    CONSTRAINT state_restore_is_complete CHECK (
        undo_kind <> 'STATE_RESTORE' OR prior_state IS NOT NULL
    )
);

CREATE INDEX action_snapshots_undoable_idx
    ON action_snapshots (created_at DESC)
    WHERE undone_at IS NULL AND undo_kind <> 'NOT_UNDOABLE';

CREATE INDEX action_snapshots_expiry_idx ON action_snapshots (expires_at);


-- ==========================================================================
-- 4. REGISTRE DES DÉRIVÉS  (09 §2.1 / proposition n°11)
--
-- « Oublie ça » doit réellement tout supprimer : mémoire, embedding, entrées
-- d'index, caches, exports.
--
-- Aujourd'hui l'embedding vit sur la même ligne, donc il disparaît en
-- cascade. Ce ne sera plus vrai au premier index externe ou au premier cache.
-- Le registre existe pour que la garantie de suppression reste vraie quand
-- l'architecture s'étendra — et non pour qu'on découvre alors qu'on ne sait
-- plus où sont les copies.
-- ==========================================================================

CREATE TABLE memory_derivatives (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    memory_id       UUID NOT NULL REFERENCES memories (id) ON DELETE CASCADE,

    derivative_kind TEXT NOT NULL CHECK (derivative_kind IN (
                        'EMBEDDING', 'INDEX_ENTRY', 'CACHE', 'EXPORT', 'BACKUP')),

    -- Où se trouve le dérivé : « memories.embedding », un chemin, une clé de
    -- cache. Assez précis pour qu'un processus de suppression sache agir.
    locator         TEXT NOT NULL CHECK (length(locator) > 0),

    -- Vrai si le dérivé disparaît avec la ligne mémoire. Faux = une action
    -- explicite est nécessaire à la suppression.
    cascades        BOOLEAN NOT NULL DEFAULT false,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (memory_id, derivative_kind, locator)
);

CREATE INDEX memory_derivatives_memory_idx ON memory_derivatives (memory_id);
CREATE INDEX memory_derivatives_manual_idx ON memory_derivatives (derivative_kind)
    WHERE cascades = false;


-- ==========================================================================
-- 5. MEMORY INBOX  (09 §2.1 / proposition n°9)
--
-- Aujourd'hui, une préférence non confirmée est REFUSÉE — et perdue. Jarvis
-- ne pourra jamais dire « j'ai remarqué ceci, dois-je le retenir ? ».
--
-- Sans file d'attente, chaque mois d'usage avant l'ajout de l'Inbox est un
-- mois d'apprentissage non rattrapable. La table existe donc maintenant, même
-- si l'interface de confirmation viendra plus tard.
-- ==========================================================================

CREATE TABLE memory_candidates (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    content             TEXT NOT NULL CHECK (length(content) > 0),
    memory_type         TEXT NOT NULL CHECK (memory_type IN (
                            'EPISODIC','SEMANTIC','PREFERENCE','RULE',
                            'INTENT','DECISION')),
    source_type         TEXT NOT NULL CHECK (source_type IN (
                            'USER_EXPLICIT','USER_INFERRED','MODEL_INFERRED',
                            'TOOL_VERIFIED','EXTERNAL_SOURCE','SYSTEM')),
    source              TEXT NOT NULL,
    provenance          TEXT NOT NULL CHECK (provenance IN (
                            'USER','SYSTEM','MEMORY','TOOL_OUTPUT','EXTERNAL_UNTRUSTED')),
    privacy_class       TEXT NOT NULL DEFAULT 'ORANGE'
                            CHECK (privacy_class IN ('RED','ORANGE','GREEN')),
    data_category       TEXT NOT NULL DEFAULT 'OTHER',
    suggested_confidence REAL NOT NULL CHECK (
                            suggested_confidence >= 0 AND suggested_confidence <= 1),
    subject_entity_id   UUID REFERENCES entities (id) ON DELETE SET NULL,

    state               TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN (
                            'PENDING','CONFIRMED','REJECTED','EXPIRED')),

    -- Déduplication : la même observation répétée dix fois ne remplit pas
    -- l'Inbox de dix cartes identiques.
    content_digest      TEXT NOT NULL,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at          TIMESTAMPTZ,
    -- Un candidat non traité expire. Une Inbox qui gonfle indéfiniment cesse
    -- d'être consultée, donc cesse de servir.
    expires_at          TIMESTAMPTZ NOT NULL,

    resulting_memory_id UUID REFERENCES memories (id) ON DELETE SET NULL,

    -- Un candidat décidé doit dire quand, et un candidat confirmé doit dire
    -- ce qu'il est devenu.
    CONSTRAINT decided_has_timestamp CHECK (
        (state = 'PENDING') = (decided_at IS NULL)
    ),
    CONSTRAINT confirmed_has_memory CHECK (
        state <> 'CONFIRMED' OR resulting_memory_id IS NOT NULL
    )
);

CREATE UNIQUE INDEX memory_candidates_pending_digest_idx
    ON memory_candidates (content_digest, memory_type)
    WHERE state = 'PENDING';

CREATE INDEX memory_candidates_pending_idx
    ON memory_candidates (created_at DESC) WHERE state = 'PENDING';


-- ==========================================================================
-- Permissions
-- ==========================================================================

GRANT SELECT, INSERT, UPDATE, DELETE
    ON action_snapshots, memory_derivatives, memory_candidates
    TO jarvis_app;
