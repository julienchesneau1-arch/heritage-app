import { createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { familySecret } from './secrets';

/**
 * Accès familial — §4.1 amendé.
 *
 * V1 avait un seul secret : l'URL de la famille. Suffisant pour LIRE — c'est
 * le choix assumé de la spec, il n'y a pas de mot de passe. Insuffisant pour
 * DÉTRUIRE : l'identité du membre était choisie librement dans une liste,
 * et la suppression d'un récit la vérifiait contre un paramètre d'URL fourni
 * par l'appelant lui-même. La garde ne gardait rien.
 *
 * Désormais deux niveaux :
 *  - Le lien FAMILIAL (`/f/<familyId>`) donne accès à la mémoire, et permet
 *    de se déclarer membre. Identité DÉCLARÉE.
 *  - Le lien PERSONNEL (`/f/<familyId>/m/<memberId>/<jeton>`) prouve qui l'on
 *    est. Identité VÉRIFIÉE.
 *
 * Seule une identité vérifiée peut détruire. Et le jeton personnel porte un
 * numéro de version : l'incrémenter révoque le lien d'un seul membre, sans
 * déconnecter le reste de la famille.
 */

const FAMILY_COOKIE = 'family_token';
const MEMBER_COOKIE = 'member_token';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

function sign(payload: string): string {
  return createHmac('sha256', familySecret()).update(payload).digest('hex');
}

function verify(payload: string, mac: string): boolean {
  const expected = Buffer.from(sign(payload), 'utf8');
  const provided = Buffer.from(mac, 'utf8');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

// ─── Jeton familial ───

export function signFamilyToken(familyId: string): string {
  return `${familyId}.${sign(familyId)}`;
}

export function verifyFamilyToken(token: string | undefined): string | null {
  if (!token) return null;
  const separator = token.lastIndexOf('.');
  if (separator <= 0) return null;
  const familyId = token.slice(0, separator);
  return verify(familyId, token.slice(separator + 1)) ? familyId : null;
}

// ─── Jeton personnel ───

/** Le jeton du lien personnel, à transmettre à ce membre et à lui seul. */
export function signMemberToken(memberId: string, tokenVersion: number): string {
  return sign(`member:${memberId}:${tokenVersion}`);
}

export function verifyMemberToken(memberId: string, tokenVersion: number, token: string): boolean {
  return verify(`member:${memberId}:${tokenVersion}`, token);
}

export type IdentityLevel = 'declared' | 'verified';

export interface MemberIdentity {
  memberId: string;
  level: IdentityLevel;
}

/**
 * Le cookie de membre est signé, niveau compris : sans signature, il
 * suffirait de le réécrire à la main pour passer de « déclaré » à
 * « vérifié ».
 */
export function signMemberCookie(memberId: string, level: IdentityLevel): string {
  const payload = `${memberId}.${level}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyMemberCookie(value: string | undefined): MemberIdentity | null {
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const [memberId, level, mac] = parts as [string, string, string];
  if (level !== 'declared' && level !== 'verified') return null;
  return verify(`${memberId}.${level}`, mac) ? { memberId, level } : null;
}

// ─── Cookies ───

export function familyCookieOptions() {
  return {
    name: FAMILY_COOKIE,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict' as const,
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  };
}

export function memberCookieOptions() {
  return { ...familyCookieOptions(), name: MEMBER_COOKIE };
}

/** Rétro-compatibilité de nom, utilisée par les routes d'entrée. */
export const cookieOptions = familyCookieOptions;

export function currentFamilyId(): string | null {
  return verifyFamilyToken(cookies().get(FAMILY_COOKIE)?.value);
}

export function currentIdentity(): MemberIdentity | null {
  return verifyMemberCookie(cookies().get(MEMBER_COOKIE)?.value);
}

/**
 * Une requête API n'est autorisée que sur la famille de son URL.
 * Jamais de requête cross-family (§2.1 règle 3).
 */
export function authorizeFamily(request: Request, familyId: string): boolean {
  const header = request.headers.get('cookie') ?? '';
  const match = header.match(new RegExp(`(?:^|;\\s*)${FAMILY_COOKIE}=([^;]+)`));
  const fromCookie = verifyFamilyToken(match?.[1] ? decodeURIComponent(match[1]) : undefined);
  if (fromCookie === familyId) return true;
  return request.headers.get('x-family-token') === signFamilyToken(familyId);
}

/**
 * L'identité d'une requête API vient du COOKIE SIGNÉ, jamais d'un paramètre.
 * C'est tout l'objet du correctif : un appelant ne peut plus se déclarer
 * auteur d'un récit qu'il veut supprimer.
 */
export function requestIdentity(request: Request): MemberIdentity | null {
  const header = request.headers.get('cookie') ?? '';
  const match = header.match(new RegExp(`(?:^|;\\s*)${MEMBER_COOKIE}=([^;]+)`));
  return verifyMemberCookie(match?.[1] ? decodeURIComponent(match[1]) : undefined);
}
