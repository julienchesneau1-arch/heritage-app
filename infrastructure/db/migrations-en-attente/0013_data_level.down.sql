-- La descente RETIRE une information plus fine et laisse `privacy_class`, qui
-- n'a jamais cessé d'exister. Elle ne peut donc rien exposer — contrairement à
-- la montée.
ALTER TABLE memories DROP CONSTRAINT IF EXISTS memories_credential_restricted;
ALTER TABLE memories DROP CONSTRAINT IF EXISTS memories_data_level_valide;
ALTER TABLE notes    DROP CONSTRAINT IF EXISTS notes_data_level_valide;
ALTER TABLE memories DROP COLUMN IF EXISTS data_level;
ALTER TABLE notes    DROP COLUMN IF EXISTS data_level;
