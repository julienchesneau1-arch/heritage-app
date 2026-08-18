/**
 * UNDO ENGINE — la boucle complète, enfin fermée. ADR-066.
 *
 * `snapshots.ts` s'ouvre sur : **« CE MODULE N'ANNULE RIEN. Il capture de quoi
 * annuler. »** Ce fichier éprouve l'autre moitié.
 *
 * L'invariant S12 — *le rollback reste possible* — était vrai au sens des
 * DONNÉES et faux au sens de l'ACTION (`docs/26 §4.10`) : on savait quoi
 * défaire, rien ne pouvait le faire. Cinq outils inverses déclarés, zéro écrit,
 * aucun moteur.
 *
 * `memory_forget` (ADR-065) a été le premier écrit. Il se trouve être l'inverse
 * déclaré de `memory_add` : la boucle est donc démontrable de bout en bout
 * **sans écrire un outil de plus**.
 *
 * ```
 * memory_add → capture INVERSE_OPERATION → undoLast → memory_forget → vérifié
 * ```
 *
 * CE QUE CE FICHIER SURVEILLE VRAIMENT
 * ---------------------------------------------------------------------------
 * Un moteur d'annulation est le meilleur endroit du dépôt pour cacher une porte
 * dérobée. Il connaît la ressource, il a la base sous la main, et « on sait ce
 * qu'on fait, c'est nous qui l'avons créé » est une phrase qui se défend. Les
 * tests ci-dessous vérifient donc surtout ce que le moteur **ne** fait **pas** :
 * il n'écrit pas, il ne confirme pas à la place de l'humain, et il ne défait
 * jamais deux fois.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appDb, databaseAvailable } from '../helpers/db.js';
import { buildStack, callContext, operationId, type Stack } from '../helpers/stack.js';
import { createUndoEngine, type UndoEngine } from '../../src/core/undo/engine.js';
import { createSnapshotStore } from '../../src/core/undo/snapshots.js';
import { forUndo } from '../../src/core/tools/identity.js';
import type { Db } from '../../src/core/db/client.js';

const enabled = databaseAvailable();

let compteur = 0;
const suffixe = (): string => `${String(Date.now())}-${String(++compteur)}`;

describe.runIf(enabled)('Undo Engine — S12, l’exécution du défaire', () => {
  let stack: Stack;
  let db: Db;
  let undo: UndoEngine;

  beforeAll(() => {
    db = appDb();
    stack = buildStack(db);
    undo = createUndoEngine({
      snapshots: createSnapshotStore(db),
      gateway: stack.gateway,
    });
  });

  afterAll(async () => {
    await db.close();
  });

  /** Mémorise par la vraie chaîne et rend l'identité de l'opération. */
  async function memoriser(contenu: string): Promise<{ op: string; memoryId: string }> {
    const op = operationId(`undo-add-${suffixe()}`);
    const result = await stack.gateway.invoke({
      toolId: 'memory_add',
      input: {
        content: contenu,
        memoryType: 'SEMANTIC',
        sourceType: 'USER_EXPLICIT',
      },
      parameterProvenance: { content: 'USER', memoryType: 'USER', sourceType: 'USER' },
      operationId: op,
      actor: 'USER',
      context: callContext({ userConfirmed: true }),
    });
    if (!result.ok) throw new Error(`mémorisation refusée : ${result.error.message}`);
    const out = result.value.output as { memoryId: string };
    return { op, memoryId: out.memoryId };
  }

  async function existe(memoryId: string): Promise<boolean> {
    const rows = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM memories WHERE id = $1',
      [memoryId],
    );
    return rows.ok && rows.value.rows[0]?.n !== '0';
  }

  /* ==================================================================== *
   * LA BOUCLE COMPLÈTE
   * ==================================================================== */

  it('09/§2.1 — « annule la dernière action » DÉFAIT réellement l’action', async () => {
    /* LE TEST QUI FERME S12. Jusqu'ici le dépôt savait capturer et savait
       oublier ; personne ne reliait les deux. */
    const { op, memoryId } = await memoriser(`a-annuler-${suffixe()}`);
    expect(await existe(memoryId)).toBe(true);

    const annule = await undo.undoOperation(op, callContext({ userConfirmed: true }));
    expect(annule.ok).toBe(true);
    if (!annule.ok) return;

    expect(annule.value.toolId).toBe('memory_forget');
    expect(annule.value.status).toBe('CONFIRMED');
    expect(annule.value.undoneOperationId).toBe(op);

    // ET L'EFFET EST RÉEL — un moteur qui rendrait CONFIRMED sans rien défaire
    // passerait tout ce qui précède.
    expect(await existe(memoryId)).toBe(false);
  });

  it('la capture est marquée annulée, et porte l’identité de l’annulation', async () => {
    const { op } = await memoriser(`trace-${suffixe()}`);
    const annule = await undo.undoOperation(op, callContext({ userConfirmed: true }));
    expect(annule.ok).toBe(true);

    const capture = await db.query<{ undone_at: Date | null; undo_operation_id: string | null }>(
      'SELECT undone_at, undo_operation_id FROM action_snapshots WHERE operation_id = $1',
      [op],
    );
    expect(capture.ok).toBe(true);
    if (!capture.ok) return;
    const ligne = capture.value.rows[0];
    expect(ligne?.undone_at).not.toBeNull();
    // La clé est DÉRIVÉE, donc reconstructible — c'est ce qui ferme le double
    // défaire au niveau du journal d'intention plutôt que dans le moteur.
    expect(ligne?.undo_operation_id).toContain('undo-');
  });

  /* ==================================================================== *
   * CE QUE LE MOTEUR NE FAIT PAS
   * ==================================================================== */

  it('ANNULER PEUT COÛTER PLUS CHER QUE FAIRE — sans confirmation, refus', async () => {
    /* `memory_add` est L2 ; son inverse `memory_forget` est L4. Annuler une
       action de niveau 2 exige donc une confirmation de niveau 4.

       C'est LA propriété qui distingue un moteur d'annulation d'une porte
       dérobée : il passe par le Policy Gate comme tout le monde. */
    const { op, memoryId } = await memoriser(`sans-accord-${suffixe()}`);

    const annule = await undo.undoOperation(op, callContext({ userConfirmed: false }));
    expect(annule.ok).toBe(false);

    // ET RIEN N'A ÉTÉ DÉFAIT : le refus n'est pas cosmétique.
    expect(await existe(memoryId)).toBe(true);
  });

  it('ANNULER DEUX FOIS ne défait qu’une fois', async () => {
    /* La seconde demande doit être refusée AVANT toute exécution — la capture
       porte `undone_at`. Et même si ce contrôle sautait, la clé déterministe
       ferait retomber le second appel sur le refus de rejeu du Gateway. Deux
       barrières, pas une. */
    const { op } = await memoriser(`deux-fois-${suffixe()}`);

    const premiere = await undo.undoOperation(op, callContext({ userConfirmed: true }));
    expect(premiere.ok).toBe(true);

    const seconde = await undo.undoOperation(op, callContext({ userConfirmed: true }));
    expect(seconde.ok).toBe(false);
    if (seconde.ok || !premiere.ok) return;
    expect(seconde.error.message).toMatch(/déjà annulée/i);

    /* ⚠ CETTE ASSERTION A ÉTÉ AJOUTÉE APRÈS SABOTAGE, ET C'EST LA SEULE QUI
       PORTE SUR LA PROPRIÉTÉ. Les lignes au-dessus n'éprouvent que la
       formulation de la PREMIÈRE barrière.

       Mesuré : en retirant la garde `undoneAt`, le second défaire ne double
       toujours pas — la clé déterministe le fait retomber sur le refus de rejeu
       du Gateway. Mais le message devient obscur, et le test ci-dessus
       rougissait pour cette raison-là, pas parce qu'un effet avait doublé.

       Un test qui rougit pour la mauvaise raison surveille la mauvaise chose. */
    const effets = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM tool_operations
        WHERE operation_id = $1 AND tool_id = 'memory_forget'`,
      [premiere.value.undoOperationId],
    );
    expect(effets.ok && effets.value.rows[0]?.n).toBe('1');
  });

  it('une action NOT_UNDOABLE est refusée en NOMMANT la raison', async () => {
    /* `memory_forget` capture `NOT_UNDOABLE` : un oubli qu'on peut défaire n'est
       pas un oubli (ADR-065). Le refus doit dire « par conception », pas
       « impossible » — l'utilisateur qui lit « impossible » réessaie. */
    const { op, memoryId } = await memoriser(`irreversible-${suffixe()}`);
    const annule = await undo.undoOperation(op, callContext({ userConfirmed: true }));
    expect(annule.ok).toBe(true);
    if (!annule.ok) return;

    // L'annulation de l'annulation : la capture de `memory_forget` elle-même.
    const rendre = await undo.undoOperation(
      annule.value.undoOperationId,
      callContext({ userConfirmed: true }),
    );
    expect(rendre.ok).toBe(false);
    if (rendre.ok) return;
    expect(rendre.error.message).toMatch(/irréversible PAR CONCEPTION/i);

    // La mémoire reste effacée — on ne ressuscite pas ce qu'on a oublié.
    expect(await existe(memoryId)).toBe(false);
  });

  it('une capture STATE_RESTORE est refusée en nommant CE QUI MANQUE', async () => {
    /* `task_complete` capture les valeurs antérieures. Les réappliquer exigerait
       un outil de restauration par type de ressource ; aucun n'est écrit.

       Le moteur pourrait « restaurer directement, puisqu'on a les données ».
       Ce serait un second chemin d'écriture hors politique et hors journal. Il
       refuse, et dit quoi. */
    const op = operationId(`undo-task-${suffixe()}`);
    const cree = await stack.gateway.invoke({
      toolId: 'task_create',
      input: { title: `tache-a-restaurer-${suffixe()}` },
      parameterProvenance: { title: 'USER' },
      operationId: op,
      actor: 'USER',
      context: callContext({ userConfirmed: true }),
    });
    expect(cree.ok).toBe(true);
    if (!cree.ok) return;
    const taskId = (cree.value.output as { taskId: string }).taskId;

    const opDone = operationId(`undo-done-${suffixe()}`);
    const fini = await stack.gateway.invoke({
      toolId: 'task_complete',
      input: { taskId },
      parameterProvenance: { taskId: 'USER' },
      operationId: opDone,
      actor: 'USER',
      context: callContext({ userConfirmed: true }),
    });
    expect(fini.ok).toBe(true);

    const annule = await undo.undoOperation(opDone, callContext({ userConfirmed: true }));
    expect(annule.ok).toBe(false);
    if (annule.ok) return;
    expect(annule.error.message).toMatch(/restauration d'état non implémentée/i);
  });

  it('une opération SANS capture est refusée — et le dit', async () => {
    /* Aucune capture est une information, pas un blanc : soit l'opération n'a
       jamais existé, soit elle a été exécutée sans capture, et le second cas
       est un défaut qu'il vaut mieux nommer. */
    const annule = await undo.undoOperation(
      'operation-qui-n-existe-pas',
      callContext({ userConfirmed: true }),
    );
    expect(annule.ok).toBe(false);
    if (annule.ok) return;
    expect(annule.error.message).toMatch(/jamais existé|sans capture/i);
  });

  /* ==================================================================== *
   * CONTRÔLES NÉGATIFS
   * ==================================================================== */

  it('CONTRÔLE NÉGATIF — la clé d’annulation est DÉTERMINISTE', () => {
    /* Sans elle, deux demandes concurrentes frapperaient deux clés et
       s'exécuteraient toutes les deux : le journal d'intention ne pourrait pas
       les rapprocher. C'est la ligne du fichier qui empêche le double effet. */
    expect(forUndo('abc')).toBe(forUndo('abc'));
    expect(forUndo('abc')).not.toBe(forUndo('def'));
  });

  it('CONTRÔLE NÉGATIF — le moteur n’écrit RIEN par lui-même', async () => {
    /* Un moteur qui supprimerait en direct passerait tous les tests d'effet
       ci-dessus. Ce qui l'en distingue est la TRACE : l'annulation doit
       apparaître au journal comme une exécution d'outil à part entière. */
    const { op } = await memoriser(`trace-journal-${suffixe()}`);
    const annule = await undo.undoOperation(op, callContext({ userConfirmed: true }));
    expect(annule.ok).toBe(true);
    if (!annule.ok) return;

    const trace = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM tool_operations
        WHERE operation_id = $1 AND tool_id = 'memory_forget'`,
      [annule.value.undoOperationId],
    );
    expect(trace.ok && trace.value.rows[0]?.n).toBe('1');
  });
});
