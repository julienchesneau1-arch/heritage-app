/**
 * Capture d'état antérieur — fondation de l'Undo Engine.
 *
 * Référence : 09 §2.1, proposition n°6.
 *
 * Ce que ces tests protègent : une action exécutée sans capture est
 * définitivement non annulable. L'interface d'annulation peut attendre ; la
 * capture, non.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createSnapshotStore,
  type SnapshotStore,
} from '../../src/core/undo/snapshots.js';
import type { Db } from '../../src/core/db/client.js';
import { appDb, databaseAvailable } from '../helpers/db.js';

const skip = !databaseAvailable();

let counter = 0;
function operationId(): string {
  counter += 1;
  return `op-${String(Date.now())}-${String(counter)}`;
}

describe.skipIf(skip)('capture d\'état antérieur', () => {
  let db: Db;
  let snapshots: SnapshotStore;

  beforeAll(() => {
    db = appDb();
    snapshots = createSnapshotStore(db);
  });

  afterAll(async () => {
    await db.close();
  });

  /* --- INVERSE_OPERATION : création ------------------------------------- */

  it('une création capture l\'appel inverse, pas la donnée', async () => {
    const captured = await snapshots.capture({
      operationId: operationId(),
      resourceKind: 'task',
      resourceId: 'task-42',
      undoKind: 'INVERSE_OPERATION',
      inverseToolId: 'task_delete',
      inverseInput: { id: 'task-42' },
    });

    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    expect(captured.value.undoKind).toBe('INVERSE_OPERATION');
    expect(captured.value.inverseToolId).toBe('task_delete');
    // Le point de la mécanique : aucune donnée métier n'est copiée.
    expect(captured.value.priorState).toBeNull();
  });

  it('refuse une capture INVERSE_OPERATION incomplète', async () => {
    const captured = await snapshots.capture({
      operationId: operationId(),
      resourceKind: 'task',
      resourceId: 'task-43',
      undoKind: 'INVERSE_OPERATION',
      // inverseToolId et inverseInput manquants
    });
    expect(captured.ok).toBe(false);
    if (!captured.ok) expect(captured.error.kind).toBe('VALIDATION');
  });

  /* --- STATE_RESTORE : modification -------------------------------------- */

  it('une modification capture les valeurs antérieures', async () => {
    const captured = await snapshots.capture({
      operationId: operationId(),
      resourceKind: 'calendar_event',
      resourceId: 'evt-7',
      undoKind: 'STATE_RESTORE',
      priorState: { startsAt: '2026-08-13T14:00:00Z' },
      privacyClass: 'ORANGE',
    });

    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    expect(captured.value.undoKind).toBe('STATE_RESTORE');
    expect(captured.value.priorState).toEqual({
      startsAt: '2026-08-13T14:00:00Z',
    });
  });

  it('refuse une capture STATE_RESTORE sans état antérieur', async () => {
    const captured = await snapshots.capture({
      operationId: operationId(),
      resourceKind: 'calendar_event',
      resourceId: 'evt-8',
      undoKind: 'STATE_RESTORE',
    });
    expect(captured.ok).toBe(false);
    if (!captured.ok) expect(captured.error.kind).toBe('VALIDATION');
  });

  it('un état antérieur sensible porte sa propre classification', async () => {
    const captured = await snapshots.capture({
      operationId: operationId(),
      resourceKind: 'memory',
      resourceId: 'mem-9',
      undoKind: 'STATE_RESTORE',
      priorState: { content: 'donnée bancaire' },
      privacyClass: 'RED',
    });
    expect(captured.ok).toBe(true);
    if (captured.ok) expect(captured.value.privacyClass).toBe('RED');
  });

  /* --- NOT_UNDOABLE ------------------------------------------------------ */

  it('une action irréversible est enregistrée comme telle', async () => {
    const captured = await snapshots.capture({
      operationId: operationId(),
      resourceKind: 'email',
      resourceId: 'msg-1',
      undoKind: 'NOT_UNDOABLE',
    });
    expect(captured.ok).toBe(true);
    if (captured.ok) expect(captured.value.undoKind).toBe('NOT_UNDOABLE');
  });

  it('une action irréversible n\'est jamais proposée à l\'annulation', async () => {
    const last = await snapshots.lastUndoable();
    expect(last.ok).toBe(true);
    if (!last.ok || last.value === null) return;
    expect(last.value.undoKind).not.toBe('NOT_UNDOABLE');
  });

  /* --- Cycle d'annulation ------------------------------------------------ */

  it('retrouve le dernier instantané annulable', async () => {
    const op = operationId();
    const captured = await snapshots.capture({
      operationId: op,
      resourceKind: 'note',
      resourceId: 'note-1',
      undoKind: 'INVERSE_OPERATION',
      inverseToolId: 'note_delete',
      inverseInput: { id: 'note-1' },
    });
    expect(captured.ok).toBe(true);

    const last = await snapshots.lastUndoable();
    expect(last.ok).toBe(true);
    if (!last.ok || last.value === null) return;
    expect(last.value.operationId).toBe(op);
  });

  it('un instantané annulé sort de la file', async () => {
    const last = await snapshots.lastUndoable();
    expect(last.ok).toBe(true);
    if (!last.ok || last.value === null) return;

    const marked = await snapshots.markUndone(last.value.id, operationId());
    expect(marked.ok).toBe(true);

    const next = await snapshots.lastUndoable();
    if (next.ok && next.value !== null) {
      expect(next.value.id).not.toBe(last.value.id);
    }
  });

  it('on n\'annule pas deux fois la même action', async () => {
    const op = operationId();
    const captured = await snapshots.capture({
      operationId: op,
      resourceKind: 'note',
      resourceId: 'note-2',
      undoKind: 'INVERSE_OPERATION',
      inverseToolId: 'note_delete',
      inverseInput: { id: 'note-2' },
    });
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;

    expect((await snapshots.markUndone(captured.value.id, operationId())).ok).toBe(
      true,
    );
    const again = await snapshots.markUndone(captured.value.id, operationId());
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.kind).toBe('CONFLICT');
  });

  /* --- Expiration -------------------------------------------------------- */

  it('les instantanés échus sont purgés', async () => {
    const op = operationId();
    const captured = await snapshots.capture({
      operationId: op,
      resourceKind: 'note',
      resourceId: 'note-3',
      undoKind: 'STATE_RESTORE',
      priorState: { content: 'ancien' },
    });
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;

    // Un instantané n'est pas un archivage : sans expiration, la table
    // deviendrait une copie permanente et non gouvernée de la base.
    const aged = await db.query(
      "UPDATE action_snapshots SET expires_at = now() - interval '1 day' WHERE id = $1",
      [captured.value.id],
    );
    expect(aged.ok).toBe(true);

    const purged = await snapshots.purgeExpired();
    expect(purged.ok).toBe(true);
    if (purged.ok) expect(purged.value).toBeGreaterThan(0);

    const gone = await snapshots.forOperation(op);
    expect(gone.ok).toBe(true);
    if (gone.ok) expect(gone.value).toBeNull();
  });
});
