/**
 * Moteurs de transcription locale.
 *
 * Tournent dans le navigateur : coût marginal nul, durée sans incidence,
 * et la voix ne quitte pas l'appareil.
 *
 * Deux tailles proposées. La grande est plus juste mais plus lente et plus
 * lourde à télécharger. Le choix appartient à la famille : sur la tablette
 * d'une grand-mère, un modèle qui met dix minutes n'est pas un meilleur
 * modèle, c'est un modèle inutilisable.
 */
export const LOCAL_MODELS = {
  rapide: {
    id: 'onnx-community/whisper-base',
    label: 'Rapide',
    note: 'Environ 80 Mo à télécharger une fois. Convient à un enregistrement court et net.',
  },
  precis: {
    id: 'onnx-community/whisper-small',
    label: 'Plus précis',
    note: 'Environ 250 Mo à télécharger une fois. Plus lent, plus fidèle aux voix hésitantes.',
  },
} as const;

export type LocalModelKey = keyof typeof LOCAL_MODELS;

export function isLocalModelKey(value: string): value is LocalModelKey {
  return value in LOCAL_MODELS;
}

/** Whisper attend du 16 kHz mono. */
export const TARGET_SAMPLE_RATE = 16_000;
