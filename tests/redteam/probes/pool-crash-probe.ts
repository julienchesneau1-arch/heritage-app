/**
 * Sonde — que devient le processus quand la connexion PostgreSQL meurt ?
 *
 * Exécutée dans un processus ENFANT, parce que le défaut recherché est une
 * terminaison de processus : on ne peut pas l'observer depuis le processus qui
 * mourrait avec lui.
 *
 * Déroulé :
 *   1. un relais TCP local se place entre Jarvis et PostgreSQL ;
 *   2. `createDb` s'y connecte et exécute une requête (le pool garde le client) ;
 *   3. le relais coupe brutalement, comme un `systemctl restart postgresql` ;
 *   4. si le processus est toujours vivant après une seconde, il imprime
 *      `SURVECU` et sort en 0. Sinon, il meurt — et c'est le défaut.
 */
import net from 'node:net';
import { createDb } from '../../../src/core/db/client.js';

const UPSTREAM_HOST = process.env['JARVIS_DB_HOST'] ?? '127.0.0.1';
const UPSTREAM_PORT = Number(process.env['JARVIS_DB_PORT'] ?? '5432');

async function main(): Promise<void> {
  const sockets: net.Socket[] = [];

  const relay = net.createServer((downstream) => {
    const upstream = net.connect(UPSTREAM_PORT, UPSTREAM_HOST);
    sockets.push(downstream, upstream);
    downstream.pipe(upstream);
    upstream.pipe(downstream);
    downstream.on('error', () => undefined);
    upstream.on('error', () => undefined);
  });

  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
  const address = relay.address();
  if (address === null || typeof address === 'string') throw new Error('relais sans port');

  const db = createDb({
    host: '127.0.0.1',
    port: address.port,
    database: process.env['JARVIS_DB_NAME'] ?? 'jarvis_test',
    user: process.env['JARVIS_DB_USER'] ?? 'jarvis_app',
    password: process.env['JARVIS_DB_PASSWORD'] ?? '',
  });

  const first = await db.query('SELECT 1 AS ok');
  if (!first.ok) {
    process.stdout.write(`PRECONDITION_ECHOUEE ${first.error.message}\n`);
    process.exit(2);
  }

  // La coupure. Le client reste « inactif » dans le pool : c'est exactement
  // le cas que `pg` signale par un événement `error` sur le Pool.
  for (const socket of sockets) socket.destroy();
  relay.close();

  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Toujours là : le processus a encaissé la coupure. On vérifie en plus que
  // l'erreur suivante est bien une VALEUR typée et non une exception.
  const second = await db.query('SELECT 1 AS ok').catch(() => 'EXCEPTION_LEVEE');
  process.stdout.write(
    second === 'EXCEPTION_LEVEE' ? 'SURVECU_MAIS_LEVE\n' : 'SURVECU\n',
  );
  await db.close().catch(() => undefined);
  process.exit(0);
}

main().catch((error: unknown) => {
  process.stdout.write(
    `SONDE_EN_ERREUR ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(3);
});
