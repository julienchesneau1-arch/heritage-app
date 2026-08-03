import { prisma } from './prisma';
import { currentFamilyId, currentIdentity, type IdentityLevel } from './session';

export interface ContextMember {
  id: string;
  name: string;
  generation: number;
}

export interface AppContext {
  family: { id: string; name: string };
  member: ContextMember | null;
  /** « declared » : choisi dans une liste. « verified » : lien personnel. */
  identityLevel: IdentityLevel | null;
  members: ContextMember[];
}

/**
 * Qui consulte, et pour quelle famille.
 *
 * En développement, s'il n'existe qu'une seule famille en base, on la prend :
 * `npm run dev` juste après le seed doit afficher quelque chose.
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

  const identity = currentIdentity();
  const member = identity ? (members.find((m) => m.id === identity.memberId) ?? null) : null;

  return {
    family,
    member,
    identityLevel: member ? identity!.level : null,
    members,
  };
}

/** Seule une identité prouvée peut détruire (§4.1 amendé). */
export function canDelete(context: AppContext): boolean {
  return context.member !== null && context.identityLevel === 'verified';
}
