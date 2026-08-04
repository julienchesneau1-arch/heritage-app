'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { canDelete, loadContext } from '@/lib/context';
import {
  familyCookieOptions,
  memberCookieOptions,
  signFamilyToken,
  signMemberCookie,
} from '@/lib/session';
import { familyService } from '@/services/family.service';
import { importService } from '@/services/import.service';
import { transcriptionService } from '@/services/transcription.service';
import { createFamilySchema, memberSchema, updateStorySchema } from '@/lib/validation';
import { prisma } from '@/lib/prisma';
import { conservateur } from '@/services/conservateur.service';
import { storyService } from '@/services/story.service';
import { threadService, MARK_KINDS, type MarkKind } from '@/services/thread.service';
import { isStructureType, type StructureType } from '@/lib/structure-types';
import { traditionService } from '@/services/tradition.service';
import { TriggerModelService, type TriggerType } from '@/services/trigger-model.service';
import { PasseurService } from '@/services/passeur.service';
import { createStorySchema, createTraditionSchema } from '@/lib/validation';
import { ACCEPTED_TYPES, buildStorageKey, isAcceptedType, MAX_UPLOAD_BYTES, storage } from '@/lib/storage';
import { isReadingSize, READING_COOKIE } from '@/lib/reading';
import { STRUCTURE_TYPES, TONES, VISIBILITY_CONTEXTS } from '@/lib/structure-types';

/**
 * Actions serveur. Chaque action recharge le contexte et ne travaille que
 * sur la famille du cookie : aucune requête cross-family (§2.1 règle 3).
 */

const triggerModel = new TriggerModelService();
const passeurService = new PasseurService();

async function requireContext() {
  const context = await loadContext();
  if (!context) redirect('/bienvenue');
  return context;
}

/**
 * Se déclarer membre depuis le lien familial. Identité DÉCLARÉE : elle
 * suffit pour lire, écrire et poser des questions, jamais pour supprimer.
 * Le cookie est signé — sans quoi il suffirait de le réécrire à la main
 * pour se hisser au niveau vérifié.
 */
export async function chooseMember(formData: FormData) {
  const context = await requireContext();
  const memberId = String(formData.get('memberId') ?? '');
  if (!context.members.some((m) => m.id === memberId)) return;

  cookies().set({ ...memberCookieOptions(), value: signMemberCookie(memberId, 'declared') });
  cookies().set({ ...familyCookieOptions(), value: signFamilyToken(context.family.id) });

  revalidatePath('/', 'layout');
  redirect('/');
}

/**
 * Confort de lecture. Par appareil : la tablette de la grand-mère et le
 * téléphone de sa petite-fille n'ont pas les mêmes yeux.
 */
export async function setReadingSize(formData: FormData) {
  const size = String(formData.get('size') ?? '');
  if (!isReadingSize(size)) return;

  cookies().set({
    name: READING_COOKIE,
    value: size,
    httpOnly: false,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: 60 * 60 * 24 * 365 * 5,
  });
  revalidatePath('/', 'layout');
}

/** §6.3 — « Ne plus me montrer » sur un signal temporel. */
export async function dismissSignal(formData: FormData) {
  const context = await requireContext();
  if (!context.member) return;
  const type = String(formData.get('signalType') ?? '') as TriggerType;
  await triggerModel.dismissSignalType(context.family.id, context.member.id, type);
  revalidatePath('/');
}

/** §6.3 — « Ne plus me montrer » sur une suggestion de récit. */
export async function dismissStory(formData: FormData) {
  const context = await requireContext();
  if (!context.member) return;

  const storyId = String(formData.get('storyId') ?? '');
  const rawContext = String(formData.get('context') ?? 'home');
  const visibilityContext = (VISIBILITY_CONTEXTS as readonly string[]).includes(rawContext)
    ? (rawContext as (typeof VISIBILITY_CONTEXTS)[number])
    : 'home';

  const story = await prisma.story.findFirst({
    where: { id: storyId, familyId: context.family.id },
    select: { id: true },
  });
  if (!story) return;

  await conservateur.processDismissal({
    familyId: context.family.id,
    storyId,
    memberId: context.member.id,
    context: visibilityContext,
  });
  revalidatePath('/');
}

/** Le Passeur a posé une question et on ne la relève pas : elle se tait 14 jours. */
export async function ignorePasseur(formData: FormData) {
  const context = await requireContext();
  if (!context.member) return;
  await passeurService.markIgnored(
    context.family.id,
    context.member.id,
    String(formData.get('subjectId') ?? ''),
    String(formData.get('ruleId') ?? ''),
  );
  revalidatePath('/');
}

export async function archiveStory(formData: FormData) {
  const context = await requireContext();
  const storyId = String(formData.get('storyId') ?? '');
  const archived = String(formData.get('archived') ?? 'true') === 'true';

  await prisma.story.updateMany({
    where: { id: storyId, familyId: context.family.id },
    data: { archived },
  });
  revalidatePath('/recits');
  revalidatePath(`/recits/${storyId}`);
}

export async function releaseQuarantine(formData: FormData) {
  const context = await requireContext();
  if (!context.member) return;
  const storyId = String(formData.get('storyId') ?? '');
  const story = await prisma.story.findFirst({
    where: { id: storyId, familyId: context.family.id },
    select: { id: true },
  });
  if (!story) return;

  // Chacun lève sa propre sourdine, jamais celle d'un autre.
  await conservateur.releaseFromQuarantine(storyId, context.member.id);
  revalidatePath(`/recits/${storyId}`);
  revalidatePath('/transmission');
}

export async function createStory(formData: FormData) {
  const context = await requireContext();
  if (!context.member) redirect('/qui');

  const rawStructure = String(formData.get('structureType') ?? '');
  const rawTone = String(formData.get('tone') ?? 'factuel');
  const rawEventDate = String(formData.get('eventDate') ?? '');
  const parentStoryId = String(formData.get('parentStoryId') ?? '');
  const threadId = String(formData.get('fromThreadId') ?? '');
  const triggerType = String(formData.get('triggerType') ?? 'manual');

  const rawNarrator = String(formData.get('narratorId') ?? '');
  const narratorId =
    rawNarrator && rawNarrator !== context.member.id && context.members.some((m) => m.id === rawNarrator)
      ? rawNarrator
      : undefined;

  const parsed = createStorySchema.safeParse({
    authorId: context.member.id,
    narratorId,
    title: String(formData.get('title') ?? '').trim(),
    content: String(formData.get('content') ?? '').trim(),
    structureType: (STRUCTURE_TYPES as readonly string[]).includes(rawStructure) ? rawStructure : undefined,
    tone: (TONES as readonly string[]).includes(rawTone) ? rawTone : 'factuel',
    eventDate: rawEventDate || undefined,
    parentStoryId: parentStoryId || undefined,
    triggerType: parentStoryId ? triggerType : undefined,
    fromThreadId: threadId || undefined,
    entityNames: parseEntityNames(String(formData.get('entities') ?? '')),
  });

  if (!parsed.success) redirect('/recits/nouveau?erreur=1');

  const story = await storyService.createStory(context.family.id, parsed.data);
  revalidatePath('/recits');
  revalidatePath('/transmission');
  redirect(`/recits/${story.id}`);
}

/**
 * Parler dans un fil.
 *
 * Ouvre le fil si besoin. Aucun titre n'est demandé, aucun type, aucune
 * structure : c'est tout l'intérêt du fil sur la page de rédaction. Trois
 * mots sur la montre de Robert doivent coûter trois mots.
 */
export async function postMessage(formData: FormData) {
  const context = await requireContext();
  if (!context.member) redirect('/qui');

  const body = String(formData.get('body') ?? '').trim();
  if (body.length < 2) return;

  const isQuestion = formData.get('isQuestion') === '1' || body.endsWith('?');
  // Qui a PARLÉ, si ce n'est pas qui tape. Le clavier n'est pas la voix.
  const narratorRaw = String(formData.get('narratorId') ?? '');
  const narratorId = narratorRaw && narratorRaw !== context.member.id ? narratorRaw : null;

  const threadId = String(formData.get('threadId') ?? '');
  const post = {
    familyId: context.family.id,
    authorId: context.member.id,
    narratorId,
    body,
    isQuestion,
  };

  if (threadId) {
    await threadService.reply(threadId, post);
  } else {
    const entityId = String(formData.get('entityId') ?? '');
    const storyId = String(formData.get('storyId') ?? '');
    const anchor = entityId
      ? { kind: 'entity' as const, entityId }
      : storyId
        ? { kind: 'story' as const, storyId }
        : { kind: 'none' as const };

    // On ne fait confiance à aucun identifiant venu du formulaire : il doit
    // appartenir à cette famille.
    if (anchor.kind === 'entity') {
      const entity = await prisma.entity.findFirst({
        where: { id: anchor.entityId, familyId: context.family.id },
        select: { id: true },
      });
      if (!entity) return;
    } else if (anchor.kind === 'story') {
      const story = await prisma.story.findFirst({
        where: { id: anchor.storyId, familyId: context.family.id },
        select: { id: true },
      });
      if (!story) return;
    }

    await threadService.open(anchor, post);
  }

  revalidatePath(String(formData.get('retour') ?? '/'));
}

/**
 * Retirer un message.
 *
 * Constitution, Annexe A point 6 : « Oubli = droit : archivage, silence,
 * suppression sont des décisions familiales ABSOLUES ». Ce chemin
 * n'existait pas — une parole versée dans la mémoire ne pouvait plus être
 * reprise par personne, pas même par celui qui l'avait dite. Une parole
 * qu'on ne peut pas retirer n'a pas été donnée, elle a été prise.
 *
 * Comme pour un récit (§4.1 amendé), seule une identité PROUVÉE détruit :
 * le droit à l'oubli ne s'exerce pas sous une identité qu'on s'est
 * attribuée soi-même dans une liste.
 */
export async function removeMessage(formData: FormData) {
  const context = await requireContext();
  const retour = String(formData.get('retour') ?? '/');
  if (!canDelete(context)) redirect(`${retour}?retrait=identite`);

  const resultat = await threadService.removeMessage(
    context.family.id,
    String(formData.get('messageId') ?? ''),
    context.member!.id,
  );

  if (resultat.raison === 'autorite') redirect(`${retour}?retrait=autorite`);
  if (resultat.filSupprime) {
    revalidatePath('/');
    revalidatePath('/recits');
    redirect('/');
  }

  revalidatePath(retour);
  redirect(retour);
}

/**
 * Cristalliser un fil en récit.
 *
 * C'est le texte RELU par un humain qui entre dans la mémoire, jamais celui
 * que la machine a proposé. Le fil reste, comme provenance.
 */
export async function crystallizeThread(formData: FormData) {
  const context = await requireContext();
  if (!context.member) redirect('/qui');

  const threadId = String(formData.get('threadId') ?? '');
  const thread = await prisma.thread.findFirst({
    where: { id: threadId, familyId: context.family.id },
    select: { id: true, storyId: true, title: true, crystallizedStoryId: true },
  });
  if (!thread || thread.crystallizedStoryId) redirect('/recits');

  const narratorRaw = String(formData.get('narratorId') ?? '');

  const story = await storyService.createStory(context.family.id, {
    authorId: context.member.id,
    narratorId: narratorRaw || undefined,
    title: String(formData.get('title') ?? '').trim(),
    content: String(formData.get('content') ?? '').trim(),
    // La grammaire narrative est fermée : un type hors liste retombe sur le
    // défaut plutôt que d'entrer dans la base.
    structureType: isStructureType(String(formData.get('structureType') ?? ''))
      ? (String(formData.get('structureType')) as StructureType)
      : undefined,
    tone: 'factuel',
    // Un fil accroché à un récit qui en engendre un autre : c'est
    // exactement la primitive du produit, et le passage est enregistré.
    parentStoryId: thread.storyId ?? undefined,
    triggerType: thread.storyId ? 'question' : undefined,
    fromThreadId: thread.id,
  });

  revalidatePath('/recits');
  revalidatePath('/transmission');
  redirect(`/recits/${story.id}`);
}

/**
 * Marquer un message. Ce n'est pas un « j'aime » : « j'y étais » est un
 * fait, et c'est justement le fait que le Passeur devinait faute de mieux.
 * Rien n'est compté ni classé — on affiche des noms.
 */
export async function markMessage(formData: FormData) {
  const context = await requireContext();
  if (!context.member) redirect('/qui');

  const messageId = String(formData.get('messageId') ?? '');
  const kind = String(formData.get('kind') ?? '');
  if (!MARK_KINDS.includes(kind as MarkKind)) return;

  const message = await prisma.message.findFirst({
    where: { id: messageId, familyId: context.family.id },
    select: { id: true },
  });
  if (!message) return;

  const existing = await prisma.messageMark.findFirst({
    where: { messageId, memberId: context.member.id, kind },
    select: { id: true },
  });

  if (existing) await threadService.unmark(messageId, context.member.id, kind as MarkKind);
  else await threadService.mark(messageId, context.member.id, kind as MarkKind);

  revalidatePath(String(formData.get('retour') ?? '/'));
}

export async function createTradition(formData: FormData) {
  const context = await requireContext();

  const parsed = createTraditionSchema.safeParse({
    name: String(formData.get('name') ?? '').trim(),
    description: String(formData.get('description') ?? '').trim(),
    periodicity: String(formData.get('periodicity') ?? 'annual'),
    monthDay: String(formData.get('monthDay') ?? '') || undefined,
    weekDay: formData.get('weekDay') ? Number(formData.get('weekDay')) : undefined,
  });
  if (!parsed.success) redirect('/traditions?erreur=1');

  await prisma.tradition.create({
    data: {
      familyId: context.family.id,
      name: parsed.data.name,
      description: parsed.data.description,
      periodicity: parsed.data.periodicity,
      monthDay: parsed.data.monthDay ?? null,
      weekDay: parsed.data.weekDay ?? null,
    },
  });
  revalidatePath('/traditions');
}

export async function traditionAction(formData: FormData) {
  const context = await requireContext();
  const traditionId = String(formData.get('traditionId') ?? '');
  const action = String(formData.get('action') ?? '');

  if (action === 'activate') await traditionService.activate(context.family.id, traditionId);
  else if (action === 'sleep')
    await traditionService.sleep(context.family.id, traditionId, 'Endormie par la famille.');
  else if (action === 'wake') await traditionService.wake(context.family.id, traditionId);

  revalidatePath('/traditions');
  revalidatePath('/');
}

/**
 * Dépôt d'une photo ou d'un enregistrement, depuis la page d'un récit.
 * Le type d'archive se déduit du type MIME : la famille n'a rien à choisir.
 */
export async function uploadArchive(formData: FormData) {
  const context = await requireContext();
  if (!context.member) redirect('/qui');

  const file = formData.get('file');
  const storyId = String(formData.get('storyId') ?? '') || null;
  const back = storyId ? `/recits/${storyId}` : '/archives';

  if (!(file instanceof File) || file.size === 0) redirect(`${back}?depot=vide`);
  if (file.size > MAX_UPLOAD_BYTES) redirect(`${back}?depot=lourd`);
  if (!isAcceptedType(file.type)) redirect(`${back}?depot=type`);

  if (storyId) {
    const story = await prisma.story.findFirst({
      where: { id: storyId, familyId: context.family.id },
      select: { id: true },
    });
    if (!story) redirect('/archives');
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const storageKey = buildStorageKey(context.family.id, file.type);
  await storage.put(storageKey, bytes);

  await prisma.archive.create({
    data: {
      familyId: context.family.id,
      uploaderId: context.member.id,
      storyId,
      type: ACCEPTED_TYPES[file.type]!.archiveType,
      title: (String(formData.get('title') ?? '').trim() || file.name).slice(0, 200),
      storageKey,
      mimeType: file.type,
      sizeBytes: bytes.byteLength,
      extractedEntities: [],
    },
  });

  revalidatePath('/archives');
  if (storyId) revalidatePath(`/recits/${storyId}`);
  redirect(back);
}

function parseEntityNames(raw: string): Array<{ name: string; type: 'PERSON' | 'PLACE' | 'OBJECT' }> {
  // Format libre : « Robert:PERSON, Montre Omega:OBJECT, Bordeaux:PLACE »
  return raw
    .split(',')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .slice(0, 20)
    .map((chunk) => {
      const [name, type] = chunk.split(':').map((part) => part.trim());
      const upper = (type ?? '').toUpperCase();
      const resolved = upper === 'PLACE' || upper === 'OBJECT' ? upper : 'PERSON';
      return { name: name!, type: resolved as 'PERSON' | 'PLACE' | 'OBJECT' };
    })
    .filter((entity) => entity.name.length > 0);
}

// ─── Fondation : créer une famille, gérer ses membres ───

/**
 * Création d'une famille avec son premier membre. Sans cela, l'application
 * n'a qu'un seul utilisateur : celui du seed.
 */
export async function createFamily(formData: FormData) {
  const parsed = createFamilySchema.safeParse({
    familyName: String(formData.get('familyName') ?? '').trim(),
    name: String(formData.get('name') ?? '').trim(),
    generation: Number(formData.get('generation') ?? 1),
    birthDate: String(formData.get('birthDate') ?? '') || undefined,
    role: String(formData.get('role') ?? '') || undefined,
  });
  if (!parsed.success) redirect('/commencer?erreur=1');

  const { familyName, ...member } = parsed.data;
  const family = await familyService.createFamily(familyName, member);
  const first = family.members[0]!;

  // Le fondateur repart avec une identité vérifiée : c'est lui qui
  // distribuera les liens des autres.
  cookies().set({ ...familyCookieOptions(), value: signFamilyToken(family.id) });
  cookies().set({ ...memberCookieOptions(), value: signMemberCookie(first.id, 'verified') });

  revalidatePath('/', 'layout');
  redirect('/famille?bienvenue=1');
}

export async function addMember(formData: FormData) {
  const context = await requireContext();
  const parsed = memberSchema.safeParse(readMember(formData));
  if (!parsed.success) redirect('/famille?erreur=1');

  await familyService.addMember(context.family.id, parsed.data);
  revalidatePath('/famille');
  revalidatePath('/', 'layout');
}

export async function updateMember(formData: FormData) {
  const context = await requireContext();
  const memberId = String(formData.get('memberId') ?? '');
  const parsed = memberSchema.safeParse(readMember(formData));
  if (!parsed.success) redirect('/famille?erreur=1');

  await familyService.updateMember(context.family.id, memberId, parsed.data);
  revalidatePath('/famille');
  revalidatePath('/', 'layout');
}

export async function removeMember(formData: FormData) {
  const context = await requireContext();
  const memberId = String(formData.get('memberId') ?? '');
  // §2.1 règle 1 : soft-delete. Les récits restent.
  await familyService.removeMember(context.family.id, memberId);
  revalidatePath('/famille');
  revalidatePath('/', 'layout');
}

export async function revokeMemberLink(formData: FormData) {
  const context = await requireContext();
  await familyService.revokeMemberLink(context.family.id, String(formData.get('memberId') ?? ''));
  revalidatePath('/famille');
}

function readMember(formData: FormData) {
  return {
    name: String(formData.get('name') ?? '').trim(),
    generation: Number(formData.get('generation') ?? 1),
    birthDate: String(formData.get('birthDate') ?? '') || undefined,
    deathDate: String(formData.get('deathDate') ?? '') || undefined,
    role: String(formData.get('role') ?? '') || undefined,
  };
}

// ─── Corriger un récit ───

/**
 * Une faute de frappe dans un récit dicté ne doit pas coûter une chaîne de
 * transmission. Avant, le seul recours était de supprimer et retaper — or
 * la suppression efface les Passages attachés, c'est-à-dire précisément ce
 * que le produit mesure.
 *
 * Corriger est réservé à celui qui a saisi ou à celui qui a raconté :
 * personne d'autre n'a autorité sur ces mots.
 */
export async function updateStory(formData: FormData) {
  const context = await requireContext();
  if (!context.member) redirect('/qui');

  const storyId = String(formData.get('storyId') ?? '');
  const story = await prisma.story.findFirst({
    where: { id: storyId, familyId: context.family.id },
    select: { id: true, authorId: true, narratorId: true },
  });
  if (!story) redirect('/recits');

  if (story.authorId !== context.member.id && story.narratorId !== context.member.id) {
    redirect(`/recits/${storyId}?modif=interdit`);
  }

  const rawStructure = String(formData.get('structureType') ?? '');
  const rawTone = String(formData.get('tone') ?? 'factuel');
  const rawEventDate = String(formData.get('eventDate') ?? '');

  const parsed = updateStorySchema.safeParse({
    title: String(formData.get('title') ?? '').trim(),
    content: String(formData.get('content') ?? '').trim(),
    structureType: (STRUCTURE_TYPES as readonly string[]).includes(rawStructure) ? rawStructure : undefined,
    tone: (TONES as readonly string[]).includes(rawTone) ? rawTone : 'factuel',
    eventDate: rawEventDate || undefined,
  });
  if (!parsed.success) redirect(`/recits/${storyId}/modifier?erreur=1`);

  await storyService.updateStory(context.family.id, storyId, parsed.data);
  revalidatePath(`/recits/${storyId}`);
  revalidatePath('/recits');
  redirect(`/recits/${storyId}`);
}

/**
 * Suppression — identité VÉRIFIÉE exigée, et l'auteur seul.
 * Le droit à l'oubli reste absolu (Constitution, §6) ; il ne s'exerce
 * simplement pas sous une identité que l'on s'est attribuée soi-même.
 */
export async function deleteStory(formData: FormData) {
  const context = await requireContext();
  if (!canDelete(context)) redirect(`/recits/${String(formData.get('storyId') ?? '')}?suppr=identite`);

  const storyId = String(formData.get('storyId') ?? '');
  const story = await prisma.story.findFirst({
    where: { id: storyId, familyId: context.family.id },
    select: { id: true, authorId: true, narratorId: true },
  });
  if (!story) redirect('/recits');

  // §2.1 règle 2 dit « uniquement par l'auteur ». Elle a été écrite avant
  // que `narratorId` existe (§2.3 : « la spec ne connaît qu'un authorId »).
  // Appliquée telle quelle, elle empêcherait Jeanne de retirer ses propres
  // mots parce que Claire tenait le clavier — ce qui contredit le point 6
  // pour la seule personne à qui ces mots appartiennent. Le droit s'étend
  // donc au narrateur, comme la correction (§2.5).
  const sienne = story.authorId === context.member!.id || story.narratorId === context.member!.id;
  if (!sienne) redirect(`/recits/${storyId}?suppr=auteur`);

  await prisma.$transaction([
    prisma.passage.deleteMany({ where: { OR: [{ parentStoryId: storyId }, { childStoryId: storyId }] } }),
    // Les fils accrochés au récit partent avec lui (cascade) ; ceux qui
    // s'y sont cristallisés se détachent, la parole reste.
    prisma.thread.updateMany({ where: { crystallizedStoryId: storyId }, data: { crystallizedStoryId: null } }),
    prisma.visibilityLog.deleteMany({ where: { storyId } }),
    prisma.archive.updateMany({ where: { storyId }, data: { storyId: null } }),
    prisma.story.delete({ where: { id: storyId } }),
  ]);

  revalidatePath('/recits');
  revalidatePath('/transmission');
  redirect('/recits');
}

/**
 * Restauration d'une sauvegarde. Crée toujours une NOUVELLE famille :
 * fusionner deux mémoires qui se recouvrent en partie coûterait des récits,
 * et personne ne saurait lesquels.
 */
export async function restoreBackup(formData: FormData) {
  const file = formData.get('backup');
  if (!(file instanceof File) || file.size === 0) {
    redirect(`/restaurer?erreur=${encodeURIComponent('Aucun fichier choisi.')}`);
  }
  if (file.size > 50 * 1024 * 1024) {
    redirect(`/restaurer?erreur=${encodeURIComponent('Fichier trop lourd (max 50 Mo).')}`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await file.text());
  } catch {
    redirect(`/restaurer?erreur=${encodeURIComponent('Ce fichier n’est pas du JSON valide.')}`);
  }

  const result = await importService.importFamily(payload);
  if ('error' in result) redirect(`/restaurer?erreur=${encodeURIComponent(result.error)}`);

  const summary = Object.entries(result.counts)
    .map(([label, count]) => `${count} ${label}`)
    .join(', ');

  cookies().set({ ...familyCookieOptions(), value: signFamilyToken(result.familyId) });
  revalidatePath('/', 'layout');
  redirect(`/qui?restaure=${encodeURIComponent(`${result.familyName} : ${summary}.`)}`);
}

// ─── Transcription : l'audio est l'original, le texte un brouillon ───

/**
 * Met un enregistrement en file de transcription. Rien n'est transcrit ici :
 * le traitement se fait en tâche de fond, et le brouillon apparaît ensuite
 * dans « À mettre au propre ». Aucune notification — §12.
 */
export async function requestTranscription(formData: FormData) {
  const context = await requireContext();
  if (!context.member) redirect('/qui');

  const archiveId = String(formData.get('archiveId') ?? '');
  const result = await transcriptionService.requestDraft({
    familyId: context.family.id,
    archiveId,
    memberId: context.member.id,
  });

  revalidatePath('/brouillons');
  if ('error' in result && result.error) {
    redirect(`/brouillons?erreur=${encodeURIComponent(result.error)}`);
  }
  redirect(`/brouillons/${result.draft!.id}`);
}

export async function retryTranscription(formData: FormData) {
  const context = await requireContext();
  await transcriptionService.retry(context.family.id, String(formData.get('draftId') ?? ''));
  revalidatePath('/brouillons');
}

/**
 * Validation d'un brouillon : c'est ICI, et seulement ici, qu'un texte
 * transcrit entre dans la mémoire de la famille. Tant qu'un humain n'a pas
 * écouté et relu, rien n'existe.
 *
 * Le narrateur est celui dont on entend la voix ; l'auteur, celui qui a
 * validé. Le texte brut du modèle est conservé pour pouvoir comparer plus
 * tard ce qui a été proposé et ce qui a été retenu.
 */
export async function validateTranscription(formData: FormData) {
  const context = await requireContext();
  if (!context.member) redirect('/qui');

  const draftId = String(formData.get('draftId') ?? '');
  const draft = await prisma.transcriptionDraft.findFirst({
    where: { id: draftId, familyId: context.family.id, status: 'ready' },
  });
  if (!draft) redirect('/brouillons');

  const rawNarrator = String(formData.get('narratorId') ?? '');
  const narratorId =
    rawNarrator && rawNarrator !== context.member.id && context.members.some((m) => m.id === rawNarrator)
      ? rawNarrator
      : undefined;

  const parsed = createStorySchema.safeParse({
    authorId: context.member.id,
    narratorId,
    title: String(formData.get('title') ?? '').trim(),
    content: String(formData.get('content') ?? '').trim(),
    tone: 'factuel',
  });
  if (!parsed.success) redirect(`/brouillons/${draftId}?erreur=1`);

  const story = await storyService.createStory(context.family.id, parsed.data);

  await prisma.$transaction([
    // L'enregistrement reste attaché au récit : l'audio est la référence.
    prisma.archive.update({ where: { id: draft.archiveId }, data: { storyId: story.id } }),
    prisma.transcriptionDraft.update({
      where: { id: draft.id },
      data: {
        status: 'validated',
        storyId: story.id,
        validatedById: context.member.id,
        validatedAt: new Date(),
      },
    }),
  ]);

  revalidatePath('/brouillons');
  revalidatePath('/recits');
  redirect(`/recits/${story.id}`);
}

/** Écarter un brouillon. L'enregistrement, lui, reste : c'est l'original. */
export async function discardTranscription(formData: FormData) {
  const context = await requireContext();
  await prisma.transcriptionDraft.updateMany({
    where: { id: String(formData.get('draftId') ?? ''), familyId: context.family.id },
    data: { status: 'discarded' },
  });
  revalidatePath('/brouillons');
  redirect('/brouillons');
}
