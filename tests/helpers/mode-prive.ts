/**
 * DOUBLE DE MODE PRIVÉ — ADR-106.
 *
 * `AssistantDeps.modePrive` est REQUIS et non nullable, pour la raison
 * d'`arret` et d'`undo` : un assemblage qui ne peut pas se taire n'est pas un
 * assemblage normal.
 *
 * ⚠ IL COMMENCE INACTIF, et c'est le bon défaut : un banc qui n'a pas voulu
 * parler de confidentialité ne doit pas se retrouver en mode privé par
 * accident, ce qui ferait refuser des égressions qu'il croit éprouver.
 */
import { ok, type Result } from '../../src/core/types/result.js';
import type { EtatModePrive, ModePrive } from '../../src/core/privacy/mode-prive.js';

export interface ModePriveDouble extends ModePrive {
  /** Les motifs reçus par `activer`, dans l'ordre. */
  readonly motifs: readonly string[];
}

export function modePriveDouble(depuis?: string): ModePriveDouble {
  const motifs: string[] = [];
  let etat: EtatModePrive = depuis === undefined
    ? { actif: false }
    : { actif: true, depuis, motif: 'double de test' };

  return {
    motifs,
    etat: (): Promise<Result<EtatModePrive>> => Promise.resolve(ok(etat)),
    activer: (motif: string): Promise<Result<EtatModePrive>> => {
      motifs.push(motif);
      // Idempotent, comme le vrai : une seconde activation rend l'existante.
      if (!etat.actif) {
        etat = { actif: true, depuis: new Date().toISOString(), motif };
      }
      return Promise.resolve(ok(etat));
    },
    lever: (): Promise<Result<void>> => {
      etat = { actif: false };
      return Promise.resolve(ok(undefined));
    },
  };
}
