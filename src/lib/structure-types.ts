/**
 * Grammaire narrative — annexe B de la spec.
 * La structure est imposée par le système. Le LLM classe dans cette liste,
 * il n'en invente jamais un type.
 */
export const STRUCTURE_TYPES = [
  'objet-emotionnel',
  'tradition-origine',
  'lieu-sensoriel',
  'trait-caractere',
  'evenement-marquant',
  'recette-familiale',
  'voyage-souvenir',
  'rencontre-decisive',
  'secret-revele',
  'echec-apprentissage',
  'rituel-quotidien',
  'heritage-symbole',
  'dispute-reconciliation',
  'deuil-memoire',
  'naissance-naissance',
  'metier-savoir',
  'migration-racine',
  'passion-transmise',
  'peur-surmontee',
  'croyance-familiale',
  'objet-perdu-retrouve',
  'chanson-danse',
  'jeu-enfance',
  'maison-demenagement',
  'animal-familier',
  'ecole-apprentissage',
  'guerre-paix',
  'fete-tradition',
  'amour-rencontre',
  'argent-pauvrete',
  'sante-maladie',
  'reve-non-accompli',
  'lettre-non-envoyee',
] as const;

export type StructureType = (typeof STRUCTURE_TYPES)[number];

export const DEFAULT_STRUCTURE_TYPE: StructureType = 'evenement-marquant';

export function isStructureType(value: string): value is StructureType {
  return (STRUCTURE_TYPES as readonly string[]).includes(value);
}

export const TONES = ['intime', 'factuel', 'epique'] as const;
export type Tone = (typeof TONES)[number];

export const LENGTHS = ['micro', 'standard', 'long'] as const;
export type Length = (typeof LENGTHS)[number];

export const LENGTH_LIMITS: Record<Length, number> = {
  micro: 300,
  standard: 1500,
  long: 5000,
};

export const MAX_CONTENT_LENGTH = LENGTH_LIMITS.long;

/** La longueur n'est pas déclarative : elle se déduit du texte. */
export function lengthFromContent(content: string): Length {
  if (content.length < LENGTH_LIMITS.micro) return 'micro';
  if (content.length < LENGTH_LIMITS.standard) return 'standard';
  return 'long';
}

export const ENTITY_TYPES = ['PERSON', 'PLACE', 'OBJECT', 'DATE', 'CONCEPT'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const ARCHIVE_TYPES = ['PHOTO', 'DOCUMENT', 'AUDIO', 'VIDEO'] as const;

// 'veillee' : extension hors spec v1.0 — un récit né pendant une veillée
// familiale. Distinct de 'tradition', qui désigne un rituel daté.
export const TRIGGER_TYPES = [
  'question',
  'tradition',
  'temporal',
  'passeur',
  'manual',
  'veillee',
] as const;
export type PassageTriggerType = (typeof TRIGGER_TYPES)[number];

export const VISIBILITY_CONTEXTS = [
  'home',
  'passeur',
  'search',
  'tradition',
  'graph',
  'veillee',
] as const;
export type VisibilityContext = (typeof VISIBILITY_CONTEXTS)[number];
