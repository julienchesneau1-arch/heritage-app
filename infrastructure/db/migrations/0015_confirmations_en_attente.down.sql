-- La descente retire une file d'attente, donc des INTENTIONS non exécutées.
-- Elle ne peut rien casser : une intention perdue est une action qui n'a pas
-- eu lieu, ce qui est l'état par défaut du système.
DROP INDEX IF EXISTS confirmations_en_attente_ouvertes_idx;
DROP TABLE IF EXISTS confirmations_en_attente;
