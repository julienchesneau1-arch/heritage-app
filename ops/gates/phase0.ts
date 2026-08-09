/**
 * Porte de sortie Phase 0 — vérification exécutable.
 *
 * `02` définit la porte comme une liste de conditions vérifiables. Ce script
 * les vérifie réellement, une par une, et refuse de déclarer la phase franchie
 * si une seule échoue.
 *
 * Une porte cochée à la main n'est pas une porte. C'est un souhait.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

interface Check {
  readonly id: string;
  readonly label: string;
  run(): Promise<boolean> | boolean;
}

function run(command: string, args: readonly string[]): boolean {
  try {
    execFileSync(command, [...args], { stdio: 'pipe', env: process.env });
    return true;
  } catch {
    return false;
  }
}

async function withDb<T>(
  user: string,
  password: string,
  fn: (c: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({
    host: process.env['JARVIS_DB_HOST'] ?? '127.0.0.1',
    port: Number(process.env['JARVIS_DB_PORT'] ?? '5432'),
    database: process.env['JARVIS_DB_NAME'] ?? 'jarvis_test',
    user,
    password,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const dbConfigured =
  process.env['JARVIS_DB_PASSWORD'] !== undefined &&
  process.env['JARVIS_DB_PASSWORD'] !== '';

const checks: readonly Check[] = [
  {
    id: 'G0.1',
    label: 'Typage strict : `tsc --noEmit` passe',
    run: () => run('pnpm', ['typecheck']),
  },
  {
    id: 'G0.2',
    label: 'Lint passe',
    run: () => run('pnpm', ['lint']),
  },
  {
    id: 'G0.3',
    label: 'Configuration hors code : config/ et policies/ existent',
    run: () =>
      existsSync(join(process.cwd(), 'config', 'default.json')) &&
      existsSync(join(process.cwd(), 'config', 'environments')) &&
      existsSync(join(process.cwd(), 'policies')),
  },
  {
    id: 'G0.4',
    label: 'Séparation des environnements : dev / test / lab / production',
    run: () =>
      ['dev', 'test', 'lab', 'production'].every((e) =>
        existsSync(join(process.cwd(), 'config', 'environments', `${e}.json`)),
      ),
  },
  {
    id: 'G0.5',
    label: 'Migration et rollback testés dans les deux sens',
    run: () =>
      run('pnpm', ['db:rollback']) &&
      run('pnpm', ['db:migrate']) &&
      run('pnpm', ['db:status']),
  },
  {
    id: 'G0.6',
    label: 'Journal inaltérable : le rôle applicatif n\'a que SELECT et INSERT',
    async run() {
      if (!dbConfigured) return false;
      return withDb(
        process.env['JARVIS_DB_USER'] ?? 'jarvis_app',
        process.env['JARVIS_DB_PASSWORD'] ?? '',
        async (c) => {
          const rows = await c.query<{ privilege_type: string }>(
            `SELECT privilege_type FROM information_schema.table_privileges
              WHERE table_name = 'event_ledger' AND grantee = $1`,
            [process.env['JARVIS_DB_USER'] ?? 'jarvis_app'],
          );
          const privileges = rows.rows.map((r) => r.privilege_type).sort();
          return (
            privileges.length === 2 &&
            privileges[0] === 'INSERT' &&
            privileges[1] === 'SELECT'
          );
        },
      );
    },
  },
  {
    id: 'G0.7',
    label: 'Journal inaltérable : UPDATE refusé en pratique',
    async run() {
      if (!dbConfigured) return false;
      return withDb(
        process.env['JARVIS_DB_USER'] ?? 'jarvis_app',
        process.env['JARVIS_DB_PASSWORD'] ?? '',
        async (c) => {
          try {
            await c.query("UPDATE event_ledger SET status = 'CONFIRMED'");
            return false; // l'UPDATE a réussi : la protection est absente
          } catch {
            return true;
          }
        },
      );
    },
  },
  {
    id: 'G0.8',
    label: 'Test de contrat fournisseur (dont le test négatif) passe',
    run: () => run('pnpm', ['test:contracts']),
  },
  {
    id: 'G0.9',
    label: 'Tests de politique passent',
    run: () => run('pnpm', ['test:policy']),
  },
  {
    id: 'G0.10',
    label: 'Tests de sécurité passent',
    run: () => run('pnpm', ['test:security']),
  },
  {
    id: 'G0.11',
    label: 'Aucun secret dans le dépôt ni dans l\'historique git',
    run: () => run('pnpm', ['secrets:scan']),
  },
];

async function main(): Promise<void> {
  console.log('\n  PORTE DE SORTIE — PHASE 0\n');

  if (!dbConfigured) {
    console.log(
      '  ⚠ JARVIS_DB_PASSWORD absent : les contrôles base de données échoueront.\n' +
        '    Configurer l\'environnement avant de statuer sur la porte.\n',
    );
  }

  let failures = 0;
  for (const check of checks) {
    process.stdout.write(`  ${check.id.padEnd(6)} ${check.label} … `);
    let passed = false;
    try {
      passed = await check.run();
    } catch {
      passed = false;
    }
    console.log(passed ? 'OK' : 'ÉCHEC');
    if (!passed) failures += 1;
  }

  console.log('');
  if (failures === 0) {
    console.log('  ✓ Phase 0 franchie. La Phase 1 peut commencer.\n');
    process.exit(0);
  }
  console.log(
    `  ✗ ${String(failures)} contrôle(s) en échec. La Phase 1 ne commence pas.\n`,
  );
  process.exit(1);
}

main().catch((error: unknown) => {
  console.error('Vérification interrompue :', error);
  process.exit(1);
});
