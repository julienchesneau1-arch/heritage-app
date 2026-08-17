-- ==========================================================================
-- 0013 — `DataLevel` remplace `PrivacyClass` dans les colonnes
--
-- Référence : `docs/14 §5`, ADR-050, ADR-053.
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
-- ==========================================================================

BEGIN;

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

-- RED → HIGHLY_SENSITIVE, sauf si la catégorie exige davantage.
-- `docs/14 §5` : « les CREDENTIAL devront être re-classés RESTRICTED par leur
-- CATÉGORIE, pas par leur ancienne classe ».
UPDATE memories SET data_level = CASE
    WHEN data_category = 'CREDENTIAL'                 THEN 'RESTRICTED'
    WHEN data_category IN ('HEALTH','FINANCIAL')      THEN 'HIGHLY_SENSITIVE'
    WHEN privacy_class = 'RED'                        THEN 'HIGHLY_SENSITIVE'
    WHEN data_category IN ('EMAIL','MESSAGE','CALENDAR',
                           'CONTACT','DOCUMENT','LOCATION') THEN 'SENSITIVE'
    WHEN privacy_class = 'GREEN'                      THEN 'PUBLIC'
    ELSE 'PERSONAL'
END;

UPDATE notes SET data_level = CASE
    WHEN privacy_class = 'RED' THEN 'HIGHLY_SENSITIVE'
    ELSE 'PERSONAL'
END;

ALTER TABLE memories
    ALTER COLUMN data_level SET NOT NULL,
    ADD CONSTRAINT memories_data_level_valide CHECK (data_level IN (
        'PUBLIC','PERSONAL','SENSITIVE','HIGHLY_SENSITIVE','RESTRICTED'));

ALTER TABLE notes
    ALTER COLUMN data_level SET NOT NULL,
    ADD CONSTRAINT notes_data_level_valide CHECK (data_level IN (
        'PUBLIC','PERSONAL','SENSITIVE','HIGHLY_SENSITIVE','RESTRICTED'));

-- Un secret reste RESTRICTED quoi qu'il arrive — la même règle qu'en code, à
-- l'endroit où elle ne dépend d'aucun appelant.
ALTER TABLE memories ADD CONSTRAINT memories_credential_restricted CHECK (
    data_category <> 'CREDENTIAL' OR data_level = 'RESTRICTED');

COMMIT;
