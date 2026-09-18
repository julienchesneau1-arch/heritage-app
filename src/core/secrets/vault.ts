/**
 * COFFRE À SECRETS — invariant S3, `docs/03 §9`. Phase 0.
 *
 * > Un secret n'entre jamais dans un prompt, un log, la mémoire, un message
 * > d'erreur, ou le dépôt.
 *
 * ⚠ CE FICHIER A ÉTÉ RECONSTITUÉ — ADR-089.
 *
 * Il existait depuis la Phase 0 et fonctionnait. Il n'avait **jamais été
 * commité** : `.gitignore` portait le motif nu `secrets/`, écrit pour tenir un
 * dossier de secrets hors du dépôt, et qui — en git — exclut **tout dossier
 * nommé `secrets`, à n'importe quelle profondeur**. Dont celui-ci.
 *
 * Le dépôt poussé ne compilait donc pas, et personne ne l'a su tant que
 * personne n'a cloné à neuf. Reconstitué depuis `tests/security/secrets.test.ts`
 * et `tests/security/refus-eprouves.test.ts`, qui en portaient le contrat
 * complet — c'est la seule raison pour laquelle la reconstitution est fidèle
 * plutôt que approximative.
 *
 * LES TROIS CHEMINS PAR LESQUELS UN SECRET FUIT
 * ---------------------------------------------------------------------------
 * Une fuite ne vient presque jamais d'un `console.log(apiKey)` délibéré :
 *
 * ```text
 * toString()        `Bearer ${secret}` — la concaténation
 * toJSON()          JSON.stringify({ config }) — la sérialisation
 * [inspect.custom]  console.log(objet) — L'AFFICHAGE, le plus fréquent
 * ```
 *
 * Les deux premiers ont été gardés dès l'origine ; **le troisième ne l'était
 * pas**, et un sabotage l'a trouvé nu (`refus-eprouves.test.ts`). C'est
 * pourtant celui que Node appelle pour `console.log`.
 *
 * Les trois sont désormais éprouvés **ensemble**, dans une seule boucle : les
 * tenir séparément a précisément laissé passer celui qui manquait.
 */
import { inspect } from 'node:util';
import { err, jarvisError, ok, type Result } from '../types/result.js';

/** Ce qui s'affiche à la place d'une valeur, par tous les chemins. */
const REDACTED = '[REDACTED]';

/**
 * Une valeur secrète, enveloppée.
 *
 * ⚠ LA VALEUR EST DANS UN CHAMP PRIVÉ `#value`, PAS `private value`.
 *
 * `private` de TypeScript est une règle de compilation : à l'exécution le
 * champ est ordinaire, et `JSON.stringify` le sérialise. `#value` est privé au
 * sens du langage — invisible de `Object.keys`, de la sérialisation, et de
 * l'inspection.
 *
 * Ce détail a une histoire : le premier sabotage du coffre écrivait
 * `this.value` là où le champ s'appelle `#value`. Il rendait `undefined`, donc
 * ne prouvait rien. **Un sabotage qu'on ne vérifie pas est une conclusion
 * qu'on s'offre.**
 */
export class Secret {
  readonly #value: string;

  /**
   * Le NOM reste public, et c'est délibéré.
   *
   * Savoir QUEL secret on regarde est utile — pour un message d'erreur, pour
   * un audit, pour comprendre ce qu'un composant réclame. C'est la VALEUR qui
   * ne sort pas. Masquer le nom rendrait tout diagnostic impossible sans rien
   * protéger de plus.
   */
  readonly name: string;

  constructor(name: string, value: string) {
    this.name = name;
    this.#value = value;
  }

  /** Chemin 1 — la concaténation. `` `Bearer ${secret}` `` ne fuit rien. */
  toString(): string {
    return `Secret(${this.name})${REDACTED}`;
  }

  /** Chemin 2 — la sérialisation. `JSON.stringify` n'atteint pas `#value`. */
  toJSON(): string {
    return `Secret(${this.name})${REDACTED}`;
  }

  /**
   * Chemin 3 — L'AFFICHAGE, et celui qui manquait.
   *
   * Node appelle ce symbole pour `console.log`, pour `util.inspect`, et pour
   * tout objet qui CONTIENT le secret, à n'importe quelle profondeur. Sans
   * lui, `console.log({ config })` imprimait la valeur nue trois niveaux plus
   * bas — et rien ne l'aurait dit.
   */
  [inspect.custom](): string {
    return `Secret(${this.name})${REDACTED}`;
  }

  /**
   * LE SEUL CHEMIN QUI REND LA VALEUR, et il porte un nom explicite.
   *
   * `expose()` se voit dans une revue de code ; un accès de champ, non. Le
   * geste est volontairement impossible à faire par distraction.
   */
  expose(): string {
    return this.#value;
  }
}

/**
 * Le coffre.
 *
 * Deux opérations seulement. Pas de `list()` : énumérer les secrets détenus
 * est déjà une information, et aucun appelant légitime n'en a besoin — chacun
 * sait quel secret il réclame.
 */
export interface SecretVault {
  get(name: string): Result<Secret>;
  has(name: string): boolean;
}

/**
 * Implémentation de développement, adossée à l'environnement.
 *
 * En production, remplacer par le trousseau du système (Keychain sur macOS).
 * L'interface ne change pas — c'est tout l'intérêt d'ADR-003.
 *
 * ⚠ UNE VARIABLE VIDE EST TRAITÉE COMME ABSENTE. `JARVIS_GOOGLE_TOKEN=""` dans
 * un `.env` est le résultat le plus courant d'une configuration à moitié
 * faite. La rendre comme un secret valide ferait tenter l'appel réseau, échouer
 * à l'authentification, et rapporter un défaut de FOURNISSEUR là où il y a une
 * absence de SECRET (ADR-043).
 */
export function createEnvSecretVault(
  env: NodeJS.ProcessEnv = process.env,
): SecretVault {
  return {
    get(name: string): Result<Secret> {
      const value = env[name];
      if (value === undefined || value === '') {
        return err(
          jarvisError('CONFIGURATION', `Secret absent : ${name}`, {
            /* On journalise le NOM du secret, jamais sa valeur. Un message
               d'erreur finit dans un log, puis dans un rapport, puis dans un
               ticket : c'est un chemin de fuite comme un autre. */
            secretName: name,
          }),
        );
      }
      return ok(new Secret(name, value));
    },

    has(name: string): boolean {
      const value = env[name];
      return value !== undefined && value !== '';
    },
  };
}
