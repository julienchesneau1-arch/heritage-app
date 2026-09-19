-- La descente retire la mémoire des affichages. Les ordinaux cesseront de se
-- résoudre — Jarvis DEMANDERA au lieu de deviner, ce qui est le comportement
-- d'avant ADR-107 et reste correct.
DROP TABLE IF EXISTS dernier_affichage;
