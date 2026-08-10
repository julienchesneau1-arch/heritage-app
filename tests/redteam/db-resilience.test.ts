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
  it('le processus SURVIT à la mort d\'une connexion inactive', async () => {
    // Corrigé (CRIT-1). `pg.Pool` émet `'error'` quand un client INACTIF meurt.
    // Sans écouteur, Node relançait l'événement en exception non capturée et le
    // processus s'arrêtait — CLI comme passerelle web exposée au réseau local.
    //
    // `createDb` installe désormais cet écouteur. Le pool n'est pas « réparé » :
    // il sait recréer une connexion au prochain appel. Ce qui change, c'est
    // qu'une panne banale ne devient plus fatale.
    const result = await probe();
    expect(result.stdout.trim()).toBe('SURVECU');
    expect(result.code).toBe(0);
  }, 45_000);

  it('et l\'erreur suivante reste une VALEUR, pas une exception', async () => {
    // `SURVECU_MAIS_LEVE` signalerait que le processus tient mais que
    // `db.query()` rejette : la moitié du problème seulement.
    const result = await probe();
    expect(result.stdout).not.toContain('SURVECU_MAIS_LEVE');
  }, 45_000);
});
