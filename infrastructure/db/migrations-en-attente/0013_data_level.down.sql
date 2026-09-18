-- La descente RETIRE une information plus fine et laisse `privacy_class`, qui
-- n'a jamais cessé d'exister. Elle ne peut donc rien exposer — contrairement à
-- la montée.
--
-- ⚠ L'ORDRE N'EST PAS DÉCORATIF : les contraintes appellent les fonctions, et
-- les triggers aussi. `DROP FUNCTION` avant elles échouerait sur une
-- dépendance. On retire dans l'ordre inverse de la construction.
DROP TRIGGER IF EXISTS memories_plancher_avant_ecriture ON memories;
DROP TRIGGER IF EXISTS notes_plancher_avant_ecriture    ON notes;
DROP FUNCTION IF EXISTS jarvis_plancher_memoire();
DROP FUNCTION IF EXISTS jarvis_plancher_note();

ALTER TABLE memories DROP CONSTRAINT IF EXISTS memories_credential_restricted;
ALTER TABLE memories DROP CONSTRAINT IF EXISTS memories_data_level_plancher;
ALTER TABLE memories DROP CONSTRAINT IF EXISTS memories_data_level_valide;
ALTER TABLE notes    DROP CONSTRAINT IF EXISTS notes_data_level_plancher;
ALTER TABLE notes    DROP CONSTRAINT IF EXISTS notes_data_level_valide;

ALTER TABLE memories DROP COLUMN IF EXISTS data_level;
ALTER TABLE notes    DROP COLUMN IF EXISTS data_level;

DROP FUNCTION IF EXISTS jarvis_plancher(TEXT, TEXT);
DROP FUNCTION IF EXISTS jarvis_plancher_categorie(TEXT);
DROP FUNCTION IF EXISTS jarvis_plancher_classe(TEXT);
DROP FUNCTION IF EXISTS jarvis_rang_niveau(TEXT);
