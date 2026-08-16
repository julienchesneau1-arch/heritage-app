/**
 * Authentification et adresse d'écoute de la passerelle web.
 *
 * Référence : PRD §30, 03 §2, ADR-023.
 *
 * Ouvrir Jarvis au Wi-Fi domestique change le modèle de menace : la mémoire
 * personnelle devient joignable par tout appareil du réseau — y compris un
 * objet connecté compromis, qui ne demande la permission de personne pour
 * scanner un port. Ces tests portent sur les garde-fous, pas sur le confort.
 */
/* Couvre **B13** de `docs/05` — volet verrouillage : après cinq échecs
   l'adresse est bloquée, y compris si le bon jeton est présenté ensuite. */
import { describe, expect, it } from 'vitest';
import {
  MAX_FAILURES,
  MIN_TOKEN_LENGTH,
  bearerToken,
  chooseBindAddress,
  createAuthLimiter,
  isPrivateAddress,
  tokenMatches,
  validateTokenStrength,
} from '../../src/apps/server/auth.js';

describe('force du jeton', () => {
  it('refuse un jeton absent', () => {
    const check = validateTokenStrength(undefined);
    expect(check.valid).toBe(false);
    expect(check.reason).toContain('jarvis:setup');
  });

  it('refuse un jeton vide', () => {
    expect(validateTokenStrength('').valid).toBe(false);
  });

  it('refuse un jeton court', () => {
    expect(validateTokenStrength('a'.repeat(MIN_TOKEN_LENGTH - 1)).valid).toBe(false);
  });

  it('accepte un jeton de la longueur générée par le setup', () => {
    // 32 octets → 43 caractères base64url.
    expect(validateTokenStrength('x'.repeat(43)).valid).toBe(true);
  });
});

describe('comparaison de jeton', () => {
  it('accepte le jeton exact', () => {
    expect(tokenMatches('abc', 'abc')).toBe(true);
  });

  it('refuse un jeton différent de même longueur', () => {
    expect(tokenMatches('abd', 'abc')).toBe(false);
  });

  it('refuse un préfixe correct — la longueur ne doit pas suffire', () => {
    expect(tokenMatches('abc', 'abcdef')).toBe(false);
    expect(tokenMatches('abcdef', 'abc')).toBe(false);
  });
});

describe('en-tête Authorization', () => {
  it('extrait un jeton Bearer', () => {
    expect(bearerToken('Bearer abc123')).toBe('abc123');
  });

  it('est insensible à la casse du schéma', () => {
    expect(bearerToken('bearer abc123')).toBe('abc123');
  });

  it('rend null sur un en-tête absent ou d\'un autre schéma', () => {
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken('Basic abc123')).toBeNull();
    expect(bearerToken('abc123')).toBeNull();
  });
});

describe('verrouillage après échecs', () => {
  it('verrouille après MAX_FAILURES et libère à l\'expiration', () => {
    const limiter = createAuthLimiter();
    const now = 1_000_000;

    for (let i = 1; i < MAX_FAILURES; i += 1) {
      expect(limiter.recordFailure('10.0.0.5', now)).toBe(false);
      expect(limiter.isLocked('10.0.0.5', now)).toBe(false);
    }

    expect(limiter.recordFailure('10.0.0.5', now)).toBe(true);
    expect(limiter.isLocked('10.0.0.5', now)).toBe(true);
    expect(limiter.isLocked('10.0.0.5', now + 59_000)).toBe(true);
    expect(limiter.isLocked('10.0.0.5', now + 61_000)).toBe(false);
  });

  it('verrouille par adresse, pas globalement', () => {
    const limiter = createAuthLimiter();
    for (let i = 0; i < MAX_FAILURES; i += 1) limiter.recordFailure('10.0.0.5');
    expect(limiter.isLocked('10.0.0.5')).toBe(true);
    expect(limiter.isLocked('10.0.0.6')).toBe(false);
  });

  it('remet le compteur à zéro après un succès', () => {
    const limiter = createAuthLimiter();
    for (let i = 0; i < MAX_FAILURES - 1; i += 1) limiter.recordFailure('10.0.0.5');
    limiter.recordSuccess('10.0.0.5');
    expect(limiter.recordFailure('10.0.0.5')).toBe(false);
    expect(limiter.isLocked('10.0.0.5')).toBe(false);
  });
});

describe('classification des adresses', () => {
  it('reconnaît les plages privées', () => {
    for (const address of [
      '127.0.0.1',
      '::1',
      '10.1.2.3',
      '192.168.1.20',
      '172.16.0.1',
      '172.31.255.254',
      '169.254.1.1',
      'fe80::1',
      'fd00::1',
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it('reconnaît les adresses publiques', () => {
    for (const address of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '2001:db8::1']) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });
});

describe('choix de l\'adresse d\'écoute', () => {
  const lan = { privateAddresses: ['192.168.1.20', '10.0.0.4'], publicAddresses: [] };

  it('écoute sur la première adresse privée, jamais sur le joker', () => {
    const choice = chooseBindAddress(lan, undefined, false);
    expect(choice.ok).toBe(true);
    if (!choice.ok) return;
    expect(choice.value.host).toBe('192.168.1.20');
    expect(choice.value.others).toEqual(['10.0.0.4']);
  });

  it('refuse une adresse publique explicite sans autorisation', () => {
    const choice = chooseBindAddress(lan, '203.0.113.7', false);
    expect(choice.ok).toBe(false);
    if (choice.ok) return;
    expect(choice.reason).toContain('§30');
  });

  it('refuse le joker 0.0.0.0 : il servirait toute interface future', () => {
    // Le vrai risque n'est pas l'inventaire du moment — c'est le VPN ou le
    // partage de connexion qui apparaît plus tard, sans nouvelle décision.
    const choice = chooseBindAddress(lan, '0.0.0.0', false);
    expect(choice.ok).toBe(false);
  });

  it('autorise l\'exposition seulement si elle est assumée, et le dit', () => {
    const choice = chooseBindAddress(lan, '0.0.0.0', true);
    expect(choice.ok).toBe(true);
    if (!choice.ok) return;
    expect(choice.value.notes.join(' ')).toContain('⚠');
  });

  it('se replie sur la boucle locale quand aucune interface privée n\'existe', () => {
    const choice = chooseBindAddress(
      { privateAddresses: [], publicAddresses: ['203.0.113.7'] },
      undefined,
      false,
    );
    expect(choice.ok).toBe(true);
    if (!choice.ok) return;
    // Pas d'interface privée : on n'ouvre PAS l'interface publique par défaut.
    expect(choice.value.host).toBe('127.0.0.1');
  });

  it('signale les interfaces publiques non servies', () => {
    const choice = chooseBindAddress(
      { privateAddresses: ['192.168.1.20'], publicAddresses: ['203.0.113.7'] },
      undefined,
      false,
    );
    expect(choice.ok).toBe(true);
    if (!choice.ok) return;
    expect(choice.value.host).toBe('192.168.1.20');
    expect(choice.value.notes.join(' ')).toContain('non servie');
  });
});
