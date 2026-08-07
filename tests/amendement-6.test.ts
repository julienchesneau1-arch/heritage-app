import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import {
  connu,
  contientUnCalculPerissable,
  divulguer,
  enPourcentage,
  estVraimentPremier,
  mesurer,
  raisonDe,
} from '@/lib/honnetete';
import { MetricsService, MIN_STORIES_FOR_RATE } from '@/services/metrics.service';
import { ConservateurService } from '@/services/conservateur.service';
import { createMemoryStore } from '@/lib/redis';

/**
 * AMENDEMENT 6 — Le produit n'affirme que ce qu'il a vérifié.
 *
 * Comme les amendements 1, 3 et 5 : testé, pas commenté. Si un test de ce
 * fichier échoue, le code ne part pas.
 */

describe('Clause 1 — une mesure impossible ne vaut pas zéro', () => {
  it('refuse de rendre un taux sur une base vide', () => {
    const m = mesurer(0, 0, { sujet: 'récit' });
    expect(m.mesurable).toBe(false);
    expect(m.mesurable === false && m.raison).toMatch(/il n’y a pas de taux/);
  });

  it('refuse de conclure sous le minimum exigé', () => {
    // Viser « une histoire sur cinq » n'a pas de sens sur trois récits :
    // la mesure saute par-dessus le seuil qu'elle évalue.
    expect(mesurer(0, 3, { sujet: 'récit', minimum: 5 }).mesurable).toBe(false);
    expect(mesurer(0, 5, { sujet: 'récit', minimum: 5 }).mesurable).toBe(true);
  });

  it('accorde le pluriel : la raison est lue par la famille', () => {
    const deux = mesurer(0, 2, { sujet: 'récit', minimum: 5 });
    expect(deux.mesurable === false && deux.raison).toContain('2 récits');
    const un = mesurer(0, 1, { sujet: 'récit', minimum: 5 });
    expect(un.mesurable === false && un.raison).toContain('1 récit :');
  });

  it('distingue « zéro mesuré » de « pas mesurable »', () => {
    // Le cas qui compte : une base suffisante et un numérateur nul est un
    // VRAI zéro, et il doit s'afficher.
    const vraiZero = mesurer(0, 10, { sujet: 'récit' });
    expect(vraiZero.mesurable).toBe(true);
    expect(vraiZero.mesurable && vraiZero.valeur).toBe(0);
    expect(enPourcentage(vraiZero)).toBe('0 %');
    expect(enPourcentage(mesurer(0, 0, { sujet: 'récit' }))).toBe('—');
  });

  it('n’affiche jamais un pourcentage pour une mesure absente', () => {
    expect(enPourcentage({ mesurable: false, base: 0, raison: 'x' })).toBe('—');
  });

  it('rend la raison plutôt que la légende quand rien n’est mesurable', () => {
    const absente = mesurer(0, 0, { sujet: 'fil' });
    expect(raisonDe(absente, 'légende habituelle')).toBe(
      absente.mesurable === false ? absente.raison : '',
    );
    expect(raisonDe(mesurer(1, 4, { sujet: 'fil' }), 'légende habituelle')).toBe('légende habituelle');
  });

  it('traite aussi ce qui n’est pas une part sur une base', () => {
    expect(connu(null, 'rien à mesurer').mesurable).toBe(false);
    const trente = connu(30, 'rien à mesurer');
    expect(trente.mesurable && trente.valeur).toBe(30);
  });
});

describe('Clause 1, appliquée — aucune métrique dérivée ne vaut zéro sur une famille vide', () => {
  function serviceVide() {
    const prisma = {
      story: { count: async () => 0, findMany: async () => [] },
      passage: { findMany: async () => [] },
      thread: { count: async () => 0 },
      message: { count: async () => 0 },
      visibilityLog: { groupBy: async () => [] },
    } as unknown as PrismaClient;
    return { metrics: new MetricsService(prisma), prisma };
  }

  it('rend « non mesurable » pour chaque taux, jamais 0', async () => {
    const metrics = await serviceVide().metrics.transmission('fam_vide');

    // Toutes les Mesure de l'objet, quelles qu'elles soient : le test ne se
    // périme pas quand une métrique est ajoutée.
    const mesures = Object.entries(metrics).filter(
      ([, v]) => typeof v === 'object' && v !== null && 'mesurable' in v,
    );
    expect(mesures.length).toBeGreaterThanOrEqual(5);

    for (const [nom, mesure] of mesures) {
      expect(mesure, `${nom} devrait être non mesurable sur une famille vide`).toMatchObject({
        mesurable: false,
      });
      expect((mesure as { raison: string }).raison.length).toBeGreaterThan(20);
    }
  });

  it('laisse les COMPTES à zéro : « zéro récit » est un fait, pas une inconnue', async () => {
    const metrics = await serviceVide().metrics.transmission('fam_vide');
    expect(metrics.storiesCount).toBe(0);
    expect(metrics.passagesCount).toBe(0);
    expect(metrics.maxChainDepth).toBe(0);
  });

  it('ne se prononce pas non plus sur la distorsion', async () => {
    const { prisma } = serviceVide();
    const conservateur = new ConservateurService(prisma, createMemoryStore());
    expect(await conservateur.calculateDistortion('fam_vide')).toBeNull();
  });

  it('le seuil de la primitive reste celui que la spec justifie', () => {
    expect(MIN_STORIES_FOR_RATE).toBe(5);
  });
});

describe('Clause 2 — une vue bornée dit ce qu’elle borne', () => {
  it('annonce ce qui est caché', () => {
    expect(divulguer({ affiches: 8, total: 14, unite: 'récits' })).toBe('8 récits affichés sur 14.');
  });

  it('précise l’ordre quand il en existe un', () => {
    expect(divulguer({ affiches: 8, total: 14, unite: 'récits', ordre: 'les plus récents' })).toBe(
      '8 récits affichés sur 14 — les plus récents.',
    );
  });

  it('se tait quand rien n’est caché : on ne meuble pas', () => {
    expect(divulguer({ affiches: 14, total: 14, unite: 'récits' })).toBeNull();
    expect(divulguer({ affiches: 0, total: 0, unite: 'récits' })).toBeNull();
  });
});

describe('Clause 3 — un superlatif se vérifie avant de s’énoncer', () => {
  it('renonce quand plusieurs sont à égalité', () => {
    // Le classement n'a pas départagé : il a rendu le premier venu.
    expect(estVraimentPremier([2, 2, 2])).toBe(false);
  });

  it('accepte quand il y a un vrai premier', () => {
    expect(estVraimentPremier([5, 2, 1])).toBe(true);
  });

  it('accepte un candidat unique — il n’y a personne pour l’égaler', () => {
    expect(estVraimentPremier([3])).toBe(true);
  });

  it('refuse sur une liste vide', () => {
    expect(estVraimentPremier([])).toBe(false);
  });
});

describe('Clause 4 — rien de dérivé du présent n’est gravé', () => {
  it('repère un calcul qui vieillira', () => {
    // Gravé dans un flux que l'agenda recopie, ce texte sera faux dans un an
    // sans que personne ne s'en aperçoive.
    expect(contientUnCalculPerissable('Il y a 10 ans, le décès de Robert.')).toBe(true);
    expect(contientUnCalculPerissable('Personne ne l’a relu depuis 3 ans.')).toBe(true);
    expect(contientUnCalculPerissable('Jeanne, âgée de 92 ans.')).toBe(true);
    expect(contientUnCalculPerissable('Deux ans plus tard, ils sont partis.')).toBe(false);
    expect(contientUnCalculPerissable('3 ans après, ils sont partis.')).toBe(true);
  });

  it('laisse passer une date de référence', () => {
    // La donnée, pas le calcul : le lecteur refait l'arithmétique à chaque
    // lecture, donc elle est juste à chaque lecture.
    expect(contientUnCalculPerissable('Robert Martin (1931–2014)')).toBe(false);
    expect(contientUnCalculPerissable('Date de décès enregistrée : 2014-11-08.')).toBe(false);
  });
});

describe('Rien ne sort du serveur sans que ce soit dit', () => {
  /**
   * L'application a une page entière intitulée « Ce que l'application fait
   * de votre mémoire ». Elle ne disait rien du seul endroit où la mémoire
   * QUITTE PHYSIQUEMENT le serveur : la transcription par API, qui envoie
   * la voix d'une personne à un tiers hors de l'Union européenne.
   *
   * L'écran disait que la machine « se trompe et qu'il lui arrive
   * d'inventer » — c'est vrai, et ce n'est pas la question : personne
   * n'était informé du départ.
   *
   * Une phrase générique aurait été pire que rien : sur une installation
   * SANS clé, annoncer un départ serait faux et ferait renoncer des gens à
   * un chemin qui ne sort de nulle part. Ce qui est dit dépend donc de la
   * configuration réelle, lue à un seul endroit.
   */
  const SOURCE = readFileSync(join(process.cwd(), 'src', 'lib', 'sortie.ts'), 'utf8');

  it('le tiers est nommé, jamais laissé dans le flou', () => {
    expect(SOURCE).toMatch(/OpenAI/);
    expect(SOURCE).toMatch(/États-Unis/);
  });

  it('les deux chemins ont deux textes différents', async () => {
    const { AVERTISSEMENT_TRANSCRIPTION, SORTIE_DECRITE } = await import('@/lib/sortie');
    expect(AVERTISSEMENT_TRANSCRIPTION.local).not.toBe(AVERTISSEMENT_TRANSCRIPTION.api);
    expect(SORTIE_DECRITE.local).not.toBe(SORTIE_DECRITE.api);
  });

  it('le chemin local promet que rien ne part, et le tient', async () => {
    const { AVERTISSEMENT_TRANSCRIPTION, SORTIE_DECRITE } = await import('@/lib/sortie');
    expect(AVERTISSEMENT_TRANSCRIPTION.local).toMatch(/ne quitte pas/);
    expect(AVERTISSEMENT_TRANSCRIPTION.local).not.toMatch(/OpenAI/);
    expect(SORTIE_DECRITE.local).not.toMatch(/OpenAI/);
  });

  it('le chemin par API dit que la voix sort, et où', async () => {
    const { AVERTISSEMENT_TRANSCRIPTION } = await import('@/lib/sortie');
    expect(AVERTISSEMENT_TRANSCRIPTION.api).toMatch(/OpenAI/);
    expect(AVERTISSEMENT_TRANSCRIPTION.api).toMatch(/Union européenne/);
  });

  it('le texte suit la configuration réelle, il n’est pas figé', async () => {
    const { cheminDeTranscription } = await import('@/lib/sortie');
    const avant = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = '';
    expect(cheminDeTranscription()).toBe('local');
    process.env.OPENAI_API_KEY = 'sk-test';
    expect(cheminDeTranscription()).toBe('api');
    if (avant === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = avant;
  });

  it('les deux écrans concernés le disent', () => {
    const RECIT = readFileSync(join(process.cwd(), 'src', 'app', 'recits', '[storyId]', 'page.tsx'), 'utf8');
    const REDDITION = readFileSync(join(process.cwd(), 'src', 'app', 'transmission', 'page.tsx'), 'utf8');
    // Au moment du geste, et dans la reddition de comptes.
    expect(RECIT).toMatch(/AVERTISSEMENT_TRANSCRIPTION\[cheminDeTranscription\(\)\]/);
    expect(REDDITION).toMatch(/SORTIE_DECRITE\[cheminDeTranscription\(\)\]/);
  });
});
