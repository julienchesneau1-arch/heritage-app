import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { cookieOptions, signFamilyToken } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * Porte d'entrée familiale (§4.1). L'URL privée pose le cookie signé,
 * puis on redirige. Le lien n'a besoin d'être ouvert qu'une fois par appareil.
 */
export async function GET(_request: NextRequest, { params }: { params: { familyId: string } }) {
  const family = await prisma.family.findUnique({
    where: { id: params.familyId },
    select: { id: true },
  });

  const response = NextResponse.redirect(
    new URL(family ? '/qui' : '/bienvenue', process.env.NEXT_PUBLIC_APP_URL ?? _request.nextUrl.origin),
  );

  if (family) {
    response.cookies.set({ ...cookieOptions(), value: signFamilyToken(family.id) });
  }

  return response;
}
