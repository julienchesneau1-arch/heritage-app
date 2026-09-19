/**
 * LE CONTRÔLE D'ARRÊT — ce qui relie la phrase, le mécanisme et le journal.
 *
 * ADR-104. `halt.ts` porte le mécanisme et pose une obligation à son appelant :
 *
 *   > *« `engage()` est une primitive du noyau, appelable directement. Elle
 *   >  n'échappe pas au journal pour autant : **l'appelant l'y inscrit**. »*
 *
 * Tant qu'`engage()` n'avait aucun appelant, cette obligation n'était portée
 * par personne. Ce module est l'appelant, et il la remplit **à un seul
 * endroit** : deux surfaces qui journaliseraient chacune de leur côté
 * finiraient par écrire deux formats, puis l'une des deux oublierait
 * (ADR-041).
 *
 * ⚠ CE QUE CE MODULE N'AJOUTE PAS, ET QU'IL SERAIT TENTANT D'AJOUTER
 * ---------------------------------------------------------------------------
 * Aucune politique, aucune vérification de surface, aucune confirmation sur
 * l'engagement. La dissymétrie d'`halt.ts` est reprise telle quelle :
 *
 * ```text
 * ENGAGER  sens sûr       → aucune contrainte ajoutée ici
 * LEVER    sens dangereux → `USER` exigé par halt.ts, et ce module ne
 *                           contourne pas cette exigence
 * ```
 *
 * ⚠ ET LE JOURNAL N'EST PAS UNE CONDITION DE L'ARRÊT. Si l'écriture au journal
 * échoue, **l'arrêt reste engagé** et l'échec est dit. L'inverse — refuser
 * d'arrêter parce qu'on n'a pas pu l'écrire — ferait dépendre le contrôle de
 * dernier recours de la santé d'une table.
 */
import type { Ledger } from '../ledger/ledger.js';
import { digestPayload } from '../ledger/event.js';
import type { EmergencyHalt, HaltState } from './halt.js';
import { ok, type Result } from '../types/result.js';

/**
 * Ce que l'utilisateur apprend après avoir dit « stop ».
 *
 * `enVol` est rendu séparément parce que c'est **la seule chose que l'arrêt ne
 * peut pas défaire** (`docs/26 §5`), et donc la seule qu'il faut dire.
 */
export interface CompteRenduDArret {
  readonly annulees: number;
  readonly enVol: number;
  /** Vrai si l'écriture au journal a échoué — l'arrêt, lui, tient. */
  readonly journalMuet: boolean;
}

export interface ControleDArret {
  etat(): Promise<Result<HaltState>>;
  engager(motif: string): Promise<Result<CompteRenduDArret>>;
  lever(note: string): Promise<Result<void>>;
}

export function createControleDArret(
  halt: EmergencyHalt,
  journal: Ledger,
): ControleDArret {
  return {
    etat: () => halt.state(),

    async engager(motif: string): Promise<Result<CompteRenduDArret>> {
      const engage = await halt.engage('USER', motif);
      if (!engage.ok) return engage;

      const journalMuet = !(await inscrire(journal, 'EMERGENCY_HALT_ENGAGED', {
        motif,
        ...engage.value,
      }));

      return ok({
        annulees: engage.value.cancelledPending,
        enVol: engage.value.inFlightUntouched,
        journalMuet,
      });
    },

    async lever(note: string): Promise<Result<void>> {
      /* `'USER'` EST ÉCRIT EN DUR, ET C'EST VOLONTAIRE.

         `halt.release` refuse tout acteur qui n'est pas `USER`. Exposer
         l'acteur en paramètre ici rendrait possible — par un appelant
         distrait, ou par un module qui se croit utilisateur — de tenter la
         levée au nom d'autre chose. Ce module n'a qu'un appelant légitime :
         un humain devant sa machine. */
      const leve = await halt.release('USER', note);
      if (!leve.ok) return leve;
      await inscrire(journal, 'EMERGENCY_HALT_RELEASED', { note });
      return ok(undefined);
    },
  };
}

/** Rend `true` si l'événement est scellé. N'échoue jamais bruyamment. */
async function inscrire(
  journal: Ledger,
  eventType: string,
  charge: Readonly<Record<string, unknown>>,
): Promise<boolean> {
  const ecrit = await journal.append({
    actor: 'USER',
    eventType,
    /* `CONFIRMED` : l'arrêt est ÉTABLI, pas espéré — la ligne existe en base
       et le Tool Gateway la lira au prochain appel. C'est une vérification par
       l'état, du même ordre que celle d'`halt.ts` sur les opérations
       `PLANNED`. */
    status: 'CONFIRMED',
    payloadDigest: digestPayload(charge),
  });
  return ecrit.ok;
}
