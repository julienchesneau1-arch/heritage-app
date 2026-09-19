-- La descente retire le mode privé PERSISTANT. Les deux processus
-- retomberaient sur `NORMAL`, c'est-à-dire sur le régime le plus permissif,
-- sans qu'aucune règle de sécurité n'ait été modifiée.
--
-- C'est le seul sens de descente possible — on ne peut pas garder un état dont
-- la table n'existe plus — mais il fallait l'écrire : une migration qui
-- RELÂCHE une protection doit le dire, sinon personne ne le verra.
DROP INDEX IF EXISTS mode_prive_un_seul_actif;
DROP TABLE IF EXISTS mode_prive;
