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

/* ========================================================================== *
 * I16 — une estampille de décision n'est jamais frappée avec `now()`
 *
 * Proposé par `docs/23 §8`, encodé ici. La mesure qui le justifie tient en
 * deux lignes (`docs/23 §3`) :
 *
 *   now() figé au CONTRÔLE   →  bail SUR-estimé   →  reprise BLOQUÉE
 *   now() figé à l'ÉCRITURE  →  bail SOUS-estimé  →  reprise PRÉMATURÉE
 *
 * Seule la seconde direction menace la sûreté. Le contrôle garde donc `now()`
 * délibérément ; ce sont les ÉCRITURES qui doivent porter une horloge murale.
 * ========================================================================== */

/**
 * Les colonnes dont l'estampille participe à une décision.
 *
 * `committed_at` n'y figure pas, et la raison est MESURÉE, pas supposée :
 * aucune lecture de cette colonne n'existe dans `src/`, `ops/` ni `tests/`.
 * C'est une trace d'audit, jamais une entrée de décision. Le jour où elle en
 * devient une, elle doit rejoindre cette liste — et ce commentaire est le seul
 * endroit où cette dette est écrite.
 */
const DECISION_TIMESTAMPS = ['executing_at', 'lease_expires_at', 'observed_at'] as const;

export interface StampSite {
  readonly file: string;
  readonly column: string;
  readonly expression: string;
  readonly wallClock: boolean;
}

/**
 * Repère les ÉCRITURES d'estampilles de décision, jamais les comparaisons.
 *
 * `executing_at > now() - interval …` est un contrôle et doit rester tel quel :
 * l'analyseur exige un `=` immédiat, donc ne le voit pas.
 */
export function classifyStamps(file: string, source: string): readonly StampSite[] {
  const content = stripComments(source);
  const found: StampSite[] = [];

  for (const column of DECISION_TIMESTAMPS) {
    const pattern = new RegExp(`(?<![<>!=])\\b${column}\\s*=\\s*([^,\\n\`]+)`, 'g');
    for (const match of content.matchAll(pattern)) {
      const expression = (match[1] ?? '').trim();
      // `NULL` libère l'estampille : aucune horloge n'est en jeu.
      if (/^NULL\b/i.test(expression)) continue;
      found.push({
        file,
        column,
        expression,
        wallClock: !/\bnow\(\)/.test(expression),
      });
    }
  }
  return found;
}

const I16: StructuralInvariant = {
  id: 'I16',
  claim:
    "aucune estampille de décision n'est frappée avec now() — une estampille " +
    'née vieille ferait expirer un bail trop tôt',
  check() {
    return sourcesUnder('src')
      .flatMap((file) => classifyStamps(file, readFileSync(file, 'utf8')))
      .filter((site) => !site.wallClock)
      .map((site) =>
        violation('I16', 'estampille de décision frappée avec now()', {
          fichier: site.file,
          colonne: site.column,
          expression: site.expression,
        }),
      );
  },
};

/* ========================================================================== *
 * I19 — une échéance PERSISTÉE est frappée par la base, jamais par le processus
 *
 * Le voisin du motif d'ADR-036, et il est resté invisible pour cette raison :
 * l'échéance était bien fixée UNE fois, mais par l'horloge du PROCESSUS, puis
 * comparée à celle de LA BASE.
 *
 * Mesuré avant correction : une dérive applicative d'un an donnait 371 jours
 * de rétention au lieu de 7 sur un état antérieur classé `ORANGE`.
 * ========================================================================== */

export interface DeadlineWrite {
  readonly file: string;
  /** Vrai si la valeur écrite vient d'une expression SQL, pas d'un paramètre. */
  readonly databaseClock: boolean;
  readonly detail: string;
}

/**
 * Un fichier qui écrit une échéance ET manipule `Date.now()` est suspect.
 *
 * Contrôle volontairement GROSSIER et FERMÉ PAR DÉFAUT : suivre un paramètre
 * `$11` jusqu'à sa valeur demanderait une analyse de flot que la moindre
 * refactorisation casserait. La cohabitation des deux dans un même fichier
 * suffit à exiger une relecture, et c'est ce qu'on veut d'une garde.
 *
 * `Date.now()` reste libre partout ailleurs — mesurer une durée, horodater un
 * journal, verrouiller EN MÉMOIRE. Ce qui est interdit, c'est de FRAPPER une
 * échéance que la base comparera.
 */
export function classifyDeadlineWrites(
  file: string,
  source: string,
): readonly DeadlineWrite[] {
  const content = stripComments(source);
  // On ne s'intéresse qu'aux fichiers qui écrivent réellement une échéance.
  if (!/expires_at/.test(content)) return [];
  if (!/INSERT INTO|UPDATE /.test(content)) return [];

  const mintsInProcess = /Date\.now\(\)\s*\+/.test(content);
  return [
    {
      file,
      databaseClock: !mintsInProcess,
      detail: mintsInProcess
        ? 'calcule une échéance avec Date.now() alors que le fichier écrit expires_at'
        : 'aucune échéance frappée par le processus',
    },
  ];
}

const I19: StructuralInvariant = {
  id: 'I19',
  claim:
    'une échéance persistée est frappée par la base, jamais par ' +
    "l'horloge du processus — qui compare doit estampiller",
  check() {
    return sourcesUnder('src')
      .flatMap((file) => classifyDeadlineWrites(file, readFileSync(file, 'utf8')))
      .filter((write) => !write.databaseClock)
      .map((write) =>
        violation('I19', write.detail, { fichier: write.file }),
      );
  },
};

/* ========================================================================== *
 * I18 — l'échéance d'un bail est LUE, jamais recalculée
 *
 * Quatrième occurrence d'un même motif, et c'est ce qui justifie un invariant
 * plutôt qu'un simple correctif :
 *
 *   Foundation 3   `attempts` distinguerait un mort d'un vivant       — faux
 *   Foundation 4   idem, retrouvé par le chaos (CRIT-5)               — faux
 *   F5.1           `attempts` garderait le rembobinage                — faux
 *   F5.2           `timeoutMs` du repreneur donnerait l'échéance      — faux
 *
 * À chaque fois, L'OBSERVATEUR REDÉFINIT LE PASSÉ. L'invariant interdit la
 * forme, pas seulement l'occurrence.
 * ========================================================================== */

export interface LeaseRead {
  readonly file: string;
  readonly expression: string;
  /** Vrai si l'échéance est comparée plutôt que reconstituée. */
  readonly readsDeadline: boolean;
}

/**
 * Repère toute COMPARAISON portant sur `executing_at`.
 *
 * `executing_at` est un fait d'archive : quand l'appel est parti. En faire une
 * borne de décision oblige à lui ajouter une durée — donc à choisir laquelle,
 * donc à laisser l'observateur trancher. `lease_expires_at` existe justement
 * pour que ce choix ait été fait une fois, par celui qui partait.
 */
export function classifyLeaseReads(file: string, source: string): readonly LeaseRead[] {
  const content = stripComments(source);
  const found: LeaseRead[] = [];

  for (const match of content.matchAll(/\bexecuting_at\s*(?:[<>]=?)\s*([^\n`]+)/g)) {
    found.push({
      file,
      expression: `executing_at ${(match[0] ?? '').slice('executing_at'.length).trim()}`,
      readsDeadline: false,
    });
  }
  for (const match of content.matchAll(/\blease_expires_at[^\n`]*?[<>]=?\s*([^\n`]+)/g)) {
    found.push({
      file,
      expression: (match[0] ?? '').replace(/\s+/g, ' ').trim(),
      readsDeadline: true,
    });
  }
  return found;
}

const I18: StructuralInvariant = {
  id: 'I18',
  claim:
    "l'échéance d'un bail est lue dans lease_expires_at, jamais recalculée " +
    "à partir d'executing_at et du timeoutMs de l'observateur",
  check() {
    return sourcesUnder('src')
      .flatMap((file) => classifyLeaseReads(file, readFileSync(file, 'utf8')))
      .filter((read) => !read.readsDeadline)
      .map((read) =>
        violation('I18', "échéance de bail recalculée par l'observateur", {
          fichier: read.file,
          expression: read.expression,
        }),
      );
  },
};

/* ========================================================================== *
 * I17 — aucune écriture autoritaire ne contourne le cloisonnement
 *
 * L'invariant qui donne sa valeur à ADR-035. Cloisonner deux `UPDATE` en
 * laissant les autres ouverts ne corrige rien : ça donne l'illusion que le
 * trou est fermé, ce qui est strictement pire que de le savoir ouvert.
 * ========================================================================== */

/** Ce qui protège une écriture de `tool_operations`, ou rien. */
export type WriteGuard =
  /** Gardée par la génération de bail : seul l'exécutant courant passe. */
  | 'FENCED'
  /**
   * Gardée par un état d'où aucun effet externe n'est possible.
   *
   * Catégorie NÉCESSAIRE, pas une tolérance : les écritures qui rendent la
   * frappe du bail possible ne peuvent pas être gardées par une génération
   * qu'elles n'ont pas encore frappée. Le compare-and-swap sur un littéral
   * `PLANNED` / `COMMITTED_TO_EXECUTION` en tient lieu, et il est suffisant
   * parce qu'un exécutant périmé est, lui, en `EXECUTING` ou au-delà.
   */
  | 'PRE_LEASE'
  /** Ni l'un ni l'autre. C'est exactement le défaut de `docs/23 §6`. */
  | 'UNGUARDED';

export interface WritePath {
  readonly file: string;
  readonly guard: WriteGuard;
  /** Le texte de la clause de garde, pour que le verdict soit relisible. */
  readonly where: string;
}

/**
 * Retire les commentaires, en conservant le contenu des chaînes.
 *
 * Nécessaire, et découvert en exécutant l'analyseur : la documentation
 * d'ADR-035 cite `UPDATE tool_operations` en prose, entre accents graves
 * markdown. Sans ce filtrage, l'invariant se dénonçait lui-même — une garde
 * qui hurle sur un commentaire finit désactivée, et le trou se rouvre par
 * lassitude plutôt que par décision.
 *
 * Erre du bon côté : une chaîne mal suivie fait tomber un `//` en commentaire
 * et amputer la fin de ligne, donc perdre un `WHERE` — donc `UNGUARDED`.
 */
export function stripComments(source: string): string {
  let out = '';
  let mode: 'code' | 'line' | 'block' | 'string' = 'code';
  let delimiter = '';

  for (let i = 0; i < source.length; i += 1) {
    const c = source[i] ?? '';
    const next = source[i + 1] ?? '';

    if (mode === 'line') {
      if (c === '\n') { mode = 'code'; out += c; }
      continue;
    }
    if (mode === 'block') {
      if (c === '*' && next === '/') { mode = 'code'; i += 1; }
      continue;
    }
    if (mode === 'string') {
      out += c;
      if (c === '\\') { out += next; i += 1; }
      else if (c === delimiter) mode = 'code';
      continue;
    }
    if (c === '/' && next === '/') { mode = 'line'; continue; }
    if (c === '/' && next === '*') { mode = 'block'; i += 1; continue; }
    if (c === '"' || c === "'" || c === '`') { mode = 'string'; delimiter = c; }
    out += c;
  }
  return out;
}

/**
 * Classe chaque `UPDATE tool_operations` d'un fichier.
 *
 * Séparée de l'invariant à dessein : un détecteur qu'on ne peut pas attaquer
 * ne prouve rien. `fencing-structure.test.ts` lui soumet des écritures
 * délibérément non gardées et vérifie qu'il les voit — la leçon de la sentinelle
 * réseau de Foundation 3, qui était aveugle pendant que tout était vert.
 *
 * FERMÉE PAR DÉFAUT : toute forme qu'elle ne sait pas lire est `UNGUARDED`.
 * Un analyseur qui « laisse passer en cas de doute » est un analyseur qui ment.
 */
export function classifyOperationWrites(
  file: string,
  source: string,
): readonly WritePath[] {
  const found: WritePath[] = [];
  const content = stripComments(source);
  const needle = 'UPDATE tool_operations';

  for (let at = content.indexOf(needle); at !== -1; at = content.indexOf(needle, at + 1)) {
    // Le littéral s'arrête au premier accent grave. Une interpolation qui
    // couperait avant le `WHERE` produit donc un texte sans garde — et sera
    // classée `UNGUARDED`, ce qui est la bonne direction.
    const end = content.indexOf('`', at);
    const statement = content.slice(at, end === -1 ? content.length : end);
    const parts = statement.split(/\bWHERE\b/i);
    const where = parts[1];

    if (where === undefined) {
      found.push({ file, guard: 'UNGUARDED', where: '(aucune clause WHERE lisible)' });
      continue;
    }

    const guard: WriteGuard = /lease_generation\s*=/.test(where)
      ? 'FENCED'
      : /state\s*=\s*'(PLANNED|COMMITTED_TO_EXECUTION)'/.test(where)
        ? 'PRE_LEASE'
        : 'UNGUARDED';

    found.push({ file, guard, where: where.replace(/\s+/g, ' ').trim() });
  }
  return found;
}

const I17: StructuralInvariant = {
  id: 'I17',
  claim:
    'toute écriture de tool_operations est cloisonnée par la génération, ' +
    "ou cantonnée à un état d'où aucun effet n'est possible",
  check() {
    /* CE QUE CET INVARIANT NE PROUVE PAS — et il faut le dire ici, pas dans
       une note de bas de page. Il lit du TEXTE. Il établit qu'une garde est
       ÉCRITE ; il n'établit pas qu'elle porte la bonne valeur. Une garde
       `lease_generation = 0` en dur passerait ce contrôle.

       Ce sont les tests adversariaux de `fencing-adversarial.test.ts` qui
       établissent la SÉMANTIQUE. Les deux sont nécessaires et aucun ne
       remplace l'autre : le structurel couvre le code non encore écrit, le
       comportemental couvre le code écrit. */
    return sourcesUnder('src')
      .flatMap((file) => classifyOperationWrites(file, readFileSync(file, 'utf8')))
      .filter((path) => path.guard === 'UNGUARDED')
      .map((path) =>
        violation('I17', 'écriture de tool_operations sans cloisonnement', {
          fichier: path.file,
          garde: path.where,
        }),
      );
  },
};

/* ========================================================================== */

const STATEFUL: readonly StatefulInvariant[] = [I1, I2, I3, I4, I7, I8];
const STRUCTURAL: readonly StructuralInvariant[] = [I5, I6, I9, I10, I16, I17, I18, I19];

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
