/**
 * Accès PostgreSQL.
 *
 * Le noyau applicatif se connecte toujours avec le rôle applicatif, qui ne
 * possède PAS les droits UPDATE/DELETE sur le journal (ADR-012). Les migrations
 * utilisent un rôle distinct, le bootstrap un troisième. C'est le principe du
 * moindre privilège appliqué à notre propre code.
 */
import pg from 'pg';
import { err, ok, jarvisError, type Result } from '../types/result.js';

export interface DbCredentials {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
  readonly poolMax?: number;
  readonly statementTimeoutMs?: number;
  /**
   * Notifié à chaque changement d'état de santé.
   *
   * Le noyau ne journalise pas lui-même : c'est l'application qui décide quoi
   * en faire — l'écrire dans l'Event Ledger, l'afficher, ou les deux.
   */
  readonly onHealthChange?: (health: DbHealth) => void;
}

/**
 * Santé de la connexion.
 *
 * Un assistant censé tourner en permanence rencontrera des redémarrages de
 * base : mise à jour système, bascule, mise en veille. L'état est donc une
 * propriété observable du système, pas un accident.
 */
export type DbHealth =
  | { readonly state: 'UP'; readonly since: string }
  | {
      readonly state: 'DOWN';
      readonly since: string;
      /** Message non sensible expliquant la panne. */
      readonly reason: string;
    };

export interface Db {
  query<T extends pg.QueryResultRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<Result<pg.QueryResult<T>>>;
  /** Transaction. Le callback reçoit un client dédié ; rollback automatique en cas d'échec. */
  transaction<T>(
    fn: (tx: TxClient) => Promise<Result<T>>,
  ): Promise<Result<T>>;
  /** État courant. Consulté par le Tool Gateway avant toute mutation. */
  health(): DbHealth;
  close(): Promise<void>;
}

export interface TxClient {
  query<T extends pg.QueryResultRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<Result<pg.QueryResult<T>>>;
}

function errorCode(cause: unknown): string {
  if (typeof cause !== 'object' || cause === null || !('code' in cause)) {
    return 'UNKNOWN';
  }
  const { code }: { code: unknown } = cause;
  return typeof code === 'string' ? code : 'UNKNOWN';
}

/**
 * Codes qui signalent que la CONNEXION est perdue, pas que la requête est
 * fautive.
 *
 * La distinction est ce qui permet de dire « la base est tombée » plutôt que
 * « ta demande a échoué » — deux messages très différents pour l'utilisateur,
 * et deux conduites très différentes pour le système.
 */
const CONNECTION_LOST = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENOTFOUND',
  '57P01', // admin_shutdown — `pg_ctl stop`, redémarrage de service
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now — la base démarre encore
  '08000',
  '08003',
  '08006',
  '08001',
  '08004',
]);

function isConnectionLost(cause: unknown): boolean {
  if (CONNECTION_LOST.has(errorCode(cause))) return true;
  // `pg` remonte parfois la perte de connexion sans code, par message seul.
  const message = cause instanceof Error ? cause.message : '';
  return /Connection terminated|connection is closed|server closed the connection|Client has encountered a connection error/i.test(
    message,
  );
}

function toError(cause: unknown, context: string): ReturnType<typeof jarvisError> {
  const code = errorCode(cause);
  const message =
    cause instanceof Error ? cause.message : 'Erreur base de données';

  // 42501 = insufficient_privilege. C'est le code que produit le refus
  // d'UPDATE/DELETE sur le journal : ce n'est pas une panne, c'est la
  // protection qui fonctionne.
  if (code === '42501') {
    return jarvisError('POLICY_DENIED', `${context}: ${message}`, { pgCode: code }, cause);
  }
  const kind = isConnectionLost(cause) ? 'PROVIDER_UNAVAILABLE' : 'INTERNAL';
  return jarvisError(kind, `${context}: ${message}`, { pgCode: code }, cause);
}

export function createDb(credentials: DbCredentials): Db {
  const pool = new pg.Pool({
    host: credentials.host,
    port: credentials.port,
    database: credentials.database,
    user: credentials.user,
    password: credentials.password,
    max: credentials.poolMax ?? 10,
    statement_timeout: credentials.statementTimeoutMs ?? 15_000,
  });

  let health: DbHealth = { state: 'UP', since: new Date().toISOString() };

  function transition(next: DbHealth): void {
    if (next.state === health.state) return;
    health = next;
    credentials.onHealthChange?.(next);
  }

  function markDown(reason: string): void {
    transition({ state: 'DOWN', since: new Date().toISOString(), reason });
  }

  function markUp(): void {
    transition({ state: 'UP', since: new Date().toISOString() });
  }

  /**
   * LE POINT QUI TUAIT LE PROCESSUS (CRIT-1).
   *
   * `pg.Pool` émet `'error'` quand un client INACTIF meurt — redémarrage de
   * PostgreSQL, bascule, mise en veille de la machine. En Node, un événement
   * `error` sans écouteur est relancé en exception non capturée : le processus
   * s'arrête, quoi qu'il fût en train de faire.
   *
   * L'écouteur ne « répare » rien : le pool sait recréer une connexion au
   * prochain appel. Il empêche seulement une panne banale de devenir fatale,
   * et transforme l'incident en ÉTAT observable — ce qui permet ensuite de
   * refuser proprement les actions plutôt que de les tenter dans le vide.
   */
  pool.on('error', (cause: Error) => {
    markDown(toError(cause, 'connexion inactive').message);
  });

  /** Met à jour la santé au vu du résultat d'une opération réelle. */
  function observe(cause: unknown): void {
    if (isConnectionLost(cause)) markDown(toError(cause, 'base').message);
  }

  return {
    async query<T extends pg.QueryResultRow>(
      text: string,
      params: readonly unknown[] = [],
    ): Promise<Result<pg.QueryResult<T>>> {
      try {
        const result = ok(await pool.query<T>(text, [...params]));
        markUp(); // une requête réussie EST la preuve du retour à la normale
        return result;
      } catch (cause) {
        observe(cause);
        return err(toError(cause, 'query'));
      }
    },

    health(): DbHealth {
      return health;
    },

    async transaction<T>(
      fn: (tx: TxClient) => Promise<Result<T>>,
    ): Promise<Result<T>> {
      // `pool.connect()` était HORS du `try` (HIGH-3) : sur une base
      // injoignable, il rejetait, et la promesse du Gateway rejetait avec lui.
      // Toute mutation passe par ici — c'était le chemin d'échec le plus
      // fréquent, et le seul qui ne rendait pas une valeur typée.
      let client: pg.PoolClient;
      try {
        client = await pool.connect();
      } catch (cause) {
        observe(cause);
        return err(toError(cause, 'connexion'));
      }
      try {
        await client.query('BEGIN');
        const tx: TxClient = {
          async query<R extends pg.QueryResultRow>(
            text: string,
            params: readonly unknown[] = [],
          ): Promise<Result<pg.QueryResult<R>>> {
            try {
              return ok(await client.query<R>(text, [...params]));
            } catch (cause) {
              return err(toError(cause, 'tx.query'));
            }
          },
        };
        const result = await fn(tx);
        if (result.ok) {
          await client.query('COMMIT');
          markUp();
        } else {
          await client.query('ROLLBACK');
        }
        return result;
      } catch (cause) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Le rollback a échoué : la connexion est probablement morte.
          // On laisse remonter l'erreur d'origine, plus informative.
        }
        observe(cause);
        return err(toError(cause, 'transaction'));
      } finally {
        client.release();
      }
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}
