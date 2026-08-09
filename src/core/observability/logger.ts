/**
 * Journalisation applicative.
 *
 * Référence : 03 §9, PRD §32.
 *
 * À journaliser : identifiant de requête, horodatage, intention, modèle et
 * outil choisis, décision de politique, décision d'égression, résultat
 * d'exécution, résultat de vérification, latence, coût.
 *
 * À ne PAS journaliser : audio brut, flux caméra, secrets, charges sensibles.
 *
 * La redaction ici est une seconde barrière, pas la première : la première est
 * de ne pas passer le secret. Mais une seconde barrière qui ne sert jamais est
 * exactement celle qui sauve le jour où la première cède.
 */
import { Secret } from '../secrets/vault.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Clés dont la valeur est masquée quel que soit son contenu. */
const SENSITIVE_KEY = /pass(word|phrase)|secret|token|api[-_]?key|authorization|cookie|credential|private[-_]?key/i;

/** Motifs reconnaissables même sans nom de clé révélateur. */
const SENSITIVE_VALUE: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, // clés de style OpenAI
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // jetons GitHub
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
];

export const REDACTED = '[REDACTED]';

export function redactString(input: string): string {
  let out = input;
  for (const pattern of SENSITIVE_VALUE) out = out.replace(pattern, REDACTED);
  return out;
}

/**
 * Masque récursivement une valeur destinée aux logs.
 * Profondeur bornée : une structure cyclique ne doit pas bloquer un log.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[TRUNCATED]';
  if (value instanceof Secret) return REDACTED;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value;
  }
  if (value instanceof Uint8Array) return `[binary ${String(value.length)}o]`;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === 'object' && value !== undefined) {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  return undefined;
}

export interface Logger {
  debug(message: string, fields?: Readonly<Record<string, unknown>>): void;
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
  error(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

export interface LoggerOptions {
  readonly minLevel?: LogLevel;
  readonly sink?: (line: string) => void;
}

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export function createLogger(options: LoggerOptions = {}): Logger {
  const minLevel = options.minLevel ?? 'info';
  const sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));

  function emit(
    level: LogLevel,
    message: string,
    fields?: Readonly<Record<string, unknown>>,
  ): void {
    if (ORDER[level] < ORDER[minLevel]) return;
    const entry = {
      ts: new Date().toISOString(),
      level,
      message: redactString(message),
      ...(fields === undefined
        ? {}
        : { fields: redact(fields) as Record<string, unknown> }),
    };
    sink(JSON.stringify(entry));
  }

  return {
    debug: (m, f) => { emit('debug', m, f); },
    info: (m, f) => { emit('info', m, f); },
    warn: (m, f) => { emit('warn', m, f); },
    error: (m, f) => { emit('error', m, f); },
  };
}
