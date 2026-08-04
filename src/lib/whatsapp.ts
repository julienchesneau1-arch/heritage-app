/**
 * LIRE UN EXPORT WHATSAPP — extension hors spec v1.0, assumée.
 *
 * ── Pourquoi ──
 *
 * Tous les chemins vers la mémoire exigeaient jusqu'ici que quelqu'un
 * produise du NEUF : écrire un récit, enregistrer sa voix, ouvrir un fil.
 * Une mémoire vide le restait donc, et c'est ce qui tue ces produits — pas
 * un défaut de fonctionnalité, une page blanche le premier soir.
 *
 * Or presque chaque famille possède déjà des années de conversation, dans
 * un endroit où elles ne servent à rien : le groupe WhatsApp. Tout y
 * défile. Personne ne retrouve, trois ans plus tard, ce que la grand-mère
 * a dit de la montre. Et le jour où quelqu'un meurt, ses messages sont
 * perdus ou enfermés dans un téléphone.
 *
 * ── Ce que ce module ne fait PAS ──
 *
 * Il ne décide rien. Il lit un fichier et rend ce qu'il y a lu. Ni tri par
 * intérêt, ni résumé, ni import automatique. Le fichier contient la parole
 * de gens qui n'ont pas demandé à entrer dans une archive familiale
 * permanente : c'est à la famille de choisir, message par moment, ce qui
 * mérite d'être gardé.
 *
 * Le fichier n'est jamais téléversé. L'analyse a lieu dans le navigateur,
 * comme la transcription. Ce qui part au serveur, ce sont les seuls
 * passages qu'un humain a explicitement retenus.
 */

export interface MessageWhatsApp {
  /** Ordre d'apparition dans le fichier — sert d'identifiant stable. */
  index: number;
  date: Date;
  auteur: string;
  texte: string;
  /** Une pièce jointe dont seul le nom subsiste dans l'export. */
  pieceJointe: string | null;
}

export interface LectureWhatsApp {
  messages: MessageWhatsApp[];
  participants: string[];
  /** Lignes que l'analyseur n'a pas su rattacher. On les compte, on ne les cache pas. */
  ignorees: number;
  /** Messages système retirés (chiffrement, arrivées, changements de sujet). */
  systeme: number;
  debut: Date | null;
  fin: Date | null;
}

/**
 * Les quatre formats qu'exporte WhatsApp selon la plateforme et la langue.
 * Aucun n'est documenté ; ils viennent d'exports réels.
 *
 *   [12/03/2024, 14:23:11] Claire Martin : Bonjour     (iOS)
 *   12/03/2024, 14:23 - Claire Martin : Bonjour        (Android)
 *   3/12/24, 2:23 PM - Claire: Hello                   (Android, US)
 *   12/03/2024 à 14:23 - Claire Martin : Bonjour       (Android, fr)
 */
const ENTETES = [
  /^\[(\d{1,2})[/.](\d{1,2})[/.](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?\]\s*([^:]{1,60}?)\s*:\s*([\s\S]*)$/i,
  /^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4}),?\s+(?:à\s+)?(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?\s+[-–]\s*([^:]{1,60}?)\s*:\s*([\s\S]*)$/i,
];

/** Une ligne qui commence par une date mais sans « Auteur : » est un message système. */
const DEBUT_DE_LIGNE_DATEE =
  /^\[?(\d{1,2})[/.](\d{1,2})[/.](\d{2,4}),?\s+(?:à\s+)?\d{1,2}:\d{2}/;

/**
 * Pièces jointes. WhatsApp remplace le média par un marqueur, dans la
 * langue du téléphone qui a exporté.
 */
const PIECES_JOINTES = [
  /<(?:Médias?|Media|Medien|Multimedia) omis(?:e)?s?>/i,
  /<attached:\s*([^>]+)>/i,
  /([\w-]+\.(?:jpg|jpeg|png|gif|webp|mp4|opus|m4a|pdf|3gp))\s*\((?:fichier joint|file attached|archivo adjunto)\)/i,
  /(?:image|vidéo|video|audio|document|sticker|GIF)\s+(?:omis|omitted|absente?)/i,
];

/**
 * Lignes que WhatsApp insère lui-même. Elles ne sont la parole de personne
 * et n'ont rien à faire dans une mémoire familiale.
 */
const SYSTEME: Array<{ motif: RegExp; exemple: string }> = [
  // Aucun `\b` en fin de motif : en JavaScript la frontière de mot s'appuie
  // sur [A-Za-z0-9_], donc elle n'existe pas après « manqué » ni « supprimé ».
  // Le motif ne se déclencherait jamais. Chaque entrée porte son exemple,
  // et un test vérifie qu'elle l'attrape encore.
  {
    motif: /(?:messages?|appels?|calls?).{0,60}(?:chiffr|encrypted)/i,
    exemple: 'Les messages sont chiffrés de bout en bout.',
  },
  {
    motif: /\ba (?:rejoint|quitté|été ajouté|ajouté|retiré|expulsé|créé)\s/i,
    exemple: 'Lucas a rejoint le groupe',
  },
  {
    motif: /\b(?:joined|left|was added|added|removed|created) (?:the |this )?(?:group|using)/i,
    exemple: 'Lucas joined the group',
  },
  {
    motif: /\ba changé (?:le sujet|l'icône|la description|son numéro)/i,
    exemple: 'Claire a changé le sujet',
  },
  {
    motif: /changed (?:the subject|this group's icon|their phone number)/i,
    exemple: "Claire changed the subject",
  },
  {
    motif: /message (?:a été )?supprimé|this message was deleted|vous avez supprimé ce message/i,
    exemple: 'Ce message a été supprimé',
  },
  {
    motif: /appel (?:manqué|vocal|vidéo)|missed (?:voice|video) call/i,
    exemple: 'Appel manqué',
  },
  {
    motif: /(?:code de sécurité|security code).{0,20}(?:a changé|changed)/i,
    exemple: 'Le code de sécurité a changé',
  },
];

/** Exposés pour que les tests vérifient que chaque motif attrape encore sa ligne. */
export const EXEMPLES_SYSTEME = SYSTEME.map((entree) => entree.exemple);

/**
 * Lit un export WhatsApp.
 *
 * Tolérant par construction : une ligne incomprise est COMPTÉE, jamais
 * devinée ni silencieusement jetée (amendement 6 — le produit ne prétend
 * pas avoir tout lu s'il n'a pas tout lu).
 */
export function lireExportWhatsApp(contenu: string): LectureWhatsApp {
  // WhatsApp sème des marques de direction invisibles (U+200E, U+200F) et
  // des espaces insécables étroits (U+202F) devant les heures. Sans ce
  // nettoyage, aucun motif ne s'accroche.
  const lignes = contenu
    .replace(/﻿/g, '')
    .replace(/[‎‏⁦-⁩]/g, '')
    .replace(/[  ]/g, ' ')
    .split(/\r?\n/);

  const messages: MessageWhatsApp[] = [];
  let ignorees = 0;
  let systeme = 0;

  for (const ligne of lignes) {
    if (ligne.trim() === '') continue;

    const entete = analyserEntete(ligne);

    if (entete) {
      if (estSysteme(entete.texte)) {
        systeme += 1;
        continue;
      }
      const { texte, pieceJointe } = extrairePieceJointe(entete.texte);
      messages.push({
        index: messages.length,
        date: entete.date,
        auteur: entete.auteur,
        texte,
        pieceJointe,
      });
      continue;
    }

    // Ligne datée sans auteur : message système (« X a rejoint le groupe »).
    if (DEBUT_DE_LIGNE_DATEE.test(ligne)) {
      systeme += 1;
      continue;
    }

    // Continuation d'un message multi-lignes.
    const precedent = messages[messages.length - 1];
    if (precedent) {
      precedent.texte = `${precedent.texte}\n${ligne}`.trim();
      continue;
    }

    ignorees += 1;
  }

  const participants = [...new Set(messages.map((m) => m.auteur))].sort((a, b) =>
    a.localeCompare(b, 'fr'),
  );

  return {
    messages,
    participants,
    ignorees,
    systeme,
    debut: messages[0]?.date ?? null,
    fin: messages[messages.length - 1]?.date ?? null,
  };
}

function analyserEntete(
  ligne: string,
): { date: Date; auteur: string; texte: string } | null {
  for (const motif of ENTETES) {
    const trouve = ligne.match(motif);
    if (!trouve) continue;

    const [, j, m, a, h, min, sec, meridien, auteur, texte] = trouve;
    const date = construireDate(j!, m!, a!, h!, min!, sec, meridien);
    if (!date) continue;

    return { date, auteur: auteur!.trim(), texte: texte ?? '' };
  }
  return null;
}

/**
 * WhatsApp exporte en JJ/MM ou MM/JJ selon la région du téléphone, sans
 * jamais le dire. On ne devine pas : quand les deux lectures sont
 * possibles, on prend JJ/MM — la convention de la langue du produit — et
 * l'interface affiche la plage de dates obtenue pour que la famille
 * vérifie d'un coup d'œil que l'année tombe juste.
 */
function construireDate(
  premier: string,
  second: string,
  annee: string,
  heure: string,
  minute: string,
  seconde: string | undefined,
  meridien: string | undefined,
): Date | null {
  let jour = Number(premier);
  let mois = Number(second);

  // Une seule lecture est possible : celle qui donne un mois valide.
  if (mois > 12 && jour <= 12) [jour, mois] = [mois, jour];
  if (mois < 1 || mois > 12 || jour < 1 || jour > 31) return null;

  let h = Number(heure);
  if (meridien) {
    const pm = meridien.toUpperCase() === 'PM';
    if (h === 12) h = pm ? 12 : 0;
    else if (pm) h += 12;
  }

  const an = annee.length === 2 ? 2000 + Number(annee) : Number(annee);
  const date = new Date(an, mois - 1, jour, h, Number(minute), Number(seconde ?? 0));

  // Le 31 février existe dans l'export d'un téléphone mal réglé, pas ici.
  return date.getMonth() === mois - 1 && date.getDate() === jour ? date : null;
}

export function estSysteme(texte: string): boolean {
  return SYSTEME.some(({ motif }) => motif.test(texte));
}

function extrairePieceJointe(texte: string): { texte: string; pieceJointe: string | null } {
  for (const motif of PIECES_JOINTES) {
    const trouve = texte.match(motif);
    if (!trouve) continue;
    return {
      texte: texte.replace(motif, '').trim(),
      pieceJointe: trouve[1]?.trim() ?? 'média',
    };
  }
  return { texte: texte.trim(), pieceJointe: null };
}

// ─────────────────────────────────────────────────────────────────────
// Les moments
// ─────────────────────────────────────────────────────────────────────

export interface Moment {
  /** Index des messages qui le composent, dans l'ordre du fichier. */
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
 * Ce n'est pas un classement par intérêt, et c'est important : le produit
 * ne sait pas ce qui compte pour une famille, et l'amendement 6 lui
 * interdit de faire semblant. Le découpage est purement temporel — un
 * critère vérifiable, que l'interface peut expliquer en une phrase.
 *
 * Les seuils sont conservateurs : au moins trois messages, au moins deux
 * personnes. Un message isolé (« ok », « à demain ») n'est pas un souvenir,
 * et un monologue n'est pas une conversation.
 */
export function decouperEnMoments(
  messages: readonly MessageWhatsApp[],
  options: { pauseMinutes?: number; minMessages?: number; minParticipants?: number } = {},
): Moment[] {
  const pause = (options.pauseMinutes ?? PAUSE_MINUTES) * 60_000;
  const minMessages = options.minMessages ?? MIN_MESSAGES;
  const minParticipants = options.minParticipants ?? MIN_PARTICIPANTS;

  const moments: Moment[] = [];
  let courant: MessageWhatsApp[] = [];

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
 * Les premiers mots réellement dits, tels quels.
 *
 * Pas de résumé : ce que la famille lit pour décider doit être ce qui est
 * écrit dans le fichier, sans quoi elle choisit sur la foi d'une machine.
 */
function apercuDe(messages: readonly MessageWhatsApp[], maxLongueur = 160): string {
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
