/**
 * DÉCOUPE SUR LES SILENCES.
 *
 * Deux problèmes réglés d'un coup :
 *
 * 1. LA PREMIÈRE CAUSE D'HALLUCINATION. Whisper invente sur le vide : privé
 *    de signal, il rend la suite statistiquement probable — d'où les
 *    « Sous-titres réalisés par… » sur un blanc. Ne pas lui donner de vide,
 *    c'est supprimer l'occasion. C'est la mitigation la plus efficace qui
 *    existe, et la seule qui agisse en amont plutôt qu'après coup.
 *
 * 2. LA DURÉE. Un enregistrement d'une heure ne tient ni dans la limite de
 *    l'API ni dans la mémoire d'un téléphone. Découpé sur les silences, il
 *    devient une suite de morceaux traités l'un après l'autre : la durée
 *    cesse d'être une contrainte, donc un coût.
 *
 * Le découpage ne coupe JAMAIS au milieu d'une phrase : les frontières sont
 * choisies dans les silences. Une coupe en pleine parole produirait deux
 * moitiés de mot que le modèle compléterait — c'est-à-dire inventerait.
 *
 * Tout ici est du calcul pur sur des échantillons : testable sans navigateur,
 * sans réseau et sans modèle.
 */

export interface SpeechSegment {
  /** Secondes depuis le début de l'enregistrement. */
  start: number;
  end: number;
}

export interface ChunkPlan {
  start: number;
  end: number;
  /** Segments de parole contenus, pour recaler les horodatages ensuite. */
  segments: SpeechSegment[];
}

export interface VadOptions {
  /**
   * Seuil d'énergie sous lequel on considère qu'il n'y a pas de parole.
   * Relatif au niveau de l'enregistrement, jamais absolu : la voix d'une
   * personne âgée dans une cuisine n'a pas le niveau d'un studio.
   */
  silenceRatio: number;
  /** Fenêtre d'analyse. 20 ms est la granularité usuelle en traitement de parole. */
  frameMs: number;
  /** Un silence plus court que cela est une respiration, pas une frontière. */
  minSilenceMs: number;
  /** Un éclat plus court que cela est un bruit, pas de la parole. */
  minSpeechMs: number;
  /** Marge conservée autour de la parole, pour ne pas manger les attaques. */
  paddingMs: number;
}

export const DEFAULT_VAD: VadOptions = {
  silenceRatio: 0.06,
  frameMs: 20,
  minSilenceMs: 700,
  minSpeechMs: 250,
  paddingMs: 250,
};

/** Énergie efficace (RMS) par fenêtre. */
export function frameEnergies(samples: Float32Array, sampleRate: number, frameMs: number): number[] {
  const frameSize = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  const energies: number[] = [];

  for (let offset = 0; offset < samples.length; offset += frameSize) {
    let sum = 0;
    const end = Math.min(offset + frameSize, samples.length);
    for (let i = offset; i < end; i += 1) sum += samples[i]! * samples[i]!;
    energies.push(Math.sqrt(sum / Math.max(1, end - offset)));
  }

  return energies;
}

/**
 * Détecte les passages parlés.
 *
 * Le seuil est relatif au niveau réel de l'enregistrement : on prend une
 * fraction du percentile haut des énergies. Un seuil absolu déclarerait
 * muette une aïeule qui parle doucement, et bavard un micro qui souffle.
 */
export function detectSpeechSegments(
  samples: Float32Array,
  sampleRate: number,
  options: Partial<VadOptions> = {},
): SpeechSegment[] {
  const config = { ...DEFAULT_VAD, ...options };
  if (samples.length === 0 || sampleRate <= 0) return [];

  const energies = frameEnergies(samples, sampleRate, config.frameMs);
  if (energies.length === 0) return [];

  const reference = percentile(energies, 0.95);
  if (reference <= 0) return []; // silence intégral
  const threshold = reference * config.silenceRatio;

  const frameSeconds = config.frameMs / 1000;
  const minSilenceFrames = Math.ceil(config.minSilenceMs / config.frameMs);

  // Passage 1 : fenêtres au-dessus du seuil, silences courts recollés.
  const raw: SpeechSegment[] = [];
  let start: number | null = null;
  let silenceRun = 0;

  energies.forEach((energy, index) => {
    if (energy > threshold) {
      if (start === null) start = index;
      silenceRun = 0;
      return;
    }
    if (start === null) return;

    silenceRun += 1;
    if (silenceRun >= minSilenceFrames) {
      raw.push({ start: start * frameSeconds, end: (index - silenceRun + 1) * frameSeconds });
      start = null;
      silenceRun = 0;
    }
  });

  if (start !== null) {
    raw.push({ start: start * frameSeconds, end: energies.length * frameSeconds });
  }

  // Passage 2 : on jette les éclats trop brefs, on ajoute la marge.
  const totalSeconds = samples.length / sampleRate;
  const padding = config.paddingMs / 1000;

  return raw
    .filter((segment) => segment.end - segment.start >= config.minSpeechMs / 1000)
    .map((segment) => ({
      start: Math.max(0, segment.start - padding),
      end: Math.min(totalSeconds, segment.end + padding),
    }));
}

/**
 * Regroupe les passages parlés en morceaux d'au plus `maxChunkSeconds`.
 *
 * Un passage plus long que la limite n'est pas coupé en deux : mieux vaut un
 * morceau trop long qu'une phrase tranchée. C'est le seul cas où la borne
 * est dépassée, et c'est délibéré.
 */
export function planChunks(segments: SpeechSegment[], maxChunkSeconds = 25): ChunkPlan[] {
  const chunks: ChunkPlan[] = [];
  let current: ChunkPlan | null = null;

  for (const segment of segments) {
    if (current && segment.end - current.start <= maxChunkSeconds) {
      current.end = segment.end;
      current.segments.push(segment);
      continue;
    }
    if (current) chunks.push(current);
    current = { start: segment.start, end: segment.end, segments: [segment] };
  }

  if (current) chunks.push(current);
  return chunks;
}

/** Part de l'enregistrement réellement parlée. Ce qui n'est pas là ne sera pas halluciné. */
export function speechRatio(segments: SpeechSegment[], totalSeconds: number): number {
  if (totalSeconds <= 0) return 0;
  const spoken = segments.reduce((sum, segment) => sum + (segment.end - segment.start), 0);
  return Math.min(1, spoken / totalSeconds);
}

/** Extrait les échantillons d'un morceau. Le silence n'est jamais transmis au modèle. */
export function sliceSamples(
  samples: Float32Array,
  sampleRate: number,
  segments: SpeechSegment[],
): Float32Array {
  const total = segments.reduce(
    (sum, segment) => sum + Math.round((segment.end - segment.start) * sampleRate),
    0,
  );
  const output = new Float32Array(total);

  let cursor = 0;
  for (const segment of segments) {
    const from = Math.max(0, Math.floor(segment.start * sampleRate));
    const to = Math.min(samples.length, Math.ceil(segment.end * sampleRate));
    for (let i = from; i < to && cursor < total; i += 1, cursor += 1) output[cursor] = samples[i]!;
  }

  return output.subarray(0, cursor);
}

function percentile(values: number[], ratio: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * ratio)));
  return sorted[index] ?? 0;
}
