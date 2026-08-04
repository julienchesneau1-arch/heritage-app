/**
 * IMPORTER UNE CONVERSATION — le modèle commun.
 *
 * Un premier lecteur, celui de WhatsApp, rendait un type qui lui était
 * propre. En ajouter trois aurait donné quatre lecteurs, quatre types,
 * quatre interfaces et quatre fois les mêmes règles à retenir.
 *
 * Tout converge donc ici. Le découpage en moments, le rattachement des
 * identités, la détection des doublons, l'écran de choix et la route
 * d'écriture sont écrits UNE fois, sur ce modèle. Une source nouvelle
 * n'apporte qu'un lecteur — et ses pièges à elle.
 */

export type SourceId = 'whatsapp' | 'messenger' | 'sms';

export interface MessageImporte {
  /** Ordre après tri chronologique. Sert d'identifiant dans l'écran de choix. */
  index: number;
  date: Date;
  auteur: string;
  texte: string;
  /** Pièce jointe dont seul le nom subsiste. Le fichier lui-même n'est pas importé. */
  pieceJointe: string | null;
  /**
   * L'heure est-elle une heure absolue ?
   *
   * Messenger et les SMS horodatent en millisecondes depuis 1970 : l'instant
   * est certain. WhatsApp écrit l'heure locale du téléphone qui a exporté,
   * sans jamais dire quel fuseau. Deux imports de la même conversation
   * peuvent donc diverger, et le produit doit le dire plutôt que de
   * prétendre à une précision qu'il n'a pas (amendement 6).
   */
  heureFiable: boolean;
}

export interface Lecture {
  source: SourceId;
  messages: MessageImporte[];
  participants: string[];
  /** Lignes non rattachées. Comptées, jamais devinées ni tues. */
  ignorees: number;
  /** Lignes produites par la plateforme elle-même, qui ne sont la parole de personne. */
  systeme: number;
  /** Messages identiques déjà présents dans la lecture — dédoublonnés. */
  doublons: number;
  debut: Date | null;
  fin: Date | null;
  /** Ce que le lecteur sait d'incertain. Affiché tel quel à la famille. */
  avertissements: string[];
}

export interface OptionsLecture {
  /**
   * Le nom du propriétaire de l'appareil.
   *
   * Un export SMS ne nomme jamais celui qui a envoyé : il marque seulement
   * « envoyé ». Sans cette réponse, la moitié de la conversation n'aurait
   * pas d'auteur — et l'inventer serait exactement ce que la Constitution
   * interdit.
   */
  proprietaire?: string;
}

export interface Source {
  id: SourceId;
  nom: string;
  /** Extensions acceptées par le sélecteur de fichier. */
  extensions: string[];
  /** Ce lecteur reconnaît-il ce contenu ? Test bon marché, sur le début du fichier. */
  reconnait(debut: string, nomFichier: string): boolean;
  lire(contenu: string, options: OptionsLecture): Lecture;
  /** Le chemin exact pour obtenir le fichier. Affiché dans l'interface. */
  commentExporter: string;
  /** Ce lecteur a-t-il besoin de savoir qui possède l'appareil ? */
  demandeProprietaire: boolean;
}

// ─────────────────────────────────────────────────────────────────────
// Assemblage commun
// ─────────────────────────────────────────────────────────────────────

export interface MessageBrut {
  date: Date;
  auteur: string;
  texte: string;
  pieceJointe?: string | null;
  heureFiable: boolean;
}

/**
 * Trie, dédoublonne, numérote.
 *
 * Le tri n'est pas cosmétique : l'export Messenger rend les messages du
 * plus récent au plus ancien, et le découpage en moments suppose l'ordre
 * chronologique.
 */
export function assembler(
  source: SourceId,
  bruts: MessageBrut[],
  compteurs: { ignorees: number; systeme: number; avertissements: string[] },
): Lecture {
  const tries = [...bruts].sort((a, b) => a.date.getTime() - b.date.getTime());

  const vus = new Set<string>();
  const messages: MessageImporte[] = [];
  let doublons = 0;

  for (const brut of tries) {
    const empreinte = empreinteDe(brut);
    if (vus.has(empreinte)) {
      doublons += 1;
      continue;
    }
    vus.add(empreinte);
    messages.push({
      index: messages.length,
      date: brut.date,
      auteur: brut.auteur,
      texte: brut.texte,
      pieceJointe: brut.pieceJointe ?? null,
      heureFiable: brut.heureFiable,
    });
  }

  return {
    source,
    messages,
    participants: [...new Set(messages.map((m) => m.auteur))].sort((a, b) => a.localeCompare(b, 'fr')),
    ignorees: compteurs.ignorees,
    systeme: compteurs.systeme,
    doublons,
    debut: messages[0]?.date ?? null,
    fin: messages[messages.length - 1]?.date ?? null,
    avertissements: compteurs.avertissements,
  };
}

/**
 * Deux messages sont le même quand ils ont la même minute, le même auteur
 * et le même texte.
 *
 * La minute, et non la seconde : une même conversation exportée depuis
 * deux appareils ne donne pas la seconde près. C'est une règle
 * approximative, et elle est dite comme telle à la famille — le produit ne
 * prétend pas reconnaître un doublon à coup sûr.
 */
export function empreinteDe(message: MessageBrut): string {
  const minute = Math.floor(message.date.getTime() / 60_000);
  const texte = message.texte.replace(/\s+/g, ' ').trim().toLowerCase();
  return `${minute}|${message.auteur.trim().toLowerCase()}|${texte}`;
}

// ─────────────────────────────────────────────────────────────────────
// Les moments
// ─────────────────────────────────────────────────────────────────────

export interface Moment {
  indices: number[];
  debut: Date;
  fin: Date;
  participants: string[];
  /** Ce que la famille lit pour décider. Jamais un résumé produit par une machine. */
  apercu: string;
}

const PAUSE_MINUTES = 90;
const MIN_MESSAGES = 3;
const MIN_PARTICIPANTS = 2;

/**
 * Découpe la conversation en MOMENTS : des rafales d'échange séparées par
 * des silences.
 *
 * Ce n'est pas un classement par intérêt, et c'est le point : le produit ne
 * sait pas ce qui compte pour une famille, et l'amendement 6 lui interdit
 * de faire semblant. Le critère est purement temporel — vérifiable, et
 * explicable en une phrase à qui doit choisir.
 */
export function decouperEnMoments(
  messages: readonly MessageImporte[],
  options: { pauseMinutes?: number; minMessages?: number; minParticipants?: number } = {},
): Moment[] {
  const pause = (options.pauseMinutes ?? PAUSE_MINUTES) * 60_000;
  const minMessages = options.minMessages ?? MIN_MESSAGES;
  const minParticipants = options.minParticipants ?? MIN_PARTICIPANTS;

  const moments: Moment[] = [];
  let courant: MessageImporte[] = [];

  const cloturer = () => {
    if (courant.length === 0) return;
    const participants = [...new Set(courant.map((m) => m.auteur))];
    if (courant.length >= minMessages && participants.length >= minParticipants) {
      moments.push({
        indices: courant.map((m) => m.index),
        debut: courant[0]!.date,
        fin: courant[courant.length - 1]!.date,
        participants,
        apercu: apercuDe(courant),
      });
    }
    courant = [];
  };

  for (const message of messages) {
    const precedent = courant[courant.length - 1];
    if (precedent && message.date.getTime() - precedent.date.getTime() > pause) cloturer();
    courant.push(message);
  }
  cloturer();

  return moments;
}

/**
 * Les premiers mots réellement dits, tels quels. Pas de résumé : ce que la
 * famille lit pour décider doit être ce qui est écrit dans le fichier,
 * sans quoi elle choisit sur la foi d'une machine.
 */
function apercuDe(messages: readonly MessageImporte[], maxLongueur = 160): string {
  const parlant = messages.filter((m) => m.texte.length > 0);
  const source = parlant.length > 0 ? parlant : messages;

  let apercu = '';
  for (const message of source) {
    const bout = message.texte || `(${message.pieceJointe ?? 'média'})`;
    const ajout = apercu === '' ? `${message.auteur} : ${bout}` : ` — ${message.auteur} : ${bout}`;
    if (apercu.length + ajout.length > maxLongueur) break;
    apercu += ajout;
  }

  if (apercu === '') {
    const premier = source[0]!;
    apercu = `${premier.auteur} : ${premier.texte || `(${premier.pieceJointe ?? 'média'})`}`;
  }
  return apercu.length > maxLongueur ? `${apercu.slice(0, maxLongueur - 1).trimEnd()}…` : apercu;
}
