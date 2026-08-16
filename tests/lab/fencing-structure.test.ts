/**
 * I17 — AUCUNE ÉCRITURE AUTORITAIRE NE CONTOURNE LE CLOISONNEMENT.
 *
 * Foundation 5.1. Cet invariant est le seul qui couvre le code PAS ENCORE
 * ÉCRIT : les épreuves adversariales prouvent que les chemins d'aujourd'hui
 * sont fermés, celle-ci prouve qu'un chemin de demain sera vu.
 *
 * POURQUOI LE CONTRÔLE NÉGATIF EST OBLIGATOIRE
 * --------------------------------------------
 * Foundation 3 a produit la leçon en vraie grandeur : la sentinelle réseau
 * enregistrait toutes les sorties sous `localhost:0` à cause d'une forme
 * d'arguments qu'elle ne savait pas lire. Elle était AVEUGLE, et toute la
 * suite était verte. Seul un contrôle négatif l'a démasquée.
 *
 * Un détecteur qui ne rend jamais « violation » et un système correct
 * produisent exactement la même sortie. La différence ne s'établit qu'en
 * attaquant le détecteur.
 *
 * ⚠ INFRASTRUCTURE DE TEST.
 */
import { describe, expect, it } from 'vitest';
import {
  checkStructuralInvariants,
  classifyDeadlineWrites,
  classifyLeaseReads,
  classifyOperationWrites,
  classifyStamps,
  renderViolations,
} from './invariants.js';

describe('I17 — cloisonnement des écritures autoritaires', () => {
  /* ================================================================== *
   * L'invariant lui-même
   * ================================================================== */

  it('le dépôt courant ne contient aucune écriture non cloisonnée', () => {
    const report = checkStructuralInvariants();
    const i17 = report.violations.filter((v) => v.invariant === 'I17');
    if (i17.length > 0) {
      throw new Error(`écritures non cloisonnées :\n${renderViolations(i17)}`);
    }
    expect(i17).toEqual([]);
  });

  it('I17 figure bien dans les invariants structurels évalués', () => {
    // Un invariant qu'on oublie de brancher est pire qu'un invariant absent :
    // il fait croire à une couverture qui n'existe pas.
    expect(
      checkStructuralInvariants().checked.some((c) => c.startsWith('I17 —')),
    ).toBe(true);
  });

  /* ================================================================== *
   * CONTRÔLES NÉGATIFS — le détecteur voit-il vraiment ?
   * ================================================================== */

  const attaques: readonly { readonly nom: string; readonly source: string }[] = [
    {
      nom: 'la faute exacte de docs/23 §6 — écriture terminale inconditionnelle',
      source:
        'const q = `UPDATE tool_operations SET state = $2, status = $3 ' +
        'WHERE operation_id = $1`;',
    },
    {
      nom: 'une seule colonne, la plus anodine',
      source:
        'const q = `UPDATE tool_operations SET recovery_detail = $2 ' +
        'WHERE operation_id = $1`;',
    },
    {
      nom: "une garde d'état qui NE PROTÈGE PAS — EXECUTING autorise un effet",
      source:
        'const q = `UPDATE tool_operations SET status = $2 ' +
        "WHERE operation_id = $1 AND state = 'EXECUTING'`;",
    },
    {
      nom: 'une garde par `attempts` — précisément ce qui a échoué',
      source:
        'const q = `UPDATE tool_operations SET state = $2 ' +
        'WHERE operation_id = $1 AND attempts = $3`;',
    },
    {
      nom: 'aucune clause WHERE du tout',
      source: 'const q = `UPDATE tool_operations SET status = null`;',
    },
    {
      nom: 'une clause WHERE injectée depuis une variable',
      source: 'const q = `UPDATE tool_operations SET status = $2 ${garde}`;',
    },
  ];

  for (const attaque of attaques) {
    it(`DÉTECTE : ${attaque.nom}`, () => {
      const paths = classifyOperationWrites('attaque.ts', attaque.source);
      expect(paths).toHaveLength(1);
      expect(paths[0]?.guard).toBe('UNGUARDED');
    });
  }

  /* ================================================================== *
   * CONTRÔLES POSITIFS — et ne crie-t-il pas au loup ?
   *
   * Un détecteur qui hurle sur du code correct finit désactivé. Le trou se
   * rouvre alors par lassitude plutôt que par décision, ce qui est le pire
   * des deux mondes.
   * ================================================================== */

  it('accepte une écriture cloisonnée par la génération', () => {
    const paths = classifyOperationWrites(
      'ok.ts',
      'const q = `UPDATE tool_operations SET state = $2 ' +
        'WHERE operation_id = $1 AND lease_generation = $3`;',
    );
    expect(paths[0]?.guard).toBe('FENCED');
  });

  it("accepte une écriture pré-bail cantonnée à un état sans effet", () => {
    const paths = classifyOperationWrites(
      'ok.ts',
      'const q = `UPDATE tool_operations SET state = \'COMMITTED_TO_EXECUTION\' ' +
        "WHERE operation_id = $1 AND state = 'PLANNED'`;",
    );
    // La garde est lue dans le `WHERE`, jamais dans le `SET` : la même valeur
    // littérale y a deux sens opposés.
    expect(paths[0]?.guard).toBe('PRE_LEASE');
  });

  /* ================================================================== *
   * I16 — l'estampille, l'autre moitié de la sémantique du bail
   * ================================================================== */

  describe('I16 — aucune estampille de décision frappée avec now()', () => {
    it('le dépôt courant ne frappe aucune estampille avec now()', () => {
      const i16 = checkStructuralInvariants().violations.filter(
        (v) => v.invariant === 'I16',
      );
      if (i16.length > 0) {
        throw new Error(`estampilles dangereuses :\n${renderViolations(i16)}`);
      }
      expect(i16).toEqual([]);
    });

    const dangereuses: readonly { readonly nom: string; readonly sql: string }[] = [
      {
        nom: "le contre-exemple exact de docs/23 §3.2 — executing_at = now()",
        sql: 'executing_at = now()',
      },
      {
        nom: "une échéance de bail née vieille",
        sql: "lease_expires_at = now() + interval '5 seconds'",
      },
      {
        nom: "l'estampille d'observation",
        sql: 'observed_at = now()',
      },
    ];

    for (const cas of dangereuses) {
      it(`DÉTECTE : ${cas.nom}`, () => {
        const sites = classifyStamps('attaque.ts', `const q = \`UPDATE t SET ${cas.sql}\`;`);
        expect(sites).toHaveLength(1);
        expect(sites[0]?.wallClock).toBe(false);
      });
    }

    it('accepte une horloge murale', () => {
      const sites = classifyStamps(
        'ok.ts',
        'const q = `UPDATE t SET executing_at = clock_timestamp()`;',
      );
      expect(sites[0]?.wallClock).toBe(true);
    });

    it("IGNORE un CONTRÔLE — `now()` y est délibéré et protecteur", () => {
      /* La distinction est tout l'objet de `docs/23 §3`. Un `now()` figé au
         contrôle ne peut que SUR-estimer un bail, donc bloquer une reprise :
         c'est un risque de disponibilité, jamais de sûreté. Un analyseur qui
         confondrait les deux ferait « corriger » la seule occurrence qui
         protège. */
      const sites = classifyStamps(
        'controle.ts',
        "const q = `SELECT executing_at > now() - interval '1 second' AS live`;",
      );
      expect(sites).toEqual([]);
    });

    it('IGNORE une libération d\'estampille', () => {
      const sites = classifyStamps(
        'ok.ts',
        'const q = `UPDATE t SET lease_expires_at = NULL`;',
      );
      expect(sites).toEqual([]);
    });
  });

  /* ================================================================== *
   * I18 — l'échéance est LUE, jamais recalculée
   * ================================================================== */

  describe("I18 — l'échéance de bail n'est pas recalculée", () => {
    it("le dépôt courant ne recalcule aucune échéance", () => {
      const i18 = checkStructuralInvariants().violations.filter(
        (v) => v.invariant === 'I18',
      );
      if (i18.length > 0) {
        throw new Error(`échéances recalculées :\n${renderViolations(i18)}`);
      }
      expect(i18).toEqual([]);
    });

    it("DÉTECTE : le contre-exemple exact — executing_at + timeoutMs de l'observateur", () => {
      const reads = classifyLeaseReads(
        'attaque.ts',
        'const q = `SELECT executing_at > now() - ($2 || \' milliseconds\')::interval AS live`;',
      );
      expect(reads).toHaveLength(1);
      expect(reads[0]?.readsDeadline).toBe(false);
    });

    it('DÉTECTE : toute comparaison sur executing_at, même sans intervalle', () => {
      const reads = classifyLeaseReads(
        'attaque.ts',
        'const q = `SELECT executing_at < now() AS vieux`;',
      );
      expect(reads[0]?.readsDeadline).toBe(false);
    });

    it("accepte la LECTURE de l'échéance stockée", () => {
      const reads = classifyLeaseReads(
        'ok.ts',
        "const q = `SELECT COALESCE(lease_expires_at, 'infinity'::timestamptz) > now() AS live`;",
      );
      expect(reads).toHaveLength(1);
      expect(reads[0]?.readsDeadline).toBe(true);
    });

    it("IGNORE l'ÉCRITURE d'executing_at — c'est I16 qui la garde", () => {
      /* Les deux invariants se partagent la colonne sans se marcher dessus :
         I16 garde le `=` (avec quelle horloge on l'écrit), I18 garde le `<`
         et le `>` (si on s'en sert pour décider). Confondre les deux ferait
         signaler l'acquisition, qui est parfaitement légitime. */
      const reads = classifyLeaseReads(
        'ok.ts',
        'const q = `UPDATE t SET executing_at = clock_timestamp()`;',
      );
      expect(reads).toEqual([]);
    });
  });

  /* ================================================================== *
   * I19 — une échéance persistée est frappée par la base
   * ================================================================== */

  describe("I19 — aucune échéance persistée frappée par le processus", () => {
    it('le dépôt courant ne frappe aucune échéance avec Date.now()', () => {
      const i19 = checkStructuralInvariants().violations.filter(
        (v) => v.invariant === 'I19',
      );
      if (i19.length > 0) {
        throw new Error(`échéances frappées par le processus :\n${renderViolations(i19)}`);
      }
      expect(i19).toEqual([]);
    });

    it('DÉTECTE : le défaut exact mesuré — 371 jours au lieu de 7', () => {
      const writes = classifyDeadlineWrites(
        'attaque.ts',
        'const expiresAt = new Date(Date.now() + TTL * 86400000).toISOString();\n' +
          'await db.query(`INSERT INTO t (expires_at) VALUES ($1)`, [expiresAt]);',
      );
      expect(writes).toHaveLength(1);
      expect(writes[0]?.databaseClock).toBe(false);
    });

    it("accepte une échéance frappée par l'horloge de la base", () => {
      const writes = classifyDeadlineWrites(
        'ok.ts',
        "await db.query(`INSERT INTO t (expires_at) " +
          "VALUES (clock_timestamp() + ($1 || ' days')::interval)`, [jours]);",
      );
      expect(writes[0]?.databaseClock).toBe(true);
    });

    it("IGNORE Date.now() dans un fichier qui n'écrit aucune échéance", () => {
      /* `Date.now()` reste libre là où il mesure une durée ou verrouille en
         mémoire. Une garde qui l'interdirait partout serait désactivée dans
         la semaine — et le vrai défaut repasserait avec elle. */
      const writes = classifyDeadlineWrites(
        'chrono.ts',
        'const debut = Date.now();\nconst ecoule = Date.now() - debut;',
      );
      expect(writes).toEqual([]);
    });
  });

  it('IGNORE une mention en commentaire — sinon il se dénoncerait lui-même', () => {
    /* Découvert en exécutant l'analyseur, pas en le relisant : la
       documentation d'ADR-035 cite `UPDATE tool_operations` en prose, entre
       accents graves markdown. Sans filtrage des commentaires, I17 signalait
       sa propre documentation. */
    const paths = classifyOperationWrites(
      'doc.ts',
      '/** Tout `UPDATE tool_operations` passe par la primitive. */\n' +
        '// et aussi : UPDATE tool_operations SET state = $2\n' +
        'const rien = 1;',
    );
    expect(paths).toEqual([]);
  });
});
