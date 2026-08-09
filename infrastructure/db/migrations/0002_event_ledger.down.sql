-- Rollback 0002
--
-- DROP TABLE n'est pas intercepté par les triggers BEFORE UPDATE/DELETE/TRUNCATE :
-- le rollback reste donc possible pour le propriétaire, alors que la
-- modification de ligne reste impossible pour tout le monde. C'est exactement
-- la propriété recherchée — immuable en exploitation, réversible en migration.

DROP TRIGGER IF EXISTS event_ledger_no_truncate ON event_ledger;
DROP TRIGGER IF EXISTS event_ledger_no_delete   ON event_ledger;
DROP TRIGGER IF EXISTS event_ledger_no_update   ON event_ledger;

DROP TABLE IF EXISTS event_ledger;

DROP FUNCTION IF EXISTS event_ledger_immutable();
