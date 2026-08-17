-- Rollback de 0014.
--
-- Supprimer la table efface l'HISTOIRE des arrêts d'urgence. C'est acceptable
-- ici et seulement ici : un `down` s'exécute pour revenir à un schéma qui ne
-- connaît pas cette capacité, donc à un état où l'arrêt d'urgence n'existe
-- pas. Le laisser à moitié serait pire — une table orpheline que plus personne
-- ne consulte donnerait l'illusion d'une protection.
DROP TABLE IF EXISTS emergency_halt;
