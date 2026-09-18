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
   * CE QUE LA REVUE LIGNE PAR LIGNE A TROUVÉ — ADR-076, CORRIGÉ EN ADR-092
   *
   * Les tests ci-dessus éprouvent ce que la migration REFUSE. Ceux-ci
   * éprouvent ce qu'elle laisse DERRIÈRE elle, et c'est là qu'étaient les
   * défauts. La différence de point de vue est tout le sujet : on avait
   * vérifié la porte, jamais la pièce d'après.
   *
   * ⚠ CES TESTS ONT CHANGÉ DE SENS, ET C'ÉTAIT LEUR FONCTION.
   * Ils FIGEAIENT deux défauts — ils affirmaient qu'une écriture échoue et
   * qu'un plancher ne tient pas. ADR-076 disait qu'ils tomberaient dès qu'un
   * correctif serait posé. Le correctif est posé : ils affirment maintenant
   * l'inverse, sur les MÊMES ordres SQL.
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

  /**
   * Comme `apresMigration`, mais rend AUSSI le niveau réellement stocké.
   *
   * Sans lui, on ne pourrait vérifier du défaut n°1 que la moitié qui se voit :
   * « l'écriture passe ». Or une écriture qui passe en posant `PUBLIC` sur un
   * bilan sanguin serait pire que l'écriture qui échouait.
   */
  async function apresMigrationNiveau(
    ordre: string,
    lecture: string,
  ): Promise<{ erreur: string | null; niveau: string | null }> {
    let erreur: string | null = null;
    let niveau: string | null = null;
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
      if (!essai.ok) {
        erreur = essai.error.message;
      } else {
        const lu = await tx.query<{ data_level: string }>(lecture);
        if (lu.ok) niveau = lu.value.rows[0]?.data_level ?? null;
      }
      return err(jarvisError('INTERNAL', 'rollback volontaire'));
    });
    if (!migre) throw new Error('la migration n’a pas été jouée — test non concluant');
    return { erreur, niveau };
  }

  it('défaut n°1 CORRIGÉ — Jarvis écrit encore, et au bon niveau', async () => {
    /* LE DÉFAUT QUI AURAIT ARRÊTÉ JARVIS LE JOUR DE L'APPLICATION.

       `data_level` était `NOT NULL` SANS `DEFAULT`, et aucun `INSERT` de `src/`
       ne le renseigne — ni `src/tools/notes.ts`, ni `src/core/memory/store.ts`.
       Les deux écritures échouaient sur une violation de contrainte : Jarvis
       perdait la mémoire et les notes d'un coup.

       Rien ne l'avait vu parce que toute la vérification portait sur le
       GARDE-FOU — « refuse-t-elle de deviner ? » — et aucune sur l'état du
       système APRÈS.

       ⚠ POURQUOI PAS UN `DEFAULT 'PERSONAL'`, QUE `docs/29` PROPOSAIT.
       Parce qu'il aurait été FAUX pour toute catégorie dont le plancher est
       plus haut. Avec la contrainte de plancher posée juste après,
       `memory_add(dataCategory: 'HEALTH')` serait passé d'« impossible » à
       « refusé » — un progrès, et toujours une fonctionnalité perdue. Un
       `DEFAULT` de colonne ne peut pas lire une autre colonne ; un trigger le
       peut. C'est tout l'écart entre les deux. */
    const note = await apresMigrationNiveau(
      `INSERT INTO notes (content, privacy_class, operation_id)
       VALUES ('x', 'ORANGE', gen_random_uuid())`,
      `SELECT data_level FROM notes WHERE content = 'x'`,
    );
    expect(note.erreur, 'note_create doit passer').toBeNull();
    expect(note.niveau).toBe('PERSONAL');

    const memoire = await apresMigrationNiveau(
      `INSERT INTO memories (kind, memory_type, content, confidence, source,
         source_type, data_category, provenance, privacy_class, content_digest)
       VALUES ('FACT','SEMANTIC','x',0.9,'c','USER_EXPLICIT','PERSONAL_MEMORY',
               'USER','ORANGE', repeat('a',64))`,
      `SELECT data_level FROM memories WHERE content_digest = repeat('a',64)`,
    );
    expect(memoire.erreur, 'memory_add doit passer').toBeNull();
    expect(memoire.niveau).toBe('PERSONAL');
  }, 30_000);

  it('le trigger pose le plancher RÉEL, pas un niveau par défaut', async () => {
    /* ⚠ LE TEST QUI SÉPARE « ça écrit » DE « ça protège ».

       Le précédent aurait été vert avec un `DEFAULT 'PERSONAL'` littéral. Pas
       celui-ci : deux lignes de classe `ORANGE` — même classe, donc même
       plancher de classe — doivent ressortir à des niveaux DIFFÉRENTS, parce
       que leurs catégories diffèrent.

       Si ce test rougit sur `PERSONAL`, le trigger a été remplacé par un
       défaut plat et le plancher n'est plus tenu que par le refus. */
    const agenda = await apresMigrationNiveau(
      `INSERT INTO memories (kind, memory_type, content, confidence, source,
         source_type, data_category, provenance, privacy_class, content_digest)
       VALUES ('FACT','SEMANTIC','rdv',0.9,'c','USER_EXPLICIT','CALENDAR',
               'USER','ORANGE', repeat('d',64))`,
      `SELECT data_level FROM memories WHERE content_digest = repeat('d',64)`,
    );
    expect(agenda.erreur).toBeNull();
    // Plancher de classe ORANGE = PERSONAL ; plancher de CALENDAR = SENSITIVE.
    // La catégorie l'emporte.
    expect(agenda.niveau).toBe('SENSITIVE');

    /* Et un secret, sans rien déclarer, atterrit RESTRICTED — au-dessus de
       `HIGHLY_SENSITIVE` que sa classe `RED` imposerait seule.

       ⚠ `RED` n'est pas un choix de rédaction : `sensitive_categories_are_red`
       (migration 0005) INTERDIT toute autre classe pour CREDENTIAL, FINANCIAL
       et HEALTH. Écrire `ORANGE` ici ferait passer le test pour une raison qui
       n'a rien à voir avec ce qu'il mesure — c'est ce qui s'est produit à la
       première rédaction. */
    const secret = await apresMigrationNiveau(
      `INSERT INTO memories (kind, memory_type, content, confidence, source,
         source_type, data_category, provenance, privacy_class, content_digest)
       VALUES ('FACT','SEMANTIC','jeton',0.9,'c','USER_EXPLICIT','CREDENTIAL',
               'USER','RED', repeat('e',64))`,
      `SELECT data_level FROM memories WHERE content_digest = repeat('e',64)`,
    );
    expect(secret.erreur).toBeNull();
    expect(secret.niveau).toBe('RESTRICTED');
  }, 30_000);

  it('⚠ le trigger ne CORRIGE pas une valeur trop basse — il la laisse refuser', async () => {
    /* LA DÉCISION LA PLUS FACILE À PRENDRE À L'ENVERS.

       Le trigger sait calculer le plancher. Il pourrait donc remonter une
       valeur trop basse au lieu de laisser la contrainte refuser — « on ne va
       tout de même pas refuser une écriture qu'on sait réparer ».

       On s'en garde, et la raison est la même que celle d'`UNKNOWN` ailleurs
       dans ce dépôt : une valeur trop basse n'est pas une absence d'opinion,
       c'est du CODE QUI CROIT AVOIR CLASSÉ ET S'EST TROMPÉ. La remonter en
       silence rendrait ce défaut indétectable, et la donnée mal classée
       suivante passerait elle aussi.

       Absent ≠ trop bas. Le trigger traite le premier, la contrainte le
       second. */
    const trompeur = await apresMigration(
      `INSERT INTO memories (kind, memory_type, content, confidence, source,
         source_type, data_category, provenance, privacy_class, content_digest,
         data_level)
       VALUES ('FACT','SEMANTIC','bilan',0.9,'c','USER_EXPLICIT','HEALTH',
               'USER','RED', repeat('b',64), 'PUBLIC')`,
    );
    expect(trompeur, 'HEALTH + PUBLIC déclaré doit être REFUSÉ').not.toBeNull();
    expect(trompeur ?? '').toContain('plancher');
  }, 30_000);

  it('défaut n°2 CORRIGÉ — le plancher tient pour les 14 catégories', async () => {
    /* SECOND DÉFAUT, PLUS SILENCIEUX QUE LE PREMIER.

       `docs/14 §3` pose une table catégorie → niveau plancher, et sa première
       propriété est : *le niveau ne peut que monter*. La migration l'appliquait
       UNE FOIS, dans son `UPDATE`, puis plus rien ne la tenait — seule
       `CREDENTIAL` recevait une contrainte permanente :

         > le niveau ne peut que monter. Même mécanique que `strictest()` dans
         > le Policy Gate — et ce doit être le même code, pas un second
         > mécanisme qui lui ressemble.

       On éprouve ici les deux catégories que la revue nommait, PLUS trois
       `SENSITIVE` qu'elle ne nommait pas — sans quoi le test serait vert avec
       une contrainte écrite pour les seuls cas cités dans le rapport, ce qui
       est précisément l'erreur qu'on répare. `CREDENTIAL` a son propre test
       plus bas, pour une raison qui y est expliquée.

       ⚠ LA CLASSE EST CHOISIE, PAS SUBIE. `sensitive_categories_are_red`
       (migration 0005) impose `RED` à CREDENTIAL, FINANCIAL et HEALTH : leur
       écrire `ORANGE` les aurait fait refuser par CETTE contrainte-là, et le
       test aurait été vert sans jamais atteindre le plancher qu'il mesure.
       Pour les catégories SENSITIVE on garde `ORANGE`, dont le plancher de
       classe (`PERSONAL`) est plus BAS que celui de la catégorie : seul le
       plancher de CATÉGORIE peut alors expliquer le refus. */
    for (const [categorie, classe, trop_bas] of [
      ['HEALTH', 'RED', 'PUBLIC'],
      ['FINANCIAL', 'RED', 'PERSONAL'],
      ['CALENDAR', 'ORANGE', 'PERSONAL'],
      ['EMAIL', 'ORANGE', 'PUBLIC'],
      ['DOCUMENT', 'ORANGE', 'PERSONAL'],
    ] as const) {
      const refuse = await apresMigration(
        `INSERT INTO memories (kind, memory_type, content, confidence, source,
           source_type, data_category, provenance, privacy_class, content_digest,
           data_level)
         VALUES ('FACT','SEMANTIC','x',0.9,'c','USER_EXPLICIT','${categorie}',
                 'USER','${classe}', repeat('f',64), '${trop_bas}')`,
      );
      expect(refuse, `${categorie} + ${trop_bas} doit être refusé`).not.toBeNull();
      expect(
        refuse ?? '',
        `${categorie} doit être refusé par le PLANCHER, pas par autre chose`,
      ).toContain('plancher');
    }
  }, 60_000);

  it('CONTRÔLE — le plancher ne refuse pas TOUT', async () => {
    /* ⚠ SANS CE TEST, LES TROIS PRÉCÉDENTS SONT GRATUITS.

       Une contrainte écrite à l'envers — refusant toute écriture — les rendrait
       tous verts. On vérifie donc qu'au-DESSUS du plancher, ça passe : une
       mémoire `TASK` déclarée `SENSITIVE` (au-dessus de son plancher
       `PERSONAL`) doit être acceptée TELLE QUELLE, sans être redescendue. Le
       niveau peut monter : c'est la moitié de la règle qu'on oublie de tester. */
    const monte = await apresMigrationNiveau(
      `INSERT INTO memories (kind, memory_type, content, confidence, source,
         source_type, data_category, provenance, privacy_class, content_digest,
         data_level)
       VALUES ('FACT','SEMANTIC','x',0.9,'c','USER_EXPLICIT','TASK',
               'USER','ORANGE', repeat('g',64), 'SENSITIVE')`,
      `SELECT data_level FROM memories WHERE content_digest = repeat('g',64)`,
    );
    expect(monte.erreur, 'monter au-dessus du plancher doit être permis').toBeNull();
    expect(monte.niveau, 'et le niveau demandé ne doit pas être redescendu').toBe(
      'SENSITIVE',
    );
  }, 30_000);

  it('défaut n°3 TRANCHÉ — `privacy_class` et `data_level` ne peuvent plus diverger', async () => {
    /* LA QUESTION QUE `docs/29` LAISSAIT OUVERTE.

       `privacy_class` survit à la migration. ADR-041 : « deux registres du même
       fait finissent par diverger ». Le choix était entre une contrainte qui
       les lie et une migration ultérieure qui retire l'ancien.

       ADR-092 tranche pour la contrainte : retirer `privacy_class` toucherait
       chaque outil du dépôt. Ce qui est interdit, c'est la divergence DANS LA
       SEULE DIRECTION QUI EXPOSE — une ligne `RED` portant un niveau qui dit
       « envoyable ». Dans l'autre sens rien n'est contraint : une ligne peut
       être PLUS protégée que sa vieille classe ne le dit, et c'est exactement
       `strictest()`. */
    const contradiction = await apresMigration(
      `INSERT INTO memories (kind, memory_type, content, confidence, source,
         source_type, data_category, provenance, privacy_class, content_digest,
         data_level)
       VALUES ('FACT','SEMANTIC','x',0.9,'c','USER_EXPLICIT','TASK',
               'USER','RED', repeat('h',64), 'PERSONAL')`,
    );
    expect(
      contradiction,
      'RED + PERSONAL est une contradiction entre les deux registres',
    ).not.toBeNull();

    // Et l'inverse — plus protégé que la classe ne l'exige — reste permis.
    const plusProtege = await apresMigration(
      `INSERT INTO memories (kind, memory_type, content, confidence, source,
         source_type, data_category, provenance, privacy_class, content_digest,
         data_level)
       VALUES ('FACT','SEMANTIC','x',0.9,'c','USER_EXPLICIT','TASK',
               'USER','ORANGE', repeat('i',64), 'RESTRICTED')`,
    );
    expect(plusProtege, 'monter au-dessus de sa classe doit rester permis').toBeNull();
  }, 30_000);

  it('⚠ la contrainte CREDENTIAL tient SEULE — plancher général retiré', async () => {
    /* POURQUOI CE TEST NE RESSEMBLE À AUCUN AUTRE DE CE FICHIER.

       `memories_credential_restricted` est REDONDANTE avec le plancher
       général : `jarvis_plancher('CREDENTIAL', …)` rend déjà `RESTRICTED`. Un
       test qui se contenterait d'insérer un CREDENTIAL trop bas serait donc
       vert même si cette contrainte avait été supprimée — c'est l'autre qui
       aurait refusé, et on n'aurait mesuré que la redondance.

       On RETIRE donc le plancher général avant d'essayer. Ce qui reste est la
       seule règle du système qu'on accepte d'écrire deux fois, et la raison de
       ce choix : elle est écrite en clair, sans appeler aucune fonction, donc
       elle survit à une erreur dans `jarvis_plancher_categorie` que le test
       d'accord SQL/TS n'aurait pas attrapée.

       Un secret envoyé ne se répare pas. C'est le seul endroit où la ceinture
       ET les bretelles se justifient. */
    let refus: string | null = null;
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

      const retire = await tx.query(
        'ALTER TABLE memories DROP CONSTRAINT memories_data_level_plancher',
      );
      if (!retire.ok) return err(jarvisError('INTERNAL', retire.error.message));
      migre = true;

      const essai = await tx.query(
        `INSERT INTO memories (kind, memory_type, content, confidence, source,
           source_type, data_category, provenance, privacy_class, content_digest,
           data_level)
         VALUES ('FACT','SEMANTIC','jeton',0.9,'c','USER_EXPLICIT','CREDENTIAL',
                 'USER','RED', repeat('c',64), 'HIGHLY_SENSITIVE')`,
      );
      if (!essai.ok) refus = essai.error.message;
      return err(jarvisError('INTERNAL', 'rollback volontaire'));
    });

    if (!migre) throw new Error('la migration n’a pas été jouée — test non concluant');
    expect(refus, 'un secret sous RESTRICTED doit être refusé, plancher ou pas').not.toBeNull();
    expect(refus ?? '').toContain('credential_restricted');
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
