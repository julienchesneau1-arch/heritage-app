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
  authorId: z.string().cuid(),
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
  // Un récit issu d'une conversation la clôt.
  fromConversationId: z.string().cuid().optional(),
});

export type CreateStoryInput = z.infer<typeof createStorySchema>;

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

export const createConversationSchema = z.object({
  storyId: z.string().cuid(),
  questionerId: z.string().cuid(),
  questionText: z.string().min(3).max(500),
});

export const answerConversationSchema = z.object({
  responderId: z.string().cuid(),
  responseText: z.string().min(1).max(2000),
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
