import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/prisma';
import { nomAffiche, QUI } from '@/lib/deces';
import { assemblerLivre, type Livre, type RecitDuLivre } from '@/lib/livre';

/**
 * CE QUI ENTRE DANS LE LIVRE — un seul endroit.
 *
 * Ce rassemblement vivait dans `app/livre/page.tsx`. Il en sort parce que
 * le coffre (`src/lib/coffre.ts`) doit produire EXACTEMENT le même livre :
 * deux requêtes écrites deux fois divergeraient un jour — un filtre ajouté
 * ici, oublié là — et la famille aurait deux livres différents sans que
 * rien ne le signale. C'est la classe de défaut que ce dépôt poursuit.
 *
 * Les archivés, les mis en quarantaine et les suspendus n'y sont pas
 * (§5.2 ter) : ils restent dans l'application et dans l'export.
 */
export async function rassemblerLivre(
  familyId: string,
  prisma: PrismaClient = defaultPrisma,
): Promise<Livre> {
  const [recitsBruts, passages, questions, membres, entitesAvecRecit] = await Promise.all([
    prisma.story.findMany({
      where: { familyId, archived: false, quarantined: false, suspendedAt: null },
      orderBy: { createdAt: 'asc' },
      include: {
        author: { select: QUI },
        narrator: { select: QUI },
      },
    }),
    prisma.passage.findMany({
      where: { familyId },
      select: { parentStoryId: true, childStoryId: true },
    }),
    // Les questions que personne n'a reprises : le fil n'a qu'un message.
    prisma.thread.findMany({
      where: { familyId, messageCount: 1, messages: { some: { isQuestion: true } } },
      orderBy: { createdAt: 'asc' },
      include: {
        openedBy: { select: QUI },
        story: { select: { title: true } },
        entity: { select: { name: true } },
        messages: { take: 1, orderBy: { createdAt: 'asc' } },
      },
    }),
    prisma.member.findMany({
      where: { familyId, isDeleted: false },
      select: { id: true, name: true },
      orderBy: [{ generation: 'asc' }, { name: 'asc' }],
    }),
    prisma.entity.findMany({
      where: { familyId, memberId: { not: null }, stories: { some: {} } },
      select: { memberId: true },
    }),
  ]);

  const recits: RecitDuLivre[] = recitsBruts.map((recit) => ({
    id: recit.id,
    titre: recit.title,
    contenu: recit.content,
    createdAt: recit.createdAt,
    eventDate: recit.eventDate,
    structureType: recit.structureType,
    auteur: { id: recit.author.id, nom: recit.author.name, anonymise: recit.author.isDeleted },
    // Le narrateur aussi : un récit dont la VOIX a quitté la famille
    // imprimait son prénom, en toutes lettres, sur du papier (§2.1 règle 1).
    narrateur: recit.narrator ? { id: recit.narrator.id, nom: nomAffiche(recit.narrator) } : null,
  }));

  // Quelqu'un qu'aucun récit ne porte : ni comme voix, ni comme plume, ni
  // comme personne mentionnée.
  const presents = new Set<string>();
  for (const recit of recits) {
    presents.add(recit.auteur.id);
    if (recit.narrateur) presents.add(recit.narrateur.id);
  }
  for (const entite of entitesAvecRecit) if (entite.memberId) presents.add(entite.memberId);

  return assemblerLivre(recits, passages, {
    questionsSansReponse: questions.map((fil) => ({
      texte: fil.messages[0]?.body ?? '',
      posePar: nomAffiche(fil.openedBy),
      aPropos: fil.story?.title ?? fil.entity?.name ?? null,
    })),
    recitsSansDate: recits.filter((recit) => !recit.eventDate).map((recit) => ({ titre: recit.titre })),
    membresJamaisMentionnes: membres
      .filter((membre) => !presents.has(membre.id))
      .map((membre) => ({ id: membre.id, nom: membre.name })),
  });
}
