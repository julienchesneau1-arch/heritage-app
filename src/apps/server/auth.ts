/**
 * Authentification de la passerelle web.
 *
 * Référence : PRD §30 (« une seule passerelle authentifiée », aucune exposition
 * publique), 03 §2.
 *
 * Ouvrir Jarvis au réseau local élargit réellement la surface d'attaque : la
 * mémoire personnelle devient joignable par tout appareil du Wi-Fi. Trois
 * garde-fous, tous obligatoires :
 *
 *   1. jeton fort exigé sur chaque requête, comparé en temps constant ;
 *   2. verrouillage après échecs répétés, par adresse ;
 *   3. refus de démarrer sur une interface publique sans autorisation explicite.
 */
import { timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';

/** Longueur minimale du jeton. 32 caractères base64url ≈ 190 bits. */
export const MIN_TOKEN_LENGTH = 32;

export interface TokenCheck {
  readonly valid: boolean;
  readonly reason?: string;
}

export function validateTokenStrength(token: string | undefined): TokenCheck {
  if (token === undefined || token.length === 0) {
    return {
      valid: false,
      reason:
        'JARVIS_WEB_TOKEN absent. Relancer `pnpm jarvis:setup` pour en générer un.',
    };
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    return {
      valid: false,
      reason: `JARVIS_WEB_TOKEN trop court (${String(token.length)} < ${String(MIN_TOKEN_LENGTH)}).`,
    };
  }
  return { valid: true };
}

/**
 * Comparaison en temps constant.
 *
 * Une comparaison naïve fuit la longueur du préfixe correct par le temps de
 * réponse. Sur un réseau local, c'est exploitable.
 */
export function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // `timingSafeEqual` exige des longueurs égales. On compare quand même
    // quelque chose de la bonne taille pour ne pas révéler la longueur.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** Extrait le jeton d'un en-tête `Authorization: Bearer …`. */
export function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/* -------------------------------------------------------------------------- */
/* Verrouillage après échecs                                                  */
/* -------------------------------------------------------------------------- */

export const MAX_FAILURES = 5;
export const LOCKOUT_MS = 60_000;

interface Attempts {
  failures: number;
  lockedUntil: number;
}

export interface AuthLimiter {
  /** Vrai si l'adresse est actuellement verrouillée. */
  isLocked(address: string, now?: number): boolean;
  /** Enregistre un échec. Renvoie vrai si ce refus vient de déclencher le verrou. */
  recordFailure(address: string, now?: number): boolean;
  recordSuccess(address: string): void;
}

export function createAuthLimiter(): AuthLimiter {
  const attempts = new Map<string, Attempts>();

  return {
    isLocked(address: string, now = Date.now()): boolean {
      const entry = attempts.get(address);
      if (entry === undefined) return false;
      if (entry.lockedUntil > now) return true;
      if (entry.lockedUntil !== 0) {
        // Verrou expiré : on repart de zéro plutôt que de cumuler.
        attempts.delete(address);
      }
      return false;
    },

    recordFailure(address: string, now = Date.now()): boolean {
      const entry = attempts.get(address) ?? { failures: 0, lockedUntil: 0 };
      entry.failures += 1;
      if (entry.failures >= MAX_FAILURES) {
        entry.lockedUntil = now + LOCKOUT_MS;
        entry.failures = 0;
        attempts.set(address, entry);
        return true;
      }
      attempts.set(address, entry);
      return false;
    },

    recordSuccess(address: string): void {
      attempts.delete(address);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Interfaces réseau                                                          */
/* -------------------------------------------------------------------------- */

/** Une adresse IPv4 est-elle privée (RFC 1918) ou locale ? */
export function isPrivateAddress(address: string): boolean {
  if (address.startsWith('127.') || address === '::1') return true;
  if (address.startsWith('10.')) return true;
  if (address.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return true;
  // Lien-local IPv4 et IPv6.
  if (address.startsWith('169.254.') || address.toLowerCase().startsWith('fe80:')) {
    return true;
  }
  // Adresses uniques locales IPv6.
  if (/^f[cd]/i.test(address)) return true;
  return false;
}

export interface InterfaceReport {
  readonly privateAddresses: readonly string[];
  readonly publicAddresses: readonly string[];
}

export interface BindChoice {
  /** Adresse sur laquelle écouter. */
  readonly host: string;
  /** Autres adresses privées de la machine, pour information. */
  readonly others: readonly string[];
  /** À afficher au démarrage. Une décision de réseau ne doit pas être muette. */
  readonly notes: readonly string[];
}

/** Une valeur qui signifie « toutes les interfaces », donc aussi les publiques. */
function isWildcard(address: string): boolean {
  return address === '0.0.0.0' || address === '::' || address === '*';
}

/**
 * Choisit l'adresse d'écoute.
 *
 * PRD §30 : aucune exposition publique. On écoute donc sur **une** adresse
 * privée nommée, jamais sur le joker : une interface qui apparaît plus tard
 * (VPN, partage de connexion) ne doit pas se retrouver servie sans décision.
 *
 * L'ouverture explicite reste possible — `JARVIS_WEB_ALLOW_PUBLIC=yes` — parce
 * qu'un garde-fou qu'on ne peut pas lever se contourne en le retirant du code.
 * Mais elle est refusée par défaut et signalée à chaque démarrage.
 */
export function chooseBindAddress(
  report: InterfaceReport,
  override: string | undefined,
  allowPublic: boolean,
): { ok: true; value: BindChoice } | { ok: false; reason: string } {
  if (override !== undefined && override.length > 0) {
    const risky = isWildcard(override) || !isPrivateAddress(override);
    if (risky && !allowPublic) {
      return {
        ok: false,
        reason:
          `JARVIS_WEB_HOST=${override} exposerait Jarvis hors du réseau local. ` +
          'Refusé (PRD §30). Pour l\'assumer explicitement : JARVIS_WEB_ALLOW_PUBLIC=yes.',
      };
    }
    return {
      ok: true,
      value: {
        host: override,
        others: report.privateAddresses,
        notes: risky
          ? ['⚠ Écoute hors réseau local, autorisée explicitement. Le jeton est la seule barrière.']
          : [],
      },
    };
  }

  const [first, ...rest] = report.privateAddresses;
  if (first === undefined) {
    return {
      ok: true,
      value: {
        host: '127.0.0.1',
        others: [],
        notes: [
          'Aucune interface réseau privée détectée : écoute sur cette machine uniquement.',
          'Le téléphone ne pourra pas se connecter tant que le Wi-Fi n\'est pas actif.',
        ],
      },
    };
  }

  return {
    ok: true,
    value: {
      host: first,
      others: rest,
      notes:
        report.publicAddresses.length > 0
          ? [
              `${String(report.publicAddresses.length)} interface(s) publique(s) détectée(s), non servie(s).`,
            ]
          : [],
    },
  };
}

export function inspectInterfaces(): InterfaceReport {
  const privateAddresses: string[] = [];
  const publicAddresses: string[] = [];

  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.internal) continue;
      if (isPrivateAddress(entry.address)) privateAddresses.push(entry.address);
      else publicAddresses.push(entry.address);
    }
  }
  return { privateAddresses, publicAddresses };
}
