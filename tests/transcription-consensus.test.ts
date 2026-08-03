import { describe, expect, it } from 'vitest';
import {
  compareTranscriptions,
  consensusSummary,
  normalizeToken,
  tokenize,
} from '@/lib/transcription-consensus';

/**
 * Le pari de ce module : deux modèles indépendants n'inventent pas la même
 * chose. Là où ils coïncident, le texte est très probablement juste ; là où
 * ils divergent, il faut écouter. Ces tests vérifient que les divergences
 * sont bien isolées — ni noyées, ni inventées.
 */

describe('Normalisation des mots', () => {
  it('ignore ponctuation, casse et accents', () => {
    expect(normalizeToken('Vélos,')).toBe(normalizeToken('velos'));
    expect(normalizeToken('« Père »')).toBe('pere');
  });

  it('découpe sur les espaces sans produire de mots vides', () => {
    expect(tokenize('  Il   réparait  les vélos. ')).toEqual(['Il', 'réparait', 'les', 'vélos.']);
  });
});

describe('Accord parfait', () => {
  const texte = 'Il réparait les vélos de tout le quartier.';

  it('ne signale aucune divergence', () => {
    const result = compareTranscriptions(texte, texte);
    expect(result.divergenceCount).toBe(0);
    expect(result.agreementRate).toBe(1);
  });

  it('ne compte pas la ponctuation comme un désaccord', () => {
    // Signaler « vélos. » contre « vélos » noierait les vrais écarts.
    const result = compareTranscriptions('Il réparait les vélos.', 'Il réparait les vélos');
    expect(result.divergenceCount).toBe(0);
  });

  it('ne compte pas la casse ni les accents', () => {
    const result = compareTranscriptions('Le Poirier', 'le poirier');
    expect(result.divergenceCount).toBe(0);
  });

  it('le dit sans promettre une fiabilité chiffrée', () => {
    const résumé = consensusSummary(compareTranscriptions(texte, texte));
    expect(résumé).toContain('coïncident');
    expect(résumé).toContain('écoute reste recommandée');
    expect(résumé).not.toMatch(/\d+\s*%/);
  });
});

describe('Divergences isolées', () => {
  it('repère une substitution au milieu d’une phrase', () => {
    const result = compareTranscriptions(
      'Le poirier a été planté en 1958 derrière la maison',
      'Le poirier a été planté en 1968 derrière la maison',
    );

    expect(result.divergenceCount).toBe(1);
    const divergence = result.tokens.find((token) => token.kind === 'divergent');
    expect(divergence?.a).toBe('1958');
    expect(divergence?.b).toBe('1968');
  });

  it('n’affole pas tout le reste après un mot ajouté', () => {
    // L'alignement naïf déclarerait divergent tout ce qui suit l'insertion.
    const result = compareTranscriptions(
      'Il refusait sans jamais expliquer pourquoi',
      'Il refusait toujours sans jamais expliquer pourquoi',
    );
    expect(result.divergenceCount).toBe(1);
    expect(result.agreementRate).toBeGreaterThan(0.8);
  });

  it('repère une hallucination ajoutée par un seul modèle', () => {
    // Le cas qui compte : un modèle invente une phrase entière, l'autre non.
    const result = compareTranscriptions(
      'Le poirier donne trop de fruits à la mi-octobre',
      'Le poirier donne trop de fruits à la mi-octobre Sous-titres réalisés par la communauté',
    );

    expect(result.divergenceCount).toBe(1);
    const ajout = result.tokens.find((token) => token.kind === 'only-b');
    expect(ajout?.b).toContain('Sous-titres');
  });

  it('repère un passage manquant chez un modèle', () => {
    const result = compareTranscriptions(
      'Il refusait il ne voulait pas dire pourquoi',
      'Il refusait pourquoi',
    );
    expect(result.divergenceCount).toBeGreaterThan(0);
  });

  it('regroupe une substitution de plusieurs mots en UNE divergence', () => {
    // Cinq mots remplacés, c'est un endroit à écouter, pas cinq.
    const result = compareTranscriptions(
      'Elle est dans le tiroir du buffet arrêtée à quatre heures douze',
      'Elle est dans le tiroir du buffet arrêtée à seize heures trente',
    );
    expect(result.divergenceCount).toBe(1);
  });

  it('compte plusieurs zones distinctes séparément', () => {
    const result = compareTranscriptions(
      'Robert portait une Omega de 1962 achetée à Bordeaux',
      'Robert portait une Rolex de 1962 achetée à Toulouse',
    );
    expect(result.divergenceCount).toBe(2);
  });
});

describe('Ce qui est retenu par défaut', () => {
  it('garde la version A — une seule référence assumée, jamais un mélange', () => {
    // Fusionner automatiquement deux versions produirait un texte que
    // personne n'a prononcé ni validé.
    const result = compareTranscriptions('Version A du récit', 'Version B du récit');
    expect(result.text).toBe('Version A du récit');
  });
});

describe('Cas limites', () => {
  it('traite deux textes vides sans planter', () => {
    const result = compareTranscriptions('', '');
    expect(result.divergenceCount).toBe(0);
    expect(result.agreementRate).toBe(1);
  });

  it('traite un texte vide face à un texte plein', () => {
    const result = compareTranscriptions('', 'Il réparait les vélos');
    expect(result.divergenceCount).toBe(1);
    expect(result.agreementRate).toBe(0);
  });

  it('ne s’effondre pas sur un très long enregistrement', () => {
    const long = Array.from({ length: 5000 }, (_, i) => `mot${i}`).join(' ');
    const début = Date.now();
    const result = compareTranscriptions(long, long);
    expect(Date.now() - début).toBeLessThan(2000);
    expect(result.text.length).toBeGreaterThan(0);
  });

  it('reste rapide sur un enregistrement de taille réaliste', () => {
    // ~2000 mots ≈ quinze minutes de parole.
    const a = Array.from({ length: 2000 }, (_, i) => `mot${i}`).join(' ');
    const b = a.replace('mot500', 'autre');
    const début = Date.now();
    const result = compareTranscriptions(a, b);
    expect(Date.now() - début).toBeLessThan(3000);
    expect(result.divergenceCount).toBe(1);
  });
});
