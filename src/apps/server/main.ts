/**
 * Jarvis — passerelle web locale.
 *
 * `pnpm jarvis:web` — sert l'interface mobile sur le réseau local, derrière une
 * authentification obligatoire.
 *
 * Référence : PRD §30, 03 §2, ADR-023.
 *
 * CE QUE CETTE COMMANDE CHANGE AU MODÈLE DE MENACE
 * ------------------------------------------------
 * Jusqu'ici, Jarvis n'était joignable que depuis le clavier de la machine. Il
 * l'est maintenant depuis tout appareil du Wi-Fi. C'est un élargissement réel
 * de la surface d'attaque, pas un détail d'ergonomie. Quatre refus de démarrage
 * l'encadrent :
 *
 *   1. pas de jeton fort → refus ;
 *   2. adresse d'écoute hors réseau privé → refus, sauf autorisation explicite ;
 *   3. journal d'audit rompu → refus (on ne sert pas une mémoire dont on ne
 *      peut plus dire ce qui lui est arrivé) ;
 *   4. base injoignable → refus, avec la raison.
 *
 * Le serveur ne traverse aucun chemin qui lui soit propre : il appelle le même
 * Assistant que le CLI, donc le même Policy Gate, le même Memory Guard, le même
 * Verification Engine et le même journal.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { stdout } from 'node:process';
import { openRuntime } from '../runtime.js';
import {
  chooseBindAddress,
  createAuthLimiter,
  inspectInterfaces,
  validateTokenStrength,
} from './auth.js';
import { createHandler, MAX_BODY_BYTES, type HttpRequest } from './http.js';

const DEFAULT_PORT = 7375;

function line(text = ''): void {
  stdout.write(`${text}\n`);
}

function stop(message: string, remedy: string): never {
  line('');
  line(`  ✗ ${message}`);
  line(`  → ${remedy}`);
  line('');
  process.exit(1);
}

/**
 * Lit le corps avec une borne stricte.
 *
 * La borne est appliquée **pendant** la lecture, pas après : un client hostile
 * ne doit pas pouvoir faire grossir la mémoire du processus en envoyant un flux
 * sans fin. C'est le seul point où le serveur accepte des octets d'un inconnu.
 */
async function readBody(request: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.length;
    if (total > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Aplatit les en-têtes sans assertion de type.
 *
 * `IncomingHttpHeaders` autorise `string[]` sur les en-têtes répétables. Un
 * `as` ici masquerait ce cas au lieu de le traiter — et `06` en fait un défaut.
 */
function headersOf(request: IncomingMessage): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

/** Adresse de l'appelant, normalisée. Sert de clé au verrouillage. */
function addressOf(request: IncomingMessage): string {
  const raw = request.socket.remoteAddress ?? 'inconnue';
  // `::ffff:192.168.1.20` et `192.168.1.20` sont le même appareil : sans
  // normalisation, le verrou compterait deux fois plus d'essais.
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

async function main(): Promise<void> {
  line('');
  line('  JARVIS — passerelle web locale');

  /* --- 1. Jeton --------------------------------------------------------- */
  const token = process.env['JARVIS_WEB_TOKEN'];
  const strength = validateTokenStrength(token);
  if (!strength.valid || token === undefined) {
    stop(
      strength.reason ?? 'Jeton invalide.',
      'Relancer `pnpm jarvis:setup` : un jeton est généré dans .env.',
    );
  }

  /* --- 2. Adresse d'écoute ---------------------------------------------- */
  const bind = chooseBindAddress(
    inspectInterfaces(),
    process.env['JARVIS_WEB_HOST'],
    process.env['JARVIS_WEB_ALLOW_PUBLIC'] === 'yes',
  );
  if (!bind.ok) stop(bind.reason, 'Corriger JARVIS_WEB_HOST dans .env.');

  const port = Number(process.env['JARVIS_WEB_PORT'] ?? String(DEFAULT_PORT));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    stop(`JARVIS_WEB_PORT invalide : ${String(process.env['JARVIS_WEB_PORT'])}.`, 'Un entier entre 1 et 65535.');
  }

  /* --- 3. Noyau --------------------------------------------------------- */
  const runtime = openRuntime();
  if (!runtime.ok) {
    stop(runtime.error.message, 'Vérifier PostgreSQL et .env, puis `pnpm jarvis:setup`.');
  }

  /* --- 4. Intégrité du journal ------------------------------------------ */
  // Servir la mémoire sur le réseau alors que la chaîne d'audit est rompue,
  // c'est perdre la capacité de dire ce qui a été fait pendant l'incident.
  const chain = await runtime.value.ledger.verifyChain();
  if (!chain.ok) {
    await runtime.value.close();
    stop(`Journal illisible : ${chain.error.message}`, 'Vérifier la base avant d\'ouvrir l\'accès réseau.');
  }
  if (!chain.value.valid) {
    await runtime.value.close();
    stop(
      `Chaîne d'audit ROMPUE (${chain.value.brokenAt?.reason ?? 'raison inconnue'}).`,
      'Ne pas ouvrir l\'accès réseau tant que l\'intégrité du journal n\'est pas rétablie.',
    );
  }

  const session = await runtime.value.sessions.start('NORMAL');
  if (!session.ok) {
    await runtime.value.close();
    stop(session.error.message, 'Vérifier la base.');
  }

  const handle = createHandler({
    runtime: runtime.value,
    token,
    limiter: createAuthLimiter(),
    sessionId: session.value.id,
    onError: (error: unknown) => {
      line(`  ! défaut interne : ${error instanceof Error ? error.message : 'inconnu'}`);
    },
  });

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const body = await readBody(request);
      const url = new URL(request.url ?? '/', 'http://localhost');

      const reply = body === null
        ? {
            status: 413,
            headers: { 'content-type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ message: 'Requête trop volumineuse.' }),
          }
        : await handle({
            method: request.method ?? 'GET',
            path: url.pathname,
            headers: headersOf(request),
            body,
            address: addressOf(request),
          } satisfies HttpRequest);

      response.writeHead(reply.status, reply.headers);
      // Une réponse à HEAD ne porte pas de corps.
      response.end(request.method === 'HEAD' ? undefined : reply.body);

      // Journal minimal : ni jeton, ni contenu. Le chemin et le code suffisent
      // à repérer une tentative répétée.
      line(`  ${request.method ?? '?'} ${url.pathname} → ${String(reply.status)}`);
    })();
  });

  server.on('error', (error: Error) => {
    stop(
      `Impossible d'écouter sur ${bind.value.host}:${String(port)} — ${error.message}`,
      'Le port est peut-être déjà pris : JARVIS_WEB_PORT=7376 pnpm jarvis:web',
    );
  });

  server.listen(port, bind.value.host, () => {
    const url = `http://${bind.value.host}:${String(port)}`;
    const loopbackOnly = bind.value.host === '127.0.0.1' || bind.value.host === '::1';
    line('');
    for (const note of bind.value.notes) line(`  ${note}`);
    line(
      loopbackOnly
        ? '  Ouvre ce lien sur CETTE machine :'
        : '  Ouvre ce lien sur le téléphone, connecté au même Wi-Fi :',
    );
    line('');
    line(`    ${url}/#t=${token}`);
    line('');
    line('  Le jeton est dans le FRAGMENT (#) : il n\'est jamais transmis au');
    line('  serveur ni écrit dans un journal. Le navigateur le range une fois,');
    line('  puis l\'envoie en en-tête à chaque requête.');
    if (bind.value.others.length > 0) {
      line('');
      line(`  Autres adresses de cette machine, non servies : ${bind.value.others.join(', ')}`);
      line('  (pour en servir une autre : JARVIS_WEB_HOST=<adresse> pnpm jarvis:web)');
    }
    line('');
    line('  Ctrl-C pour arrêter.');
  });

  const shutdown = (): void => {
    line('');
    line('  Arrêt…');
    server.close(() => {
      void (async () => {
        await runtime.value.sessions.end(session.value.id);
        await runtime.value.close();
        line('  À bientôt.');
        process.exit(0);
      })();
    });
    // Les connexions ouvertes (onglet du téléphone) empêcheraient la fermeture.
    server.closeAllConnections();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  line(`\n  ✗ Interrompu : ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
