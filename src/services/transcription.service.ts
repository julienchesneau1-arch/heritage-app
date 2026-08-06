import type { PrismaClient } from '@prisma/client';
import OpenAI, { toFile } from 'openai';
import { prisma as defaultPrisma } from '@/lib/prisma';
import { storage } from '@/lib/storage';
import {
  countSuspect,
  draftTextFrom,
  reviewSegments,
  type RawSegment,
  type ReviewedSegment,
} from '@/lib/transcription-doubt';

/**
 * TRANSCRIPTION — opération LLM vérifiée par l'humain (§3.4).
 *
 * Choix du modèle : `whisper-1`, pas `gpt-4o-transcribe`. Le second rend un
 * texte plus « propre », donc plus reformulé — or la façon dont quelqu'un
 * construit ses phrases fait partie de ce qui se transmet. Surtout,
 * `whisper-1` en `verbose_json` renvoie par segment `avg_logprob`,
 * `compression_ratio` et `no_speech_prob` : le modèle dit lui-même où il a
 * douté. Sans ces indicateurs, la vérification humaine se ferait à l'aveugle
 * sur tout le texte.
 *
 * Réglages : température 0 (pas de créativité), langue forcée, et AUCUN
 * prompt — un prompt oriente la sortie vers ce qu'il contient, ce qui est
 * précisément le biais qu'on veut éviter.
 */

export const TRANSCRIPTION_MODEL = 'whisper-1';
export const TRANSCRIPTION_LANGUAGE = 'fr';
/** Limite de l'API OpenAI pour un fichier audio. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export interface TranscriptionOutcome {
  rawText: string;
  segments: ReviewedSegment[];
  suspectCount: number;
  durationSeconds: number | null;
}

export class TranscriptionService {
  private client: OpenAI | null;

  constructor(
    private prisma: PrismaClient = defaultPrisma,
    apiKey = process.env.OPENAI_API_KEY,
  ) {
    this.client = apiKey ? new OpenAI({ apiKey }) : null;
  }

  get isAvailable(): boolean {
    return this.client !== null;
  }

  /** Met un enregistrement en file. Ne transcrit pas : la file est traitée à part. */
  async requestDraft(params: { familyId: string; archiveId: string; memberId: string }) {
    const archive = await this.prisma.archive.findFirst({
      where: { id: params.archiveId, familyId: params.familyId, type: 'AUDIO' },
      select: { id: true, sizeBytes: true },
    });
    if (!archive) return { error: 'Enregistrement introuvable.' as const };
    if (archive.sizeBytes > MAX_AUDIO_BYTES) {
      return { error: 'Enregistrement trop long pour être transcrit (max 25 Mo).' as const };
    }

    const existing = await this.prisma.transcriptionDraft.findUnique({
      where: { archiveId: params.archiveId },
    });
    if (existing) return { draft: existing };

    const draft = await this.prisma.transcriptionDraft.create({
      data: {
        familyId: params.familyId,
        archiveId: params.archiveId,
        requestedById: params.memberId,
        status: 'pending',
      },
    });
    return { draft };
  }

  /**
   * Traite les brouillons en attente. Appelée par un travail de fond, jamais
   * dans le cycle d'une requête : dix minutes d'audio dépassent largement le
   * délai d'une fonction serverless.
   */
  async processPending(limit = 3): Promise<{ processed: number; failed: number; reportes: number }> {
    const pending = await this.prisma.transcriptionDraft.findMany({
      where: { status: 'pending' },
      orderBy: { createdAt: 'asc' },
      take: limit,
      include: { archive: { select: { storageKey: true, mimeType: true, title: true } } },
    });

    let processed = 0;
    let failed = 0;
    /** Ni traités, ni en échec : à reprendre tels quels au prochain passage. */
    let reportes = 0;

    for (const draft of pending) {
      try {
        // ── Une panne de stockage ne condamne pas un enregistrement ──
        //
        // `storage.get` rendait `null` pour toute erreur, y compris un
        // service momentanément injoignable. Le brouillon passait alors en
        // `failed` avec « Fichier audio introuvable dans le stockage », et
        // le relecteur lisait que l'enregistrement de sa grand-mère était
        // perdu — alors qu'il dormait, intact, derrière une panne de deux
        // minutes. On laisse donc le brouillon EN ATTENTE : le cron
        // repassera, et personne n'aura appris une fausse nouvelle.
        let audio: Buffer | null;
        try {
          audio = await storage.get(draft.archive.storageKey);
        } catch (error) {
          console.error('[transcription] stockage injoignable, brouillon laissé en attente', error);
          reportes += 1;
          continue;
        }
        if (!audio) throw new Error('Fichier audio introuvable dans le stockage.');

        const outcome = await this.transcribe(audio, draft.archive.mimeType, draft.archive.title);

        await this.prisma.transcriptionDraft.update({
          where: { id: draft.id },
          data: {
            status: 'ready',
            rawText: outcome.rawText,
            segments: outcome.segments as unknown as object,
            suspectCount: outcome.suspectCount,
            durationSeconds: outcome.durationSeconds,
            model: TRANSCRIPTION_MODEL,
            processedAt: new Date(),
            error: null,
          },
        });
        processed += 1;
      } catch (error) {
        await this.prisma.transcriptionDraft.update({
          where: { id: draft.id },
          data: {
            status: 'failed',
            error: error instanceof Error ? error.message : 'Erreur inconnue.',
            processedAt: new Date(),
          },
        });
        failed += 1;
      }
    }

    return { processed, failed, reportes };
  }

  /** Un brouillon en échec peut être relancé : une panne réseau n'est pas définitive. */
  async retry(familyId: string, draftId: string) {
    await this.prisma.transcriptionDraft.updateMany({
      where: { id: draftId, familyId, status: 'failed' },
      data: { status: 'pending', error: null },
    });
  }

  async transcribe(audio: Buffer, mimeType: string, filename: string): Promise<TranscriptionOutcome> {
    if (!this.client) throw new Error('Aucune clé OpenAI configurée.');

    const file = await toFile(audio, safeFilename(filename, mimeType), { type: mimeType });

    const response = await this.client.audio.transcriptions.create({
      file,
      model: TRANSCRIPTION_MODEL,
      language: TRANSCRIPTION_LANGUAGE,
      // Aucune créativité : on veut la transcription la plus littérale possible.
      temperature: 0,
      // verbose_json est le seul format qui expose les indicateurs de doute.
      response_format: 'verbose_json',
      timestamp_granularities: ['segment'],
      // Volontairement PAS de `prompt` : il biaiserait la sortie.
    });

    return readOutcome(response as unknown as Record<string, unknown>);
  }
}

/** Traduit la réponse de l'API en segments relus. Isolé pour être testable. */
export function readOutcome(response: Record<string, unknown>): TranscriptionOutcome {
  const rawSegments = Array.isArray(response.segments) ? response.segments : [];

  const segments: RawSegment[] = rawSegments
    .filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === 'object')
    .map((s) => ({
      start: numberOr(s.start, 0),
      end: numberOr(s.end, 0),
      text: typeof s.text === 'string' ? s.text : '',
      avgLogprob: numberOrNull(s.avg_logprob),
      compressionRatio: numberOrNull(s.compression_ratio),
      noSpeechProb: numberOrNull(s.no_speech_prob),
    }));

  const reviewed = reviewSegments(segments);

  // Si l'API n'a pas renvoyé de segments, on retombe sur le texte brut : il
  // ne sera pas annoté, donc entièrement à vérifier — ce que l'écran dit.
  const fallbackText = typeof response.text === 'string' ? response.text.trim() : '';

  return {
    rawText: reviewed.length > 0 ? draftTextFrom(reviewed) : fallbackText,
    segments: reviewed,
    suspectCount: countSuspect(reviewed),
    durationSeconds: numberOrNull(response.duration),
  };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function safeFilename(title: string, mimeType: string): string {
  const extension = mimeType.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'webm';
  return `enregistrement.${extension}`;
}

export const transcriptionService = new TranscriptionService();
