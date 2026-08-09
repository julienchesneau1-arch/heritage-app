-- Rollback 0001
--
-- L'ordre suit les dépendances de clés étrangères. `03` exige qu'une migration
-- ait toujours un chemin de retour testé, pas seulement documenté.

DROP TABLE IF EXISTS decisions;
DROP TABLE IF EXISTS rules;
DROP TABLE IF EXISTS preferences;
DROP TABLE IF EXISTS tasks;
DROP TABLE IF EXISTS projects;
DROP TABLE IF EXISTS memories;
DROP TABLE IF EXISTS relations;
DROP TABLE IF EXISTS entities;

-- pgcrypto est laissée en place : d'autres migrations en dépendent, et sa
-- présence est sans effet de bord.
