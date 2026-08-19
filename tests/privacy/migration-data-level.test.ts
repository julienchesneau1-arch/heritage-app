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
   * CE QUE LA REVUE LIGNE PAR LIGNE A TROUVÉ — ADR-076
   *
   * Les tests ci-dessus éprouvent ce que la migration REFUSE. Ceux-ci
   * éprouvent ce qu'elle laisse DERRIÈRE elle, et c'est là que sont les
   * défauts. La différence de point de vue est tout le sujet : on avait
   * vérifié la porte, jamais la pièce d'après.
   * ================================================================== */

  /**
   * Joue la migration puis un ordre applicatif, dans une transaction annulée.
   *
   * ⚠ LES DEUX `UPDATE` D'EN-TÊTE NE SONT PAS DÉCORATIFS.
   *
   * Sans eux ces tests passaient ISOLÉS et échouaient en SUITE COMPLÈTE :
   * `jarvis_test` est partagée, d'autres fichiers y sèment des lignes `GREEN`,
   * le garde-fou refusait donc la migration, et le défaut qu'on veut mesurer
   * n'était jamais atteint. Le tout en silence, parce que `db.transaction`
   * convertit une exception en `Result` — l'erreur ressortait donc comme
   * « pas d'erreur ».
   *
   * On neutralise les `GREEN` DANS la transaction annulée : ce qui est éprouvé
   * ici est l'état d'APRÈS-migration, pas le garde-fou — celui-ci a ses propres
   * tests plus haut, qui sèment leurs lignes eux-mêmes.
   *
   * `migre` distingue les deux causes d'échec possibles, au lieu de les
   * confondre dans un `null` : un refus de migration n'est pas un `INSERT` qui
   * passe.
   */
  async function apresMigration(ordre: string): Promise<string | null> {
    let erreur: string | null = null;
    let migre = false;
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
      migre = true;
      const essai = await tx.query(ordre);
      if (!essai.ok) erreur = essai.error.message;
      return err(jarvisError('INTERNAL', 'rollback volontaire'));
    });
    if (!migre) throw new Error('la migration n’a pas été jouée — test non concluant');
    return erreur;
  }

  it('⚠ BLOQUANT — après la migration, Jarvis ne peut plus RIEN écrire', async () => {
    /* LE DÉFAUT QUI AURAIT ARRÊTÉ JARVIS LE JOUR DE L'APPLICATION.

       `data_level` est `NOT NULL` SANS `DEFAULT`, et aucun `INSERT` de `src/`
       ne le renseigne — ni `src/tools/notes.ts`, ni
       `src/core/memory/store.ts`. Les deux écritures échouent donc sur une
       violation de contrainte, et Jarvis perd la mémoire et les notes d'un
       coup.

       Rien ne l'avait vu parce que toute la vérification portait sur le
       GARDE-FOU — « refuse-t-elle de deviner ? » — et aucune sur l'état du
       système APRÈS. La migration est sûre au sens où elle n'expose pas ; elle
       est inapplicable au sens où elle casse.

       ⚠ CE TEST DOIT RESTER ROUGE-SI-CORRIGÉ-À-MOITIÉ : il tombera le jour où
       un `DEFAULT` sera posé OU où le code écrira `data_level`. C'est
       exactement le signal attendu. */
    const note = await apresMigration(
      `INSERT INTO notes (content, privacy_class, operation_id)
       VALUES ('x', 'ORANGE', gen_random_uuid())`,
    );
    expect(note, 'note_create devrait échouer aujourd’hui').not.toBeNull();
    expect(note ?? '').toContain('data_level');

    const memoire = await apresMigration(
      `INSERT INTO memories (kind, memory_type, content, confidence, source,
         source_type, data_category, provenance, privacy_class, content_digest)
       VALUES ('FACT','SEMANTIC','x',0.9,'c','USER_EXPLICIT','PERSONAL_MEMORY',
               'USER','ORANGE', repeat('a',64))`,
    );
    expect(memoire, 'memory_add devrait échouer aujourd’hui').not.toBeNull();
    expect(memoire ?? '').toContain('data_level');
  }, 30_000);

  it('⚠ le PLANCHER de catégorie n’est pas tenu après la migration', async () => {
    /* SECOND DÉFAUT, PLUS SILENCIEUX QUE LE PREMIER.

       `docs/14 §3` pose une table catégorie → niveau plancher, et sa première
       propriété est : *le niveau ne peut que monter*. La migration l'applique
       UNE FOIS, dans son `UPDATE`, puis plus rien ne la tient — seule
       `CREDENTIAL` reçoit une contrainte permanente.

       Une mémoire `HEALTH` dont le plancher est `HIGHLY_SENSITIVE` peut donc
       être écrite `PUBLIC` sans que la base s'y oppose. Le jour où le code
       apprendra à renseigner `data_level` (défaut n°1), c'est lui seul qui
       tiendra le plancher — et `docs/14` dit le contraire :

         > le niveau ne peut que monter. Même mécanique que `strictest()` dans
         > le Policy Gate — et ce doit être le même code, pas un second
         > mécanisme qui lui ressemble.

       Un plancher tenu par la seule application est un second mécanisme. */
    const accepte = await apresMigration(
      `INSERT INTO memories (kind, memory_type, content, confidence, source,
         source_type, data_category, provenance, privacy_class, content_digest,
         data_level)
       VALUES ('FACT','SEMANTIC','bilan',0.9,'c','USER_EXPLICIT','HEALTH',
               'USER','RED', repeat('b',64), 'PUBLIC')`,
    );
    // `null` = accepté. C'est le défaut, et on le fige pour qu'il se voie.
    expect(accepte, 'HEALTH + PUBLIC est accepté — le plancher ne tient pas').toBeNull();
  }, 30_000);

  it('CONTRÔLE — la contrainte CREDENTIAL, elle, tient bien', async () => {
    /* Sans lui, les deux tests ci-dessus pourraient s'expliquer par une
       migration qui n'a rien créé du tout. Celui-ci montre que le mécanisme
       EXISTE et fonctionne — il n'a simplement été posé que pour une catégorie
       sur trois. */
    const refuse = await apresMigration(
      `INSERT INTO memories (kind, memory_type, content, confidence, source,
         source_type, data_category, provenance, privacy_class, content_digest,
         data_level)
       VALUES ('FACT','SEMANTIC','jeton',0.9,'c','USER_EXPLICIT','CREDENTIAL',
               'USER','RED', repeat('c',64), 'PUBLIC')`,
    );
    expect(refuse, 'CREDENTIAL + PUBLIC doit être refusé').not.toBeNull();
    expect(refuse ?? '').toContain('credential_restricted');
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
