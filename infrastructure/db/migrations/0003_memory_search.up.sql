-- 0003 — Recherche hybride et mémoire de travail
--
-- Référence : ADR-001 (base unique), ADR-002 (trois voies + RRF), 02 Phase 1.
--
-- Les trois voies de récupération vivent dans la MÊME table :
--
--   structurée → colonnes et jointures classiques
--   lexicale   → `search_vector`, tsvector français généré
--   sémantique → `embedding`, pgvector
--
-- C'est tout l'intérêt d'ADR-001 : une mémoire et son embedding ne peuvent pas
-- se désynchroniser, puisqu'ils sont sur la même ligne, dans la même
-- transaction. Aucun job de synchronisation à écrire, à surveiller, ni à
-- réparer.

-- L'extension `vector` est créée par `pnpm db:bootstrap`, avec le
-- superutilisateur : le rôle de migration ne possède pas ce privilège, et ne
-- doit pas le posséder (moindre privilège). On vérifie donc sa présence plutôt
-- que de la créer ici.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
        RAISE EXCEPTION
            'Extension pgvector absente. Exécuter `pnpm db:bootstrap` (superutilisateur) avant cette migration.';
    END IF;
END
$$;

-- --------------------------------------------------------------------------
-- Voie lexicale et voie sémantique sur les mémoires
-- --------------------------------------------------------------------------

-- Dimension 768 : EmbeddingGemma-300M (08 §3.4). La troncature Matryoshka
-- permet de descendre à 512/256/128 sans réentraînement, mais PAS de monter.
-- Changer de famille de modèle vers une dimension supérieure (BGE-M3 = 1024)
-- exigera une migration et un réencodage complet — c'est le coût assumé de
-- l'indexation vectorielle, et il est documenté ici plutôt que découvert.
ALTER TABLE memories ADD COLUMN embedding vector(768);

-- Modèle ayant produit l'embedding. Sans cette colonne, un changement de modèle
-- rendrait la base incohérente en silence : des vecteurs de familles
-- différentes seraient comparés entre eux.
ALTER TABLE memories ADD COLUMN embedding_model TEXT;

ALTER TABLE memories ADD CONSTRAINT embedding_has_model
    CHECK ((embedding IS NULL) = (embedding_model IS NULL));

-- Colonne générée : impossible de la laisser diverger du contenu.
ALTER TABLE memories ADD COLUMN search_vector tsvector
    GENERATED ALWAYS AS (to_tsvector('french', content)) STORED;

CREATE INDEX memories_search_vector_idx ON memories USING GIN (search_vector);

-- HNSW plutôt qu'IVFFlat : pas de phase d'entraînement, donc utilisable dès la
-- première mémoire insérée. À notre échelle, la différence de rappel est sans
-- objet ; la simplicité d'exploitation ne l'est pas.
CREATE INDEX memories_embedding_idx ON memories
    USING hnsw (embedding vector_cosine_ops);

-- --------------------------------------------------------------------------
-- Alias d'entités — la matière première de la détection d'ambiguïté
--
-- « Pierre » doit pouvoir désigner trois personnes. Le Context Engine s'appuie
-- sur cette table pour DEMANDER au lieu de choisir (05/A3).
-- --------------------------------------------------------------------------

CREATE TABLE entity_aliases (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id  UUID NOT NULL REFERENCES entities (id) ON DELETE CASCADE,
    alias      TEXT NOT NULL CHECK (length(alias) > 0),
    -- Un alias explicitement confirmé par l'utilisateur pèse plus qu'un alias
    -- déduit d'un contenu externe.
    confirmed_by_user BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (entity_id, alias)
);

CREATE INDEX entity_aliases_alias_idx ON entity_aliases (lower(alias));

-- --------------------------------------------------------------------------
-- M1 — Mémoire de travail
--
-- Durée de vie : la session. Volontairement séparée des mémoires durables :
-- ce qui se dit dans une conversation ne devient pas un fait personnel sans
-- passer par le Memory Guard (03 §11).
-- --------------------------------------------------------------------------

CREATE TABLE sessions (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mode       TEXT NOT NULL DEFAULT 'NORMAL'
                   CHECK (mode IN ('NORMAL','PRIVATE','MEETING','DRIVING',
                                   'FOCUS','TRAVEL','HOME')),
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at   TIMESTAMPTZ
);

CREATE TABLE session_turns (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id   UUID NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    turn_index   INTEGER NOT NULL CHECK (turn_index >= 0),
    speaker      TEXT NOT NULL CHECK (speaker IN ('USER','JARVIS')),
    content      TEXT NOT NULL,
    -- Provenance du tour : un contenu externe lu à voix haute reste externe.
    provenance   TEXT NOT NULL DEFAULT 'USER'
                     CHECK (provenance IN ('USER','SYSTEM','MEMORY',
                                           'TOOL_OUTPUT','EXTERNAL_UNTRUSTED')),
    -- Entités mentionnées, pour la résolution de référents ultérieurs
    -- (« celui-ci », « le projet »).
    mentioned_entity_ids UUID[] NOT NULL DEFAULT '{}',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (session_id, turn_index)
);

CREATE INDEX session_turns_session_idx ON session_turns (session_id, turn_index DESC);

-- --------------------------------------------------------------------------
-- Déduplication
--
-- Le Memory Guard refuse d'écrire deux fois la même chose. L'empreinte est
-- calculée sur le contenu normalisé, côté application.
-- --------------------------------------------------------------------------

ALTER TABLE memories ADD COLUMN content_digest TEXT;

CREATE UNIQUE INDEX memories_content_digest_idx
    ON memories (content_digest, memory_type)
    WHERE content_digest IS NOT NULL AND state <> 'DELETED';

-- --------------------------------------------------------------------------
-- Permissions — moindre privilège maintenu sur les nouvelles tables
-- --------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON entity_aliases, sessions, session_turns
    TO jarvis_app;
