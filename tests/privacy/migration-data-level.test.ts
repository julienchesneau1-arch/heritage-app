/**
 * MIGRATION 0013 — celle qui doit DÉFAILLIR plutôt que deviner.
 *
 * C'est la seule migration du dépôt dont l'erreur **expose une donnée**.
 *
 * Toutes les autres rétrécissent : un défaut y bloque une action légitime —
 * ennuyeux, visible, corrigible. Celle-ci **élargit** : une ligne `GREEN` mal
 * convertie devient `PUBLIC`, c'est-à-dire *envoyable*. Le défaut ne bloque
 * rien, il expose en silence, et rien ne le signale.
 *
 *   > `docs/14 §5` — `GREEN → PUBLIC` : ⚠ à vérifier ligne par ligne avant
 *   > migration. **La migration doit défaillir plutôt que deviner.**
 *
 * ELLE N'EST PAS APPLIQUÉE, ET CE FICHIER EST LA RAISON POUR LAQUELLE ON PEUT
 * LE DIRE SANS SE PAYER DE MOTS.
 * ---------------------------------------------------------------------------
 * Une garde jamais déclenchée est une intention, pas un mécanisme. Ce fichier
 * la déclenche : il sème exactement les lignes que `docs/14 §5` redoute, joue
 * le SQL réel, et vérifie qu'il refuse en les nommant.
 *
 * Tout se passe dans une transaction annulée — la migration ne s'applique donc
 * jamais, y compris quand ce test passe.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseAvailable, ownerDb } from '../helpers/db.js';
import { err, jarvisError } from '../../src/core/types/result.js';
import type { Db } from '../../src/core/db/client.js';

const enabled = databaseAvailable();

const SQL = readFileSync(
  'infrastructure/db/migrations-en-attente/0013_data_level.up.sql',
  'utf8',
);

/**
 * Le corps de la migration, sans son `BEGIN`/`COMMIT`.
 *
 * On veut la jouer DANS une transaction que le test annule : laisser son propre
 * `COMMIT` la rendrait définitive, et un test qui applique une migration qu'on
 * a décidé de ne pas appliquer serait le comble.
 */
const CORPS = SQL.replace(/^\s*BEGIN;\s*$/m, '').replace(/^\s*COMMIT;\s*$/m, '');

/** Une mémoire minimale valide — les colonnes réelles, pas celles supposées. */
function memoire(contenu: string, classe: string, categorie: string): string {
  return `INSERT INTO memories
            (kind, memory_type, content, confidence, source, provenance,
             privacy_class, source_type, data_category)
          VALUES ('FACT', 'SEMANTIC', '${contenu}', 0.9, 'test', 'USER',
                  '${classe}', 'USER_EXPLICIT', '${categorie}')`;
}

describe.runIf(enabled)('migration 0013 — elle défaille plutôt que deviner', () => {
  let db: Db;

  beforeAll(() => {
    db = ownerDb();
  });

  afterAll(async () => {
    await db.close();
  });

  /**
   * Joue la migration dans une transaction TOUJOURS annulée.
   *
   * ⚠ PASSE PAR `db.transaction`, ET LA PREMIÈRE RÉDACTION NE LE FAISAIT PAS.
   *
   * Elle enchaînait `db.query('BEGIN')`, le semis, la migration, puis
   * `db.query('ROLLBACK')`. Sur un POOL, ces quatre appels peuvent emprunter
   * quatre connexions différentes : le `BEGIN` n'englobe rien, la migration
   * s'auto-valide, et le `ROLLBACK` annule une transaction vide.
   *
   * Mesuré : la colonne `data_level` s'était réellement créée en base — un
   * test censé prouver que la migration N'EST PAS appliquée l'appliquait.
   *
   * `db.transaction` donne un client dédié, et annule tout à la sortie.
   */
  async function essayer(semer: string[]): Promise<string | null> {
    let erreur: string | null = null;
    await db.transaction(async (tx) => {
      for (const ordre of semer) {
        const seme = await tx.query(ordre);
        if (!seme.ok) throw new Error(`semis impossible : ${seme.error.message}`);
      }
      const joue = await tx.query(CORPS);
      if (!joue.ok) erreur = joue.error.message;
      // Échec DÉLIBÉRÉ : il provoque le rollback, quoi qu'il arrive au-dessus.
      return err(jarvisError('INTERNAL', 'rollback volontaire'));
    });
    return erreur;
  }

  /* ================================================================== *
   * ELLE REFUSE — et elle nomme ce qui bloque
   * ================================================================== */

  it("REFUSE une mémoire GREEN dont la catégorie ne confirme pas le public", async () => {
    /* LE CAS QUE `docs/14 §5` REDOUTE, MOT POUR MOT : « une donnée aujourd'hui
       GREEN par défaut d'attention deviendrait publiquement envoyable ». */
    const erreur = await essayer([
      memoire('note anodine en apparence', 'GREEN', 'PERSONAL_MEMORY'),
    ]);

    expect(erreur, 'la migration devait échouer').not.toBeNull();
    expect(erreur).toContain('MIGRATION REFUSÉE');
    // Elle NOMME la catégorie fautive : un refus qu'on ne peut pas instruire
    // ne sert qu'à bloquer, pas à corriger.
    expect(erreur).toContain('PERSONAL_MEMORY');
    expect(erreur).toContain('ligne par ligne');
  }, 30_000);

  it('REFUSE toute note GREEN — `notes` ne porte aucune catégorie', async () => {
    /* Aucune confirmation n'est possible sur cette table : les convertir
       reviendrait littéralement à deviner. Leur seule présence bloque, par
       construction plutôt que par vigilance. */
    const erreur = await essayer([
      `INSERT INTO notes (content, privacy_class) VALUES ('une note', 'GREEN')`,
    ]);

    expect(erreur).not.toBeNull();
    expect(erreur).toContain('MIGRATION REFUSÉE');
    expect(erreur).toContain('DEVINER');
  }, 30_000);

  /* ================================================================== *
   * CONTRÔLE NÉGATIF — elle n'est pas bloquée en permanence
   * ================================================================== */

  it("ACCEPTE quand chaque GREEN est confirmé par sa catégorie", async () => {
    /* Sans ce test, les deux précédents seraient verts en échouant TOUJOURS —
       il suffirait d'une migration cassée pour « prouver » qu'elle refuse.

       `WEATHER` est la seule catégorie dont le plancher est `PUBLIC`
       (`docs/14 §3`) : c'est donc la seule qui confirme qu'une donnée `GREEN`
       est réellement publique. */
    const erreur = await essayer([
      `DELETE FROM notes WHERE privacy_class = 'GREEN'`,
      `DELETE FROM memories WHERE privacy_class = 'GREEN'`,
      memoire('il pleut', 'GREEN', 'WEATHER'),
    ]);

    expect(erreur, `la migration devait passer, elle a rendu : ${erreur ?? ''}`).toBeNull();
  }, 30_000);

  it('convertit alors correctement, et un CREDENTIAL devient RESTRICTED', async () => {
    /* `docs/14 §5` : « les CREDENTIAL devront être re-classés RESTRICTED par
       leur CATÉGORIE, pas par leur ancienne classe ». On le vérifie sur le
       résultat réel de la migration, dans la transaction annulée. */
    let niveaux: { data_category: string; data_level: string }[] = [];
    await db.transaction(async (tx) => {
      await tx.query(`DELETE FROM notes WHERE privacy_class = 'GREEN'`);
      await tx.query(`DELETE FROM memories WHERE privacy_class = 'GREEN'`);
      await tx.query(memoire('jeton', 'RED', 'CREDENTIAL'));
      await tx.query(memoire('rendez-vous', 'ORANGE', 'CALENDAR'));
      await tx.query(memoire('une tâche', 'ORANGE', 'TASK'));

      const joue = await tx.query(CORPS);
      expect(joue.ok, joue.ok ? '' : joue.error.message).toBe(true);

      const lu = await tx.query<{ data_category: string; data_level: string }>(
        `SELECT data_category, data_level FROM memories
          WHERE data_category IN ('CREDENTIAL','CALENDAR','TASK')`,
      );
      if (lu.ok) niveaux = [...lu.value.rows];
      return err(jarvisError('INTERNAL', 'rollback volontaire'));
    });

    const par = (c: string): string | undefined =>
      niveaux.find((n) => n.data_category === c)?.data_level;

    // Le plancher de la CATÉGORIE l'emporte sur l'ancienne classe.
    expect(par('CREDENTIAL')).toBe('RESTRICTED');
    expect(par('CALENDAR')).toBe('SENSITIVE');
    expect(par('TASK')).toBe('PERSONAL');
  }, 30_000);

  /* ================================================================== *
   * ELLE N'EST PAS APPLIQUÉE — et ce n'est pas qu'une déclaration
   * ================================================================== */

  it("n'est PAS dans le chemin du lanceur de migrations", async () => {
    /* La décision se tient par la STRUCTURE, pas par la discipline : le
       lanceur ne lit que `migrations/`, et ce fichier vit ailleurs. Le jour où
       quelqu'un l'y déplace, c'est un geste délibéré — pas un oubli. */
    const { readdirSync } = await import('node:fs');
    const appliquees = readdirSync('infrastructure/db/migrations');
    expect(appliquees.some((f) => f.includes('data_level'))).toBe(false);

    const enAttente = readdirSync('infrastructure/db/migrations-en-attente');
    expect(enAttente).toContain('0013_data_level.up.sql');
    expect(enAttente).toContain('0013_data_level.down.sql');
  });

  it("la colonne `data_level` n'existe NULLE PART en base", async () => {
    /* La preuve directe, et celle qui compte : peu importe où vit le fichier
       si son effet est déjà là. */
    const colonnes = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM information_schema.columns
        WHERE column_name = 'data_level'`,
    );
    expect(colonnes.ok).toBe(true);
    if (!colonnes.ok) return;
    expect(colonnes.value.rows[0]?.n).toBe('0');
  }, 30_000);
});
