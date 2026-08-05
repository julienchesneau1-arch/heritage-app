import type { Inventaire } from './context';

/**
 * Les sections du produit, et ce qui doit exister pour qu'elles servent.
 *
 * Données pures, hors du composant : la règle « un menu ne propose que ce
 * qui existe » est ainsi vérifiable par un test, et non enfouie dans du JSX.
 */
export interface Section {
  href: string;
  label: string;
  utile: (inventaire: Inventaire) => boolean;
  /** Dit dans « Tout le reste » : le vocabulaire du produit s'y explique. */
  role: string;
}

export const SECTIONS: Section[] = [
  {
    href: '/veillee',
    label: 'Veillée',
    utile: (i) => i.recits > 0,
    role: 'Trois récits à lire à voix haute quand la famille est réunie.',
  },
  {
    href: '/recits',
    label: 'Récits',
    utile: (i) => i.recits > 0,
    role: 'Tout ce qui a été gardé, du plus récent au plus ancien.',
  },
  {
    href: '/brouillons',
    label: 'À mettre au propre',
    utile: (i) => i.brouillons > 0,
    role: 'Les enregistrements transcrits, à relire avant de les garder.',
  },
  {
    href: '/archives',
    label: 'Archives',
    utile: (i) => i.archives > 0,
    role: 'Les photos, les documents, les enregistrements.',
  },
  {
    href: '/traditions',
    label: 'Traditions',
    utile: (i) => i.traditions > 0,
    role: 'Ce qui revient chaque année, et qu’on ne veut pas perdre.',
  },
  {
    href: '/graphe',
    label: 'Graphe',
    utile: (i) => i.entites > 0,
    role: 'Les personnes, les lieux, les objets — et ce qui se dit de chacun.',
  },
  {
    href: '/livre',
    label: 'Le livre',
    utile: (i) => i.recits > 0,
    role: 'Tout ce qui a été gardé, composé pour le papier — avec ce qui manque.',
  },
];

/**
 * Ce qui a QUITTÉ cette liste, et pourquoi.
 *
 * « Transmission » y figurait. C'était la page de mes chiffres, servie à la
 * famille comme un bulletin : « 23 % des récits ont engendré au moins un
 * autre récit », en corps 4xl, avec une cible V1 de 20 % (§9.1). La §12
 * interdit le score — et une famille ne peut rien faire d'un pourcentage,
 * sinon écrire pour le faire monter, ce qui est exactement l'optimisation
 * d'engagement que la même ligne interdit.
 *
 * Ce que cette page contient d'obligatoire — ce que l'algorithme écarte,
 * met en sourdine, n'a jamais remontré — reste dû à la famille (§6.3,
 * Annexe A point 5). Elle est donc descendue au PIED de page, à côté
 * d'« Exporter la mémoire » : c'est le même genre de chose, la reddition
 * de comptes, et ce n'est pas un lieu où l'on passe tous les jours.
 */

export const INVENTAIRE_VIDE: Inventaire = {
  recits: 0,
  archives: 0,
  traditions: 0,
  entites: 0,
  brouillons: 0,
  fils: 0,
};

/** Ce que le premier jour dit, et rien de plus. Extrait pour être testé. */
export const PREMIER_JOUR = {
  quoi: (famille: string) => `Ici, la famille ${famille} se raconte.`,
  comment:
    'Quelqu’un dit une chose. Quelqu’un d’autre ajoute la sienne. Quand il y en a assez, cela devient un récit qui reste.',
  rassurance:
    'Rien à rédiger : personne n’écrit de mémoires ici. Une phrase suffit, et elle peut être dite à voix haute.',
  action: 'Dites une première chose',
  autreChemin:
    'La famille se parle peut-être déjà ailleurs — dans un groupe WhatsApp, où tout défile et où personne ne retrouve rien.',
} as const;
