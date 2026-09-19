-- ==========================================================================
-- 0018 — CE QUE JARVIS VIENT DE MONTRER
--
-- Référence : ADR-107, `docs/05 §A2`.
--
-- LE MANQUE QU'ELLE FERME
-- ------------------------
-- « Marque la première comme faite » suppose qu'une PREMIÈRE existe. Jarvis
-- affichait des listes et n'en gardait aucune trace : la sortie d'un outil
-- vivait le temps d'une réponse HTTP, puis disparaissait.
--
-- Le banc de fluidité le mesurait sans le nommer : `REFERENCE 0/8`. Huit tours
-- sur trente désignent une chose sans la renommer — c'est ce qui fait qu'une
-- conversation est une conversation, et non une suite d'ordres.
--
-- ⚠ CE N'EST PAS UN SECOND REGISTRE DES DONNÉES
-- ----------------------------------------------
-- Cette table ne copie ni les tâches ni les mémoires : elle enregistre un
-- ÉVÉNEMENT DE PRÉSENTATION — « à cet instant, dans cette conversation, ces
-- identités ont été montrées dans cet ordre ». C'est un fait dont il n'existe
-- aucune autre trace, pas le double d'un fait existant (ADR-041).
--
-- ⚠ ET LES IDENTITÉS SONT REVALIDÉES À LA RÉSOLUTION
-- ---------------------------------------------------
-- Une tâche montrée il y a dix minutes a pu être terminée, supprimée, ou
-- modifiée depuis. Cette table dit ce qui a été MONTRÉ, jamais ce qui EXISTE :
-- l'outil visé refera son propre contrôle, et le Policy Gate le sien.
--
-- ⚠ UNE SEULE LIGNE PAR SESSION
-- ------------------------------
-- « La première » désigne la dernière liste vue, pas une liste parmi
-- plusieurs. Conserver un historique inviterait à résoudre un ordinal contre
-- un affichage que l'utilisateur ne regarde plus — exactement l'ambiguïté que
-- `docs/05 §A2` interdit de trancher par supposition.
-- ==========================================================================

CREATE TABLE dernier_affichage (
    session_id  UUID PRIMARY KEY
                REFERENCES sessions (id) ON DELETE CASCADE,

    -- L'outil qui a produit la liste. Sert à refuser un ordinal dont le GENRE
    -- ne correspond pas : « supprime la deuxième » après une recherche en
    -- mémoire et après une liste de tâches ne désignent pas la même chose.
    tool_id     TEXT NOT NULL CHECK (length(tool_id) > 0),

    -- Les éléments, DANS L'ORDRE AFFICHÉ. Un tableau JSON de
    -- { id, genre, libelle } — la position est l'index, pas un champ : la
    -- stocker serait se donner deux façons de dire la même chose.
    elements    JSONB NOT NULL,

    montre_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON dernier_affichage TO jarvis_app;
