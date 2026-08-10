/**
 * Installation en une commande.
 *
 * `pnpm jarvis:setup` — vérifie l'environnement, génère les secrets locaux,
 * crée les rôles et la base, applique les migrations.
 *
 * Le nom porte un préfixe parce que `pnpm setup` est une commande RÉSERVÉE de
 * pnpm : elle configure le répertoire personnel de pnpm et ignore
 * silencieusement le script du projet. Défaut trouvé en exécutant, pas en
 * relisant.
 *
 * PRINCIPE : le script ne devine rien et ne masque aucune erreur. Chaque étape
 * dit ce qu'elle a fait, et un échec explique quoi corriger — pas « erreur
 * inconnue » (PRD §42, `04 §6`).
 *
 * Les mots de passe sont générés aléatoirement et écrits dans `.env`, ignoré
 * par git. Aucun secret ne transite par le dépôt (03 §9).
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const ENV_PATH = join(process.cwd(), '.env');

function step(label: string): void {
  process.stdout.write(`  ${label} … `);
}

function done(detail = 'OK'): void {
  process.stdout.write(`${detail}\n`);
}

function fail(message: string, remedy: string): never {
  process.stdout.write('ÉCHEC\n\n');
  console.error(`  ✗ ${message}\n`);
  console.error(`  → ${remedy}\n`);
  process.exit(1);
}

function secret(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * Jeton de la passerelle web. Plus long que les mots de passe de base : c'est
 * la SEULE barrière entre le réseau local et la mémoire personnelle (ADR-023).
 * 32 octets → 43 caractères base64url, ~256 bits.
 */
function webToken(): string {
  return randomBytes(32).toString('base64url');
}

/* -------------------------------------------------------------------------- */

function checkNode(): void {
  step('Node 22+');
  const major = Number(process.versions.node.split('.')[0] ?? '0');
  if (major < 22) {
    fail(
      `Node ${process.versions.node} détecté, 22 minimum requis.`,
      'Installer Node 22 ou plus récent (nvm install 22).',
    );
  }
  done(`v${process.versions.node}`);
}

interface EnvFile {
  readonly created: boolean;
  readonly values: Record<string, string>;
}

function ensureEnv(): EnvFile {
  step('Fichier .env');

  if (existsSync(ENV_PATH)) {
    const existing = readFileSync(ENV_PATH, 'utf8');
    const values: Record<string, string> = {};
    for (const line of existing.split('\n')) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (match?.[1] !== undefined) values[match[1]] = match[2] ?? '';
    }

    // Une installation antérieure n'a pas de jeton web. On le COMPLÈTE sans
    // toucher au reste : réécrire un .env existant, c'est risquer d'effacer un
    // mot de passe qu'aucune sauvegarde ne connaît.
    const missing = (values['JARVIS_WEB_TOKEN'] ?? '').length === 0;
    if (missing) {
      values['JARVIS_WEB_TOKEN'] = webToken();
      const suffix =
        (existing.endsWith('\n') ? '' : '\n') +
        '\n# Passerelle web locale (`pnpm jarvis:web`). Ajouté par jarvis:setup.\n' +
        `JARVIS_WEB_TOKEN=${values['JARVIS_WEB_TOKEN']}\n`;
      writeFileSync(ENV_PATH, existing + suffix, { mode: 0o600 });
      done('complété — jeton de passerelle web généré');
      return { created: false, values };
    }

    done('déjà présent, conservé');
    return { created: false, values };
  }

  // Mots de passe générés par machine : rien à recopier, rien à inventer, et
  // aucune valeur par défaut partagée entre installations.
  const values: Record<string, string> = {
    JARVIS_ENV: 'dev',
    JARVIS_DB_HOST: '127.0.0.1',
    JARVIS_DB_PORT: '5432',
    JARVIS_DB_NAME: 'jarvis_dev',
    JARVIS_DB_USER: 'jarvis_app',
    JARVIS_DB_PASSWORD: secret(),
    JARVIS_DB_OWNER_USER: 'jarvis_owner',
    JARVIS_DB_OWNER_PASSWORD: secret(),
    JARVIS_DB_SUPERUSER: process.env['JARVIS_DB_SUPERUSER'] ?? 'postgres',
    JARVIS_DB_SUPERUSER_PASSWORD: process.env['JARVIS_DB_SUPERUSER_PASSWORD'] ?? '',
    JARVIS_CLOUD_BUDGET_MONTHLY_EUR: '0',
    JARVIS_WEB_TOKEN: webToken(),
  };

  const content = [
    '# Généré par `pnpm jarvis:setup`. Ignoré par git.',
    '# Les mots de passe applicatifs sont aléatoires et propres à cette machine.',
    '',
    ...Object.entries(values).map(([k, v]) => `${k}=${v}`),
    '',
  ].join('\n');

  writeFileSync(ENV_PATH, content, { mode: 0o600 });
  done('créé, secrets générés');
  return { created: true, values };
}

async function checkPostgres(values: Record<string, string>): Promise<void> {
  step('PostgreSQL joignable');

  const client = new pg.Client({
    host: values['JARVIS_DB_HOST'] ?? '127.0.0.1',
    port: Number(values['JARVIS_DB_PORT'] ?? '5432'),
    database: 'postgres',
    user: values['JARVIS_DB_SUPERUSER'] ?? 'postgres',
    ...(values['JARVIS_DB_SUPERUSER_PASSWORD'] === undefined ||
    values['JARVIS_DB_SUPERUSER_PASSWORD'] === ''
      ? {}
      : { password: values['JARVIS_DB_SUPERUSER_PASSWORD'] }),
    connectionTimeoutMillis: 5000,
  });

  try {
    await client.connect();
    const version = await client.query<{ v: string }>('SELECT version() AS v');
    done((version.rows[0]?.v ?? '').split(',')[0] ?? 'connecté');
  } catch (error: unknown) {
    fail(
      `Connexion impossible : ${error instanceof Error ? error.message : String(error)}`,
      'Démarrer PostgreSQL 16+, ou utiliser Docker :\n' +
        '     docker compose -f infrastructure/docker/docker-compose.yml up -d\n' +
        '   Puis renseigner JARVIS_DB_SUPERUSER_PASSWORD dans .env si nécessaire.',
    );
  } finally {
    await client.end().catch(() => undefined);
  }

  /* pgvector : absent n'est pas bloquant, mais doit être DIT. */
  step('Extension pgvector');
  const check = new pg.Client({
    host: values['JARVIS_DB_HOST'] ?? '127.0.0.1',
    port: Number(values['JARVIS_DB_PORT'] ?? '5432'),
    database: 'postgres',
    user: values['JARVIS_DB_SUPERUSER'] ?? 'postgres',
    ...(values['JARVIS_DB_SUPERUSER_PASSWORD'] === undefined ||
    values['JARVIS_DB_SUPERUSER_PASSWORD'] === ''
      ? {}
      : { password: values['JARVIS_DB_SUPERUSER_PASSWORD'] }),
  });
  try {
    await check.connect();
    const available = await check.query(
      "SELECT 1 FROM pg_available_extensions WHERE name = 'vector'",
    );
    if (available.rowCount === 0) {
      done('ABSENTE');
      console.error(
        '\n  ⚠ pgvector n\'est pas disponible sur ce serveur.\n' +
          '    La voie sémantique de la recherche sera indisponible ;\n' +
          '    les voies structurée et lexicale fonctionnent sans elle.\n' +
          '    macOS : brew install pgvector — Debian : apt install postgresql-16-pgvector\n',
      );
    } else {
      done('disponible');
    }
  } finally {
    await check.end().catch(() => undefined);
  }
}

function run(label: string, args: readonly string[], env: NodeJS.ProcessEnv): void {
  step(label);
  try {
    execFileSync('node', ['--import', 'tsx', ...args], { stdio: 'pipe', env });
    done();
  } catch (error: unknown) {
    const output =
      error !== null && typeof error === 'object' && 'stderr' in error
        ? String((error as { stderr: unknown }).stderr)
        : '';
    fail(
      `${label} a échoué.`,
      output.trim().length > 0 ? output.trim() : 'Relancer avec plus de détail.',
    );
  }
}

async function main(): Promise<void> {
  console.log('\n  INSTALLATION DE JARVIS\n');

  checkNode();
  const env = ensureEnv();
  await checkPostgres(env.values);

  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env.values };

  run('Rôles et base de développement', ['ops/db/bootstrap.ts'], childEnv);
  run('Migrations (développement)', ['ops/db/migrate.ts', 'up'], childEnv);

  // La suite de tests recrée le schéma à chaque exécution : elle doit viser sa
  // PROPRE base. On la provisionne ici pour que `pnpm test` fonctionne sur une
  // machine fraîchement installée — sans jamais toucher aux données réelles.
  const testEnv: NodeJS.ProcessEnv = {
    ...childEnv,
    JARVIS_ENV: 'test',
    JARVIS_DB_NAME: 'jarvis_test',
  };
  run('Base de test isolée', ['ops/db/bootstrap.ts'], testEnv);
  run('Migrations (test)', ['ops/db/migrate.ts', 'up'], testEnv);

  console.log('\n  ✓ Prêt.\n');
  console.log('    pnpm jarvis        lancer l\'interface texte');
  console.log('    pnpm jarvis:web    ouvrir la passerelle web (téléphone)');
  console.log('    pnpm test          la suite complète');
  console.log('    pnpm gate:phase2   vérifier les portes de sortie');
  if (env.created) {
    console.log('\n  Les secrets ont été écrits dans .env (ignoré par git).');
  }
  console.log('');
}

main().catch((error: unknown) => {
  console.error(
    `\n  ✗ Installation interrompue : ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exit(1);
});
