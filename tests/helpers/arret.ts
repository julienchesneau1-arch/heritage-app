/**
 * DOUBLE D'ARRÊT D'URGENCE — ADR-104.
 *
 * `AssistantDeps.arret` est REQUIS et non nullable : un assemblage qu'on ne
 * peut pas arrêter n'est pas un assemblage normal. Chaque banc doit donc en
 * fournir un, et le compilateur l'a rappelé à onze endroits le jour où le
 * champ est apparu.
 *
 * ⚠ CE DOUBLE COMPTE SES APPELS PLUTÔT QUE DE LES OUBLIER. Un double muet
 * rendrait vert un Assistant qui n'arrête rien du tout ; celui-ci permet
 * d'affirmer que la phrase a bien atteint le mécanisme.
 */
import { ok, type Result } from '../../src/core/types/result.js';
import type { CompteRenduDArret, ControleDArret } from '../../src/core/safety/controle.js';
import type { HaltState } from '../../src/core/safety/halt.js';

export interface ArretDouble extends ControleDArret {
  /** Les motifs reçus par `engager`, dans l'ordre. */
  readonly motifs: readonly string[];
}

export function arretDouble(
  compteRendu: Partial<CompteRenduDArret> = {},
): ArretDouble {
  const motifs: string[] = [];
  return {
    motifs,
    etat: (): Promise<Result<HaltState>> => Promise.resolve(ok({ halted: false })),
    engager: (motif: string): Promise<Result<CompteRenduDArret>> => {
      motifs.push(motif);
      return Promise.resolve(
        ok({ annulees: 0, enVol: 0, journalMuet: false, ...compteRendu }),
      );
    },
    lever: (): Promise<Result<void>> => Promise.resolve(ok(undefined)),
  };
}
