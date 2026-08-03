/**
 * Questions en un geste.
 *
 * Le plus jeune membre de la famille Martin a sept ans. Il ne rédigera pas
 * une question dans un champ de texte — donc, en l'état, il ne participe
 * pas. Or l'enfant qui demande « pourquoi ? » est, dans une famille réelle,
 * le premier moteur de transmission. Le produit ne peut pas se permettre de
 * l'exclure pour une raison de clavier.
 *
 * Ce ne sont pas des suggestions au sens du §6.1 : rien ici n'est
 * recommandé, classé, ni poussé. C'est une autre façon de saisir la même
 * chose que le champ libre, pour ceux qui n'écrivent pas — les enfants, et
 * tous ceux que la page blanche arrête.
 *
 * Contraintes de rédaction : factuelles, ouvertes, sans présupposé sur ce
 * que ressent qui que ce soit. Un test vérifie qu'elles franchissent le
 * filtre constitutionnel.
 */
export const ONE_TAP_QUESTIONS = [
  'Qui est-ce ?',
  'C’était quand ?',
  'C’était où ?',
  'Et après, qu’est-ce qui s’est passé ?',
] as const;

export type OneTapQuestion = (typeof ONE_TAP_QUESTIONS)[number];

export function isOneTapQuestion(value: string): value is OneTapQuestion {
  return (ONE_TAP_QUESTIONS as readonly string[]).includes(value);
}
