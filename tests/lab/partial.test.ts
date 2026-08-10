/**
 * SUCCÈS PARTIEL — Foundation 3, constat avant spécification.
 *
 * Le mandat demande de spécifier `PARTIAL` AVANT de l'implémenter, et d'y
 * réfléchir plutôt que de l'ajouter parce que « ça semble logique ». Ce fichier
 * fournit la matière du raisonnement : ce que le système fait AUJOURD'HUI face
 * à un envoi à cinq destinataires dont trois aboutissent.
 *
 * IL Y RÉVÈLE UNE CHOSE QU'ON N'ATTENDAIT PAS
 * -------------------------------------------
 * L'inégalité fondamentale du sprint est MAL FORMULÉE :
 *
 *     external_effect_count ≤ 1            ← ce qu'on écrivait
 *     external_effect_count(cible) ≤ 1     ← ce qu'il fallait écrire
 *
 * Une opération à cinq destinataires produit légitimement cinq effets. La
 * garantie ne porte pas sur l'opération, elle porte sur le couple
 * (clé d'opération, cible). Tant qu'aucun outil n'avait plusieurs cibles, la
 * distinction était invisible — et fausse quand même.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseAvailable } from '../helpers/db.js';
import { buildLabStack, labCall, labDb, labKey } from './harness.js';
import { createHostileProvider } from './hostile-provider.js';
import { createHostileTool } from './hostile-tool.js';
import { createWorld, effectsFor, externalEffectCount, resetWorld, worldDb } from './world.js';
import { VerificationStatus } from '../../src/core/types/domain.js';
import type { Db } from '../../src/core/db/client.js';

const enabled = databaseAvailable();
const DESTINATAIRES = ['anne', 'bruno', 'chloé', 'david', 'eva'] as const;

describe.runIf(enabled)('banc — succès partiel', () => {
  let db: Db;
  let world: Db;

  beforeAll(async () => {
    db = labDb(10);
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

  function partialStack(succeed: number) {
    const stack = buildLabStack(db);
    stack.register(
      createHostileTool({
        provider: createHostileProvider(world, {
          id: 'hostile-partiel',
          behaviour: { kind: 'PARTIAL', succeed },
          timing: 'BEFORE_RESPONSE',
          targets: DESTINATAIRES,
          latencyMs: 5,
        }),
        world,
      }),
    );
    return stack;
  }

  /* ------------------------------------------------------------------ */

  it('3 destinataires sur 5 : le monde porte bien 3 effets distincts', async () => {
    const key = labKey('partiel');
    await partialStack(3).gateway.invoke(labCall(key));

    expect(await externalEffectCount(world, key)).toBe(3);

    const effects = await effectsFor(world, key);
    const servis = effects.map((e) => e.target).sort();
    expect(servis).toEqual(['anne', 'bruno', 'chloé']);

    // Deux destinataires n'ont RIEN reçu, et personne ne sait s'ils
    // recevront : le fournisseur les a déclarés `UNCERTAIN`.
    const nonServis = DESTINATAIRES.filter((d) => !servis.includes(d));
    expect(nonServis).toEqual(['david', 'eva']);
  });

  it(
    'AUJOURD\'HUI, ce succès partiel est rapporté comme un ÉCHEC TOTAL',
    async () => {
      const key = labKey('partiel-verdict');
      const result = await partialStack(3).gateway.invoke(labCall(key));

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Le verdict est `FAILED`. C'est faux dans les deux sens :
      //   — trois personnes ONT reçu le message ;
      //   — deux ne l'ont pas reçu, et ce n'est pas un échec constaté non plus.
      //
      // Dire « échec » ferait rejouer l'envoi aux cinq. Dire « succès »
      // laisserait deux personnes sans message. Aucun des quatre statuts
      // existants ne décrit la situation.
      expect(result.value.status).toBe('FAILED');
    },
  );

  it(
    'aucun des quatre statuts existants ne peut décrire un succès partiel',
    () => {
      // Preuve STRUCTURELLE, exhaustive sur l'énumération : si un cinquième
      // statut apparaît un jour, ce test le signalera au lieu de rester vert.
      const descriptions: Record<
        (typeof VerificationStatus.options)[number],
        string
      > = {
        CONFIRMED: 'affirme que les cinq ont reçu — faux',
        PROBABLE: 'suppose les cinq sans preuve — faux ET non vérifié',
        UNKNOWN: 'nie savoir, alors que trois sont CONFIRMÉS — perte d\'information',
        FAILED: 'affirme que personne n\'a reçu — faux',
      };

      expect(Object.keys(descriptions).sort()).toEqual(
        [...VerificationStatus.options].sort(),
      );
      // Chacun est faux pour une raison différente. C'est la définition d'une
      // valeur manquante, pas d'un mauvais choix parmi les valeurs existantes.
      expect(Object.keys(descriptions).length).toBe(4);
    },
  );

  it(
    'l\'inégalité fondamentale doit se lire PAR CIBLE, pas par opération',
    async () => {
      const key = labKey('partiel-inegalite');
      await partialStack(3).gateway.invoke(labCall(key));

      const effects = await effectsFor(world, key);

      // Par opération : 3 > 1. L'inégalité telle qu'écrite est VIOLÉE.
      expect(effects.length).toBeGreaterThan(1);

      // Par cible : chacune reçoit au plus une fois. C'est la vraie garantie,
      // et c'est celle qui empêche le double virement.
      const parCible = new Map<string, number>();
      for (const effect of effects) {
        parCible.set(effect.target, (parCible.get(effect.target) ?? 0) + 1);
      }
      for (const [, count] of parCible) {
        expect(count).toBeLessThanOrEqual(1);
      }
    },
  );

  it(
    'une reprise après succès partiel ne resserve PAS ceux déjà servis',
    async () => {
      const key = labKey('partiel-reprise');
      const stack = partialStack(3);

      await stack.gateway.invoke(labCall(key));
      expect(await externalEffectCount(world, key)).toBe(3);

      // Cinq reprises. Le journal d'intention refuse de rejouer : c'est
      // correct pour les trois déjà servis, et cela laisse les deux autres
      // définitivement non servis. La protection fonctionne au prix d'une
      // perte — et c'est exactement ce que `PARTIAL` doit résoudre.
      for (let round = 0; round < 5; round += 1) {
        await stack.gateway.invoke(labCall(key));
      }

      expect(await externalEffectCount(world, key)).toBe(3);
    },
  );
});
