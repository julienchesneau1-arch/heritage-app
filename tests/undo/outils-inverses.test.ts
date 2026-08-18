/**
 * LES OUTILS INVERSES — quatre déclarés depuis le premier jour, écrits ici.
 * ADR-067.
 *
 * Chaque outil créateur annonçait son défaire dans une chaîne de caractères :
 *
 * ```
 * note_create      → « Supprimer la note via note_delete. »
 * task_create      → « Passer la tâche à CANCELLED via task_cancel. »
 * reminder_create  → « Passer le rappel à CANCELLED via reminder_cancel. »
 * ```
 *
 * Aucun n'existait. C'était donc **une promesse en prose que rien ne liait au
 * réel** — la famille de défaut que `docs/26 §2` recense sept fois.
 *
 * CE QUE CE FICHIER SURVEILLE EN PROPRE
 * ---------------------------------------------------------------------------
 * **Annuler n'est pas supprimer.** `note_delete` efface : la ligne part, et
 * l'outil est `L4` (`docs/03` : *suppression, irréversible*). `task_cancel` et
 * `reminder_cancel` font passer un état : la ligne survit, le contenu aussi, et
 * ils restent `L2`.
 *
 * Ce n'est pas un détail de classement. Le niveau d'autonomie est l'endroit où
 * la différence de gravité se paie — en confirmation humaine. Les tests
 * ci-dessous vérifient que les trois outils ne se ressemblent PAS là où ils ne
 * doivent pas se ressembler.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appDb, databaseAvailable } from '../helpers/db.js';
import { buildStack, callContext, operationId, type Stack } from '../helpers/stack.js';
import { createUndoEngine, type UndoEngine } from '../../src/core/undo/engine.js';
import { createSnapshotStore } from '../../src/core/undo/snapshots.js';
import type { Db } from '../../src/core/db/client.js';

const enabled = databaseAvailable();

let compteur = 0;
const suffixe = (): string => `${String(Date.now())}-${String(++compteur)}`;

describe.runIf(enabled)('les outils inverses — S12, quatre déclarés, écrits', () => {
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

  async function creer(
    toolId: string,
    input: Record<string, unknown>,
    provenance: Record<string, 'USER'>,
  ): Promise<{ op: string; output: Record<string, unknown> }> {
    const op = operationId(`inv-${toolId}-${suffixe()}`);
    const result = await stack.gateway.invoke({
      toolId,
      input,
      parameterProvenance: provenance,
      operationId: op,
      actor: 'USER',
      context: callContext({ userConfirmed: true }),
    });
    if (!result.ok) throw new Error(`${toolId} refusé : ${result.error.message}`);
    return { op, output: result.value.output as Record<string, unknown> };
  }

  /* ==================================================================== *
   * note_delete — SUPPRIMER : la ligne part
   * ==================================================================== */

  it('note_create s’annule — et la note DISPARAÎT', async () => {
    const { op, output } = await creer(
      'note_create',
      { content: `note-a-annuler-${suffixe()}` },
      { content: 'USER' },
    );
    const noteId = output['noteId'] as string;

    const annule = await undo.undoOperation(op, callContext({ userConfirmed: true }));
    expect(annule.ok).toBe(true);
    if (!annule.ok) return;
    expect(annule.value.toolId).toBe('note_delete');
    expect(annule.value.status).toBe('CONFIRMED');

    const reste = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM notes WHERE id = $1',
      [noteId],
    );
    expect(reste.ok && reste.value.rows[0]?.n).toBe('0');
  });

  it('supprimer une note INEXISTANTE n’est pas un succès', async () => {
    /* Même défaut que celui trouvé sur `memory_forget` par son contrôle
       négatif : une relecture vide est aussi vraie d'une note qui n'a jamais
       existé. Revendiquer un acte qui n'a pas eu lieu reste la faute. */
    const op = operationId(`note-fantome-${suffixe()}`);
    const result = await stack.gateway.invoke({
      toolId: 'note_delete',
      input: { noteId: '00000000-0000-4000-8000-000000000000' },
      parameterProvenance: { noteId: 'USER' },
      operationId: op,
      actor: 'USER',
      context: callContext({ userConfirmed: true }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).not.toBe('CONFIRMED');
  });

  /* ==================================================================== *
   * task_cancel / reminder_cancel — ANNULER : la ligne survit
   * ==================================================================== */

  it('task_create s’annule — et la tâche SURVIT, à l’état CANCELLED', async () => {
    /* LA DIFFÉRENCE AVEC LA NOTE, ÉPROUVÉE PLUTÔT QU'ÉCRITE. Si `task_cancel`
       supprimait la ligne, ce test rougirait — et l'utilisateur perdrait le
       titre de sa tâche en croyant seulement l'annuler. */
    const titre = `tache-a-annuler-${suffixe()}`;
    const { op, output } = await creer('task_create', { title: titre }, { title: 'USER' });
    const taskId = output['taskId'] as string;

    const annule = await undo.undoOperation(op, callContext({ userConfirmed: true }));
    expect(annule.ok).toBe(true);
    if (!annule.ok) return;
    expect(annule.value.toolId).toBe('task_cancel');
    expect(annule.value.status).toBe('CONFIRMED');

    const ligne = await db.query<{ state: string; title: string }>(
      'SELECT state, title FROM tasks WHERE id = $1',
      [taskId],
    );
    expect(ligne.ok).toBe(true);
    if (!ligne.ok) return;
    expect(ligne.value.rows[0]?.state).toBe('CANCELLED');
    // LE CONTENU EST INTACT — c'est ce qui distingue annuler de supprimer.
    expect(ligne.value.rows[0]?.title).toBe(titre);
  });

  it('reminder_create s’annule — et le rappel SURVIT, à l’état CANCELLED', async () => {
    const texte = `rappel-a-annuler-${suffixe()}`;
    const { op, output } = await creer(
      'reminder_create',
      { text: texte, remindAt: new Date(Date.now() + 3_600_000).toISOString() },
      { text: 'USER', remindAt: 'USER' },
    );
    const reminderId = output['reminderId'] as string;

    const annule = await undo.undoOperation(op, callContext({ userConfirmed: true }));
    expect(annule.ok).toBe(true);
    if (!annule.ok) return;
    expect(annule.value.toolId).toBe('reminder_cancel');

    const ligne = await db.query<{ state: string; text: string }>(
      'SELECT state, text FROM reminders WHERE id = $1',
      [reminderId],
    );
    expect(ligne.ok).toBe(true);
    if (!ligne.ok) return;
    expect(ligne.value.rows[0]?.state).toBe('CANCELLED');
    expect(ligne.value.rows[0]?.text).toBe(texte);
  });

  /* ==================================================================== *
   * LES REFUS SYMÉTRIQUES — on n'écrase pas une décision
   * ==================================================================== */

  it('annuler une tâche DÉJÀ TERMINÉE est refusé — miroir de task_complete', async () => {
    /* `task_complete` refuse une tâche `CANCELLED` parce que « la terminer
       effacerait cette décision ». La symétrie doit tenir dans l'autre sens,
       sinon l'ordre des gestes déciderait de ce qui survit. */
    const { output } = await creer(
      'task_create',
      { title: `tache-finie-${suffixe()}` },
      { title: 'USER' },
    );
    const taskId = output['taskId'] as string;

    const fini = await stack.gateway.invoke({
      toolId: 'task_complete',
      input: { taskId },
      parameterProvenance: { taskId: 'USER' },
      operationId: operationId(`fin-${suffixe()}`),
      actor: 'USER',
      context: callContext({ userConfirmed: true }),
    });
    expect(fini.ok).toBe(true);

    const annule = await stack.gateway.invoke({
      toolId: 'task_cancel',
      input: { taskId },
      parameterProvenance: { taskId: 'USER' },
      operationId: operationId(`ann-${suffixe()}`),
      actor: 'USER',
      context: callContext({ userConfirmed: true }),
    });
    expect(annule.ok).toBe(false);
    if (annule.ok) return;
    expect(annule.error.message).toMatch(/déjà terminée/i);

    // ET L'ÉTAT N'A PAS BOUGÉ : le refus n'est pas cosmétique.
    const etat = await db.query<{ state: string }>(
      'SELECT state FROM tasks WHERE id = $1',
      [taskId],
    );
    expect(etat.ok && etat.value.rows[0]?.state).toBe('DONE');
  });

  /* ==================================================================== *
   * LES NIVEAUX — là où la gravité se paie
   * ==================================================================== */

  it('SUPPRIMER est L4, ANNULER est L2 — et ce n’est pas une inadvertance', () => {
    const par = (id: string) =>
      stack.gateway.list().find((t) => t.definition.id === id)?.definition;

    // Supprimer : irréversible, donc confirmation forte (`docs/03`).
    expect(par('note_delete')?.autonomy).toBe('L4');
    expect(par('note_delete')?.reversible).toBe(false);
    expect(par('note_delete')?.rollback).toBeNull();

    // Annuler : la ligne survit, rien n'est perdu, donc pas de cérémonie.
    for (const id of ['task_cancel', 'reminder_cancel']) {
      expect(par(id)?.autonomy, id).toBe('L2');
      expect(par(id)?.reversible, id).toBe(true);
      // Et l'état antérieur est CAPTURÉ, même si rien ne sait encore le rejouer.
      expect(par(id)?.rollback, id).toMatch(/STATE_RESTORE/);
    }
  });

  it('les quatre outils inverses DÉCLARÉS existent tous', () => {
    /* LE TEST QUI FERME LA PROMESSE EN PROSE. Chaque `inverseToolId` capturé
       doit désigner un outil enregistré — sinon l'annulation échoue au moment
       où on en a besoin, c'est-à-dire au pire moment. */
    const enregistres = new Set(stack.gateway.list().map((t) => t.definition.id));
    for (const inverse of ['memory_forget', 'note_delete', 'task_cancel', 'reminder_cancel']) {
      expect(enregistres.has(inverse), inverse).toBe(true);
    }

    /* `calendar_delete` reste NON écrit, et il est nommé ici plutôt que passé
       sous silence : c'est le seul dont l'effet est EXTERNE, donc le seul dont
       la vérification ne peut pas s'appuyer sur PostgreSQL. Il mérite sa propre
       passe, pas d'être expédié avec les trois autres. */
    expect(enregistres.has('calendar_delete')).toBe(false);
  });

  it('CONTRÔLE NÉGATIF — une capture désignant un outil ABSENT est refusée', async () => {
    /* Sans lui, le test précédent ne prouverait rien du comportement : il faut
       que l'Undo Engine se comporte correctement le jour où un inverse manque,
       plutôt que d'échouer de façon obscure. */
    const snapshots = createSnapshotStore(db);
    const op = `capture-orpheline-${suffixe()}`;
    const capture = await snapshots.capture({
      operationId: op,
      resourceKind: 'inconnu',
      resourceId: '00000000-0000-4000-8000-000000000000',
      undoKind: 'INVERSE_OPERATION',
      inverseToolId: 'outil_qui_nexiste_pas',
      inverseInput: { x: 1 },
    });
    expect(capture.ok).toBe(true);

    const annule = await undo.undoOperation(op, callContext({ userConfirmed: true }));
    expect(annule.ok).toBe(false);
  });
});
