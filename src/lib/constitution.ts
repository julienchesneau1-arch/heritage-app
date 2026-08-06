/**
 * Constitution de la Mémoire — implémentation technique (§8.1).
 *
 * Amendement 4 : le produit ne déduit jamais une émotion à partir d'une donnée.
 * Ce filtre s'applique à TOUTE sortie LLM, sans exception. Il ne corrige pas :
 * il rejette. Une sortie rejetée devient un fallback, ou rien.
 */

const EMOTION_INFERENCE_PATTERNS: RegExp[] = [
  /vous semblez/i,
  /tu sembles/i,
  /vous devez être/i,
  /tu dois être/i,
  /vous avez l'air/i,
  /tu as l'air/i,
  /vous êtes (triste|heureux|heureuse|énervé|énervée|fatigué|fatiguée|en colère|nostalgique)/i,
  /tu es (triste|heureux|heureuse|énervé|énervée|fatigué|fatiguée|en colère|nostalgique)/i,
  /ça vous manque/i,
  /ça te manque/i,
  /vous regrettez/i,
  /tu regrettes/i,
  /vous ressentez/i,
  /tu ressens/i,
  /(cela|ça) a dû être (dur|difficile|douloureux|éprouvant)/i,
  /on sent (que|bien)/i,
  /(cette|votre|ta) (tristesse|douleur|joie|nostalgie|colère)/i,
];

/**
 * Les apostrophes typographiques et les espaces multiples ne doivent pas
 * suffire à passer sous le filtre : « tu as l’air » et « tu as l'air »
 * sont la même phrase.
 */
function canonical(text: string): string {
  return text.replace(/[’‘‛`´]/g, "'").replace(/\s+/g, ' ');
}

/** true si le texte est constitutionnellement acceptable. */
export function constitutionEmotionFilter(text: string): boolean {
  const value = canonical(text);
  return !EMOTION_INFERENCE_PATTERNS.some((pattern) => pattern.test(value));
}

/** Le motif fautif, pour le log d'audit. Null si le texte passe. */
export function emotionViolation(text: string): string | null {
  const value = canonical(text);
  const hit = EMOTION_INFERENCE_PATTERNS.find((pattern) => pattern.test(value));
  return hit ? hit.source : null;
}

/**
 * §6.2 — langage produit.
 * Ni chantage émotionnel ("vous n'avez pas lu"), ni guilt-tripping
 * ("il y a longtemps que..."). Vérifié par test sur les chaînes d'UI.
 */
const GUILT_PATTERNS: RegExp[] = [
  /vous n'avez pas (lu|ouvert|regardé|répondu)/i,
  /tu n'as pas (lu|ouvert|regardé|répondu)/i,
  /il y a longtemps que/i,
  /cela fait (longtemps|des mois|des années) que vous/i,
  /n'oubliez pas de/i,
  // Vise l'injonction « pensez à raconter ceci ». Attrape aussi, par
  // construction, des tournures innocentes : « quand vous pensez à votre
  // enfance ». C'est assumé — ce filtre a le droit d'être trop large, il
  // n'a pas le droit d'être trop étroit. Quand il refuse une phrase juste,
  // on reformule la phrase ; on n'assouplit pas le motif. Un cas réel :
  // une question de l'entretien, réécrite en « qui vous revient, de votre
  // enfance ».
  /pensez à/i,
];

export function isNonCoerciveLanguage(text: string): boolean {
  const value = canonical(text);
  return !GUILT_PATTERNS.some((pattern) => pattern.test(value));
}
