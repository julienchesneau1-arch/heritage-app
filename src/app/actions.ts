'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { loadContext, MEMBER_COOKIE } from '@/lib/context';
import { cookieOptions, signFamilyToken } from '@/lib/session';
import { prisma } from '@/lib/prisma';
import { conservateur } from '@/services/conservateur.service';
import { storyService } from '@/services/story.service';
import { traditionService } from '@/services/tradition.service';
import { TriggerModelService, type TriggerType } from '@/services/trigger-model.service';
import { PasseurService } from '@/services/passeur.service';
import { createStorySchema, createTraditionSchema } from '@/lib/validation';
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

export async function chooseMember(formData: FormData) {
  const context = await requireContext();
  const memberId = String(formData.get('memberId') ?? '');
  if (!context.members.some((m) => m.id === memberId)) return;

  cookies().set({
    name: MEMBER_COOKIE,
    value: memberId,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
  });
  // Le cookie familial est posé en même temps : l'URL reste le secret partagé.
  cookies().set({ ...cookieOptions(), value: signFamilyToken(context.family.id) });

  revalidatePath('/', 'layout');
  redirect('/');
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
    String(formData.get('storyId') ?? ''),
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
  const storyId = String(formData.get('storyId') ?? '');
  const story = await prisma.story.findFirst({
    where: { id: storyId, familyId: context.family.id },
    select: { id: true },
  });
  if (!story) return;

  await conservateur.releaseFromQuarantine(storyId);
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
  const conversationId = String(formData.get('fromConversationId') ?? '');
  const triggerType = String(formData.get('triggerType') ?? 'manual');

  const parsed = createStorySchema.safeParse({
    authorId: context.member.id,
    title: String(formData.get('title') ?? '').trim(),
    content: String(formData.get('content') ?? '').trim(),
    structureType: (STRUCTURE_TYPES as readonly string[]).includes(rawStructure) ? rawStructure : undefined,
    tone: (TONES as readonly string[]).includes(rawTone) ? rawTone : 'factuel',
    eventDate: rawEventDate || undefined,
    parentStoryId: parentStoryId || undefined,
    triggerType: parentStoryId ? triggerType : undefined,
    fromConversationId: conversationId || undefined,
    entityNames: parseEntityNames(String(formData.get('entities') ?? '')),
  });

  if (!parsed.success) redirect('/recits/nouveau?erreur=1');

  const story = await storyService.createStory(context.family.id, parsed.data);
  revalidatePath('/recits');
  revalidatePath('/transmission');
  redirect(`/recits/${story.id}`);
}

export async function askQuestion(formData: FormData) {
  const context = await requireContext();
  if (!context.member) redirect('/qui');

  const storyId = String(formData.get('storyId') ?? '');
  const questionText = String(formData.get('questionText') ?? '').trim();
  if (questionText.length < 3) return;

  const story = await prisma.story.findFirst({
    where: { id: storyId, familyId: context.family.id },
    select: { id: true },
  });
  if (!story) return;

  await prisma.conversation.create({
    data: {
      familyId: context.family.id,
      storyId,
      questionerId: context.member.id,
      questionText,
    },
  });
  revalidatePath(`/recits/${storyId}`);
}

export async function answerQuestion(formData: FormData) {
  const context = await requireContext();
  if (!context.member) redirect('/qui');

  const conversationId = String(formData.get('conversationId') ?? '');
  const responseText = String(formData.get('responseText') ?? '').trim();
  if (!responseText) return;

  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, familyId: context.family.id },
  });
  if (!conversation) return;

  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      responderId: context.member.id,
      responseText,
      status: conversation.status === 'converted' ? 'converted' : 'answered',
      answeredAt: new Date(),
    },
  });
  revalidatePath(`/recits/${conversation.storyId}`);
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
