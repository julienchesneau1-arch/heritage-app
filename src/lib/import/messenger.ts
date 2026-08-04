import { assembler, type Lecture, type MessageBrut, type Source } from './modele';

/**
 * LIRE UN EXPORT MESSENGER.
 *
 * Facebook livre une archive « Download Your Information » qui contient
 * TOUTES les conversations : les ex, les collègues, les médecins. On
 * n'accepte donc jamais l'archive entière — seulement un fichier de
 * conversation, `messages/inbox/<la-conversation>/message_1.json`.
 *
 * Ce n'est pas de la prudence excessive. Accepter le ZIP reviendrait à
 * inviter quelqu'un à verser dix ans de vie privée dans une archive
 * familiale permanente, en un geste, sans l'avoir relue.
 *
 * ── Les trois pièges de ce format ──
 *
 * 1. L'UTF-8 est encodé deux fois. « arrêtée » est écrit « arrÃªtÃ©e ».
 *    C'est un défaut ancien et jamais corrigé de l'export Facebook ; sans
 *    réparation, tout import français est illisible.
 * 2. Les messages sont rendus du plus RÉCENT au plus ancien.
 * 3. Un message peut n'avoir aucun `content` : photo seule, sticker,
 *    appel, message retiré.
 */

interface MessageJson {
  sender_name?: string;
  timestamp_ms?: number;
  content?: string;
  photos?: Array<{ uri?: string }>;
  videos?: Array<{ uri?: string }>;
  audio_files?: Array<{ uri?: string }>;
  files?: Array<{ uri?: string }>;
  sticker?: { uri?: string };
  is_unsent?: boolean;
  call_duration?: number;
  type?: string;
}

interface FichierJson {
  participants?: Array<{ name?: string }>;
  messages?: MessageJson[];
  title?: string;
}

/**
 * Répare l'UTF-8 encodé deux fois.
 *
 * Appliquée à un texte sain, cette transformation le DÉTRUIT : « arrêtée »
 * deviendrait « arr�t�e ». La détection n'est donc pas une optimisation,
 * c'est une condition. On n'agit que sur une signature de double encodage,
 * et on annule si la réparation produit un caractère de remplacement.
 */
export function reparerDoubleEncodage(texte: string): string {
  if (!/[ÃÂ]|â€/.test(texte)) return texte;

  // Hors de la plage Latin-1, la réinterprétation octet par octet n'a pas
  // de sens : le texte n'est pas du mojibake, il est simplement accentué.
  for (const caractere of texte) {
    if (caractere.codePointAt(0)! > 0xff) return texte;
  }

  const octets = Uint8Array.from([...texte], (caractere) => caractere.charCodeAt(0));
  const repare = new TextDecoder('utf-8').decode(octets);

  // U+FFFD : la lecture en UTF-8 a échoué, ce n'était pas du double encodage.
  return repare.includes('�') ? texte : repare;
}

function media(message: MessageJson): string | null {
  if (message.photos?.length) return nomDeFichier(message.photos[0]?.uri) ?? 'photo';
  if (message.videos?.length) return nomDeFichier(message.videos[0]?.uri) ?? 'vidéo';
  if (message.audio_files?.length) return nomDeFichier(message.audio_files[0]?.uri) ?? 'message vocal';
  if (message.files?.length) return nomDeFichier(message.files[0]?.uri) ?? 'fichier';
  if (message.sticker) return 'autocollant';
  return null;
}

function nomDeFichier(uri: string | undefined): string | null {
  if (!uri) return null;
  return uri.split('/').pop() || null;
}

export function lireExportMessenger(contenu: string): Lecture {
  const avertissements: string[] = [];
  let systeme = 0;
  let ignorees = 0;

  let fichier: FichierJson;
  try {
    fichier = JSON.parse(contenu) as FichierJson;
  } catch {
    return assembler('messenger', [], {
      ignorees: 1,
      systeme: 0,
      avertissements: ['Ce fichier n’est pas un JSON lisible.'],
    });
  }

  const bruts: MessageBrut[] = [];
  let reparations = 0;

  for (const message of fichier.messages ?? []) {
    if (typeof message.timestamp_ms !== 'number' || !message.sender_name) {
      ignorees += 1;
      continue;
    }
    // Appel, message retiré : la plateforme parle, pas une personne.
    if (message.is_unsent || typeof message.call_duration === 'number') {
      systeme += 1;
      continue;
    }

    const auteurBrut = message.sender_name;
    const auteur = reparerDoubleEncodage(auteurBrut);
    const texteBrut = message.content ?? '';
    const texte = reparerDoubleEncodage(texteBrut);
    if (texte !== texteBrut || auteur !== auteurBrut) reparations += 1;

    const pieceJointe = media(message);
    if (texte.trim() === '' && !pieceJointe) {
      ignorees += 1;
      continue;
    }

    bruts.push({
      // Millisecondes depuis 1970 : l'instant est absolu, sans ambiguïté
      // de fuseau — contrairement à WhatsApp.
      date: new Date(message.timestamp_ms),
      auteur,
      texte: texte.trim(),
      pieceJointe,
      heureFiable: true,
    });
  }

  if (reparations > 0) {
    avertissements.push(
      `${reparations} messages avaient leurs accents abîmés par l’export de Facebook ; ils ont été rétablis. Vérifiez un aperçu avant de garder.`,
    );
  }

  return assembler('messenger', bruts, { ignorees, systeme, avertissements });
}

export const SOURCE_MESSENGER: Source = {
  id: 'messenger',
  nom: 'Messenger',
  extensions: ['.json'],
  demandeProprietaire: false,
  reconnait: (debut, nomFichier) =>
    /message_\d+\.json$/i.test(nomFichier) ||
    (/"participants"\s*:/.test(debut) && /"(?:messages|sender_name)"\s*:/.test(debut)),
  lire: (contenu) => lireExportMessenger(contenu),
  commentExporter:
    'Sur facebook.com : Paramètres → Vos informations → Télécharger vos informations, au format JSON. Dans l’archive, ouvrez messages/inbox/, puis le dossier de la conversation de famille, et déposez ici le fichier message_1.json — celui-là seulement.',
};
