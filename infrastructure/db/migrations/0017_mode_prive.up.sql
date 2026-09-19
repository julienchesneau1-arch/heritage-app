-- ==========================================================================
-- 0017 — LE MODE PRIVÉ, PERSISTANT ET PARTAGÉ
--
-- Référence : ADR-106, `docs/02` Phase 4, `docs/03 §7`.
--
-- LE MANQUE QU'ELLE FERME
-- ------------------------
-- Le Policy Gate refuse toute égression quand `context.mode === 'PRIVATE'`.
-- La règle est écrite, testée — et **rien ne posait jamais ce mode**. Les deux
-- surfaces envoyaient `NORMAL`, donc le mode privé était un régime qu'aucune
-- phrase, aucun bouton et aucune commande ne pouvait atteindre.
--
-- `docs/02` en fait pourtant un livrable de Phase 4 :
--   « Mode privé (cloud OFF, réseau externe OFF, indicateur visible). »
--
-- ⚠ POURQUOI UNE TABLE, ET PAS UNE VARIABLE EN MÉMOIRE
-- -----------------------------------------------------
-- Le CLI et la passerelle web sont **deux processus distincts**. Un booléen en
-- mémoire leur donnerait deux modes privés : le téléphone se croirait protégé
-- pendant que le terminal laisserait sortir. Deux registres du même fait
-- finissent par diverger, et le jour où ils divergent, aucun ne fait autorité
-- (ADR-041).
--
-- Ici le fait est « est-ce que quelque chose peut sortir de la machine », et la
-- divergence a un nom : une fuite que l'utilisateur croyait impossible.
--
-- ⚠ ET LA FORME EST CELLE D'`emergency_halt`, DÉLIBÉRÉMENT
-- ---------------------------------------------------------
-- Une HISTOIRE, pas un interrupteur. On veut pouvoir répondre à « depuis
-- quand ? » et « qui l'a levé ? » — c'est ce que `/audit` doit savoir raconter,
-- et c'est ce qu'un `UPDATE` sur une ligne unique effacerait à chaque bascule.
-- ==========================================================================

CREATE TABLE mode_prive (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    active_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    active_par   TEXT NOT NULL,
    -- Ce que l'utilisateur a dit, ou ce que la configuration a demandé. Une
    -- activation sans motif ne se relit pas trois jours plus tard.
    motif        TEXT NOT NULL CHECK (length(motif) > 0),

    levee_at     TIMESTAMPTZ,
    levee_par    TEXT,
    levee_note   TEXT,

    -- Levée : les trois champs ensemble, ou aucun. L'état intermédiaire — levé
    -- sans dire par qui ni pourquoi — n'a aucun sens, et la base le refuse
    -- plutôt que de compter sur l'appelant.
    CONSTRAINT mode_prive_levee_coherente CHECK (
        (levee_at IS NULL AND levee_par IS NULL AND levee_note IS NULL)
     OR (levee_at IS NOT NULL AND levee_par IS NOT NULL AND levee_note IS NOT NULL)
    )
);

-- ⚠ UN SEUL MODE PRIVÉ ACTIF À LA FOIS, garanti par la base.
--
-- Sans cet index, « passe en mode privé » répété trois fois par quelqu'un qui
-- n'est pas sûr créerait trois lignes, et la LEVÉE n'en fermerait qu'une :
-- Jarvis resterait privé après qu'on lui a dit d'arrêter, sans que rien ne
-- l'explique. L'unicité est donc une propriété de la table, pas une discipline
-- d'appelant.
CREATE UNIQUE INDEX mode_prive_un_seul_actif
    ON mode_prive ((levee_at IS NULL))
    WHERE levee_at IS NULL;

-- Pas de DELETE : une bascule de confidentialité ne s'efface pas. Savoir que
-- le mode privé a été levé mardi à 14 h fait partie de ce que le journal doit
-- pouvoir raconter.
GRANT SELECT, INSERT, UPDATE ON mode_prive TO jarvis_app;
