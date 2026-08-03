/**
 * CONSENSUS — le seul levier de précision qui vaille vraiment.
 *
 * Aucun modèle ne garantit l'exactitude. Mais deux modèles indépendants
 * n'inventent pratiquement jamais la MÊME chose : une hallucination est le
 * produit d'un chemin de décodage particulier, pas d'une propriété du son.
 *
 * Il en découle une règle beaucoup plus forte que n'importe quel indicateur
 * de confiance :
 *
 *   - Là où deux transcriptions coïncident mot pour mot, le texte est
 *     très probablement ce qui a été dit.
 *   - Là où elles divergent, il faut écouter. Sans exception.
 *
 * C'est ce qui transforme la relecture. Au lieu de demander à quelqu'un de
 * vérifier trois minutes de texte, on lui demande de vérifier les quatre
 * endroits où les modèles ne sont pas d'accord.
 *
 * Le second avis peut être un autre modèle local (une taille différente),
 * une seconde passe, ou l'API. Ce module ne s'occupe que de la comparaison :
 * calcul pur, testable sans réseau.
 */

export type AgreementKind = 'agreed' | 'divergent' | 'only-a' | 'only-b';

export interface ConsensusToken {
  kind: AgreementKind;
  /** Texte de la version A, quand elle en a un. */
  a?: string;
  /** Texte de la version B, quand elle en a un. */
  b?: string;
}

export interface ConsensusResult {
  tokens: ConsensusToken[];
  /** Part de mots sur lesquels les deux versions coïncident. 0-1. */
  agreementRate: number;
  /** Nombre de zones à écouter — c'est le chiffre qui compte pour la relecture. */
  divergenceCount: number;
  /** Texte retenu par défaut : la version A, seule référence assumée. */
  text: string;
}

/**
 * Découpe en mots comparables. La ponctuation et la casse ne sont pas des
 * désaccords : « vélos. » et « vélos » disent la même chose, et signaler
 * cela noierait les vrais écarts.
 */
export function tokenize(text: string): string[] {
  return text
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean);
}

export function normalizeToken(token: string): string {
  return token
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Alignement par plus longue sous-séquence commune.
 *
 * L'alignement mot à mot naïf déraille dès qu'un modèle ajoute ou omet un
 * mot : tout ce qui suit apparaîtrait comme divergent. La LCS recale les
 * deux versions et isole les vraies zones de désaccord.
 */
export function compareTranscriptions(a: string, b: string): ConsensusResult {
  const wordsA = tokenize(a);
  const wordsB = tokenize(b);

  const normA = wordsA.map(normalizeToken);
  const normB = wordsB.map(normalizeToken);

  // Table de LCS. Les enregistrements familiaux sont courts ; le coût
  // quadratique est sans conséquence, et on borne par sécurité.
  const LIMIT = 4000;
  if (wordsA.length > LIMIT || wordsB.length > LIMIT) {
    return {
      tokens: [{ kind: 'only-a', a: a.trim() }],
      agreementRate: 0,
      divergenceCount: 1,
      text: a.trim(),
    };
  }

  const table: number[][] = Array.from({ length: normA.length + 1 }, () =>
    new Array<number>(normB.length + 1).fill(0),
  );

  for (let i = normA.length - 1; i >= 0; i -= 1) {
    for (let j = normB.length - 1; j >= 0; j -= 1) {
      table[i]![j] =
        normA[i] === normB[j] && normA[i] !== ''
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }

  const tokens: ConsensusToken[] = [];
  let i = 0;
  let j = 0;
  let agreed = 0;

  while (i < normA.length && j < normB.length) {
    if (normA[i] === normB[j] && normA[i] !== '') {
      push(tokens, { kind: 'agreed', a: wordsA[i], b: wordsB[j] });
      agreed += 1;
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      push(tokens, { kind: 'only-a', a: wordsA[i] });
      i += 1;
    } else {
      push(tokens, { kind: 'only-b', b: wordsB[j] });
      j += 1;
    }
  }

  while (i < normA.length) push(tokens, { kind: 'only-a', a: wordsA[i++] });
  while (j < normB.length) push(tokens, { kind: 'only-b', b: wordsB[j++] });

  const merged = coalesceNearbyDivergences(mergeDivergences(tokens));
  const total = Math.max(wordsA.length, wordsB.length);

  return {
    tokens: merged,
    agreementRate: total === 0 ? 1 : agreed / total,
    divergenceCount: merged.filter((token) => token.kind !== 'agreed').length,
    text: a.trim(),
  };
}

/**
 * Regroupe les mots contigus en blocs, et fond un « seulement A » suivi d'un
 * « seulement B » en une divergence unique : c'est une substitution, pas
 * deux anomalies séparées.
 */
function mergeDivergences(tokens: ConsensusToken[]): ConsensusToken[] {
  const merged: ConsensusToken[] = [];

  for (const token of tokens) {
    const last = merged[merged.length - 1];

    if (last && last.kind === 'only-a' && token.kind === 'only-b') {
      merged[merged.length - 1] = { kind: 'divergent', a: last.a, b: token.b };
      continue;
    }
    if (last && last.kind === 'divergent' && token.kind === 'only-b') {
      last.b = [last.b, token.b].filter(Boolean).join(' ');
      continue;
    }
    if (last && last.kind === token.kind) {
      last.a = [last.a, token.a].filter(Boolean).join(' ') || undefined;
      last.b = [last.b, token.b].filter(Boolean).join(' ') || undefined;
      continue;
    }
    merged.push({ ...token });
  }

  return merged;
}

/**
 * Fusionne deux divergences séparées par un îlot d'accord trop court.
 *
 * « quatre heures douze » contre « seize heures trente » aligne « heures »
 * comme commun et produit deux divergences. C'est exact du point de vue de
 * l'algorithme, et inutile du point de vue de celui qui réécoute : c'est UN
 * passage à vérifier, pas deux. Un mot isolé entre deux désaccords n'est pas
 * un point d'appui, c'est une coïncidence.
 */
const BRIDGE_WORDS = 1;

function coalesceNearbyDivergences(tokens: ConsensusToken[]): ConsensusToken[] {
  const result: ConsensusToken[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const previous = result[result.length - 1];
    const next = tokens[index + 1];

    const isShortIsland =
      token.kind === 'agreed' &&
      previous !== undefined &&
      previous.kind !== 'agreed' &&
      next !== undefined &&
      next.kind !== 'agreed' &&
      wordCount(token.a) <= BRIDGE_WORDS;

    if (isShortIsland) {
      // L'îlot rejoint la divergence précédente, des deux côtés.
      previous.kind = 'divergent';
      previous.a = join(previous.a, token.a);
      previous.b = join(previous.b, token.b ?? token.a);
      continue;
    }

    if (previous && previous.kind === 'divergent' && token.kind !== 'agreed') {
      previous.a = join(previous.a, token.a);
      previous.b = join(previous.b, token.b);
      continue;
    }

    result.push({ ...token });
  }

  return result;
}

function wordCount(value: string | undefined): number {
  return value ? value.trim().split(/\s+/).filter(Boolean).length : 0;
}

function join(...parts: Array<string | undefined>): string | undefined {
  const joined = parts.filter(Boolean).join(' ').trim();
  return joined.length > 0 ? joined : undefined;
}

function push(tokens: ConsensusToken[], token: ConsensusToken) {
  tokens.push(token);
}

/**
 * Résumé destiné à la famille. Il dit combien d'endroits demandent une
 * écoute — jamais que le texte serait « fiable à N % », ce qui serait une
 * promesse que personne ne peut tenir.
 */
export function consensusSummary(result: ConsensusResult): string {
  if (result.divergenceCount === 0) {
    return 'Les deux transcriptions coïncident mot pour mot. Une écoute reste recommandée.';
  }
  return `${result.divergenceCount} endroit${result.divergenceCount > 1 ? 's' : ''} où les deux transcriptions ne disent pas la même chose. Ce sont ceux-là qu’il faut écouter.`;
}
