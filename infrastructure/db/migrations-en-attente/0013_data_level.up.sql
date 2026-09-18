-- ==========================================================================
-- 0013 — `DataLevel` remplace `PrivacyClass` dans les colonnes
--
-- Référence : `docs/14 §5`, ADR-050, ADR-053, ADR-076, ADR-092.
--
-- ⚠⚠ CETTE MIGRATION EST LA SEULE DU DÉPÔT DONT L'ERREUR EXPOSE UNE DONNÉE.
--
-- Toutes les autres RÉTRÉCISSENT : elles ajoutent une contrainte, un cloison-
-- nement, un refus. Un défaut y bloque une action légitime — ennuyeux, visible,
-- corrigible.
--
-- Celle-ci ÉLARGIT. Une ligne `GREEN` mal convertie devient `PUBLIC`,
-- c'est-à-dire ENVOYABLE. Le défaut ne bloque rien : il expose, en silence, et
-- rien ne le signale.
--
-- `docs/14 §5` le dit dans ces termes :
--
--   > `GREEN → PUBLIC` : ⚠ à vérifier LIGNE PAR LIGNE avant migration. Une
--   > donnée aujourd'hui GREEN par défaut d'attention deviendrait publiquement
--   > envoyable. **La migration doit défaillir plutôt que deviner.**
--
-- ELLE EST ÉCRITE, TESTÉE, ET DÉLIBÉRÉMENT NON APPLIQUÉE
-- -------------------------------------------------------
-- La vérification ligne par ligne porte sur des données réelles que seul leur
-- propriétaire peut arbitrer. Ce n'est pas une décision d'agent.
--
-- La marche à suivre est en `docs/29`. Le préalable non négociable :
--
--     SELECT id, data_category, privacy_class, left(content, 60)
--       FROM memories WHERE privacy_class = 'GREEN';
--     SELECT id, privacy_class, left(content, 60)
--       FROM notes    WHERE privacy_class = 'GREEN';
--
-- CE QUI REND CETTE MIGRATION SÛRE MALGRÉ TOUT
-- ---------------------------------------------
-- Elle ne devine JAMAIS. `GREEN` n'est converti en `PUBLIC` que si la CATÉGORIE
-- le confirme — seule `WEATHER` a un plancher `PUBLIC` (`docs/14 §3`). Toute
-- autre ligne `GREEN` fait ÉCHOUER la migration en la nommant, et la
-- transaction est annulée : rien n'est à moitié converti.
--
-- `notes` n'a pas de colonne `data_category` : AUCUNE de ses lignes `GREEN` ne
-- peut donc être confirmée, et leur seule présence bloque la migration. C'est
-- voulu — une note sans catégorie est exactement le « GREEN par défaut
-- d'attention » que le document redoute.
--
-- ==========================================================================
-- CE QUI A CHANGÉ APRÈS LA REVUE LIGNE PAR LIGNE — ADR-092
-- ==========================================================================
-- La revue de `docs/29` a trouvé deux défauts BLOQUANTS et posé une question.
-- Les trois sont traités ici, et la façon dont ils le sont tient en une phrase :
--
--     LA BASE NE CALCULE PAS LE NIVEAU. ELLE REFUSE CEUX QUI SONT TROP BAS,
--     ET ELLE POSE LE PLANCHER QUAND PERSONNE N'A RIEN DIT.
--
-- 1. AUCUNE ÉCRITURE N'ÉTAIT PLUS POSSIBLE (défaut bloquant n°1).
--    `data_level` était `NOT NULL` sans `DEFAULT`, et aucun `INSERT` de `src/`
--    ne le renseigne. Un `DEFAULT 'PERSONAL'` littéral aurait été FAUX ici : le
--    plancher dépend de la catégorie de la ligne, et un `DEFAULT` de colonne ne
--    peut pas lire une autre colonne. `memory_add(dataCategory: 'HEALTH')`
--    serait alors passé de « impossible » à « refusé par la contrainte » — un
--    progrès, mais toujours une fonctionnalité perdue.
--    → un trigger `BEFORE INSERT` pose le plancher RÉEL quand `data_level` est
--      absent. Il ne corrige jamais une valeur fournie : une valeur trop basse
--      est REFUSÉE, pas remontée en douce. Remonter silencieusement cacherait
--      un défaut applicatif ; refuser le montre.
--
-- 2. LE PLANCHER NE TENAIT QUE POUR `CREDENTIAL` (défaut n°2).
--    → une contrainte le tient pour les 14 catégories de `docs/14 §3`.
--
-- 3. `privacy_class` SURVIT À LA MIGRATION (la question laissée ouverte).
--    ADR-041 : « deux registres du même fait finissent par diverger ».
--    → on ne retire pas `privacy_class` : chaque outil du dépôt en dépend, et
--      la retirer maintenant serait un chantier bien plus large que celui-ci.
--      On rend la DIVERGENCE IMPOSSIBLE dans la seule direction qui expose :
--      une ligne `RED` ne peut pas porter un niveau inférieur à
--      `HIGHLY_SENSITIVE`, une `ORANGE` pas moins que `PERSONAL`. Dans l'autre
--      sens rien n'est contraint — une ligne peut toujours être PLUS protégée
--      que sa vieille classe ne le dit, et c'est exactement `strictest()`.
--
-- ⚠ LE DEUXIÈME REGISTRE QUE CE FICHIER INTRODUIT, ET QU'IL FAUT NOMMER
-- ---------------------------------------------------------------------
-- La table des planchers de `docs/14 §3` existe déjà en TypeScript
-- (`src/core/privacy/classify.ts`, constante `PLANCHER`). L'écrire aussi en SQL
-- crée un second registre du même fait — précisément ce qu'ADR-041 met en garde.
--
-- Il est ASSUMÉ, pour une raison qu'on peut dire à voix haute : une contrainte
-- de base ne peut pas appeler du TypeScript. Le choix n'est pas entre un
-- registre et deux, il est entre deux registres et AUCUNE barrière — c'est-à-dire
-- un plancher tenu par la seule application, que `docs/14` refuse explicitement.
--
-- Ce qu'on fait donc, puisque la duplication est inévitable : on l'EXPOSE et on
-- la MESURE. `tests/privacy/plancher-sql-vs-ts.test.ts` interroge les deux
-- registres sur les 14 catégories × 3 classes et exige qu'ils rendent le même
-- niveau. Le jour où l'un dérive, un test rougit — pas une donnée qui fuit.
-- ==========================================================================

BEGIN;

-- --------------------------------------------------------------------------
-- 0. LA TABLE DES PLANCHERS, CÔTÉ BASE
--
-- Trois fonctions `IMMUTABLE`, utilisées par la conversion, par le trigger ET
-- par les contraintes. Un seul endroit à lire, un seul à corriger : si la table
-- de `docs/14 §3` change, elle change ici, et le test d'accord avec le
-- TypeScript le dira.
-- --------------------------------------------------------------------------

/* L'ordre de protection. MÊME ordre que `DATA_LEVEL_ORDER` en TypeScript.
   Une valeur inconnue rend NULL plutôt que 0 : un niveau qu'on ne sait pas
   ranger ne doit PAS être traité comme le moins protégé. */
CREATE FUNCTION jarvis_rang_niveau(niveau TEXT) RETURNS INTEGER
    LANGUAGE sql IMMUTABLE STRICT AS $$
    SELECT CASE niveau
        WHEN 'PUBLIC'           THEN 0
        WHEN 'PERSONAL'         THEN 1
        WHEN 'SENSITIVE'        THEN 2
        WHEN 'HIGHLY_SENSITIVE' THEN 3
        WHEN 'RESTRICTED'       THEN 4
    END
$$;

/* `docs/14 §3` — catégorie → plancher. Les 14 lignes, en toutes lettres.
   Le `ELSE` est le DÉFAUT FERMÉ de `OTHER` : ce qu'on ne sait pas nommer ne
   part pas. Un `ELSE 'PUBLIC'` serait la seule façon de transformer cette
   table en fuite. */
CREATE FUNCTION jarvis_plancher_categorie(categorie TEXT) RETURNS TEXT
    LANGUAGE sql IMMUTABLE STRICT AS $$
    SELECT CASE categorie
        WHEN 'CREDENTIAL'      THEN 'RESTRICTED'
        WHEN 'HEALTH'          THEN 'HIGHLY_SENSITIVE'
        WHEN 'FINANCIAL'       THEN 'HIGHLY_SENSITIVE'
        WHEN 'EMAIL'           THEN 'SENSITIVE'
        WHEN 'MESSAGE'         THEN 'SENSITIVE'
        WHEN 'CALENDAR'        THEN 'SENSITIVE'
        WHEN 'CONTACT'         THEN 'SENSITIVE'
        WHEN 'DOCUMENT'        THEN 'SENSITIVE'
        WHEN 'LOCATION'        THEN 'SENSITIVE'
        WHEN 'TASK'            THEN 'PERSONAL'
        WHEN 'PROJECT'         THEN 'PERSONAL'
        WHEN 'PERSONAL_MEMORY' THEN 'PERSONAL'
        WHEN 'WEATHER'         THEN 'PUBLIC'
        ELSE 'PERSONAL'
    END
$$;

/* `docs/14 §5` — ancienne classe → plancher. C'est `fromLegacy` vu comme un
   MINIMUM et non comme une conversion : `GREEN` n'impose rien (`PUBLIC` est le
   rang zéro), donc une ligne GREEN peut parfaitement finir SENSITIVE si sa
   catégorie l'exige. La contrainte ne peut que refuser un niveau TROP BAS —
   jamais forcer une descente. */
CREATE FUNCTION jarvis_plancher_classe(classe TEXT) RETURNS TEXT
    LANGUAGE sql IMMUTABLE STRICT AS $$
    SELECT CASE classe
        WHEN 'RED'    THEN 'HIGHLY_SENSITIVE'
        WHEN 'ORANGE' THEN 'PERSONAL'
        WHEN 'GREEN'  THEN 'PUBLIC'
        ELSE 'PERSONAL'
    END
$$;

/* Le plancher effectif : le plus protecteur des deux. C'est `strictestLevel`,
   écrit une fois, et la raison pour laquelle le trigger et la contrainte ne
   peuvent pas diverger l'un de l'autre. */
CREATE FUNCTION jarvis_plancher(categorie TEXT, classe TEXT) RETURNS TEXT
    LANGUAGE sql IMMUTABLE STRICT AS $$
    SELECT CASE
        WHEN jarvis_rang_niveau(jarvis_plancher_categorie(categorie))
           >= jarvis_rang_niveau(jarvis_plancher_classe(classe))
        THEN jarvis_plancher_categorie(categorie)
        ELSE jarvis_plancher_classe(classe)
    END
$$;

-- --------------------------------------------------------------------------
-- 1. LE GARDE-FOU — il s'exécute AVANT toute écriture
-- --------------------------------------------------------------------------
DO $$
DECLARE
    bloquantes TEXT;
    nb INTEGER;
BEGIN
    -- Mémoires GREEN dont la catégorie ne confirme PAS le caractère public.
    SELECT count(*), string_agg(id::text || ' (' || data_category || ')', ', ')
      INTO nb, bloquantes
      FROM memories
     WHERE privacy_class = 'GREEN' AND data_category <> 'WEATHER';

    IF nb > 0 THEN
        RAISE EXCEPTION
            'MIGRATION REFUSÉE — % mémoire(s) GREEN deviendraient PUBLIC sans que '
            'leur catégorie le confirme : %. docs/14 §5 exige une vérification '
            'ligne par ligne. Reclassez-les (ORANGE si personnelles, ou '
            'data_category = WEATHER si réellement publiques) puis relancez.',
            nb, bloquantes;
    END IF;

    -- Notes GREEN : aucune catégorie n'existe sur cette table, donc aucune
    -- confirmation n'est possible. Leur présence bloque, par construction.
    SELECT count(*) INTO nb FROM notes WHERE privacy_class = 'GREEN';
    IF nb > 0 THEN
        RAISE EXCEPTION
            'MIGRATION REFUSÉE — % note(s) GREEN. La table `notes` ne porte '
            'aucune catégorie : rien ne peut confirmer qu''elles sont publiques, '
            'et les convertir reviendrait à DEVINER. Reclassez-les en ORANGE '
            'puis relancez.', nb;
    END IF;
END
$$;

-- --------------------------------------------------------------------------
-- 2. LA CONVERSION — seulement une fois le garde-fou franchi
-- --------------------------------------------------------------------------
ALTER TABLE memories ADD COLUMN data_level TEXT;
ALTER TABLE notes    ADD COLUMN data_level TEXT;

/* La conversion appelle la MÊME fonction que le trigger et la contrainte.
   La version précédente répétait la table sous forme de `CASE` en ligne : trois
   copies du même fait, dont une seule était éprouvée.

   `docs/14 §5` — « les CREDENTIAL devront être re-classés RESTRICTED par leur
   CATÉGORIE, pas par leur ancienne classe » — est une CONSÉQUENCE de
   `jarvis_plancher`, plus une branche à ne pas oublier : le plancher de
   catégorie l'emporte dès qu'il est plus haut. */
UPDATE memories SET data_level = jarvis_plancher(data_category, privacy_class);

/* `notes` n'a pas de catégorie. On lui applique `PERSONAL_MEMORY`, ce que la
   table EST — et non `OTHER`, qui donnerait le même plancher pour de mauvaises
   raisons. Conséquence directe et voulue : une note GREEN devient `PERSONAL`,
   jamais `PUBLIC`. Une note ne peut pas être confirmée publique, ici pas plus
   qu'au garde-fou. */
UPDATE notes SET data_level = jarvis_plancher('PERSONAL_MEMORY', privacy_class);

ALTER TABLE memories
    ALTER COLUMN data_level SET NOT NULL,
    ADD CONSTRAINT memories_data_level_valide CHECK (data_level IN (
        'PUBLIC','PERSONAL','SENSITIVE','HIGHLY_SENSITIVE','RESTRICTED'));

ALTER TABLE notes
    ALTER COLUMN data_level SET NOT NULL,
    ADD CONSTRAINT notes_data_level_valide CHECK (data_level IN (
        'PUBLIC','PERSONAL','SENSITIVE','HIGHLY_SENSITIVE','RESTRICTED'));

-- --------------------------------------------------------------------------
-- 3. LE PLANCHER, TENU PAR LA BASE — défaut n°2 de la revue
--
-- `docs/14 §3` : « le niveau ne peut que monter ». La version précédente
-- l'appliquait UNE FOIS, dans son `UPDATE`, puis plus rien ne le tenait : seule
-- `CREDENTIAL` avait une contrainte. Une mémoire `HEALTH` pouvait être écrite
-- `PUBLIC` et la base ne disait rien.
--
-- Ces deux contraintes couvrent les 14 catégories ET les 3 classes. Elles ne
-- calculent rien : elles comparent un rang à un plancher, et refusent en
-- dessous.
-- --------------------------------------------------------------------------
ALTER TABLE memories ADD CONSTRAINT memories_data_level_plancher CHECK (
    jarvis_rang_niveau(data_level)
        >= jarvis_rang_niveau(jarvis_plancher(data_category, privacy_class)));

ALTER TABLE notes ADD CONSTRAINT notes_data_level_plancher CHECK (
    jarvis_rang_niveau(data_level)
        >= jarvis_rang_niveau(jarvis_plancher('PERSONAL_MEMORY', privacy_class)));

/* Un secret reste RESTRICTED quoi qu'il arrive — la même règle qu'en code, à
   l'endroit où elle ne dépend d'aucun appelant.

   ⚠ REDONDANTE AVEC LA PRÉCÉDENTE, ET GARDÉE EXPRÈS. `jarvis_plancher` la
   couvre déjà. Mais elle est écrite en clair, sans passer par aucune fonction :
   elle survit à une erreur dans `jarvis_plancher_categorie` que le test
   d'accord n'aurait pas attrapée. C'est la seule règle du système dont on
   accepte de payer une double écriture, et c'est celle dont l'échec serait le
   pire — un secret envoyé. */
ALTER TABLE memories ADD CONSTRAINT memories_credential_restricted CHECK (
    data_category <> 'CREDENTIAL' OR data_level = 'RESTRICTED');

-- --------------------------------------------------------------------------
-- 4. QUAND PERSONNE N'A RIEN DIT — défaut n°1 de la revue
--
-- ⚠ CE TRIGGER NE CORRIGE RIEN. Il ne s'applique QUE si `data_level` est
-- absent, et il pose alors le plancher exact de la ligne.
--
-- La tentation était de remonter aussi les valeurs trop basses : « on ne va
-- tout de même pas refuser une écriture qu'on sait réparer ». On s'en garde.
-- Une valeur trop basse est un DÉFAUT APPLICATIF — du code qui croit avoir
-- classé et s'est trompé. La remonter en silence rendrait ce défaut
-- indétectable, et la prochaine donnée mal classée passerait elle aussi. La
-- contrainte refuse ; l'erreur remonte ; quelqu'un la lit.
--
-- Absent ≠ trop bas : l'un est un appelant qui n'a pas d'opinion, l'autre est
-- un appelant qui en a une, et qui a tort.
-- --------------------------------------------------------------------------
CREATE FUNCTION jarvis_plancher_memoire() RETURNS TRIGGER
    LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.data_level IS NULL THEN
        NEW.data_level := jarvis_plancher(NEW.data_category, NEW.privacy_class);
    END IF;
    RETURN NEW;
END
$$;

CREATE FUNCTION jarvis_plancher_note() RETURNS TRIGGER
    LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.data_level IS NULL THEN
        NEW.data_level := jarvis_plancher('PERSONAL_MEMORY', NEW.privacy_class);
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER memories_plancher_avant_ecriture
    BEFORE INSERT OR UPDATE ON memories
    FOR EACH ROW EXECUTE FUNCTION jarvis_plancher_memoire();

CREATE TRIGGER notes_plancher_avant_ecriture
    BEFORE INSERT OR UPDATE ON notes
    FOR EACH ROW EXECUTE FUNCTION jarvis_plancher_note();

COMMIT;
