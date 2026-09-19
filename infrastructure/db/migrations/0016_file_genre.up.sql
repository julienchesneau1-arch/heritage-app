-- ==========================================================================
-- 0016 — LA FILE SAIT CE QU'ELLE PORTE
--
-- Référence : ADR-105, `docs/26 §4.20`. Étend ADR-099.
--
-- LE MANQUE QU'ELLE FERME
-- ------------------------
-- Depuis ADR-099, le téléphone prépare une action irréversible et la machine
-- la confirme. Une seule sorte d'intention pouvait y entrer : un APPEL
-- D'OUTIL, rejoué par `gateway.invoke`.
--
-- « Annule la dernière action » n'en est pas un. L'Undo Engine fait DEUX
-- choses — invoquer l'outil inverse, puis marquer la capture annulée — et la
-- file ne savait rejouer que la première. Sans la seconde, la capture serait
-- restée annulable et l'utilisateur se la serait vue reproposer.
--
-- ⚠ CE QUI EST REFUSÉ ICI, ET QUI ÉTAIT L'AUTRE OPTION
-- -----------------------------------------------------
-- On aurait pu donner à la file une étape « marquer la capture » après
-- exécution. **C'est exactement ce qu'il ne faut pas faire** : la sûreté de
-- cette table vient de ce qu'elle n'exécute RIEN et n'a aucun moyen
-- d'exécuter quoi que ce soit. Lui donner un geste d'exécution, c'est la
-- transformer en moteur.
--
-- On note donc le GENRE de l'intention, et c'est l'appelant — devant la
-- machine — qui la remet à son propriétaire :
--
--     OUTIL       → gateway.invoke          (le propriétaire est l'outil)
--     ANNULATION  → undo.undoOperation      (le propriétaire est l'Undo Engine)
--
-- Le Policy Gate est traversé EXACTEMENT UNE FOIS dans les deux cas :
-- `undoOperation` appelle `gateway.invoke` en interne. Rien n'est contourné.
--
-- ⚠ ET LE DÉFAUT PAR DÉFAUT EST LE PLUS ANCIEN
-- ---------------------------------------------
-- `DEFAULT 'OUTIL'` : les lignes écrites avant cette migration sont des appels
-- d'outil, et c'est vrai — c'est tout ce que la file savait porter. Un défaut
-- qui décrit le passé plutôt qu'un choix commode.
-- ==========================================================================

ALTER TABLE confirmations_en_attente
    ADD COLUMN genre TEXT NOT NULL DEFAULT 'OUTIL'
        CHECK (genre IN ('OUTIL', 'ANNULATION'));

-- ⚠ POUR UNE ANNULATION, `operation_id` DÉSIGNE L'OPÉRATION À DÉFAIRE, pas
-- l'annulation elle-même.
--
-- C'est la propriété qui rend la confirmation différée sûre : la file porte
-- une opération NOMMÉE, jamais « la dernière ». « La dernière » change avec le
-- temps — entre la demande sur le téléphone et la confirmation devant la
-- machine, une autre action peut avoir eu lieu, et on défferait alors autre
-- chose que ce qui a été montré.
--
-- L'identité de l'annulation, elle, est DÉRIVÉE de la capture (`forUndo`),
-- donc stable : un rejeu ne peut pas produire un second effet.
COMMENT ON COLUMN confirmations_en_attente.genre IS
    'OUTIL : rejoué par gateway.invoke. ANNULATION : operation_id désigne '
    'l''opération À DÉFAIRE, rejouée par undo.undoOperation (ADR-105).';
