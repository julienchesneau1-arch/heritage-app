-- La descente retire la distinction de genre. Les intentions d'ANNULATION
-- encore en file deviendraient indiscernables d'appels d'outil, et seraient
-- rejouées par le mauvais chemin.
--
-- On les RÉSOUT donc avant de retirer la colonne, plutôt que de les laisser
-- derrière : une intention qu'on ne sait plus exécuter correctement ne doit
-- pas rester approuvable. La refuser est le seul geste qui ne peut rien
-- casser — c'est l'état par défaut du système.
UPDATE confirmations_en_attente
   SET resolue_at = clock_timestamp(), resolution = 'REFUSEE'
 WHERE genre = 'ANNULATION' AND resolue_at IS NULL;

ALTER TABLE confirmations_en_attente DROP COLUMN IF EXISTS genre;
