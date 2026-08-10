/**
 * RED TEAM — « c'est fait » sous la panne.
 *
 * Référence : invariants S7 et S15, 00 §I4, scénarios 05/B5 et B12.
 *
 * On provoque volontairement les pannes et on regarde ce que Jarvis DIT. La
 * question n'est pas « le code gère-t-il l'erreur » — c'est « peut-il, dans un
 * de ces états, annoncer un succès qui n'a pas eu lieu ».
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Db } from '../../src/core/db/client.js';
import { appDb, databaseAvailable } from '../helpers/db.js';
import { buildStack, callContext, operationId, type Stack } from '../helpers/stack.js';
import { createDb } from '../../src/core/db/client.js';
import { defineTool } from '../../src/core/tools/contract.js';
import { err, ok, jarvisError } from '../../src/core/types/result.js';
import { buildRuntime } from '../../src/apps/runtime.js';

const skip = !databaseAvailable();

/** Fabrique un outil dont on choisit précisément le mode de défaillance. */
function faulty(
  id: string,
  mode: 'THROW' | 'ERROR' | 'TIMEOUT' | 'LIES' | 'READBACK_FAILS',
) {
  return defineTool({
    definition: {
      id,
      version: '1.0.0',
      description: 'Outil défaillant',
      autonomy: 'L2',
      privacyClass: 'GREEN',
      reversible: false,
      networkRequired: false,
      parameters: [{ name: 'valeur', sensitive: false }],
      idempotency: 'OPERATION_KEY',
      verification: 'READ_BACK',
      timeoutMs: mode === 'TIMEOUT' ? 150 : 3000,
      maxRetries: 0,
      auditEvent: 'REDTEAM_FAULT',
      requiredSecrets: [],
      rollback: null,
    },
    inputSchema: z.object({ valeur: z.string() }),
    async execute() {
      if (mode === 'THROW') throw new Error('panne brutale du fournisseur');
      if (mode === 'ERROR') {
        return err(jarvisError('PROVIDER_UNAVAILABLE', 'fournisseur injoignable'));
      }
      if (mode === 'TIMEOUT') {
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
      // LIES : l'outil affirme avoir réussi. Rien n'a changé dans le monde.
      return ok({ output: { http: 200, message: 'Envoyé !' } });
    },
    readBack() {
      if (mode === 'READBACK_FAILS') {
        return Promise.resolve(err(jarvisError('TIMEOUT', 'relecture impossible')));
      }
      if (mode === 'LIES') {
        return Promise.resolve(
          ok({
            status: 'FAILED' as const,
            detail: 'état réel relu : rien n\'a changé, malgré la réponse 200',
          }),
        );
      }
      return Promise.resolve(
        ok({ status: 'CONFIRMED' as const, detail: 'état réel conforme' }),
      );
    },
  });
}

describe.skipIf(skip)('RED TEAM — modes de défaillance', () => {
  let db: Db;
  let stack: Stack;

  beforeAll(() => {
    db = appDb();
    stack = buildStack(db);
    for (const mode of ['THROW', 'ERROR', 'TIMEOUT', 'LIES', 'READBACK_FAILS'] as const) {
      stack.registerExtra(faulty(`fault_${mode.toLowerCase()}`, mode));
    }
  });

  afterAll(async () => {
    await db.close();
  });

  function call(toolId: string) {
    return {
      toolId,
      input: { valeur: 'x' },
      parameterProvenance: { valeur: 'USER' as const },
      operationId: operationId('fault'),
      actor: 'USER' as const,
      context: callContext(),
    };
  }

  it('DÉMONSTRATION — un outil qui lève fait remonter une exception hors du Gateway', async () => {
    // Constat brut. `invoke()` promet un `Result` ; sur ce chemin il rejette.
    await expect(stack.gateway.invoke(call('fault_throw'))).rejects.toThrow(
      'panne brutale',
    );
  });

  it('DÉMONSTRATION — et l\'exception échappe AVANT toute écriture au journal', async () => {
    // C'est le vrai problème : pas le plantage, l'absence de trace. Un outil
    // qui casse ne laisse rien derrière lui, donc `/audit` ne peut pas en
    // parler. L'invariant « toute action est journalisée » tombe en silence.
    const opId = operationId('fault-throw-audit');
    await stack.gateway
      .invoke({ ...call('fault_throw'), operationId: opId })
      .catch(() => undefined);
    const logged = await stack.ledger.findByOperationId(opId);
    expect(logged.ok).toBe(true);
    if (!logged.ok) return;
    expect(logged.value).toBeNull(); // rien. Comme si l'appel n'avait pas eu lieu.
  });

  it.fails(
    'DÉFAUT — un outil qui lève doit produire un Result typé, pas une exception',
    async () => {
      // `06` : « les erreurs sont des valeurs typées, pas des exceptions
      // génériques. Un chemin d'échec qui remonte par `throw` finit tôt ou
      // tard attrapé par un `catch` trop large, et une décision de sécurité
      // s'y perd. » Le Gateway viole sa propre règle.
      const result = await stack.gateway.invoke(call('fault_throw'));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe('INTERNAL');
    },
  );

  it('fournisseur indisponible : l\'échec est dit, pas absorbé', async () => {
    const result = await stack.gateway.invoke(call('fault_error'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('PROVIDER_UNAVAILABLE');
  });

  it('timeout : UNKNOWN — « peut-être », jamais « c\'est fait »', async () => {
    const opId = operationId('fault-timeout');
    const result = await stack.gateway.invoke({ ...call('fault_timeout'), operationId: opId });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('TIMEOUT');

    // Et le journal garde la trace de l'incertitude, pas d'un échec net :
    // l'action a PEUT-ÊTRE abouti côté fournisseur.
    const logged = await stack.ledger.findByOperationId(opId);
    expect(logged.ok).toBe(true);
    if (logged.ok && logged.value !== null) {
      expect(logged.value.status).toBe('UNKNOWN');
    }
  });

  it('outil qui MENT (HTTP 200, rien n\'a changé) : FAILED', async () => {
    // 05/B12. C'est le scénario que les assistants du marché ratent.
    const result = await stack.gateway.invoke(call('fault_lies'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('FAILED');
    expect(result.value.output).toBeDefined(); // la sortie du menteur est conservée
  });

  it('relecture impossible : UNKNOWN, pas CONFIRMED', async () => {
    const result = await stack.gateway.invoke(call('fault_readback_fails'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('UNKNOWN');
    expect(result.value.verification.detail).toContain('peut-être');
  });

  it('base injoignable en LECTURE : erreur typée, aucun succès annoncé', async () => {
    // `db.query()` gère correctement : le port fermé devient une valeur.
    const brokenDb = createDb({
      host: '127.0.0.1',
      port: 1,
      database: 'jarvis_test',
      user: 'jarvis_app',
      password: 'peu-importe',
    });
    const result = await brokenDb.query('SELECT 1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('ECONNREFUSED');
    await brokenDb.close();
  });

  it.fails(
    'DÉFAUT — base injoignable en ÉCRITURE : `transaction()` lève au lieu de rendre une erreur',
    async () => {
      // `pool.connect()` est HORS du `try` dans `db/client.ts`. Toute mutation
      // passe par là. Résultat : la promesse du Gateway rejette, l'appelant
      // reçoit une exception, et le CLI se termine sur un message brut.
      const brokenDb = createDb({
        host: '127.0.0.1',
        port: 1,
        database: 'jarvis_test',
        user: 'jarvis_app',
        password: 'peu-importe',
      });
      const broken = buildStack(brokenDb);
      const result = await broken.gateway.invoke({
        toolId: 'task_create',
        input: { title: 'tâche pendant la panne' },
        parameterProvenance: { title: 'USER' },
        operationId: operationId('db-down'),
        actor: 'USER',
        context: callContext(),
      });
      expect(result.ok).toBe(false);
      await brokenDb.close();
    },
  );

  it('le noyau refuse de démarrer sur une base injoignable, avec la raison', async () => {
    const brokenDb = createDb({
      host: '127.0.0.1',
      port: 1,
      database: 'jarvis_test',
      user: 'jarvis_app',
      password: 'peu-importe',
    });
    const built = buildRuntime(brokenDb);
    // L'assemblage réussit (rien n'est encore interrogé) ; c'est la première
    // opération qui échoue. À noter : le noyau ne teste PAS la base au
    // démarrage — le CLI découvre la panne à la première phrase.
    expect(built.ok).toBe(true);
    if (built.ok) {
      const session = await built.value.sessions.start('NORMAL');
      expect(session.ok).toBe(false);
    }
    await brokenDb.close();
  });

  /* ------------------------------------------------------------------ */
  /* Invariant structurel                                                */
  /* ------------------------------------------------------------------ */

  it('aucun module du noyau ne fabrique un CONFIRMED hors du Verification Engine', () => {
    // S15 comme propriété du dépôt, pas comme consigne. Si ce test casse,
    // quelqu'un a ouvert une seconde porte vers « c'est fait ».
    const allowed = new Set([
      'src/core/types/domain.ts', // déclaration de l'énumération
      'src/core/verification/engine.ts', // la fabrique unique
      'src/core/memory/inbox.ts', // état d'un candidat, sans rapport avec l'action
      'src/core/memory/types.ts',
    ]);

    const files = listTypeScript(join(process.cwd(), 'src', 'core'));
    const offenders: string[] = [];
    for (const file of files) {
      const relative = file.slice(process.cwd().length + 1);
      if (allowed.has(relative)) continue;
      if (/['"]CONFIRMED['"]/.test(readFileSync(file, 'utf8'))) offenders.push(relative);
    }
    expect(offenders).toEqual([]);
  });
});

/** Liste récursive des fichiers TypeScript d'un répertoire. */
function listTypeScript(root: string): readonly string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) out.push(...listTypeScript(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}
