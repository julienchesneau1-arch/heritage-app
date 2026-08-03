import OpenAI from 'openai';
import { constitutionEmotionFilter, emotionViolation } from '@/lib/constitution';
import { DEFAULT_STRUCTURE_TYPE, isStructureType, STRUCTURE_TYPES } from '@/lib/structure-types';

/**
 * LLM OPERATOR SERVICE — §3.4.
 *
 * Mission : exécuter des opérations informationnelles vérifiables.
 * Ne jamais décider. Ne jamais inférer d'émotion.
 *
 * Toute sortie passe par deux filtres : la vérification propre à l'opération,
 * puis le filtre constitutionnel. Une sortie qui échoue devient un fallback.
 * Sans OPENAI_API_KEY, le service renvoie directement les fallbacks : l'app
 * fonctionne, simplement sans assistance linguistique.
 */

export interface LLMRequest {
  prompt: string;
  maxTokens: number;
  temperature: number;
  verify?: (output: string) => boolean;
  fallback?: string;
}

const SYSTEM_PROMPT = `Tu es un opérateur linguistique pour une application de mémoire familiale.
RÈGLES ABSOLUES :
- Ne jamais inférer une émotion (tristesse, joie, colère).
- Ne jamais inventer de fait non présent dans le texte source.
- Ne jamais suggérer une action que l'utilisateur n'a pas demandée.
- Toujours rester factuel, sobre, respectueux.`;

export class LLMOperatorService {
  private client: OpenAI | null;

  constructor(apiKey = process.env.OPENAI_API_KEY) {
    this.client = apiKey ? new OpenAI({ apiKey }) : null;
  }

  get isAvailable(): boolean {
    return this.client !== null;
  }

  async generateVerified(request: LLMRequest): Promise<string | null> {
    if (!this.client) return request.fallback ?? null;

    let output: string;
    try {
      const response = await this.client.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: request.prompt },
        ],
        max_tokens: request.maxTokens,
        temperature: request.temperature,
      });
      output = response.choices[0]?.message?.content?.trim() ?? '';
    } catch (error) {
      console.error('[LLM] Erreur génération :', error);
      return request.fallback ?? null;
    }

    if (!output) return request.fallback ?? null;

    // Vérification propre à l'opération.
    if (request.verify && !request.verify(output)) {
      console.warn('[LLM] Vérification échouée, retour fallback');
      return request.fallback ?? null;
    }

    // Vérification constitutionnelle : jamais d'inférence émotionnelle.
    const violation = emotionViolation(output);
    if (violation) {
      console.warn(`[LLM] Inférence émotionnelle détectée (${violation}), rejetée`);
      return request.fallback ?? null;
    }

    return output;
  }

  /** Opération autorisée : extraction d'entités. Vérifiée par parsing strict. */
  async extractEntities(text: string): Promise<Array<{ name: string; type: string }>> {
    const prompt = `Extrais les entités nommées de ce texte familial.
Pour chaque entité, donne son nom et son type (PERSON, PLACE, OBJECT, DATE).
Réponds UNIQUEMENT en JSON : [{"name": "...", "type": "..."}]

Texte : "${text.slice(0, 1000)}"`;

    const response = await this.generateVerified({
      prompt,
      maxTokens: 500,
      temperature: 0.1,
      verify: (output) => parseEntities(output) !== null,
      fallback: '[]',
    });

    return (response ? parseEntities(response) : null) ?? [];
  }

  /** Opération autorisée : classification dans les types imposés par le système. */
  async classifyStructure(text: string): Promise<string> {
    const prompt = `Classe ce texte familial dans UNE SEULE catégorie parmi : ${STRUCTURE_TYPES.join(', ')}.
Réponds UNIQUEMENT par le nom de la catégorie, sans ponctuation.

Texte : "${text.slice(0, 500)}"`;

    const response = await this.generateVerified({
      prompt,
      maxTokens: 50,
      temperature: 0.1,
      verify: (output) => isStructureType(output.trim().toLowerCase()),
      fallback: DEFAULT_STRUCTURE_TYPE,
    });

    const candidate = response?.trim().toLowerCase() ?? DEFAULT_STRUCTURE_TYPE;
    return isStructureType(candidate) ? candidate : DEFAULT_STRUCTURE_TYPE;
  }

  /**
   * Opération autorisée : formuler une question à partir d'un vide
   * informationnel repéré par une règle du Passeur. Le LLM ne choisit ni
   * l'histoire, ni la règle — seulement les mots.
   */
  async phraseQuestion(storyContent: string, fallback: string): Promise<string> {
    const prompt = `Dans ce texte familial, identifie UNE tension non résolue (quelque chose qui est mentionné mais pas expliqué).
Réponds UNIQUEMENT par une question ouverte, en 1 phrase, sans inférer d'émotion.

Texte : "${storyContent.slice(0, 500)}"`;

    const response = await this.generateVerified({
      prompt,
      maxTokens: 100,
      temperature: 0.7,
      verify: (text) => text.includes('?') && text.length <= 240 && constitutionEmotionFilter(text),
      fallback,
    });

    return response ?? fallback;
  }
}

function parseEntities(output: string): Array<{ name: string; type: string }> | null {
  try {
    const cleaned = output.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const parsed: unknown = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return null;
    const valid = parsed.filter(
      (entry): entry is { name: string; type: string } =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as { name?: unknown }).name === 'string' &&
        typeof (entry as { type?: unknown }).type === 'string',
    );
    return valid.length === parsed.length ? valid : null;
  } catch {
    return null;
  }
}

export const llmOperator = new LLMOperatorService();
