-- ==========================================================================
-- 0014 — L'arrêt d'urgence
--
-- Référence : `docs/05 §C2` (CRITIQUE), ADR-057.
--
-- POURQUOI 0014 ET PAS 0013
-- --------------------------
-- Le numéro 0013 est RÉSERVÉ à `data_level`, qui vit délibérément dans
-- `migrations-en-attente/` : c'est la seule migration du dépôt dont l'erreur
-- expose une donnée, et `docs/14 §5` exige une relecture humaine ligne par
-- ligne (ADR-053, marche à suivre en `docs/29`). Lui reprendre son numéro
-- obligerait à réécrire ce runbook — et un runbook réécrit est un runbook
-- qu'on relit moins bien.
--
-- POURQUOI EN BASE, ET PAS EN MÉMOIRE DU PROCESSUS
-- -------------------------------------------------
-- Un arrêt que le redémarrage efface n'est pas un arrêt d'urgence. Le cas est
-- précisément celui où l'on appuie sur le bouton : quelque chose va mal, le
-- processus peut tomber, et Jarvis se réveillerait en reprenant ses actions.
--
-- POURQUOI UNE HISTOIRE, ET PAS UN BOOLÉEN
-- -----------------------------------------
-- Un drapeau `halted` répondrait « est-ce arrêté ? » et rien d'autre. Les
-- questions qui comptent après coup sont « qui a arrêté, quand, pourquoi, et
-- qui a relevé l'arrêt ». Une ligne par engagement les porte toutes, et le
-- `docs/12` (vérité et traçabilité) l'exige pour toute décision de sûreté.
--
-- L'état courant est donc DÉRIVÉ : arrêté ⇔ il existe une ligne non relevée.
-- ==========================================================================

CREATE TABLE emergency_halt (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- QUI et QUAND. `now()` — l'instant de la transaction : deux lignes
    -- écrites dans la même transaction doivent porter le même instant.
    engaged_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    engaged_by    TEXT NOT NULL CHECK (engaged_by IN (
                      'USER','JARVIS','SYSTEM','AUTOMATION','EXTERNAL_SERVICE')),

    -- POURQUOI. Obligatoire : un arrêt sans motif est ingérable une heure plus
    -- tard, quand il faut décider de le relever.
    reason        TEXT NOT NULL CHECK (length(reason) > 0),

    -- La levée. `NULL` tant que l'arrêt tient.
    released_at   TIMESTAMPTZ,
    released_by   TEXT CHECK (released_by IN (
                      'USER','JARVIS','SYSTEM','AUTOMATION','EXTERNAL_SERVICE')),

    -- Les deux vont ENSEMBLE ou pas du tout. Une levée sans auteur laisserait
    -- croire que personne n'a décidé — or quelqu'un a décidé.
    CONSTRAINT release_fields_together CHECK (
        (released_at IS NULL AND released_by IS NULL)
     OR (released_at IS NOT NULL AND released_by IS NOT NULL)
    )
);

-- UN SEUL ARRÊT ACTIF À LA FOIS.
--
-- Sans cette contrainte, deux engagements concurrents produiraient deux lignes
-- ouvertes : lever la première laisserait Jarvis arrêté sans que personne ne
-- comprenne pourquoi, et lever les deux exigerait de savoir qu'elles
-- existaient. L'index partiel unique le rend impossible en base plutôt qu'en
-- discipline applicative.
CREATE UNIQUE INDEX emergency_halt_one_active_idx
    ON emergency_halt ((released_at IS NULL))
    WHERE released_at IS NULL;

-- La question posée à chaque appel d'outil : « y a-t-il un arrêt actif ? »
CREATE INDEX emergency_halt_active_idx ON emergency_halt (released_at)
    WHERE released_at IS NULL;

/* PAS DE DELETE POUR LE RÔLE APPLICATIF.

   L'histoire des arrêts est une trace de sûreté au sens de `docs/12`. Un
   arrêt effacé, c'est un incident dont il ne reste rien — exactement ce que
   `docs/05 §C2` interdit en exigeant que le **journal soit conservé**. */
GRANT SELECT, INSERT, UPDATE ON emergency_halt TO jarvis_app;
