/**
 * Interfaces fournisseurs.
 *
 * ADR-003 / invariant I6 : le noyau ne connaît aucun fournisseur. Il n'existe
 * nulle part de `if (provider === 'OpenAI')`.
 *
 * RÈGLE VÉRIFIÉE PAR LE BUILD
 * ---------------------------
 * Seuls les fichiers de `src/providers/**` peuvent importer un SDK de
 * fournisseur. Toute infraction fait échouer
 * `tests/contracts/provider-isolation.test.ts`, donc la CI.
 *
 * Aucune de ces interfaces n'expose de secret : les identifiants sont injectés
 * au moment de l'exécution par le Tool Gateway (03 §9).
 */
import type { PrivacyClass } from '../core/types/domain.js';
import type { Result } from '../core/types/result.js';

/* -------------------------------------------------------------------------- */
/* Capacités communes                                                         */
/* -------------------------------------------------------------------------- */

/** Décrit ce qu'un fournisseur sait faire — le routeur choisit une capacité,
 *  jamais un fournisseur (00 §R2, PRD §31). */
export interface ProviderCapabilities {
  readonly id: string;
  /** Un fournisseur local n'expose jamais de donnée hors de la machine. */
  readonly local: boolean;
  readonly requiresNetwork: boolean;
  /** Classe maximale de donnée que ce fournisseur a le droit de voir. */
  readonly maxPrivacyClass: PrivacyClass;
  /** Coût indicatif par million de jetons, en euros. 0 pour le local. */
  readonly costPerMillionTokensEur: number;
}

export interface ProviderHealth {
  readonly available: boolean;
  readonly latencyMs?: number;
  readonly detail?: string;
}

export interface Provider {
  readonly capabilities: ProviderCapabilities;
  health(): Promise<Result<ProviderHealth>>;
}

/* -------------------------------------------------------------------------- */
/* Modèles                                                                    */
/* -------------------------------------------------------------------------- */

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface ChatRequest {
  readonly messages: readonly ChatMessage[];
  readonly maxTokens?: number;
  readonly temperature?: number;
}

export interface ChatResponse {
  readonly content: string;
  readonly model: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly costEur: number;
}

export interface ModelProvider extends Provider {
  chat(request: ChatRequest): Promise<Result<ChatResponse>>;
  /**
   * Sortie structurée. Le schéma est fourni par l'appelant et la réponse est
   * validée avant de revenir — une sortie de modèle est une entrée non fiable
   * (S1), y compris quand elle prétend être du JSON.
   */
  structuredOutput<T>(
    request: ChatRequest,
    validate: (raw: unknown) => Result<T>,
  ): Promise<Result<T>>;
  embeddings(texts: readonly string[]): Promise<Result<readonly number[][]>>;
}

/** ADR-007 — Ollama, llama.cpp, MLX… derrière une interface unique. */
export interface LocalModelRuntime extends Provider {
  listModels(): Promise<Result<readonly string[]>>;
  isModelLoaded(model: string): Promise<Result<boolean>>;
}

/* -------------------------------------------------------------------------- */
/* Voix                                                                       */
/* -------------------------------------------------------------------------- */

export interface TranscriptionRequest {
  readonly audio: Uint8Array;
  readonly language: string;
}

export interface TranscriptionResult {
  readonly text: string;
  readonly language: string;
  readonly confidence: number;
  readonly durationMs: number;
}

export interface SpeechProvider extends Provider {
  /** ADR-008 — Whisper par défaut, pour le français. */
  transcribe(request: TranscriptionRequest): Promise<Result<TranscriptionResult>>;
  /** ADR-009 — uniquement des modèles sous licence permissive. */
  synthesize(text: string, voice: string): Promise<Result<Uint8Array>>;
}

/* -------------------------------------------------------------------------- */
/* Vision                                                                     */
/* -------------------------------------------------------------------------- */

export interface VisionProvider extends Provider {
  describe(image: Uint8Array): Promise<Result<string>>;
  extractText(image: Uint8Array): Promise<Result<string>>;
}

/** ADR-014 — caméra iPhone, Ray-Ban Meta, futures lunettes. */
export interface VisionSource {
  readonly id: string;
  capturePhoto(): Promise<Result<Uint8Array>>;
  readonly supportsContinuousStream: boolean;
}

/* -------------------------------------------------------------------------- */
/* Données personnelles                                                       */
/* -------------------------------------------------------------------------- */

export interface CalendarEvent {
  readonly id: string;
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt: string;
}

export interface CalendarProvider extends Provider {
  listEvents(fromIso: string, toIso: string): Promise<Result<readonly CalendarEvent[]>>;
  createEvent(
    event: Omit<CalendarEvent, 'id'>,
    operationId: string,
  ): Promise<Result<CalendarEvent>>;
  /**
   * Relit l'état réel après mutation. C'est ce qui distingue « l'API a répondu
   * 200 » de « l'événement existe » (22 du PRD, invariant S7).
   */
  verifyEvent(id: string): Promise<Result<CalendarEvent | null>>;
}

export interface MessagingProvider extends Provider {
  prepare(to: string, body: string): Promise<Result<{ readonly draftId: string }>>;
  send(
    draftId: string,
    operationId: string,
  ): Promise<Result<{ readonly messageId: string }>>;
  /** Preuve fournisseur : sans elle, le statut reste UNKNOWN. */
  verifySent(messageId: string): Promise<Result<boolean>>;
}

export interface StorageProvider extends Provider {
  search(query: string): Promise<Result<readonly string[]>>;
  read(path: string): Promise<Result<Uint8Array>>;
}

export interface SearchProvider extends Provider {
  search(query: string): Promise<Result<readonly { title: string; url: string }[]>>;
}

/** ADR-015 — Home Assistant est un DeviceProvider, pas le cerveau. */
export interface DeviceProvider extends Provider {
  listDevices(): Promise<Result<readonly { id: string; name: string }[]>>;
  setState(deviceId: string, state: string, operationId: string): Promise<Result<void>>;
  verifyState(deviceId: string): Promise<Result<string>>;
}
