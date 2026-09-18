/**
 * LES DEUX REGISTRES DU PLANCHER, INTERROGÉS CÔTE À CÔTE — ADR-092.
 *
 * ADR-041 dit la règle : **deux registres du même fait finissent par diverger.**
 * La migration 0013 en crée un deuxième — la table des planchers de `docs/14 §3`
 * existait en TypeScript (`src/core/privacy/classify.ts`), elle existe désormais
 * aussi en SQL (`jarvis_plancher_categorie`).
 *
 * POURQUOI ON L'A FAIT QUAND MÊME
 * ---------------------------------------------------------------------------
 * Parce qu'une contrainte de base ne peut pas appeler du TypeScript. Le choix
 * n'était pas entre un registre et deux, il était entre :
 *
 *   - deux registres, et une barrière que l'application ne peut pas contourner ;
 *   - un seul registre, et un plancher tenu par la seule application — ce que
 *     `docs/14` refuse explicitement : *« ce doit être le même code, pas un
 *     second mécanisme qui lui ressemble »*.
 *
 * La duplication est donc assumée. Ce fichier est le prix qu'on paye pour
 * qu'elle reste honnête : il pose la MÊME question aux deux registres, sur les
 * 14 catégories × 3 classes, et exige la même réponse.
 *
 * ⚠ CE QUE CE FICHIER NE PROUVE PAS. Il prouve que les deux tables s'accordent,
 * pas qu'elles sont justes. Si `docs/14 §3` était mal recopié DES DEUX CÔTÉS,
 * ce test serait vert. C'est pour ça que `memories_credential_restricted`
 * existe toujours, écrite en clair, sans passer par aucune fonction : la seule
 * ligne dont l'erreur serait irréparable est la seule qu'on écrit trois fois.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseAvailable, ownerDb } from '../helpers/db.js';
import { err, jarvisError } from '../../src/core/types/result.js';
import { floorFor, fromLegacy } from '../../src/core/privacy/classify.js';
import { DataCategory, PrivacyClass } from '../../src/core/types/domain.js';
import type { Db } from '../../src/core/db/client.js';

const enabled = databaseAvailable();

const CORPS = readFileSync(
  'infrastructure/db/migrations-en-attente/0013_data_level.up.sql',
  'utf8',
)
  .replace(/^\s*BEGIN;\s*$/m, '')
  .replace(/^\s*COMMIT;\s*$/m, '');

interface Ligne {
  readonly categorie: string;
  readonly classe: string;
  readonly plancher_categorie: string;
  readonly plancher: string;
}

describe.runIf(enabled)('le plancher SQL et le plancher TypeScript s\'accordent', () => {
  let db: Db;
  let lignes: Ligne[] = [];

  beforeAll(async () => {
    db = ownerDb();

    /* On joue la migration dans une transaction ANNULÉE, comme partout
       ailleurs : ce fichier interroge des fonctions qui n'existent pas en base
       et ne doivent pas y rester. Le nettoyage des `GREEN` est le même que dans
       `migration-data-level.test.ts` — `jarvis_test` est partagée, et sans lui
       le garde-fou refuserait la migration avant d'avoir créé quoi que ce
       soit. */
    await db.transaction(async (tx) => {
      for (const nettoyage of [
        "UPDATE memories SET privacy_class = 'ORANGE' WHERE privacy_class = 'GREEN'",
        "UPDATE notes    SET privacy_class = 'ORANGE' WHERE privacy_class = 'GREEN'",
      ]) {
        const fait = await tx.query(nettoyage);
        if (!fait.ok) return err(jarvisError('INTERNAL', fait.error.message));
      }
      const joue = await tx.query(CORPS);
      if (!joue.ok) return err(jarvisError('INTERNAL', `migration : ${joue.error.message}`));

      /* Un produit cartésien construit en SQL : 14 × 3 = 42 lignes, et aucune
         liste à tenir à jour dans ce fichier. */
      const lu = await tx.query<Ligne>(
        `SELECT c AS categorie,
                p AS classe,
                jarvis_plancher_categorie(c) AS plancher_categorie,
                jarvis_plancher(c, p)        AS plancher
           FROM unnest($1::text[]) AS c,
                unnest($2::text[]) AS p`,
        [[...DataCategory.options], [...PrivacyClass.options]],
      );
      if (lu.ok) lignes = [...lu.value.rows];
      return err(jarvisError('INTERNAL', 'rollback volontaire'));
    });
  }, 60_000);

  afterAll(async () => {
    await db.close();
  });

  it('la migration a bien été jouée — sans quoi rien de ce qui suit ne vaut', () => {
    /* ⚠ LE CONTRÔLE QUI ÉVITE LE PIRE FAUX VERT DE CE FICHIER.

       `db.transaction` convertit une exception en `Result`. Si la migration
       avait échoué, `lignes` serait vide, chaque `it.each` ci-dessous
       n'exécuterait AUCUN cas, et la suite serait verte en n'ayant rien
       comparé. */
    expect(lignes.length).toBe(
      DataCategory.options.length * PrivacyClass.options.length,
    );
  });

  /* ==================================================================== *
   * LA TABLE DES CATÉGORIES — `docs/14 §3`
   * ==================================================================== */

  it.each(DataCategory.options)(
    'le plancher de %s est le même des deux côtés',
    (categorie) => {
      const ligne = lignes.find((l) => l.categorie === categorie);
      expect(ligne, `aucune ligne SQL pour ${categorie}`).toBeDefined();
      expect(ligne?.plancher_categorie).toBe(floorFor(categorie));
    },
  );

  it('⚠ `OTHER` tombe sur PERSONAL des deux côtés, pas sur PUBLIC', () => {
    /* LE DÉFAUT FERMÉ, ET LE SEUL ENDROIT DE CETTE TABLE OÙ UNE ERREUR
       DEVIENDRAIT UNE FUITE.

       Le `CASE` SQL a un `ELSE`. S'il avait été écrit `ELSE 'PUBLIC'`, toute
       catégorie future — et toute faute de frappe dans une catégorie existante
       — serait devenue envoyable, en silence. */
    const other = lignes.find((l) => l.categorie === 'OTHER');
    expect(other?.plancher_categorie).toBe('PERSONAL');
    expect(floorFor('OTHER')).toBe('PERSONAL');
  });

  it('⚠ une catégorie INCONNUE de SQL tombe aussi sur PERSONAL', async () => {
    /* Le test précédent interroge `OTHER`, qui est une branche EXPLICITE de la
       table. Celui-ci interroge le `ELSE` lui-même, avec une valeur qui n'est
       dans aucune des deux listes.

       C'est la différence entre vérifier la case par défaut et vérifier qu'elle
       est atteinte. */
    let plancher: string | null = null;
    await db.transaction(async (tx) => {
      const joue = await tx.query(CORPS.replace(/^\s*DO \$\$[\s\S]*?\$\$;\s*$/m, ''));
      if (!joue.ok) return err(jarvisError('INTERNAL', joue.error.message));
      const lu = await tx.query<{ p: string }>(
        `SELECT jarvis_plancher_categorie('CATEGORIE_QUI_N_EXISTE_PAS') AS p`,
      );
      if (lu.ok) plancher = lu.value.rows[0]?.p ?? null;
      return err(jarvisError('INTERNAL', 'rollback volontaire'));
    });
    expect(plancher).toBe('PERSONAL');
  }, 30_000);

  /* ==================================================================== *
   * LA CONVERSION DEPUIS L'ANCIEN DOMAINE — `docs/14 §5`
   * ==================================================================== */

  describe('RED et ORANGE : `jarvis_plancher` rend ce que `fromLegacy` rend', () => {
    const cas = DataCategory.options.flatMap((categorie) =>
      (['RED', 'ORANGE'] as const).map((classe) => ({ categorie, classe })),
    );

    it.each(cas)('$classe + $categorie', ({ categorie, classe }) => {
      const attendu = fromLegacy(classe, categorie);
      expect(attendu.ok, 'RED et ORANGE ne peuvent jamais refuser').toBe(true);
      if (!attendu.ok) return;

      const ligne = lignes.find(
        (l) => l.categorie === categorie && l.classe === classe,
      );
      expect(ligne?.plancher).toBe(attendu.value);
    });
  });

  describe('GREEN : les deux registres DIVERGENT, et c\'est documenté', () => {
    /* ⚠ LA SEULE DIVERGENCE ASSUMÉE DE CE FICHIER, ET LA RAISON D'ÊTRE DE CE
       BLOC : une divergence qu'on n'écrit pas devient un bug qu'on découvre.

       Les deux fonctions ne font pas le même métier :

         `fromLegacy` convertit des lignes DÉJÀ STOCKÉES, où `GREEN` peut
         vouloir dire « public par défaut d'attention ». Pour une conversion en
         masse, refuser est la bonne réponse — c'est le garde-fou de la
         migration, mot pour mot `docs/14 §5`.

         `jarvis_plancher` répond à « quel est le minimum acceptable pour cette
         ligne ». Pour une écriture NOUVELLE où l'application n'a rien déclaré,
         refuser casserait `note_create` ; poser le plancher de la catégorie est
         la bonne réponse, et elle protège PLUS que `GREEN` ne le suggérait.

       L'une refuse de deviner sur des données anciennes, l'autre protège par
       défaut des données nouvelles. Elles ne se contredisent pas : aucune des
       deux ne rend jamais un niveau INFÉRIEUR au plancher de la catégorie. */

    it('WEATHER — le seul cas où GREEN devient réellement PUBLIC, des deux côtés', () => {
      const attendu = fromLegacy('GREEN', 'WEATHER');
      expect(attendu.ok).toBe(true);
      if (attendu.ok) expect(attendu.value).toBe('PUBLIC');

      const ligne = lignes.find(
        (l) => l.categorie === 'WEATHER' && l.classe === 'GREEN',
      );
      expect(ligne?.plancher).toBe('PUBLIC');
    });

    it.each(DataCategory.options.filter((c) => c !== 'WEATHER'))(
      'GREEN + %s : TypeScript REFUSE, SQL protège vers le haut',
      (categorie) => {
        expect(fromLegacy('GREEN', categorie).ok).toBe(false);

        const ligne = lignes.find(
          (l) => l.categorie === categorie && l.classe === 'GREEN',
        );
        // Jamais PUBLIC — c'est la propriété qui compte, et la seule dont
        // l'absence exposerait une donnée.
        expect(ligne?.plancher).not.toBe('PUBLIC');
        expect(ligne?.plancher).toBe(floorFor(categorie));
      },
    );
  });
});
