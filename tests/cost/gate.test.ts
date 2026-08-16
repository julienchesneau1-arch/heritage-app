/**
 * LE COSTGATE — `docs/04 §9-11`, `docs/14 §4`, ADR-040.
 *
 * CE QUE CE FICHIER ÉPROUVE, DANS L'ORDRE D'IMPORTANCE
 * -----------------------------------------------------
 *   1. le coût ne décide JAMAIS de l'éligibilité      `docs/14 §4`
 *   2. le budget par défaut est un vrai zéro          `docs/04 §9`
 *   3. aucun dépassement SILENCIEUX                   `docs/04 §9`
 *   4. l'arithmétique est exacte                      pas de flottant sur un seuil
 *
 * Le premier est le seul qui soit une question de SÛRETÉ. Les trois autres
 * sont des questions d'exactitude — importantes, mais d'un autre ordre.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { appDb, databaseAvailable, ownerDb } from '../helpers/db.js';
import {
  createCostGate,
  eurosToMicros,
  microsToEuros,
  type CostGateConfig,
  type Micros,
} from '../../src/core/cost/gate.js';
import type { Db } from '../../src/core/db/client.js';

const enabled = databaseAvailable();

const DEFAUT: CostGateConfig = {
  budgetMonthlyEur: 0,
  alertAtPercent: 50,
  hardBlockAtPercent: 100,
  cloudEnabled: true,
};

describe.runIf(enabled)('CostGate', () => {
  let db: Db;
  /* Le nettoyage passe par le rôle PROPRIÉTAIRE, parce que le rôle applicatif
     n'a délibérément pas le droit de supprimer une ligne de dépense — voir la
     migration 0010, et le test dédié plus bas. */
  let owner: Db;

  beforeAll(() => {
    db = appDb();
    owner = ownerDb();
  });

  afterAll(async () => {
    await db.close();
    await owner.close();
  });

  afterEach(async () => {
    await owner.query('DELETE FROM cloud_spend');
  });

  const gate = (patch: Partial<CostGateConfig> = {}) =>
    createCostGate({ db, config: { ...DEFAUT, ...patch } });

  const requete = (patch: Record<string, unknown> = {}) => ({
    provider: 'fournisseur-test',
    model: 'modele-test',
    allowance: 'LOCAL_OR_CLOUD' as const,
    estimated: eurosToMicros(0.01),
    privacyClass: 'GREEN' as const,
    importance: 'ROUTINE' as const,
    ...patch,
  });

  /* ================================================================== *
   * 1. LE COÛT NE DÉCIDE JAMAIS DE L'ÉLIGIBILITÉ — `docs/14 §4`
   *
   * La seule propriété de SÛRETÉ du module, et celle qu'on attaque le plus.
   * ================================================================== */

  describe("l'ordre qui interdit au coût de décider", () => {
    it('LOCAL_ONLY reste local même avec un budget ILLIMITÉ', async () => {
      /* Le contre-exemple qui compte : si le coût pouvait promouvoir, il
         suffirait d'avoir de l'argent pour contourner la confidentialité.

         `docs/14 §4` : « Un modèle non autorisé n'existe pas comme repli —
         même si tous les modèles autorisés sont indisponibles. » */
      const g = gate({ budgetMonthlyEur: 1_000_000 });
      const verdict = await g.decide(
        requete({ allowance: 'LOCAL_ONLY', privacyClass: 'RED' }),
      );

      expect(verdict.ok).toBe(true);
      if (!verdict.ok) return;
      expect(verdict.value.decision).toBe('ALLOW_LOCAL');
      expect(verdict.value.decision).not.toBe('ALLOW_CLOUD');
    });

    it('LOCAL_ONLY reste local pour une requête IMPORTANTE', async () => {
      // L'importance ne rachète pas davantage que l'argent.
      const g = gate({ budgetMonthlyEur: 1_000 });
      const verdict = await g.decide(
        requete({ allowance: 'LOCAL_ONLY', importance: 'IMPORTANT' }),
      );
      expect(verdict.ok).toBe(true);
      if (!verdict.ok) return;
      expect(verdict.value.decision).toBe('ALLOW_LOCAL');
    });

    it("la raison du refus ne mentionne PAS le budget quand c'est la politique", async () => {
      /* `docs/04 §10` exige la raison du routage. Une raison qui invoquerait
         le budget là où la politique a tranché ferait croire qu'augmenter le
         budget changerait quelque chose. */
      const g = gate({ budgetMonthlyEur: 0 });
      const verdict = await g.decide(requete({ allowance: 'LOCAL_ONLY' }));
      expect(verdict.ok).toBe(true);
      if (!verdict.ok) return;
      expect(verdict.value.reason).toContain('politique');
      expect(verdict.value.reason).toContain("n'entre pas en ligne de compte");
    });
  });

  /* ================================================================== *
   * 2. LE DÉFAUT DU PACK EST UN VRAI ZÉRO — `docs/04 §9`
   * ================================================================== */

  describe('budget 0 € — le défaut', () => {
    it('aucun appel cloud n\'est engagé, quelle que soit son estimation', async () => {
      const g = gate({ budgetMonthlyEur: 0 });

      for (const estime of [0, 0.000_001, 0.01, 1_000]) {
        const verdict = await g.decide(
          requete({ estimated: eurosToMicros(estime) }),
        );
        expect(verdict.ok).toBe(true);
        if (!verdict.ok) return;
        expect(verdict.value.decision).toBe('ALLOW_LOCAL');
      }
    });

    it("même une estimation NULLE ne fait pas passer un appel cloud", async () => {
      /* Le contournement évident : estimer zéro. Un budget nul doit refuser
         le CHEMIN, pas le montant — sinon toute estimation optimiste
         ouvrirait la porte. */
      const g = gate({ budgetMonthlyEur: 0 });
      const verdict = await g.decide(requete({ estimated: 0 as Micros }));
      expect(verdict.ok).toBe(true);
      if (!verdict.ok) return;
      expect(verdict.value.decision).toBe('ALLOW_LOCAL');
    });
  });

  /* ================================================================== *
   * 3. AUCUN DÉPASSEMENT SILENCIEUX — `docs/04 §9`
   * ================================================================== */

  describe('aucun dépassement silencieux', () => {
    it('la décision porte sur « dépensé + estimation », pas sur « dépensé »', async () => {
      /* La nuance qui fait tout : décider sur le dépensé seul autoriserait un
         appel qui déborde, et le dépassement ne serait constaté qu'APRÈS. */
      const g = gate({ budgetMonthlyEur: 1 });

      // On consomme 0,90 € du budget.
      await g.record({
        provider: 'p',
        model: 'm',
        decision: 'ALLOW_CLOUD',
        reason: 'mise en place',
        privacyClass: 'GREEN',
        estimated: eurosToMicros(0.9),
        actual: eurosToMicros(0.9),
      });

      // Un appel à 0,05 € passe : 0,95 € reste sous le plafond.
      const petit = await g.decide(requete({ estimated: eurosToMicros(0.05) }));
      expect(petit.ok).toBe(true);
      if (petit.ok) expect(petit.value.decision).toBe('ALLOW_CLOUD');

      // Un appel à 0,20 € est refusé AVANT de partir : 1,10 € déborderait.
      const gros = await g.decide(requete({ estimated: eurosToMicros(0.2) }));
      expect(gros.ok).toBe(true);
      if (!gros.ok) return;
      expect(gros.value.decision).toBe('DENY');
      expect(gros.value.reason).toContain('Blocage dur');
    });

    it("une requête IMPORTANTE est SOUMISE à l'utilisateur, pas refusée en silence", async () => {
      /* `docs/04` interdit le dépassement SILENCIEUX — pas la question posée.
         Refuser sans rien dire une opération importante serait une
         dégradation invisible, ce qui est le défaut symétrique. */
      const g = gate({ budgetMonthlyEur: 1 });
      await g.record({
        provider: 'p',
        model: 'm',
        decision: 'ALLOW_CLOUD',
        reason: 'mise en place',
        privacyClass: 'GREEN',
        estimated: eurosToMicros(0.99),
        actual: eurosToMicros(0.99),
      });

      const verdict = await g.decide(
        requete({ estimated: eurosToMicros(0.5), importance: 'IMPORTANT' }),
      );
      expect(verdict.ok).toBe(true);
      if (!verdict.ok) return;
      expect(verdict.value.decision).toBe('ASK_USER');
    });

    it("l'alerte à 50 % est levée AVANT le blocage, pas avec lui", async () => {
      const g = gate({ budgetMonthlyEur: 1 });

      const avant = await g.decide(requete());
      expect(avant.ok).toBe(true);
      if (avant.ok) expect(avant.value.alert).toBe(false);

      await g.record({
        provider: 'p',
        model: 'm',
        decision: 'ALLOW_CLOUD',
        reason: 'mise en place',
        privacyClass: 'GREEN',
        estimated: eurosToMicros(0.6),
        actual: eurosToMicros(0.6),
      });

      const apres = await g.decide(requete());
      expect(apres.ok).toBe(true);
      if (!apres.ok) return;
      // Alerte levée, ET l'appel passe encore : c'est bien un avertissement.
      expect(apres.value.alert).toBe(true);
      expect(apres.value.decision).toBe('ALLOW_CLOUD');
      expect(apres.value.reason).toContain("seuil d'alerte");
    });

    it('un dépassement sur le coût RÉEL est rendu, jamais avalé', async () => {
      /* Le cas qu'on ne peut pas empêcher : une estimation basse. Le blocage
         dur travaille sur l'estimation, donc le seuil peut être franchi après
         coup, sur le réel.

         Ce qui EST évitable, c'est que ça passe inaperçu. */
      const g = gate({ budgetMonthlyEur: 1 });
      const written = await g.record({
        provider: 'p',
        model: 'm',
        decision: 'ALLOW_CLOUD',
        reason: 'estimation optimiste',
        privacyClass: 'GREEN',
        estimated: eurosToMicros(0.1),
        actual: eurosToMicros(1.5),
      });

      expect(written.ok).toBe(true);
      if (!written.ok) return;
      expect(written.value.overrun).toBe(true);
    });
  });

  /* ================================================================== *
   * 4. L'ARITHMÉTIQUE EST EXACTE
   * ================================================================== */

  describe('monnaie en entiers', () => {
    it("dix mille appels à 0,0001 € font EXACTEMENT 1 €", () => {
      /* Le défaut classique : en flottant, cette somme ne rend pas 1. Sur un
         seuil de blocage, l'approximation transforme « à 100 % » en « vers
         100 % » — et le dépassement n'apparaît qu'après. */
      const unite = eurosToMicros(0.0001);
      let total = 0;
      for (let i = 0; i < 10_000; i += 1) total += unite;

      expect(total).toBe(1_000_000);
      expect(microsToEuros(total)).toBe(1);
      expect(Number.isInteger(total)).toBe(true);
    });

    it("l'arrondi va toujours dans la direction qui PROTÈGE", () => {
      /* Arrondi au supérieur, des deux côtés : un budget arrondi vers le bas
         serait dépassé sans le dire, une estimation arrondie vers le bas
         laisserait passer un appel qui déborde. Les deux erreurs iraient dans
         la même mauvaise direction. */
      expect(eurosToMicros(0.000_000_1)).toBe(1);
      expect(eurosToMicros(1.000_000_4)).toBe(1_000_001);
    });
  });

  /* ================================================================== *
   * 5. LE TABLEAU DE BORD — `docs/04 §11`
   * ================================================================== */

  describe('tableau de bord', () => {
    it("un dépôt sans aucun appel affiche 100 % local, et c'est EXACT", async () => {
      /* Rendre 0 % laisserait croire à une dérive architecturale qui n'existe
         pas : tout ce qui a été fait l'a bien été localement. */
      const résumé = await gate().summary();
      expect(résumé.ok).toBe(true);
      if (!résumé.ok) return;
      expect(résumé.value.localRatio).toBe(1);
      expect(résumé.value.monthMicros).toBe(0);
      expect(résumé.value.mostExpensive).toBeNull();
    });

    it('rapporte la dépense, le ratio local et la tâche la plus coûteuse', async () => {
      const g = gate({ budgetMonthlyEur: 10 });

      await g.record({
        provider: 'alpha',
        model: 'petit',
        decision: 'ALLOW_CLOUD',
        reason: 'routine',
        privacyClass: 'GREEN',
        estimated: eurosToMicros(0.02),
        actual: eurosToMicros(0.02),
      });
      await g.record({
        provider: 'beta',
        model: 'gros',
        decision: 'ALLOW_CLOUD',
        reason: 'routine',
        privacyClass: 'GREEN',
        estimated: eurosToMicros(0.5),
        actual: eurosToMicros(0.5),
      });
      await g.record({
        provider: 'local',
        model: 'local',
        decision: 'ALLOW_LOCAL',
        reason: 'budget nul',
        privacyClass: 'GREEN',
        estimated: 0 as Micros,
      });

      const résumé = await g.summary();
      expect(résumé.ok).toBe(true);
      if (!résumé.ok) return;

      expect(résumé.value.monthMicros).toBe(eurosToMicros(0.52));
      expect(résumé.value.byProvider).toHaveLength(2);
      expect(résumé.value.byProvider[0]?.provider).toBe('beta');
      expect(résumé.value.mostExpensive?.model).toBe('gros');
      // Un appel local sur trois.
      expect(résumé.value.localRatio).toBeCloseTo(1 / 3, 5);
    });
  });

  /* ================================================================== *
   * 6. L'INTERRUPTEUR GLOBAL — I2
   * ================================================================== */

  it('cloud désactivé globalement : aucun appel, quel que soit le budget', async () => {
    const g = gate({ budgetMonthlyEur: 1_000, cloudEnabled: false });
    const verdict = await g.decide(requete());
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.value.decision).toBe('ALLOW_LOCAL');
    expect(verdict.value.reason).toContain('désactivé globalement');
  });

  /* ================================================================== *
   * 7. LE PLAFOND NE SE CONTOURNE PAS EN EFFAÇANT L'HISTORIQUE
   * ================================================================== */

  it("le rôle applicatif ne peut PAS supprimer une ligne de dépense", async () => {
    /* La question posée en écrivant la migration : si l'application peut
       effacer des lignes, elle peut remettre le compteur à zéro — et le
       blocage dur devient une suggestion.

       Le contournement ne demanderait même pas de malveillance : un
       « nettoyage » de maintenance suffirait. */
    const g = gate({ budgetMonthlyEur: 1 });
    await g.record({
      provider: 'p',
      model: 'm',
      decision: 'ALLOW_CLOUD',
      reason: 'dépense à effacer',
      privacyClass: 'GREEN',
      estimated: eurosToMicros(0.5),
      actual: eurosToMicros(0.5),
    });

    const efface = await db.query('DELETE FROM cloud_spend');
    expect(efface.ok).toBe(false);

    const modifie = await db.query('UPDATE cloud_spend SET actual_micros = 0');
    expect(modifie.ok).toBe(false);

    // Et la dépense est toujours comptée.
    const verdict = await g.decide(requete());
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.value.spentMicros).toBe(eurosToMicros(0.5));
  });

  /* ================================================================== *
   * 8. LE MOIS EST CALCULÉ PAR LA BASE — I19
   * ================================================================== */

  it("le budget du mois ne dépend pas de l'horloge du PROCESSUS", async () => {
    /* La leçon d'ADR-037 appliquée d'emblée : un processus dont l'horloge
       dérive d'un mois lirait sinon un budget vide, et dépenserait deux fois
       le plafond sans que rien ne le signale. */
    const g = gate({ budgetMonthlyEur: 1 });
    await g.record({
      provider: 'p',
      model: 'm',
      decision: 'ALLOW_CLOUD',
      reason: 'mise en place',
      privacyClass: 'GREEN',
      estimated: eurosToMicros(0.9),
      actual: eurosToMicros(0.9),
    });

    const real = Date.now.bind(Date);
    Date.now = () => real() + 60 * 24 * 3_600 * 1_000; // deux mois plus tard
    try {
      const verdict = await g.decide(requete({ estimated: eurosToMicros(0.5) }));
      expect(verdict.ok).toBe(true);
      if (!verdict.ok) return;
      // La dépense reste vue : le mois est celui de la BASE.
      expect(verdict.value.spentMicros).toBe(eurosToMicros(0.9));
      expect(verdict.value.decision).toBe('DENY');
    } finally {
      Date.now = real;
    }
  });
});
