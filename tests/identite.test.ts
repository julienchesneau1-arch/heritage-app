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

describe('Jeton familial', () => {
  it('reconnaît un jeton qu’il a signé', () => {
    expect(verifyFamilyToken(signFamilyToken('fam_1'))).toBe('fam_1');
  });

  it('refuse une signature altérée', () => {
    const token = signFamilyToken('fam_1');
    expect(verifyFamilyToken(`${token.slice(0, -1)}0`)).toBeNull();
  });

  it('refuse qu’on remplace l’identifiant de famille', () => {
    const [, mac] = signFamilyToken('fam_1').split('.');
    expect(verifyFamilyToken(`fam_2.${mac}`)).toBeNull();
  });

  it('refuse une valeur vide ou malformée', () => {
    for (const value of [undefined, '', 'sansPoint', '.mac', 'fam_1.']) {
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
