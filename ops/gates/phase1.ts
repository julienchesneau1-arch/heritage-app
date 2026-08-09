/**
 * Porte de sortie Phase 1 — vérification exécutable.
 *
 * Les cinq conditions de `02`, vérifiées en conditions réelles plutôt que
 * cochées à la main. Contrairement à la porte Phase 0, plusieurs contrôles
 * exécutent ici le vrai chemin de code — Guard, recherche, résolution — parce
 * que ce sont des comportements, pas des propriétés statiques.
 */
import { execFileSync } from 'node:child_process';
import { createDb } from '../../src/core/db/client.js';
import { createMemoryGuard } from '../../src/core/memory/guard.js';
import { createMemoryStore } from '../../src/core/memory/store.js';
import { createHybridSearch } from '../../src/core/memory/search.js';
import { createEntityResolver } from '../../src/core/context/resolver.js';
import { buildContextPacket, DEFAULT_BUDGET } from '../../src/core/context/packet.js';
import type { StoredMemory } from '../../src/core/memory/types.js';

interface Check {
  readonly id: string;
  readonly label: string;
  run(): Promise<boolean> | boolean;
}

function runCommand(command: string, args: readonly string[]): boolean {
  try {
    execFileSync(command, [...args], { stdio: 'pipe', env: process.env });
    return true;
  } catch {
    return false;
  }
}

const dbConfigured =
  process.env['JARVIS_DB_PASSWORD'] !== undefined &&
  process.env['JARVIS_DB_PASSWORD'] !== '';

function db() {
  return createDb({
    host: process.env['JARVIS_DB_HOST'] ?? '127.0.0.1',
    port: Number(process.env['JARVIS_DB_PORT'] ?? '5432'),
    database: process.env['JARVIS_DB_NAME'] ?? 'jarvis_test',
    user: process.env['JARVIS_DB_USER'] ?? 'jarvis_app',
    password: process.env['JARVIS_DB_PASSWORD'] ?? '',
  });
}

const checks: readonly Check[] = [
  {
    id: 'G1.1',
    label:
      'Un email affirmant une préférence devient EXTERNAL_CLAIM, jamais une préférence',
    async run() {
      if (!dbConfigured) return false;
      const connection = db();
      try {
        const guard = createMemoryGuard(createMemoryStore(connection));
        const result = await guard.propose(
          {
            memoryType: 'PREFERENCE',
            content: `Julien aime X (contrôle de porte ${String(Date.now())})`,
            provenance: 'EXTERNAL_UNTRUSTED',
            source: 'email:gate-check',
            suggestedConfidence: 1,
          },
          { userConfirmed: false },
        );
        if (!result.ok) return false;
        return (
          result.value.memory.kind === 'EXTERNAL_CLAIM' &&
          result.value.memory.memoryType !== 'PREFERENCE' &&
          result.value.memory.confidence <= 0.4
        );
      } finally {
        await connection.close();
      }
    },
  },
  {
    id: 'G1.2',
    label: 'Face à plusieurs homonymes, le résolveur demande au lieu de choisir',
    async run() {
      if (!dbConfigured) return false;
      const connection = db();
      try {
        const suffix = String(Date.now());
        for (const name of [`Homonyme A ${suffix}`, `Homonyme B ${suffix}`]) {
          const inserted = await connection.query(
            `INSERT INTO entities (kind, display_name) VALUES ('PERSON', $1)`,
            [name],
          );
          if (!inserted.ok) return false;
        }
        const resolver = createEntityResolver(connection);
        const result = await resolver.resolveMention('Homonyme');
        if (!result.ok) return false;
        return (
          result.value.kind === 'AMBIGUOUS' &&
          result.value.question.includes('?')
        );
      } finally {
        await connection.close();
      }
    },
  },
  {
    id: 'G1.3',
    label: 'Le paquet de contexte est borné et déclare ce qu\'il écarte',
    run() {
      const flood: StoredMemory[] = Array.from({ length: 500 }, (_, i) => ({
        id: `m${String(i)}`,
        kind: 'FACT',
        memoryType: 'SEMANTIC',
        content: 'z'.repeat(400),
        confidence: 0.9,
        source: 'gate',
        provenance: 'USER',
        privacyClass: 'ORANGE',
        state: 'ACTIVE',
        subjectEntityId: null,
        createdAt: '2026-08-01T00:00:00.000Z',
        lastVerifiedAt: null,
        expiresAt: null,
        hasEmbedding: false,
      }));

      const packet = buildContextPacket({
        query: 'contrôle de porte',
        memories: flood,
        entities: [],
        turns: [],
        maxPrivacyClass: 'RED',
      });
      if (!packet.ok) return false;

      return (
        packet.value.characters <= DEFAULT_BUDGET.maxCharacters &&
        packet.value.memories.length <= DEFAULT_BUDGET.maxMemories &&
        packet.value.omitted.byBudget > 0 &&
        packet.value.omitted.reasons.length > 0
      );
    },
  },
  {
    id: 'G1.4',
    label: 'Une donnée RED n\'entre jamais dans un paquet destiné au cloud',
    run() {
      const packet = buildContextPacket({
        query: 'contrôle',
        memories: [
          {
            id: 'red',
            kind: 'FACT',
            memoryType: 'SEMANTIC',
            content: 'IBAN FR76 0000 0000 0000',
            confidence: 1,
            source: 'gate',
            provenance: 'USER',
            privacyClass: 'RED',
            state: 'ACTIVE',
            subjectEntityId: null,
            createdAt: '2026-08-01T00:00:00.000Z',
            lastVerifiedAt: null,
            expiresAt: null,
            hasEmbedding: false,
          },
        ],
        entities: [],
        turns: [],
        maxPrivacyClass: 'ORANGE',
      });
      if (!packet.ok) return false;
      return (
        packet.value.memories.length === 0 &&
        packet.value.omitted.byPrivacy === 1 &&
        !JSON.stringify(packet.value).includes('FR76')
      );
    },
  },
  {
    id: 'G1.5',
    label: 'Recherche mémoire fonctionnelle sans fournisseur d\'embeddings',
    async run() {
      if (!dbConfigured) return false;
      const connection = db();
      try {
        const guard = createMemoryGuard(createMemoryStore(connection));
        const marker = `porte-hors-ligne-${String(Date.now())}`;
        const stored = await guard.propose(
          {
            memoryType: 'SEMANTIC',
            content: `Contrôle de porte hors ligne ${marker}`,
            provenance: 'USER',
            source: 'gate',
            suggestedConfidence: 0.9,
          },
          { userConfirmed: true },
        );
        if (!stored.ok) return false;

        // `null` = aucun fournisseur, exactement le cas réseau coupé.
        const search = createHybridSearch(connection, null);
        const found = await search.search({ text: marker });
        if (!found.ok) return false;

        return (
          found.value.degraded &&
          found.value.merged.some((m) => m.memory.id === stored.value.memory.id)
        );
      } finally {
        await connection.close();
      }
    },
  },
  {
    id: 'G1.6',
    label: 'Les trois voies sont rapportées séparément, avec leur temps',
    async run() {
      if (!dbConfigured) return false;
      const connection = db();
      try {
        const search = createHybridSearch(connection, null);
        const result = await search.search({ text: 'contrôle' });
        if (!result.ok) return false;

        const lanes = result.value.lanes.map((l) => l.lane);
        return (
          lanes.includes('STRUCTURED') &&
          lanes.includes('LEXICAL') &&
          lanes.includes('SEMANTIC') &&
          result.value.lanes.every((l) => typeof l.elapsedMs === 'number')
        );
      } finally {
        await connection.close();
      }
    },
  },
  {
    id: 'G1.7',
    label: 'Tests mémoire et contexte passent',
    run: () => runCommand('pnpm', ['test:memory']) && runCommand('pnpm', ['test:context']),
  },
  {
    id: 'G1.8',
    label: 'La Phase 0 reste franchie (aucune régression)',
    run: () =>
      runCommand('pnpm', ['test:contracts']) &&
      runCommand('pnpm', ['test:policy']) &&
      runCommand('pnpm', ['test:security']),
  },
];

async function main(): Promise<void> {
  console.log('\n  PORTE DE SORTIE — PHASE 1\n');

  if (!dbConfigured) {
    console.log('  ⚠ JARVIS_DB_PASSWORD absent : les contrôles base échoueront.\n');
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
    console.log('  ✓ Phase 1 franchie. La Phase 2 peut commencer.\n');
    process.exit(0);
  }
  console.log(
    `  ✗ ${String(failures)} contrôle(s) en échec. La Phase 2 ne commence pas.\n`,
  );
  process.exit(1);
}

main().catch((error: unknown) => {
  console.error('Vérification interrompue :', error);
  process.exit(1);
});
