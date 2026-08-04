import { describe, expect, it } from 'vitest';
import {
  signFamilyToken,
  signMemberCookie,
  signMemberToken,
  verifyFamilyToken,
  verifyMemberCookie,
  verifyMemberToken,
} from '@/lib/session';

/**
 * La faille corrigée : l'identité d'un membre était choisie librement dans
 * une liste, et la suppression la vérifiait contre un paramètre d'URL fourni
 * par l'appelant. Ces tests fixent le nouveau contrat.
 */

describe('Jeton familial — révocable, lui aussi', () => {
  it('reconnaît un jeton qu’il a signé, et rend sa version', () => {
    expect(verifyFamilyToken(signFamilyToken('fam_1'))).toEqual({
      familyId: 'fam_1',
      tokenVersion: 1,
    });
  });

  it('refuse une signature altérée', () => {
    const token = signFamilyToken('fam_1');
    expect(verifyFamilyToken(`${token.slice(0, -1)}0`)).toBeNull();
  });

  it('refuse qu’on remplace l’identifiant de famille', () => {
    const [, version, mac] = signFamilyToken('fam_1').split('.');
    expect(verifyFamilyToken(`fam_2.${version}.${mac}`)).toBeNull();
  });

  /**
   * Le cœur de « Changer ce lien ». Le lien familial EST le secret de la
   * §4.1 : publié par erreur, il n'avait aucun recours. Réécrire la version
   * dans le jeton ne sert à rien — elle entre dans la signature.
   */
  it('refuse qu’on réécrive la version pour survivre à une rotation', () => {
    const [familyId, , mac] = signFamilyToken('fam_1', 1).split('.');
    expect(verifyFamilyToken(`${familyId}.2.${mac}`)).toBeNull();
  });

  it('signe des jetons distincts par version', () => {
    expect(signFamilyToken('fam_1', 1)).not.toBe(signFamilyToken('fam_1', 2));
    expect(verifyFamilyToken(signFamilyToken('fam_1', 7))).toEqual({
      familyId: 'fam_1',
      tokenVersion: 7,
    });
  });

  it('refuse une valeur vide ou malformée', () => {
    for (const value of [undefined, '', 'sansPoint', '.mac', 'fam_1.', 'fam_1.1', 'fam_1.x.mac', 'fam_1.0.mac']) {
      expect(verifyFamilyToken(value as string | undefined)).toBeNull();
    }
  });
});

describe('Cookie de membre — le niveau d’identité est signé', () => {
  it('conserve le membre et son niveau', () => {
    expect(verifyMemberCookie(signMemberCookie('mem_1', 'declared'))).toEqual({
      memberId: 'mem_1',
      level: 'declared',
    });
  });

  it('interdit de se promouvoir « vérifié » en réécrivant le cookie', () => {
    // Le cœur du correctif : sans signature du NIVEAU, il suffirait de
    // remplacer « declared » par « verified » pour gagner le droit de supprimer.
    const cookie = signMemberCookie('mem_1', 'declared');
    const [memberId, , mac] = cookie.split('.');
    expect(verifyMemberCookie(`${memberId}.verified.${mac}`)).toBeNull();
  });

  it('interdit de se faire passer pour un autre membre', () => {
    const cookie = signMemberCookie('mem_1', 'verified');
    const [, level, mac] = cookie.split('.');
    expect(verifyMemberCookie(`mem_2.${level}.${mac}`)).toBeNull();
  });

  it('refuse un niveau inconnu', () => {
    expect(verifyMemberCookie(signMemberCookie('mem_1', 'admin' as never))).toBeNull();
  });
});

describe('Lien personnel — révocable individuellement', () => {
  it('valide le jeton de la version courante', () => {
    expect(verifyMemberToken('mem_1', 3, signMemberToken('mem_1', 3))).toBe(true);
  });

  it('invalide le jeton dès que la version change', () => {
    // C'est la révocation : incrémenter tokenVersion pour UN membre.
    const ancien = signMemberToken('mem_1', 3);
    expect(verifyMemberToken('mem_1', 4, ancien)).toBe(false);
  });

  it('ne vaut que pour le membre auquel il a été remis', () => {
    expect(verifyMemberToken('mem_2', 3, signMemberToken('mem_1', 3))).toBe(false);
  });

  it('révoquer un membre laisse les autres intacts', () => {
    const autre = signMemberToken('mem_2', 1);
    expect(verifyMemberToken('mem_1', 2, signMemberToken('mem_1', 1))).toBe(false);
    expect(verifyMemberToken('mem_2', 1, autre)).toBe(true);
  });
});

describe('La clé de signature refuse de partir en production sans être changée', () => {
  /**
   * Le repli de développement est une constante publiée dans un dépôt
   * public. Servie en ligne, elle rend forgeable le cookie de n'importe
   * quelle famille : il suffit de lire le code source. Le produit doit
   * refuser de démarrer plutôt que d'ouvrir la porte en silence.
   */
  const original = { env: process.env.NODE_ENV, secret: process.env.FAMILY_TOKEN_SECRET };

  function withEnv(nodeEnv: string, secret: string | undefined, fn: () => void) {
    const env = process.env as Record<string, string | undefined>;
    env.NODE_ENV = nodeEnv;
    if (secret === undefined) delete env.FAMILY_TOKEN_SECRET;
    else env.FAMILY_TOKEN_SECRET = secret;
    try {
      fn();
    } finally {
      env.NODE_ENV = original.env;
      if (original.secret === undefined) delete env.FAMILY_TOKEN_SECRET;
      else env.FAMILY_TOKEN_SECRET = original.secret;
    }
  }

  it('refuse une clé absente en production', () => {
    withEnv('production', undefined, () => {
      expect(() => signFamilyToken('fam_1')).toThrow(/FAMILY_TOKEN_SECRET/);
    });
  });

  it('refuse la clé de développement en production', () => {
    withEnv('production', 'dev-secret-non-securise', () => {
      expect(() => signFamilyToken('fam_1')).toThrow(/valeur de développement/);
    });
  });

  it('refuse une clé trop courte pour un HMAC sérieux', () => {
    withEnv('production', 'trop-court', () => {
      expect(() => signFamilyToken('fam_1')).toThrow(/au moins 32/);
    });
  });

  it('accepte une clé convenable', () => {
    withEnv('production', 'a'.repeat(64), () => {
      expect(() => signFamilyToken('fam_1')).not.toThrow();
    });
  });

  it('laisse le développement tranquille', () => {
    withEnv('development', undefined, () => {
      expect(() => signFamilyToken('fam_1')).not.toThrow();
    });
  });
});
