-- ==========================================================================
-- 0010 — Le registre de dépense cloud
--
-- Référence : `docs/04 §9-11`, `docs/14 §4`, ADR-040.
--
-- POURQUOI CETTE TABLE EXISTE
-- ---------------------------
-- `docs/04` pose « 0 € récurrent » comme invariant. Il était tenu PAR ABSENCE
-- DE DÉPENSE — aucun fournisseur cloud n'est branché — et non PAR MÉCANISME.
-- Un invariant qui repose sur le fait que rien n'est branché cesse d'être un
-- invariant au premier branchement.
--
-- LA MONNAIE EST EN ENTIERS, ET CE N'EST PAS UN DÉTAIL
-- -----------------------------------------------------
-- `cost_micros` = millionièmes d'euro, en BIGINT.
--
-- Un budget en flottant dérive : additionner dix mille appels à 0,0001 € ne
-- rend pas exactement 1 €, et « blocage dur à 100 % » devient « blocage dur
-- vers 100 % ». Sur un seuil, l'approximation N'EST PAS acceptable — c'est
-- exactement le genre de défaut qu'on ne voit qu'après le dépassement.
--
-- Un micro-euro suffit : l'appel cloud le moins cher du marché coûte plusieurs
-- centaines de micro-euros.
-- ==========================================================================

CREATE TABLE cloud_spend (
    id                BIGSERIAL PRIMARY KEY,

    -- Estampillé PAR LA BASE — I19. Le calcul du mois en cours compare cette
    -- colonne à `date_trunc('month', clock_timestamp())` ; une estampille
    -- frappée par le processus rendrait le budget dépendant de l'horloge de
    -- l'appelant.
    occurred_at       TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

    provider          TEXT NOT NULL CHECK (length(provider) > 0),
    model             TEXT NOT NULL CHECK (length(model) > 0),

    -- Ce qui a été DEMANDÉ, et ce qui a été FACTURÉ. Les deux, parce que leur
    -- écart est l'information la plus utile du registre : une estimation
    -- systématiquement basse rend le blocage dur inopérant.
    estimated_micros  BIGINT NOT NULL CHECK (estimated_micros >= 0),
    actual_micros     BIGINT CHECK (actual_micros IS NULL OR actual_micros >= 0),

    tokens_in         INTEGER NOT NULL DEFAULT 0 CHECK (tokens_in >= 0),
    tokens_out        INTEGER NOT NULL DEFAULT 0 CHECK (tokens_out >= 0),
    latency_ms        INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),

    -- `docs/04 §10` : la classe de confidentialité ET la raison du routage.
    -- Sans la raison, le tableau de bord dit ce qui a coûté, jamais pourquoi.
    privacy_class     TEXT NOT NULL CHECK (privacy_class IN ('RED','ORANGE','GREEN')),
    routing_reason    TEXT NOT NULL CHECK (length(routing_reason) > 0),

    -- Décision du CostGate, conservée telle qu'elle a été prise.
    decision          TEXT NOT NULL CHECK (decision IN (
                          'ALLOW_LOCAL','ALLOW_CLOUD','ASK_USER','DENY')),

    -- Opération à l'origine de l'appel, quand il y en a une.
    operation_id      TEXT
);

-- La question posée avant chaque appel : « combien ce mois-ci ? »
CREATE INDEX cloud_spend_month_idx ON cloud_spend (occurred_at);

-- Le tableau de bord de `docs/04 §11` : appels par fournisseur.
CREATE INDEX cloud_spend_provider_idx ON cloud_spend (provider, occurred_at);

-- --------------------------------------------------------------------------
-- DROITS : LECTURE ET AJOUT, JAMAIS SUPPRESSION NI MODIFICATION
--
-- La question posée en écrivant ce fichier : le rôle applicatif doit-il
-- pouvoir effacer une ligne de dépense ?
--
-- Non, et c'est une propriété de sûreté, pas d'hygiène. Le blocage dur
-- compare la dépense du mois à un plafond. Si l'application peut SUPPRIMER
-- des lignes, elle peut remettre le compteur à zéro — et le plafond devient
-- une suggestion. Le contournement ne demanderait même pas de malveillance :
-- un « nettoyage » de maintenance suffirait.
--
-- Même raisonnement que pour `event_ledger` : ce qui sert de preuve ne
-- s'écrit qu'une fois. La correction d'une erreur passe par une écriture
-- compensatoire, visible, pas par un effacement.
-- --------------------------------------------------------------------------
GRANT SELECT, INSERT ON cloud_spend TO jarvis_app;
GRANT USAGE, SELECT ON SEQUENCE cloud_spend_id_seq TO jarvis_app;
