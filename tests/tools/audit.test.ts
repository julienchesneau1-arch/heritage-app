/**
 * `audit_query` — scénario doré **A9**, promesse de `docs/12`.
 *
 * L'exigence tient en une clause, et tout le fichier tourne autour :
 *
 *   > réponse construite **depuis l'Event Ledger**.
 *   > **Interdit :** réponse reconstruite par le modèle de mémoire.
 *
 * Un système qui raconte ses actions depuis sa mémoire raconte ce qu'il CROIT
 * avoir fait. L'écart entre les deux est exactement l'espace où un audit
 * devient inutile.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseAvailable } from '../helpers/db.js';
import { buildStack, callContext, operationId, type Stack } from '../helpers/stack.js';
import { appDb } from '../helpers/db.js';
import type { Db } from '../../src/core/db/client.js';

const enabled = databaseAvailable();

const TRUSTED = { content: 'USER' as const, window: 'USER' as const, limit: 'USER' as const };

describe.runIf(enabled)('audit_query — A9', () => {
  let stack: Stack;
  let db: Db;

  beforeAll(() => {
    db = appDb();
    stack = buildStack(db);
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.query("DELETE FROM notes WHERE content LIKE 'audit-%'");
  });

  /** Interroge l'audit et rend la charge utile. */
  async function interroger(
    window: 'today' | 'week' | 'month' = 'today',
  ): Promise<Record<string, unknown> | null> {
    const result = await stack.gateway.invoke({
      toolId: 'audit_query',
      input: { window, limit: 100 },
      parameterProvenance: TRUSTED,
      operationId: operationId(`audit-${window}-${String(Math.random()).slice(2, 8)}`),
      actor: 'USER',
      context: callContext(),
    });
    if (!result.ok) return null;
    return result.value.output as Record<string, unknown>;
  }

  /* ================================================================== *
   * A9 — la réponse vient du JOURNAL
   * ================================================================== */

  it("A9 — une action réalisée apparaît dans l'audit, lue au journal", async () => {
    const marqueur = `audit-${String(Date.now())}`;
    /* `userConfirmed` — la note est une action à cérémonie, et c'est le test
       qui avait tort : sans confirmation, `note_create` rend
       `CONFIRMATION_REQUIRED`. L'événement `…_PREPARED` apparaît alors quand
       même dans l'audit, ce qui est correct — mais on veut ici éprouver
       qu'une action RÉALISÉE s'y trouve. */
    const créé = await stack.gateway.invoke({
      toolId: 'note_create',
      input: { content: marqueur },
      parameterProvenance: { content: 'USER' },
      operationId: operationId(`audit-note-${marqueur}`),
      actor: 'USER',
      context: callContext({ userConfirmed: true }),
    });
    expect(créé.ok).toBe(true);
    if (!créé.ok) return;
    expect(créé.value.status).toBe('CONFIRMED');

    const sortie = await interroger();
    expect(sortie).not.toBeNull();
    if (sortie === null) return;

    const entries = sortie['entries'] as {
      eventType: string;
      tool: string | null;
      status: string;
    }[];
    const note = entries.find(
      (e) => e.tool === 'note_create' && e.status === 'CONFIRMED',
    );
    expect(note).toBeDefined();
    // Et l'audit rapporte le TYPE d'événement écrit à l'époque, pas une
    // reformulation : c'est ce qui distingue une lecture d'un résumé.
    expect(note?.eventType).toContain('NOTE');
  }, 30_000);

  it("A9 — l'audit lit `event_ledger`, et RIEN d'autre", async () => {
    /* La propriété structurelle qui donne son sens au scénario. Un audit qui
       interrogerait `tool_operations`, la mémoire ou les notes raconterait
       l'état COURANT — révisable — au lieu de ce qui a été écrit au moment des
       faits.

       Vérifié sur le texte de la source : une garantie comportementale ne
       couvrirait pas la prochaine jointure ajoutée par commodité. */
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/tools/audit.ts', 'utf8');

    expect(source).toContain('FROM event_ledger');
    for (const interdite of [
      'FROM tool_operations',
      'FROM memories',
      'FROM notes',
      'FROM tasks',
      'JOIN',
    ]) {
      expect(source, interdite).not.toContain(interdite);
    }
  });

  it("A9 — l'audit n'appelle AUCUN modèle", async () => {
    /* L'interdit explicite de `docs/05` : « réponse reconstruite par le modèle
       de mémoire ». L'outil ne reçoit aucun fournisseur de modèle et n'en
       importe aucun — c'est une impossibilité de construction, pas une
       discipline. */
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/tools/audit.ts', 'utf8');
    for (const interdit of ['provider', 'complete(', 'chat(', 'embed(', 'summar']) {
      expect(source.toLowerCase(), interdit).not.toContain(interdit.toLowerCase());
    }
  });

  /* ================================================================== *
   * Ce qu'un audit honnête doit dire de lui-même
   * ================================================================== */

  it('signale explicitement une réponse TRONQUÉE', async () => {
    /* La seule façon dont une lecture honnête peut mentir : montrer cinquante
       lignes sur trois cents sans le dire. */
    const result = await stack.gateway.invoke({
      toolId: 'audit_query',
      input: { window: 'today', limit: 1 },
      parameterProvenance: TRUSTED,
      operationId: operationId(`audit-tronq-${String(Math.random()).slice(2, 8)}`),
      actor: 'USER',
      context: callContext(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const sortie = result.value.output as Record<string, unknown>;
    expect(sortie['count']).toBe(1);
    expect(sortie['truncated']).toBe(true);
  }, 30_000);

  it("l'interrogation d'audit est elle-même journalisée", async () => {
    /* Un audit qui ne se journalise pas laisse un angle mort exactement là où
       il ne devrait pas y en avoir : qui a consulté le journal, et quand. */
    const op = operationId(`audit-trace-${String(Math.random()).slice(2, 8)}`);
    await stack.gateway.invoke({
      toolId: 'audit_query',
      input: { window: 'today', limit: 10 },
      parameterProvenance: TRUSTED,
      operationId: op,
      actor: 'USER',
      context: callContext(),
    });

    const found = await stack.ledger.findByOperationId(op);
    expect(found.ok).toBe(true);
    if (!found.ok || found.value === null) return;
    expect(found.value.eventType).toContain('AUDIT_QUERIED');
  }, 30_000);

  /* ================================================================== *
   * La fenêtre est calculée par la BASE — ADR-037
   * ================================================================== */

  it("« aujourd'hui » ne dépend pas de l'horloge du processus", async () => {
    /* Un appelant dont l'horloge dérive verrait sinon « aujourd'hui » ailleurs
       qu'aujourd'hui — et un audit qui montre le mauvais jour est pire qu'un
       audit absent, parce qu'il inspire confiance. */
    const marqueur = `audit-horloge-${String(Date.now())}`;
    await stack.gateway.invoke({
      toolId: 'note_create',
      input: { content: marqueur },
      parameterProvenance: { content: 'USER' },
      operationId: operationId(marqueur),
      actor: 'USER',
      context: callContext({ userConfirmed: true }),
    });

    const real = Date.now.bind(Date);
    Date.now = () => real() + 45 * 24 * 3_600 * 1_000; // un mois et demi plus tard
    try {
      const sortie = await interroger('today');
      expect(sortie).not.toBeNull();
      if (sortie === null) return;
      // L'action reste visible : la fenêtre est celle de la BASE.
      const entries = sortie['entries'] as { tool: string | null }[];
      expect(entries.some((e) => e.tool === 'note_create')).toBe(true);
    } finally {
      Date.now = real;
    }
  }, 30_000);

  /* ================================================================== *
   * Le contrat déclaré est honnête
   * ================================================================== */

  it("se déclare sans effet externe, et c'est vrai", () => {
    const tool = stack.gateway.list().find((t) => t.definition.id === 'audit_query');
    expect(tool).toBeDefined();
    if (tool === undefined) return;

    expect(tool.definition.effect).toBe('NO_EXTERNAL_EFFECT');
    expect(tool.definition.networkRequired).toBe(false);
    /* `false` : non pas « irréversible » mais « rien à défaire ». Le
       validateur de contrat refuse `true` sans procédure d'annulation, et il a
       raison — promettre une annulation impossible serait pire que de ne rien
       promettre. */
    expect(tool.definition.reversible).toBe(false);
    /* ORANGE et non GREEN : le journal ne contient aucune charge utile, mais
       l'ENCHAÎNEMENT des actions est en soi une information sur la vie de
       l'utilisateur. */
    expect(tool.definition.privacyClass).toBe('ORANGE');
  });
});
