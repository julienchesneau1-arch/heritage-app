/**
 * DOUBLE DE MOTEUR D'ANNULATION — ADR-105.
 *
 * `AssistantDeps.undo` est REQUIS et non nullable, pour la raison exacte
 * d'`arret` : un assemblage qui ne peut pas défaire n'est pas un assemblage
 * normal. Chaque banc doit donc en fournir un.
 *
 * ⚠ IL NE DÉFAIT RIEN PAR DÉFAUT, et c'est le bon défaut. `previewLast` rend
 * `null` — « rien à annuler » — de sorte qu'un banc qui n'a pas voulu parler
 * d'annulation n'en déclenche pas une par accident. Les tests qui veulent
 * éprouver le chemin fournissent explicitement leur aperçu.
 */
import { err, ok, jarvisError, type Result } from '../../src/core/types/result.js';
import type {
  UndoEngine,
  UndoOutcome,
  UndoPreview,
} from '../../src/core/undo/engine.js';

export interface UndoDouble extends UndoEngine {
  /** Les identifiants d'opération reçus par `undoOperation`, dans l'ordre. */
  readonly vises: readonly string[];
}

export function undoDouble(
  options: {
    apercu?: UndoPreview | null;
    resultat?: Result<UndoOutcome>;
  } = {},
): UndoDouble {
  const vises: string[] = [];
  const apercu = options.apercu ?? null;
  const resultat: Result<UndoOutcome> =
    options.resultat ??
    err(jarvisError('NOT_FOUND', 'aucune capture — double de test'));

  return {
    vises,
    previewLast: () => Promise.resolve(ok(apercu)),
    undoLast: () => Promise.resolve(resultat),
    undoOperation: (operationId: string) => {
      vises.push(operationId);
      return Promise.resolve(resultat);
    },
  };
}

/** Un aperçu qui décrit une note créée, défaisable. */
export function apercuDeNote(operationId = 'op-1'): UndoPreview {
  return {
    snapshotId: 'snap-1',
    operationId,
    resource: { kind: 'note', id: 'note-1' },
    inverseToolId: 'note_delete',
    undoKind: 'INVERSE_TOOL',
    empechement: null,
  };
}
