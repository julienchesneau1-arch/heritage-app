# JARVIS — Personal Operating System

**Pack de référence v0.2 — Architecture-first**
Statut : spécification. **Aucun code produit à ce stade, volontairement.**

---

## Ce que ce dépôt contient

Ce dépôt ne contient pas encore Jarvis. Il contient la **constitution** de Jarvis :
les décisions structurantes, les invariants de sécurité, la politique de dépendances,
les scénarios de non-régression, et l'audit du terrain qui détermine ce que nous
allons *assembler* plutôt que *développer*.

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
| — | [`docs/DEPENDENCIES.md`](docs/DEPENDENCIES.md) | Registre des dépendances et de leurs fiches | avant d'ajouter une dépendance |

`CLAUDE.md` à la racine est chargé automatiquement par Claude Code et renvoie vers 06.

---

## Démarrage

Prérequis : **Node 22+**, **pnpm 10+**, **PostgreSQL 16+** (avec `pgvector` pour
la Phase 1).

```bash
pnpm install
cp .env.example .env        # puis renseigner les mots de passe
pnpm db:bootstrap           # crée les rôles et la base (superutilisateur)
pnpm db:migrate             # applique les migrations
pnpm test                   # 121 tests
pnpm gate:phase0            # vérifie la porte de sortie Phase 0
pnpm gate:phase1            # vérifie la porte de sortie Phase 1
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

**Phases 0 et 1 franchies. Phase 2 gelée à mi-parcours, pour audit d'architecture
(voir `docs/09`).**

Ce qui existe et tourne : schéma PostgreSQL avec migrations réversibles, Event
Ledger append-only chaîné par hash, Policy Gate L0–L4 adossé à Cedar, Memory
Guard, recherche hybride à trois voies, Context Engine avec détection
d'ambiguïté, interfaces fournisseurs avec test de contrat bloquant, coffre à
secrets, banc de mesure, CI. **121 tests passent.**

Ce qui n'existe pas encore : Tool Gateway, Verification Engine, séparation
Privileged/Quarantined, Data Firewall, voix, iOS. Voir `docs/02`.

Le document 08 conclut qu'environ **80 % de la machinerie** peut être assemblée à partir
de briques open source matures, et identifie les **20 %** — la couche de confiance — qui
constituent réellement notre propriété logicielle. Il impose aussi **six corrections** à
la v0.2, dont une majeure : *le Policy Engine seul ne suffit pas contre l'injection
indirecte.*

Les deux décisions bloquantes sont tranchées (9 août 2026) : **Cedar** pour l'évaluation
de politique (ADR-005), **TypeScript + Swift** pour l'implémentation (ADR-016).

Restent avant Phase 0 : la validation de la frontière assembler / développer, et le
**banc de mesure** — sept questions que l'audit ne peut pas trancher par la lecture
(WER français, latence de bout en bout, qualité de récupération, appel d'outils en
français…). Voir `docs/08 §7`.

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
