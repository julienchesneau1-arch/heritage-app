/**
 * Chargement de la configuration.
 *
 * Ordre : `config/default.json` puis `config/environments/<env>.json`, puis les
 * variables d'environnement pour les secrets et les surcharges d'infrastructure.
 * Toute valeur franchit Zod avant d'entrer dans le noyau — c'est une frontière.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  Environment,
  PublicConfig,
  SecretConfig,
  type Config,
} from './schema.js';
import { err, ok, jarvisError, type Result } from '../types/result.js';

const RawJson = z.record(z.string(), z.unknown());

function readJson(path: string): Result<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const checked = RawJson.safeParse(parsed);
    if (!checked.success) {
      return err(
        jarvisError('CONFIGURATION', `Configuration illisible : ${path}`),
      );
    }
    return ok(checked.data);
  } catch (cause) {
    return err(
      jarvisError(
        'CONFIGURATION',
        `Impossible de lire la configuration : ${path}`,
        undefined,
        cause,
      ),
    );
  }
}

/** Fusion superficielle par section — suffisant pour une config à deux niveaux. */
function merge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = out[key];
    if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      typeof existing === 'object' &&
      existing !== null &&
      !Array.isArray(existing)
    ) {
      out[key] = {
        ...(existing as Record<string, unknown>),
        ...(value as Record<string, unknown>),
      };
    } else {
      out[key] = value;
    }
  }
  return out;
}

export interface LoadOptions {
  readonly configDir?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export function loadConfig(options: LoadOptions = {}): Result<Config> {
  const env = options.env ?? process.env;
  const configDir = options.configDir ?? join(process.cwd(), 'config');

  const environment = Environment.safeParse(env['JARVIS_ENV'] ?? 'dev');
  if (!environment.success) {
    return err(
      jarvisError(
        'CONFIGURATION',
        'JARVIS_ENV doit valoir dev, test, lab ou production.',
      ),
    );
  }

  const defaults = readJson(join(configDir, 'default.json'));
  if (!defaults.ok) return defaults;

  const specific = readJson(
    join(configDir, 'environments', `${environment.data}.json`),
  );
  if (!specific.ok) return specific;

  const merged = merge(defaults.value, specific.value);
  merged['environment'] = environment.data;

  // Surcharges d'infrastructure : elles dépendent de la machine, pas du dépôt.
  const database = {
    ...((merged['database'] as Record<string, unknown> | undefined) ?? {}),
  };
  if (env['JARVIS_DB_HOST'] !== undefined) database['host'] = env['JARVIS_DB_HOST'];
  if (env['JARVIS_DB_PORT'] !== undefined)
    database['port'] = Number(env['JARVIS_DB_PORT']);
  if (env['JARVIS_DB_NAME'] !== undefined) database['name'] = env['JARVIS_DB_NAME'];
  if (env['JARVIS_DB_USER'] !== undefined) database['user'] = env['JARVIS_DB_USER'];
  merged['database'] = database;

  if (env['JARVIS_CLOUD_BUDGET_MONTHLY_EUR'] !== undefined) {
    merged['cloud'] = {
      ...((merged['cloud'] as Record<string, unknown> | undefined) ?? {}),
      budgetMonthlyEur: Number(env['JARVIS_CLOUD_BUDGET_MONTHLY_EUR']),
    };
  }

  const publicConfig = PublicConfig.safeParse(merged);
  if (!publicConfig.success) {
    return err(
      jarvisError('CONFIGURATION', 'Configuration publique invalide.', {
        issues: publicConfig.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join(' | '),
      }),
    );
  }

  const secretConfig = SecretConfig.safeParse({
    databasePassword: env['JARVIS_DB_PASSWORD'] ?? '',
  });
  if (!secretConfig.success) {
    return err(
      jarvisError(
        'CONFIGURATION',
        'Secret manquant : JARVIS_DB_PASSWORD. Voir .env.example.',
      ),
    );
  }

  return ok({ public: publicConfig.data, secret: secretConfig.data });
}
