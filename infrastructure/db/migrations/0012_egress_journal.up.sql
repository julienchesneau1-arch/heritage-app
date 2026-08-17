-- ==========================================================================
-- 0012 — Ce qui est parti de la machine
--
-- Référence : `docs/05 §C4`, `docs/02 §Phase 4`, ADR-052.
--
-- C4 EXIGE TROIS CHOSES, ET AUCUNE N'ÉTAIT ENREGISTRÉE
-- -----------------------------------------------------
--   « Montre-moi ce qui est parti sur Internet. »
--   → liste lisible par un humain — DESTINATION, CLASSE DE DONNÉES, RAISON.
--
-- Le journal savait dire QUI a fait QUOI et avec quel verdict. Il ne savait pas
-- dire OÙ c'est allé.
--
-- POURQUOI CES COLONNES SONT DANS `event_ledger` ET PAS AILLEURS
-- ---------------------------------------------------------------
-- Une console d'égression alimentée par une seconde table pourrait diverger du
-- journal — et le jour où elles divergent, aucune ne fait autorité. C'est la
-- leçon d'ADR-041 : la source qui ne peut pas être révisée est la seule qui
-- prouve quelque chose.
--
-- LE HACHAGE, ET C'EST LE POINT DÉLICAT
-- --------------------------------------
-- La chaîne couvre une LISTE ORDONNÉE de champs. Y insérer trois positions
-- changerait le hachage de toutes les lignes déjà écrites : leur vérification
-- échouerait, et le seul mécanisme de preuve du dépôt deviendrait faux au
-- moment précis où on ajoute un mécanisme de preuve.
--
-- Les champs d'égression sont donc AJOUTÉS EN QUEUE, et seulement quand ils
-- existent. Une ligne sans égression produit une liste byte-identique à
-- l'ancienne, donc le même hachage. Une ligne avec égression étend la liste,
-- donc les trois faits sont couverts par la chaîne comme le reste.
--
-- Voir `src/core/ledger/event.ts` — la propriété y est éprouvée.
-- ==========================================================================

ALTER TABLE event_ledger
    -- OÙ. Identifiant du fournisseur, jamais une URL : `docs/03 §12` interdit
    -- de journaliser autre chose qu'une empreinte du contenu, et une URL en
    -- porte souvent.
    ADD COLUMN egress_destination TEXT,

    -- QUELLE CLASSE. Le niveau `docs/14` de la donnée concernée, tel qu'il a
    -- été déterminé AU MOMENT de la décision — pas recalculé après coup.
    ADD COLUMN egress_data_level  TEXT CHECK (egress_data_level IN (
                   'PUBLIC','PERSONAL','SENSITIVE','HIGHLY_SENSITIVE','RESTRICTED')),

    -- POURQUOI. La raison rendue par le Policy Gate, en clair.
    ADD COLUMN egress_reason      TEXT;

-- Les trois vont ensemble ou pas du tout. Une destination sans niveau serait
-- une ligne d'audit qui pose une question au lieu d'y répondre.
ALTER TABLE event_ledger ADD CONSTRAINT egress_fields_together CHECK (
    (egress_destination IS NULL AND egress_data_level IS NULL AND egress_reason IS NULL)
    OR
    (egress_destination IS NOT NULL AND egress_data_level IS NOT NULL
     AND egress_reason IS NOT NULL)
);

-- La console lit « ce qui est parti », donc seulement les lignes concernées.
CREATE INDEX event_ledger_egress_idx ON event_ledger (occurred_at DESC)
    WHERE egress_destination IS NOT NULL;
