import { createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';

/**
 * §4.1 — V1 : accès par URL privée + cookie familial. Pas de mot de passe.
 * L'URL est le secret partagé ; le cookie ne fait que le mémoriser.
 *
 * Ce n'est pas de l'authentification forte, et c'est assumé : le jeton
 * autorise l'accès à une famille, jamais à une autre (§2.1 règle 3).
 */

const COOKIE_NAME = 'family_token';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

function secret(): string {
  return process.env.FAMILY_TOKEN_SECRET ?? 'dev-secret-non-securise';
}

export function signFamilyToken(familyId: string): string {
  const mac = createHmac('sha256', secret()).update(familyId).digest('hex');
  return `${familyId}.${mac}`;
}

export function verifyFamilyToken(token: string | undefined): string | null {
  if (!token) return null;
  const separator = token.lastIndexOf('.');
  if (separator <= 0) return null;
  const familyId = token.slice(0, separator);
  const provided = Buffer.from(token.slice(separator + 1), 'utf8');
  const expected = Buffer.from(createHmac('sha256', secret()).update(familyId).digest('hex'), 'utf8');
  if (provided.length !== expected.length) return null;
  return timingSafeEqual(provided, expected) ? familyId : null;
}

export function cookieOptions() {
  return {
    name: COOKIE_NAME,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict' as const,
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  };
}

/** Famille mémorisée par le navigateur, si elle existe. */
export function currentFamilyId(): string | null {
  return verifyFamilyToken(cookies().get(COOKIE_NAME)?.value);
}

/**
 * Une requête API n'est autorisée que sur la famille de son URL, et
 * uniquement si le cookie correspond. Aucune requête cross-family.
 */
export function authorizeFamily(request: Request, familyId: string): boolean {
  const header = request.headers.get('cookie') ?? '';
  const match = header.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  const fromCookie = verifyFamilyToken(match?.[1] ? decodeURIComponent(match[1]) : undefined);
  if (fromCookie === familyId) return true;
  // Premier accès : l'URL fait foi (le secret partagé), le cookie sera posé ensuite.
  return request.headers.get('x-family-token') === signFamilyToken(familyId);
}
