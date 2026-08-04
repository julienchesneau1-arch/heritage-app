import { prisma } from './prisma';
import { currentFamilyId, currentIdentity, type IdentityLevel } from './session';

export interface ContextMember {
  id: string;
  name: string;
  generation: number;
}

/**
 * Ce que cette famille possède réellement.
 *
 * Sert à ne proposer que des sections qui contiennent quelque chose. La
 * §6.1 dit « parcimonie visuelle » ; un menu de neuf entrées dont sept
 * mènent à une page vide n'est pas parcimonieux, il est décoratif.
 */
export interface Inventaire {
  recits: number;
  archives: number;
  traditions: number;
  entites: number;
  brouillons: number;
  fils: number;
}

export interface AppContext {
  family: { id: string; name: string };
  member: ContextMember | null;
  /** « declared » : choisi dans une liste. « verified » : lien personnel. */
  identityLevel: IdentityLevel | null;
  members: ContextMember[];
  inventaire: Inventaire;
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
    inventaire: await inventaire(family.id),
  };
}

/**
 * Un seul aller-retour. Ce compte est fait à CHAQUE page — six requêtes
 * séparées seraient six fois trop cher pour une information d'affichage.
 */
async function inventaire(familyId: string): Promise<Inventaire> {
  const [row] = await prisma.$queryRaw<Array<Record<string, bigint>>>`
    SELECT
      (SELECT count(*) FROM stories    WHERE family_id = ${familyId} AND archived = false) AS recits,
      (SELECT count(*) FROM archives   WHERE family_id = ${familyId}) AS archives,
      (SELECT count(*) FROM traditions WHERE family_id = ${familyId}) AS traditions,
      (SELECT count(*) FROM entities   WHERE family_id = ${familyId}) AS entites,
      (SELECT count(*) FROM threads    WHERE family_id = ${familyId}) AS fils,
      (SELECT count(*) FROM transcription_drafts
        WHERE family_id = ${familyId} AND status IN ('pending','ready','failed')) AS brouillons
  `;

  // Postgres rend des bigint ; React ne sait pas les sérialiser.
  const n = (valeur: bigint | undefined) => Number(valeur ?? 0n);
  return {
    recits: n(row?.recits),
    archives: n(row?.archives),
    traditions: n(row?.traditions),
    entites: n(row?.entites),
    fils: n(row?.fils),
    brouillons: n(row?.brouillons),
  };
}

/** Seule une identité prouvée peut détruire (§4.1 amendé). */
export function canDelete(context: AppContext): boolean {
  return context.member !== null && context.identityLevel === 'verified';
}
