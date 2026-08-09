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
| 08 | [`docs/08_LANDSCAPE_AUDIT.md`](docs/08_LANDSCAPE_AUDIT.md) | **Audit du terrain** : ce qu'on assemble vs ce qu'on développe | avant de décider de coder quoi que ce soit |

`CLAUDE.md` à la racine est chargé automatiquement par Claude Code et renvoie vers 06.

---

## L'état actuel du projet

**Phase : audit terminé, construction non commencée.**

Le document 08 conclut qu'environ **80 % de la machinerie** peut être assemblée à partir
de briques open source matures, et identifie les **20 %** — la couche de confiance — qui
constituent réellement notre propriété logicielle. Il impose aussi **six corrections** à
la v0.2, dont une majeure : *le Policy Engine seul ne suffit pas contre l'injection
indirecte.*

La construction ne démarre qu'après validation de cet arbitrage et résolution des deux
décisions bloquantes (ADR-005 et ADR-016).

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
