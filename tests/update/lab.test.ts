/**
 * UPDATE ENGINE — le LAB n'a aucun secret de production. `docs/07 §5`.
 *
 * Porte de sortie Phase 7, troisième condition. C'est la propriété qui rend
 * tout le reste sûr : une mise à jour malveillante testée dans le LAB ne peut
 * rien exfiltrer, **parce qu'il n'y a rien à exfiltrer**.
 *
 * ⚠ CE FICHIER MET DE VRAIS SECRETS DANS L'ENVIRONNEMENT, ET C'EST LE POINT.
 * Un test qui vérifierait le refus dans un environnement VIDE ne prouverait
 * rien : un coffre de production refuse aussi un secret absent. On ne saurait
 * pas distinguer « le LAB est privé » de « il n'y avait rien à trouver ».
 */
import { describe, expect, it } from 'vitest';
import {
  coffreEstPrive,
  createLabVault,
  MOTIF_LAB,
} from '../../src/core/update/lab.js';
import { createEnvSecretVault } from '../../src/core/secrets/vault.js';

/**
 * Des noms de secrets RÉELLEMENT utilisés par le produit.
 *
 * Recopiés de `providers/google/calendar.ts` et du chargement de configuration.
 * Un nom inventé rendrait le contrôle infalsifiable — le défaut d'ADR-087.
 */
const NOMS_REELS = [
  'JARVIS_GOOGLE_CLIENT_ID',
  'JARVIS_GOOGLE_CLIENT_SECRET',
  'JARVIS_GOOGLE_REFRESH_TOKEN',
  'JARVIS_DB_PASSWORD',
];

/** Un environnement qui CONTIENT tout ce que le LAB ne doit pas voir. */
const ENV_DE_PRODUCTION: NodeJS.ProcessEnv = {
  JARVIS_GOOGLE_CLIENT_ID: 'identifiant-de-production',
  JARVIS_GOOGLE_CLIENT_SECRET: 'valeur-qui-ne-doit-jamais-sortir',
  JARVIS_GOOGLE_REFRESH_TOKEN: 'jeton-de-rafraichissement-reel',
  JARVIS_DB_PASSWORD: 'mot-de-passe-base-production',
};

describe('le coffre du LAB', () => {
  it('refuse chaque secret RÉEL, alors que l\'environnement les contient', () => {
    /* La comparaison qui donne son sens au test : le même environnement, deux
       coffres, deux comportements opposés. */
    const lab = createLabVault();
    for (const nom of NOMS_REELS) {
      expect(lab.has(nom)).toBe(false);
      const lu = lab.get(nom);
      expect(lu.ok).toBe(false);
    }
  });

  it('un coffre de PRODUCTION, lui, les rend — le contrôle négatif', () => {
    /* ⚠ SANS CE TEST, LE PRÉCÉDENT NE PROUVE RIEN.

       Il démontre que les secrets sont bel et bien atteignables dans cet
       environnement, donc que le refus du LAB est une PROPRIÉTÉ et non une
       absence de matière. */
    const production = createEnvSecretVault(ENV_DE_PRODUCTION);
    expect(production.has('JARVIS_GOOGLE_CLIENT_SECRET')).toBe(true);
    expect(production.get('JARVIS_GOOGLE_CLIENT_SECRET').ok).toBe(true);
  });

  it('refuse aussi un secret que personne n\'a jamais défini', () => {
    const lab = createLabVault();
    expect(lab.get('UN_SECRET_QUI_N_EXISTE_PAS').ok).toBe(false);
  });

  it('le refus porte un MOTIF nommé, pas un échec quelconque', () => {
    /* « Ça a échoué » ne distingue pas un LAB correctement privé d'un coffre
       en panne. Le motif rend la propriété lisible dans un journal. */
    const lu = createLabVault().get('JARVIS_DB_PASSWORD');
    expect(lu.ok).toBe(false);
    if (lu.ok) return;
    expect(lu.error.message).toContain(MOTIF_LAB);
  });

  it('⚠ le message de refus ne contient JAMAIS de valeur', () => {
    /* Un message de défaut de confidentialité ne doit pas être lui-même une
       fuite : il finit dans un journal, puis dans un rapport, puis dans un
       ticket. Le NOM du secret est journalisé, jamais sa valeur. */
    const lu = createLabVault().get('JARVIS_GOOGLE_CLIENT_SECRET');
    expect(lu.ok).toBe(false);
    if (lu.ok) return;
    const tout = JSON.stringify(lu.error);
    expect(tout).not.toContain('valeur-qui-ne-doit-jamais-sortir');
    // …mais il nomme bien le secret demandé : c'est un signal, pas un secret.
    expect(tout).toContain('JARVIS_GOOGLE_CLIENT_SECRET');
  });
});

describe('coffreEstPrive — le contrôle utilisé par la porte de sortie', () => {
  it('accepte le coffre du LAB', () => {
    expect(coffreEstPrive(createLabVault(), NOMS_REELS).ok).toBe(true);
  });

  it('REFUSE un coffre de production — et c\'est ce qui rend la porte utile', () => {
    /* Si ce test passait, la porte de sortie serait décorative : elle
       accepterait le mauvais câblage exactement comme le bon. */
    const verdict = coffreEstPrive(createEnvSecretVault(ENV_DE_PRODUCTION), NOMS_REELS);
    expect(verdict.ok).toBe(false);
  });

  it('refuse une liste VIDE — un contrôle sans matière est décoratif', () => {
    /* Passer `[]` ferait passer n'importe quel coffre, y compris celui de
       production. C'est le défaut d'ADR-087 sous une autre forme : un contrôle
       qui ne peut pas échouer. */
    expect(coffreEstPrive(createLabVault(), []).ok).toBe(false);
  });

  it('ne recopie pas la valeur du secret dans son message d\'erreur', () => {
    const verdict = coffreEstPrive(createEnvSecretVault(ENV_DE_PRODUCTION), NOMS_REELS);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(JSON.stringify(verdict.error)).not.toContain('identifiant-de-production');
  });
});

describe('la garde est de CONSTRUCTION, pas de conduite', () => {
  it('createLabVault n\'accepte aucun paramètre', () => {
    /* ⚠ CE TEST GARDE UNE PROPRIÉTÉ D'API, ET IL EST FRAGILE À DESSEIN.

       Le jour où quelqu'un ajoutera un paramètre « coffre de repli » ou
       « secrets autorisés en LAB », il rougira. C'est exactement le moment où
       il faut relire `docs/07 §5` : une fabrique qui accepte un coffre rouvre
       le trou qu'elle prétend fermer, puisqu'il suffit d'un appelant pressé
       pour lui passer celui de production.

       Ne rien accepter rend le mauvais usage IMPOSSIBLE À ÉCRIRE, pas
       seulement déconseillé. */
    expect(createLabVault.length).toBe(0);
  });
});
