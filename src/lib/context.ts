import { cookies } from 'next/headers';
import { prisma } from './prisma';
import { currentFamilyId } from './session';

export const MEMBER_COOKIE = 'member_id';

export interface AppContext {
  family: { id: string; name: string };
  member: { id: string; name: string; generation: number } | null;
  members: Array<{ id: string; name: string; generation: number }>;
}

/**
 * Qui consulte, et pour quelle famille.
 *
 * V1 : la famille vient du cookie signé (§4.1). En développement, s'il n'y
 * en a qu'une en base, on la prend — pour que `npm run dev` juste après le
 * seed affiche quelque chose.
 */
export async function loadContext(): Promise<AppContext | null> {
  let familyId = currentFamilyId();

  if (!familyId && process.env.NODE_ENV !== 'production') {
    const count = await prisma.family.count();
    if (count === 1) familyId = (await prisma.family.findFirst({ select: { id: true } }))!.id;
  }
  if (!familyId) return null;

  const family = await prisma.family.findUnique({
    where: { id: familyId },
    select: { id: true, name: true },
  });
  if (!family) return null;

  const members = await prisma.member.findMany({
    where: { familyId: family.id, isDeleted: false },
    select: { id: true, name: true, generation: true },
    orderBy: [{ generation: 'asc' }, { name: 'asc' }],
  });

  const memberId = cookies().get(MEMBER_COOKIE)?.value;
  const member = members.find((m) => m.id === memberId) ?? null;

  return { family, member, members };
}
