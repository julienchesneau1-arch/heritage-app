import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiError, apiOk } from '@/lib/errors';
import { authorizeFamily, requestIdentity } from '@/lib/session';
import { prisma } from '@/lib/prisma';
import { threadService } from '@/services/thread.service';

export const dynamic = 'force-dynamic';

/**
 * Enregistre les moments qu'un humain a retenus dans un export.
 *
 * Le fichier n'arrive jamais ici : il a été lu dans le navigateur, et seuls
 * les passages cochés sont transmis. Cette route ne sait donc rien de ce
 * qui a été écarté — c'est le but.
 *
 * L'identité vient du cookie signé, jamais du corps de la requête : ce
 * n'est pas à l'appelant de déclarer qui écrit dans la mémoire.
 */
const schema = z.object({
  source: z.enum(['whatsapp', 'messenger', 'sms']),
  // nom dans l'export → identifiant de membre. Vide = personne, et c'est
  // une réponse valide : on ne devine pas une identité.
  correspondances: z.record(z.string(), z.string()),
  moments: z
    .array(
      z.object({
        debut: z.string().datetime(),
        messages: z
          .array(
            z.object({
              auteur: z.string().trim().min(1).max(120),
              texte: z.string().max(5000),
              date: z.string().datetime(),
              pieceJointe: z.string().max(255).nullable(),
            }),
          )
          .min(1)
          .max(500),
      }),
    )
    .min(1)
    .max(200),
});

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  if (!(await authorizeFamily(request, params.id))) return apiError('FORBIDDEN');

  const identity = requestIdentity(request);
  if (!identity) return apiError('FORBIDDEN', 'Identité requise pour écrire dans la mémoire.');

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError('INVALID_INPUT', parsed.error.flatten());

  const membres = await prisma.member.findMany({
    where: { familyId: params.id, isDeleted: false },
    select: { id: true },
  });
  const valides = new Set(membres.map((membre) => membre.id));
  if (!valides.has(identity.memberId)) return apiError('FORBIDDEN');

  // Une correspondance vers un membre d'une autre famille n'existe pas.
  const correspondances = new Map(
    Object.entries(parsed.data.correspondances).filter(([, id]) => valides.has(id)),
  );

  const origine = { whatsapp: 'WhatsApp', messenger: 'Messenger', sms: 'SMS' }[parsed.data.source];

  let fils = 0;
  for (const moment of parsed.data.moments) {
    // D'où viennent ces mots, dit une fois pour le fil. La famille doit
    // pouvoir savoir qu'un échange a été repris ailleurs, et non écrit ici.
    const titre = `Conversation ${origine} du ${new Date(moment.debut).toLocaleDateString('fr-FR')}`;
    const [premier, ...suite] = moment.messages;
    if (!premier) continue;

    // L'importateur est l'AUTEUR — c'est lui qui pose ces mots ici. Le
    // narrateur est celui qui les a dits, quand on sait qui c'est. La même
    // distinction que pour un récit dicté, et pour la même raison : sans
    // elle, tout ce que la famille a dit pendant dix ans serait attribué à
    // celui qui a exporté le fichier.
    const enMessage = (message: (typeof moment.messages)[number]) => {
      const narratorId = correspondances.get(message.auteur) ?? null;
      return {
        familyId: params.id,
        authorId: identity.memberId,
        narratorId,
        // Quand personne n'a été rattaché, le nom de l'export est la seule
        // trace de qui a parlé : le perdre attribuerait ces mots au
        // déposant. L'interface le promet, le code doit le tenir.
        body: corps(message, narratorId === null),
        isQuestion: message.texte.trimEnd().endsWith('?'),
      };
    };

    const thread = await threadService.open({ kind: 'none' }, enMessage(premier), titre);
    for (const message of suite) await threadService.reply(thread.id, enMessage(message));
    fils += 1;
  }

  return apiOk({ fils }, 201);
}

/**
 * Le texte tel qu'il a été écrit — précédé du nom de l'export quand aucun
 * membre n'a été rattaché, car ce nom est alors la seule trace de qui a
 * parlé. On ne réécrit rien d'autre : ce sont les mots de quelqu'un.
 */
function corps(
  message: { auteur: string; texte: string; pieceJointe: string | null },
  citerLAuteur: boolean,
): string {
  const texte = message.texte.trim();
  const media = message.pieceJointe ? `[${message.pieceJointe} — non importé]` : '';
  const contenu = [texte, media].filter(Boolean).join(' ').trim() || '[message vide]';
  return citerLAuteur ? `${message.auteur} : ${contenu}` : contenu;
}
