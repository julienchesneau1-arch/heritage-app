-- ==========================================================================
-- 0015 — LA FILE D'ATTENTE DE CONFIRMATIONS
--
-- Référence : ADR-099, et elle renverse une partie d'ADR-023.
--
-- CE QU'ELLE PERMET
-- ------------------
-- Le téléphone PRÉPARE une action irréversible ; la machine la CONFIRME.
--
--     jeton détenu           → droit de METTRE EN FILE
--     présence à la machine  → droit d'EXÉCUTER
--
-- C'est le second facteur qu'ADR-090 constatait manquant : un attaquant qui
-- détient le jeton peut remplir cette table, il ne peut pas se tenir devant
-- l'ordinateur de Julien.
--
-- ⚠⚠ CETTE TABLE NE CONTIENT AUCUNE AUTORISATION
-- ----------------------------------------------
-- C'est la propriété qui rend l'ensemble sûr, et elle est architecturale plutôt
-- qu'écrite dans un commentaire :
--
--     une ligne ici est une INTENTION, pas une permission.
--
-- La confirmation REJOUE la chaîne complète — Policy Gate compris — avec
-- `surface: 'LOCALE'`. Une action refusée par une politique Cedar sera refusée
-- de nouveau au moment de la confirmation. Mettre en file n'accorde RIEN.
--
-- Sans cette propriété, la table deviendrait un contournement de politique :
-- il suffirait d'y écrire une ligne pour obtenir demain ce qui est interdit
-- aujourd'hui.
--
-- ⚠ ET CE N'EST PAS UNE SESSION
-- ------------------------------
-- ADR-023 a refusé l'état de confirmation avec ce motif : « aucune session à
-- stocker, donc aucune session à détourner ». Il reste juste, et cette table ne
-- le contredit pas dans ce sens-là :
--
--     une SESSION porte une identité — la détourner, c'est devenir quelqu'un
--     une INTENTION porte un acte    — la détourner, c'est obtenir CET acte,
--                                      et seulement après un humain devant la
--                                      machine
--
-- Ce qui est renversé est plus étroit : la confirmation n'est plus toujours
-- sans état. Elle l'est encore sur la surface LOCALE ; elle devient différée
-- quand la demande vient d'ailleurs.
-- ==========================================================================

CREATE TABLE confirmations_en_attente (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- ADR-030 : une intention utilisateur, une identité d'opération. Elle est
    -- conservée jusqu'à l'exécution, de sorte qu'un rejeu ne duplique rien.
    operation_id  TEXT NOT NULL UNIQUE,

    tool_id       TEXT NOT NULL CHECK (length(tool_id) > 0),

    -- L'appel TEL QU'IL SERA REJOUÉ. Les référents sont déjà résolus : à ce
    -- stade `noteId` est un identifiant, pas « la note du carreleur ».
    input         JSONB NOT NULL,
    -- La provenance de chaque paramètre, rejouée telle quelle : le Policy Gate
    -- durcit sur elle, et la perdre affaiblirait la décision au moment où elle
    -- compte le plus.
    provenance    JSONB NOT NULL,

    -- CE QUE L'UTILISATEUR LIRA AVANT D'APPROUVER.
    --
    -- Produit par `libelleSur` (ADR-096) : une mémoire dont le plancher dépasse
    -- PERSONAL y est NOMMÉE, jamais citée. Une file d'attente qui afficherait
    -- « supprimer : mot de passe banque … » serait la fuite d'ADR-096 déplacée
    -- d'un écran.
    resume        TEXT NOT NULL CHECK (length(resume) > 0),

    demandee_de   TEXT NOT NULL CHECK (demandee_de IN ('LOCALE','DISTANTE')),

    -- ⚠ UNE INTENTION EXPIRE, et ce n'est pas de l'hygiène de table.
    --
    -- Une demande vieille d'un jour ne décrit plus l'état d'esprit de personne.
    -- L'approuver reviendrait à exécuter ce que quelqu'un voulait hier, sur une
    -- base qui a changé depuis. Le délai est un CHOIX (ADR-099) et il est écrit
    -- comme tel.
    expires_at    TIMESTAMPTZ NOT NULL,

    resolue_at    TIMESTAMPTZ,
    resolution    TEXT CHECK (resolution IN ('CONFIRMEE','REFUSEE')),

    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Une ligne résolue porte les deux champs, ou aucun. L'état intermédiaire
    -- — résolue sans dire comment, ou dite confirmée sans date — n'a aucun sens
    -- et la base le refuse plutôt que de compter sur l'appelant.
    CONSTRAINT confirmation_resolution_coherente CHECK (
        (resolue_at IS NULL AND resolution IS NULL)
     OR (resolue_at IS NOT NULL AND resolution IS NOT NULL)
    )
);

-- La lecture qui compte : « qu'est-ce qui m'attend, maintenant ». Partielle,
-- parce que les lignes résolues ne sont jamais relues par ce chemin.
CREATE INDEX confirmations_en_attente_ouvertes_idx
    ON confirmations_en_attente (expires_at)
    WHERE resolue_at IS NULL;

-- --------------------------------------------------------------------------
-- LES DROITS — et cette ligne manquait à la première rédaction.
--
-- Mesuré en exécution, pas en test : le téléphone a demandé une suppression et
-- a reçu « permission denied for table confirmations_en_attente ». Les tests
-- passaient, parce qu'ils tournent avec le rôle PROPRIÉTAIRE ; le produit
-- tourne avec `jarvis_app`, qui n'a que ce qu'on lui accorde.
--
-- C'est le motif de ce dépôt sous une forme nouvelle : une propriété vérifiée
-- par un chemin qui n'est pas celui du produit. Lancer la passerelle pour de
-- vrai a coûté deux minutes et trouvé ce qu'aucun test n'aurait vu.
--
-- Pas de DELETE : une intention ne s'efface pas, elle se RÉSOUT. La trace de
-- ce qui a été demandé — et refusé — fait partie de ce que `/audit` doit
-- pouvoir raconter.
-- --------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON confirmations_en_attente TO jarvis_app;
