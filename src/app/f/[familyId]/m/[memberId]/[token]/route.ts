import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import {
  familyCookieOptions,
  memberCookieOptions,
  signFamilyToken,
  signMemberCookie,
  verifyMemberToken,
} from '@/lib/session';

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
  const member = await prisma.member.findFirst({
    where: { id: params.memberId, familyId: params.familyId, isDeleted: false },
    select: { id: true, tokenVersion: true, family: { select: { tokenVersion: true } } },
  });

  const valid = member && verifyMemberToken(member.id, member.tokenVersion, params.token);

  const response = NextResponse.redirect(new URL(valid ? '/' : '/bienvenue', request.nextUrl.origin));
  if (valid) {
    response.cookies.set({
      ...familyCookieOptions(),
      value: signFamilyToken(params.familyId, member.family.tokenVersion),
    });
    response.cookies.set({ ...memberCookieOptions(), value: signMemberCookie(member.id, 'verified') });
  }
  return response;
}
