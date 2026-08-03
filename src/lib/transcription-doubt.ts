/**
 * DÉTECTION DU DOUTE — le garde-fou de la transcription.
 *
 * Whisper est génératif : sur un silence, une respiration ou une hésitation,
 * il ne rend pas du vide, il rend la suite la plus probable. Il invente donc,
 * et il le fait davantage sur les voix âgées et hésitantes — exactement le
 * profil de ceux pour qui cette fonction existe.
 *
 * Rien ici ne prétend garantir l'exactitude : c'est impossible avec un modèle
 * génératif. Ce module fait la seule chose honnête possible — DIRE OÙ IL FAUT
 * REGARDER. La vérification reste humaine, comme la §3.4 l'exigeait déjà
 * (« transcrire audio → vérifié par : l'utilisateur écoute et corrige »).
 *
 * Deux sources de doute :
 *  1. Les indicateurs que le modèle produit sur lui-même, avec les seuils de
 *     l'implémentation de référence de Whisper.
 *  2. Les artefacts connus — des phrases issues des sous-titres de vidéos
 *     présents dans ses données d'entraînement, qu'il recrache sur le silence.
 */

/**
 * Seuils de l'implémentation de référence de Whisper. Ce ne sont pas des
 * valeurs choisies au jugé : ce sont celles que le décodeur utilise lui-même
 * pour considérer qu'une passe a échoué.
 */
export const DOUBT_THRESHOLDS = {
  /** Log-probabilité moyenne : en dessous, le modèle n'était pas sûr de lui. */
  avgLogprob: -1.0,
  /** Ratio de compression : au-dessus, le texte boucle (répétitions). */
  compressionRatio: 2.4,
  /** Probabilité d'absence de parole : au-dessus, il n'y avait sans doute rien à entendre. */
  noSpeechProb: 0.6,
} as const;

/**
 * Artefacts de sous-titrage. Whisper a été entraîné sur des vidéos
 * sous-titrées ; sur un passage sans parole, il restitue les mentions de
 * fin de ces sous-titres. Ces phrases n'ont jamais été prononcées.
 */
const KNOWN_ARTIFACTS: RegExp[] = [
  /sous-titr(es|age)\s+(réalisés?|par|:)/i,
  /amara\.org/i,
  /soustitreur\.com/i,
  /merci d'avoir regardé (cette vidéo|la vidéo)/i,
  /merci de (votre écoute|regarder)/i,
  /abonnez-vous/i,
  /n'oubliez pas de vous abonner/i,
  /like et abonne/i,
  /à la prochaine ?!?$/i,
  /^(sous-titres|traduction)\s*:/i,
  /\bSCP-\d+/i, // artefact récurrent signalé sur les modèles Whisper
];

export interface RawSegment {
  start: number;
  end: number;
  text: string;
  avgLogprob?: number | null;
  compressionRatio?: number | null;
  noSpeechProb?: number | null;
}

export type DoubtReason =
  | 'ARTEFACT_CONNU'
  | 'CONFIANCE_FAIBLE'
  | 'REPETITION'
  | 'SILENCE_PROBABLE'
  | 'REPETITION_VOISINE';

export interface ReviewedSegment {
  start: number;
  end: number;
  text: string;
  /** true si un humain doit regarder ce passage en priorité. */
  suspect: boolean;
  reasons: DoubtReason[];
  /** true si le segment est très probablement une invention pure. */
  artifact: boolean;
}

export const DOUBT_LABELS: Record<DoubtReason, string> = {
  ARTEFACT_CONNU: 'Phrase que le modèle produit sur les silences — jamais prononcée',
  CONFIANCE_FAIBLE: 'Le modèle était peu sûr de lui sur ce passage',
  REPETITION: 'Texte anormalement répétitif — le modèle a pu boucler',
  SILENCE_PROBABLE: 'Le modèle estime qu’il n’y avait probablement pas de parole ici',
  REPETITION_VOISINE: 'Identique au segment précédent',
};

/**
 * Les apostrophes typographiques ne doivent pas suffire à passer sous le
 * filtre : « Merci d'avoir » et « Merci d’avoir » sont la même invention.
 * Un modèle de transcription produit presque toujours la forme typographique.
 */
function canonical(text: string): string {
  return text.replace(/[’‘‛`´]/g, "'").replace(/\s+/g, ' ').trim();
}

export function isKnownArtifact(text: string): boolean {
  const value = canonical(text);
  if (!value) return false;
  return KNOWN_ARTIFACTS.some((pattern) => pattern.test(value));
}

/**
 * Marque les segments douteux. Ne supprime rien de ce qui pourrait être de
 * la parole : dans le doute, on signale et on laisse l'humain trancher.
 * Seuls les artefacts connus sont désignés comme inventions certaines.
 */
export function reviewSegments(segments: RawSegment[]): ReviewedSegment[] {
  return segments.map((segment, index) => {
    const reasons: DoubtReason[] = [];
    const text = segment.text.trim();

    const artifact = isKnownArtifact(text);
    if (artifact) reasons.push('ARTEFACT_CONNU');

    if (segment.avgLogprob != null && segment.avgLogprob < DOUBT_THRESHOLDS.avgLogprob) {
      reasons.push('CONFIANCE_FAIBLE');
    }
    if (
      segment.compressionRatio != null &&
      segment.compressionRatio > DOUBT_THRESHOLDS.compressionRatio
    ) {
      reasons.push('REPETITION');
    }
    if (segment.noSpeechProb != null && segment.noSpeechProb > DOUBT_THRESHOLDS.noSpeechProb) {
      reasons.push('SILENCE_PROBABLE');
    }

    // Une phrase identique à la précédente est le signe le plus visible
    // d'une boucle de décodage.
    const previous = segments[index - 1]?.text.trim();
    if (previous && previous === text && text.length > 0) reasons.push('REPETITION_VOISINE');

    return { start: segment.start, end: segment.end, text, suspect: reasons.length > 0, reasons, artifact };
  });
}

/**
 * Le texte proposé à la famille. Les artefacts certains sont retirés — les
 * laisser reviendrait à demander à quelqu'un de supprimer à la main une
 * phrase qui n'a jamais été dite. Tout le reste est conservé, y compris ce
 * qui est douteux : c'est à l'humain d'écouter, pas à nous de décider.
 */
export function draftTextFrom(segments: ReviewedSegment[]): string {
  return segments
    .filter((segment) => !segment.artifact)
    .map((segment) => segment.text)
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function countSuspect(segments: ReviewedSegment[]): number {
  return segments.filter((segment) => segment.suspect).length;
}

/** mm:ss, pour se repérer dans l'enregistrement. */
export function formatTimecode(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
