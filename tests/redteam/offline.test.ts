/**
 * RED TEAM — preuve d'absence de sortie réseau.
 *
 * Référence : invariants I2 et I5, 03 §6, PRD §30.
 *
 * « Aucun appel réseau » est une affirmation forte. Ce fichier la traite comme
 * une hypothèse à réfuter : on instrumente les primitives réseau de Node
 * (`net.Socket.prototype.connect`, `dns.lookup`, `fetch`), on fait tourner une
 * session Jarvis complète, et on inspecte ce qui a réellement été appelé.
 *
 * PORTÉE — à lire avant de conclure quoi que ce soit
 * --------------------------------------------------
 * Cette instrumentation observe le processus Node courant. Elle ne verrait pas
 * une sortie effectuée par un binaire externe, par un module natif contournant
 * `net`, ou par PostgreSQL lui-même. Elle prouve donc : *le noyau Jarvis
 * n'ouvre aucune connexion hors boucle locale pendant ces scénarios*. Rien de
 * plus — et c'est déjà ce que le marché ne prouve pas.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import dns from 'node:dns';
import { z } from 'zod';
import type { Db } from '../../src/core/db/client.js';
import { appDb, databaseAvailable, withLedgerExclusive } from '../helpers/db.js';
import { buildRuntime, type Runtime } from '../../src/apps/runtime.js';

const skip = !databaseAvailable();

interface Attempt {
  readonly kind: 'socket' | 'dns' | 'fetch';
  readonly target: string;
}

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|localhost)$/;

/**
 * La méthode d'origine, récupérée sans assertion de type.
 *
 * `06` interdit un `as` sur une frontière, et lire une propriété d'un
 * descripteur EST une frontière : rien ne garantit statiquement ce qu'on y
 * trouve. Zod le vérifie à l'exécution.
 */
const ConnectFn = z.custom<(this: net.Socket, ...args: unknown[]) => net.Socket>(
  (value) => typeof value === 'function',
  { message: 'net.Socket.prototype.connect introuvable' },
);

/** Rend une valeur inconnue lisible, sans jamais produire « [object Object] ». */
function label(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return 'inconnu';
  return JSON.stringify(value) ?? 'inconnu';
}

/** Extrait l'hôte visé d'un appel à `Socket.connect`, quelle que soit sa forme. */
function describeTarget(args: readonly unknown[]): string {
  const first = args[0];
  if (typeof first === 'string') return first;
  if (typeof first === 'number') return label(args[1] ?? 'localhost');
  if (typeof first === 'object' && first !== null) {
    const options: Record<string, unknown> = { ...first };
    return label(options['host'] ?? options['path'] ?? 'inconnu');
  }
  return 'inconnu';
}

describe.skipIf(skip)('RED TEAM — rien ne sort de la machine', () => {
  let db: Db;
  let runtime: Runtime;
  let attempts: Attempt[] = [];

  // Copie liée : la méthode est réappliquée explicitement plus bas, jamais
  // détachée de son objet.
  const connectDescriptor = Object.getOwnPropertyDescriptor(
    net.Socket.prototype,
    'connect',
  );
  const realConnect = ConnectFn.parse(connectDescriptor?.value);
  const realLookup = dns.lookup;
  const realFetch = globalThis.fetch;

  beforeAll(() => {
    db = appDb();
    const built = buildRuntime(appDb());
    if (!built.ok) throw new Error(built.error.message);
    runtime = built.value;
  });

  afterAll(async () => {
    await runtime.close();
    await db.close();
  });

  beforeEach(() => {
    attempts = [];

    // On enregistre au lieu de bloquer : bloquer prouverait que Jarvis survit
    // à une coupure, pas qu'il n'appelle personne. Ce sont deux questions
    // différentes, et celle-ci est la plus intéressante.
    Object.defineProperty(net.Socket.prototype, 'connect', {
      configurable: true,
      writable: true,
      value: function patched(this: net.Socket, ...args: unknown[]): net.Socket {
        attempts.push({ kind: 'socket', target: describeTarget(args) });
        return realConnect.apply(this, args);
      },
    });

    Object.defineProperty(dns, 'lookup', {
      configurable: true,
      writable: true,
      value: (...args: unknown[]): void => {
        attempts.push({ kind: 'dns', target: label(args[0]) });
        Reflect.apply(realLookup, dns, args);
      },
    });

    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: (...args: unknown[]): never => {
        attempts.push({ kind: 'fetch', target: label(args[0]) });
        throw new Error('APPEL RÉSEAU SORTANT INATTENDU');
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(net.Socket.prototype, 'connect', {
      configurable: true,
      writable: true,
      value: realConnect,
    });
    Object.defineProperty(dns, 'lookup', {
      configurable: true,
      writable: true,
      value: realLookup,
    });
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: realFetch,
    });
  });

  function offenders(): readonly Attempt[] {
    return attempts.filter((a) => {
      if (a.kind === 'fetch') return true;
      if (a.target.startsWith('/')) return false; // socket UNIX locale
      return !LOOPBACK.test(a.target);
    });
  }

  it('une session complète n\'ouvre aucune connexion hors boucle locale', async () => {
    const tag = `offline-${String(Date.now())}`;

    await runtime.assistant.say(`Retiens que ${tag} est un test hors ligne`);
    await runtime.assistant.say(`Que sais-tu sur ${tag}`);
    await runtime.assistant.say(`Ajoute ${tag} à ma liste`);
    await runtime.assistant.say('mes tâches');
    await runtime.assistant.say(`note ${tag}`);

    expect(offenders()).toEqual([]);
  });

  it('la lecture du journal d\'audit ne sort pas non plus', async () => {
    // Accès exclusif : `ledger-chain.test.ts` corrompt volontairement ce
    // journal partagé (voir `withLedgerExclusive`).
    const chain = await withLedgerExclusive(db, () => runtime.ledger.verifyChain());
    expect(chain.ok).toBe(true);
    await runtime.ledger.recent(50);
    expect(offenders()).toEqual([]);
  });

  it('l\'analyse d\'intention seule n\'ouvre AUCUNE connexion, même locale', () => {
    // Tier 0 : des règles, pas un modèle. Aucune base, aucun serveur
    // d'inférence. C'est la propriété qui rend Jarvis utilisable sur un
    // ordinateur débranché du monde.
    for (const phrase of [
      'Ajoute du café à ma liste',
      'Retiens que le compteur est au sous-sol',
      'Que sais-tu sur le compteur',
      'zzz flurb',
      'Envoie un mail à Paul',
    ]) {
      runtime.intent.propose(phrase);
    }
    expect(attempts).toEqual([]);
  });

  it('aucune télémétrie n\'est émise au chargement du noyau', () => {
    const built = buildRuntime(db);
    expect(built.ok).toBe(true);
    expect(offenders()).toEqual([]);
  });
});
