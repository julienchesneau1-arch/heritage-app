/**
 * `task_complete` — Phase 3, point 1 de `docs/02`.
 *
 * Premier outil du dépôt qui MODIFIE une ligne existante. Tout ce fichier
 * tourne autour de la conséquence :
 *
 *   > Créer se défait en supprimant. Modifier ne se défait qu'en restaurant
 *   > **ce qui était là**.
 *
 * Une suppression n'a besoin de rien savoir du passé. Une restauration n'est
 * correcte que si l'état antérieur a été LU — et lu au bon instant. C'est le
 * motif « l'observateur redéfinit le passé » (`docs/26 §3`) dans sa forme la
 * plus coûteuse : ici l'observation n'est pas un rapport, c'est la seule chose
 * qui rendra l'annulation possible.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appDb, databaseAvailable } from '../helpers/db.js';
import { buildStack, callContext, operationId, type Stack } from '../helpers/stack.js';
import { taskCompleteTool } from '../../src/tools/tasks.js';
import type { Db } from '../../src/core/db/client.js';

const enabled = databaseAvailable();

let compteur = 0;
const suffixe = (): string => `${String(Date.now())}-${String(++compteur)}`;

describe.runIf(enabled)('task_complete — Phase 3 point 1', () => {
  let stack: Stack;
  let db: Db;

  beforeAll(() => {
    db = appDb();
    stack = buildStack(db);
  });

  afterAll(async () => {
    await db.close();
  });

  /** Crée une tâche par la vraie chaîne et rend son identifiant. */
  async function créerTâche(titre: string): Promise<string> {
    const result = await stack.gateway.invoke({
      toolId: 'task_create',
      input: { title: titre },
      parameterProvenance: { title: 'USER' },
      operationId: operationId(`tc-create-${suffixe()}`),
      actor: 'USER',
      context: callContext({ userConfirmed: true }),
    });
    if (!result.ok) throw new Error(`création refusée : ${result.error.message}`);
    const output = result.value.output as { taskId: string };
    return output.taskId;
  }

  async function terminer(
    taskId: string,
  ): Promise<
    | { ok: true; op: string; output: Record<string, unknown>; status: string }
    | { ok: false; kind: string; message: string }
  > {
    const op = operationId(`tc-done-${suffixe()}`);
    const result = await stack.gateway.invoke({
      toolId: 'task_complete',
      input: { taskId },
      parameterProvenance: { taskId: 'USER' },
      operationId: op,
      actor: 'USER',
      context: callContext({ userConfirmed: true }),
    });
    if (!result.ok) {
      return { ok: false, kind: result.error.kind, message: result.error.message };
    }
    return {
      ok: true,
      op,
      output: result.value.output as Record<string, unknown>,
      status: result.value.status,
    };
  }

  async function étatEnBase(taskId: string): Promise<string | null> {
    const rows = await db.query<{ state: string }>(
      'SELECT state FROM tasks WHERE id = $1',
      [taskId],
    );
    if (!rows.ok) throw new Error(rows.error.message);
    return rows.value.rows[0]?.state ?? null;
  }

  /* ================================================================== *
   * Le cas nominal, et la preuve que `prior` lit bien l'AVANT
   * ================================================================== */

  it('termine une tâche ouverte, et le confirme par relecture', async () => {
    const id = await créerTâche(`tc-nominal-${suffixe()}`);
    const done = await terminer(id);

    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.status).toBe('CONFIRMED');
    expect(done.output['state']).toBe('DONE');
    expect(await étatEnBase(id)).toBe('DONE');
  }, 30_000);

  it("l'état antérieur rendu est celui d'AVANT l'écriture, pas celui d'après", async () => {
    /* LE TEST QUI DISCRIMINE.

       `UPDATE … FROM tasks AS prior` : si `prior` lisait la ligne APRÈS
       modification — ce qu'un lecteur pressé suppose — `priorState` vaudrait
       `DONE`, exactement comme `state`. Les deux valeurs seraient alors
       indiscernables et la capture d'annulation serait un enregistrement de
       l'état COURANT, c'est-à-dire rien.

       C'est aussi ce qui rend la mutation et la capture indivisibles : elles
       sont la même instruction, donc aucune fenêtre où l'état changerait
       entre les deux. */
    const id = await créerTâche(`tc-prior-${suffixe()}`);
    const done = await terminer(id);

    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.output['priorState']).toBe('OPEN');
    expect(done.output['state']).toBe('DONE');
    expect(done.output['priorState']).not.toBe(done.output['state']);
  }, 30_000);

  /* ================================================================== *
   * La capture d'annulation porte l'état OBSERVÉ, jamais un état supposé
   * ================================================================== */

  it("capture un STATE_RESTORE portant l'état observé (ADR-019, G2.6)", async () => {
    const id = await créerTâche(`tc-capture-${suffixe()}`);
    const done = await terminer(id);
    expect(done.ok).toBe(true);
    if (!done.ok) return;

    const snap = await stack.snapshots.forOperation(done.op);
    expect(snap.ok).toBe(true);
    if (!snap.ok || snap.value === null) throw new Error('aucune capture enregistrée');

    expect(snap.value.undoKind).toBe('STATE_RESTORE');
    expect(snap.value.resourceKind).toBe('task');
    expect(snap.value.resourceId).toBe(id);
    expect(snap.value.priorState).toEqual({ taskId: id, state: 'OPEN' });
  }, 30_000);

  it("terminer une tâche DÉJÀ terminée capture `DONE`, et surtout PAS `OPEN`", async () => {
    /* LE DÉFAUT QU'UNE CAPTURE EN DUR PRODUIRAIT.

       Un outil qui écrirait `priorState: 'OPEN'` — l'état « normal » avant une
       complétion — passerait tous les tests précédents. Ici il inventerait un
       passé : annuler rouvrirait une tâche que l'utilisateur avait terminée
       AVANT cet appel, et personne ne pourrait dire d'où vient la
       réouverture.

       C'est exactement « l'observateur redéfinit le passé », appliqué à
       l'annulation. */
    const id = await créerTâche(`tc-idem-${suffixe()}`);

    const premier = await terminer(id);
    expect(premier.ok).toBe(true);
    if (!premier.ok) return;
    expect(premier.output['changed']).toBe(true);

    const second = await terminer(id);
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.output['priorState']).toBe('DONE');
    expect(second.output['changed']).toBe(false);
    expect(await étatEnBase(id)).toBe('DONE');

    const snap = await stack.snapshots.forOperation(second.op);
    expect(snap.ok).toBe(true);
    if (!snap.ok || snap.value === null) throw new Error('aucune capture enregistrée');
    expect(snap.value.priorState).toEqual({ taskId: id, state: 'DONE' });
  }, 30_000);

  it("« c'était déjà fait » et « je viens de le faire » sont deux réponses", async () => {
    /* Le champ `changed` n'est pas décoratif : annoncer une action qui n'a rien
       changé est un succès non vérifié au sens de la règle 3 — l'effet
       rapporté n'est pas l'effet obtenu. */
    const id = await créerTâche(`tc-changed-${suffixe()}`);
    const a = await terminer(id);
    const b = await terminer(id);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.output['changed']).not.toBe(b.output['changed']);
  }, 30_000);

  /* ================================================================== *
   * Ce que l'outil REFUSE
   * ================================================================== */

  it('REFUSE de terminer une tâche annulée, et ne touche pas son état', async () => {
    /* Faire passer une tâche ANNULÉE à TERMINÉE effacerait une décision de
       l'utilisateur du seul état qu'il consulte. Le journal la garderait — mais
       personne ne lit le journal pour savoir où en est sa liste. */
    const id = await créerTâche(`tc-annulee-${suffixe()}`);
    const annulée = await db.query("UPDATE tasks SET state = 'CANCELLED' WHERE id = $1", [id]);
    expect(annulée.ok).toBe(true);

    const done = await terminer(id);
    expect(done.ok).toBe(false);
    if (done.ok) return;
    expect(done.kind).toBe('CONFLICT');
    // Et le refus est SANS EFFET : l'état n'a pas bougé d'un cran.
    expect(await étatEnBase(id)).toBe('CANCELLED');
  }, 30_000);

  it('REFUSE une tâche inexistante par NOT_FOUND, pas par un succès vide', async () => {
    const done = await terminer('00000000-0000-4000-8000-000000000000');
    expect(done.ok).toBe(false);
    if (done.ok) return;
    expect(done.kind).toBe('NOT_FOUND');
  }, 30_000);

  /* ================================================================== *
   * La relecture n'invente ni succès ni échec
   * ================================================================== */

  it("relit UNKNOWN — et non FAILED — si un autre écrivain a rouvert la tâche", async () => {
    /* L'`UPDATE` a rendu une ligne : l'écriture a EU LIEU. Observer ensuite
       autre chose que `DONE` ne prouve pas qu'elle a échoué — cela prouve qu'un
       autre écrivain est passé après le commit.

       Annoncer `FAILED` serait un échec inventé, et l'utilisateur agirait
       dessus : il relancerait une action déjà faite. La branche est éprouvée
       en appelant `readBack` directement, seule façon d'occuper la fenêtre
       entre le commit et la relecture. */
    const id = await créerTâche(`tc-course-${suffixe()}`);
    const done = await terminer(id);
    expect(done.ok).toBe(true);

    const rouverte = await db.query("UPDATE tasks SET state = 'OPEN' WHERE id = $1", [id]);
    expect(rouverte.ok).toBe(true);

    const tool = taskCompleteTool();
    expect(typeof tool.readBack).toBe('function');
    if (tool.readBack === undefined) return;

    const outcome = await tool.readBack(
      { output: {}, resource: { kind: 'task', id } },
      {
        db,
        operationId: operationId(`tc-readback-${suffixe()}`),
        actor: 'USER',
        secrets: new Map<string, string>(),
      },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.status).toBe('UNKNOWN');
    expect(outcome.value.unknownReason).toBe('EXTERNAL_STATE');
  }, 30_000);

  /* ================================================================== *
   * Le contrat déclaré — porte de sortie Phase 3
   * ================================================================== */

  it('déclare réversibilité, risque et méthode de vérification (porte Phase 3)', () => {
    const tool = stack.gateway.list().find((t) => t.definition.id === 'task_complete');
    expect(tool).toBeDefined();
    if (tool === undefined) return;

    const d = tool.definition;
    expect(d.reversible).toBe(true);
    // Réversible SANS procédure décrite serait une promesse creuse — le
    // validateur de contrat l'interdit, et c'est ici qu'on le constate.
    expect(d.rollback).not.toBeNull();
    expect(d.autonomy).toBe('L2');
    expect(d.verification).toBe('READ_BACK');
    expect(d.networkRequired).toBe(false);
    /* `OPERATION_KEY` et non `NATURALLY_IDEMPOTENT` — invariant S6, imposé par
       le validateur de contrat contre la première rédaction de cet outil.

       L'idempotence vaut ici pour l'ÉTAT, pas pour la CAPTURE : une seconde
       exécution enregistrerait `priorState: 'DONE'` par-dessus la première et
       rendrait l'action irréversible, sans que l'état bouge d'un cran. Une
       mutation n'est jamais « naturellement » idempotente tant qu'elle traîne
       un effet de bord qui, lui, ne l'est pas. */
    expect(d.idempotency).toBe('OPERATION_KEY');
    /* `NONE` est un choix, pas un défaut d'outillage : un rejeu capturerait
       `priorState: 'DONE'` et écraserait la capture de la première exécution.
       L'action deviendrait irréversible, silencieusement. */
    expect(d.attemptVerification).toBe('NONE');
  });
});
