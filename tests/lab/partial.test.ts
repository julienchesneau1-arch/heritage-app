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
import { mayClaimSuccess } from '../../src/core/verification/engine.js';
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
    'le verdict global d\'un succès partiel reste non affirmatif',
    async () => {
      const key = labKey('partiel-verdict');
      const result = await partialStack(3).gateway.invoke(labCall(key));

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      /* Foundation 3 rendait `FAILED` — faux dans les deux sens : trois
         personnes AVAIENT reçu le message.

         Foundation 4 rend `UNKNOWN` : l'outil est `OBSERVABLE`, il ne peut pas
         prouver que les deux autres ne recevront jamais. C'est moins faux,
         mais toujours insuffisant — le verdict global perd l'information « qui
         a reçu ».

         `PARTIAL` et le modèle par cible existent désormais
         (`src/core/tools/outcome.ts`). Les BRANCHER au Gateway est la dette
         nommée que `docs/20 §4` porte : le Gateway n'a pas encore de notion de
         cible à lui passer. */
      expect(result.value.status).toBe('UNKNOWN');
      expect(mayClaimSuccess(result.value.status)).toBe(false);
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
        PROVIDER_CONTRACT_VIOLATION:
          'accuse la SOURCE, alors que le fournisseur a fait exactement ce ' +
          "qu'il annonçait — trois sur cinq n'est pas une rupture de contrat",
        NOT_ATTEMPTED: 'affirme qu\'on n\'a rien tenté — faux',
        PARTIAL: 'DÉCRIT LA SITUATION — ajouté par Foundation 4',
      };

      expect(Object.keys(descriptions).sort()).toEqual(
        [...VerificationStatus.options].sort(),
      );
      // Le constat de Foundation 3 : quatre statuts, tous faux. Foundation 4
      // en a ajouté deux, dont celui qui décrit réellement la situation.
      expect(Object.keys(descriptions).length).toBe(7);
      expect(VerificationStatus.options).toContain('PARTIAL');
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
