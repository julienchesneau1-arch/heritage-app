import { NextResponse } from 'next/server';

/** Codes d'erreur standardisés — §4.3 de la spec. */
export const ERROR_CODES = {
  PARCIMONY_LIMIT: { status: 429, message: 'Limite de parcimonie atteinte.' },
  CONSTITUTION_BLOCK: { status: 403, message: 'Action interdite par la Constitution.' },
  QUARANTINE_ACTIVE: { status: 409, message: 'Histoire en quarantaine.' },
  NO_SIGNAL: { status: 200, message: 'Aucun trigger détecté.' },
  NOT_FOUND: { status: 404, message: 'Ressource introuvable.' },
  INVALID_INPUT: { status: 422, message: 'Données invalides.' },
  RATE_LIMITED: { status: 429, message: 'Trop de requêtes.' },
  FORBIDDEN: { status: 403, message: 'Accès refusé.' },
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export function apiError(code: ErrorCode, details?: unknown) {
  const { status, message } = ERROR_CODES[code];
  return NextResponse.json({ error: { code, message, details } }, { status });
}

export function apiOk<T>(data: T, status = 200) {
  return NextResponse.json(data, { status });
}
