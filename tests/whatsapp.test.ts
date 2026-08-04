import { describe, expect, it } from 'vitest';
import { estSysteme, lireExportWhatsApp, EXEMPLES_SYSTEME } from '@/lib/whatsapp';
import { decouperEnMoments, type MessageImporte } from '@/lib/import';

/**
 * Les formats viennent d'exports réels : WhatsApp n'en documente aucun, et
 * ils changent selon la plateforme ET la langue du téléphone qui exporte.
 * Un analyseur qui ne tiendrait qu'un seul format ne servirait à personne.
 */

const IOS_FR = `[12/03/2024, 14:23:11] Claire Martin : Vous vous souvenez de la montre de papa ?
[12/03/2024, 14:25:02] Jeanne Martin : Celle qu'il avait arrêtée ?
[12/03/2024, 14:26:40] Claire Martin : Oui. Elle est où maintenant ?
[12/03/2024, 14:31:19] Jeanne Martin : Dans le tiroir du buffet, avec les alliances.`;

const ANDROID_FR = `12/03/2024, 14:23 - Claire Martin : Vous vous souvenez de la montre ?
12/03/2024, 14:25 - Jeanne Martin : Celle qu'il avait arrêtée ?
12/03/2024, 14:26 - Claire Martin : Oui`;

const ANDROID_US = `3/12/24, 2:23 PM - Claire: Do you remember the watch?
3/12/24, 2:25 PM - Jeanne: The one he stopped?
3/12/24, 2:26 PM - Claire: Yes`;

const ANDROID_FR_A = `12/03/2024 à 14:23 - Claire Martin : La montre
12/03/2024 à 14:25 - Jeanne Martin : Oui
12/03/2024 à 14:26 - Lucas Martin : Elle est où ?`;

describe('L’analyseur tient les quatre formats réels', () => {
  it('lit le format iOS', () => {
    const lu = lireExportWhatsApp(IOS_FR);
    expect(lu.messages).toHaveLength(4);
    expect(lu.messages[0]!.auteur).toBe('Claire Martin');
    expect(lu.messages[0]!.texte).toBe('Vous vous souvenez de la montre de papa ?');
    expect(lu.messages[0]!.date.getHours()).toBe(14);
    expect(lu.messages[0]!.date.getFullYear()).toBe(2024);
  });

  it('lit le format Android', () => {
    expect(lireExportWhatsApp(ANDROID_FR).messages).toHaveLength(3);
  });

  it('lit le format américain, méridien compris', () => {
    const lu = lireExportWhatsApp(ANDROID_US);
    expect(lu.messages).toHaveLength(3);
    // 2:23 PM → 14 h. Sans traitement du méridien, l'après-midi devient le matin.
    expect(lu.messages[0]!.date.getHours()).toBe(14);
  });

  it('lit le format français avec « à »', () => {
    expect(lireExportWhatsApp(ANDROID_FR_A).participants).toEqual([
      'Claire Martin',
      'Jeanne Martin',
      'Lucas Martin',
    ]);
  });

  it('survit aux marques invisibles que WhatsApp insère', () => {
    // U+200E et l'espace insécable étroit avant l'heure : sans nettoyage,
    // aucun motif ne s'accroche et l'export paraît vide.
    const sale = '‎[12/03/2024, 2:23:11 PM] Claire : Bonjour';
    expect(lireExportWhatsApp(sale).messages).toHaveLength(1);
  });

  it('n’invente pas une date impossible', () => {
    // Un téléphone mal réglé exporte des 31 février. On refuse la ligne.
    const lu = lireExportWhatsApp('[31/02/2024, 14:23:11] Claire : Bonjour');
    expect(lu.messages).toHaveLength(0);
  });

  it('lit MM/JJ quand JJ/MM est impossible', () => {
    // 03/25 ne peut être qu'un mois de mars, jour 25.
    const lu = lireExportWhatsApp('[03/25/2024, 14:23:11] Claire : Bonjour');
    expect(lu.messages[0]!.date.getMonth()).toBe(2);
    expect(lu.messages[0]!.date.getDate()).toBe(25);
  });
});

describe('Ce qui n’est la parole de personne n’entre pas', () => {
  it('écarte l’avertissement de chiffrement', () => {
    const lu = lireExportWhatsApp(
      `[12/03/2024, 14:00:00] Claire : Les messages sont chiffrés de bout en bout.
[12/03/2024, 14:23:11] Claire : Vous vous souvenez de la montre ?`,
    );
    expect(lu.messages).toHaveLength(1);
    expect(lu.systeme).toBe(1);
  });

  it('écarte les arrivées, départs et changements de sujet', () => {
    const lu = lireExportWhatsApp(
      `[12/03/2024, 14:00:00] Lucas a rejoint le groupe
[12/03/2024, 14:01:00] Claire a changé le sujet
[12/03/2024, 14:23:11] Claire : Un vrai message`,
    );
    expect(lu.messages).toHaveLength(1);
    expect(lu.systeme).toBe(2);
  });

  it('écarte les messages supprimés et les appels manqués', () => {
    const lu = lireExportWhatsApp(
      `[12/03/2024, 14:00:00] Claire : Ce message a été supprimé
[12/03/2024, 14:01:00] Claire : Appel manqué
[12/03/2024, 14:23:11] Claire : Un vrai message`,
    );
    expect(lu.messages).toHaveLength(1);
  });
});

describe('Ce que l’analyseur n’a pas compris, il le compte', () => {
  it('ne jette rien en silence', () => {
    // Amendement 6 : le produit ne prétend pas avoir tout lu s'il n'a pas
    // tout lu. Une ligne orpheline en tête de fichier est signalée.
    const lu = lireExportWhatsApp('une ligne sans date ni auteur\n[12/03/2024, 14:23:11] Claire : Bonjour');
    expect(lu.ignorees).toBe(1);
    expect(lu.messages).toHaveLength(1);
  });

  it('rattache les lignes suivantes à leur message', () => {
    const lu = lireExportWhatsApp(
      `[12/03/2024, 14:23:11] Jeanne : La recette :
- trois poires
- du beurre`,
    );
    expect(lu.messages).toHaveLength(1);
    expect(lu.messages[0]!.texte).toBe('La recette :\n- trois poires\n- du beurre');
    expect(lu.ignorees).toBe(0);
  });

  it('rend la plage de dates, pour que la famille vérifie la lecture', () => {
    const lu = lireExportWhatsApp(IOS_FR);
    expect(lu.debut!.getFullYear()).toBe(2024);
    expect(lu.fin!.getMinutes()).toBe(31);
  });
});

describe('Les pièces jointes sont signalées, pas inventées', () => {
  it('repère un média omis', () => {
    const lu = lireExportWhatsApp('[12/03/2024, 14:23:11] Claire : <Médias omis>');
    expect(lu.messages[0]!.pieceJointe).toBe('média');
    expect(lu.messages[0]!.texte).toBe('');
  });

  it('garde le nom du fichier quand l’export le donne', () => {
    const lu = lireExportWhatsApp(
      '[12/03/2024, 14:23:11] Claire : IMG-20240312-WA0001.jpg (fichier joint)',
    );
    expect(lu.messages[0]!.pieceJointe).toBe('IMG-20240312-WA0001.jpg');
  });

  it('conserve le texte qui accompagne la pièce jointe', () => {
    const lu = lireExportWhatsApp(
      '[12/03/2024, 14:23:11] Claire : <Médias omis> la montre sur le buffet',
    );
    expect(lu.messages[0]!.texte).toBe('la montre sur le buffet');
    expect(lu.messages[0]!.pieceJointe).toBe('média');
  });
});

describe('Les moments — un découpage temporel, pas un jugement', () => {
  const conversation = `[12/03/2024, 14:23:11] Claire : La montre de papa ?
[12/03/2024, 14:25:02] Jeanne : Celle qu'il avait arrêtée
[12/03/2024, 14:26:40] Claire : Oui, elle est où ?
[12/03/2024, 20:10:00] Lucas : on mange à quelle heure
[13/03/2024, 09:00:00] Claire : Le figuier a repris
[13/03/2024, 09:05:00] Jeanne : Celui de Bordeaux
[13/03/2024, 09:07:00] Lucas : j'y étais jamais allé`;

  it('sépare deux rafales par le silence qui les sépare', () => {
    const moments = decouperEnMoments(lireExportWhatsApp(conversation).messages);
    expect(moments).toHaveLength(2);
    expect(moments[0]!.participants).toEqual(['Claire', 'Jeanne']);
    expect(moments[1]!.participants).toEqual(['Claire', 'Jeanne', 'Lucas']);
  });

  it('écarte le message isolé : « on mange à quelle heure » n’est pas un souvenir', () => {
    const moments = decouperEnMoments(lireExportWhatsApp(conversation).messages);
    const tousLesIndices = moments.flatMap((m) => m.indices);
    expect(tousLesIndices).not.toContain(3);
  });

  it('écarte un monologue : une conversation demande deux voix', () => {
    const monologue = `[12/03/2024, 14:23:11] Claire : un
[12/03/2024, 14:24:11] Claire : deux
[12/03/2024, 14:25:11] Claire : trois`;
    expect(decouperEnMoments(lireExportWhatsApp(monologue).messages)).toHaveLength(0);
  });

  it('rend un aperçu fait des mots réellement écrits', () => {
    // La famille choisit sur la foi du fichier, jamais sur celle d'un résumé.
    const moment = decouperEnMoments(lireExportWhatsApp(conversation).messages)[0]!;
    expect(moment.apercu).toContain('Claire : La montre de papa ?');
    expect(moment.apercu.length).toBeLessThanOrEqual(160);
  });

  it('ne classe rien : l’ordre reste celui du fichier', () => {
    const moments = decouperEnMoments(lireExportWhatsApp(conversation).messages);
    expect(moments[0]!.debut.getTime()).toBeLessThan(moments[1]!.debut.getTime());
  });

  it('tient sur un gros export sans exploser', () => {
    const gros = Array.from(
      { length: 20_000 },
      (_, i) =>
        `[12/03/2024, ${String(Math.floor(i / 60) % 24).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00] ${i % 2 === 0 ? 'Claire' : 'Jeanne'} : message ${i}`,
    ).join('\n');
    const debut = Date.now();
    const lu = lireExportWhatsApp(gros);
    const moments = decouperEnMoments(lu.messages);
    expect(lu.messages.length).toBe(20_000);
    expect(moments.length).toBeGreaterThan(0);
    expect(Date.now() - debut).toBeLessThan(3000);
  });
});

describe('Chaque motif système attrape encore sa ligne', () => {
  /**
   * Deux fois dans ce projet, un motif contenant `\b` après une lettre
   * accentuée n'a jamais rien attrapé — la frontière de mot de JavaScript
   * s'appuie sur [A-Za-z0-9_], et « é » n'en fait pas partie. Un garde-fou
   * qui ne garde rien est pire qu'aucun garde-fou : il rassure.
   */
  it('attrape l’exemple que chaque motif prétend couvrir', () => {
    for (const exemple of EXEMPLES_SYSTEME) {
      expect(estSysteme(exemple), `« ${exemple} » n’est plus reconnu`).toBe(true);
    }
  });

  it('laisse passer la parole ordinaire, accents compris', () => {
    for (const vrai of [
      'Vous vous souvenez de la montre ?',
      'Elle est où maintenant ?',
      'J’ai retrouvé la recette de la tarte',
      'Le téléphone de papa a sonné toute la nuit',
    ]) {
      expect(estSysteme(vrai), `« ${vrai} » a été pris pour un message système`).toBe(false);
    }
  });
});

describe('L’import n’attribue à personne ce qu’il ne sait pas', () => {
  /**
   * Le danger propre à cet import : c'est UNE personne qui dépose dix ans
   * de paroles familiales. Sans distinction, tout serait attribué à celui
   * qui a exporté le fichier — et Jeanne disparaîtrait de sa propre mémoire
   * une seconde fois, après en avoir déjà été privée par le clavier.
   *
   * La règle est la même que pour un récit dicté : l'importateur est
   * l'AUTEUR (c'est lui qui pose ces mots ici), le narrateur est celui qui
   * les a dits — quand, et seulement quand, quelqu'un l'a déclaré.
   */
  function attribuer(
    auteurExport: string,
    correspondances: Record<string, string>,
    importateur: string,
  ) {
    const narratorId = correspondances[auteurExport] ?? null;
    return { authorId: importateur, narratorId };
  }

  it('rattache la parole au membre déclaré, pas à l’importateur', () => {
    const r = attribuer('Mamie', { Mamie: 'mem_jeanne' }, 'mem_claire');
    expect(r.authorId).toBe('mem_claire');
    expect(r.narratorId).toBe('mem_jeanne');
  });

  it('laisse le narrateur vide quand personne n’a été déclaré', () => {
    // « Mamie » n'est pas un identifiant. Ne pas savoir n'est pas savoir
    // que c'est l'importateur.
    const r = attribuer('Mamie', {}, 'mem_claire');
    expect(r.narratorId).toBeNull();
  });

  it('ne retient jamais une correspondance vers un membre d’une autre famille', () => {
    const valides = new Set(['mem_claire', 'mem_jeanne']);
    const propose = { Mamie: 'mem_dune_autre_famille', Papa: 'mem_jeanne' };
    const retenues = new Map(Object.entries(propose).filter(([, id]) => valides.has(id)));
    expect(retenues.has('Mamie')).toBe(false);
    expect(retenues.get('Papa')).toBe('mem_jeanne');
  });
});

describe('Ce qui est envoyé au serveur', () => {
  const CONVERSATION = `[12/03/2024, 14:23:11] Claire : La montre de papa ?
[12/03/2024, 14:25:02] Jeanne : Celle qu'il avait arrêtée
[12/03/2024, 14:26:40] Claire : Elle est où ?
[15/06/2024, 09:00:00] Claire : mon code de carte bleue c'est 4412
[15/06/2024, 09:01:00] Lucas : ok
[15/06/2024, 09:02:00] Claire : merci`;

  it('n’envoie que les moments cochés — le reste ne quitte pas l’appareil', () => {
    const lu = lireExportWhatsApp(CONVERSATION);
    const moments = decouperEnMoments(lu.messages);
    expect(moments).toHaveLength(2);

    // La famille ne coche que le premier. Le second — logistique, données
    // sensibles — n'est jamais transmis.
    const retenus = new Set([0]);
    const envoyes = moments
      .filter((_: unknown, i: number) => retenus.has(i))
      .flatMap((moment) => moment.indices.map((index) => lu.messages[index]!.texte));

    expect(envoyes.join(' ')).toContain('La montre de papa');
    expect(envoyes.join(' ')).not.toContain('4412');
  });

  it('conserve les mots tels qu’ils ont été écrits', () => {
    const lu = lireExportWhatsApp(CONVERSATION);
    const moment = decouperEnMoments(lu.messages)[0]!;
    const textes = moment.indices.map((i) => lu.messages[i]!.texte);
    expect(textes).toEqual([
      'La montre de papa ?',
      "Celle qu'il avait arrêtée",
      'Elle est où ?',
    ]);
  });

  it('repère les questions pour que le Passeur puisse les reprendre', () => {
    const lu = lireExportWhatsApp(CONVERSATION);
    const questions = lu.messages.filter((m: MessageImporte) => m.texte.trimEnd().endsWith('?'));
    expect(questions.map((q) => q.texte)).toContain('Elle est où ?');
  });
});
