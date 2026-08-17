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

/* ==================================================================== *
 * ACCÈS EXCLUSIF AU JOURNAL — infrastructure de test
 * ==================================================================== */

/**
 * Clé de verrou consultatif protégeant la FENÊTRE DE CORRUPTION du journal.
 *
 * ⚠ CE VERROU EXISTE À CAUSE D'UN DÉFAUT RÉEL, TROUVÉ EN SUITE COMPLÈTE.
 *
 * `ledger-chain.test.ts` **corrompt délibérément** le journal — triggers
 * désactivés, ligne réécrite — pour prouver que le chaînage par hash détecte
 * l'altération quand les deux premières barrières tombent. Il restaure ensuite
 * dans un `finally`.
 *
 * Mais le journal est PARTAGÉ par toute la suite, et quatre autres fichiers y
 * appellent `verifyChain()` — plus `system_status`, qui le fait en production.
 * Pendant la fenêtre de corruption, la chaîne est GLOBALEMENT invalide : un
 * lecteur concurrent voit `valid: false` et échoue, à juste titre.
 *
 * Mesuré : `intent/flow.test.ts` — « la chaîne d'audit reste intacte après une
 * session complète » — vert seul, rouge en suite complète. Ce n'était pas un
 * défaut du produit, et surtout **pas une raison d'affaiblir l'assertion** :
 * elle avait raison.
 *
 * On ne peut pas vérifier globalement l'intégrité d'un objet pendant qu'on le
 * corrompt volontairement ailleurs. Le seul correctif honnête est l'exclusion
 * mutuelle — côté TESTS, jamais dans le produit.
 */
const LEDGER_EXCLUSIVE_KEY = 0x4c454447; // "LEDG"

/**
 * Exécute `fn` en accès exclusif au journal.
 *
 * Le verrou est pris par une transaction DÉDIÉE qui reste ouverte pendant tout
 * le callback ; le travail de `fn`, lui, passe par d'autres connexions — c'est
 * ce qui permet à un corrupteur d'appeler `verifyChain()` sur lui-même sans se
 * bloquer, tout en excluant les lecteurs des autres fichiers.
 *
 * `pg_advisory_xact_lock` plutôt que sa variante de session : sur un pool, une
 * connexion rendue conserverait un verrou de session — et le libérerait à un
 * moment qu'on ne contrôle pas.
 */
export async function withLedgerExclusive<T>(
  lockDb: Db,
  fn: () => Promise<T>,
): Promise<T> {
  let out: T | undefined;
  /* Un TABLEAU plutôt qu'une variable, et ce n'est pas un caprice : TypeScript
     ne suit pas une affectation faite dans un callback, donc `thrown` restait
     narrow à `null` au moment du `throw` — et la règle `only-throw-error` y
     voyait un jet de `null`. */
  const echecs: Error[] = [];

  await lockDb.transaction(async (tx) => {
    const locked = await tx.query('SELECT pg_advisory_xact_lock($1)', [
      String(LEDGER_EXCLUSIVE_KEY),
    ]);
    if (!locked.ok) return locked;
    try {
      out = await fn();
    } catch (cause) {
      /* On MÉMORISE plutôt que de laisser filer : une exception traversant la
         transaction la ferait bien annuler — donc relâcher le verrou — mais on
         veut relancer l'erreur d'ORIGINE, pas une erreur de transaction. Sans
         quoi un échec d'assertion Vitest arriverait déguisé, et le test dirait
         « transaction échouée » là où il devrait dire ce qui a réellement
         cassé. */
      echecs.push(cause instanceof Error ? cause : new Error(String(cause)));
    }
    return okVoid();
  });

  const premier = echecs[0];
  if (premier !== undefined) throw premier;
  return out as T;
}

function okVoid(): { readonly ok: true; readonly value: undefined } {
  return { ok: true, value: undefined };
}
