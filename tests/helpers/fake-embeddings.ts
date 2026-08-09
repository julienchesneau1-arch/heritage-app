/**
 * Double de test pour le fournisseur d'embeddings.
 *
 * Ce n'est PAS un modèle : c'est un sac de mots projeté sur 768 dimensions puis
 * normalisé. Deux textes partageant des mots produisent des vecteurs proches,
 * ce qui suffit à éprouver la plomberie — requête pgvector, filtrage par
 * modèle, fusion RRF, dégradation.
 *
 * Il ne dit rien de la qualité sémantique réelle. Cette question-là relève du
 * banc de mesure sur la machine cible (08 §7), pas de la suite de tests.
 */
import type {
  EmbeddingProvider,
  ProviderHealth,
} from '../../src/providers/contract.js';
import { ok, err, jarvisError, type Result } from '../../src/core/types/result.js';

const DIMENSIONS = 768;

function bucket(token: string): number {
  let hash = 2166136261;
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % DIMENSIONS;
}

export function embedDeterministic(text: string): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  const tokens = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1);

  for (const token of tokens) {
    const index = bucket(token);
    vector[index] = (vector[index] ?? 0) + 1;
  }

  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) {
    // Un vecteur nul rendrait la distance cosinus indéfinie. On renvoie un
    // vecteur unitaire arbitraire mais stable.
    vector[0] = 1;
    return vector;
  }
  return vector.map((v) => v / norm);
}

export interface FakeEmbeddingOptions {
  /** Simule une panne du fournisseur — le chemin hors ligne. */
  readonly unavailable?: boolean;
  readonly model?: string;
}

export function createFakeEmbeddingProvider(
  options: FakeEmbeddingOptions = {},
): EmbeddingProvider {
  const model = options.model ?? 'fake-bow-768';
  return {
    dimensions: DIMENSIONS,
    model,
    capabilities: {
      id: model,
      local: true,
      requiresNetwork: false,
      maxPrivacyClass: 'RED',
      costPerMillionTokensEur: 0,
    },
    health(): Promise<Result<ProviderHealth>> {
      return Promise.resolve(
        ok({ available: options.unavailable !== true }),
      );
    },
    embed(texts: readonly string[]): Promise<Result<readonly number[][]>> {
      if (options.unavailable === true) {
        return Promise.resolve(
          err(
            jarvisError(
              'PROVIDER_UNAVAILABLE',
              'Fournisseur d\'embeddings simulé indisponible',
            ),
          ),
        );
      }
      return Promise.resolve(ok(texts.map(embedDeterministic)));
    },
  };
}
