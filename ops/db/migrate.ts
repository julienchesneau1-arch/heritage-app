/**
 * Runner de migrations.
 *
 * Écrit à la main plutôt qu'importé : `04` demande qu'une dépendance justifie
 * son existence, et une centaine de lignes nous donne exactement ce que la
 * porte de sortie Phase 0 exige — un rollback testé dans les deux sens, et un
 * checksum qui détecte la modification d'une migration déjà appliquée.
 *
 * Usage : tsx ops/db/migrate.ts <up|down|status>
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const MIGRATIONS_DIR = join(process.cwd(), 'infrastructure', 'db', 'migrations');

interface Migration {
  readonly version: string;
  readonly name: string;
  readonly upPath: string;
  readonly downPath: string;
}

function discover(): Migration[] {
  const files = readdirSync(MIGRATIONS_DIR);
  const versions = new Map<string, { name: string; up?: string; down?: string }>();

  for (const file of files) {
    const match = /^(\d{4})_(.+)\.(up|down)\.sql$/.exec(file);
    if (match === null) continue;
    const [, version, name, direction] = match;
    if (version === undefined || name === undefined || direction === undefined) continue;

    const entry = versions.get(version) ?? { name };
    if (direction === 'up') entry.up = join(MIGRATIONS_DIR, file);
    else entry.down = join(MIGRATIONS_DIR, file);
    versions.set(version, entry);
  }

  const result: Migration[] = [];
  for (const [version, entry] of [...versions.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (entry.up === undefined || entry.down === undefined) {
      throw new Error(
        `Migration ${version} incomplète : un fichier .up.sql ET un .down.sql sont requis. ` +
          `Une migration sans chemin de retour n'est pas déployable (07 §9).`,
      );
    }
    result.push({
      version,
      name: entry.name,
      upPath: entry.up,
      downPath: entry.down,
    });
  }
  return result;
}

function checksum(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function connect(): Promise<pg.Client> {
  const client = new pg.Client({
    host: process.env['JARVIS_DB_HOST'] ?? 'localhost',
    port: Number(process.env['JARVIS_DB_PORT'] ?? '5432'),
    database: process.env['JARVIS_DB_NAME'] ?? 'jarvis_dev',
    user: process.env['JARVIS_DB_OWNER_USER'] ?? 'jarvis_owner',
    ...(process.env['JARVIS_DB_OWNER_PASSWORD'] === undefined
      ? {}
      : { password: process.env['JARVIS_DB_OWNER_PASSWORD'] }),
  });
  await client.connect();
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      checksum   TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  return client;
}

async function applied(client: pg.Client): Promise<Map<string, string>> {
  const rows = await client.query<{ version: string; checksum: string }>(
    'SELECT version, checksum FROM schema_migrations ORDER BY version',
  );
  return new Map(rows.rows.map((r) => [r.version, r.checksum]));
}

async function up(client: pg.Client): Promise<void> {
  const migrations = discover();
  const done = await applied(client);

  // Une migration déjà appliquée puis modifiée est un piège classique : le
  // schéma réel ne correspond plus au dépôt. On refuse plutôt que d'ignorer.
  for (const m of migrations) {
    const recorded = done.get(m.version);
    if (recorded !== undefined && recorded !== checksum(m.upPath)) {
      throw new Error(
        `Migration ${m.version}_${m.name} déjà appliquée mais modifiée depuis. ` +
          `Créer une nouvelle migration au lieu d'éditer celle-ci.`,
      );
    }
  }

  const pending = migrations.filter((m) => !done.has(m.version));
  if (pending.length === 0) {
    console.log('✓ Aucune migration en attente.');
    return;
  }

  for (const m of pending) {
    process.stdout.write(`  → ${m.version}_${m.name} … `);
    await client.query('BEGIN');
    try {
      await client.query(readFileSync(m.upPath, 'utf8'));
      await client.query(
        'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
        [m.version, m.name, checksum(m.upPath)],
      );
      await client.query('COMMIT');
      console.log('appliquée');
    } catch (error: unknown) {
      await client.query('ROLLBACK');
      console.log('ÉCHEC');
      throw error;
    }
  }
  console.log(`✓ ${String(pending.length)} migration(s) appliquée(s).`);
}

async function down(client: pg.Client): Promise<void> {
  const migrations = discover();
  const done = await applied(client);
  const last = [...done.keys()].sort().pop();

  if (last === undefined) {
    console.log('✓ Aucune migration à annuler.');
    return;
  }

  const migration = migrations.find((m) => m.version === last);
  if (migration === undefined) {
    throw new Error(
      `Migration ${last} enregistrée en base mais absente du dépôt. ` +
        `Impossible d'annuler sans son fichier .down.sql.`,
    );
  }

  process.stdout.write(`  ← ${migration.version}_${migration.name} … `);
  await client.query('BEGIN');
  try {
    await client.query(readFileSync(migration.downPath, 'utf8'));
    await client.query('DELETE FROM schema_migrations WHERE version = $1', [
      migration.version,
    ]);
    await client.query('COMMIT');
    console.log('annulée');
  } catch (error: unknown) {
    await client.query('ROLLBACK');
    console.log('ÉCHEC');
    throw error;
  }
}

async function status(client: pg.Client): Promise<void> {
  const migrations = discover();
  const done = await applied(client);
  console.log('  version  état        nom');
  for (const m of migrations) {
    const mark = done.has(m.version) ? 'appliquée  ' : 'en attente ';
    console.log(`  ${m.version}     ${mark} ${m.name}`);
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'status';
  const client = await connect();
  try {
    switch (command) {
      case 'up':
        await up(client);
        break;
      case 'down':
        await down(client);
        break;
      case 'status':
        await status(client);
        break;
      default:
        console.error(`Commande inconnue : ${command}. Attendu : up | down | status.`);
        process.exit(1);
    }
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(
    '✗ Migration échouée :',
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});
