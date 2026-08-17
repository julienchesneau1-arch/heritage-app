-- Réversible sans précaution : `reminders` ne participe à aucune chaîne de
-- hachage et ne sert de preuve à personne. Les rappels perdus sont des
-- données applicatives, pas un journal.
DROP TABLE IF EXISTS reminders;
