import { prisma } from './prisma';
import { currentFamilyId, currentIdentity, type IdentityLevel } from './session';
import { peutAgir } from './deces';

export interface ContextMember {
  id: string;
  name: string;
  generation: number;
  /**
   * Présente pour que chaque écran puisse trancher lui-même entre les deux
   * rôles. `members` garde TOUT LE MONDE, morts compris : « je note ce que
   * ma grand-mère racontait » est précisément ce qu'on vient faire ici après
   * une mort. Ce sont les écrans où il faut AGIR — prendre une identité,
   * relire un enregistrement — qui écartent. Voir `src/lib/deces.ts`.
   */
  deathDate: Date | null;
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
  /**
   * `tokenVersion` sert à réémettre le jeton familial affiché en page
   * Famille. Sans lui, l'écran montrerait un jeton de version 1 alors que
   * la famille aurait fait tourner son lien — un secret de secours faux
   * est pire qu'aucun.
   */
  family: { id: string; name: string; tokenVersion: number };
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
  let familyId = await currentFamilyId();

  if (!familyId && process.env.NODE_ENV !== 'production') {
    const count = await prisma.family.count();
    if (count === 1) familyId = (await prisma.family.findFirst({ select: { id: true } }))!.id;
  }
  if (!familyId) return null;

  const family = await prisma.family.findUnique({
    where: { id: familyId },
    select: { id: true, name: true, tokenVersion: true },
  });
  if (!family) return null;

  const members = await prisma.member.findMany({
    where: { familyId: family.id, isDeleted: false },
    select: { id: true, name: true, generation: true, deathDate: true },
    orderBy: [{ generation: 'asc' }, { name: 'asc' }],
  });

  const identity = currentIdentity();
  /*
   * ── UNE SESSION OUVERTE NE SURVIT PAS AU DÉCÈS ──
   *
   * `members` garde tout le monde, morts compris — c'est voulu : on note
   * encore ce qu'ils racontaient. Mais le membre COURANT, celui au nom de
   * qui l'application agit, doit pouvoir agir. `/qui` ne propose plus un
   * défunt et son lien personnel n'ouvre plus de session ; il restait ce
   * troisième chemin, le plus discret — un cookie posé avant la mort.
   *
   * Trouvé en regardant une capture d'écran, pas en relisant le code : la
   * page d'un récit affichait « Qui parle : Robert Martin (moi) » alors
   * que Robert était marqué décédé deux écrans plus loin.
   *
   * La session retombe simplement sur « Qui êtes-vous ? ». Rien n'est
   * détruit, et corriger la date en `/famille` rend tout.
   */
  const candidat = identity ? (members.find((m) => m.id === identity.memberId) ?? null) : null;
  const member = candidat && peutAgir(candidat) ? candidat : null;

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
