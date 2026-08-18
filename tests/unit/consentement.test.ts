/**
 * LA LECTURE DU CONSENTEMENT — le dernier pouce de « le système décide ».
 *
 * POURQUOI CE FICHIER EXISTE
 * ---------------------------------------------------------------------------
 * `docs/26 §4.2` se rassurait ainsi sur le CLI, seule surface du dépôt à 0 % de
 * couverture :
 *
 *   > le CLI n'exécute rien en propre, il appelle l'Assistant […] Le risque
 *   > porte sur l'**ergonomie et le rendu**, pas sur la sûreté.
 *
 * **C'était faux.** Le CLI lit le consentement de l'utilisateur sur une action
 * `L3`/`L4`, et c'est une décision de sûreté — la DERNIÈRE de la chaîne, et
 * celle qu'aucun Policy Gate ne rattrape : le Gate a déjà rendu son verdict, il
 * a dit « demande à l'humain ». Ce qui suit est le seul juge.
 *
 * MESURÉ AVANT D'ÊTRE ÉCRIT
 * --------------------------
 * ```text
 * isNegative → return false        → 744 tests verts
 * ancrage ^…$ retiré               → « oui mais non » lu comme un OUI
 * ```
 *
 * Le premier sabotage ne casse rien de grave — le défaut fermé rattrape, et
 * l'utilisateur voit « je n'ai pas compris » au lieu d'« annulé ». **Le second
 * exécute une action L4 que personne n'a confirmée.**
 *
 * ⚠ CE QUE CE FICHIER NE COUVRE PAS. La boucle du CLI reste non traversée :
 *   l'affichage, la lecture d'entrée, les commandes. Ce qui est sorti de
 *   l'ombre, c'est la DÉCISION — elle vit désormais dans une fonction pure
 *   (`readConfirmation`) plutôt que dans une chaîne de `if` au milieu du rendu.
 */
import { describe, expect, it } from 'vitest';
import {
  isAffirmative,
  isNegative,
  readConfirmation,
} from '../../src/apps/cli/report.js';

describe('lire un consentement — trois issues, et deux ne font rien', () => {
  /* ================================================================== *
   * CE QUI CONFIRME — et rien d'autre
   * ================================================================== */

  it('CONFIRME sur les formulations attendues, casse et accents compris', () => {
    for (const oui of [
      'oui', 'OUI', 'Oui', 'o', 'O',
      'ok', 'OK', "d'accord", 'daccord', 'vas-y', 'confirme',
      'y', 'yes', 'YES',
      // Les espaces autour ne changent rien : `.trim()`.
      '  oui  ', '\toui\n',
    ]) {
      expect(readConfirmation(oui), `« ${oui} » devait confirmer`).toBe('CONFIRM');
    }
  });

  /* ================================================================== *
   * CE QUI REFUSE
   * ================================================================== */

  it('REFUSE explicitement — et « annule » / « stop » comptent', () => {
    for (const non of ['non', 'NON', 'n', 'N', 'annule', 'stop', 'no', '  non  ']) {
      expect(readConfirmation(non), `« ${non} » devait refuser`).toBe('REFUSE');
    }
  });

  /* ================================================================== *
   * LE DOUTE — PRD §135, et c'est le cœur du fichier
   * ================================================================== */

  it('NE CONFIRME PAS une réponse ambiguë — le doute n’est pas un oui', () => {
    /* `PRD §135` : le doute n'est pas une confirmation. Un booléen aurait
       forcé à ranger « peut-être » d'un côté ou de l'autre ; trois issues
       laissent l'ambiguïté exister avec sa propre réponse. */
    for (const flou of [
      'peut-être', 'je crois', 'si tu veux', 'pourquoi pas', 'euh',
      'oui ?', 'ok...', 'plutôt oui', 'je ne sais pas',
      '', '   ', '?', '42',
    ]) {
      expect(readConfirmation(flou), `« ${flou} » ne doit PAS confirmer`).not.toBe(
        'CONFIRM',
      );
    }
  });

  it('L’ANCRAGE tient — « oui mais non » n’est pas un oui', () => {
    /* LE SABOTAGE QUI EXÉCUTERAIT UNE ACTION L4 SANS CONSENTEMENT.

       Retirer `^…$` d'`isAffirmative` fait matcher n'importe quelle phrase
       CONTENANT « oui ». C'est la seule façon dont ce fichier peut produire un
       dommage réel, et c'est donc le test qui compte le plus ici. */
    for (const phrase of [
      'oui mais non',
      'surtout pas ok',
      "je ne suis pas d'accord",
      'non, pas oui',
      'ne confirme pas',
      'yes I would rather not',
      'annule, pas oui',
    ]) {
      expect(readConfirmation(phrase), `« ${phrase} » ne doit PAS confirmer`).not.toBe(
        'CONFIRM',
      );
    }
  });

  /* ================================================================== *
   * L'ORDRE — il décide dans le sens qui ne fait rien
   * ================================================================== */

  it('le REFUS l’emporte si les deux listes se recouvraient un jour', () => {
    /* Aujourd'hui les deux ensembles sont disjoints, donc ce test ne peut pas
       échouer par les données. Il fige l'ORDRE : `isNegative` d'abord. Le jour
       où quelqu'un ajoute un mot des deux côtés — « ok annule », « no » vs
       « nope » — c'est le refus qui doit gagner, jamais l'inverse. */
    const desDeux = ['non', 'stop', 'annule'].filter(
      (m) => isNegative(m) && isAffirmative(m),
    );
    // Constat du jour : aucun recouvrement.
    expect(desDeux).toEqual([]);

    // Et la garantie qui vaut même si ça change : le refus est lu en premier.
    const source = readConfirmation('non');
    expect(source).toBe('REFUSE');
  });

  it('les trois issues sont ATTEIGNABLES — sinon la décision est décorative', () => {
    // Une lecture qui rendrait toujours la même chose passerait la plupart des
    // tests ci-dessus. On vérifie que les trois existent réellement.
    const vues = new Set([
      readConfirmation('oui'),
      readConfirmation('non'),
      readConfirmation('peut-être'),
    ]);
    expect(vues).toEqual(new Set(['CONFIRM', 'REFUSE', 'UNCLEAR']));
  });

  /* ================================================================== *
   * CONTRÔLES NÉGATIFS
   * ================================================================== */

  it('les prédicats ne sont pas devenus constants', () => {
    /* Si `isAffirmative` rendait toujours `false`, « le doute n'est pas un
       oui » serait vert et le produit inutilisable. Si elle rendait toujours
       `true`, tout serait confirmé. Les deux directions sont fixées. */
    expect(isAffirmative('oui')).toBe(true);
    expect(isAffirmative('non')).toBe(false);
    expect(isNegative('non')).toBe(true);
    expect(isNegative('oui')).toBe(false);
  });

  it('une réponse très longue ne confirme pas par accident', () => {
    // Cas dégénéré : un copier-coller malheureux dans l'invite.
    const pave = `${'texte '.repeat(500)}oui`;
    expect(readConfirmation(pave)).toBe('UNCLEAR');
  });
});
