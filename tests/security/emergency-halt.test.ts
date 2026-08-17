/**
 * ARRÊT D'URGENCE — scénario doré **05/C2**, `CRITIQUE`.
 *
 *   > **Entrée :** « Jarvis, stop. »
 *   > **Attendu :** sorties interrompues, actions en attente annulées, actions
 *   > externes bloquées, **journal conservé**.
 *
 * CE SCÉNARIO ÉTAIT COMPTÉ COMME COUVERT PAR UNE COLLISION DE CHAÎNE.
 * -------------------------------------------------------------------
 * Le compteur doré cherchait `\bC2\b`. Le seul « C2 » du dépôt vivait dans
 * `intent-journal.test.ts` — « matrice adversariale **ligne C2** », la ligne
 * d'un TOUT AUTRE tableau. Aucune capacité d'arrêt d'urgence n'existait, et
 * `docs/28` affichait pourtant 27/30 (ADR-057).
 *
 * QUATRE PROPRIÉTÉS, ET LA QUATRIÈME EST CELLE QU'ON OUBLIE
 * ----------------------------------------------------------
 *   1. les actions EN ATTENTE sont annulées
 *   2. les actions nouvelles sont bloquées — mais pas les lectures locales
 *   3. les actions EN VOL ne sont PAS prétendues annulées (`docs/26 §5`)
 *   4. le journal est CONSERVÉ — un arrêt qui efface les traces serait
 *      l'inverse exact de ce qu'on veut d'un arrêt d'urgence
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appDb, databaseAvailable, ownerDb } from '../helpers/db.js';
import { buildStack, callContext, operationId } from '../helpers/stack.js';
import { createEmergencyHalt } from '../../src/core/safety/halt.js';
import { err, jarvisError } from '../../src/core/types/result.js';
import type { Db } from '../../src/core/db/client.js';

const enabled = databaseAvailable();

let compteur = 0;
const op = (p: string): ReturnType<typeof operationId> =>
  operationId(`${p}-${String(Date.now())}-${String(++compteur)}`);

describe.runIf(enabled)('arrêt d’urgence — 05/C2', () => {
  let db: Db;

  beforeAll(() => {
    db = appDb();
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    // Chaque test part d'un Jarvis NON arrêté. On lève par SQL plutôt que par
    // `release()` : le nettoyage ne doit pas dépendre du code sous test.
    await db.query(
      `UPDATE emergency_halt SET released_at = now(), released_by = 'USER'
        WHERE released_at IS NULL`,
    );
  });

  /* ================================================================== *
   * 2 — les actions nouvelles sont bloquées
   * ================================================================== */

  it('C2 — une MUTATION est refusée pendant un arrêt', async () => {
    const halt = createEmergencyHalt(db);
    const stack = buildStack(db);

    const engagé = await halt.engage('USER', 'test — « Jarvis, stop »');
    expect(engagé.ok, engagé.ok ? '' : engagé.error.message).toBe(true);

    const refus = await stack.gateway.invoke({
      toolId: 'task_create',
      input: { title: 'ne doit pas exister' },
      parameterProvenance: { title: 'USER' },
      operationId: op('halt-mut'),
      actor: 'USER',
      context: callContext({ userConfirmed: true }),
    });

    expect(refus.ok).toBe(false);
    if (refus.ok) return;
    expect(refus.error.kind).toBe('POLICY_DENIED');
    expect(refus.error.message).toContain('Arrêt d’urgence actif');
  }, 30_000);

  it('C2 — une action SORTANTE est refusée, même en L1', async () => {
    /* `web_search` est L1 : sans la clause `networkRequired`, il passerait au
       travers de l'arrêt. C'est le cas que la formulation « actions externes
       bloquées » vise en premier. */
    const halt = createEmergencyHalt(db);
    const stack = buildStack(db);
    await halt.engage('USER', 'test — sortie pendant arrêt');

    const refus = await stack.gateway.invoke({
      toolId: 'web_search',
      input: { query: 'sujet anodin', limit: 3 },
      parameterProvenance: { query: 'USER', limit: 'USER' },
      operationId: op('halt-web'),
      actor: 'USER',
      context: callContext({ cloudEnabled: true, userConfirmed: true }),
    });

    expect(refus.ok).toBe(false);
    if (refus.ok) return;
    expect(refus.error.kind).toBe('POLICY_DENIED');
  }, 30_000);

  it('LES LECTURES LOCALES RESTENT DISPONIBLES — sinon l’arrêt est indiagnosticable', async () => {
    /* LA CONTRE-ÉPREUVE, et elle vaut autant que les refus.

       Après avoir dit « stop », on a PLUS besoin de comprendre, pas moins.
       Un arrêt qui coupe `audit_query`, `system_status` et `egress_review`
       laisse l'utilisateur devant un système muet — et c'est le moment où il
       a le plus besoin de voir. Même raisonnement que l'invariant I12, qui
       place sa garde après l'observation et pas avant. */
    const halt = createEmergencyHalt(db);
    const stack = buildStack(db);
    await halt.engage('USER', 'test — lectures pendant arrêt');

    for (const [toolId, input] of [
      ['audit_query', { limit: 5 }],
      ['system_status', {}],
      ['egress_review', { window: 'today', limit: 5 }],
      ['task_list', {}],
    ] as const) {
      const lu = await stack.gateway.invoke({
        toolId,
        input,
        parameterProvenance: {},
        operationId: op(`halt-lecture-${toolId}`),
        actor: 'USER',
        context: callContext(),
      });
      expect(lu.ok, `${toolId} : ${lu.ok ? '' : lu.error.message}`).toBe(true);
    }
  }, 60_000);

  it('TOUT REDEVIENT POSSIBLE après la levée — l’arrêt n’est pas une panne', async () => {
    const halt = createEmergencyHalt(db);
    const stack = buildStack(db);
    await halt.engage('USER', 'test — levée');

    const levé = await halt.release('USER', 'test terminé');
    expect(levé.ok, levé.ok ? '' : levé.error.message).toBe(true);

    const après = await stack.gateway.invoke({
      toolId: 'task_create',
      input: { title: 'après la levée' },
      parameterProvenance: { title: 'USER' },
      operationId: op('halt-apres'),
      actor: 'USER',
      context: callContext({ userConfirmed: true }),
    });
    expect(après.ok, après.ok ? '' : après.error.message).toBe(true);
  }, 30_000);

  /* ================================================================== *
   * 1 et 3 — ce qui est annulé, et ce qui ne l'est PAS
   * ================================================================== */

  it('annule les actions EN ATTENTE — et l’état s’appelle bien PLANNED', async () => {
    /* ⚠ CE TEST EXISTE PARCE QUE J'AVAIS SUPPOSÉ `PENDING`.

       L'état réel est `PLANNED`. Avec la mauvaise valeur, l'`UPDATE` aurait
       trouvé zéro ligne : aucune erreur, aucun test rouge, et un arrêt
       d'urgence qui n'annule RIEN. Le nom de l'état est donc éprouvé sur des
       lignes réelles, pas relu dans une migration. */
    const halt = createEmergencyHalt(db);
    const id = `halt-planifiee-${String(Date.now())}`;

    /* LES COLONNES RÉELLES, PAS CELLES SUPPOSÉES : `tool_version` et `actor`
       sont NOT NULL, et `input_digest` exige 64 caractères hexadécimaux. Une
       fixture approximative aurait échoué à l'insertion — ce qui est le bon
       sens de l'erreur, mais fait perdre du temps. */
    const semé = await db.query(
      `INSERT INTO tool_operations
         (operation_id, tool_id, tool_version, input_digest, actor, state)
       VALUES ($1, 'task_create', '1.0.0', repeat('a', 64), 'USER', 'PLANNED')`,
      [id],
    );
    expect(semé.ok, semé.ok ? '' : semé.error.message).toBe(true);

    const engagé = await halt.engage('USER', 'test — annulation des planifiées');
    expect(engagé.ok).toBe(true);
    if (!engagé.ok) return;
    expect(engagé.value.cancelledPending).toBeGreaterThan(0);

    const relu = await db.query<{ state: string; recovery_detail: string | null }>(
      'SELECT state, recovery_detail FROM tool_operations WHERE operation_id = $1',
      [id],
    );
    expect(relu.ok).toBe(true);
    if (!relu.ok) return;
    expect(relu.value.rows[0]?.state).toBe('FAILED');
    expect(relu.value.rows[0]?.recovery_detail).toContain('arrêt d’urgence');
  }, 30_000);

  it('NE PRÉTEND PAS annuler ce qui est déjà parti — et le COMPTE à part', async () => {
    /* `docs/26 §5` : « annuler une requête déjà partie — rien dans la pile ne
       l'offre ». Une opération `COMMITTED_TO_EXECUTION` a peut-être produit
       son effet dans le monde. La marquer annulée effacerait la seule trace
       qu'une requête est partie.

       `docs/05 §C2` dit « actions **en attente** annulées » — pas « en vol ».
       Le document et la limite disent la même chose, et le code doit dire les
       deux séparément plutôt que de les fondre en un chiffre rassurant. */
    const halt = createEmergencyHalt(db);
    const id = `halt-envol-${String(Date.now())}`;

    const semé = await db.query(
      `INSERT INTO tool_operations
         (operation_id, tool_id, tool_version, input_digest, actor, state,
          committed_at, lease_expires_at)
       VALUES ($1, 'task_create', '1.0.0', repeat('b', 64), 'USER',
               'COMMITTED_TO_EXECUTION',
               clock_timestamp(), clock_timestamp() + interval '5 minutes')`,
      [id],
    );
    expect(semé.ok, semé.ok ? '' : semé.error.message).toBe(true);

    const engagé = await halt.engage('USER', 'test — en vol intouchée');
    expect(engagé.ok).toBe(true);
    if (!engagé.ok) return;
    expect(engagé.value.inFlightUntouched).toBeGreaterThan(0);

    const relu = await db.query<{ state: string }>(
      'SELECT state FROM tool_operations WHERE operation_id = $1',
      [id],
    );
    expect(relu.ok).toBe(true);
    if (!relu.ok) return;
    // INTOUCHÉE. Son sort est inconnu, et c'est ce qu'il faut dire.
    expect(relu.value.rows[0]?.state).toBe('COMMITTED_TO_EXECUTION');
  }, 30_000);

  /* ================================================================== *
   * 4 — le journal est CONSERVÉ
   * ================================================================== */

  it('C2 — le JOURNAL est conservé, et le refus y est inscrit', async () => {
    const halt = createEmergencyHalt(db);
    const stack = buildStack(db);

    const avant = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM event_ledger',
    );
    expect(avant.ok).toBe(true);
    if (!avant.ok) return;

    await halt.engage('USER', 'test — journal conservé');
    const id = op('halt-journal');
    await stack.gateway.invoke({
      toolId: 'task_create',
      input: { title: 'refusée' },
      parameterProvenance: { title: 'USER' },
      operationId: id,
      actor: 'USER',
      context: callContext({ userConfirmed: true }),
    });

    const après = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM event_ledger',
    );
    expect(après.ok).toBe(true);
    if (!après.ok) return;
    // STRICTEMENT CROISSANT : rien n'a été effacé, et le refus est ajouté.
    expect(Number(après.value.rows[0]?.n)).toBeGreaterThan(
      Number(avant.value.rows[0]?.n),
    );

    const refusJournalisé = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM event_ledger
        WHERE event_type LIKE '%_HALTED' AND operation_id = $1`,
      [String(id)],
    );
    expect(refusJournalisé.ok).toBe(true);
    if (!refusJournalisé.ok) return;
    expect(refusJournalisé.value.rows[0]?.n).toBe('1');
  }, 30_000);

  /* ================================================================== *
   * LA DISSYMÉTRIE ENGAGER / LEVER
   * ================================================================== */

  it('SEUL l’utilisateur peut LEVER — ce qui a déclenché l’arrêt ne le lève pas', async () => {
    /* Sans cette règle, une injection indirecte enchaînerait arrêt → levée et
       n'aurait fait que du bruit. Avec elle, la levée est un point de contrôle
       humain qu'aucun contenu externe ne franchit. */
    const halt = createEmergencyHalt(db);
    await halt.engage('USER', 'test — dissymétrie');

    for (const acteur of ['JARVIS', 'AUTOMATION', 'SYSTEM', 'EXTERNAL_SERVICE'] as const) {
      const tenté = await halt.release(acteur, 'je me lève moi-même');
      expect(tenté.ok, acteur).toBe(false);
      if (!tenté.ok) expect(tenté.error.kind).toBe('POLICY_DENIED');
    }

    // CONTRÔLE NÉGATIF : l'utilisateur, lui, y arrive.
    const parUtilisateur = await halt.release('USER', 'levée légitime');
    expect(parUtilisateur.ok).toBe(true);
  }, 30_000);

  it('ENGAGER est permissif — un arrêt de trop ne coûte rien, un arrêt manqué si', async () => {
    /* La dissymétrie dans l'autre sens. Un modèle manipulé qui déclencherait
       un arrêt n'obtient qu'un Jarvis arrêté : bruyant, visible, sans dommage.
       Le contraindre créerait le risque d'un arrêt refusé au mauvais moment. */
    const halt = createEmergencyHalt(db);
    const parJarvis = await halt.engage('JARVIS', 'anomalie détectée');
    expect(parJarvis.ok, parJarvis.ok ? '' : parJarvis.error.message).toBe(true);
  }, 30_000);

  it('« stop » RÉPÉTÉ ne casse rien — un seul arrêt actif, et il est IDEMPOTENT', async () => {
    /* Quelqu'un qui panique tape trois fois. Une violation d'unicité à ce
       moment-là serait le pire moment pour échouer. */
    const halt = createEmergencyHalt(db);
    const a = await halt.engage('USER', 'panique 1');
    const b = await halt.engage('USER', 'panique 2');
    const c = await halt.engage('USER', 'panique 3');

    expect(a.ok && b.ok && c.ok).toBe(true);
    if (!a.ok || !b.ok || !c.ok) return;
    // MÊME arrêt : le motif du premier est celui qui compte.
    expect(b.value.haltId).toBe(a.value.haltId);
    expect(c.value.haltId).toBe(a.value.haltId);

    const actifs = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM emergency_halt WHERE released_at IS NULL',
    );
    expect(actifs.ok).toBe(true);
    if (!actifs.ok) return;
    expect(actifs.value.rows[0]?.n).toBe('1');
  }, 30_000);

  it('LEVER un arrêt inexistant est une ERREUR, pas un succès silencieux', async () => {
    // Rendre `ok` laisserait croire qu'on vient de rétablir quelque chose.
    const halt = createEmergencyHalt(db);
    const àVide = await halt.release('USER', 'rien à lever');
    expect(àVide.ok).toBe(false);
    if (!àVide.ok) expect(àVide.error.kind).toBe('NOT_FOUND');
  }, 30_000);

  it('un arrêt SANS MOTIF est refusé — un motif absent est ingérable une heure après', async () => {
    const halt = createEmergencyHalt(db);
    const sansMotif = await halt.engage('USER', '   ');
    expect(sansMotif.ok).toBe(false);
    if (!sansMotif.ok) expect(sansMotif.error.kind).toBe('VALIDATION');
  }, 30_000);

  /* ================================================================== *
   * L'ARRÊT SURVIT AU PROCESSUS
   * ================================================================== */

  it('SURVIT à un redémarrage — un arrêt effacé par un reboot n’est pas un arrêt', async () => {
    /* Le cas où l'on appuie sur le bouton est précisément celui où quelque
       chose va mal, donc celui où le processus peut tomber. Un arrêt gardé en
       mémoire laisserait Jarvis se réveiller en reprenant ses actions.

       On le prouve en construisant une pile ENTIÈREMENT NEUVE — nouveau
       gateway, nouvelle instance de halt — sans rien lui transmettre. */
    const halt = createEmergencyHalt(db);
    await halt.engage('USER', 'test — survie au redémarrage');

    const nouvellePile = buildStack(db);
    const refus = await nouvellePile.gateway.invoke({
      toolId: 'task_create',
      input: { title: 'après un redémarrage simulé' },
      parameterProvenance: { title: 'USER' },
      operationId: op('halt-reboot'),
      actor: 'USER',
      context: callContext({ userConfirmed: true }),
    });
    expect(refus.ok).toBe(false);
    if (!refus.ok) expect(refus.error.kind).toBe('POLICY_DENIED');

    const relu = await createEmergencyHalt(db).state();
    expect(relu.ok).toBe(true);
    if (!relu.ok) return;
    expect(relu.value.halted).toBe(true);
    expect(relu.value.reason).toContain('redémarrage');
  }, 30_000);

  /* ================================================================== *
   * LE REPLI FERMÉ — la propriété que le sabotage a trouvée SANS TEST
   * ================================================================== */

  it('NE SE REPLIE PAS sur « pas arrêté » quand la base est illisible', async () => {
    /* ⚠ CE TEST EXISTE PARCE QU'UN SABOTAGE N'A RIEN ATTRAPÉ.

       Remplacer `if (!rows.ok) return rows;` par `return ok({ halted: false })`
       laissait les treize autres tests VERTS. C'est pourtant le mode de panne
       le plus coûteux du fichier : une panne de lecture transformée en
       autorisation d'agir — un arrêt d'urgence que la moindre indisponibilité
       de la base neutralise en silence.

       Troisième fois dans ce dépôt qu'un sabotage révèle un test manquant
       plutôt qu'un défaut de code. Le motif est stable : **un chemin d'erreur
       que rien ne provoque n'est pas éprouvé, il est seulement écrit.** */
    const cassée: Db = {
      query: () =>
        Promise.resolve(err(jarvisError('INTERNAL', 'base injoignable (simulé)'))),
      transaction: () =>
        Promise.resolve(err(jarvisError('INTERNAL', 'base injoignable (simulé)'))),
      health: () => ({ state: 'DOWN' as const, since: new Date().toISOString(), reason: 'simulé' }),
      close: () => Promise.resolve(),
    };

    const état = await createEmergencyHalt(cassée).state();
    // L'ERREUR REMONTE. Elle ne devient pas « tout va bien ».
    expect(état.ok).toBe(false);
  });

  it('le GATEWAY refuse quand il ne peut pas LIRE l’état d’arrêt', async () => {
    /* La contre-partie côté produit, et la seule façon de l'atteindre : le
       Gateway construit son `EmergencyHalt` lui-même (jamais injecté, pour
       qu'aucune doublure ne puisse répondre « pas arrêté »). On retire donc
       réellement le droit de lecture au rôle applicatif.

       Restauré dans un `finally` — `docs/26 §2.3` : un test qui casse un
       objet partagé doit le rendre intact. */
    const owner = ownerDb();
    const stack = buildStack(db);
    try {
      const revoke = await owner.query('REVOKE SELECT ON emergency_halt FROM jarvis_app');
      expect(revoke.ok, revoke.ok ? '' : revoke.error.message).toBe(true);

      const refus = await stack.gateway.invoke({
        toolId: 'task_create',
        input: { title: 'pendant une base illisible' },
        parameterProvenance: { title: 'USER' },
        operationId: op('halt-illisible'),
        actor: 'USER',
        context: callContext({ userConfirmed: true }),
      });

      expect(refus.ok).toBe(false);
      if (refus.ok) return;
      expect(refus.error.kind).toBe('POLICY_DENIED');
      expect(refus.error.message).toContain('illisible');
    } finally {
      await owner.query('GRANT SELECT ON emergency_halt TO jarvis_app');
      await owner.close();
    }
  }, 30_000);

  it('CONTRÔLE NÉGATIF — le droit de lecture est bien rendu', async () => {
    /* Sans lui, le test précédent pourrait laisser la base amputée et tous les
       suivants échoueraient pour une raison qui n'a rien à voir. */
    const lu = await db.query('SELECT count(*) FROM emergency_halt');
    expect(lu.ok, lu.ok ? '' : lu.error.message).toBe(true);
  }, 30_000);
});
