-- LA PASSE DE RETRAIT — la part qui vit en base.
--
-- `Tradition.sleepReason` est une PHRASE, composée par le produit et rangée
-- en base, puis affichée telle quelle. Corriger le code qui l'écrit ne
-- corrige donc que les sommeils À VENIR : les familles qui portent déjà
-- « Non relevée depuis 3 ans » continueraient de lire, sur leur écran, que
-- c'est elles qui ont failli — ce que la §6.2 interdit précisément
-- (« ne jamais dire : il y a longtemps que… »).
--
-- On réécrit donc les lignes existantes. Le sujet de la phrase devient
-- l'application, qui rend compte de sa propre décision : c'est elle qui
-- cesse de proposer, pas la famille qui a laissé tomber.
--
-- Ciblé sur la formule exacte que le produit écrivait. Une raison saisie à
-- la main par un membre — « on ne la fait plus depuis que papi est parti » —
-- n'est pas touchée : ce sont ses mots, pas les nôtres (§2.1).
UPDATE "traditions"
SET "sleep_reason" = 'L''application a cessé de la proposer après 3 ans sans occasion notée.'
WHERE "sleep_reason" = 'Non relevée depuis 3 ans.';
