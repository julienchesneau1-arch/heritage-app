-- Descente de 0009. Les lignes portant un statut retiré du CHECK doivent
-- disparaître d'abord, sinon la contrainte restreinte est invalide.
DROP INDEX IF EXISTS tool_operations_trust_breach_idx;

DELETE FROM tool_operations
 WHERE status IN ('PARTIAL','NOT_ATTEMPTED','PROVIDER_CONTRACT_VIOLATION');

ALTER TABLE tool_operations DROP CONSTRAINT IF EXISTS tool_operations_status_check;
ALTER TABLE tool_operations ADD CONSTRAINT tool_operations_status_check CHECK (
    status IN ('CONFIRMED','PROBABLE','UNKNOWN','FAILED')
);

-- LE JOURNAL EST APPEND-ONLY ET CHAÎNÉ, ce qui rend cette descente
-- particulière — et l'erreur que j'ai commise mérite d'être écrite ici.
--
-- Première version : re-poser la contrainte étroite telle quelle. Elle
-- échouait dès qu'une rupture de confiance avait été journalisée, et bloquait
-- la suite de tests entière — `tests/global-setup.ts` fait descendre puis
-- remonter le schéma à chaque exécution.
--
-- Purger les lignes fautives était exclu : cela romprait la chaîne de hachage,
-- c'est-à-dire la seule propriété qui donne sa valeur au journal.
--
-- `NOT VALID` est la réponse juste : la contrainte s'applique aux écritures
-- FUTURES, et l'histoire déjà écrite reste intacte et vérifiable. La forme du
-- schéma est restaurée sans qu'aucun maillon ne soit touché.
ALTER TABLE event_ledger DROP CONSTRAINT IF EXISTS event_ledger_status_check;
ALTER TABLE event_ledger ADD CONSTRAINT event_ledger_status_check CHECK (
    status IN ('CONFIRMED','PROBABLE','UNKNOWN','FAILED')
) NOT VALID;
