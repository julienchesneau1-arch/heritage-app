/**
 * LE LIVRE — Annexe A, points 1 et 7.
 *
 *   1. Une histoire doit pouvoir engendrer une autre histoire.
 *   7. Le succès ultime est que la famille continue de transmettre SANS l'app.
 *
 * C'est la seule pièce du produit qui serve les deux à la fois, et c'est
 * pourquoi elle existe. Toutes les autres attirent vers l'intérieur ; un
 * objet de papier fonctionne quand l'application est fermée, et un livre
 * qui montre ses trous donne envie de les combler.
 *
 * ── Ce qui le sépare du livre de mémoire ordinaire ──
 *
 * Le genre tient en quatre traits : chronologique, une voix par récit,
 * d'apparence complète, fini. Les quatre sont abandonnés.
 *
 * 1. **Par filiation, pas par année.** Le produit sait quel récit en a
 *    engendré un autre — c'est sa primitive, et aucun autre livre de
 *    famille ne peut le montrer. On lit « ce récit, et les trois qu'il a
 *    provoqués », pas « 1971, 1972, 1973 ».
 *
 *    L'amendement 5 interdit d'imposer un ordre : il vise le Conservateur,
 *    qui ne peut pas reclasser selon ce qu'il juge intéressant. La
 *    filiation n'est pas un jugement du produit — ce sont les `Passage`
 *    que la famille a créés. À l'intérieur de chaque niveau, l'ordre
 *    redevient chronologique.
 *
 * 2. **Deux noms par récit.** « Raconté par Jeanne Martin, noté par Claire
 *    Martin. » Le livre crédite la voix, pas le clavier (§2.3).
 *
 * 3. **Il dit ce qu'il ne sait pas.** Amendement 6, en papier : les
 *    questions restées sans réponse, les récits sans date, les membres
 *    qu'aucun récit ne mentionne. Tous les livres de famille font semblant
 *    d'être complets ; celui-ci imprime ses manques.
 *
 * 4. **Il n'est pas fini.** Les questions sans réponse sont imprimées avec
 *    la place pour écrire à la main.
 *
 * Et il ne ramène pas : aucun code à scanner, aucune adresse à taper. Le
 * point 7 dit « sans l'app » — un livre qui renvoie vers l'écran est un
 * dépliant publicitaire.
 */

export interface RecitDuLivre {
  id: string;
  titre: string;
  contenu: string;
  createdAt: Date;
  eventDate: Date | null;
  structureType: string;
  auteur: { id: string; nom: string; anonymise: boolean };
  narrateur: { id: string; nom: string } | null;
}

export interface LienDeFiliation {
  parentStoryId: string;
  childStoryId: string;
}

export interface QuestionOuverte {
  texte: string;
  posePar: string;
  aPropos: string | null;
}

export interface MembreDuLivre {
  id: string;
  nom: string;
}

/** Un récit et ce qu'il a engendré, en profondeur. */
export interface Branche {
  recit: RecitDuLivre;
  nes: Branche[];
}

export interface Livre {
  branches: Branche[];
  /** Ce que ce livre ne dit pas. Imprimé, pas caché. */
  trous: {
    questionsSansReponse: QuestionOuverte[];
    recitsSansDate: Array<{ titre: string }>;
    membresJamaisMentionnes: MembreDuLivre[];
  };
  /** De quoi vérifier que rien n'a été omis à l'impression. */
  compte: { recits: number; racines: number; liens: number };
}

/**
 * Assemble le livre.
 *
 * Un récit qui n'est né d'aucun autre est une racine. Les autres se rangent
 * sous celui qui les a engendrés. Un cycle — deux récits qui se réclament
 * l'un de l'autre — ne fait pas boucler : chaque récit n'est imprimé
 * qu'une fois, à sa première place rencontrée.
 */
export function assemblerLivre(
  recits: readonly RecitDuLivre[],
  liens: readonly LienDeFiliation[],
  trous: Livre['trous'],
): Livre {
  const parId = new Map(recits.map((recit) => [recit.id, recit]));

  // Enfants d'un récit, dans l'ordre chronologique — l'amendement 5 vaut
  // à l'intérieur de chaque niveau.
  const enfants = new Map<string, string[]>();
  const aUnParent = new Set<string>();
  for (const lien of liens) {
    if (!parId.has(lien.parentStoryId) || !parId.has(lien.childStoryId)) continue;
    if (lien.parentStoryId === lien.childStoryId) continue;
    (enfants.get(lien.parentStoryId) ?? enfants.set(lien.parentStoryId, []).get(lien.parentStoryId)!).push(
      lien.childStoryId,
    );
    aUnParent.add(lien.childStoryId);
  }
  for (const liste of enfants.values()) {
    liste.sort((a, b) => parId.get(a)!.createdAt.getTime() - parId.get(b)!.createdAt.getTime());
  }

  const imprimes = new Set<string>();

  function brancher(id: string): Branche | null {
    if (imprimes.has(id)) return null;
    imprimes.add(id);
    const recit = parId.get(id)!;
    const nes = (enfants.get(id) ?? [])
      .map(brancher)
      .filter((branche): branche is Branche => branche !== null);
    return { recit, nes };
  }

  const racines = [...recits]
    .filter((recit) => !aUnParent.has(recit.id))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  const branches = racines.map((recit) => brancher(recit.id)!).filter(Boolean);

  // Un cycle laisse des récits qu'aucune racine n'atteint. On ne les perd
  // pas : ils s'ajoutent à la suite, chronologiquement. Un livre qui
  // oublierait un récit serait le pire des manquements.
  const oublies = [...recits]
    .filter((recit) => !imprimes.has(recit.id))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((recit) => brancher(recit.id))
    .filter((branche): branche is Branche => branche !== null);

  return {
    branches: [...branches, ...oublies],
    trous,
    compte: { recits: recits.length, racines: branches.length, liens: aUnParent.size },
  };
}

/** Combien de récits le livre contient réellement, branches comprises. */
export function compterImprimes(branches: readonly Branche[]): number {
  return branches.reduce((total, branche) => total + 1 + compterImprimes(branche.nes), 0);
}

/**
 * La ligne de provenance d'un récit.
 *
 * La voix d'abord, la plume ensuite. Sans cette distinction, tout ce qu'une
 * aïeule transmet est crédité à celui qui tenait le clavier (§2.3).
 */
export function provenanceDe(recit: RecitDuLivre): string {
  const auteur = recit.auteur.anonymise ? 'un auteur anonymisé' : recit.auteur.nom;
  if (recit.narrateur && recit.narrateur.id !== recit.auteur.id) {
    return `Raconté par ${recit.narrateur.nom}, noté par ${auteur}`;
  }
  return `Raconté et noté par ${auteur}`;
}

/**
 * La date d'un récit — celle de l'événement, ou rien.
 *
 * Amendement 6 : on n'affiche pas la date de saisie à la place de la date
 * de l'événement. Un récit saisi en 2026 sur un déménagement de 1971 ne
 * porte pas « 2026 » : il porte le silence, et il figure parmi les trous.
 */
export function dateDe(recit: RecitDuLivre): string | null {
  if (!recit.eventDate) return null;
  return recit.eventDate.toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}
