/**
 * Porte de sortie Phase 3 — vérification exécutable.
 *
 * ⚠ CETTE PORTE N'EXISTAIT PAS, ET LA PHASE ÉTAIT DÉCLARÉE FRANCHIE. ADR-087.
 *
 * `docs/28` affirmait **« Phase 3 COMPLÈTE (10/10) »**. Le chiffre compte des
 * outils ÉCRITS. La porte de sortie de `docs/02`, elle, pose trois conditions —
 * et aucune n'était vérifiée par un mécanisme :
 *
 * ```text
 * [ ] Les 15 outils passent leurs tests de contrat.
 * [ ] `audit_query` répond correctement à « Qu'as-tu fait aujourd'hui ? »
 *     DEPUIS LE JOURNAL, pas depuis le modèle.
 * [ ] Chaque outil déclare sa réversibilité, son niveau de risque et sa
 *     méthode de vérification.
 * ```
 *
 * Les phases 0, 1 et 2 ont chacune leur `pnpm gate:phaseN`. La Phase 3 se
 * déclarait franchie en comptant ses livrables — c'est-à-dire en vérifiant
 * qu'on avait fait le travail, jamais qu'il tenait.
 *
 * > Compter des outils écrits n'est pas franchir une porte. C'est mesurer
 * > l'effort au lieu du résultat.
 *
 * DEUX CASES, UN SEUL MÉCANISME — ET ON LE DIT
 * ---------------------------------------------------------------------------
 * La première et la troisième case se vérifient **au même endroit** :
 * `validateDefinition` refuse déjà un outil qui se déclare réversible sans
 * décrire son rollback, ou qui mute en annonçant `verification: NONE`.
 *
 * Les scinder en deux contrôles distincts donnerait l'apparence d'une
 * couverture plus large sans rien vérifier de plus. On préfère un contrôle
 * honnête à deux contrôles décoratifs.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { mint, type OperationIdentity } from '../../src/core/tools/identity.js';
import { createDb } from '../../src/core/db/client.js';
import { createLedger } from '../../src/core/ledger/ledger.js';
import { digestPayload } from '../../src/core/ledger/event.js';
import { validateDefinition } from '../../src/core/tools/contract.js';
import { createPolicyGate } from '../../src/core/policy/gate.js';
import { createMemoryGuard } from '../../src/core/memory/guard.js';
import { createMemoryInbox } from '../../src/core/memory/inbox.js';
import { createMemoryStore } from '../../src/core/memory/store.js';
import { createHybridSearch } from '../../src/core/memory/search.js';
import { createEnvSecretVault } from '../../src/core/secrets/vault.js';
import { createToolGateway } from '../../src/core/tools/gateway.js';
import { createVerificationEngine } from '../../src/core/verification/engine.js';
import {
  createCedarEvaluator,
  loadPolicySource,
} from '../../src/providers/policy/cedar.js';
import { registerCoreTools } from '../../src/tools/index.js';
import type { Db } from '../../src/core/db/client.js';

interface Check {
  readonly id: string;
  readonly label: string;
  run(): Promise<boolean> | boolean;
}

/**
 * LES QUINZE OUTILS NOMMÉS PAR `docs/02`, ET SEULEMENT EUX.
 *
 * Cinq de Phase 2, dix de Phase 3. Cette liste est **recopiée du document**,
 * pas dérivée du code : c'est tout son intérêt. Une liste dérivée du catalogue
 * dirait « les outils enregistrés sont enregistrés », ce qui est vrai de tout
 * catalogue et ne franchit aucune porte.
 *
 * Le dépôt en compte davantage aujourd'hui (`entity_create`, `note_delete`,
 * `reminder_cancel`, `egress_review`…). Ils sont soumis au contrôle de contrat
 * comme les autres, mais leur absence ne bloquerait pas la Phase 3 : la porte
 * vérifie ce que le plan a promis, pas ce qui a été ajouté depuis.
 */
const OUTILS_PROMIS: readonly string[] = [
  // Phase 2 — « Les 5 premiers outils »
  'memory_add',
  'memory_search',
  'task_create',
  'task_list',
  'note_create',
  // Phase 3 — « Les 10 outils restants »
  'task_complete',
  'calendar_read',
  'calendar_create',
  'calendar_update',
  'file_search',
  'web_search',
  'briefing_generate',
  'reminder_create',
  'system_status',
  'audit_query',
];

function runCommand(command: string, args: readonly string[]): boolean {
  try {
    execFileSync(command, [...args], { stdio: 'pipe', env: process.env });
    return true;
  } catch {
    return false;
  }
}

const dbConfigured =
  process.env['JARVIS_DB_PASSWORD'] !== undefined &&
  process.env['JARVIS_DB_PASSWORD'] !== '';

function db(): Db {
  return createDb({
    host: process.env['JARVIS_DB_HOST'] ?? '127.0.0.1',
    port: Number(process.env['JARVIS_DB_PORT'] ?? '5432'),
    database: process.env['JARVIS_DB_NAME'] ?? 'jarvis_test',
    user: process.env['JARVIS_DB_USER'] ?? 'jarvis_app',
    password: process.env['JARVIS_DB_PASSWORD'] ?? '',
  });
}

function stack(connection: Db) {
  const source = loadPolicySource(join(process.cwd(), 'policies'));
  if (!source.ok) throw new Error(source.error.message);

  const store = createMemoryStore(connection);
  const ledger = createLedger(connection);
  const gateway = createToolGateway({
    db: connection,
    gate: createPolicyGate(createCedarEvaluator(source.value)),
    vault: createEnvSecretVault({}),
    ledger,
    verifier: createVerificationEngine(),
  });

  const registered = registerCoreTools(gateway, {
    guard: createMemoryGuard(store, createMemoryInbox(connection)),
    store,
    search: createHybridSearch(connection, null),
    ledger,
    isUserConfirmed: () => true,
    /* ⚠ AUCUN FOURNISSEUR EXTERNE N'EST FOURNI, ET C'EST DÉLIBÉRÉ.

       `calendar`, `websearch`, `fileRoots` restent absents. Les outils
       s'enregistrent quand même et rendent `PROVIDER_UNAVAILABLE` — ADR-078.
       La porte éprouve donc que les quinze outils EXISTENT et que leur contrat
       tient, pas qu'un fournisseur tiers répond.

       C'est une limite, et elle est nommée : cette porte ne dit rien de ce que
       fait `calendar_create` face au vrai Google. Deux appels réels le diront
       (`docs/26 §4.7`), et aucune porte verte ne remplace ça. */
    modeleLocal: { kind: 'DESACTIVE' },
  });
  if (!registered.ok) throw new Error(registered.error.message);

  return { gateway, ledger };
}

let seq = 0;
function operationId(prefix: string): OperationIdentity {
  seq += 1;
  return mint(`gate3-${prefix}-${String(seq)}`);
}

const checks: readonly Check[] = [
  {
    id: 'G3.1',
    label: 'Les quinze outils promis par le plan sont enregistrés',
    run() {
      if (!dbConfigured) return false;
      const connection = db();
      try {
        const { gateway } = stack(connection);
        const presents = new Set(gateway.list().map((t) => t.definition.id));
        const manquants = OUTILS_PROMIS.filter((id) => !presents.has(id));
        if (manquants.length > 0) {
          console.log(`\n         manquants : ${manquants.join(', ')}`);
          return false;
        }
        return true;
      } finally {
        void connection.close();
      }
    },
  },
  {
    id: 'G3.2',
    label: 'Chaque outil déclare réversibilité, risque et vérification — de façon COHÉRENTE',
    run() {
      if (!dbConfigured) return false;
      const connection = db();
      try {
        const { gateway } = stack(connection);
        /* `validateDefinition` porte les règles du contrat, dont celles qui
           font échouer une déclaration INCOHÉRENTE :
             — se dire réversible sans décrire de rollback ;
             — muter en annonçant `verification: NONE` ;
             — se dire `UNVERIFIABLE` tout en réclamant L1 ou L2.

           Vérifier la seule PRÉSENCE des champs serait tautologique : le type
           TypeScript les impose déjà. C'est la cohérence qui se vérifie. */
        const fautifs: string[] = [];
        for (const outil of gateway.list()) {
          /* `validateDefinition` rend la LISTE des problèmes, pas un `Result` :
             une définition saine rend un tableau vide. La lire comme un
             booléen inversé (`!problemes`) serait toujours vrai — un tableau
             vide est truthy. */
          const problemes = validateDefinition(outil.definition);
          for (const probleme of problemes) {
            fautifs.push(`${outil.definition.id} — ${probleme}`);
          }
        }
        if (fautifs.length > 0) {
          console.log(`\n         ${fautifs.join('\n         ')}`);
          return false;
        }
        return true;
      } finally {
        void connection.close();
      }
    },
  },
  {
    id: 'G3.3',
    label: '« Qu\'as-tu fait aujourd\'hui ? » rend le JOURNAL, et rien d\'autre',
    async run() {
      if (!dbConfigured) return false;
      const connection = db();
      try {
        const { gateway, ledger } = stack(connection);

        /* ⚠ MESURÉ AVANT **ET** APRÈS L'ÉCRITURE — et ce n'est pas du zèle.

           La case du plan dit « depuis le journal, **pas depuis le modèle** ».
           Un contrôle positif seul ne la vérifie pas : un outil qui rendrait
           toujours quelque chose de plausible le passerait tout aussi bien.

           PREMIÈRE RÉDACTION, ÉCARTÉE. Je demandais une opération jamais
           journalisée et vérifiais son absence. C'était un contrôle qui **ne
           pouvait pas échouer** : `audit_query` ne reçoit jamais cet
           identifiant, il ne risquait donc pas de le rendre. Un contrôle
           infalsifiable est un contrôle décoratif — exactement le défaut que
           cette porte existe pour corriger.

           Le MÊME marqueur est donc observé deux fois, autour de son écriture.
           Un audit qui invente le montrerait avant ; un audit en panne ne le
           montrerait ni avant ni après. Les deux échouent, et pour des raisons
           distinctes. */
        const marque = operationId('audit');

        const demander = async (
          etiquette: string,
        ): Promise<string | null> => {
          const lu = await gateway.invoke({
            toolId: 'audit_query',
            input: { window: 'today', limit: 200 },
            parameterProvenance: {},
            operationId: operationId(etiquette),
            actor: 'USER',
            context: {
              mode: 'NORMAL',
              cloudEnabled: false,
              proactive: false,
              userConfirmed: true,
            },
          });
          return lu.ok ? JSON.stringify(lu.value.output) : null;
        };

        const avant = await demander('avant');
        if (avant === null || avant.includes(marque)) return false;

        const ecrit = await ledger.append({
          actor: 'USER',
          eventType: 'TASK_CREATED',
          status: 'CONFIRMED',
          operationId: marque,
          payloadDigest: digestPayload({ porte: 'phase3' }),
        });
        if (!ecrit.ok) return false;

        /* ⚠ ET LE COMPTE DOIT CORRESPONDRE AU JOURNAL — MAIS PAS À L'ÉGALITÉ.

           Le marqueur seul ne suffit pas : un audit qui rendrait la bonne
           entrée PLUS des entrées inventées le contiendrait quand même.
           « Répond depuis le journal » deviendrait « répond depuis le journal,
           entre autres ».

           PREMIÈRE RÉDACTION : égalité stricte avec un `count(*)` pris après
           coup. Mesuré — journal 80, audit 79 — et l'écart n'était PAS un
           défaut d'`audit_query` :

             **l'appel d'audit est lui-même journalisé pendant qu'il lit.**

           C'est mot pour mot le défaut déjà rencontré dans `system_status`,
           où la première rédaction se comptait elle-même. Le même piège, à
           deux endroits différents, à deux mois d'intervalle.

           On encadre donc : l'audit voit AU MOINS ce qui existait avant lui, et
           AU PLUS ce qui existe après. Un audit qui omet tombe sous la borne
           basse ; un audit qui invente passe au-dessus de la haute. Les deux
           directions restent falsifiables — c'est tout ce qu'on demandait à
           l'égalité, sans lui demander l'impossible. */
        const compter = async (): Promise<number | null> => {
          const r = await connection.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM event_ledger
              WHERE occurred_at >= date_trunc('day', clock_timestamp())`,
          );
          return r.ok ? Number(r.value.rows[0]?.n ?? '0') : null;
        };

        const avantLecture = await compter();
        const apres = await demander('apres');
        const apresLecture = await compter();
        if (apres === null || avantLecture === null || apresLecture === null) return false;
        if (!apres.includes(marque)) return false;

        const rendu: unknown = JSON.parse(apres);
        const compte =
          typeof rendu === 'object' && rendu !== null && 'count' in rendu
            ? (rendu as { count: unknown }).count
            : null;
        if (typeof compte !== 'number') return false;

        const bas = Math.min(avantLecture, 200);
        const haut = Math.min(apresLecture, 200);
        if (compte < bas || compte > haut) {
          console.log(
            `\n         journal ∈ [${String(bas)}, ${String(haut)}] · audit : ${String(compte)}`,
          );
          return false;
        }
        return true;
      } finally {
        void connection.close();
      }
    },
  },
  {
    id: 'G3.4',
    label: 'Tests d\'outils et de contrats passent',
    run() {
      return runCommand('pnpm', [
        'vitest',
        'run',
        'tests/tools',
        'tests/contracts',
        'tests/providers',
      ]);
    },
  },
  {
    id: 'G3.5',
    label: 'Les Phases 0, 1 et 2 restent franchies (aucune régression)',
    run() {
      return (
        runCommand('pnpm', ['gate:phase0']) &&
        runCommand('pnpm', ['gate:phase1']) &&
        runCommand('pnpm', ['gate:phase2'])
      );
    },
  },
];

async function main(): Promise<void> {
  console.log('\n  PORTE DE SORTIE — PHASE 3\n');

  if (!dbConfigured) {
    console.log('  ⚠ JARVIS_DB_PASSWORD absent : les contrôles base échoueront.\n');
  }

  let failures = 0;
  for (const check of checks) {
    process.stdout.write(`  ${check.id.padEnd(6)} ${check.label} … `);
    let passed = false;
    try {
      passed = await check.run();
    } catch {
      passed = false;
    }
    console.log(passed ? 'OK' : 'ÉCHEC');
    if (!passed) failures += 1;
  }

  console.log('');
  if (failures === 0) {
    console.log('  ✓ Phase 3 franchie. Les quinze outils tiennent leur contrat.\n');
    console.log('  ⚠ Ce que cette porte NE dit PAS : aucun fournisseur externe');
    console.log('    n\'a été interrogé. `calendar_*` et `web_search` sont éprouvés');
    console.log('    sans Google et sans réseau (`docs/26 §4.7`).\n');
    process.exit(0);
  }
  console.log(`  ✗ ${String(failures)} contrôle(s) en échec. La Phase 3 n'est pas franchie.\n`);
  process.exit(1);
}

main().catch((error: unknown) => {
  console.error('Vérification interrompue :', error);
  process.exit(1);
});
