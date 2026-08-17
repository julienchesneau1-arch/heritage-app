-- Retirer ces colonnes ne casse pas la chaîne : les lignes SANS égression
-- produisent la même liste de champs qu'avant l'ajout, donc le même hachage.
-- Les lignes AVEC égression, elles, deviendraient invérifiables — c'est le prix
-- d'une descente, et c'est pourquoi elle n'a lieu qu'en test.
ALTER TABLE event_ledger DROP CONSTRAINT IF EXISTS egress_fields_together;
DROP INDEX IF EXISTS event_ledger_egress_idx;
ALTER TABLE event_ledger
    DROP COLUMN IF EXISTS egress_destination,
    DROP COLUMN IF EXISTS egress_data_level,
    DROP COLUMN IF EXISTS egress_reason;
