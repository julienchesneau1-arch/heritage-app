/**
 * RED TEAM — un module testé est-il un module BRANCHÉ ?
 *
 * La question que ce fichier pose est celle que l'audit doit poser en premier :
 * *ce composant est-il traversé quand j'utilise Jarvis, ou seulement quand je
 * lance les tests ?* Un module couvert à 100 % mais qu'aucun point d'entrée
 * n'atteint ne protège rien. Il donne une impression de sécurité, ce qui est
 * pire que rien.
 *
 * On construit donc le graphe d'imports réel à partir des deux points d'entrée
 * — le CLI et la passerelle web — et on regarde qui n'y figure pas.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = process.cwd();

/** Résout un import relatif `.js` vers le fichier `.ts` réel. */
function resolveImport(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const target = resolve(dirname(fromFile), specifier);
  return target.replace(/\.js$/, '.ts');
}

/** Ensemble des fichiers réellement atteignables depuis des points d'entrée. */
function reachableFrom(entries: readonly string[]): ReadonlySet<string> {
  const seen = new Set<string>();
  const queue = [...entries];

  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);

    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    // On retire d'abord les imports PUREMENT de type : avec
    // `verbatimModuleSyntax`, `import type …` est effacé à la compilation. Le
    // module cible n'est jamais chargé — il n'exécute donc rien. C'est
    // exactement la distinction qui nous intéresse ici.
    const runtimeOnly = source.replace(
      /^\s*(?:import|export)\s+type\s[^;]*;/gm,
      '',
    );

    // `import … from '…'`, `export … from '…'`, et `import('…')`.
    const pattern = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(runtimeOnly)) !== null) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      const resolved = resolveImport(file, specifier);
      if (resolved !== null) queue.push(resolved);
    }
  }
  return seen;
}

function listTs(root: string): readonly string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) out.push(...listTs(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('RED TEAM — code mort en production', () => {
  const entries = [
    join(ROOT, 'src', 'apps', 'cli', 'main.ts'),
    join(ROOT, 'src', 'apps', 'server', 'main.ts'),
  ];
  const reachable = reachableFrom(entries);
  const allSources = listTs(join(ROOT, 'src'));
  const orphans = allSources
    .filter((f) => !reachable.has(f))
    .map((f) => relative(ROOT, f))
    .sort();

  /**
   * Fichiers qui ne contiennent QUE des types et des contrats. Leur absence du
   * graphe d'exécution est normale et attendue : ils disparaissent à la
   * compilation. Les distinguer évite de noyer les vrais orphelins.
   */
  const pureContracts = [
    'src/core/policy/evaluator.ts', // interface, implémentée par cedar.ts
    'src/providers/contract.ts', // interfaces fournisseurs, aucune implémentation
  ];

  it('DÉMONSTRATION — inventaire des modules qu\'aucun point d\'entrée n\'atteint', () => {
    // Liste figée volontairement : elle doit BOUGER quand on branche ou
    // débranche quelque chose, et faire échouer ce test si le changement
    // n'était pas voulu.
    expect(orphans).toEqual(
      [
        ...pureContracts,

        // ---- Ci-dessous : de la LOGIQUE, pas des types. Le problème. ----

        /* `src/core/quarantine/processor.ts` A QUITTÉ CETTE LISTE — ADR-055.

           Il y figurait avec ce motif : « Implémentée, testée, JAMAIS
           APPELÉE : rien n'ingère aujourd'hui de contenu externe. » Ce n'est
           plus vrai. `web_search` est la première ingestion du dépôt, et le
           Tool Gateway appelle `sealExternal` sur toute sortie déclarée
           `EXTERNAL_UNTRUSTED`.

           C'est le mouvement qu'on attend d'une dette datée : elle sort de la
           liste quand elle est payée, et ce test l'aurait signalé si on avait
           oublié de l'en retirer. */

        // Context Engine — résolution d'entités et détection d'ambiguïté.
        // `QUICKSTART.md` promet « il ne devine pas : deux homonymes → il
        // demande lequel ». Ce chemin n'existe pas dans la boucle réelle.
        'src/core/context/packet.ts',
        'src/core/context/resolver.ts',

        // Journalisation applicative avec redaction (03 §9). Aucun appelant :
        // les exigences de log — identifiant de requête, latence, coût,
        // décision d'égression — ne sont satisfaites par personne.
        'src/core/observability/logger.ts',

        /* CostGate (ADR-040). Écrit, testé, et appelé par PERSONNE — parce
           qu'aucun fournisseur cloud n'existe pour l'appeler.

           C'est délibéré et c'est le bon ordre : `docs/04` pose « 0 €
           récurrent » comme invariant, et il était jusqu'ici tenu par ABSENCE
           DE DÉPENSE plutôt que par mécanisme. Le mécanisme existe désormais
           AVANT le premier appel payant, au lieu d'être écrit dans l'urgence
           après.

           Il sortira de cette liste le jour où un fournisseur cloud sera
           branché — et ce test le signalera si on oublie de l'y brancher. */
        'src/core/cost/gate.ts',

        /* ⚠ `src/core/tools/outcome.ts` A QUITTÉ CETTE LISTE — ADR-065.
           Il y figurait avec ce commentaire : « pas encore branché […] jusqu'à
           ce qu'un outil multi-cibles existe ». Cet outil existe :
           `memory_forget` projette son statut sur la ligne mémoire ET sur
           chaque dérivé hors cascade.

           La dette nommée de Foundation 4 est payée, et c'est ce test qui
           l'aura suivie du premier au dernier jour. */

      ].sort(),
    );
  });

  it('quatre modules de LOGIQUE testés ne sont traversés par aucun usage', () => {
    const deadLogic = orphans.filter((f) => !pureContracts.includes(f));
    /* Le chiffre est asserté, pas seulement la liste : c'est ce qui force à
       PASSER ICI quand un module cesse d'être atteint — ou le devient.

       Il est monté de six à sept avec `privacy/classify.ts` à l'étape F1, où
       la classification était délibérément branchée à rien. Il est redescendu
       à six à F2, quand le Policy Gate a commencé à l'appeler — exactement le
       mouvement annoncé, et ce test l'aurait signalé si on l'avait oublié.

       **À cinq avec ADR-055** : `quarantine/processor.ts` est appelé par le
       Tool Gateway depuis que `web_search` existe. C'est la défense principale
       contre T1 (ADR-004) qui entre en circuit, après y avoir été absente
       depuis le début du dépôt.

       **À quatre avec ADR-065** : `tools/outcome.ts` est traversé par
       `memory_forget`, qui projette son statut sur la ligne mémoire et sur
       chaque dérivé hors cascade. Le modèle d'effet par cible attendait un
       outil multi-cibles depuis Foundation 4 ; le droit à l'oubli en est un,
       parce qu'une mémoire vit à plusieurs endroits. */
    expect(deadLogic).toHaveLength(4);
    // Chacun est pourtant couvert par des tests : la couverture mesure le code
    // exécuté PAR LES TESTS, jamais le code exécuté par le produit.
  });

  it('l\'identité d\'opération, elle, EST sur le chemin réel', () => {
    // Contre-épreuve du test précédent, et la raison pour laquelle il compte.
    // `identity.ts` a été introduit en même temps qu'`outcome.ts` : l'un est
    // câblé jusqu'au type de `ToolCall`, l'autre non. Le test le distingue au
    // lieu de les traiter également.
    expect(orphans).not.toContain('src/core/tools/identity.ts');
  });

  it('le noyau de sécurité, lui, est bien sur le chemin', () => {
    for (const required of [
      'src/core/policy/gate.ts',
      'src/core/tools/gateway.ts',
      'src/core/verification/engine.ts',
      'src/core/ledger/ledger.ts',
      'src/core/memory/guard.ts',
      'src/core/secrets/vault.ts',
      'src/core/undo/snapshots.ts',
      /* AJOUTÉ PAR ADR-066 — et ce que cette ligne prouve est PLUS ÉTROIT que
         ce que le premier commentaire prétendait.

         Mesuré par sabotage : en remplaçant l'appel `createUndoEngine(...)` du
         runtime par `undefined`, ce test est resté VERT. `reachable` suit le
         graphe d'IMPORTS ; un import conservé suffit à rendre un module
         « atteint », même si plus rien ne l'appelle.

         La ligne garde donc sa valeur — elle attrape la disparition complète —
         mais c'est le test suivant qui vérifie que le moteur arrive jusqu'à
         l'utilisateur. */
      'src/core/undo/engine.ts',
      'src/providers/policy/cedar.ts',
    ]) {
      expect(reachable.has(join(ROOT, required)), required).toBe(true);
    }
  });

  it('l’Undo Engine arrive jusqu’à la SURFACE PRODUIT, pas seulement au graphe', () => {
    /* LA LEÇON D'ADR-063, APPLIQUÉE À UN MOTEUR ENTIER. On y avait réparé le
       pipeline de la confirmation et oublié le rendu ; ici le risque est le
       même à plus grande échelle — un Undo Engine complet, éprouvé, et qu'aucune
       commande n'appelle.

       On vérifie donc les deux bouts : le runtime l'EXPOSE, et le CLI l'APPELLE.
       Un test qui ne regarderait que le premier laisserait passer exactement le
       sabotage qui a rendu la ligne ci-dessus verte à tort. */
    const runtime = readFileSync(join(ROOT, 'src/apps/runtime.ts'), 'utf8');
    expect(runtime).toContain('createUndoEngine(');

    const cli = readFileSync(join(ROOT, 'src/apps/cli/main.ts'), 'utf8');
    expect(cli).toContain('runtime.undo.previewLast()');
    expect(cli).toContain('runtime.undo.undoLast(');
    // Et la commande est ANNONCÉE : une capacité que l'aide ne cite pas
    // n'existe que pour qui a lu le code.
    expect(cli).toContain('/annule');
  });

  it('DÉMONSTRATION — la boucle réelle ne résout aucune entité, donc ne lève aucune ambiguïté', async () => {
    // Corollaire du précédent, vérifié côté code plutôt que côté prose : le
    // fichier qui porte la boucle n'a aucun lien, direct ou transitif, avec le
    // resolver.
    const assistant = readFileSync(join(ROOT, 'src', 'core', 'assistant.ts'), 'utf8');
    expect(assistant).not.toContain('context/');
    expect(assistant).not.toContain('resolver');

    const intent = readFileSync(join(ROOT, 'src', 'core', 'intent', 'engine.ts'), 'utf8');
    expect(intent).not.toContain('resolver');
    await Promise.resolve();
  });

  it('DÉMONSTRATION — 5 clés de configuration sur 16 n\'ont aucun effet', () => {
    // `06` impose « aucune configuration critique cachée dans le code ». Le
    // dépôt fait l'inverse du reproche attendu : la configuration existe, est
    // validée par Zod… et n'est lue par personne. Une clé décorative est pire
    // qu'une valeur en dur, parce qu'elle laisse croire à un interrupteur.
    const sources = listTs(join(ROOT, 'src'))
      .filter((f) => !f.endsWith('config/schema.ts') && !f.endsWith('config/load.ts'))
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');

    // Aucun consommateur nulle part dans `src/` hors du schéma lui-même.
    for (const key of [
      'defaultDecision',
      'startInPrivateMode',
      'externalTelemetry',
      'verifyChainOnStartup', // le CLI ne vérifie PAS la chaîne au démarrage
    ]) {
      expect(sources.includes(key), key).toBe(false);
    }

    /* TROIS CLÉS ONT CESSÉ D'ÊTRE DÉCORATIVES — ADR-040.

       `budgetMonthlyEur`, `alertAtPercent` et `hardBlockAtPercent` sont
       désormais LUES et APPLIQUÉES par le CostGate. Elles restent inertes en
       exploitation tant qu'aucun fournisseur cloud n'appelle le gate, mais la
       distinction compte : une clé qu'aucun code ne lit est décorative, une
       clé lue par un module non branché est en attente. */
    for (const key of ['budgetMonthlyEur', 'alertAtPercent', 'hardBlockAtPercent']) {
      expect(sources.includes(key), key).toBe(true);
    }

    /* `policy.directory` reste contourné : le runtime prend le chemin en dur.
       `cloud.enabled`, LUI, A ÉTÉ CÂBLÉ (ADR-069) — il quitte donc cette liste,
       et le compteur passe de six à cinq. */
    const runtime = readFileSync(join(ROOT, 'src', 'apps', 'runtime.ts'), 'utf8');
    expect(runtime).toContain("join(process.cwd(), 'policies')");
    expect(runtime).toContain('config.value.public.cloud.enabled');
  });

  it('`poolMax` et `statementTimeoutMs` sont désormais transmis à la base', () => {
    // Corrigé au passage de CRIT-1 : `createDb` savait les recevoir, mais
    // `runtime.ts` ne les passait pas. Les valeurs de `config/default.json`
    // étaient remplacées en silence par les défauts du code.
    const runtime = readFileSync(join(ROOT, 'src', 'apps', 'runtime.ts'), 'utf8');
    expect(runtime).toContain('poolMax');
    expect(runtime).toContain('statementTimeoutMs');
  });

  it('la CI exécute la suite ENTIÈRE, sans énumérer les répertoires', () => {
    // Corrigé (MED-1). L'énumération avait déjà laissé passer deux répertoires
    // entiers ; ce test empêche d'y revenir. Si quelqu'un remplace `pnpm test`
    // par une liste, il échoue.
    const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(ci).toMatch(/run:\s*pnpm test\s*$/m);
    expect(ci).not.toContain('pnpm test:contracts');
    expect(ci).not.toContain('pnpm test:policy');
  });

  it('`cloudEnabled` est PILOTÉ par la configuration — S13', () => {
    /* ⚠ CE TEST A CHANGÉ DE CAMP — ADR-069.
       Il démontrait le défaut : « le runtime écrit `false` en littéral et
       l'Assistant aussi ; la clé n'a aucun effet — dans le bon sens
       aujourd'hui, mais c'est un piège : elle laisse croire qu'un interrupteur
       existe. »

       L'interrupteur existe désormais. Le défaut restait invisible dans tout
       comportement observable, puisque le résultat était le bon : c'est la
       LECTURE de la configuration qui fait la différence, et c'est elle qu'on
       vérifie. Détail dans `tests/security/interrupteur-cloud.test.ts`. */
    const runtime = readFileSync(join(ROOT, 'src', 'apps', 'runtime.ts'), 'utf8');
    expect(runtime).toContain('config.value.public.cloud.enabled');
    expect(runtime).not.toContain('cloudEnabled: false,');

    const assistant = readFileSync(join(ROOT, 'src', 'core', 'assistant.ts'), 'utf8');
    expect(assistant).not.toContain('cloudEnabled: false');
  });
});
