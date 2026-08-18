/**
 * DEUX TROUS DANS CE QUE JE VENAIS D'ÉCRIRE.
 *
 * Trois commits de code porteur de sûreté — `memory_forget`, l'Undo Engine, les
 * trois outils inverses — méritaient le traitement adverse appliqué au reste du
 * dépôt. Le balayage « quels exports ne sont cités par aucun test ? » en a rendu
 * deux, et le sabotage a tranché lequel comptait.
 *
 * ---------------------------------------------------------------------------
 * **1. `erased()` POUVAIT MENTIR SUR SA PREUVE, EN SILENCE.**
 *
 * Mesuré : en lui faisant rendre `POSITIVE_PRESENCE` au lieu de
 * `POSITIVE_ABSENCE`, **les 818 tests restaient verts.**
 *
 * Or c'est toute la raison d'être de cette fabrique (ADR-065) : un outil dont
 * le succès EST une absence doit pouvoir le dire *avec la bonne preuve*. Si
 * l'évidence est fausse, la fabrique redevient un `confirmed()` déguisé —
 * précisément ce qu'elle existait pour éviter.
 *
 * Pourquoi rien ne rougissait : personne ne CONSOMME encore cette évidence.
 * `memory_forget` construit ses cibles à la main pour la projection, sans
 * repasser par `erased`. La valeur était donc de la documentation, pas un
 * mécanisme — la famille de défaut que `docs/26 §2` recense sept fois.
 *
 * ---------------------------------------------------------------------------
 * **2. `previewLast()` N'ÉTAIT « CITÉ » QUE PAR UN GREP.**
 *
 * `wiring.test.ts` vérifie que le texte du CLI contient
 * `runtime.undo.previewLast()`. C'est un test de CÂBLAGE, pas de comportement :
 * il prouve que la fonction est appelée, jamais qu'elle dit vrai.
 *
 * Et c'est la fonction qui décide de **ce que l'humain lit avant de confirmer
 * un acte irréversible**. Le même défaut qu'ADR-063 : le pipeline réparé,
 * l'affichage oublié. Deux fois la même leçon dans la même session.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appDb, databaseAvailable } from '../helpers/db.js';
import { buildStack, callContext, operationId, type Stack } from '../helpers/stack.js';
import { createUndoEngine, type UndoEngine } from '../../src/core/undo/engine.js';
import { createSnapshotStore, type SnapshotStore } from '../../src/core/undo/snapshots.js';
import {
  constrainToVerifiability as brider,
  verificationOutcome,
} from '../../src/core/verification/engine.js';
import { projectStatus } from '../../src/core/tools/outcome.js';
import type { Db } from '../../src/core/db/client.js';

const enabled = databaseAvailable();

let compteur = 0;
const suffixe = (): string => `${String(Date.now())}-${String(++compteur)}`;

/* ====================================================================== *
 * 1. LA FABRIQUE — sans base
 * ====================================================================== */

describe('erased() — un succès dont la preuve est une ABSENCE', () => {
  const sortie = verificationOutcome.erased({
    observed: 'la ligne a disparu',
    conclusiveBecause: 'lecture transactionnelle après commit',
  });

  it('rend CONFIRMED — effacer réussi est un succès, pas un échec', () => {
    /* Avant ADR-065, la seule fabrique rendant `POSITIVE_ABSENCE` était
       `failed()`. Un outil d'effacement n'avait donc le choix qu'entre mentir
       sur la preuve et sous-déclarer son propre succès. */
    expect(sortie.status).toBe('CONFIRMED');
  });

  it('porte POSITIVE_ABSENCE — et c’est le trou que le sabotage a trouvé', () => {
    /* ⚠ CETTE ASSERTION EST LA RAISON D'ÊTRE DU FICHIER.
       Mesuré : `POSITIVE_PRESENCE` à la place → 818 tests verts. La fabrique
       redevenait un `confirmed()` déguisé sans que rien ne le dise. */
    expect(sortie.evidence).toBe('POSITIVE_ABSENCE');
  });

  it('exige de DIRE pourquoi l’observation est concluante', () => {
    /* Même exigence que `failed()`, et pour la même raison : face à une file
       d'attente, « zéro ligne » ne prouve rien. Le motif doit atteindre le
       texte, sinon il n'est qu'un paramètre qu'on remplit sans y penser. */
    expect(sortie.detail).toContain('lecture transactionnelle après commit');
    expect(sortie.detail).toContain('la ligne a disparu');
  });

  it('se DISTINGUE de confirmed() — deux succès, deux preuves', () => {
    const additif = verificationOutcome.confirmed({ observed: 'la ligne est là' });
    expect(additif.status).toBe(sortie.status);
    // Même statut, preuve opposée : c'est exactement ce que le champ existe
    // pour porter. Un test qui ne compare que le statut ne verrait rien.
    expect(additif.evidence).not.toBe(sortie.evidence);
  });

  it('CONTRÔLE NÉGATIF — la projection d’effacement DÉPEND de cette preuve', () => {
    /* Ce qui rend l'assertion ci-dessus autre chose qu'un test de constante :
       on montre la conséquence. Avec la bonne preuve, un effacement se projette
       en CONFIRMED ; avec la mauvaise, il tombe en UNKNOWN — un oubli réussi
       serait annoncé comme incertain. */
    const bonne = projectStatus(
      [{ target: 'x', status: 'CONFIRMED', evidence: sortie.evidence ?? 'NONE', detail: '' }],
      'POSITIVE_ABSENCE',
    );
    expect(bonne).toBe('CONFIRMED');

    const mauvaise = projectStatus(
      [{ target: 'x', status: 'CONFIRMED', evidence: 'POSITIVE_PRESENCE', detail: '' }],
      'POSITIVE_ABSENCE',
    );
    expect(mauvaise).toBe('UNKNOWN');
  });
});

/* ====================================================================== *
 * 2. L'APERÇU — ce que l'humain lit avant de dire oui
 * ====================================================================== */

describe.runIf(enabled)('previewLast() — on ne confirme pas ce qu’on n’a pas vu', () => {
  let stack: Stack;
  let db: Db;
  let undo: UndoEngine;
  let snapshots: SnapshotStore;

  beforeAll(() => {
    db = appDb();
    stack = buildStack(db);
    snapshots = createSnapshotStore(db);
    undo = createUndoEngine({ snapshots, gateway: stack.gateway });
  });

  afterAll(async () => {
    await db.close();
  });

  async function creerUneNote(): Promise<string> {
    const op = operationId(`apercu-${suffixe()}`);
    const result = await stack.gateway.invoke({
      toolId: 'note_create',
      input: { content: `note-apercu-${suffixe()}` },
      parameterProvenance: { content: 'USER' },
      operationId: op,
      actor: 'USER',
      context: callContext({ userConfirmed: true }),
    });
    if (!result.ok) throw new Error(`note_create refusé : ${result.error.message}`);
    return op;
  }

  it('DÉSIGNE l’action qui serait défaite — pas « la dernière » en général', async () => {
    /* Demander « annuler la dernière action ? » sans dire LAQUELLE transforme
       la confirmation en formalité : l'utilisateur tape oui sur une phrase,
       pas sur un acte. */
    const op = await creerUneNote();

    const apercu = await undo.previewLast();
    expect(apercu.ok).toBe(true);
    if (!apercu.ok || apercu.value === null) throw new Error('aucun aperçu');

    expect(apercu.value.operationId).toBe(op);
    expect(apercu.value.resource.kind).toBe('note');
    expect(apercu.value.inverseToolId).toBe('note_delete');
    expect(apercu.value.empechement).toBeNull();
  });

  it('N’EXÉCUTE RIEN — c’est un aperçu, pas une annulation déguisée', async () => {
    /* La propriété la plus importante du fichier. Un aperçu qui agirait
       exécuterait un `L4` sans que personne n'ait rien confirmé — la
       confirmation arriverait APRÈS le fait. */
    const op = await creerUneNote();

    const avant = await snapshots.forOperation(op);
    expect(avant.ok && avant.value?.undoneAt).toBeNull();

    await undo.previewLast();
    await undo.previewLast();

    const apres = await snapshots.forOperation(op);
    expect(apres.ok && apres.value?.undoneAt).toBeNull();

    // Et la note existe toujours : rien n'a été défait.
    const reste = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM notes WHERE id = $1`,
      [apres.ok && apres.value !== null ? apres.value.resourceId : ''],
    );
    expect(reste.ok && reste.value.rows[0]?.n).toBe('1');
  });

  it('PORTE L’EMPÊCHEMENT quand la capture n’est pas rejouable', async () => {
    /* Un empêchement se dit AVANT la question. Demander un accord pour une
       action qu'on sait refusée fait perdre le temps de l'utilisateur — et une
       confirmation qu'on demande pour rien est une confirmation qu'on
       n'écoutera plus. */
    const op = `apercu-restore-${suffixe()}`;
    const capture = await snapshots.capture({
      operationId: op,
      resourceKind: 'task',
      resourceId: '00000000-0000-4000-8000-000000000000',
      undoKind: 'STATE_RESTORE',
      priorState: { state: 'OPEN' },
    });
    expect(capture.ok).toBe(true);

    const apercu = await undo.previewLast();
    expect(apercu.ok).toBe(true);
    if (!apercu.ok || apercu.value === null) throw new Error('aucun aperçu');

    expect(apercu.value.operationId).toBe(op);
    expect(apercu.value.undoKind).toBe('STATE_RESTORE');
    // Le motif est NOMMÉ, pas « impossible » : l'utilisateur qui lit
    // « impossible » réessaie ; celui qui lit ce qui manque, non.
    expect(apercu.value.empechement).toMatch(/restauration d'état non implémentée/i);
  });

  it('rend NULL — et pas une erreur — quand il n’y a rien à annuler', async () => {
    /* `lastUndoable` filtre déjà les captures annulées, expirées et
       NOT_UNDOABLE. Un aperçu vide est une réponse, pas une panne : le CLI doit
       pouvoir dire « rien à annuler » sans traiter un cas d'erreur. */
    const vide = createUndoEngine({
      snapshots: {
        ...snapshots,
        lastUndoable: () => Promise.resolve({ ok: true as const, value: null }),
      },
      gateway: stack.gateway,
    });

    const apercu = await vide.previewLast();
    expect(apercu.ok).toBe(true);
    if (!apercu.ok) return;
    expect(apercu.value).toBeNull();
  });
});

/* ====================================================================== *
 * 3. LA CAPTURE CONSOMMÉE — le troisième trou, et le plus coûteux
 * ====================================================================== */

describe.runIf(enabled)('quand une capture est-elle CONSOMMÉE ?', () => {
  /* ⚠ CE BLOC EXISTE PARCE QU'UN SABOTAGE EST RESTÉ VERT.
     En faisant rendre `true` à `hasAnyEffect`, les trente-sept tests
     d'annulation passaient. La garde qui empêche de BRÛLER une capture —
     la marquer annulée alors que l'action tient toujours — n'était donc
     protégée par rien, alors que tout le raisonnement « exécuter puis
     marquer » repose sur elle. */

  let stack: Stack;
  let db: Db;
  let snapshots: SnapshotStore;

  beforeAll(() => {
    db = appDb();
    stack = buildStack(db);
    snapshots = createSnapshotStore(db);
  });

  afterAll(async () => {
    await db.close();
  });

  it('une annulation qui ÉCHOUE ne brûle PAS la capture', async () => {
    /* LE CAS QUI COMPTE POUR LA SÛRETÉ. Si l'inverse échoue, l'action d'origine
       tient toujours — marquer la capture rendrait l'annulation définitivement
       impossible, et l'utilisateur croirait avoir défait ce qui existe encore.

       Une DOUBLURE de passerelle plutôt qu'un échec provoqué en base : on veut
       éprouver la décision du moteur, pas la façon d'obtenir un échec. */
    const op = `brulee-${suffixe()}`;
    const capture = await snapshots.capture({
      operationId: op,
      resourceKind: 'note',
      resourceId: '00000000-0000-4000-8000-000000000000',
      undoKind: 'INVERSE_OPERATION',
      inverseToolId: 'note_delete',
      inverseInput: { noteId: '00000000-0000-4000-8000-000000000000' },
    });
    expect(capture.ok).toBe(true);

    const menteuse = createUndoEngine({
      snapshots,
      gateway: {
        ...stack.gateway,
        invoke: () =>
          Promise.resolve({
            ok: true as const,
            value: {
              status: 'UNKNOWN' as const,
              output: {},
              verification: {
                status: 'UNKNOWN' as const,
                detail: 'la base n’a pas répondu',
                evidence: 'INCONCLUSIVE' as const,
              },
              policy: { decision: 'ALLOW' as const, effectiveAutonomy: 'L4' as const, reasons: [] },
              eventId: 'x',
              replayed: false,
              provenance: 'TOOL_OUTPUT' as const,
              suspectedInjection: false,
            },
          }),
      } as unknown as Stack['gateway'],
    });

    const tente = await menteuse.undoOperation(op, callContext({ userConfirmed: true }));
    expect(tente.ok).toBe(true);
    if (!tente.ok) return;
    expect(tente.value.status).toBe('UNKNOWN');
    expect(tente.value.detail).toContain('reste annulable');

    // LA CAPTURE N'EST PAS MARQUÉE : elle pourra être rejouée.
    const apres = await snapshots.forOperation(op);
    expect(apres.ok && apres.value?.undoneAt).toBeNull();
  });

  it('une annulation SANS OBJET consomme la capture — sinon `undoLast` boucle', async () => {
    /* LE SECOND DÉFAUT, TROUVÉ EN CHERCHANT LE PREMIER. `lastUndoable` rend la
       capture non annulée la plus récente. Une capture qu'on ne marque JAMAIS
       serait donc resservie à chaque « annule la dernière action » — la
       commande deviendrait inutilisable sans que rien ne signale pourquoi.

       Cas réel : la note a été supprimée par un autre chemin avant qu'on
       annule sa création. `note_delete` ne trouve rien : ce n'est pas un
       échec, c'est un sans-objet. */
    const undo = createUndoEngine({ snapshots, gateway: stack.gateway });

    const op = operationId(`sans-objet-${suffixe()}`);
    const cree = await stack.gateway.invoke({
      toolId: 'note_create',
      input: { content: `note-doublement-supprimee-${suffixe()}` },
      parameterProvenance: { content: 'USER' },
      operationId: op,
      actor: 'USER',
      context: callContext({ userConfirmed: true }),
    });
    expect(cree.ok).toBe(true);
    if (!cree.ok) return;
    const noteId = (cree.value.output as { noteId: string }).noteId;

    // Supprimée PAR UN AUTRE CHEMIN, hors annulation.
    const horsCircuit = await db.query('DELETE FROM notes WHERE id = $1', [noteId]);
    expect(horsCircuit.ok).toBe(true);

    const annule = await undo.undoOperation(op, callContext({ userConfirmed: true }));
    expect(annule.ok).toBe(true);
    if (!annule.ok) return;
    expect(annule.value.status).toBe('NOT_ATTEMPTED');

    // LA CAPTURE EST CONSOMMÉE : `undoLast` passera à la suivante.
    const apres = await snapshots.forOperation(op);
    expect(apres.ok && apres.value?.undoneAt).not.toBeNull();
  });
});

/* ====================================================================== *
 * 4. SUPPRIMER CHEZ AUTRUI NE SE PROUVE PAS — ADR-070
 * ====================================================================== */

describe('un succès-par-absence est bridé par la vérifiabilité', () => {
  /* ⚠ CE TROU EST NÉ D'ADR-065, ET JE NE L'AI PAS VU EN L'ÉCRIVANT.
     Il est apparu en préparant `calendar_delete` — le cinquième outil inverse,
     le seul dont l'effet sort de la machine.

     `constrainToVerifiability` bridait `FAILED` — l'absence d'EFFET — et
     laissait passer `CONFIRMED`. C'était juste tant que « succès » voulait dire
     « présence » : un outil OBSERVABLE peut prouver une présence, c'est sa
     définition. `erased()` a introduit un succès dont la preuve est une
     ABSENCE, et la fonction n'a pas été revisitée.

     Conséquence concrète : un `calendar_delete` OBSERVABLE aurait annoncé
     « supprimé, vérifié » sur un fournisseur incapable de prouver une absence. */

  /** Un outil minimal, dont on ne fait varier que la vérifiabilité. */
  function outil(verifiability: 'VERIFIABLE' | 'OBSERVABLE' | 'UNVERIFIABLE') {
    return {
      definition: { id: 'suppression_ailleurs', verifiability },
    } as unknown as Parameters<typeof brider>[0];
  }

  it('VERIFIABLE — l’effacement vérifié PASSE, c’est le cas de memory_forget', () => {
    const rendu = brider(
      outil('VERIFIABLE'),
      verificationOutcome.erased({
        observed: 'la ligne a disparu',
        conclusiveBecause: 'lecture transactionnelle après commit',
      }),
    );
    expect(rendu.status).toBe('CONFIRMED');
  });

  it('OBSERVABLE — l’effacement est DÉGRADÉ en UNKNOWN', () => {
    /* « Je ne vois plus rien » n'est pas « il n'y a plus rien ». La requête de
       suppression peut être en vol, ou le fournisseur traiter en file.

       CE N'EST PAS UN DÉFAUT À CORRIGER : supprimer sur une machine qu'on ne
       possède pas ne se prouve pas. Cela s'annonce, et le verdict honnête
       plafonne ici. */
    const rendu = brider(
      outil('OBSERVABLE'),
      verificationOutcome.erased({
        observed: "l'agenda ne rend plus l'événement",
        conclusiveBecause: 'le fournisseur a répondu 204',
      }),
    );
    expect(rendu.status).toBe('UNKNOWN');
    expect(rendu.unknownReason).toBe('EXTERNAL_STATE');
    expect(rendu.detail).toMatch(/ne peut pas prouver une absence/i);
  });

  it('CONTRÔLE NÉGATIF — un succès par PRÉSENCE n’est PAS dégradé', () => {
    /* Sans lui, une fonction qui dégraderait tout passerait le test précédent.
       Un outil OBSERVABLE qui observe une présence est exactement dans son
       domaine : `calendar_create` en dépend. */
    const rendu = brider(
      outil('OBSERVABLE'),
      verificationOutcome.confirmed({ observed: "l'événement est là" }),
    );
    expect(rendu.status).toBe('CONFIRMED');
  });
});
