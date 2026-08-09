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
