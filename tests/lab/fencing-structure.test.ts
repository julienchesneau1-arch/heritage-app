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
  classifyOperationWrites,
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
