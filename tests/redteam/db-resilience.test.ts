/**
 * RED TEAM — survie à une coupure de PostgreSQL.
 *
 * Le scénario n'a rien d'exotique : `brew services restart postgresql`, une
 * mise à jour système, une mise en veille du Mac, un basculement réseau. Un
 * assistant personnel qui doit tourner en permanence les rencontrera.
 *
 * `QUICKSTART.md` affirme : « Coupez PostgreSQL en cours de route : vous
 * obtiendrez `?` ou `✗`, jamais un faux succès. » Ce fichier met cette phrase
 * à l'épreuve — et la sonde tourne dans un processus enfant, parce que le
 * comportement observé est une TERMINAISON de processus.
 */
import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { databaseAvailable } from '../helpers/db.js';

const run = promisify(execFile);
const skip = !databaseAvailable();

interface ProbeResult {
  readonly code: number;
  readonly stdout: string;
}

async function probe(): Promise<ProbeResult> {
  const script = join(process.cwd(), 'tests', 'redteam', 'probes', 'pool-crash-probe.ts');
  try {
    const { stdout } = await run('npx', ['tsx', script], {
      env: { ...process.env },
      timeout: 30_000,
    });
    return { code: 0, stdout };
  } catch (error: unknown) {
    const detail: Record<string, unknown> =
      typeof error === 'object' && error !== null ? { ...error } : {};
    return {
      code: typeof detail['code'] === 'number' ? detail['code'] : 1,
      stdout: typeof detail['stdout'] === 'string' ? detail['stdout'] : '',
    };
  }
}

describe.skipIf(skip)('RED TEAM — coupure de PostgreSQL', () => {
  it.fails(
    'DÉFAUT — le processus doit survivre à la mort d\'une connexion inactive',
    async () => {
      // `pg.Pool` émet un événement `error` quand un client INACTIF meurt.
      // `createDb` n'installe aucun écouteur. En Node, un événement `error`
      // sans écouteur est relancé en exception non capturée : le processus
      // meurt, quoi qu'il fasse à ce moment-là.
      //
      // Portée : le CLI, mais aussi `pnpm jarvis:web`, qui est exposé au
      // réseau local. N'importe qui pouvant provoquer un redémarrage de la
      // base peut donc arrêter la passerelle.
      const result = await probe();
      expect(result.stdout.trim()).toBe('SURVECU');
      expect(result.code).toBe(0);
    },
    45_000,
  );

  it('DÉMONSTRATION — le processus meurt effectivement, code de sortie non nul', async () => {
    const result = await probe();
    expect(result.code).not.toBe(0);
    expect(result.stdout).not.toContain('SURVECU');
  }, 45_000);
});
