import { describe, expect, it } from 'vitest';
import { constitutionEmotionFilter, isNonCoerciveLanguage } from '@/lib/constitution';
import { LLMOperatorService } from '@/services/llm-operator.service';

/**
 * §12 : « Les règles constitutionnelles sont des tests. Si un test échoue,
 * le code ne shippe pas. » Ce fichier est donc normatif, pas décoratif.
 */

describe('Amendement 1 — pas d’inférence émotionnelle', () => {
  const forbidden = [
    'Vous semblez triste en relisant cette histoire.',
    'Ça vous manque, cette époque ?',
    'Vous devez être fier de votre père.',
    'Tu as l’air nostalgique.',
    'Cela a dû être difficile pour la famille.',
    'On sent bien que ce souvenir compte.',
    'Vous regrettez de ne pas lui avoir demandé.',
  ];

  it.each(forbidden)('rejette : %s', (text) => {
    expect(constitutionEmotionFilter(text)).toBe(false);
  });

  const allowed = [
    'Cette histoire dit que Robert réparait les vélos. Elle ne dit pas pourquoi il refusait d’en acheter un neuf.',
    'Emma n’a pas encore raconté cette histoire de son point de vue.',
    '« La montre arrêtée » a été racontée il y a 2 ans. Qu’est-ce qui a changé depuis ?',
    'Il y a 11 ans, le décès de Robert Martin.',
  ];

  it.each(allowed)('accepte : %s', (text) => {
    expect(constitutionEmotionFilter(text)).toBe(true);
  });
});

describe('§6.2 — le langage ne fait pas pression', () => {
  it('rejette le chantage à la lecture', () => {
    expect(isNonCoerciveLanguage('Vous n’avez pas lu cette histoire.')).toBe(false);
  });

  it('rejette le guilt-tripping temporel', () => {
    expect(isNonCoerciveLanguage('Il y a longtemps que personne n’a rien raconté.')).toBe(false);
    expect(isNonCoerciveLanguage('Pensez à raconter quelque chose aujourd’hui.')).toBe(false);
  });

  it('accepte la formulation neutre', () => {
    expect(isNonCoerciveLanguage('Cette histoire n’a pas été relue depuis 2023.')).toBe(true);
  });
});

describe('LLMOperatorService — le filtre s’applique après génération', () => {
  /** Faux client OpenAI : renvoie ce qu'on lui dit de renvoyer. */
  function operatorReturning(text: string) {
    const operator = new LLMOperatorService('clef-de-test');
    // Injection du double de test à la place du client réel.
    (operator as unknown as { client: unknown }).client = {
      chat: {
        completions: {
          create: async () => ({ choices: [{ message: { content: text } }] }),
        },
      },
    };
    return operator;
  }

  it('rejette une sortie qui infère une émotion, malgré une vérification passante', async () => {
    const operator = operatorReturning('Vous semblez triste.');
    const result = await operator.generateVerified({
      prompt: 'peu importe',
      maxTokens: 50,
      temperature: 0,
      verify: () => true,
      fallback: 'FALLBACK',
    });
    expect(result).toBe('FALLBACK');
  });

  it('laisse passer une sortie factuelle', async () => {
    const operator = operatorReturning('Qui a offert ce vélo à Robert ?');
    const result = await operator.generateVerified({
      prompt: 'peu importe',
      maxTokens: 50,
      temperature: 0,
    });
    expect(result).toBe('Qui a offert ce vélo à Robert ?');
  });

  it('sans clé API, renvoie le fallback sans appel réseau', async () => {
    const operator = new LLMOperatorService(undefined);
    expect(operator.isAvailable).toBe(false);
    await expect(
      operator.generateVerified({ prompt: 'x', maxTokens: 10, temperature: 0, fallback: 'FALLBACK' }),
    ).resolves.toBe('FALLBACK');
  });

  it('classifyStructure ne renvoie jamais un type hors de la grammaire', async () => {
    const operator = operatorReturning('type-invente-par-le-modele');
    await expect(operator.classifyStructure('texte')).resolves.toBe('evenement-marquant');
  });

  it('extractEntities rejette un JSON malformé plutôt que d’inventer', async () => {
    const operator = operatorReturning('pas du json du tout');
    await expect(operator.extractEntities('texte')).resolves.toEqual([]);
  });
});
