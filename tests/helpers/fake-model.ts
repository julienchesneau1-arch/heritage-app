/**
 * Double de test pour un fournisseur de modèle.
 *
 * Il ne raisonne pas : il rejoue une réponse programmée. C'est délibéré — les
 * tests de quarantaine doivent vérifier ce que le SYSTÈME fait d'une sortie de
 * modèle, pas la qualité de cette sortie.
 *
 * Le cas le plus important est celui du modèle **compromis** : on programme
 * une réponse qui obéit à l'injection, et on vérifie que le système la
 * neutralise quand même. Une garantie qui dépendrait du bon comportement du
 * modèle ne serait pas architecturale.
 */
import type {
  ChatRequest,
  ChatResponse,
  ModelProvider,
  ProviderHealth,
} from '../../src/providers/contract.js';
import { ok, type Result } from '../../src/core/types/result.js';

export interface FakeModelOptions {
  /** Réponse structurée renvoyée par `structuredOutput`. */
  readonly structured?: unknown;
  readonly text?: string;
}

export function createFakeModel(options: FakeModelOptions = {}): ModelProvider {
  const seen: ChatRequest[] = [];

  return {
    capabilities: {
      id: 'fake-model',
      local: true,
      requiresNetwork: false,
      maxPrivacyClass: 'RED',
      costPerMillionTokensEur: 0,
    },

    health(): Promise<Result<ProviderHealth>> {
      return Promise.resolve(ok({ available: true }));
    },

    chat(request: ChatRequest): Promise<Result<ChatResponse>> {
      seen.push(request);
      return Promise.resolve(
        ok({
          content: options.text ?? '',
          model: 'fake-model',
          promptTokens: 0,
          completionTokens: 0,
          costEur: 0,
        }),
      );
    },

    structuredOutput<T>(
      request: ChatRequest,
      validate: (raw: unknown) => Result<T>,
    ): Promise<Result<T>> {
      seen.push(request);
      return Promise.resolve(validate(options.structured));
    },

    embeddings(): Promise<Result<readonly number[][]>> {
      return Promise.resolve(ok([]));
    },
  };
}
