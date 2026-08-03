import { prisma } from '@/lib/prisma';
import { verifyMemberToken } from '@/lib/session';
import { familyEvents, toIcs } from '@/lib/calendar';

export const dynamic = 'force-dynamic';

/**
 * Le flux iCalendar de la famille.
 *
 * L'URL EST le secret : un agenda ne renvoie pas de cookie, il ne sait que
 * télécharger une adresse. On réutilise donc le jeton personnel — celui qui
 * porte déjà `tokenVersion`, si bien que « Révoquer ce lien » sur la page
 * Famille coupe aussi le calendrier de ce membre, et de lui seul. Pas de
 * second mécanisme de révocation à tenir à jour, pas de second à oublier.
 *
 * En lecture seule, et sans contenu : jamais le texte d'un récit. Ce flux
 * est recopié dans Google ou Apple, et ce qu'on y met, on le leur donne.
 */
export async function GET(
  _request: Request,
  { params }: { params: { memberId: string; token: string } },
) {
  const member = await prisma.member.findUnique({
    where: { id: params.memberId },
    select: { id: true, familyId: true, isDeleted: true, tokenVersion: true },
  });

  // Réponse identique dans les trois cas : un membre inconnu, retiré, ou un
  // jeton faux ne se distinguent pas de l'extérieur.
  if (!member || member.isDeleted || !verifyMemberToken(member.id, member.tokenVersion, params.token)) {
    return new Response('Calendrier introuvable.', { status: 404 });
  }

  const [family, members, traditions, stories] = await Promise.all([
    prisma.family.findUniqueOrThrow({ where: { id: member.familyId }, select: { name: true } }),
    prisma.member.findMany({
      where: { familyId: member.familyId, isDeleted: false },
      select: { id: true, name: true, birthDate: true, deathDate: true },
    }),
    prisma.tradition.findMany({
      where: { familyId: member.familyId, isAsleep: false },
      select: { id: true, name: true, description: true, monthDay: true },
    }),
    // Bornée : un calendrier de mille lignes n'est plus un calendrier. Les
    // récits les plus récemment datés d'abord.
    prisma.story.findMany({
      where: { familyId: member.familyId, archived: false, quarantined: false, eventDate: { not: null } },
      select: { id: true, title: true, eventDate: true },
      orderBy: { eventDate: 'desc' },
      take: 200,
    }),
  ]);

  const events = familyEvents(
    { familyName: family.name, members, traditions, stories },
    new Date().getFullYear(),
  );

  // `stamp` figé sur la date du jour, pas sur l'instant : sans cela chaque
  // rafraîchissement produirait un flux différent d'un octet, et tous les
  // agendas de la famille croiraient à une modification, chaque heure.
  const stamp = new Date();
  stamp.setUTCHours(0, 0, 0, 0);

  return new Response(toIcs(events, { calendarName: `Famille ${family.name} — mémoire`, stamp }), {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="heritage.ics"',
      'Cache-Control': 'private, max-age=3600',
    },
  });
}
