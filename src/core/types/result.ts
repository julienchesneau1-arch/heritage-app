/**
 * Résultat typé.
 *
 * `06` impose : « les erreurs sont des valeurs typées, pas des exceptions
 * génériques ». Un chemin d'échec qui remonte par `throw` finit tôt ou tard
 * attrapé par un `catch` trop large, et une décision de sécurité s'y perd.
 */

export type Result<T, E = JarvisError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function isOk<T, E>(
  r: Result<T, E>,
): r is { readonly ok: true; readonly value: T } {
  return r.ok;
}

/** Familles d'erreurs du noyau. Chaque famille a un traitement distinct. */
export type ErrorKind =
  | 'VALIDATION' // une frontière a refusé une valeur
  | 'POLICY_DENIED' // le Policy Gate a refusé
  | 'CONFIRMATION_REQUIRED' // action préparée, en attente de l'utilisateur
  | 'NOT_FOUND'
  | 'CONFLICT' // idempotence : l'opération existe déjà
  /**
   * Une opération de MÊME CLÉ est déjà engagée par un autre appelant.
   *
   * Volontairement distinct de `CONFLICT`, qui signale un défaut d'appelant
   * (même clé, arguments différents). Ici il n'y a aucun défaut : deux appels
   * légitimes ont couru, un seul a pris l'engagement.
   *
   * Ce n'est PAS un échec de l'action. L'appelant qui reçoit ceci n'a rien
   * tenté, et ne sait rien de l'issue de celui qui a gagné.
   */
  | 'OPERATION_IN_FLIGHT'
  /**
   * L'exécutant a perdu son autorité pendant qu'il exécutait — ADR-035.
   *
   * Distinct d'`OPERATION_IN_FLIGHT` : ici l'appel EST parti, et il a peut-être
   * eu un effet. Un autre exécutant a simplement pris la relève entre-temps.
   *
   * L'appelant périmé ne peut plus écrire de résultat autoritaire, et ne doit
   * surtout pas en conclure un échec : son effet, lui, existe peut-être.
   */
  | 'STALE_EXECUTOR'
  /**
   * La confiance dans ce fournisseur est ROMPUE — `docs/22 §9`, invariant I12.
   *
   * Distinct de `PROVIDER_UNAVAILABLE` : celui-là ne répond pas, celui-ci a
   * répondu — et a fait autre chose que ce qu'il annonçait. Le premier peut
   * revenir tout seul ; le second exige une décision humaine.
   *
   * Rien n'a été tenté. C'est le point : on n'engage aucune action nouvelle
   * sur une information compromise.
   */
  | 'PROVIDER_TRUST_REVOKED'
  | 'PROVIDER_UNAVAILABLE'
  | 'TIMEOUT'
  | 'VERIFICATION_FAILED'
  | 'INTEGRITY' // le journal ou la mémoire est incohérent
  | 'CONFIGURATION'
  | 'INTERNAL';

export interface JarvisError {
  readonly kind: ErrorKind;
  readonly message: string;
  /** Contexte non sensible. Ne jamais y placer de secret ni de donnée RED. */
  readonly details?: Readonly<Record<string, string | number | boolean>>;
  readonly cause?: unknown;
}

export function jarvisError(
  kind: ErrorKind,
  message: string,
  details?: Readonly<Record<string, string | number | boolean>>,
  cause?: unknown,
): JarvisError {
  const base: JarvisError = { kind, message };
  return {
    ...base,
    ...(details === undefined ? {} : { details }),
    ...(cause === undefined ? {} : { cause }),
  };
}
