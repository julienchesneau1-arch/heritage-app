import { assembler, type Lecture, type MessageBrut, type OptionsLecture, type Source } from './modele';

/**
 * LIRE UNE SAUVEGARDE SMS.
 *
 * Format de « SMS Backup & Restore » (Android), le seul export de SMS
 * réellement à la portée d'une famille. iOS n'en propose aucun : les
 * messages ne sortent qu'en fouillant une sauvegarde chiffrée, ce qu'on ne
 * demandera à personne.
 *
 * ── Le piège propre à ce format ──
 *
 * Un SMS reçu porte le nom du contact. Un SMS ENVOYÉ n'en porte aucun : la
 * sauvegarde sait seulement qu'il est sorti de cet appareil. La moitié de
 * la conversation serait donc sans auteur — et l'inventer serait
 * exactement ce que la Constitution interdit. On demande donc le nom du
 * propriétaire du téléphone, et on le dit dans l'interface.
 */

const TYPE_RECU = '1';
const TYPE_ENVOYE = '2';

/** Attributs d'une balise auto-fermante, décodés des entités XML. */
function attributs(balise: string): Record<string, string> {
  const trouves: Record<string, string> = {};
  for (const [, cle, valeur] of balise.matchAll(/([\w:-]+)="([^"]*)"/g)) {
    trouves[cle!] = decoderEntites(valeur!);
  }
  return trouves;
}

export function decoderEntites(valeur: string): string {
  return valeur
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // En dernier, sans quoi « &amp;lt; » deviendrait « < ».
    .replace(/&amp;/g, '&');
}

export function lireSauvegardeSms(contenu: string, options: OptionsLecture = {}): Lecture {
  const avertissements: string[] = [];
  const bruts: MessageBrut[] = [];
  let ignorees = 0;
  let systeme = 0;

  const proprietaire = options.proprietaire?.trim();
  if (!proprietaire) {
    avertissements.push(
      'Le nom du propriétaire du téléphone n’a pas été donné : les messages envoyés depuis cet appareil resteront sans auteur nommé.',
    );
  }

  const nomDe = (attrs: Record<string, string>) => {
    if (attrs.type === TYPE_ENVOYE) return proprietaire || 'Depuis cet appareil';
    const contact = attrs.contact_name?.trim();
    // « (Unknown) » est ce qu'écrit l'application quand le numéro n'est pas
    // dans le carnet d'adresses. Le numéro vaut mieux qu'un faux nom.
    if (contact && contact !== '(Unknown)' && contact !== 'null') return contact;
    return attrs.address?.trim() || 'Inconnu';
  };

  const dateDe = (attrs: Record<string, string>): Date | null => {
    const millisecondes = Number(attrs.date);
    if (!Number.isFinite(millisecondes) || millisecondes <= 0) return null;
    const date = new Date(millisecondes);
    return Number.isNaN(date.getTime()) ? null : date;
  };

  // ── SMS ──
  for (const [balise] of contenu.matchAll(/<sms\b[^>]*\/?>/g)) {
    const attrs = attributs(balise);
    const date = dateDe(attrs);
    const corps = (attrs.body ?? '').trim();

    if (!date) {
      ignorees += 1;
      continue;
    }
    if (corps === '') {
      systeme += 1;
      continue;
    }

    bruts.push({
      // Millisecondes depuis 1970 : instant absolu.
      date,
      auteur: nomDe(attrs),
      texte: corps,
      pieceJointe: null,
      heureFiable: true,
    });
  }

  // ── MMS : le texte est dans une <part ct="text/plain">, le reste est un média ──
  for (const [bloc] of contenu.matchAll(/<mms\b[\s\S]*?<\/mms>/g)) {
    const enTete = bloc.match(/<mms\b[^>]*>/)?.[0] ?? '';
    const attrs = attributs(enTete);
    const date = dateDe(attrs);
    if (!date) {
      ignorees += 1;
      continue;
    }

    let texte = '';
    let pieceJointe: string | null = null;

    for (const [partie] of bloc.matchAll(/<part\b[^>]*\/?>/g)) {
      const partieAttrs = attributs(partie);
      const type = partieAttrs.ct ?? '';
      if (type.startsWith('text/')) {
        const contenuTexte = (partieAttrs.text ?? '').trim();
        if (contenuTexte && contenuTexte !== 'null') texte = contenuTexte;
      } else if (type !== 'application/smil' && !pieceJointe) {
        pieceJointe = partieAttrs.name?.trim() || partieAttrs.cl?.trim() || type;
      }
    }

    if (texte === '' && !pieceJointe) {
      systeme += 1;
      continue;
    }

    bruts.push({ date, auteur: nomDe(attrs), texte, pieceJointe, heureFiable: true });
  }

  return assembler('sms', bruts, { ignorees, systeme, avertissements });
}

export const SOURCE_SMS: Source = {
  id: 'sms',
  nom: 'SMS',
  extensions: ['.xml'],
  demandeProprietaire: true,
  reconnait: (debut, nomFichier) =>
    /\.xml$/i.test(nomFichier) && /<smses\b|<sms\b|<mms\b/.test(debut),
  lire: (contenu, options) => lireSauvegardeSms(contenu, options),
  commentExporter:
    'Sur Android, avec l’application gratuite « SMS Backup & Restore » : Sauvegarder → seulement les Messages → enregistrer en XML. Choisissez si possible la conversation concernée plutôt que tout le téléphone.',
};
