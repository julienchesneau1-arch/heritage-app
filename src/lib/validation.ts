import { z } from 'zod';
import {
  ARCHIVE_TYPES,
  ENTITY_TYPES,
  MAX_CONTENT_LENGTH,
  STRUCTURE_TYPES,
  TONES,
  TRIGGER_TYPES,
  VISIBILITY_CONTEXTS,
} from './structure-types';

// §8.2 : validation Zod sur tous les inputs API.

export const createStorySchema = z.object({
  // Qui a saisi le récit.
  authorId: z.string().cuid(),
  // Qui l'a raconté, si ce n'est pas la même personne.
  narratorId: z.string().cuid().optional(),
  title: z.string().min(1).max(160),
  content: z.string().min(1).max(MAX_CONTENT_LENGTH),
  structureType: z.enum(STRUCTURE_TYPES).optional(),
  tone: z.enum(TONES).default('factuel'),
  eventDate: z.coerce.date().optional(),
  entityNames: z
    .array(z.object({ name: z.string().min(1).max(120), type: z.enum(ENTITY_TYPES) }))
    .max(20)
    .optional(),
  // Transmission explicite : ce récit naît d'un autre.
  parentStoryId: z.string().cuid().optional(),
  triggerType: z.enum(TRIGGER_TYPES).optional(),
  // Un récit né d'un fil : le fil devient sa provenance.
  fromThreadId: z.string().cuid().optional(),
});

export type CreateStoryInput = z.infer<typeof createStorySchema>;

/** Correction d'un récit : le contenu, jamais l'auteur ni les passages. */
export const updateStorySchema = z.object({
  title: z.string().min(1).max(160),
  content: z.string().min(1).max(MAX_CONTENT_LENGTH),
  structureType: z.enum(STRUCTURE_TYPES).optional(),
  tone: z.enum(TONES).default('factuel'),
  eventDate: z.coerce.date().optional(),
});

export type UpdateStoryInput = z.infer<typeof updateStorySchema>;

/** Un membre : au moins un nom et une génération. Les dates nourrissent le Trigger Model. */
export const memberSchema = z
  .object({
    name: z.string().min(1).max(120),
    generation: z.coerce.number().int().min(1).max(10),
    birthDate: z.coerce.date().optional(),
    deathDate: z.coerce.date().optional(),
    role: z.string().max(280).optional(),
    // Ne pas figurer au flux `.ics`, qui est recopié chez Google ou Apple.
    // Par défaut on y figure : c'est l'état d'avant cette case, et une
    // migration ne doit pas retirer les gens d'un calendrier sans le dire.
    calendarOptOut: z.boolean().default(false),
  })
  .refine((m) => !m.birthDate || !m.deathDate || m.deathDate >= m.birthDate, {
    message: 'La date de décès ne peut précéder la naissance.',
    path: ['deathDate'],
  });

/** Une famille se crée avec son premier membre : une mémoire a besoin de quelqu'un qui la porte. */
export const createFamilySchema = z
  .object({
    familyName: z.string().min(1).max(120),
    name: z.string().min(1).max(120),
    generation: z.coerce.number().int().min(1).max(10),
    birthDate: z.coerce.date().optional(),
    role: z.string().max(280).optional(),
  });

export const listStoriesSchema = z.object({
  search: z.string().max(120).optional(),
  structureType: z.enum(STRUCTURE_TYPES).optional(),
  authorId: z.string().cuid().optional(),
  entityId: z.string().cuid().optional(),
  includeArchived: z.coerce.boolean().default(false),
  take: z.coerce.number().int().min(1).max(100).default(50),
  skip: z.coerce.number().int().min(0).default(0),
});

export const viewStorySchema = z.object({
  memberId: z.string().cuid(),
  context: z.enum(VISIBILITY_CONTEXTS).default('home'),
});

export const dismissStorySchema = z.object({
  memberId: z.string().cuid(),
  context: z.enum(VISIBILITY_CONTEXTS).default('home'),
  reason: z.string().max(280).optional(),
});

export const createTraditionSchema = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().min(1).max(1000),
    periodicity: z.enum(['annual', 'monthly', 'weekly']),
    monthDay: z
      .string()
      .regex(/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'Format attendu : MM-JJ')
      .optional(),
    weekDay: z.number().int().min(0).max(6).optional(),
  })
  .refine((t) => (t.periodicity === 'annual' ? Boolean(t.monthDay) : true), {
    message: 'Une tradition annuelle exige monthDay (MM-JJ).',
    path: ['monthDay'],
  })
  .refine((t) => (t.periodicity === 'weekly' ? t.weekDay !== undefined : true), {
    message: 'Une tradition hebdomadaire exige weekDay (0-6).',
    path: ['weekDay'],
  });

/**
 * Parler dans un fil. Rien n'est obligatoire au-delà du corps du message :
 * c'est exactement ce que l'ancien `createConversationSchema` interdisait,
 * puisqu'il exigeait un `storyId`.
 */
export const openThreadSchema = z.object({
  authorId: z.string().cuid(),
  narratorId: z.string().cuid().optional(),
  body: z.string().trim().min(2).max(5000),
  isQuestion: z.boolean().optional(),
  title: z.string().trim().min(1).max(120).optional(),
  // Au plus un ancrage — la base le vérifie aussi.
  threadId: z.string().cuid().optional(),
  entityId: z.string().cuid().optional(),
  storyId: z.string().cuid().optional(),
});

export const createArchiveSchema = z.object({
  uploaderId: z.string().cuid(),
  storyId: z.string().cuid().optional(),
  type: z.enum(ARCHIVE_TYPES),
  title: z.string().min(1).max(200),
  storageKey: z.string().min(1).max(500),
  mimeType: z.string().min(1).max(120),
  sizeBytes: z.number().int().min(0).max(500 * 1024 * 1024),
  extractedText: z.string().max(20000).optional(),
});

/** Parse un objet et renvoie soit les données, soit les erreurs formatées. */
export function parseOrNull<T extends z.ZodTypeAny>(schema: T, input: unknown) {
  const result = schema.safeParse(input);
  return result.success
    ? { data: result.data as z.infer<T>, errors: null }
    : { data: null, errors: result.error.flatten() };
}
