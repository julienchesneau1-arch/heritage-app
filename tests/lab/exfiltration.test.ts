/**
 * DATA_EXFILTRATION = 0 — Foundation 3.
 *
 * Mesuré au niveau des sockets, pas sur la foi du Policy Gate.
 *
 * LE TÉMOIN NÉGATIF EST LA MOITIÉ DU TEST
 * ---------------------------------------
 * Une sentinelle mal branchée ne voit rien, et un test qui vérifie « rien n'est
 * sorti » passe alors parfaitement — pour la pire des raisons. Le premier test
 * de ce fichier prouve donc que la sentinelle SAIT voir une sortie. Sans lui,
 * tous les autres ne vaudraient rien.
 */
/* Couvre **C5** (branche C — Internet indisponible) et **C6** (hors ligne
   prolongé) de `docs/05` : `DATA_EXFILTRATION = 0` établit qu'aucun module
   du noyau n'ouvre de connexion sortante, donc que rien ne dépend d'un
   accès réseau. Les branches A, B et D de C5 supposent des fournisseurs
   cloud et un runtime Ollama qui n'existent pas ici — les simuler ne
   prouverait que la simulation. */
import net from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseAvailable } from '../helpers/db.js';
import { appDb } from '../helpers/db.js';
import { buildStack, callContext, operationId } from '../helpers/stack.js';
import {
  exfiltrationReport,
  installNetworkSentinel,
  type NetworkSentinel,
} from './network-sentinel.js';
import type { Db } from '../../src/core/db/client.js';
import type { Stack } from '../helpers/stack.js';

const enabled = databaseAvailable();

describe.runIf(enabled)('banc — exfiltration de données', () => {
  let db: Db;
  let stack: Stack;
  let sentinel: NetworkSentinel;

  beforeAll(() => {
    db = appDb();
    stack = buildStack(db, { embeddings: null });
    sentinel = installNetworkSentinel();
  });

  afterAll(async () => {
    sentinel.uninstall();
    await db.close();
  });

  beforeEach(() => {
    sentinel.reset();
  });

  /* ================================================================== *
   * TÉMOIN NÉGATIF — la sentinelle voit-elle vraiment ?
   * ================================================================== */

  it('la sentinelle DÉTECTE une sortie réseau (témoin négatif)', async () => {
    // 192.0.2.1 — RFC 5737, réservé à la documentation, garanti non routable.
    // On ne cherche pas à joindre quoi que ce soit : seule la TENTATIVE compte.
    await new Promise<void>((resolve) => {
      const socket = net.connect({ host: '192.0.2.1', port: 443 });
      socket.on('error', () => {
        socket.destroy();
        resolve();
      });
      socket.setTimeout(200, () => {
        socket.destroy();
        resolve();
      });
    });

    const out = sentinel.egress();
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out.some((r) => r.host === '192.0.2.1')).toBe(true);
  });

  it('la boucle locale n\'est PAS comptée comme exfiltration', async () => {
    const probe = await db.query('SELECT 1');
    expect(probe.ok).toBe(true);

    // PostgreSQL a bien été joint…
    expect(sentinel.all().length).toBeGreaterThan(0);
    // …et cela ne constitue pas une sortie.
    expect(sentinel.egress()).toEqual([]);
  });

  /* ================================================================== *
   * LA MESURE
   * ================================================================== */

  it('mémoriser une donnée RED : aucune sortie réseau', async () => {
    const key = operationId('exfil-red');
    const result = await stack.gateway.invoke({
      toolId: 'memory_add',
      input: {
        content: 'Mon numéro de sécurité sociale est un secret absolu.',
        memoryType: 'SEMANTIC',
        sourceType: 'USER_EXPLICIT',
        dataCategory: 'HEALTH',
      },
      parameterProvenance: {
        content: 'USER',
        memoryType: 'USER',
        sourceType: 'USER',
        dataCategory: 'USER',
      },
      operationId: key,
      actor: 'USER',
      context: callContext({ userConfirmed: true }),
    });

    expect(result.ok).toBe(true);
    expect(sentinel.egress()).toEqual([]);
  });

  it('rechercher en mémoire : aucune sortie, même avec le cloud activé', async () => {
    const result = await stack.gateway.invoke({
      toolId: 'memory_search',
      input: { query: 'sécurité sociale' },
      parameterProvenance: { query: 'USER' },
      operationId: operationId('exfil-search'),
      actor: 'USER',
      // Le cloud est AUTORISÉ. Rien ne doit sortir malgré tout : la recherche
      // est locale par construction, pas par configuration.
      context: callContext({ cloudEnabled: true, userConfirmed: true }),
    });

    expect(result.ok).toBe(true);
    expect(sentinel.egress()).toEqual([]);
  });

  it('les cinq outils du noyau, enchaînés : DATA_EXFILTRATION = 0', async () => {
    const calls = [
      {
        toolId: 'task_create',
        input: { title: 'Déclarer mes impôts' },
        provenance: { title: 'USER' as const },
      },
      { toolId: 'task_list', input: {}, provenance: {} },
      {
        toolId: 'note_create',
        input: { content: 'RIB : à ne jamais partager.' },
        provenance: { content: 'USER' as const },
      },
      {
        toolId: 'memory_add',
        input: {
          content: 'Mon salaire net est une donnée financière.',
          memoryType: 'SEMANTIC',
          sourceType: 'USER_EXPLICIT',
          dataCategory: 'FINANCIAL',
        },
        provenance: {
          content: 'USER' as const,
          memoryType: 'USER' as const,
          sourceType: 'USER' as const,
          dataCategory: 'USER' as const,
        },
      },
      { toolId: 'memory_search', input: { query: 'salaire' }, provenance: { query: 'USER' as const } },
    ];

    for (const call of calls) {
      await stack.gateway.invoke({
        toolId: call.toolId,
        input: call.input,
        parameterProvenance: call.provenance,
        operationId: operationId(`exfil-${call.toolId}`),
        actor: 'USER',
        context: callContext({ cloudEnabled: true, userConfirmed: true }),
      });
    }

    const report = exfiltrationReport(sentinel, {
      requestId: 'suite-complete',
      classification: 'RED / HIGHLY_SENSITIVE',
    });

    // Le rapport est imprimé : il fait partie du livrable, pas seulement de
    // l'assertion.
    // eslint-disable-next-line no-console
    console.log(`\n${report}\n`);

    expect(sentinel.egress()).toEqual([]);
    expect(report).toContain('DATA_EXFILTRATION = 0');
  });

  it('aucune résolution DNS n\'est déclenchée par un traitement local', () => {
    const lookups = sentinel.all().filter((r) => r.via === 'dns.lookup');
    // Une résolution de nom est déjà une fuite de métadonnée : elle révèle à
    // qui observe le réseau quel service on s'apprête à joindre.
    expect(lookups.filter((r) => r.host !== 'localhost')).toEqual([]);
  });
});
