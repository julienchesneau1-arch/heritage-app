import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VAD,
  detectSpeechSegments,
  frameEnergies,
  planChunks,
  sliceSamples,
  speechRatio,
} from '@/lib/audio-chunking';

const SAMPLE_RATE = 16_000;

/** Signal synthétique : alternance de parole (sinusoïde) et de silence. */
function build(parts: Array<{ seconds: number; speech: boolean; amplitude?: number }>): Float32Array {
  const total = parts.reduce((sum, part) => sum + Math.round(part.seconds * SAMPLE_RATE), 0);
  const samples = new Float32Array(total);
  let cursor = 0;

  for (const part of parts) {
    const count = Math.round(part.seconds * SAMPLE_RATE);
    const amplitude = part.amplitude ?? 0.5;
    for (let i = 0; i < count; i += 1, cursor += 1) {
      samples[cursor] = part.speech ? Math.sin((2 * Math.PI * 180 * i) / SAMPLE_RATE) * amplitude : 0;
    }
  }

  return samples;
}

describe('Énergie par fenêtre', () => {
  it('distingue le silence de la parole', () => {
    const energies = frameEnergies(build([{ seconds: 0.2, speech: false }]), SAMPLE_RATE, 20);
    expect(energies.every((value) => value === 0)).toBe(true);

    const parlé = frameEnergies(build([{ seconds: 0.2, speech: true }]), SAMPLE_RATE, 20);
    expect(parlé.every((value) => value > 0)).toBe(true);
  });
});

describe('Détection de la parole', () => {
  it('isole un passage parlé entouré de silence', () => {
    const samples = build([
      { seconds: 2, speech: false },
      { seconds: 3, speech: true },
      { seconds: 2, speech: false },
    ]);

    const segments = detectSpeechSegments(samples, SAMPLE_RATE);
    expect(segments).toHaveLength(1);
    // Marge de 250 ms de part et d'autre : on ne mange pas les attaques.
    expect(segments[0]!.start).toBeGreaterThan(1.5);
    expect(segments[0]!.start).toBeLessThan(2.1);
    expect(segments[0]!.end).toBeGreaterThan(4.9);
    expect(segments[0]!.end).toBeLessThan(5.5);
  });

  it('sépare deux prises de parole séparées par un long silence', () => {
    const segments = detectSpeechSegments(
      build([
        { seconds: 1.5, speech: true },
        { seconds: 3, speech: false },
        { seconds: 1.5, speech: true },
      ]),
      SAMPLE_RATE,
    );
    expect(segments).toHaveLength(2);
  });

  it('ne coupe pas sur une simple respiration', () => {
    // 300 ms de silence : c'est une reprise de souffle, pas une frontière.
    const segments = detectSpeechSegments(
      build([
        { seconds: 1.5, speech: true },
        { seconds: 0.3, speech: false },
        { seconds: 1.5, speech: true },
      ]),
      SAMPLE_RATE,
    );
    expect(segments).toHaveLength(1);
  });

  it('ignore un bruit trop bref pour être de la parole', () => {
    const segments = detectSpeechSegments(
      build([
        { seconds: 2, speech: false },
        { seconds: 0.08, speech: true },
        { seconds: 2, speech: false },
      ]),
      SAMPLE_RATE,
    );
    expect(segments).toHaveLength(0);
  });

  it('ne rend rien sur un enregistrement entièrement muet', () => {
    // C'est le cas qui compte : rien n'est envoyé, donc rien n'est halluciné.
    expect(detectSpeechSegments(build([{ seconds: 5, speech: false }]), SAMPLE_RATE)).toEqual([]);
  });

  it('entend une voix faible — le seuil est relatif, pas absolu', () => {
    // Une aïeule qui parle doucement dans une cuisine ne doit pas être
    // déclarée muette par un seuil calibré sur un studio.
    const segments = detectSpeechSegments(
      build([
        { seconds: 1, speech: false },
        { seconds: 2, speech: true, amplitude: 0.02 },
        { seconds: 1, speech: false },
      ]),
      SAMPLE_RATE,
    );
    expect(segments).toHaveLength(1);
  });

  it('ne plante pas sur une entrée vide', () => {
    expect(detectSpeechSegments(new Float32Array(0), SAMPLE_RATE)).toEqual([]);
    expect(detectSpeechSegments(build([{ seconds: 1, speech: true }]), 0)).toEqual([]);
  });
});

describe('Découpe en morceaux', () => {
  const segments = [
    { start: 0, end: 10 },
    { start: 12, end: 20 },
    { start: 30, end: 38 },
  ];

  it('regroupe tant que la limite le permet', () => {
    const chunks = planChunks(segments, 25);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.segments).toHaveLength(2);
  });

  it('ne coupe jamais au milieu d’un passage parlé', () => {
    // Un passage de 40 s dépasse la limite de 25 s : on le laisse entier.
    // Une coupe en pleine phrase produirait deux moitiés de mot que le
    // modèle compléterait — c'est-à-dire inventerait.
    const chunks = planChunks([{ start: 0, end: 40 }], 25);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.end - chunks[0]!.start).toBe(40);
  });

  it('rend une liste vide sur une entrée vide', () => {
    expect(planChunks([], 25)).toEqual([]);
  });

  it('permet une durée illimitée en multipliant les morceaux, pas leur taille', () => {
    // Une heure de parole hachée : autant de morceaux qu'il faut, chacun borné.
    const longue = Array.from({ length: 200 }, (_, i) => ({ start: i * 18, end: i * 18 + 15 }));
    const chunks = planChunks(longue, 25);
    expect(chunks.length).toBeGreaterThan(100);
    for (const chunk of chunks) expect(chunk.end - chunk.start).toBeLessThanOrEqual(40);
  });
});

describe('Ce qui est envoyé au modèle', () => {
  it('ne transmet que la parole — le silence est retiré', () => {
    const samples = build([
      { seconds: 2, speech: false },
      { seconds: 2, speech: true },
      { seconds: 4, speech: false },
    ]);

    const segments = detectSpeechSegments(samples, SAMPLE_RATE);
    const kept = sliceSamples(samples, SAMPLE_RATE, segments);

    // 8 secondes enregistrées, environ 2,5 transmises.
    expect(kept.length).toBeLessThan(samples.length * 0.45);
    expect(kept.length).toBeGreaterThan(0);
  });

  it('mesure la part réellement parlée', () => {
    const ratio = speechRatio([{ start: 0, end: 3 }], 10);
    expect(ratio).toBeCloseTo(0.3, 2);
    expect(speechRatio([], 10)).toBe(0);
    expect(speechRatio([{ start: 0, end: 20 }], 10)).toBe(1);
  });
});

describe('Réglages par défaut', () => {
  it('tolère les pauses d’un récit parlé lentement', () => {
    // Une personne âgée marque des silences longs. Couper à 200 ms
    // fragmenterait chaque phrase.
    expect(DEFAULT_VAD.minSilenceMs).toBeGreaterThanOrEqual(500);
    expect(DEFAULT_VAD.paddingMs).toBeGreaterThanOrEqual(150);
  });
});
