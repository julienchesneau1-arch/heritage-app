/**
 * CE QUE L'UTILISATEUR CONFIRME — et ce qu'on lui cachait.
 *
 * `docs/03 §3` : *la confirmation doit porter sur ce qui va **réellement se
 * produire**, pas sur une intention résumée.* C'est la défense qui tient quand
 * un modèle a été convaincu : peu importe ce qu'il raconte, l'humain voit la
 * valeur concrète avant de dire oui.
 *
 * DEUX DÉFAUTS, TROUVÉS EN CHERCHANT LES EXPORTS QU'AUCUN TEST NE CITE
 * ---------------------------------------------------------------------------
 * **1. Une liste NOIRE là où il fallait une liste blanche.** Les valeurs
 * voyageaient dans `error.details` mêlées aux métadonnées, et DEUX
 * consommateurs les triaient chacun par `key !== 'tool' && key !== 'autonomy'`.
 * Le Gateway étalait `...sensitiveValues` **après** ces clés : un paramètre
 * nommé `tool` aurait écrasé la métadonnée puis disparu du tri.
 * **L'humain aurait confirmé une valeur qu'il n'a jamais vue.**
 *
 * **2. Une troncature SILENCIEUSE, et celle-là était ACTIVE.** `.slice(0, 200)`
 * coupait sans le dire. `web_search.query` accepte 256 caractères : cinquante-six
 * pouvaient disparaître de ce qu'on confirme. Ce n'était pas un piège pour plus
 * tard — c'était le comportement du jour.
 */
import { describe, expect, it } from 'vitest';
import { confirmationPrompt } from '../../src/apps/cli/report.js';
import {
  CONFIRM_MAX,
  CONFIRM_PREFIX,
  confirmableKey,
  readConfirmables,
  renderConfirmable,
} from '../../src/core/tools/confirmation.js';

describe('ce qui est montré est ce qui sera fait', () => {
  /* ================================================================== *
   * LA TRONCATURE — le défaut qui était ACTIF
   * ================================================================== */

  it('une valeur COURTE passe intacte — rien n’est ajouté', () => {
    expect(renderConfirmable('virer 50 € à Paul')).toBe('virer 50 € à Paul');
    expect(renderConfirmable('')).toBe('');
  });

  it('une valeur LONGUE est coupée — et le DIT, avec la longueur réelle', () => {
    /* LE DÉFAUT DU JOUR, PAS UN PIÈGE POUR PLUS TARD.

       `web_search.query` va jusqu'à 256 caractères ; la limite d'affichage est
       à 200. Cinquante-six caractères disparaissaient de ce que l'utilisateur
       confirmait, en silence. Confirmer ce qu'on n'a pas vu n'est pas
       confirmer. */
    const longue = 'a'.repeat(256);
    const rendu = renderConfirmable(longue);

    expect(rendu).toContain('tronqué');
    // La longueur RÉELLE est dite : sans elle, on sait qu'il manque quelque
    // chose sans savoir combien.
    expect(rendu).toContain('256');
    // Et le début reste lisible : une troncature qui montre tout ou rien ne
    // sert à rien.
    expect(rendu.startsWith('a'.repeat(CONFIRM_MAX))).toBe(true);
  });

  it('la LIMITE EXACTE ne déclenche pas de mention — pas de faux positif', () => {
    /* Un seuil qui se déclenche un caractère trop tôt crie au loup, et ce qui
       crie trop finit ignoré. */
    const pile = 'b'.repeat(CONFIRM_MAX);
    expect(renderConfirmable(pile)).toBe(pile);
    expect(renderConfirmable(`${pile}c`)).toContain('tronqué');
  });

  it('un OBJET est rendu lisiblement, jamais « [object Object] »', () => {
    /* Une confirmation qui affiche `[object Object]` ne permet de confirmer
       rien — c'est le commentaire que le Gateway portait déjà, désormais
       éprouvé. */
    const rendu = renderConfirmable({ destinataire: 'Paul', montant: 50 });
    expect(rendu).not.toContain('[object Object]');
    expect(rendu).toContain('Paul');
    expect(rendu).toContain('50');
  });

  it('une valeur NON SÉRIALISABLE ne casse rien', () => {
    // `JSON.stringify` rend `undefined` pour une fonction ou un symbole.
    for (const hostile of [undefined, () => 1, Symbol('x')]) {
      expect(typeof renderConfirmable(hostile)).toBe('string');
    }
  });

  /* ================================================================== *
   * LA LISTE BLANCHE — ce qui a le droit d'être affiché
   * ================================================================== */

  it('ne rend QUE les valeurs préfixées — les métadonnées restent dehors', () => {
    const valeurs = readConfirmables({
      tool: 'payment_send',
      autonomy: 'L3',
      [confirmableKey('montant')]: '50',
      [confirmableKey('destinataire')]: 'Paul',
    });

    expect(valeurs.map((v) => v.nom).sort()).toEqual(['destinataire', 'montant']);
    // Le nom est rendu SANS le préfixe de transport : l'utilisateur n'a pas à
    // connaître la plomberie.
    expect(valeurs.every((v) => !v.nom.startsWith(CONFIRM_PREFIX))).toBe(true);
  });

  it('un paramètre nommé `tool` est MONTRÉ — c’est le piège que la liste noire tendait', () => {
    /* AVANT : la clé était le nom nu, donc `tool` écrasait la métadonnée du
       Gateway, puis les deux consommateurs le filtraient par son nom.
       L'utilisateur confirmait une valeur invisible.

       Aucun outil ne porte ce nom aujourd'hui. C'est précisément pour ça qu'il
       fallait le fermer maintenant : un piège qu'on ne déclenche pas est un
       piège qu'on oublie. */
    const valeurs = readConfirmables({
      tool: 'payment_send',
      autonomy: 'L3',
      [confirmableKey('tool')]: 'valeur-du-parametre-tool',
      [confirmableKey('autonomy')]: 'valeur-du-parametre-autonomy',
    });

    expect(valeurs.map((v) => v.nom).sort()).toEqual(['autonomy', 'tool']);
    expect(valeurs.find((v) => v.nom === 'tool')?.rendu).toBe(
      'valeur-du-parametre-tool',
    );
    // La métadonnée, elle, n'est pas passée : `payment_send` n'apparaît pas.
    expect(valeurs.some((v) => v.rendu === 'payment_send')).toBe(false);
  });

  it('une clé INCONNUE est ignorée, pas affichée — le doute ne s’affiche pas', () => {
    /* Défaut fermé, appliqué à l'affichage : une clé ajoutée demain par un
       autre chemin n'apparaît pas dans ce qu'on demande de confirmer. */
    const valeurs = readConfirmables({ chose_inattendue: 'x', autre: 42 });
    expect(valeurs).toEqual([]);
  });

  it('`undefined` rend une liste vide, jamais une exception', () => {
    expect(readConfirmables(undefined)).toEqual([]);
    expect(readConfirmables({})).toEqual([]);
  });

  /* ================================================================== *
   * L'ORDRE — stable, parce qu'un ordre qui bouge fait relire
   * ================================================================== */

  it('l’ordre est STABLE — deux confirmations identiques se ressemblent', () => {
    /* Un ordre qui change d'un appel à l'autre oblige à relire entièrement, et
       ce qu'on relit trop souvent finit par ne plus être lu. */
    const details = {
      [confirmableKey('zeta')]: 'z',
      [confirmableKey('alpha')]: 'a',
      [confirmableKey('mu')]: 'm',
    };
    const noms = readConfirmables(details).map((v) => v.nom);
    expect(noms).toEqual(['alpha', 'mu', 'zeta']);
    // Et deux lectures successives donnent le même ordre.
    expect(readConfirmables(details).map((v) => v.nom)).toEqual(noms);
  });

  /* ================================================================== *
   * CONTRÔLE NÉGATIF — l'extracteur voit-il vraiment ?
   * ================================================================== */

  it('DÉTECTE une valeur qui perdrait son préfixe en chemin', () => {
    /* Si le Gateway cessait de préfixer, l'utilisateur ne verrait plus RIEN à
       confirmer — un écran vide plutôt qu'un mensonge, mais un écran vide sur
       lequel on tape « oui ». */
    const sansPrefixe = readConfirmables({ montant: '50', destinataire: 'Paul' });
    expect(sansPrefixe).toEqual([]);

    const avecPrefixe = readConfirmables({
      [confirmableKey('montant')]: '50',
    });
    expect(avecPrefixe).toHaveLength(1);
  });

  it('le préfixe et la limite ne sont pas devenus vides ou absurdes', () => {
    // Un préfixe vide ferait tout passer ; une limite nulle tronquerait tout.
    expect(CONFIRM_PREFIX.length).toBeGreaterThan(0);
    expect(CONFIRM_MAX).toBeGreaterThan(50);
    expect(confirmableKey('x')).toBe(`${CONFIRM_PREFIX}x`);
  });
});

/* ====================================================================== *
 * LE RENDU — ce que l'humain lit VRAIMENT avant de dire oui
 * ====================================================================== */

describe('l’invite de confirmation montre tout, et demande clairement', () => {
  /* ⚠ CE BLOC EXISTE PARCE QUE LE BALAYAGE M'A ATTRAPÉ.

     `confirmationPrompt` figurait dans « exports non cités par un test », j'ai
     corrigé le PIPELINE (préfixe, troncature, liste blanche) et laissé le RENDU
     sans test. Le balayage suivant l'a redonné, mot pour mot.

     Une méthode qui ne trouve que ce qu'on avait déjà vu ne vaut rien ; celle-ci
     a trouvé sa propre application incomplète. */

  it('montre CHAQUE valeur reçue — aucune ne disparaît en chemin', () => {
    const rendu = confirmationPrompt('Confirmer ce virement ?', {
      montant: '50 €',
      destinataire: 'Paul',
    });
    expect(rendu).toContain('50 €');
    expect(rendu).toContain('Paul');
    expect(rendu).toContain('Confirmer ce virement ?');
  });

  it('DEMANDE explicitement, et dit quelles réponses il attend', () => {
    /* Une invite qui ne dit pas ce qu'elle attend transforme le doute en
       hasard. `readConfirmation` classe « peut-être » en `UNCLEAR` — encore
       faut-il que l'utilisateur sache qu'on attend « oui » ou « non ». */
    const rendu = confirmationPrompt('Confirmer ?', {});
    expect(rendu.toLowerCase()).toContain('oui');
    expect(rendu.toLowerCase()).toContain('non');
  });

  it('SANS valeur concrète, il montre au moins la raison', () => {
    /* Cas réel : un outil `L3` sans paramètre sensible. Il n'y a rien de
       concret à afficher, et une invite vide serait pire qu'une invite
       laconique — on ne confirme pas un écran blanc. */
    const rendu = confirmationPrompt('Cette action est irréversible.', {});
    expect(rendu).toContain('Cette action est irréversible.');
    expect(rendu.trim().length).toBeGreaterThan(20);
  });

  it('la MENTION DE TRONCATURE survit jusqu’à l’écran', () => {
    /* Le bout de la chaîne : `renderConfirmable` l'a mise dans le texte
       précisément pour qu'aucun affichage n'ait à y penser. On le vérifie
       plutôt que de le supposer. */
    const rendu = confirmationPrompt('Confirmer ?', {
      query: renderConfirmable('x'.repeat(300)),
    });
    expect(rendu).toContain('tronqué');
    expect(rendu).toContain('300');
  });

  it('CONTRÔLE NÉGATIF — une invite vide serait détectée', () => {
    // Sans lui, « montre la raison » passerait sur une fonction qui rend ''.
    expect(confirmationPrompt('', {}).trim().length).toBeGreaterThan(0);
  });
});
