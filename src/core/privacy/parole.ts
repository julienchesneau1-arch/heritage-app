/**
 * « PASSE EN MODE PRIVÉ » — la phrase qui atteint `docs/03 §7`.
 *
 * ADR-106.
 *
 * ⚠ SEULE L'ACTIVATION EST UNE PHRASE
 * ---------------------------------------------------------------------------
 * La dissymétrie d'`halt.ts`, reprise telle quelle :
 *
 * ```text
 * ACTIVER      sens sûr       → une phrase, depuis n'importe quelle surface
 * DÉSACTIVER   sens dangereux → une commande, sur la machine, avec une note
 * ```
 *
 * Reconnaître « sors du mode privé » comme on reconnaît « passe en mode
 * privé » les rendrait aussi faciles l'une que l'autre. Quelqu'un qui
 * détiendrait le jeton du téléphone pourrait alors **rouvrir le réseau à
 * distance**, puis faire sortir ce qu'il veut — et l'utilisateur ne verrait
 * qu'un indicateur éteint, ce qu'il lit comme « normal ».
 *
 * ⚠ ET LA GARDE EST CELLE DES DEUX AUTRES : PAS DE COMPLÉMENT INATTENDU
 * ---------------------------------------------------------------------------
 * ```text
 * mode privé · passe en mode privé · coupe le réseau   → ACTIVATION
 * note que je préfère le mode privé                     → memory_add
 * ```
 *
 * En cas de doute, ici, **on active** : se tromper coûte une égression refusée
 * qui se répare en une commande. L'erreur inverse coûte une donnée sortie.
 */

/** Accents, apostrophes typographiques et ponctuation terminale enlevés. */
function aplati(texte: string): string {
  return texte
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/gu, '')
    .replace(/['’]/gu, "'")
    .replace(/[.!?;,\s]+$/u, '')
    .trim()
    .replace(/\s+/gu, ' ');
}

const FORMES: readonly RegExp[] = [
  /* « mode privé », « passe en mode privé », « active le mode privé ». */
  /^(?:passe (?:en|au) |active (?:le )?|mets?-? ?toi en )?mode prive$/u,
  /* Ce que les gens disent quand ils veulent la même chose. */
  /^coupe (?:le )?(?:reseau|internet|le cloud)$/u,
  /^ne sors rien(?: de la machine)?$/u,
];

/** Cette phrase demande-t-elle le passage en mode privé ? */
export function estUnPassageEnModePrive(texte: string): boolean {
  const nu = aplati(texte);
  return FORMES.some((forme) => forme.test(nu));
}
