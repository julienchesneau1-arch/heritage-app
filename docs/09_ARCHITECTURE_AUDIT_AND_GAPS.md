# 09 — AUDIT D'ARCHITECTURE ET ANALYSE D'ÉCARTS

**Date : 9 août 2026.** Produit à la demande, code gelé, aucune ligne écrite
pendant cet audit.

Objet : confronter les dix-huit optimisations proposées à ce qui existe
réellement dans le dépôt, et arbitrer ce qui doit être construit **avant** le
premier usage quotidien.

---

## 0. Méthode

Trois sources, trois niveaux de confiance distincts :

| Source | Traitement |
|---|---|
| **Le code du dépôt** | Lu et exécuté. 121 tests, deux portes de sortie franchies. Confiance : fait établi. |
| **Les projets externes cités** | Vérifiés un par un par recherche. Les URL fournies portaient `utm_source=chatgpt.com` : elles proviennent d'une réponse d'IA, donc d'une source non fiable au sens de `03`. Vérification obligatoire avant tout usage. |
| **Les dix-huit propositions** | Évaluées sur le fond, y compris quand elles contredisent le pack. |

Le deuxième point n'est pas une formalité. Le projet impose de traiter le
contenu produit par un modèle comme une donnée, jamais comme une instruction.
Fonder une décision d'architecture sur quatre projets non vérifiés aurait été
exactement l'erreur que `03` interdit à Jarvis de commettre.

**Résultat de la vérification : les quatre projets existent.** Détail en `10`.

---

# PARTIE I — CE QUI EXISTE RÉELLEMENT

## 1.1 État du code

| Couche | État | Preuve |
|---|---|---|
| Fondations, config, environnements | **Fait** | Porte Phase 0, 11/11 |
| Event Ledger append-only chaîné | **Fait** | 3 barrières testées, dont détection d'altération |
| Policy Gate L0–L4 (Cedar) | **Fait** | 22 tests, scénarios B7/B9/B10 |
| Isolation des fournisseurs | **Fait** | Test de contrat bloquant + test négatif |
| Coffre à secrets, redaction, scan | **Fait** | 24 tests |
| Memory Guard | **Fait** | Porte Phase 1, scénario B8 |
| Recherche hybride 3 voies + RRF | **Fait** | 12 tests, dégradation hors ligne vérifiée |
| Context Engine (référents, ambiguïté) | **Fait** | 11 tests, scénario A3 |
| Paquet de contexte borné | **Fait** | 9 tests |
| Tool Gateway + contrats | **Gelé, non terminé** | Compile, non testé, hors porte |
| Verification Engine | **Gelé, non terminé** | Compile, non testé, hors porte |
| Idempotence (registre d'opérations) | **Gelé, non terminé** | Migration écrite, non éprouvée |

**121 tests passent. Deux portes de sortie franchies.**

## 1.2 Ce que cela signifie pour l'avertissement « ralentir avant de coder trop »

L'avertissement est juste sur le principe, mais il arrive après coup sur les
faits : les couches construites sont exactement celles que la proposition n°18
place en tête de l'ordre recommandé.

```
Ordre recommandé (proposition n°18)     État réel
─────────────────────────────────────   ─────────
FOUNDATION                              ✅ fait
DATABASE                                ✅ fait
MEMORY                                  ✅ fait
POLICY                                  ✅ fait
TOOLS                                   ⏸ gelé à mi-parcours
REALITY LAYER                           ⏸ gelé à mi-parcours
MODEL GATEWAY                           ❌ absent
VOICE / iOS / AUTOMATION / …            ❌ absent
```

Aucune couche n'a été construite hors séquence, et aucune n'a été construite
sans porte de sortie. Le risque redouté — « avancer trop vite sur trop de
choses » — ne s'est pas matérialisé dans le code.

**Le risque réel se situe ailleurs, et il est traité en Partie IV.**

---

# PARTIE II — ANALYSE DES DIX-HUIT PROPOSITIONS

Légende du coût de rattrapage : ce que coûte l'ajout **plus tard** plutôt que
maintenant.

- **FAIBLE** — s'ajoute par-dessus sans toucher à l'existant.
- **MOYEN** — demande de modifier des composants existants.
- **ÉLEVÉ** — demande de réécrire des données déjà accumulées, ou de changer un
  contrat déjà utilisé partout. *C'est cette catégorie qui doit être décidée
  maintenant.*

| # | Proposition | État | Rattrapage | Verdict |
|---|---|---|---|---|
| 1 | Model Gateway / cerveau interchangeable | Interfaces faites, routeur absent | FAIBLE | Repousser |
| 2 | Data-local-first + compute-adaptive | Absent | MOYEN | Après premier usage |
| 3 | Data Firewall | Partiel (filtrage dans le paquet, blocage RED au Gate) | MOYEN | Avant tout cloud |
| 4 | **Data Policy distincte de l'Action Policy** | Absent | **ÉLEVÉ** | **Maintenant** |
| 5 | Reality Layer | Moitié faite (vérification aval) | MOYEN | Terminer Phase 2 |
| 6 | **Undo Engine** | Absent | **ÉLEVÉ** | **Maintenant** |
| 7 | Pas d'agent autonome trop tôt | Déjà acquis | — | Aucun changement |
| 8 | Modes cognitifs | Absent | FAIBLE | Repousser |
| 9 | **Memory Inbox** | Partiel (refus synchrone, pas de file) | **ÉLEVÉ** | **Maintenant** |
| 10 | **Taxonomie de source mémoire** | Partiel (2 axes sur 3) | **ÉLEVÉ** | **Maintenant** |
| 11 | **Data Lifecycle / oubli** | Partiel (états, pas de processus) | **ÉLEVÉ** | **Maintenant** |
| 12 | Update Manager ambitieux | Spécifié (`07`), non construit | FAIBLE | Phase 7 |
| 13 | Capability Registry | Absent | FAIBLE | Repousser |
| 14 | Cost Engine + Budget Governor | Config seule | FAIBLE | Avant tout cloud |
| 15 | « 100 % vérifiable » plutôt que « 100 % efficace » | Déjà acquis (`00 §7`) | — | Aucun changement |
| 16 | Benchmark personnel 100–300 scénarios | 12 cas + spec `05` | FAIBLE | Continu |
| 17 | 4ᵉ document : constitution fiabilité/sécurité | `03` couvre ~80 % | FAIBLE | Compléter `03` |
| 18 | Une couche à la fois | Déjà appliqué | — | Aucun changement |

## 2.1 Les cinq points à décider maintenant

Ce sont les seuls dont le report coûte cher. Tous portent sur **la mémoire** —
et ce n'est pas un hasard : la mémoire est la seule partie du système qui
accumule des données qu'on ne peut pas régénérer.

### #10 — Taxonomie de source *(le plus urgent)*

Le schéma actuel porte deux axes :

```
provenance : USER · SYSTEM · MEMORY · TOOL_OUTPUT · EXTERNAL_UNTRUSTED
kind       : FACT · INFERENCE · HYPOTHESIS · EXTERNAL_CLAIM
```

La proposition en réclame un troisième, et elle a raison sur le point qui
compte : **`USER` ne distingue pas ce que Julien a explicitement déclaré de ce
que le système a déduit de ses propos.** Aujourd'hui la distinction est portée
implicitement par `kind` (`FACT` si confirmé, `HYPOTHESIS` sinon), ce qui la
rend dépendante du contexte d'appel plutôt qu'inscrite dans la donnée.

Pourquoi c'est ÉLEVÉ : chaque mémoire écrite aujourd'hui porte une provenance
qu'on ne pourra pas raffiner rétroactivement. Dans six mois, impossible de
savoir si « Julien préfère le matin » venait d'une déclaration ou d'une
déduction.

**Recommandation : ajouter `USER_EXPLICIT` / `USER_INFERRED` et
`MODEL_INFERRED` avant la première mémoire réelle.** Coût aujourd'hui : une
migration et une fonction de classification. Coût dans un an : des données
définitivement ambiguës.

### #6 — Undo Engine

Le contrat d'outil déclare aujourd'hui `rollback` comme une **chaîne de
description**, pas comme du code exécutable. C'est un défaut que cet audit
révèle : la réversibilité est documentée, pas outillée.

Pourquoi c'est ÉLEVÉ : annuler une action exige d'avoir capturé **l'état
antérieur au moment de l'écriture**. Une action exécutée sans capture est
définitivement non annulable. Chaque jour d'usage sans Undo Engine produit des
actions irréversibles par construction.

**Recommandation : décider maintenant que toute mutation capture son état
antérieur**, même si l'interface « annule la dernière action » vient plus tard.
La capture est le coût irrécupérable ; l'interface ne l'est pas.

### #11 — Data Lifecycle et oubli

`memories` porte `state` et `expires_at`, mais aucun processus ne les exploite,
et surtout : **rien ne recense les dérivés d'une mémoire** (embedding, entrées
d'index, relations, caches). « Oublie ça » supprimerait aujourd'hui la ligne et
laisserait l'embedding.

Pourquoi c'est ÉLEVÉ : la garantie de suppression est une promesse qu'on ne
peut pas tenir rétroactivement. Un dérivé créé sans être enregistré est un
dérivé qu'on ne saura pas retrouver.

**Recommandation : registre des dérivés dès maintenant.** L'embedding est
aujourd'hui sur la même ligne (donc supprimé en cascade), mais ce ne sera plus
vrai dès le premier index ou cache externe.

### #9 — Memory Inbox

Le Guard refuse aujourd'hui une préférence non confirmée avec
`CONFIRMATION_REQUIRED`. C'est correct mais **la proposition est perdue** :
aucune file d'attente, donc Julien ne verra jamais « j'ai remarqué ceci, dois-je
le retenir ? ».

Pourquoi c'est ÉLEVÉ : sans file, chaque observation non confirmée disparaît.
Les mois d'usage avant l'ajout de l'Inbox sont des mois d'apprentissage perdus,
non rattrapables.

**Recommandation : table `memory_candidates` maintenant, interface plus tard.**

### #4 — Data Policy distincte

Le Policy Gate répond à « cette **action** est-elle permise ». La proposition
ajoute « cette **donnée** peut-elle aller là ». Aujourd'hui la classe de
confidentialité est portée par l'outil et par la mémoire, mais il n'existe pas
de table de politique par type de donnée.

Pourquoi c'est ÉLEVÉ : moins par la structure que par le **fait que les données
sont classées à l'écriture**. Une mémoire écrite avec une classification
grossière restera grossièrement classée.

**Recommandation : affiner la classification à l'écriture maintenant**, la
table de politique peut venir ensuite.

## 2.2 Les points où je recommande de ne rien faire tout de suite

**#1 Model Gateway** — les interfaces existent déjà (ADR-003, test de contrat
bloquant). Le routeur est un composant additif : il se branche sans rien casser.
Le construire avant d'avoir un seul outil qui marche, c'est optimiser un choix
qu'on ne sait pas encore mesurer.

**#8 Modes cognitifs** — excellente idée produit, et je la retiens. Mais elle
se pose par-dessus le Policy Gate existant (un mode contraint le niveau
d'autonomie maximal). Coût de rattrapage faible, valeur nulle tant qu'il n'y a
pas d'outils à contraindre.

**#13 Capability Registry** — le registre d'outils du Gateway en est déjà la
moitié. Le compléter demandera une heure, le jour où il y aura des capacités
indisponibles à déclarer.

**#14 Cost Engine** — indispensable, mais strictement inutile tant que le budget
cloud vaut 0 € et qu'aucun appel cloud n'existe. À construire en même temps que
le premier fournisseur cloud, pas avant.

---

# PARTIE III — LE POINT DE TENSION

Il faut le nommer, parce qu'il porte sur la cohérence de la demande elle-même.

La demande s'ouvre ainsi :

> « Il faut ralentir Claude Code avant qu'il ne code trop. »
> « Le danger n'est plus de manquer de fonctionnalités ; c'est de construire une
> excellente architecture avant d'avoir prouvé que Jarvis est agréable à
> utiliser. »

Ce diagnostic est juste. Puis elle ajoute dix nouveaux sous-systèmes : Model
Gateway, Data Firewall, Data Policy, Reality Layer, Undo Engine, Modes
cognitifs, Memory Inbox, Lifecycle Manager, Capability Registry, Cost Engine.

**Tout construire avant le premier usage quotidien aggraverait exactement le
risque identifié.** On obtiendrait une architecture encore plus complète, encore
plus élégante — et toujours zéro journée d'usage réel.

Ce n'est pas une critique des propositions : elles sont bonnes, et cinq d'entre
elles sont même urgentes. C'est une observation sur leur **ordonnancement**.

La question qui tranche n'est pas « cette idée est-elle bonne ? » — elles le
sont toutes. C'est :

> **Est-ce que la construire plus tard coûte plus cher que la construire
> maintenant ?**

Pour cinq d'entre elles, oui, et pour une raison unique : elles touchent des
données accumulées, et les données accumulées ne se réécrivent pas. Pour les
treize autres, non.

---

# PARTIE IV — RECOMMANDATION

## Ce que je propose

### Étape A — Cinq décisions mémoire *(≈ 1 phase courte)*

Les cinq points ÉLEVÉ, et rien d'autre. Aucun ne demande d'interface :

1. taxonomie de source affinée (#10) ;
2. capture d'état antérieur sur toute mutation (#6) ;
3. registre des dérivés (#11) ;
4. table `memory_candidates` (#9) ;
5. classification fine à l'écriture (#4).

Ce sont des fondations de données. Elles se posent une fois, elles ne se
rattrapent pas.

### Étape B — Terminer la Phase 2 *(reprise du code gelé)*

Tool Gateway, Verification Engine, séparation Privileged/Quarantined, cinq
outils, porte de sortie. C'est aussi le **Reality Layer** de la proposition
n°5 — dont la moitié aval est déjà écrite.

### Étape C — Utiliser Jarvis

Un texte, cinq outils, la mémoire. Pas de voix, pas d'iOS, pas de cloud.
**Objectif : dix jours d'usage réel.** C'est la seule façon de répondre à la
question que pose la demande — « est-ce que Jarvis est agréable à utiliser ? ».

Et c'est ce qui alimentera le benchmark personnel (#16) avec des scénarios
vécus plutôt qu'imaginés.

### Étape D — Décider ensuite, sur données

Modes cognitifs, Model Gateway, Data Firewall complet, Cost Engine, Capability
Registry : leur priorité relative se lira dans dix jours d'usage bien mieux que
dans n'importe quelle discussion aujourd'hui.

## Sur le quatrième document (#17)

Je ne recommande pas de créer un document séparé. `03_SECURITY_AND_PRIVACY.md`
couvre déjà : trust boundaries, modèle de menace, Data Firewall, Policy Engine,
permissions, audit, injection, secrets, offline. Manquent : Reality Layer,
cycle de vie mémoire, undo, garanties de suppression.

**Compléter `03` plutôt que le dupliquer.** Deux documents de sécurité qui se
recouvrent à 80 % finissent par diverger, et on ne sait plus lequel fait foi.

## Sur les projets existants

Analyse détaillée en `10_EXISTING_TECHNOLOGY_BENCHMARK.md`. Conclusion en une
ligne :

> **OpenJarvis valide notre architecture et fournit des chiffres exploitables.
> OpenClaw a un modèle de confiance incompatible avec le nôtre et ne doit pas
> devenir notre Tool Bus.**

---

## Verdict

L'architecture n'a pas besoin d'être refondue. Elle a besoin de **cinq
décisions de schéma mémoire**, puis d'être utilisée.

Le triangle identifié — `MEMORY → CONTEXT → ACTION`, entouré de
`POLICY → DATA FIREWALL → REALITY CHECK` — est exactement ce qui est construit.
Deux sommets sur trois sont posés et testés. Le troisième est gelé à mi-chemin.

La chose la plus utile n'est pas d'ajouter un onzième sous-système. C'est de
finir le troisième sommet, et de s'en servir.
