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

        /* Context Engine — `packet.ts` SEUL reste hors circuit.

           ⚠ `resolver.ts` A QUITTÉ CETTE LISTE — ADR-073. Le commentaire disait :
           « `QUICKSTART.md` promet *il ne devine pas : deux homonymes → il
           demande lequel*. Ce chemin n'existe pas dans la boucle réelle. »

           Il existe : l'Assistant résout les référents avant d'invoquer un
           outil, et rend une QUESTION dès que la lecture est ambiguë,
           introuvable, ou sans contexte. La promesse du QUICKSTART est tenue.

           `packet.ts` — l'assemblage du paquet de contexte — n'a toujours aucun
           appelant. La distinction est le sujet : résoudre une référence et
           composer un contexte sont deux choses, et une seule est faite. */
        'src/core/context/packet.ts',

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

        /* ⚠ QUATRE MODULES ENTRENT ICI D'UN COUP — ADR-088, Update Engine.

           Et c'est la plus grosse hausse que ce compteur ait connue. Elle est
           délibérée, pour la raison exacte qui a mis le CostGate dans cette
           liste : **l'enveloppe de sûreté s'écrit à froid.**

           Clouer « une signature non vérifiée est refusée, sans exception » est
           facile aujourd'hui. Ça le sera beaucoup moins le jour où un correctif
           de sécurité urgent attendra derrière ce refus — et c'est précisément
           ce jour-là qu'on aurait écrit la règle si on avait attendu.

           Ils sortiront de cette liste quand un vérificateur TUF/Sigstore puis
           un exécutant existeront (`docs/26 §4.16`). Dans cet ordre : un
           exécutant sans vérificateur installerait n'importe quoi.

           ⚠ ET LE COMPTEUR MONTE, CE QUI EST LE POINT. Le faire baisser en
           branchant un exécutant qui n'a rien à vérifier serait le tricher. */
        'src/core/update/candidat.ts',
        'src/core/update/promotion.ts',
        'src/core/update/surveillance.ts',
        'src/core/update/lab.ts',

        /* ⚠ DEUX MODULES DE PLUS — ADR-093, les deux arbitrages de la voix.

           Même geste que `privacy/classify.ts` à l'étape F1 : des fonctions
           PURES, sans appelant, qui n'accordent ni ne retirent aucune
           permission. Il n'y a pas une ligne de code audio dans ce dépôt, donc
           rien ne peut les appeler.

           Mais l'ordre compte, et il est inhabituel ici : `docs/26 §4.17`
           demandait une DÉCISION puis un MÉCANISME. Ces deux fichiers SONT la
           décision — écrite en fonction éprouvée plutôt qu'en paragraphe,
           parce qu'un paragraphe se relit et qu'une fonction se casse quand on
           la contredit.

           Ils sortiront de cette liste quand un canal vocal existera :
           `micro.ts` quand le module audio lira son état, `plafond.ts` quand
           `assistant.say()` consultera un déclencheur. Et ce jour-là,
           `Declencheur` devra être DÉRIVÉ de `context.proactive`, jamais
           transporté à côté (ADR-041).

           ⚠ ET LE COMPTEUR MONTE ENCORE. Le faire baisser en branchant un
           micro sur un plafond qu'on n'a pas décidé serait exactement
           l'inversion que `docs/26 §4.17` refusait. */
        'src/core/voice/micro.ts',
        'src/core/voice/plafond.ts',

        /* ⚠ LE MODEL ROUTER — ADR-102. Et son motif d'entrée ici n'est AUCUN
           des précédents.

           Le CostGate ne pouvait pas être branché : aucun payeur n'existe.
           L'Update Engine ne doit pas l'être : aucun vérificateur de signature
           n'existe. Le routeur, lui, POURRAIT l'être — `createOllama` fournit
           un candidat local dès aujourd'hui.

           On ne le branche pas, et la raison est plus étroite :

               **Arbitrer entre un seul candidat n'est pas arbitrer.**

           La décision pour laquelle ce module existe — la confidentialité
           passe avant la disponibilité — ne se prend que le jour où un
           candidat NON LOCAL existe. Le brancher sur une liste d'un élément
           ferait descendre ce compteur sans qu'aucun arbitrage n'ait jamais
           été rendu par lui : le compteur mesurerait alors l'apparence du
           branchement, pas l'usage.

           ⚠ SA CONDITION DE SORTIE EST MÉCANIQUE, et c'est ce qui la rend
           vérifiable : le jour où `src/providers/` contient un `ModelProvider`
           dont `local` est faux. Ce jour-là, ce test signalera qu'on a ajouté
           un fournisseur distant sans le faire passer par le routeur — ce qui
           est exactement la faute qu'il doit attraper. */
        'src/core/routing/router.ts',

        /* ⚠ LA PASSERELLE AUDIO ET SON REGISTRE — ADR-103.

           Et la question s'est posée honnêtement : il AURAIT été facile de les
           brancher. `runtime.ts` sait construire un `EtatModeleLocal` ; il
           saurait construire un `EtatPasserelleAudio`, et `system_status`
           saurait afficher « voix : aucun moteur installé ».

           On ne l'a pas fait, pour la raison qu'ADR-102 venait d'écrire une
           ADR plus tôt. Brancher une passerelle audio sur une interface qui ne
           peut ni entendre ni parler ferait descendre ce compteur en
           produisant **l'apparence d'un pipeline**. Le compteur mesurerait
           alors le branchement, pas l'usage — et c'est précisément sur la voix
           qu'une apparence de capacité est dangereuse, parce qu'elle se
           vérifie en parlant et que personne ne parlera.

           ⚠ ET `registre.ts` EST VIDE, littéralement : deux tableaux sans
           élément. Il entre quand même ici, parce que ce compteur mesure ce
           qu'aucun point d'entrée n'atteint, pas ce qui est gros.

           Condition de sortie, mécanique : le premier moteur enregistré. Ce
           jour-là il faudra brancher les deux, et ce test le rappellera. */
        'src/core/voice/passerelle.ts',
        'src/providers/voice/registre.ts',


        /* ⚠ `src/core/intent/tier1.ts` A QUITTÉ CETTE LISTE — ADR-082.

           Il y figurait avec ce motif : « écrit, éprouvé, et appelé par
           PERSONNE, parce qu'aucun `ModelProvider` local n'existe encore ».
           Il existe : `createOllama` implémente `ModelProvider` sur la boucle
           locale, et `runtime.ts` construit le `Tier 1` dès que la
           configuration l'active.

           Le compteur redescend de quatre à trois — et cette fois pour la
           raison qu'on avait annoncée, à l'ADR suivante. C'est le mouvement
           qu'on attend d'une dette datée. */

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

  it('SEPT modules de LOGIQUE testés ne sont traversés par aucun usage', () => {
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
       parce qu'une mémoire vit à plusieurs endroits.

       **À trois avec ADR-073** : `context/resolver.ts` est appelé par
       l'Assistant, qui résout les référents avant d'invoquer un outil. Le
       Context Engine attendait cela depuis `docs/26 §4.12` — et il l'a obtenu
       SANS modèle, par trois causes tombées l'une après l'autre. */
    /* **À QUATRE avec ADR-081**, puis **À TROIS avec ADR-082** : le `Tier 1`
       est entré dans la liste le temps d'un commit — celui où son enveloppe de
       sûreté était écrite mais où aucun modèle ne l'appelait — et en est sorti
       dès que `createOllama` a existé.

       Un aller-retour d'une seule étape, annoncé à l'aller. C'est ce qu'on
       attend d'une dette datée, par opposition à celle qu'on découvre.

       **À SEPT avec ADR-088**, et c'est la plus forte hausse de l'histoire de
       ce compteur : les quatre modules de l'Update Engine entrent d'un coup.

       ⚠ IL FAUT LIRE CETTE HAUSSE COMME UNE DÉCISION, PAS COMME UN RECUL.

       C'est le motif du CostGate à l'échelle d'une phase : l'enveloppe de
       sûreté s'écrit À FROID. Clouer « une signature non vérifiée est refusée,
       sans exception » est facile aujourd'hui ; ça le sera beaucoup moins le
       jour où un correctif de sécurité urgent attendra derrière ce refus — et
       c'est ce jour-là qu'on aurait écrit la règle si on avait attendu.

       Ce compteur ne mesure pas une qualité : il mesure **l'écart entre ce qui
       est écrit et ce qui sert**. Le faire baisser en branchant un exécutant
       de mise à jour qui n'a aucun vérificateur de signature serait le
       tricher — et produirait exactement le système que `docs/07 §4` interdit.

       **À NEUF avec ADR-093** : `voice/micro.ts` et `voice/plafond.ts`
       entrent ensemble, et pour une raison qui n'est PAS celle de l'Update
       Engine. Là il s'agissait d'écrire une enveloppe de sûreté à froid ; ici
       il s'agit d'écrire une DÉCISION.

       `docs/26 §4.17` posait deux questions — qui est dans la pièce, qui
       entend la réponse — et refusait d'écrire le mécanisme avant la réponse,
       « écrire le mécanisme d'abord reviendrait à choisir à sa place ». La
       réponse est venue. Elle est écrite en fonction plutôt qu'en paragraphe,
       et c'est la seule forme qui se casse quand on la contredit.

       Un compteur qui monte de deux pour cette raison-là est un bon compteur.
       Le faire baisser en branchant un micro sur un plafond non décidé serait
       l'inversion exacte que la zone d'ombre refusait.

       **À DIX avec ADR-102**, le Model Router. Troisième motif distinct
       d'entrée dans cette liste, après « pas de payeur » (CostGate) et « pas
       de vérificateur » (Update Engine) : ici le module POURRAIT être branché,
       et ne l'est pas parce qu'arbitrer entre un seul candidat n'est pas
       arbitrer. Sa condition de sortie est le premier fournisseur non local.

       **À DOUZE avec ADR-103** : la passerelle audio et son registre. Même
       motif que le routeur — branchables, non branchés — et il est ici plus
       tranchant : brancher un pipeline audio sur une machine qui ne peut ni
       entendre ni parler produirait l'APPARENCE d'une voix, qui ne se vérifie
       qu'en parlant. Condition de sortie : le premier moteur enregistré. */
    expect(deadLogic).toHaveLength(12);
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

  it('l’agenda Google arrive jusqu’aux OUTILS, et seulement s’il est configuré', () => {
    /* ⚠ LA LEÇON D'ADR-066, APPLIQUÉE AU PREMIER FOURNISSEUR RÉSEAU.

       `reachable` suit le graphe d'IMPORTS : un import conservé suffit à faire
       passer un module pour branché, même si plus rien ne l'appelle. On vérifie
       donc les deux bouts — le runtime CONSTRUIT le fournisseur, et il le passe
       aux outils.

       Et la garde qui compte autant : il n'est construit QUE si le coffre porte
       de quoi se connecter. Le construire sans secrets ne ferait que découvrir
       leur absence à chaque appel, et ferait dire à Jarvis « indisponible » là
       où la vérité est « aucun compte connecté ». */
    const runtime = readFileSync(join(ROOT, 'src/apps/runtime.ts'), 'utf8');
    expect(runtime).toContain('googleAgendaConfigure(vault)');
    expect(runtime).toContain('createGoogleAgenda({ vault })');
    expect(runtime).toContain('calendar:');

    /* ⚠ ET AUCUN SECRET N'EST LU DANS LE RUNTIME. Le coffre y circule comme
       objet ; `expose()` n'a qu'un point d'usage, dans l'adaptateur. */
    expect(runtime).not.toContain('expose()');
  });

  it('l’Undo Engine arrive jusqu’à la SURFACE PRODUIT, pas seulement au graphe', () => {
    /* LA LEÇON D'ADR-063, APPLIQUÉE À UN MOTEUR ENTIER. On y avait réparé le
       pipeline de la confirmation et oublié le rendu ; ici le risque est le
       même à plus grande échelle — un Undo Engine complet, éprouvé, et qu'aucune
       commande n'appelle.

       On vérifie donc les deux bouts : le runtime l'EXPOSE, et une surface
       l'ATTEINT. Un test qui ne regarderait que le premier laisserait passer
       exactement le sabotage qui a rendu la ligne ci-dessus verte à tort.

       ⚠ CE TEST A CHANGÉ DE BOUT — ADR-105, et le changement EST l'ADR.

       Il vérifiait que le CLI appelle `previewLast()` et `undoLast()`. C'était
       vrai, et c'était précisément le défaut : le moteur n'était atteint que
       par LE CLI. Depuis `assistant.say()` — donc depuis le téléphone — la
       même phrase rendait « capacité absente ».

       Un moteur branché à une seule surface est, vu des autres, un moteur
       absent. On vérifie donc qu'il est atteint là où TOUTES les surfaces
       passent : l'Assistant. */
    const runtime = readFileSync(join(ROOT, 'src/apps/runtime.ts'), 'utf8');
    expect(runtime).toContain('createUndoEngine(');
    expect(runtime, 'l’Assistant doit le recevoir').toContain('undo,');

    const assistant = readFileSync(join(ROOT, 'src/core/assistant.ts'), 'utf8');
    expect(assistant).toContain('deps.undo.previewLast()');
    expect(assistant).toContain('deps.undo.undoOperation(');

    // Et la capacité est ANNONCÉE sur les deux surfaces : une capacité que
    // l'interface ne cite pas n'existe que pour qui a lu le code (ADR-094).
    const cli = readFileSync(join(ROOT, 'src/apps/cli/main.ts'), 'utf8');
    expect(cli).toContain('/annule');
    const ui = readFileSync(join(ROOT, 'src/apps/server/ui.ts'), 'utf8');
    expect(ui).toContain('data-phrase="annule la dernière action"');
  });

  it('la boucle réelle RÉSOUT les référents — et le moteur reste pur', () => {
    /* ⚠ CE TEST A CHANGÉ DE CAMP — ADR-073.
       Il démontrait que « la boucle réelle ne résout aucune entité » : le
       fichier portant la boucle n'avait aucun lien avec le résolveur.

       Il en a un désormais, et à UN SEUL endroit — c'est le sujet. La
       résolution vit dans l'Assistant ; le moteur d'intention, lui, n'a
       toujours aucun lien avec le résolveur, et c'est la propriété qu'on a
       refusé de vendre : `propose(text)` reste une fonction PURE du texte. */
    const assistant = readFileSync(join(ROOT, 'src', 'core', 'assistant.ts'), 'utf8');
    expect(assistant).toContain('resolveAnaphora');

    const intent = readFileSync(join(ROOT, 'src', 'core', 'intent', 'engine.ts'), 'utf8');
    expect(intent).not.toContain('resolver');

    /* ⚠ CETTE ASSERTION A ÉTÉ AFFINÉE, PAS AFFAIBLIE — ADR-096.

       Elle disait `not.toContain('context/')`. Un moteur qui importe le
       résolveur n'est plus pur : l'assertion était juste, et elle a rougi dès
       que le moteur a eu besoin du TYPE `GenreDesigne`.

       La distinction n'est pas de la comptabilité de typage :

       ```text
       import type { GenreDesigne }   effacé à la compilation. Aucun code,
                                      aucune entrée-sortie, aucun appel.
       import { createDesignation… }  le moteur pourrait interroger la base.
                                      C'est CE jour-là que propose() cesse
                                      d'être une fonction du texte.
       ```

       On interdit donc le second, et on autorise le premier — ce qui rend la
       propriété PLUS précise qu'avant : « le moteur ne peut pas interroger la
       base » remplace « le moteur ne prononce pas le mot context ».

       `verbatimModuleSyntax` est activé dans ce dépôt : un `import type` qui
       serait en fait un import de valeur ne compilerait pas. Le compilateur
       garde donc la moitié que ce test ne peut pas voir. */
    const importsDeValeur = [...intent.matchAll(/^import\s+(?!type\b)[^;]*from\s+'[^']*context\/[^']*';/gm)];
    expect(
      importsDeValeur.map((m) => m[0]),
      'le moteur d’intention ne doit importer AUCUNE valeur de context/',
    ).toEqual([]);

    // Contrôle : l'import de type, lui, existe bien — sinon l'assertion
    // ci-dessus serait vraie pour la mauvaise raison.
    expect(intent).toContain("import type { GenreDesigne }");
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
