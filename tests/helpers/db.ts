/**
 * Aides de test pour la base.
 *
 * Les tests touchant la base sont exécutés sur `jarvis_test`, jamais sur une
 * base de développement ou de production : `07 §5` interdit au LAB l'accès aux
 * données réelles, et le même principe vaut pour les tests.
 */
import { createDb, type Db } from '../../src/core/db/client.js';

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(
      `Variable ${name} absente. Les tests base de données exigent un environnement ` +
        `configuré (voir .env.example et README « Démarrage »).`,
    );
  }
  return value;
}

/** Vrai si l'environnement permet de faire tourner les tests base de données. */
export function databaseAvailable(): boolean {
  return (
    process.env['JARVIS_DB_PASSWORD'] !== undefined &&
    process.env['JARVIS_DB_PASSWORD'] !== ''
  );
}

/** Connexion avec le rôle applicatif : SELECT/INSERT sur le journal, rien de plus. */
export function appDb(): Db {
  return createDb({
    host: env('JARVIS_DB_HOST', '127.0.0.1'),
    port: Number(env('JARVIS_DB_PORT', '5432')),
    database: env('JARVIS_DB_NAME', 'jarvis_test'),
    user: env('JARVIS_DB_USER', 'jarvis_app'),
    password: env('JARVIS_DB_PASSWORD'),
  });
}

/**
 * Connexion superutilisateur — RÉSERVÉE aux tests d'intégrité.
 *
 * Sert uniquement à simuler la chute des deux premières barrières (permissions
 * et trigger) pour vérifier que la troisième — le chaînage par hash — détecte
 * bien l'altération. Aucun code applicatif ne doit jamais l'utiliser.
 */
export function superuserDb(): Db {
  return createDb({
    host: env('JARVIS_DB_HOST', '127.0.0.1'),
    port: Number(env('JARVIS_DB_PORT', '5432')),
    database: env('JARVIS_DB_NAME', 'jarvis_test'),
    user: env('JARVIS_DB_SUPERUSER', 'postgres'),
    password: env('JARVIS_DB_SUPERUSER_PASSWORD'),
  });
}

/**
 * Connexion avec le rôle propriétaire.
 *
 * Utilisée uniquement pour prouver que la seconde barrière (le trigger) tient
 * même face à un rôle qui possède les privilèges DML.
 */
export function ownerDb(): Db {
  return createDb({
    host: env('JARVIS_DB_HOST', '127.0.0.1'),
    port: Number(env('JARVIS_DB_PORT', '5432')),
    database: env('JARVIS_DB_NAME', 'jarvis_test'),
    user: env('JARVIS_DB_OWNER_USER', 'jarvis_owner'),
    password: env('JARVIS_DB_OWNER_PASSWORD'),
  });
}
