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
}

export interface Db {
  query<T extends pg.QueryResultRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<Result<pg.QueryResult<T>>>;
  /** Transaction. Le callback reçoit un client dédié ; rollback automatique en cas d'échec. */
  transaction<T>(
    fn: (tx: TxClient) => Promise<Result<T>>,
  ): Promise<Result<T>>;
  close(): Promise<void>;
}

export interface TxClient {
  query<T extends pg.QueryResultRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<Result<pg.QueryResult<T>>>;
}

function toError(cause: unknown, context: string): ReturnType<typeof jarvisError> {
  const code =
    typeof cause === 'object' && cause !== null && 'code' in cause
      ? String((cause as { code: unknown }).code)
      : 'UNKNOWN';
  const message =
    cause instanceof Error ? cause.message : 'Erreur base de données';

  // 42501 = insufficient_privilege. C'est le code que produit le refus
  // d'UPDATE/DELETE sur le journal : ce n'est pas une panne, c'est la
  // protection qui fonctionne.
  const kind = code === '42501' ? 'POLICY_DENIED' : 'INTERNAL';
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

  return {
    async query<T extends pg.QueryResultRow>(
      text: string,
      params: readonly unknown[] = [],
    ): Promise<Result<pg.QueryResult<T>>> {
      try {
        return ok(await pool.query<T>(text, [...params]));
      } catch (cause) {
        return err(toError(cause, 'query'));
      }
    },

    async transaction<T>(
      fn: (tx: TxClient) => Promise<Result<T>>,
    ): Promise<Result<T>> {
      const client = await pool.connect();
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
