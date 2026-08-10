/**
 * SENTINELLE RÉSEAU — banc de défaillance, Foundation 3.
 *
 * Le mandat est explicite, et il a raison de l'être :
 *
 *   > Et pas simplement parce que le logiciel le prétend. Il faut
 *   > éventuellement instrumenter les sorties réseau dans l'environnement de
 *   > test.
 *
 * Un test qui vérifie « le Policy Gate a répondu DENY » ne mesure pas
 * l'exfiltration : il mesure notre intention. Si un composant contournait le
 * Gate — un SDK bavard, une télémétrie, un `fetch` oublié dans une dépendance
 * — ce test resterait vert pendant que la donnée partirait.
 *
 * Cette sentinelle se place SOUS tout le code applicatif, au niveau des
 * primitives réseau de Node. Elle voit ce qui part, quelle que soit la couche
 * qui l'a décidé.
 *
 * ⚠ INFRASTRUCTURE DE TEST.
 */
import net from 'node:net';
import dns from 'node:dns';

export interface EgressRecord {
  readonly host: string;
  readonly port: number;
  /** Primitive interceptée : `socket.connect`, `dns.lookup`… */
  readonly via: string;
  readonly at: number;
}

export interface NetworkSentinel {
  /** Tout ce qui a été tenté, y compris vers la boucle locale. */
  all(): readonly EgressRecord[];
  /** Ce qui SORT réellement de la machine. C'est la mesure du mandat. */
  egress(): readonly EgressRecord[];
  reset(): void;
  uninstall(): void;
}

/**
 * Une destination quitte-t-elle la machine ?
 *
 * PostgreSQL sur `127.0.0.1` et un moteur d'inférence sur `localhost` sont des
 * appels LOCAUX : les compter comme exfiltration rendrait la mesure inutile.
 * Tout le reste est une sortie, y compris une adresse privée de LAN — une
 * imprimante réseau ou un NAS reste hors de la machine.
 */
function isLoopback(host: string): boolean {
  if (host === 'localhost' || host === '::1' || host === '') return true;
  if (host.startsWith('127.')) return true;
  // Forme mappée IPv4 de la boucle locale.
  if (host.startsWith('::ffff:127.')) return true;
  return false;
}

/**
 * Extrait hôte et port d'un appel `connect`, quelle que soit sa signature.
 *
 * ⚠ Le cas du TABLEAU n'est pas théorique, et il a failli rendre cette
 * sentinelle inutile. `net.connect(options)` ne transmet pas `options` à
 * `socket.connect` : il appelle `normalizeArgs()` puis passe le TABLEAU
 * `[options, callback]`. Sans ce déballage, chaque sortie était enregistrée
 * comme `localhost:0` — donc classée « boucle locale », donc invisible.
 *
 * Le témoin négatif de `exfiltration.test.ts` a attrapé exactement cela. Une
 * sentinelle aveugle rend tous les tests verts.
 */
function destinationOf(args: readonly unknown[]): { host: string; port: number } {
  const first = args[0];

  // connect([options, callback]) — forme normalisée interne de Node.
  if (Array.isArray(first)) {
    return destinationOf(first as readonly unknown[]);
  }

  // connect(options, ...)
  if (typeof first === 'object' && first !== null) {
    const options = first as Record<string, unknown>;
    // Une socket UNIX n'a pas d'hôte : c'est un chemin, donc local.
    if (typeof options['path'] === 'string') {
      return { host: 'unix-socket', port: 0 };
    }
    return {
      host: typeof options['host'] === 'string' ? options['host'] : 'localhost',
      port: typeof options['port'] === 'number' ? options['port'] : 0,
    };
  }

  // connect(port, host?, ...)
  const port = typeof first === 'number' ? first : Number(first ?? 0);
  const second = args[1];
  return {
    host: typeof second === 'string' ? second : 'localhost',
    port: Number.isFinite(port) ? port : 0,
  };
}

/**
 * Installe la sentinelle.
 *
 * `tls.connect`, `http.request`, `https.request` et `fetch` finissent tous par
 * ouvrir une `net.Socket` : intercepter `connect` les couvre tous d'un coup,
 * sans avoir à deviner la pile utilisée par chaque dépendance.
 *
 * `dns.lookup` est intercepté en plus, et ce n'est pas redondant : une simple
 * résolution de nom révèle déjà à un observateur réseau quel service on
 * s'apprête à joindre. C'est une fuite de métadonnée, avant même l'octet.
 */
export function installNetworkSentinel(): NetworkSentinel {
  const records: EgressRecord[] = [];

  const socketConnect = Object.getOwnPropertyDescriptor(
    net.Socket.prototype,
    'connect',
  );
  const dnsLookup = Object.getOwnPropertyDescriptor(dns, 'lookup');

  if (socketConnect?.value === undefined) {
    throw new Error('net.Socket.prototype.connect introuvable : sentinelle inopérante.');
  }

  const originalConnect = socketConnect.value as (
    this: net.Socket,
    ...args: unknown[]
  ) => net.Socket;

  Object.defineProperty(net.Socket.prototype, 'connect', {
    ...socketConnect,
    value: function patchedConnect(this: net.Socket, ...args: unknown[]): net.Socket {
      const { host, port } = destinationOf(args);
      records.push({ host, port, via: 'socket.connect', at: Date.now() });
      return originalConnect.apply(this, args);
    },
  });

  if (dnsLookup?.value !== undefined) {
    const originalLookup = dnsLookup.value as (...args: unknown[]) => unknown;
    Object.defineProperty(dns, 'lookup', {
      ...dnsLookup,
      value: function patchedLookup(...args: unknown[]): unknown {
        const hostname = typeof args[0] === 'string' ? args[0] : 'inconnu';
        records.push({ host: hostname, port: 0, via: 'dns.lookup', at: Date.now() });
        return originalLookup.apply(dns, args);
      },
    });
  }

  return {
    all: () => [...records],
    egress: () => records.filter((r) => !isLoopback(r.host) && r.host !== 'unix-socket'),
    reset: () => {
      records.length = 0;
    },
    uninstall: () => {
      Object.defineProperty(net.Socket.prototype, 'connect', socketConnect);
      if (dnsLookup !== undefined) Object.defineProperty(dns, 'lookup', dnsLookup);
    },
  };
}

/**
 * Rapport lisible, tel que demandé par le mandat §9.
 *
 * Sa vertu est d'être VÉRIFIABLE : chaque ligne vient d'une interception, pas
 * d'une déclaration du code applicatif.
 */
export function exfiltrationReport(
  sentinel: NetworkSentinel,
  context: { requestId: string; classification: string },
): string {
  const out = sentinel.egress();
  const lines = [
    `Request ID: ${context.requestId}`,
    `Classification: ${context.classification}`,
    '',
    'Réseau (interceptions réelles) :',
  ];

  if (out.length === 0) {
    lines.push('  aucune connexion hors de la machine');
  } else {
    for (const record of out) {
      lines.push(`  ⚠ ${record.host}:${String(record.port)} via ${record.via}`);
    }
  }

  lines.push(
    '',
    `Local : ${String(sentinel.all().length - out.length)} connexion(s) sur la boucle locale`,
    '',
    `DATA_EXFILTRATION = ${String(out.length)}`,
  );

  return lines.join('\n');
}
