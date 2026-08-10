/**
 * LE FOURNISSEUR N'EST PAS UNE AUTORITÉ — Foundation 3.
 *
 * Nous avons posé qu'une sortie de modèle est une entrée non fiable
 * (ADR-024). Le mandat Foundation 3 pousse la même logique un cran plus loin,
 * et c'est le bon endroit où la pousser :
 *
 *   > Un fournisseur externe est une source d'OBSERVATION.
 *   > Pas une autorité absolue.
 *
 * Deux mensonges symétriques, et le second est le plus coûteux :
 *
 *   « SUCCESS » sans effet   → Jarvis annoncerait une action jamais faite
 *   « ERROR » après l'effet  → Jarvis conclurait à un échec, puis rejouerait
 *
 * Le premier trompe l'utilisateur. Le second double le virement.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseAvailable } from '../helpers/db.js';
import { buildLabStack, labCall, labDb, labKey, type LabStack } from './harness.js';
import { createHostileProvider, type HostileBehaviour, type EffectTiming } from './hostile-provider.js';
import { createBlindHostileTool, createHostileTool } from './hostile-tool.js';
import { createWorld, externalEffectCount, resetWorld, worldDb } from './world.js';
import { mayClaimSuccess } from '../../src/core/verification/engine.js';
import type { Db } from '../../src/core/db/client.js';

const enabled = databaseAvailable();

describe.runIf(enabled)('banc — le fournisseur ment', () => {
  let db: Db;
  let world: Db;

  beforeAll(async () => {
    db = labDb(15);
    world = worldDb(10);
    await createWorld(world);
  });

  afterAll(async () => {
    await db.close();
    await world.close();
  });

  beforeEach(async () => {
    await resetWorld(world);
  });

  /** Pile équipée d'un fournisseur au comportement choisi. */
  function stackWith(
    behaviour: HostileBehaviour,
    timing: EffectTiming,
    options: { blind?: boolean } = {},
  ): LabStack {
    const stack = buildLabStack(db);
    const provider = createHostileProvider(world, {
      id: 'hostile-menteur',
      behaviour,
      timing,
      latencyMs: 5,
    });
    stack.register(
      options.blind === true
        ? createBlindHostileTool({
            id: 'lab_external_send',
            provider,
            world,
          })
        : createHostileTool({ provider, world }),
    );
    return stack;
  }

  /* ================================================================== *
   * MENSONGE 1 — « c'est fait » alors que rien n'a bougé
   * ================================================================== */

  it('SUCCESS annoncé sans effet réel → jamais CONFIRMED', async () => {
    const stack = stackWith({ kind: 'SUCCESS_WITHOUT_EFFECT' }, 'NEVER');
    const key = labKey('lie-success');

    const result = await stack.gateway.invoke(labCall(key));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Le monde n'a pas bougé.
    expect(await externalEffectCount(world, key)).toBe(0);
    // Donc Jarvis ne peut pas annoncer un succès.
    expect(mayClaimSuccess(result.value.status)).toBe(false);

    /* ⚠ CE TEST ATTENDAIT `FAILED` JUSQU'À FOUNDATION 4.
       Il attend désormais `UNKNOWN`, et c'est un DURCISSEMENT, pas un recul.

       L'outil est `OBSERVABLE` : il sait constater un effet, il ne sait pas
       prouver qu'aucun effet différé n'arrivera. « Je ne vois rien » n'est pas
       « il n'y a rien » (ADR-030).

       Dire `FAILED` ici aurait autorisé une reprise — et si le fournisseur
       traitait en file d'attente, cette reprise aurait doublé l'effet. */
    expect(result.value.status).toBe('UNKNOWN');
    expect(result.value.verification.unknownReason).toBe('EXTERNAL_STATE');
  });

  it(
    'un outil aveugle à effet externe ne peut plus être AUTOMATIQUE',
    () => {
      /* Foundation 3 laissait cet outil s'enregistrer en L2 et rendre
         `PROBABLE`. Foundation 4 le REFUSE À L'ENREGISTREMENT :

           effet EXTERNAL + UNVERIFIABLE + autonomie automatique
             → illusion de fiabilité

         On n'interdit pas l'outil — un service d'emailing sans API de
         consultation reste utile. On interdit qu'il agisse sans qu'un humain
         l'ait voulu (ADR-030). La barrière est à l'enregistrement, ce qui est
         plus fort qu'une vérification à l'appel. */
      expect(() =>
        stackWith({ kind: 'SUCCESS_WITHOUT_EFFECT' }, 'NEVER', { blind: true }),
      ).toThrow(/Contrat d'outil invalide/);
    },
  );

  it(
    'le même outil aveugle est ACCEPTÉ en L3, et plafonné à PROBABLE',
    async () => {
      // La voie de sortie honnête : l'outil existe, mais son exécution passe
      // par une confirmation humaine, et son verdict ne dépasse jamais
      // `PROBABLE` faute d'observation indépendante.
      const stack = buildLabStack(db);
      stack.register(
        createBlindHostileTool({
          id: 'lab_external_send',
          autonomy: 'L3',
          provider: createHostileProvider(world, {
            id: 'hostile-aveugle',
            behaviour: { kind: 'SUCCESS_WITHOUT_EFFECT' },
            timing: 'NEVER',
          }),
          world,
        }),
      );

      const key = labKey('lie-blind-l3');
      const result = await stack.gateway.invoke(labCall(key));

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(await externalEffectCount(world, key)).toBe(0);
      expect(result.value.status).toBe('PROBABLE');
      expect(mayClaimSuccess(result.value.status)).toBe(false);
    },
  );

  /* ================================================================== *
   * MENSONGE 2 — « ça a échoué » alors que le monde a changé
   * ================================================================== */

  it('ERROR annoncé APRÈS un effet réel → jamais FAILED sec', async () => {
    const stack = stackWith({ kind: 'ERROR_AFTER_EFFECT' }, 'BEFORE_RESPONSE');
    const key = labKey('lie-error');

    const result = await stack.gateway.invoke(labCall(key));

    // Le monde A changé, quoi qu'ait dit le fournisseur.
    expect(await externalEffectCount(world, key)).toBe(1);

    // La question : Jarvis a-t-il cru le fournisseur sur parole ?
    const row = await db.query<{ state: string; status: string | null }>(
      'SELECT state, status FROM tool_operations WHERE operation_id = $1',
      [key],
    );
    expect(row.ok).toBe(true);
    if (!row.ok) return;

    const operation = row.value.rows[0];
    // Conclure FAILED serait affirmer qu'aucun effet n'a eu lieu — une
    // affirmation que rien n'étaye. Le seul état honnête est UNKNOWN.
    expect(operation?.state).toBe('UNKNOWN');
    expect(result.ok).toBe(false);
  });

  it(
    'après une erreur fournisseur, une reprise ne produit pas un second effet',
    async () => {
      const stack = stackWith({ kind: 'ERROR_AFTER_EFFECT' }, 'BEFORE_RESPONSE');
      const key = labKey('lie-error-replay');

      await stack.gateway.invoke(labCall(key));
      expect(await externalEffectCount(world, key)).toBe(1);

      // Cinq reprises. Aucune ne doit rejouer.
      for (let round = 0; round < 5; round += 1) {
        await stack.gateway.invoke(labCall(key));
      }
      expect(await externalEffectCount(world, key)).toBe(1);
    },
  );

  /* ================================================================== *
   * Le fournisseur qui traite APRÈS avoir répondu
   * ================================================================== */

  it(
    'effet différé après la réponse : le verdict immédiat n\'affirme pas le succès',
    async () => {
      // Le fournisseur accuse réception, puis traite en file d'attente. Au
      // moment où Jarvis relit, le monde n'a pas encore bougé.
      const stack = stackWith({ kind: 'NORMAL' }, 'AFTER_RESPONSE');
      const key = labKey('lie-async');

      const result = await stack.gateway.invoke(labCall(key));
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Jarvis ne peut pas annoncer un succès qu'il n'a pas constaté.
      expect(mayClaimSuccess(result.value.status)).toBe(false);

      // L'effet arrive ensuite. C'est une DETTE nommée : Jarvis a dit FAILED
      // d'une action qui finira par aboutir. Un fournisseur asynchrone exige
      // une réconciliation différée — elle n'existe pas, et `docs/18` le dit.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await externalEffectCount(world, key)).toBe(1);
    },
  );

  /* ================================================================== *
   * 429 / 5xx : aucun effet, et surtout aucun rejeu automatique
   * ================================================================== */

  it.each([429, 500, 503] as const)(
    'HTTP %i : aucun effet, aucun rejeu automatique',
    async (status) => {
      const stack = stackWith({ kind: 'HTTP', status }, 'NEVER');
      const key = labKey(`http-${String(status)}`);

      const result = await stack.gateway.invoke(labCall(key));

      expect(result.ok).toBe(false);
      expect(await externalEffectCount(world, key)).toBe(0);

      // Le fournisseur n'a été appelé qu'UNE fois : le Gateway n'a pas
      // réessayé de lui-même. `maxRetries` reste un champ mort, et c'est la
      // propriété voulue tant qu'`UNKNOWN` n'a pas de sémantique de rejeu.
      const row = await db.query<{ attempts: number }>(
        'SELECT attempts FROM tool_operations WHERE operation_id = $1',
        [key],
      );
      expect(row.ok).toBe(true);
      if (!row.ok) return;
      expect(row.value.rows[0]?.attempts ?? 0).toBe(1);
    },
  );

  it('connexion coupée : le processus survit et rien n\'est affirmé', async () => {
    const stack = stackWith({ kind: 'CONNECTION_RESET' }, 'NEVER');
    const key = labKey('reset');

    const result = await stack.gateway.invoke(labCall(key));
    expect(result.ok).toBe(false);
    expect(await externalEffectCount(world, key)).toBe(0);
  });

  it('timeout : UNKNOWN, jamais FAILED, et aucun rejeu', async () => {
    const stack = buildLabStack(db);
    stack.register(
      createHostileTool({
        provider: createHostileProvider(world, {
          id: 'hostile-lent',
          behaviour: { kind: 'TIMEOUT' },
          // L'effet a lieu AVANT que le fournisseur cesse de répondre : c'est
          // le cas dangereux, celui où le timeout ne dit rien de l'effet.
          timing: 'AFTER_EFFECT_BEFORE_RESPONSE',
        }),
        world,
        timeoutMs: 300,
      }),
    );

    const key = labKey('timeout');
    const result = await stack.gateway.invoke(labCall(key));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('TIMEOUT');

    // L'effet a bien eu lieu, et l'état le reconnaît comme incertain.
    expect(await externalEffectCount(world, key)).toBe(1);
    const row = await db.query<{ state: string; recovery_detail: string | null }>(
      'SELECT state, recovery_detail FROM tool_operations WHERE operation_id = $1',
      [key],
    );
    expect(row.ok).toBe(true);
    if (!row.ok) return;
    expect(row.value.rows[0]?.state).toBe('UNKNOWN');
    expect(row.value.rows[0]?.recovery_detail).toContain('PROVIDER_TIMEOUT');
  });
});
