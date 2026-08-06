import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import {
  familyCookieOptions,
  memberCookieOptions,
  signFamilyToken,
  signMemberCookie,
  verifyMemberToken,
} from '@/lib/session';
import { ACTEURS } from '@/lib/deces';

export const dynamic = 'force-dynamic';

/**
 * Lien personnel. Il prouve qui l'on est — c'est le seul chemin vers une
 * identité vérifiée, donc vers le droit de supprimer ses propres récits.
 *
 * Le jeton intègre `tokenVersion` : incrémenter cette valeur pour un membre
 * invalide son lien à lui seul, sans déconnecter le reste de la famille.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { familyId: string; memberId: string; token: string } },
) {
  /*
   * ── LE LIEN D'UN DÉFUNT N'OUVRE PLUS DE SESSION À SON NOM ──
   *
   * Ce filtre ne portait que sur `isDeleted`. Le lien personnel d'un mort
   * restait donc valide indéfiniment — et c'est le seul qui prouve une
   * identité, donc le seul qui autorise à SUPPRIMER. Supprimer au nom d'un
   * mort n'est pas une suppression : c'est une usurpation.
   *
   * Le refus est doux : on renvoie vers l'accueil avec un mot, sans
   * détruire quoi que ce soit. Et si la date de décès est une erreur, elle
   * se corrige depuis `/famille` et le lien revient.
   */
  const member = await prisma.member.findFirst({
    where: { id: params.memberId, familyId: params.familyId, ...ACTEURS },
    select: { id: true, tokenVersion: true, family: { select: { tokenVersion: true } } },
  });

  // Distinguer « ce lien n'existe pas » de « cette personne est décédée » :
  // sans cela, la famille croirait à un lien cassé et le ferait tourner.
  const defunt =
    member === null
      ? await prisma.member.findFirst({
          where: { id: params.memberId, familyId: params.familyId, isDeleted: false },
          select: { deathDate: true },
        })
      : null;

  const valid = member && verifyMemberToken(member.id, member.tokenVersion, params.token);

  const destination = valid
    ? '/'
    : defunt?.deathDate
      ? `/bienvenue?lien=${encodeURIComponent('decede')}`
      : '/bienvenue';
  const response = NextResponse.redirect(new URL(destination, request.nextUrl.origin));
  if (valid) {
    response.cookies.set({
      ...familyCookieOptions(),
      value: signFamilyToken(params.familyId, member.family.tokenVersion),
    });
    response.cookies.set({ ...memberCookieOptions(), value: signMemberCookie(member.id, 'verified') });
  }
  return response;
}
