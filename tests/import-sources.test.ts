import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assembler,
  decouperEnMoments,
  detecterSource,
  empreinteDe,
  lireConversation,
  reparerDoubleEncodage,
  SOURCES,
} from '@/lib/import';
import { lireExportMessenger } from '@/lib/import/messenger';
import { decoderEntites, lireSauvegardeSms } from '@/lib/import/sms';

/**
 * Trois plateformes, trois pièges différents. Les fichiers d'exemple
 * reproduisent les exports réels — y compris leurs défauts.
 */

/**
 * Reproduit le défaut de l'export Facebook : l'UTF-8 y est encodé deux
 * fois. On le fabrique ici plutôt que de le coller en dur — le test
 * documente ainsi la transformation qu'il vérifie.
 */
function commeFacebook(texte: string): string {
  return [...new TextEncoder().encode(texte)].map((octet) => String.fromCharCode(octet)).join('');
}

const MESSENGER = JSON.stringify({
  participants: [{ name: 'Claire Martin' }, { name: 'Jeanne Martin' }],
  title: 'Famille Martin',
  messages: [
    // Facebook rend les messages du PLUS RÉCENT au plus ancien.
    { sender_name: 'Jeanne Martin', timestamp_ms: 1710253880000, content: commeFacebook('Dans le tiroir du buffet') },
    { sender_name: 'Claire Martin', timestamp_ms: 1710253500000, content: commeFacebook('Elle est où ?') },
    { sender_name: 'Claire Martin', timestamp_ms: 1710253391000, content: commeFacebook('Celle qu’il avait arrêtée ?') },
    { sender_name: 'Lucas Martin', timestamp_ms: 1710253300000, photos: [{ uri: 'messages/photos/IMG_1.jpg' }] },
    { sender_name: 'Claire Martin', timestamp_ms: 1710253200000, call_duration: 42 },
    { sender_name: 'Claire Martin', timestamp_ms: 1710253100000, content: 'annule', is_unsent: true },
  ],
});

const SMS = `<?xml version="1.0" encoding="UTF-8"?>
<smses count="5">
  <sms protocol="0" address="+33612345678" date="1710253391000" type="1" body="Tu te souviens de la montre ?" contact_name="Mamie" />
  <sms protocol="0" address="+33612345678" date="1710253500000" type="2" body="Celle qu&apos;il avait arr&#234;t&#233;e ?" contact_name="Mamie" />
  <sms protocol="0" address="+33698765432" date="1710253600000" type="1" body="Oui" contact_name="(Unknown)" />
  <sms protocol="0" address="+33612345678" date="1710253700000" type="1" body="" contact_name="Mamie" />
  <mms date="1710253800000" address="+33612345678" type="1" contact_name="Mamie">
    <parts>
      <part seq="-1" ct="application/smil" name="smil.xml" />
      <part seq="0" ct="text/plain" text="Le figuier de Bordeaux" />
      <part seq="1" ct="image/jpeg" name="figuier.jpg" />
    </parts>
  </mms>
</smses>`;

describe('Messenger — le double encodage de Facebook', () => {
  it('rétablit les accents abîmés par l’export', () => {
    // Défaut ancien et jamais corrigé. Sans réparation, tout import
    // français est illisible.
    const textes = lireExportMessenger(MESSENGER).messages.map((m) => m.texte);
    expect(textes).toContain('Celle qu’il avait arrêtée ?');
    expect(textes).toContain('Elle est où ?');
  });

  it('ne détruit pas un texte déjà sain', () => {
    // Appliquée à tort, la réparation transforme « arrêtée » en illisible.
    // La détection n'est donc pas une optimisation, c'est une condition.
    for (const sain of ['Celle qu’il avait arrêtée, à Bordeaux', '簡単', 'rien de spécial']) {
      expect(reparerDoubleEncodage(sain)).toBe(sain);
    }
  });

  it('signale la réparation plutôt que de la taire', () => {
    expect(lireExportMessenger(MESSENGER).avertissements.join(' ')).toMatch(/accents.*rétablis/i);
  });

  it('remet les messages dans l’ordre chronologique', () => {
    const dates = lireExportMessenger(MESSENGER).messages.map((m) => m.date.getTime());
    expect(dates).toEqual([...dates].sort((a, b) => a - b));
  });

  it('écarte les appels et les messages retirés', () => {
    const lu = lireExportMessenger(MESSENGER);
    expect(lu.systeme).toBe(2);
    expect(lu.messages.map((m) => m.texte)).not.toContain('annule');
  });

  it('garde une photo comme pièce jointe nommée, sans importer le fichier', () => {
    const photo = lireExportMessenger(MESSENGER).messages.find((m) => m.pieceJointe !== null)!;
    expect(photo.pieceJointe).toBe('IMG_1.jpg');
    expect(photo.texte).toBe('');
  });

  it('tient un horodatage absolu — contrairement à WhatsApp', () => {
    expect(lireExportMessenger(MESSENGER).messages.every((m) => m.heureFiable)).toBe(true);
  });

  it('ne prétend rien lire d’un JSON illisible', () => {
    const lu = lireExportMessenger('{ ceci n’est pas du JSON');
    expect(lu.messages).toHaveLength(0);
    expect(lu.avertissements.join(' ')).toMatch(/pas un JSON/i);
  });
});

describe('SMS — la moitié de la conversation n’a pas d’auteur', () => {
  it('nomme l’expéditeur avec le propriétaire déclaré', () => {
    const lu = lireSauvegardeSms(SMS, { proprietaire: 'Claire Martin' });
    expect(lu.messages.find((m) => m.texte.startsWith('Celle qu'))!.auteur).toBe('Claire Martin');
  });

  it('n’invente aucun nom quand le propriétaire est inconnu', () => {
    const lu = lireSauvegardeSms(SMS);
    expect(lu.messages.find((m) => m.texte.startsWith('Celle qu'))!.auteur).toBe('Depuis cet appareil');
    expect(lu.avertissements.join(' ')).toMatch(/sans auteur nommé/i);
  });

  it('préfère le numéro à un faux nom', () => {
    // « (Unknown) » est ce qu'écrit l'application quand le numéro n'est pas
    // dans le carnet d'adresses.
    const lu = lireSauvegardeSms(SMS, { proprietaire: 'Claire Martin' });
    expect(lu.participants).toContain('+33698765432');
    expect(lu.participants).not.toContain('(Unknown)');
  });

  it('décode les entités XML', () => {
    const lu = lireSauvegardeSms(SMS, { proprietaire: 'Claire Martin' });
    expect(lu.messages.map((m) => m.texte)).toContain("Celle qu'il avait arrêtée ?");
    expect(decoderEntites('&amp;lt;')).toBe('&lt;');
    expect(decoderEntites('&#233;t&#233;')).toBe('été');
  });

  it('lit un MMS : son texte et sa pièce jointe', () => {
    const lu = lireSauvegardeSms(SMS, { proprietaire: 'Claire Martin' });
    const mms = lu.messages.find((m) => m.texte === 'Le figuier de Bordeaux')!;
    // Le fichier SMIL est de la tuyauterie, pas une pièce jointe.
    expect(mms.pieceJointe).toBe('figuier.jpg');
  });

  it('écarte un SMS au corps vide', () => {
    const lu = lireSauvegardeSms(SMS, { proprietaire: 'Claire Martin' });
    expect(lu.systeme).toBeGreaterThanOrEqual(1);
    expect(lu.messages.some((m) => m.texte === '')).toBe(false);
  });
});

describe('La détection ne devine jamais', () => {
  it('reconnaît chaque source à son contenu', () => {
    expect(detecterSource(MESSENGER, 'message_1.json')?.id).toBe('messenger');
    expect(detecterSource(SMS, 'sms-20240312.xml')?.id).toBe('sms');
    expect(detecterSource('[12/03/2024, 14:23:11] Claire : Bonjour', 'chat.txt')?.id).toBe('whatsapp');
  });

  it('ne se fie pas à la seule extension', () => {
    expect(detecterSource('une liste de courses', 'courses.txt')).toBeNull();
    expect(detecterSource('{"autre":"chose"}', 'donnees.json')).toBeNull();
  });

  it('rend null plutôt que de tenter une lecture au hasard', () => {
    // Deviner produirait un import silencieusement faux — le pire résultat
    // possible pour une mémoire familiale.
    expect(lireConversation('n’importe quoi', 'x.txt', {})).toBeNull();
  });

  it('chaque source sait expliquer comment obtenir son fichier', () => {
    for (const source of SOURCES) {
      expect(source.commentExporter.length).toBeGreaterThan(60);
      expect(source.extensions.length).toBeGreaterThan(0);
    }
  });
});

describe('Le modèle commun — doublons et ordre', () => {
  const brut = (date: string, auteur: string, texte: string) => ({
    date: new Date(date),
    auteur,
    texte,
    heureFiable: true,
  });

  it('écarte deux fois le même message et le compte', () => {
    // Une même conversation existe souvent dans deux exports : on migre de
    // SMS vers WhatsApp, on garde les deux.
    const lecture = assembler(
      'whatsapp',
      [
        brut('2024-03-12T14:23:11Z', 'Claire', 'La montre'),
        brut('2024-03-12T14:23:40Z', 'Claire', 'La montre'),
        brut('2024-03-12T14:25:00Z', 'Jeanne', 'Oui'),
      ],
      { ignorees: 0, systeme: 0, avertissements: [] },
    );
    expect(lecture.messages).toHaveLength(2);
    expect(lecture.doublons).toBe(1);
  });

  it('ne confond pas deux messages identiques éloignés dans le temps', () => {
    const lecture = assembler(
      'whatsapp',
      [brut('2024-03-12T14:23:11Z', 'Claire', 'Oui'), brut('2024-06-01T09:00:00Z', 'Claire', 'Oui')],
      { ignorees: 0, systeme: 0, avertissements: [] },
    );
    expect(lecture.messages).toHaveLength(2);
  });

  it('ignore la casse et les espaces dans l’empreinte', () => {
    expect(empreinteDe(brut('2024-03-12T14:23:11Z', 'Claire', 'La  montre'))).toBe(
      empreinteDe(brut('2024-03-12T14:23:40Z', 'claire', 'la montre')),
    );
  });

  it('découpe en moments de la même façon quelle que soit la source', () => {
    const messenger = decouperEnMoments(lireExportMessenger(MESSENGER).messages);
    const sms = decouperEnMoments(lireSauvegardeSms(SMS, { proprietaire: 'Claire' }).messages);
    expect(messenger.length).toBeGreaterThan(0);
    expect(sms.length).toBeGreaterThan(0);
    for (const moment of [...messenger, ...sms]) {
      expect(moment.participants.length).toBeGreaterThanOrEqual(2);
      expect(moment.indices.length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('§3.1 amendée — apporté n’est pas capté', () => {
  /**
   * L'amendement distingue deux gestes que la liste d'origine confondait :
   * le produit qui VA CHERCHER dans le téléphone, et une personne qui
   * APPORTE un fichier qu'elle a exporté, lu et coché. Le second est de la
   * saisie utilisateur, déjà autorisée. Trois conditions le tiennent.
   */
  it('condition 1 — aucun lecteur ne touche au réseau ni au disque', () => {
    // L'analyse a lieu dans le navigateur. Un lecteur qui téléverserait le
    // fichier ferait tomber toute l'autorisation.
    const sources = ['modele.ts', 'messenger.ts', 'sms.ts'];
    for (const fichier of sources) {
      const code = readFileSync(join(process.cwd(), 'src', 'lib', 'import', fichier), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      expect(code, `${fichier} ne doit rien émettre`).not.toMatch(
        /\bfetch\(|XMLHttpRequest|navigator\.|localStorage|indexedDB|fs\./,
      );
    }
  });

  it('condition 2 — un lecteur lit une conversation, jamais une archive', () => {
    // Un export Facebook contient toutes les conversations d'une vie.
    // Aucune source n'accepte le ZIP.
    for (const source of SOURCES) {
      expect(source.extensions).not.toContain('.zip');
      expect(source.extensions.every((extension) => ['.txt', '.json', '.xml'].includes(extension))).toBe(
        true,
      );
    }
  });

  it('reconnaît un tête-à-tête, pour pouvoir le dire', () => {
    // Un groupe est un espace créé ensemble ; un échange à deux a été écrit
    // à une seule personne. L'importer change l'auditoire.
    const aDeux = lireSauvegardeSms(SMS_A_DEUX, { proprietaire: 'Claire Martin' });
    expect(aDeux.participants).toHaveLength(2);

    const enGroupe = lireExportMessenger(MESSENGER);
    expect(enGroupe.participants.length).toBeGreaterThan(2);
  });
});

const SMS_A_DEUX = `<smses>
  <sms address="+33612345678" date="1710253391000" type="1" body="Tu te souviens de la montre ?" contact_name="Mamie" />
  <sms address="+33612345678" date="1710253500000" type="2" body="Oui" contact_name="Mamie" />
  <sms address="+33612345678" date="1710253600000" type="1" body="Elle est dans le buffet" contact_name="Mamie" />
</smses>`;
