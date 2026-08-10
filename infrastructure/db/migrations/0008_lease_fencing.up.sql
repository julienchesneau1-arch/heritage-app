-- ==========================================================================
-- 0008 — Cloisonnement du bail (fencing)
--
-- Référence : ADR-035, `docs/23 §6` (défaut mesuré), `docs/24`.
--
-- LE DÉFAUT CORRIGÉ
-- -----------------
-- Mesuré en couche 01 :
--
--   opération en EXECUTING
--   B reprend et clôt        →  SUCCEEDED, « repris par B »
--   A, zombie, revient       →  UNKNOWN,   « écriture tardive de A »
--   état final               →  celui de A
--
-- Jarvis autorisait un exécutant dont l'autorité était expirée à modifier
-- l'état courant. Le système racontait l'histoire de A à propos d'un monde
-- façonné par B.
--
-- CE QUE LE CLOISONNEMENT PROTÈGE — ET CE QU'IL NE PROTÈGE PAS
-- ------------------------------------------------------------
--   protège      l'état interne de Jarvis contre ses anciens exécutants
--   ne protège   le monde extérieur contre une requête déjà partie
--   PAS
--
--   fencing ≠ annulation ≠ idempotence ≠ vérification ≠ absence d'effet
-- ==========================================================================

ALTER TABLE tool_operations
    -- LE JETON. Monotone, incrémenté à chaque prise ou reprise de bail dans
    -- le MÊME compare-and-swap : deux exécutants ne peuvent jamais obtenir la
    -- même génération.
    ADD COLUMN lease_generation INTEGER NOT NULL DEFAULT 0
        CHECK (lease_generation >= 0),

    -- Diagnostic uniquement. Ne participe à AUCUNE décision de sûreté : la
    -- génération suffit, puisqu'elle est frappée atomiquement. Sert à
    -- répondre à « quel processus a lancé cet appel ? ».
    ADD COLUMN lease_owner TEXT,

    -- Échéance DÉCIDÉE À L'ACQUISITION et stockée, plutôt que recalculée à
    -- chaque lecture depuis `executing_at + timeout`.
    --
    -- Estampillée avec `clock_timestamp()`, jamais `now()` : `now()` rend
    -- l'heure de DÉBUT de transaction, et une estampille née vieille ferait
    -- expirer le bail trop tôt — donc une reprise prématurée (`docs/23 §3.2`).
    --
    -- Le Gateway n'est de toute façon jamais dans la transaction d'un
    -- appelant (`docs/23 §3.4`) ; c'est une défense en profondeur, pas la
    -- protection principale.
    ADD COLUMN lease_expires_at TIMESTAMPTZ;

-- Rattrapage des lignes antérieures.
--
-- Une opération déjà en `EXECUTING` au moment de la migration n'a jamais eu de
-- bail. On lui en attribue un DÉJÀ EXPIRÉ plutôt qu'un bail courant : la
-- migration ne doit pas ressusciter l'autorité d'un exécutant dont plus
-- personne ne sait s'il existe. FAIL CLOSED appliqué à la migration.
UPDATE tool_operations
   SET lease_expires_at = COALESCE(executing_at, created_at)
 WHERE state = 'EXECUTING' AND lease_expires_at IS NULL;

-- Un bail détenu implique une échéance. L'inverse n'est pas vrai : une
-- opération close conserve sa dernière génération sans échéance courante.
ALTER TABLE tool_operations ADD CONSTRAINT lease_has_deadline CHECK (
    state <> 'EXECUTING' OR lease_expires_at IS NOT NULL
);

-- Reprise : retrouver les baux expirés sans balayer la table.
CREATE INDEX tool_operations_lease_idx
    ON tool_operations (lease_expires_at)
    WHERE state = 'EXECUTING';
