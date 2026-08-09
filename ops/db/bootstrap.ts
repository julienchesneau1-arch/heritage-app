/**
 * Bootstrap de la base — création des rôles et de la base.
 *
 * Exécuté une fois par machine, avec un rôle superutilisateur. Le noyau ne
 * possède jamais ce niveau de privilège : trois rôles distincts, trois usages.
 *
 *   jarvis_superuser  → ce script uniquement
 *   jarvis_owner      → migrations uniquement (propriétaire du schéma)
 *   jarvis_app        → le noyau. Pas d'UPDATE/DELETE sur le journal.
 *
 * Les mots de passe viennent de l'environnement et ne sont ni journalisés, ni
 * écrits sur disque (03 §9).
 */
import pg from 'pg';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    console.error(`✗ Variable d'environnement manquante : ${name}`);
    console.error('  Voir .env.example.');
    process.exit(1);
  }
  return value;
}

/** Échappe un littéral de mot de passe pour un ordre DDL. */
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Valide un identifiant SQL au lieu de l'échapper : plus strict, plus lisible. */
function assertIdentifier(value: string, label: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) {
    console.error(`✗ ${label} invalide : « ${value} »`);
    console.error('  Attendu : minuscules, chiffres et tirets bas.');
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const host = process.env['JARVIS_DB_HOST'] ?? 'localhost';
  const port = Number(process.env['JARVIS_DB_PORT'] ?? '5432');
  const database = assertIdentifier(
    process.env['JARVIS_DB_NAME'] ?? 'jarvis_dev',
    'JARVIS_DB_NAME',
  );
  const appUser = assertIdentifier(
    process.env['JARVIS_DB_USER'] ?? 'jarvis_app',
    'JARVIS_DB_USER',
  );
  const ownerUser = assertIdentifier(
    process.env['JARVIS_DB_OWNER_USER'] ?? 'jarvis_owner',
    'JARVIS_DB_OWNER_USER',
  );

  const appPassword = required('JARVIS_DB_PASSWORD');
  const ownerPassword = required('JARVIS_DB_OWNER_PASSWORD');

  const admin = new pg.Client({
    host,
    port,
    database: 'postgres',
    user: process.env['JARVIS_DB_SUPERUSER'] ?? 'postgres',
    ...(process.env['JARVIS_DB_SUPERUSER_PASSWORD'] === undefined
      ? {}
      : { password: process.env['JARVIS_DB_SUPERUSER_PASSWORD'] }),
  });

  await admin.connect();
  try {
    for (const [role, password] of [
      [ownerUser, ownerPassword],
      [appUser, appPassword],
    ] as const) {
      const exists = await admin.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM pg_roles WHERE rolname = $1',
        [role],
      );
      const present = exists.rows[0]?.count !== '0';
      if (present) {
        await admin.query(
          `ALTER ROLE ${role} WITH LOGIN PASSWORD ${quoteLiteral(password)}`,
        );
        console.log(`  rôle ${role} : mot de passe mis à jour`);
      } else {
        await admin.query(
          `CREATE ROLE ${role} WITH LOGIN PASSWORD ${quoteLiteral(password)}`,
        );
        console.log(`  rôle ${role} : créé`);
      }
    }

    const dbExists = await admin.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM pg_database WHERE datname = $1',
      [database],
    );
    if (dbExists.rows[0]?.count === '0') {
      await admin.query(`CREATE DATABASE ${database} OWNER ${ownerUser}`);
      console.log(`  base ${database} : créée`);
    } else {
      console.log(`  base ${database} : déjà présente`);
    }
  } finally {
    await admin.end();
  }

  // Les extensions demandent un privilège que le propriétaire n'a pas toujours.
  const inDb = new pg.Client({
    host,
    port,
    database,
    user: process.env['JARVIS_DB_SUPERUSER'] ?? 'postgres',
    ...(process.env['JARVIS_DB_SUPERUSER_PASSWORD'] === undefined
      ? {}
      : { password: process.env['JARVIS_DB_SUPERUSER_PASSWORD'] }),
  });
  await inDb.connect();
  try {
    // Les extensions exigent un privilège que le rôle de migration ne possède
    // pas — et ne doit pas posséder. C'est donc ici, avec le superutilisateur,
    // et une seule fois par base.
    await inDb.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    try {
      await inDb.query('CREATE EXTENSION IF NOT EXISTS vector');
      console.log('  extension pgvector : disponible');
    } catch {
      console.warn(
        '  ⚠ pgvector absent : la voie sémantique sera indisponible.\n' +
          '    Installer le paquet (par exemple `postgresql-16-pgvector` ou\n' +
          '    `brew install pgvector`) puis relancer `pnpm db:bootstrap`.\n' +
          '    Les voies structurée et lexicale fonctionnent sans lui.',
      );
    }
    await inDb.query(`GRANT ALL ON SCHEMA public TO ${ownerUser}`);
    await inDb.query(`GRANT USAGE ON SCHEMA public TO ${appUser}`);
    console.log('  extensions et privilèges de schéma : appliqués');
  } finally {
    await inDb.end();
  }

  console.log('✓ Bootstrap terminé.');
}

main().catch((error: unknown) => {
  console.error('✗ Bootstrap échoué :', error instanceof Error ? error.message : error);
  process.exit(1);
});
