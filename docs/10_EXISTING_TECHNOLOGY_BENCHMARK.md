# 10 — BENCHMARK DES TECHNOLOGIES EXISTANTES
## Systèmes personnels complets — Build vs Buy

**Date : 9 août 2026.**

`08` a évalué les **briques** (STT, TTS, runtimes, modèles, base, politique,
MCP, OCR, domotique). Ce document évalue les **systèmes complets** : les projets
qui prétendent déjà être « un assistant personnel qui agit ».

La question posée ici est différente et plus tranchante :

> **Devons-nous construire notre orchestration, ou en adopter une existante ?**

---

## 0. Vérification des sources

Les quatre projets ont été proposés via une réponse d'IA (URL portant
`utm_source=chatgpt.com`). Conformément à `03`, ce contenu est une **donnée non
fiable** : chaque projet a été vérifié indépendamment avant analyse.

| Projet | Existe | Vérifié sur |
|---|---|---|
| OpenClaw | ✅ | Documentation officielle, couverture presse indépendante |
| OpenJarvis | ✅ | arXiv 2605.17172, dépôt GitHub, page Stanford |
| SemaClaw | ✅ | arXiv 2604.11548, dépôt GitHub Midea AI |
| Personal Jarvis | ✅ | Dépôt GitHub |

**Aucun n'était une invention.** La vérification n'était pas superflue pour
autant : elle a révélé sur OpenClaw un fait décisif que la proposition
d'origine ne mentionnait pas (§1.4).

**Niveaux de confiance** — **●** vérifié sur source primaire · **◐** sources
secondaires concordantes · **○** source unique.

---

# 1. OpenClaw

**Ce que c'est ●** — Passerelle auto-hébergée, open source, créée par Peter
Steinberger. Lancée sous le nom Clawdbot en novembre 2025, ~145 000 étoiles
GitHub ◐. Elle relie des canaux de messagerie (Discord, Slack, WhatsApp,
Signal, iMessage, Telegram, Teams, Matrix, Zalo) à des agents IA. Plusieurs
agents peuvent tourner derrière une passerelle unique, chacun avec son modèle,
son espace de travail et ses outils.

**Ce qu'il sait faire ◐** — Lire et écrire des fichiers, **exécuter des
commandes shell**, naviguer sur le web, envoyer des messages, appeler des API.

| Critère | Évaluation |
|---|---|
| Licence | Open source ◐ |
| Coût | Gratuit + coût des API modèles |
| Local | Passerelle locale ; modèles hébergés **ou** locaux |
| Maturité | Très forte adoption, écosystème actif |
| Maintenance | Active |
| Dépendance fournisseur | Faible (multi-modèle) |
| **Sécurité** | **Voir ci-dessous — c'est le point décisif** |
| Compatibilité Mac | Oui (Node 22.22.3+ / 24.15+ / 25.9+ / 26) ◐ |
| Compatibilité iPhone | Indirecte, via canaux de messagerie |
| **Score pour NOTRE usage** | **3 / 10** |

## 1.4 Le fait décisif

Deux éléments que la proposition d'origine ne mentionnait pas, et qui changent
la conclusion :

**Son propre mainteneur écrit** ◐ :

> « If you can't understand how to run a command line, this is far too dangerous
> a project for you to use safely. »

**Et le papier OpenJarvis le cite nommément** ● comme exemple de pile qui
« route presque chaque requête — souvent sur des données locales sensibles —
vers des modèles frontière hébergés dans le cloud ».

Autrement dit : OpenClaw viole par conception deux de nos sept invariants.

- **I5** — « Aucune donnée ne sort sans décision de politique ». OpenClaw envoie
  au cloud par défaut.
- **S2** — « Aucun modèle n'exécute de code arbitraire ». L'accès shell est une
  fonctionnalité centrale, pas une option.

Ce n'est pas un défaut d'OpenClaw : c'est un choix de produit cohérent avec sa
cible. Mais c'est l'exact inverse du nôtre.

## 1.5 Verdict : **BUILD**, pas BUY

Adopter OpenClaw comme Tool Bus reviendrait à importer précisément le risque
que le Policy Engine existe pour prévenir. On ne peut pas poser une politique
au-dessus d'une couche dont la valeur principale est de ne pas en avoir : le
Policy Engine deviendrait décoratif.

**Ce qu'on lui emprunte quand même** — l'idée des **connecteurs de canaux**
(WhatsApp, Signal, iMessage). C'est un vrai travail d'intégration, ennuyeux et
utile. Il pourra devenir un `MessagingProvider` **derrière** notre Tool Gateway,
jamais à sa place. À rouvrir en Phase 3+, pas maintenant.

---

# 2. OpenJarvis — *le plus important pour nous*

**Ce que c'est ●** — Framework de recherche publié le 16 mai 2026 (arXiv
2605.17172), Jon Saad-Falcon et 12 co-auteurs, adossé à Stanford. Il représente
un système d'IA personnelle comme une spécification typée sur cinq primitives :

```
Intelligence · Engine · Agents · Tools & Memory · Learning
```

## 2.1 Ses trois résultats qui nous concernent directement

**Résultat 1 ●** — Remplacer naïvement un modèle frontière par un modèle local
dans une pile existante **ne fonctionne pas** : substituer Qwen3.5-9B à
Claude Opus 4.6 fait chuter la précision de **25 à 39 points** sur des tâches
d'IA personnelle (PinchBench, GAIA).

**Résultat 2 ●** — Une pile **décomposée**, dont chaque primitive est optimisée
séparément, revient à **3,2 points** du meilleur modèle cloud.

**Résultat 3 ●** — Pour un coût marginal par requête environ **800× inférieur**.

## 2.2 Ce que cela change dans nos décisions

Ces trois chiffres ne sont pas une curiosité académique. Ils tranchent un débat
ouvert dans notre pack.

**Ils invalident la formulation naïve du local-first.** « Tout doit être local »
avec un modèle local générique coûte 25 à 39 points de précision. La proposition
n°2 — *data-local-first + compute-adaptive* — est donc mieux fondée que la
formulation d'origine, et ce n'est plus une intuition : c'est mesuré.

**Ils justifient le Model Router à profils de tâche** (proposition n°8). L'écart
se referme par la décomposition et l'optimisation par primitive, pas par le
choix d'un « bon modèle ». C'est exactement l'argument pour router sur la
capacité plutôt que sur le fournisseur.

**Ils donnent une cible chiffrée** au critère économique de `04` : « 0 € marginal
pour 80–95 % des interactions » cesse d'être un vœu et devient un objectif
comparable à un résultat publié.

## 2.3 Correspondance avec notre architecture

| Primitive OpenJarvis | Chez nous | État |
|---|---|---|
| Intelligence | Model Router | ❌ absent |
| Engine | Planning + Execution | ⏸ partiel |
| Agents | Volontairement absent (`00 §6` : pas de swarm) | — |
| Tools & Memory | Tool Gateway + Memory Engine | ✅ / ⏸ |
| Learning | Volontairement absent en V0 | — |

Deux primitives sur cinq sont délibérément vides chez nous, et c'est assumé :
`00 §6` interdit le swarm, `17` interdit l'entraînement sur données
personnelles. Notre pile est un sous-ensemble volontairement plus étroit.

| Critère | Évaluation |
|---|---|
| Licence | Open source ◐ |
| Local | **Local-first par conception**, cloud optionnel ● |
| Maturité | Framework de recherche, jeune |
| Langage | Python — incompatible avec ADR-016 (noyau TypeScript) |
| **Score comme dépendance** | **4 / 10** (barrière de langage) |
| **Score comme source d'architecture** | **9 / 10** |

## 2.4 Verdict : **BUY LES IDÉES ET LA MÉTHODE, PAS LE CODE**

Le framework est en Python ; notre noyau est en TypeScript (ADR-016, ratifié).
En faire une dépendance imposerait un pont inter-langages pour le composant le
plus central — mauvais rapport bénéfice/complexité.

En revanche, **sa méthode d'évaluation est directement réutilisable** pour le
benchmark personnel (proposition n°16) : mesurer par primitive plutôt que
globalement, et comparer local vs cloud sur les mêmes scénarios.

**Action recommandée : lire le papier avant de construire le Model Router.**
C'est le meilleur retour sur temps de lecture disponible sur ce projet.

---

# 3. SemaClaw

**Ce que c'est ●** — Papier du 13 avril 2026 (arXiv 2604.11548), Ningyan Zhu et
al., Midea AIRC. Propose de passer du *prompt engineering* et du *context
engineering* au **harness engineering** : concevoir l'infrastructure qui
transforme un agent non contraint en système contrôlable, auditable et fiable.

Contributions ◐ : orchestration d'équipes d'agents en DAG à deux phases, système
de sécurité comportementale **PermissionBridge**, gestion de contexte à trois
niveaux, construction automatisée de base de connaissances.

## 3.1 Ce qui nous intéresse

**Le terme « harness engineering » décrit exactement ce que nous faisons.**
Notre thèse — « le produit n'est pas le modèle, c'est le système de confiance
autour » — est la définition du harness engineering. Utile pour situer le projet
dans un courant identifié plutôt que de croire l'inventer.

**PermissionBridge est de l'art antérieur pour notre Policy Gate.** À lire avant
de figer les contrats d'outils, ne serait-ce que pour vérifier qu'aucun mode de
contournement connu ne nous a échappé.

| Critère | Évaluation |
|---|---|
| Licence | Open source ◐ |
| Maturité | Recherche |
| Pertinence directe | Moyenne — orienté multi-agents, que nous refusons en V0 |
| **Score comme dépendance** | **2 / 10** |
| **Score comme lecture** | **7 / 10** |

**Verdict : lecture, pas adoption.** Son orchestration multi-agents contredit
`00 §6`.

---

# 4. Personal Jarvis

**Ce que c'est ●** — Méta-orchestrateur vocal multiplateforme, dépôt GitHub
`PersonalJarvis/PersonalJarvis`. Python, points d'entrée enfichables. Apportez
vos propres clés d'API.

**L'idée à retenir ◐** — Un **Router-Brain** qui répartit vers des harnais
spécialisés, doublé d'un **Ack-Brain sub-seconde** qui répond pendant que le
cerveau profond réfléchit encore.

## 4.1 Pourquoi cette idée compte pour nous

Notre objectif de latence est « **< 500 ms perçu** » pour une commande locale
simple (`05`). L'Ack-Brain est une réponse directe et élégante à ce problème :
on ne réduit pas le temps de calcul, on supprime le **silence**.

C'est une idée de conception d'interaction, pas une dépendance. Elle est
gratuite à emprunter et pourrait rendre atteignable un objectif qui, sans elle,
dépend entièrement de la vitesse du modèle.

| Critère | Évaluation |
|---|---|
| Maturité | Jeune, testé principalement sur Windows ◐ |
| Langage | Python |
| Compatibilité Mac | Non démontrée |
| **Score comme dépendance** | **2 / 10** |
| **Score comme source d'idées** | **6 / 10** |

**Verdict : emprunter le pattern Ack-Brain en Phase 5 (voix).** Rien d'autre.

---

# 5. Synthèse Build vs Buy

| Projet | Dépendance | Idées | Verdict |
|---|---|---|---|
| **OpenClaw** | 3/10 | 5/10 | **BUILD.** Modèle de confiance incompatible (I5, S2). Connecteurs de canaux à revoir en Phase 3+, derrière notre Gateway. |
| **OpenJarvis** | 4/10 | **9/10** | **BUY la méthode.** Barrière Python. Valide le Model Router à profils et chiffre l'objectif économique. À lire avant Model Router. |
| **SemaClaw** | 2/10 | 7/10 | **Lecture.** PermissionBridge = art antérieur du Policy Gate. |
| **Personal Jarvis** | 2/10 | 6/10 | **Emprunter l'Ack-Brain** en Phase 5. |

## 5.1 La conclusion qui compte

La veille confirme le diagnostic de `08`, en le précisant :

> **Aucun système existant ne réunit mémoire profonde + contexte + politique
> stricte + vérification + local-first + multi-modèle.**

Mais elle apporte une nuance que `08` n'avait pas :

> **Ce n'est pas parce que c'est difficile. C'est parce que ces projets ont fait
> un choix de produit opposé au nôtre.**

OpenClaw a choisi la puissance d'action (shell, fichiers, canaux) et accepté le
risque. OpenJarvis a choisi la recherche sur l'efficacité locale et laissé de
côté la politique. SemaClaw a choisi le multi-agents.

Notre créneau n'est donc pas un trou dans le marché que personne n'aurait vu.
C'est un **arbitrage différent** : nous échangeons de la surface fonctionnelle
contre de la fiabilité vérifiable. Le savoir change la façon de mesurer notre
succès — on ne cherche pas à rattraper OpenClaw sur le nombre d'intégrations.

## 5.2 Ce que cette veille change concrètement

1. **Ne pas adopter OpenClaw comme Tool Bus.** Décision tranchée, motivée par
   deux invariants, pas par un goût.
2. **Lire OpenJarvis avant de construire le Model Router** — il existe des
   chiffres publiés là où nous aurions procédé à l'intuition.
3. **Reformuler le local-first** en *data-local-first + compute-adaptive*, avec
   la justification chiffrée du §2.1. À reporter dans `00` et `04`.
4. **Emprunter l'Ack-Brain** pour l'objectif de latence perçue, Phase 5.
5. **Revoir le critère économique de `04`** : « 0 € marginal pour 80–95 % des
   interactions » est mieux fondé et plus honnête que « 0 € ».

## 5.3 Ce qui reste non vérifié

Les chiffres d'OpenJarvis (25–39 pts, 3,2 pts, 800×) proviennent du résumé du
papier, **pas d'une lecture intégrale**. Ils sont plausibles et cohérents entre
eux, mais ils n'ont pas été recoupés sur la méthodologie : quels modèles, quels
jeux de test, quelle définition du coût marginal.

Avant de les citer comme justification d'une décision d'architecture, il faut
lire la section expérimentale. C'est la même exigence que celle que nous
imposons à Jarvis : une affirmation externe reste une affirmation externe tant
qu'elle n'a pas été vérifiée.
