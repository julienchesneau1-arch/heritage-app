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
      attemptVerification: 'NONE',
      effect: 'LOCAL_TRANSACTIONAL',
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

  it('un outil qui lève produit un Result typé, pas une exception', async () => {
    // Corrigé (HIGH-2). `06` pose que « les erreurs sont des valeurs typées,
    // pas des exceptions génériques ». Le Gateway violait sa propre règle.
    const result = await stack.gateway.invoke(call('fault_throw'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('INTERNAL');
    // Le message ne promet rien : l'outil a pu avoir un effet avant de lever.
    expect(result.error.message).toContain('peut-être');
  });

  it('et l\'incident laisse une trace au journal', async () => {
    // C'était le vrai problème : pas le plantage, l'absence de trace. Un outil
    // qui cassait ne laissait rien derrière lui, donc `/audit` ne pouvait pas
    // en parler. L'invariant « toute action est journalisée » tombait en
    // silence.
    const opId = operationId('fault-throw-audit');
    await stack.gateway.invoke({ ...call('fault_throw'), operationId: opId });
    const logged = await stack.ledger.findByOperationId(opId);
    expect(logged.ok).toBe(true);
    if (!logged.ok || logged.value === null) throw new Error('incident non journalisé');
    expect(logged.value.eventType).toContain('CRASHED');
    // UNKNOWN, pas FAILED : on ignore si l'outil a eu un effet avant de lever.
    expect(logged.value.status).toBe('UNKNOWN');
  });

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

  it('base injoignable en ÉCRITURE : erreur typée, aucune exception', async () => {
    // Corrigé (HIGH-3). `pool.connect()` était HORS du `try` : toute mutation
    // passait par là, donc toute mutation rejetait au lieu de rendre une
    // valeur. Le CLI se terminait sur un message brut.
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
      // `dueAt` doit être renseigné : un paramètre sensible absent de la carte
      // vaut EXTERNAL_UNTRUSTED, et déclencherait une confirmation avant même
      // que la panne de base ne soit constatée.
      parameterProvenance: { title: 'USER', dueAt: 'USER' },
      operationId: operationId('db-down'),
      actor: 'USER',
      context: callContext(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // La panne de connexion est distinguée d'un défaut interne : deux
      // conduites différentes, deux messages différents.
      expect(result.error.kind).toBe('PROVIDER_UNAVAILABLE');
    }
    await brokenDb.close();
  });

  it('base tombée : Jarvis REFUSE d\'agir plutôt que de tenter à l\'aveugle', async () => {
    // CRIT-1, second volet. Tout passe par PostgreSQL : la politique lit, le
    // journal écrit, la vérification relit. Tenter une action base coupée
    // laisserait un état indéterminé — et c'est exactement ce qu'on ne veut
    // jamais annoncer comme fait.
    const brokenDb = createDb({
      host: '127.0.0.1',
      port: 1,
      database: 'jarvis_test',
      user: 'jarvis_app',
      password: 'peu-importe',
    });
    const broken = buildStack(brokenDb);
    const first = await broken.gateway.invoke({
      toolId: 'task_create',
      input: { title: 'première tentative' },
      // `dueAt` doit être renseigné : un paramètre sensible absent de la carte
      // vaut EXTERNAL_UNTRUSTED, et déclencherait une confirmation avant même
      // que la panne de base ne soit constatée.
      parameterProvenance: { title: 'USER', dueAt: 'USER' },
      operationId: operationId('db-down-1'),
      actor: 'USER',
      context: callContext(),
    });
    expect(first.ok).toBe(false);
    expect(brokenDb.health().state).toBe('DOWN');

    // La seconde tentative ne réessaie même pas l'outil : elle sonde, échoue,
    // et le dit sans ambiguïté.
    const second = await broken.gateway.invoke({
      toolId: 'task_create',
      input: { title: 'seconde tentative' },
      // `dueAt` doit être renseigné : un paramètre sensible absent de la carte
      // vaut EXTERNAL_UNTRUSTED, et déclencherait une confirmation avant même
      // que la panne de base ne soit constatée.
      parameterProvenance: { title: 'USER', dueAt: 'USER' },
      operationId: operationId('db-down-2'),
      actor: 'USER',
      context: callContext(),
    });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.kind).toBe('PROVIDER_UNAVAILABLE');
      expect(second.error.message).toContain('Rien n\'a été tenté');
    }
    await brokenDb.close();
  });

  it('base saine : l\'état de santé est UP et le reste', async () => {
    expect(db.health().state).toBe('UP');
    const result = await stack.gateway.invoke(call('fault_lies'));
    expect(result.ok).toBe(true);
    expect(db.health().state).toBe('UP');
  });

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
