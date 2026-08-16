/**
 * Formulation des réponses de Jarvis.
 *
 * Référence : `06 §Style des réponses`, `00 §I4`, PRD §84.
 *
 * Deux exigences qui se combinent mal si on ne les traite pas ensemble :
 *
 *   CONCISION  — « C'est fait. », pas « J'ai bien pris en compte votre
 *                demande et procédé à… »
 *   HONNÊTETÉ  — « C'est fait » n'est autorisé que sur `CONFIRMED`.
 *
 * Ce module est le seul endroit qui traduit un statut en phrase. Isoler cette
 * traduction évite qu'un `PROBABLE` devienne « c'est fait » quelque part par
 * commodité de rédaction.
 */
import type { VerificationStatus } from '../../core/types/domain.js';

export interface Reportable {
  readonly status: VerificationStatus;
  readonly detail: string;
}

/**
 * Phrase d'annonce d'un résultat d'action.
 *
 * Volontairement laconique sur le succès, explicite sur tout le reste :
 * l'incertitude mérite plus de mots que la réussite.
 */
export function announce(result: Reportable): string {
  switch (result.status) {
    case 'CONFIRMED':
      return 'C\'est fait.';

    case 'PROBABLE':
      return (
        'Probablement fait — je n\'ai pas pu le vérifier indépendamment.\n' +
        `  ${result.detail}`
      );

    case 'UNKNOWN':
      return (
        'Je ne sais pas si ça a abouti.\n' +
        `  ${result.detail}`
      );

    case 'PARTIAL':
      return (
        'Partiellement fait — le détail par destinataire compte plus que ce ' +
        'résumé.\n' +
        `  ${result.detail}`
      );

    case 'NOT_ATTEMPTED':
      return `Je n'ai rien tenté.\n  ${result.detail}`;

    case 'FAILED':
      // Le mot est fort, et il ne s'emploie que sur PREUVE d'absence d'effet
      // (ADR-030). Un timeout ou un 500 ne l'autorisent pas.
      return `Ça n'a pas marché.\n  ${result.detail}`;

    case 'PROVIDER_CONTRACT_VIOLATION':
      /* La formulation la plus difficile du fichier, et elle doit dire DEUX
         choses sans en mélanger aucune : je ne sais pas ce qui s'est passé,
         ET le service a fait autre chose que ce qu'il annonçait. Ne dire que
         la première perdrait l'information la plus importante ; ne dire que
         la seconde laisserait croire que l'action a échoué. */
      return (
        "Je ne sais pas ce qui s'est passé, et le service ne s'est pas " +
        "comporté comme il l'annonce.\n" +
        `  ${result.detail}\n` +
        "  Je n'engagerai plus rien par ce service tant que ce n'est pas levé."
      );
  }
}

/** Préfixe visuel, pour repérer un statut d'un coup d'œil dans le terminal. */
export function mark(status: VerificationStatus): string {
  switch (status) {
    case 'CONFIRMED':
      return '✓';
    case 'PROBABLE':
      return '~';
    case 'UNKNOWN':
      return '?';
    case 'PARTIAL':
      return '±';
    case 'NOT_ATTEMPTED':
      return '·';
    case 'FAILED':
      return '✗';
    // Distinct de tous les autres : le problème n'est pas l'action, c'est
    // celui qui la rapporte.
    case 'PROVIDER_CONTRACT_VIOLATION':
      return '⚠';
  }
}

/**
 * Question de confirmation.
 *
 * Porte sur les VALEURS concrètes, jamais sur l'intention résumée : c'est ce
 * qui rend la confirmation utile face à une injection (03 §3).
 */
export function confirmationPrompt(
  reason: string,
  values: Readonly<Record<string, string | number | boolean>>,
): string {
  const lines = [reason];
  const concrete = Object.entries(values).filter(
    ([key]) => key !== 'tool' && key !== 'autonomy',
  );

  if (concrete.length > 0) {
    lines.push('');
    for (const [key, value] of concrete) {
      lines.push(`  ${key} : ${String(value)}`);
    }
  }
  lines.push('');
  lines.push('Confirmer ? (oui / non)');
  return lines.join('\n');
}

/** Une réponse vaut-elle confirmation ? Le doute n'en est pas une (PRD §135). */
export function isAffirmative(answer: string): boolean {
  return /^(o|oui|ok|d'accord|daccord|vas-y|confirme|y|yes)$/iu.test(
    answer.trim(),
  );
}

export function isNegative(answer: string): boolean {
  return /^(n|non|annule|stop|no)$/iu.test(answer.trim());
}
