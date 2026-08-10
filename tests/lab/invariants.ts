/**
 * LES DIX INVARIANTS — Foundation 4.
 *
 * Le mandat est explicite sur ce qui distingue ce module d'une suite de tests :
 *
 *   > Pas : « 20 tests passent. »
 *   > Mais : des INVARIANTS. Et le test doit chercher des contre-exemples,
 *   > pas simplement exécuter un scénario prévu.
 *
 * Un test vérifie qu'un scénario connu se comporte comme prévu. Un invariant
 * affirme quelque chose de VRAI POUR TOUT ÉTAT — et se laisse donc évaluer sur
 * un état qu'on n'avait pas imaginé, produit par le chaos runner.
 *
 * D'où la forme de ce fichier : chaque invariant est une FONCTION de l'état du
 * monde vers un verdict, jamais une assertion. C'est ce qui permet de les
 * rejouer après chaque scénario aléatoire, et de minimiser un contre-exemple.
 *
 * ⚠ INFRASTRUCTURE DE TEST.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../../src/core/db/client.js';

export interface Violation {
  readonly invariant: string;
  readonly detail: string;
  /** De quoi rejouer : clé d'opération, cible, valeurs observées. */
  readonly evidence: Readonly<Record<string, string | number>>;
}

export interface InvariantReport {
  readonly checked: readonly string[];
  readonly violations: readonly Violation[];
}

/** Un invariant qui s'évalue sur l'état persistant. */
interface StatefulInvariant {
  readonly id: string;
  readonly claim: string;
  check(db: Db, world: Db): Promise<readonly Violation[]>;
}

/** Un invariant qui s'évalue sur le TEXTE des sources. */
interface StructuralInvariant {
  readonly id: string;
  readonly claim: string;
  check(): readonly Violation[];
}

function violation(
  invariant: string,
  detail: string,
  evidence: Readonly<Record<string, string | number>> = {},
): Violation {
  return { invariant, detail, evidence };
}

function sourcesUnder(root: string): readonly string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith('.ts')) found.push(full);
    }
  };
  walk(root);
  return found;
}

/* ========================================================================== *
 * I1 — jamais deux effets pour (operation_id, target)
 * ========================================================================== */

const I1: StatefulInvariant = {
  id: 'I1',
  claim: 'jamais deux effets pour un même couple (operation_id, cible)',
  async check(_db, world) {
    // La formulation PAR CIBLE, corrigée en Foundation 3 : une opération à
    // cinq destinataires produit légitimement cinq effets.
    const rows = await world.query<{
      operation_key: string;
      target: string;
      n: string;
    }>(
      `SELECT operation_key, target, count(*)::text AS n
         FROM lab_world_effects
        GROUP BY operation_key, target
       HAVING count(*) > 1`,
    );
    if (!rows.ok) return [violation('I1', `lecture du monde impossible : ${rows.error.message}`)];

    return rows.value.rows.map((r) =>
      violation('I1', `${r.n} effets pour une même cible`, {
        operation: r.operation_key,
        cible: r.target,
        effets: Number(r.n),
      }),
    );
  },
};

/* ========================================================================== *
 * I2 — aucun CONFIRMED sans preuve
 * ========================================================================== */

const I2: StatefulInvariant = {
  id: 'I2',
  claim: 'aucune opération CONFIRMED sans effet réellement observé',
  async check(db, world) {
    const rows = await db.query<{ operation_id: string; tool_id: string }>(
      `SELECT operation_id, tool_id FROM tool_operations
        WHERE status = 'CONFIRMED' AND state = 'SUCCEEDED'`,
    );
    if (!rows.ok) return [violation('I2', rows.error.message)];

    const violations: Violation[] = [];
    for (const row of rows.value.rows) {
      // Seuls les outils du banc écrivent dans le monde. Les cinq outils du
      // noyau écrivent dans PostgreSQL et sont hors de portée de cette
      // vérification — c'est une limite assumée, pas un oubli.
      if (!row.tool_id.startsWith('lab_')) continue;

      const counted = await world.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM lab_world_effects WHERE operation_key = $1',
        [row.operation_id],
      );
      if (!counted.ok) continue;
      if (Number(counted.value.rows[0]?.n ?? '0') === 0) {
        violations.push(
          violation('I2', 'CONFIRMED annoncé, aucun effet dans le monde', {
            operation: row.operation_id,
            outil: row.tool_id,
          }),
        );
      }
    }
    return violations;
  },
};

/* ========================================================================== *
 * I3 — aucun FAILED sans preuve d'ABSENCE
 * ========================================================================== */

const I3: StatefulInvariant = {
  id: 'I3',
  claim: "aucune opération FAILED alors qu'un effet existe dans le monde",
  async check(db, world) {
    const rows = await db.query<{ operation_id: string; tool_id: string }>(
      `SELECT operation_id, tool_id FROM tool_operations WHERE status = 'FAILED'`,
    );
    if (!rows.ok) return [violation('I3', rows.error.message)];

    const violations: Violation[] = [];
    for (const row of rows.value.rows) {
      if (!row.tool_id.startsWith('lab_')) continue;
      const counted = await world.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM lab_world_effects WHERE operation_key = $1',
        [row.operation_id],
      );
      if (!counted.ok) continue;
      const n = Number(counted.value.rows[0]?.n ?? '0');
      if (n > 0) {
        // Le mensonge le plus coûteux : Jarvis dit « ça n'a pas marché » à
        // propos d'un virement qui est passé.
        violations.push(
          violation('I3', `FAILED annoncé alors que ${String(n)} effet(s) existent`, {
            operation: row.operation_id,
            effets: n,
          }),
        );
      }
    }
    return violations;
  },
};

/* ========================================================================== *
 * I4 — UNKNOWN ne devient jamais CONFIRMED par simple reprise
 * ========================================================================== */

const I4: StatefulInvariant = {
  id: 'I4',
  claim: 'aucune opération ne dépasse une tentative sans preuve positive',
  async check(db) {
    // `attempts > 1` n'est légitime QUE si une vérification a positivement
    // établi l'absence d'effet (`NO_EFFECT`). Toute autre montée du compteur
    // est un rejeu, quel que soit le nom qu'on lui donne.
    const rows = await db.query<{
      operation_id: string;
      attempts: number;
      recovery_detail: string | null;
    }>(
      /* Cadré aux outils du banc, comme I2, I3 et I8.
         Les cinq outils du noyau ont leurs propres suites, et leurs opérations
         survivent d'un fichier de test à l'autre : les balayer ici ferait
         dépendre le verdict du chaos de ce qui s'est exécuté avant lui — un
         invariant qui change de résultat selon l'ordre des tests n'est pas un
         invariant. */
      `SELECT operation_id, attempts, recovery_detail FROM tool_operations
        WHERE attempts > 1 AND tool_id LIKE 'lab\\_%'`,
    );
    if (!rows.ok) return [violation('I4', rows.error.message)];

    return rows.value.rows
      .filter((r) => !(r.recovery_detail ?? '').startsWith('Reprise : aucun effet'))
      .map((r) =>
        violation('I4', `${String(r.attempts)} tentatives sans preuve d'absence`, {
          operation: r.operation_id,
          tentatives: r.attempts,
          motif: r.recovery_detail ?? '(aucun)',
        }),
      );
  },
};

/* ========================================================================== *
 * I5 — un repli conserve l'identité d'opération
 * ========================================================================== */

const I5: StructuralInvariant = {
  id: 'I5',
  claim: "l'identité d'opération n'est frappée qu'au point d'entrée d'une intention",
  check() {
    /* STRUCTUREL, et c'est le seul moyen d'en faire une garantie.
       Un test comportemental ne peut pas prouver qu'aucun futur routeur ne
       frappera une clé neuve dans un chemin de repli. Le typage marqué
       (`OperationIdentity`) rend la faute impossible par accident ; ce contrôle
       rend visible le seul endroit qui a le droit de la commettre. */
    const minters: string[] = [];
    for (const file of sourcesUnder('src')) {
      const content = readFileSync(file, 'utf8');
      // On cherche l'APPEL `mint(`, pas l'import ni la définition.
      if (/(?<![A-Za-z.])mint\(/.test(content) && !file.endsWith('identity.ts')) {
        minters.push(file);
      }
    }

    const allowed = new Set([
      // Le point de passage d'une intention utilisateur à une opération.
      'src/core/assistant.ts',
      // Le CLI fixe la clé AVANT le premier essai, pour qu'une confirmation
      // rejoue la même opération au lieu d'en créer une seconde.
      'src/apps/cli/main.ts',
    ]);

    return minters
      .filter((file) => !allowed.has(file))
      .map((file) =>
        violation('I5', "frappe une identité d'opération hors du point d'entrée", {
          fichier: file,
        }),
      );
  },
};

/* ========================================================================== *
 * I6 — une donnée RED ne quitte jamais le périmètre autorisé
 * ========================================================================== */

const I6: StructuralInvariant = {
  id: 'I6',
  claim: 'la règle « RED + sortie réseau → refus » est sans exception ni option',
  check() {
    const policy = readFileSync('policies/00_hard_security.cedar', 'utf8');
    const violations: Violation[] = [];

    if (!/forbid[\s\S]{0,200}privacyClass == "RED"[\s\S]{0,80}egress == true/.test(policy)) {
      violations.push(
        violation('I6', 'la politique dure RED + egress a disparu ou été modifiée'),
      );
    }
    if (!/forbid[\s\S]{0,200}mode == "PRIVATE"[\s\S]{0,80}egress == true/.test(policy)) {
      violations.push(violation('I6', 'la politique dure du mode privé a disparu'));
    }
    // Une politique `permit` qui mentionnerait `RED` rouvrirait le passage.
    if (/permit[\s\S]{0,300}privacyClass == "RED"/.test(policy)) {
      violations.push(violation('I6', 'une politique PERMIT mentionne la classe RED'));
    }
    return violations;
  },
};

/* ========================================================================== *
 * I7 — aucun état perdu après crash
 * ========================================================================== */

const I7: StatefulInvariant = {
  id: 'I7',
  claim: "toute opération ayant produit un effet possède une trace d'intention",
  async check(db, world) {
    // La propriété qui rend l'absence de trace INFORMATIVE (ADR-027) : si un
    // effet existait sans ligne correspondante, une reprise ne trouverait rien
    // et rejouerait.
    const keys = await world.query<{ operation_key: string }>(
      'SELECT DISTINCT operation_key FROM lab_world_effects',
    );
    if (!keys.ok) return [violation('I7', keys.error.message)];

    const violations: Violation[] = [];
    for (const row of keys.value.rows) {
      const traced = await db.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM tool_operations WHERE operation_id = $1',
        [row.operation_key],
      );
      if (!traced.ok) continue;
      if (Number(traced.value.rows[0]?.n ?? '0') === 0) {
        violations.push(
          violation('I7', "effet dans le monde sans trace d'intention", {
            operation: row.operation_key,
          }),
        );
      }
    }
    return violations;
  },
};

/* ========================================================================== *
 * I8 — aucune décision autonome au-delà de la politique
 * ========================================================================== */

const I8: StatefulInvariant = {
  id: 'I8',
  claim: 'toute exécution a été précédée d\'une décision ALLOW du Policy Gate',
  async check(db) {
    // Le journal est la seule preuve recevable : il est append-only et chaîné.
    const rows = await db.query<{ event_type: string; policy_decision: string | null }>(
      `SELECT event_type, policy_decision FROM event_ledger
        WHERE event_type LIKE 'LAB_%' AND event_type NOT LIKE '%_DENIED'
          AND event_type NOT LIKE '%_PREPARED' AND event_type NOT LIKE '%_CRASHED'`,
    );
    if (!rows.ok) return [violation('I8', rows.error.message)];

    return rows.value.rows
      .filter((r) => r.policy_decision !== 'ALLOW')
      .map((r) =>
        violation('I8', 'exécution journalisée sans décision ALLOW', {
          evenement: r.event_type,
          decision: r.policy_decision ?? '(nulle)',
        }),
      );
  },
};

/* ========================================================================== *
 * I9 — aucun modèle ne peut modifier la politique
 * ========================================================================== */

const I9: StructuralInvariant = {
  id: 'I9',
  claim: 'aucun code du noyau n\'écrit dans les politiques',
  check() {
    const violations: Violation[] = [];
    for (const file of sourcesUnder('src')) {
      const content = readFileSync(file, 'utf8');
      // Écriture de fichier visant le répertoire des politiques.
      if (/writeFile[\s\S]{0,120}polic/i.test(content)) {
        violations.push(
          violation('I9', 'écrit potentiellement dans les politiques', {
            fichier: file,
          }),
        );
      }
    }
    // Le chargement doit rester en lecture seule.
    const cedar = readFileSync('src/providers/policy/cedar.ts', 'utf8');
    if (/writeFileSync|appendFile|createWriteStream/.test(cedar)) {
      violations.push(violation('I9', 'le chargeur de politiques sait écrire'));
    }
    return violations;
  },
};

/* ========================================================================== *
 * I10 — aucun modèle ne peut fabriquer une preuve
 * ========================================================================== */

const I10: StructuralInvariant = {
  id: 'I10',
  claim: 'CONFIRMED et FAILED ne sont fabriqués que par le Verification Engine',
  check() {
    const violations: Violation[] = [];
    const engine = readFileSync('src/core/verification/engine.ts', 'utf8');

    // Les deux fabriques exigent une preuve en argument.
    if (!/function confirmed\(evidence: Evidence\)/.test(engine)) {
      violations.push(violation('I10', 'confirmed() n\'exige plus de preuve'));
    }
    if (!/function failed\(absence: Absence\)/.test(engine)) {
      violations.push(violation('I10', 'failed() n\'exige plus de preuve d\'absence'));
    }

    // `MODEL_OUTPUT` reste une provenance non fiable.
    const domain = readFileSync('src/core/types/domain.ts', 'utf8');
    if (!/UNTRUSTED_PROVENANCES[\s\S]{0,200}MODEL_OUTPUT/.test(domain)) {
      violations.push(
        violation('I10', 'MODEL_OUTPUT n\'est plus dans les provenances non fiables'),
      );
    }
    return violations;
  },
};

/* ========================================================================== */

const STATEFUL: readonly StatefulInvariant[] = [I1, I2, I3, I4, I7, I8];
const STRUCTURAL: readonly StructuralInvariant[] = [I5, I6, I9, I10];

/** Évalue les dix invariants sur l'état courant. */
export async function checkInvariants(db: Db, world: Db): Promise<InvariantReport> {
  const violations: Violation[] = [];

  for (const invariant of STRUCTURAL) {
    violations.push(...invariant.check());
  }
  for (const invariant of STATEFUL) {
    violations.push(...(await invariant.check(db, world)));
  }

  return {
    checked: [...STRUCTURAL, ...STATEFUL].map((i) => `${i.id} — ${i.claim}`),
    violations,
  };
}

/** Les invariants qui n'exigent aucun état : utilisables sans base. */
export function checkStructuralInvariants(): InvariantReport {
  const violations = STRUCTURAL.flatMap((i) => i.check());
  return {
    checked: STRUCTURAL.map((i) => `${i.id} — ${i.claim}`),
    violations,
  };
}

/** Rendu lisible d'un rapport, pour les traces de chaos. */
export function renderViolations(violations: readonly Violation[]): string {
  if (violations.length === 0) return 'aucune violation';
  return violations
    .map((v) => {
      const evidence = Object.entries(v.evidence)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(' ');
      return `  ✗ ${v.invariant} : ${v.detail}${evidence === '' ? '' : ` [${evidence}]`}`;
    })
    .join('\n');
}
