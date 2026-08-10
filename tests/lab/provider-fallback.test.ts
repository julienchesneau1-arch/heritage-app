/**
 * REPLI D'UN FOURNISSEUR SUR UN AUTRE — Foundation 3.
 *
 * Le scénario nommé par le mandat, et il est vicieux :
 *
 *     A ──► effet ──► timeout
 *                        │
 *                        ▼
 *                  Jarvis : UNKNOWN
 *                        │
 *                        ▼
 *                   « j'essaie B »
 *                        │
 *                        ▼
 *                    B ──► effet          💥 DEUX EFFETS
 *
 * La règle qui en découle, et qui vaut d'être énoncée seule :
 *
 *   > Un changement de fournisseur ne constitue JAMAIS une preuve que le
 *   > premier fournisseur n'a pas exécuté l'action.
 *
 * Ce fichier mesure ce que la clé d'opération protège — et ce qu'elle ne
 * protège pas. La seconde partie est la plus importante.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseAvailable } from '../helpers/db.js';
import { buildLabStack, labCall, labDb, labKey } from './harness.js';
import { createHostileProvider } from './hostile-provider.js';
import { createHostileTool } from './hostile-tool.js';
import {
  createWorld,
  effectCountByProvider,
  externalEffectCount,
  resetWorld,
  worldDb,
} from './world.js';
import type { Db } from '../../src/core/db/client.js';
import type { LabStack } from './harness.js';
import {
  isExternalEffect,
  mayReplayAfterUnknown,
} from '../../src/core/types/domain.js';

const enabled = databaseAvailable();

describe.runIf(enabled)('banc — repli entre fournisseurs', () => {
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

  /** Fournisseur A : produit l'effet, puis ne répond jamais. */
  function stackA(): LabStack {
    const stack = buildLabStack(db);
    stack.register(
      createHostileTool({
        provider: createHostileProvider(world, {
          id: 'fournisseur-A',
          behaviour: { kind: 'TIMEOUT' },
          timing: 'AFTER_EFFECT_BEFORE_RESPONSE',
        }),
        world,
        timeoutMs: 250,
      }),
    );
    return stack;
  }

  /** Fournisseur B : parfaitement sain. C'est ce qui le rend dangereux. */
  function stackB(): LabStack {
    const stack = buildLabStack(db);
    stack.register(
      createHostileTool({
        provider: createHostileProvider(world, {
          id: 'fournisseur-B',
          behaviour: { kind: 'NORMAL' },
          timing: 'BEFORE_RESPONSE',
          latencyMs: 5,
        }),
        world,
        timeoutMs: 2_000,
      }),
    );
    return stack;
  }

  /* ================================================================== *
   * CE QUI EST GARANTI
   * ================================================================== */

  it(
    'repli SUR LA MÊME CLÉ après un timeout de A : B n\'exécute pas',
    async () => {
      const key = labKey('fallback-meme-cle');

      // A : l'effet part, la réponse jamais.
      const first = await stackA().gateway.invoke(labCall(key));
      expect(first.ok).toBe(false);
      expect(await externalEffectCount(world, key)).toBe(1);
      expect(await effectCountByProvider(world, 'fournisseur-A')).toBe(1);

      // Le routeur « bascule sur B » — en conservant la clé d'opération.
      const second = await stackB().gateway.invoke(labCall(key));

      // B n'a rien produit : le journal d'intention a vu l'état UNKNOWN et a
      // refusé de rejouer, quel que soit le fournisseur qui se présente.
      expect(await effectCountByProvider(world, 'fournisseur-B')).toBe(0);
      expect(await externalEffectCount(world, key)).toBe(1);

      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.value.status).toBe('UNKNOWN');
      expect(second.value.replayed).toBe(true);
    },
  );

  it(
    'même sous 20 replis concurrents, B reste sans effet',
    async () => {
      const key = labKey('fallback-concurrent');
      await stackA().gateway.invoke(labCall(key));
      expect(await externalEffectCount(world, key)).toBe(1);

      const b = stackB();
      await Promise.all(
        Array.from({ length: 20 }, () => b.gateway.invoke(labCall(key))),
      );

      expect(await effectCountByProvider(world, 'fournisseur-B')).toBe(0);
      expect(await externalEffectCount(world, key)).toBe(1);
    },
  );

  /* ================================================================== *
   * CE QUI N'EST PAS GARANTI — et qu'il faut écrire noir sur blanc
   * ================================================================== */

  it(
    'repli avec une NOUVELLE clé : le double effet se produit — trou nommé',
    async () => {
      // Ce test ne dénonce pas un défaut du Gateway : il montre que la
      // protection est portée par la CLÉ, et par rien d'autre. Un routeur qui
      // frappe une nouvelle clé pour « réessayer ailleurs » n'effectue pas un
      // repli — il lance une SECONDE ACTION, et rien dans le noyau ne peut le
      // deviner.
      //
      // C'est l'invariant que Foundation 4 devra rendre structurel :
      //
      //   un repli conserve la clé d'opération, ou ce n'est pas un repli.
      const keyA = labKey('fallback-cleA');
      const keyB = labKey('fallback-cleB');

      await stackA().gateway.invoke(labCall(keyA));
      await stackB().gateway.invoke(labCall(keyB));

      expect(await externalEffectCount(world, keyA)).toBe(1);
      expect(await externalEffectCount(world, keyB)).toBe(1);

      // Deux effets pour une seule intention utilisateur. Aucune règle du
      // noyau ne l'empêche aujourd'hui, parce que le noyau ne voit pas
      // l'intention — il ne voit que des clés.
      const total =
        (await effectCountByProvider(world, 'fournisseur-A')) +
        (await effectCountByProvider(world, 'fournisseur-B'));
      expect(total).toBe(2);
    },
  );

  /* ================================================================== *
   * La règle de repli dépend du TYPE d'effet, pas du fournisseur
   * ================================================================== */

  it(
    'un outil à effet EXTERNAL laisse UNKNOWN — jamais de conclusion d\'absence',
    async () => {
      const key = labKey('fallback-external');
      await stackA().gateway.invoke(labCall(key));

      const row = await db.query<{ state: string; recovery_detail: string | null }>(
        'SELECT state, recovery_detail FROM tool_operations WHERE operation_id = $1',
        [key],
      );
      expect(row.ok).toBe(true);
      if (!row.ok) return;

      // `UNKNOWN` est la seule conclusion défendable, et c'est elle qui
      // interdit le repli automatique : on ne bascule pas sur B « parce que A
      // a échoué », puisque A n'a pas échoué — on ne sait pas.
      expect(row.value.rows[0]?.state).toBe('UNKNOWN');
    },
  );

  it(
    'le champ effect distingue ce qui peut être repris de ce qui ne le peut pas',
    async () => {
      // Propriété STRUCTURELLE, pas comportementale : c'est la déclaration de
      // l'outil qui décide si une erreur autorise à conclure à l'absence
      // d'effet. Un futur routeur doit lire ce champ, et lui seul.
      const externalTool = createHostileTool({
        provider: createHostileProvider(world, {
          id: 'peu-importe',
          behaviour: { kind: 'NORMAL' },
          timing: 'NEVER',
        }),
        world,
      });
      /* Le champ a gagné en précision avec ADR-033 : il ne dit plus seulement
         « externe », il dit CE QU'ON A LE DROIT DE FAIRE après un UNKNOWN.
         `EXTERNALLY_VERIFIABLE` = interrogeable, mais NON idempotent, donc
         jamais rejouable. */
      expect(externalTool.definition.effect).toBe('EXTERNALLY_VERIFIABLE');
      expect(mayReplayAfterUnknown(externalTool.definition.effect)).toBe(false);
      expect(isExternalEffect(externalTool.definition.effect)).toBe(true);

      // Les cinq outils du noyau, eux, sont transactionnels : une erreur y
      // signifie bien un rollback, donc l'absence d'effet.
      const { registerCoreTools } = await import('../../src/tools/index.js');
      expect(typeof registerCoreTools).toBe('function');
    },
  );
});
