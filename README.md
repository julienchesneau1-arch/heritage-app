# JARVIS — Personal Operating System

**Pack de référence v0.2 — Architecture-first**

> **Jarvis est une couche personnelle de confiance qui transforme une intention
> humaine en action vérifiable.**

Statut : **Jarvis fonctionne.** Interface texte, passerelle web pour le téléphone,
cinq outils, mémoire — sans Internet et sans aucun modèle installé.

---

## Ce que ce dépôt contient

Deux choses, et l'ordre compte : d'abord la **constitution** de Jarvis — décisions
structurantes, invariants de sécurité, politique de dépendances, scénarios de
non-régression, audits — puis le **noyau** qui l'applique.

Aucune couche n'a été construite sans porte de sortie vérifiable.

Le changement de philosophie entre v0.1 et v0.2 tient en une phrase :

> Jarvis n'est pas construit à partir d'une liste de technologies.
> Jarvis est un système dont les technologies peuvent être remplacées sans casser le produit.

---

## Ordre de lecture

| # | Document | Rôle | Lire si… |
|---|----------|------|----------|
| — | `README.md` | Ordre de lecture | vous arrivez |
| 00 | [`docs/00_MASTER_VISION.md`](docs/00_MASTER_VISION.md) | Constitution technique et produit | **toujours en premier** |
| 01 | [`docs/01_ARCHITECTURE_DECISIONS.md`](docs/01_ARCHITECTURE_DECISIONS.md) | ADR — décisions + arbitrages + conditions de révision | vous vous demandez « pourquoi ce choix » |
| 02 | [`docs/02_CLAUDE_CODE_EXECUTION_PLAN.md`](docs/02_CLAUDE_CODE_EXECUTION_PLAN.md) | Construction phase par phase, avec portes de sortie | vous allez construire |
| 03 | [`docs/03_SECURITY_AND_PRIVACY.md`](docs/03_SECURITY_AND_PRIVACY.md) | Modèle de menace, invariants, Data Firewall | vous touchez à une action externe |
| 04 | [`docs/04_DEPENDENCY_AND_COST_POLICY.md`](docs/04_DEPENDENCY_AND_COST_POLICY.md) | €0 récurrent, indépendance fournisseurs, droit d'exister d'une dépendance | vous ajoutez une dépendance |
| 05 | [`docs/05_GOLDEN_TESTS.md`](docs/05_GOLDEN_TESTS.md) | Scénarios de non-régression, y compris adversariaux | vous modifiez un comportement |
| 06 | [`docs/06_CLAUDE_CODE_MASTER_PROMPT.md`](docs/06_CLAUDE_CODE_MASTER_PROMPT.md) | Instructions permanentes pour Claude Code | **avant toute session de code** |
| 07 | [`docs/07_UPDATE_ENGINE_SPEC.md`](docs/07_UPDATE_ENGINE_SPEC.md) | Auto-update, LAB/Twin, canary, rollback | vous touchez au cycle de vie |
| 08 | [`docs/08_LANDSCAPE_AUDIT.md`](docs/08_LANDSCAPE_AUDIT.md) | **Audit du terrain** : ce qu'on assemble vs ce qu'on développe, brique par brique | avant de décider de coder quoi que ce soit |
| 09 | [`docs/09_ARCHITECTURE_AUDIT_AND_GAPS.md`](docs/09_ARCHITECTURE_AUDIT_AND_GAPS.md) | **Audit d'architecture et analyse d'écarts** : ce qui doit être décidé maintenant vs plus tard | avant de reprendre le développement |
| 10 | [`docs/10_EXISTING_TECHNOLOGY_BENCHMARK.md`](docs/10_EXISTING_TECHNOLOGY_BENCHMARK.md) | **Build vs Buy** sur les systèmes personnels complets (OpenClaw, OpenJarvis, SemaClaw…) | avant d'adopter une orchestration existante |
| 11 | [`docs/11_RED_TEAM_AUDIT.md`](docs/11_RED_TEAM_AUDIT.md) | **Audit et red team** : ce qui est vrai, ce qui est faux, ce qui est dangereux — avec preuves exécutables | avant de faire confiance à ce dépôt |
| 12 | [`docs/12_TRUTH_AND_TRACEABILITY.md`](docs/12_TRUTH_AND_TRACEABILITY.md) | **Architecture de vérité** : le contrat `SOURCE → … → OBSERVATION`, la matrice adversariale, le journal d'intention | avant de brancher le contexte ou un modèle |
| 13 | [`docs/13_THREAT_MODEL.md`](docs/13_THREAT_MODEL.md) | **Modèle de menace** : biens, attaquants, frontières de confiance, et la règle `FAIL CLOSED` | avant d'ouvrir une surface d'attaque |
| 14 | [`docs/14_DATA_CLASSIFICATION.md`](docs/14_DATA_CLASSIFICATION.md) | **Classification des données** : cinq niveaux, et l'ordre qui interdit au coût de décider de la confidentialité | vous manipulez une donnée personnelle |
| 15 | [`docs/15_MODEL_PROVIDER_CONTRACT.md`](docs/15_MODEL_PROVIDER_CONTRACT.md) | **Contrat de fournisseur** : capacités et non modèles, quatre verbes, quatre règles non négociables | vous branchez un modèle |
| 16 | [`docs/16_VERIFICATION_CAPABILITIES.md`](docs/16_VERIFICATION_CAPABILITIES.md) | **Capacités de vérification** : ce qu'un outil doit déclarer, et pourquoi la déclaration doit être vérifiée | vous écrivez un outil |
| 17 | [`docs/17_REAL_WORLD_FAILURE_MATRIX.md`](docs/17_REAL_WORLD_FAILURE_MATRIX.md) | **Défaillances du monde réel** : ce qui est prouvé, partiel, ou intestable — et pourquoi | avant de croire que ça tient sous panne |
| 18 | [`docs/18_REAL_WORLD_FAILURE_REPORT.md`](docs/18_REAL_WORLD_FAILURE_REPORT.md) | **Rapport du banc de défaillance** : ce que la concurrence, les crashs et un fournisseur menteur ont réellement produit | avant de croire une garantie de ce dépôt |
| 19 | [`docs/19_PARTIAL_AND_ROUTING.md`](docs/19_PARTIAL_AND_ROUTING.md) | **Succès partiel et routage** : `PARTIAL` par sous-cible, et les deux invariants de repli | avant d'écrire un outil multi-cibles ou un routeur |
| 20 | [`docs/20_CHAOS_AND_TRUST_BOUNDARY.md`](docs/20_CHAOS_AND_TRUST_BOUNDARY.md) | **Chaos et preuve** : hiérarchie `CONFIRMED`/`FAILED`/`UNKNOWN`, dix invariants, bail d'exécution | avant de croire qu'un défaut se voit à la relecture |
| 21 | [`docs/21_LEASE_ADVERSARIAL_REPORT.md`](docs/21_LEASE_ADVERSARIAL_REPORT.md) | **Le bail ne mesure pas la vie** : contrat d'effet, et la frontière avec le monde extérieur | avant de rejouer quoi que ce soit après un `UNKNOWN` |
| 22 | [`docs/22_EXTERNAL_REALITY_LAB_DESIGN.md`](docs/22_EXTERNAL_REALITY_LAB_DESIGN.md) | **Conception du banc de réalité extérieure** : six invariants, jeton de cloisonnement, deux mondes, matrice de vérité | avant d'écrire la moindre ligne de Foundation 5 |
| 23 | [`docs/23_CLOCK_AND_FENCING_MEASUREMENTS.md`](docs/23_CLOCK_AND_FENCING_MEASUREMENTS.md) | **Couche 01 mesurée** : les trois horloges, le défaut latent de l'estampille, l'absence de cloisonnement | avant de toucher au bail ou d'envelopper le Gateway dans une transaction |
| 24 | [`docs/24_FENCING_REPORT.md`](docs/24_FENCING_REPORT.md) | **Cloisonnement du bail** : matrice des chemins d'écriture audités, test de sabotage, et la frontière que le cloisonnement ne franchit pas | avant d'écrire quoi que ce soit dans `tool_operations` |
| 25 | [`docs/25_LEASE_LAYER_REPORT.md`](docs/25_LEASE_LAYER_REPORT.md) | **Couche 02 — le bail** : l'échéance appartient à l'acquisition, le gel qu'aucune mesure ne détecte, et le coût mesuré de l'absence de renouvellement | avant de toucher à l'expiration d'un bail ou au `timeoutMs` d'un outil |
| 26 | [`docs/26_REGISTRE_DES_ZONES_D_OMBRE.md`](docs/26_REGISTRE_DES_ZONES_D_OMBRE.md) | **Registre des zones d'ombre** : ce qui est supprimé, ce qui est irréductible, ce qui est différé — et ce que le balayage ne garantit pas | avant de croire qu'une capacité de ce dépôt est disponible |
| — | [`docs/DEPENDENCIES.md`](docs/DEPENDENCIES.md) | Registre des dépendances et de leurs fiches | avant d'ajouter une dépendance |

`CLAUDE.md` à la racine est chargé automatiquement par Claude Code et renvoie vers 06.

---

## Démarrage

Prérequis : **Node 22+**, **pnpm 10+**, **PostgreSQL 16+** (avec `pgvector` pour
la Phase 1).

Guide pas à pas : [`QUICKSTART.md`](QUICKSTART.md).

```bash
pnpm install
pnpm jarvis:setup           # secrets générés, rôles, bases, migrations
pnpm jarvis                 # l'interface texte
pnpm jarvis:web             # la passerelle web locale (téléphone)

pnpm test                   # 501 tests
pnpm test:redteam           # les 97 tests d'audit et de red team
pnpm test:lab               # les 129 tests du banc (chaos, bail, horloge, cloisonnement, échéances)
JARVIS_CHAOS_RUNS=150 pnpm test:lab   # campagne de chaos étendue
pnpm test:coverage          # couverture mesurée
pnpm gate:phase0            # vérifie la porte de sortie Phase 0
pnpm gate:phase1            # vérifie la porte de sortie Phase 1
pnpm gate:phase2            # vérifie la porte de sortie Phase 2
```

Les tests tournent sur une base séparée (`jarvis_test`). Un garde-fou refuse de
les lancer si la base visée ne contient pas « test » dans son nom : la suite
recrée le schéma à chaque exécution.

```text
> Ajoute du terreau à ma liste
  ✓ C'est fait.

> Retiens que Jean travaille chez Orano
  ✓ C'est fait.

> Que sais-tu sur Orano
  ✓ C'est fait.
  (recherche sans la voie sémantique — aucun modèle d'embeddings)
  • Jean travaille chez Orano  [FACT]

> Qu'as-tu fait aujourd'hui ?
  Depuis le journal d'exécution :
      1 × MEMORY_ADDED [CONFIRMED]
      1 × MEMORY_SEARCHED [CONFIRMED]
      1 × TASK_CREATED [CONFIRMED]
  Chaîne d'audit intacte (3 événements).
```

`pgvector` est requis pour la voie sémantique. S'il est absent, `db:bootstrap`
le signale et les voies structurée et lexicale continuent de fonctionner.

Trois rôles PostgreSQL distincts, par moindre privilège :

| Rôle | Usage | Droits sur le journal |
|---|---|---|
| `jarvis_superuser` | `db:bootstrap` uniquement | — |
| `jarvis_owner` | migrations uniquement | bloqué par trigger |
| `jarvis_app` | le noyau | `SELECT`, `INSERT` — **jamais** `UPDATE`/`DELETE` |

Le banc de mesure se lance à part, sur la machine cible : `pnpm bench`
(voir [`ops/bench/README.md`](ops/bench/README.md)).

---

## L'état actuel du projet

**Phases 0, 1 et 2 franchies. Étape A (fondations de données) posée.**

Ce qui existe et tourne : schéma PostgreSQL avec migrations réversibles, Event
Ledger append-only chaîné par hash, Policy Gate L0–L4 adossé à Cedar, Memory
Guard à deux axes de classification, recherche hybride à trois voies, Context
Engine avec détection d'ambiguïté, Memory Inbox, capture d'état antérieur,
registre des dérivés, interfaces fournisseurs avec test de contrat bloquant,
coffre à secrets, banc de mesure, CI. **154 tests passent.**

S'y ajoutent le Tool Gateway et ses contrats, le Verification Engine, la
séparation Privileged/Quarantined (ADR-004), les cinq premiers outils —
`memory_add`, `memory_search`, `task_create`, `task_list`, `note_create` — et
une **interface texte** avec analyse d'intention par règles (Tier 0 du PRD :
aucun modèle requis).

Enfin une **passerelle web locale** (ADR-023) : la même boucle, servie sur le
réseau domestique derrière un jeton obligatoire, pour utiliser Jarvis depuis un
téléphone. Elle n'exécute rien en propre — elle appelle le même Assistant que le
CLI, donc le même Policy Gate, le même Memory Guard et le même journal.
**501 tests passent**, dont 97 écrits pour l'audit et la red team.

Cet audit a trouvé deux défauts critiques et sept majeurs. **Le Sprint
Foundation 1 en a corrigé six** — dont les deux critiques : le processus survit
désormais à une coupure de PostgreSQL et reprend seul, et une déduction de
modèle ne peut plus hériter d'une provenance fiable (ADR-024). Aucune
fonctionnalité n'a été ajoutée pendant ce sprint : c'était un gel.

Restent ouverts et documentés : la mémoire de travail, la contradiction, et les
outils d'oubli et de correction. Lire `docs/11` avant de se fier à ce dépôt.

Ce qui n'existe pas encore : Undo Engine (la capture existe, pas l'exécution),
Data Firewall complet, Model Router, Cost Engine, modes cognitifs, voix,
application iOS native. Voir `docs/02` et l'analyse d'écarts en `docs/09`.

Le document 08 conclut qu'environ **80 % de la machinerie** peut être assemblée à partir
de briques open source matures, et identifie les **20 %** — la couche de confiance — qui
constituent réellement notre propriété logicielle. Il impose aussi **six corrections** à
la v0.2, dont une majeure : *le Policy Engine seul ne suffit pas contre l'injection
indirecte.*

Les deux décisions bloquantes sont tranchées (9 août 2026) : **Cedar** pour l'évaluation
de politique (ADR-005), **TypeScript + Swift** pour l'implémentation (ADR-016).

Le document 09 (analyse d'écarts) a conduit à poser cinq **fondations de données**
avant d'aller plus loin — taxonomie de source à deux axes, capture d'état antérieur,
registre des dérivés, Memory Inbox, classification fine. Ce sont les seules décisions
dont le report coûtait cher, parce que la mémoire accumule des données qu'on ne peut
pas régénérer.

Reste ouvert : le **banc de mesure**, sept questions que la lecture ne peut pas
trancher (WER français, latence de bout en bout, qualité de récupération, appel
d'outils en français…). Voir `docs/08 §7` — il s'exécute sur la machine cible.

La règle qui en découle est permanente :

> Si Claude Code propose de coder quelque chose qui peut être remplacé par une brique
> open source mature **sans perte fonctionnelle ni perte de sécurité**, il doit proposer
> cette option avant d'implémenter.

---

## Le premier succès attendu

Pas « Jarvis parle comme Tony Stark ».

> Internet est coupé, aucun fournisseur IA externe n'est disponible, et Jarvis continue
> à comprendre, mémoriser, retrouver et exécuter correctement les tâches locales.

---

## Note sur le nom du dépôt

Ce dépôt s'appelle `heritage-app` pour des raisons historiques ; le produit s'appelle
Jarvis. À renommer ou à assumer explicitement avant la première release, pour éviter
une ambiguïté durable dans les scripts, les chemins et la documentation.
