# 01 — ARCHITECTURE DECISION RECORDS

Chaque décision porte : **Statut**, **Contexte**, **Décision**, **Conséquences**,
et surtout **Condition de révision** — le fait mesurable qui nous obligerait à
changer d'avis. Une décision sans condition de révision est un dogme, pas une
décision d'ingénierie.

**Statuts** : `RATIFIÉ` · `PROPOSÉ` (attend validation) · `REMPLACÉ` · `REJETÉ`

---

## ADR-001 — PostgreSQL est l'unique magasin de vérité

**Statut : RATIFIÉ**

**Contexte.** La tentation par défaut des projets IA est d'empiler une base
vectorielle, un graphe et un moteur de recherche. Chaque base ajoutée multiplie les
migrations, les backups, les modes de panne et la surface d'attaque — pour un système
dont l'utilisateur unique tient dans quelques centaines de milliers de lignes de données.

**Décision.** Un seul PostgreSQL contient entités, relations, événements, mémoires,
tâches, projets, préférences, règles, décisions et journal. Les embeddings vivent dans
une colonne `vector` (pgvector) de la même base, pas dans un service séparé.

**Conséquences.** Une transaction, un backup, une restauration, une migration. La
cohérence entre une mémoire et son embedding est garantie par la base, pas par un job
de synchronisation. On perd les optimisations spécialisées des bases vectorielles
dédiées — non pertinent à notre échelle.

**Condition de révision.** Une requête de récupération dépasse **200 ms p95** sur un
corpus réel, et le profilage démontre que la limite vient de l'index vectoriel et non
de notre pipeline. Alors seulement : évaluer `pgvectorscale` avant d'envisager une
base externe.

---

## ADR-002 — Recherche hybride lexicale + sémantique, fusionnée par RRF

**Statut : RATIFIÉ**

**Contexte.** Deux questions, deux natures de recherche :

> « Quelle est la référence de mon carrelage ? » → donnée structurée exacte
> « Qu'avait-on décidé pour la déco du mariage ? » → recherche sémantique

Un système purement vectoriel échoue sur la première (il rapproche « carrelage » de
« faïence » au lieu de retourner la référence exacte). Un système purement lexical
échoue sur la seconde.

**Décision.** Trois voies de récupération, dans cet ordre de priorité :

1. **Structuré** — SQL sur les entités/relations/attributs. Réponse exacte, confiance
   maximale. Toujours tenté en premier.
2. **Lexical** — `tsvector` natif PostgreSQL.
3. **Sémantique** — pgvector.

Les voies 2 et 3 sont fusionnées par **Reciprocal Rank Fusion**, qui s'écrit en SQL
standard et ne demande aucune extension supplémentaire.

**Conséquences.** Aucune extension au-delà de pgvector pour démarrer. Le classement
lexical de PostgreSQL (`ts_rank`) est notoirement faible comparé à BM25 — acceptable
tant que RRF ne s'appuie que sur le *rang*, pas sur le score absolu.

**Condition de révision.** Les Golden Tests de récupération montrent que la voie
lexicale dégrade la fusion (rappel < 0,9 sur les requêtes à mots-clés exacts). Alors :
introduire `pg_textsearch` (BM25 natif Postgres, production-ready mi-2026) — une
extension, pas une base de plus.

---

## ADR-003 — Le noyau ne connaît aucun fournisseur

**Statut : RATIFIÉ**

**Contexte.** Le couplage à un fournisseur est la dette la plus coûteuse d'un système
IA, parce qu'elle est invisible jusqu'au jour où le fournisseur change ses prix, ses
conditions, ou disparaît.

**Décision.** Interfaces obligatoires : `ModelProvider`, `SpeechProvider`,
`VisionProvider`, `CalendarProvider`, `MessagingProvider`, `StorageProvider`,
`SearchProvider`, `DeviceProvider`.

Aucun code hors `/providers/<nom>/` ne peut importer un SDK de fournisseur. Cette
règle est vérifiée par un **test de contrat automatisé** qui échoue le build, pas par
une convention de revue.

**Conséquences.** Un peu de cérémonie sur les adaptateurs. En échange, la substitution
d'un fournisseur est une modification de configuration, pas une réécriture.

**Condition de révision.** Aucune. C'est un invariant (I6).

---

## ADR-004 — Séparation flux de contrôle / flux de données (Privileged / Quarantined)

**Statut : RATIFIÉ** — *la décision la plus structurante du pack*

**Contexte.** Le Policy Engine seul ne suffit pas. Si un modèle unique lit à la fois
la demande de l'utilisateur (fiable) et le contenu d'un email (non fiable), une
injection dans l'email peut réorienter le *plan* — et le Policy Engine validera
consciencieusement une action parfaitement autorisée mais que l'utilisateur n'a jamais
demandée. La politique dit « as-tu le droit », elle ne dit pas « est-ce bien ce qui
t'a été demandé ».

La littérature 2024–2026 (CaMeL, FIDES, Progent, RTBAS, FORGE) a convergé sur la même
réponse, et c'est la nôtre : la sécurité s'applique **hors** du modèle, par un moniteur
déterministe qui suit la provenance des données.

**Décision.** Deux rôles de modèle, strictement séparés :

- **Privileged** — ne voit **que** la demande utilisateur et l'état système. Produit le
  plan. A le droit de déclencher des outils.
- **Quarantined** — traite le contenu non fiable (emails, PDF, pages web, sorties
  d'outils). **N'a aucun accès aux outils** et **ne peut jamais influencer le flux de
  contrôle**. Sa sortie est une donnée typée, pas une instruction.

Toute valeur issue du Quarantined est étiquetée par sa provenance. Le Tool Gateway
refuse un appel dont un paramètre sensible (destinataire, montant, identifiant,
chemin) provient d'une source non fiable sans confirmation explicite de l'utilisateur.

**Conséquences.** Deux appels de modèle au lieu d'un sur les tâches qui lisent du
contenu externe : coût de latence réel, assumé. En échange, la garantie devient
architecturale et non comportementale — elle ne dépend plus de la résistance du modèle
à la persuasion.

**Condition de révision.** Aucune sur le principe. L'implémentation du suivi de
provenance peut évoluer (étiquettes simples → interpréteur à capacités) si les Golden
Tests adversariaux le justifient.

---

## ADR-005 — Le Policy Engine : moteur d'évaluation assemblé, logique de porte développée

**Statut : RATIFIÉ** *(9 août 2026)*

**Contexte.** Trois options : tout coder ; embarquer OPA/Rego ; embarquer Cedar.
Rego est puissant mais son modèle logique (Datalog) est difficile à relire six mois
plus tard sur un projet personnel. Cedar est déclaratif, formellement vérifié, et
nettement plus rapide, mais sa communauté est plus jeune. Casbin est le plus léger et
s'embarque partout.

**Décision.** Séparer deux choses que l'on confond souvent :

- **L'évaluation** (« cette action, dans ce contexte, est-elle permise ? ») → moteur
  externe, déclaratif, testable isolément. **Cedar** par défaut, pour la vérification
  formelle et la lisibilité des politiques.
- **La porte** (échelle d'autonomie L0–L4, hiérarchie des règles, couplage à
  l'idempotence, à la vérification et au journal) → **notre code**. Ce n'est pas de
  l'autorisation générique, c'est de la logique produit.

**Conséquences.** Les politiques deviennent des fichiers relisibles et testables
séparément du code. Le risque de couplage à Cedar est contenu par une interface
`PolicyEvaluator` (ADR-003).

**Condition de révision.** Si l'écriture des premières politiques réelles montre que
Cedar ne peut pas exprimer un besoin (par exemple des conditions temporelles riches),
basculer sur OPA — la décision d'interface le permet sans réécriture.

---

## ADR-006 — MCP est un protocole d'outils, pas une frontière de sécurité

**Statut : RATIFIÉ**

**Contexte.** MCP est devenu le standard d'interopérabilité des outils. La spécification
`2026-07-28` (vérifiée sur le changelog officiel) a :

- supprimé la poignée de main `initialize` / `notifications/initialized` et l'en-tête
  `Mcp-Session-Id` — le protocole est désormais **sans état**, la version et les
  capacités voyageant dans `_meta` à chaque requête ;
- durci l'autorisation : validation du paramètre `iss` (RFC 9207) avant échange du
  code, et `application_type` obligatoire à l'enregistrement dynamique de client pour
  éviter les conflits d'URI de redirection OIDC ;
- sorti l'extension **Tasks** du cœur du protocole (`io.modelcontextprotocol/tasks`),
  avec `tasks/get` par interrogation au lieu d'un `tasks/result` bloquant ;
- rendu obligatoires les en-têtes `Mcp-Method` et `Mcp-Name` sur les POST Streamable
  HTTP — exploitables par une passerelle.

Conséquence notable : un serveur qui a besoin d'état inter-appels doit désormais
utiliser des **handles explicites émis par le serveur**, passés comme arguments d'outil
ordinaires.

**Décision.** Adopter MCP comme protocole de transport et de découverte d'outils.
**Le Policy Engine reste strictement au-dessus** : aucune autorisation n'est déléguée
au protocole ni au serveur MCP distant.

Deux propriétés de la spec 2026-07-28 nous servent directement :
- l'absence d'état supprime une classe entière d'attaques par détournement de session ;
- le routage par en-têtes permet à notre Tool Gateway d'**autoriser avant de dispatcher**,
  sans désérialiser le corps de la requête.

**Conséquences.** Un serveur MCP tiers est traité comme une source non fiable
(ADR-004) : ses descriptions d'outils sont des données, jamais des instructions.

**Condition de révision.** Aucune. Si MCP décline, l'interface `ToolTransport` absorbe
le changement.

---

## ADR-007 — Runtime d'inférence local derrière un adaptateur

**Statut : RATIFIÉ**

**Contexte.** Le terrain bouge vite. Ollama 0.19 (mars 2026) a remplacé son backend
llama.cpp/Metal par MLX sur Apple Silicon, avec un quasi-doublement du débit de
décodage — **mais uniquement au-delà de 32 Go de mémoire unifiée** ; en dessous, la
machine reste sur l'ancien chemin Metal. llama.cpp reste le backend sur Linux et Windows.

**Décision.** Interface `LocalModelRuntime`. Implémentations possibles : Ollama,
llama.cpp, MLX-LM, autre. Ollama est le runtime de *référence* pour démarrer, jamais
une dépendance dure : le test D du critère d'indépendance (« Ollama indisponible →
fallback local ») doit passer.

**Conséquences.** Le seuil des 32 Go est une **contrainte matérielle documentée**, pas
une surprise de déploiement. Elle doit figurer dans les prérequis d'installation.

**Condition de révision.** Un runtime unique devient nettement supérieur sur nos
benchmarks Jarvis (pas sur les benchmarks généraux) pendant deux cycles de mesure
consécutifs.

---

## ADR-008 — STT : Whisper d'abord, pour le français

**Statut : RATIFIÉ**

**Contexte.** Parakeet domine les classements de vitesse sur Apple Silicon et
plusieurs implémentations exploitent le Neural Engine via Core ML. Mais ces gains sont
mesurés principalement sur la dictée **anglaise**. Whisper couvre 99 langues et reste
le choix fiable en multilingue ; `whisper.cpp` sait exporter son encodeur en Core ML
pour l'ANE.

**Décision.** Whisper (via `whisper.cpp` + Core ML, ou WhisperKit côté Swift) est le
moteur par défaut, parce que **l'utilisateur parle français**. Parakeet reste un
adaptateur optionnel, activable si un benchmark francophone interne le justifie.

**Conséquences.** On accepte de ne pas prendre le modèle le plus rapide du classement.
C'est cohérent avec la règle : le meilleur modèle est celui qui marche pour Jarvis,
pas celui qui gagne le benchmark général.

**Condition de révision.** Un benchmark **français** interne montre un WER Parakeet
comparable à Whisper avec une latence significativement meilleure.

---

## ADR-009 — TTS : la licence est un critère de sélection, pas une note de bas de page

**Statut : RATIFIÉ**

**Contexte.** Les modèles TTS locaux ont rattrapé le commercial en 2026. Mais les
licences divergent fortement, et certaines interdisent l'usage commercial (XTTS v2 est
sous CPML). Un projet personnel aujourd'hui peut devenir autre chose demain ; hériter
d'une licence non commerciale au cœur du produit est une impasse silencieuse.

**Décision.** N'intégrer que des modèles TTS sous licence permissive.
**Piper** (léger, CPU, latence minimale, voix audiblement synthétique) et **Kokoro**
(82M, français supporté, qualité nettement supérieure, Apache) sont les deux candidats
retenus. XTTS v2 est **exclu** pour raison de licence.

**Conséquences.** Piper pour les réponses courtes où la latence prime, Kokoro pour les
lectures longues : un arbitrage à mesurer, pas à décréter.

**Condition de révision.** Un modèle sous licence permissive dépasse nettement Kokoro
en français.

---

## ADR-010 — Pas d'exécution de code arbitraire en V0

**Statut : RATIFIÉ**

**Contexte.** La question « quel sandbox » (WASM, Deno, microVM Firecracker, gVisor)
n'a de sens que si l'on a besoin d'exécuter du code arbitraire. Le besoin réel de la
V0 — mémoire, tâches, agenda, notes, fichiers, recherche — ne l'exige pas.

**Décision.** V0 n'exécute **aucun code généré**. Les outils sont typés, finis et
écrits par nous. La question du sandbox est explicitement reportée.

Si le besoin apparaît, l'ordre d'évaluation est fixé d'avance :
1. **Aucun code** — reformuler le besoin en outil typé (par défaut) ;
2. **WASM / Deno à permissions** — si le code est contraint et connu ;
3. **microVM** — uniquement pour du code arbitraire, non modifié, avec dépendances
   natives.

**Conséquences.** On supprime aujourd'hui la surface d'attaque la plus dangereuse, au
prix d'une flexibilité dont on n'a pas démontré le besoin.

**Condition de révision.** Trois cas d'usage réels et documentés qu'aucun outil typé
ne peut couvrir.

---

## ADR-011 — Intégrité des mises à jour : Sigstore + TUF

**Statut : RATIFIÉ**

**Contexte.** « Une mise à jour doit être signée et vérifiée » est facile à écrire et
difficile à faire correctement — notamment la rotation de clés et la résistance à la
compromission d'une clé unique.

**Décision.** Ne pas inventer de schéma de signature. **TUF** pour la distribution et
la rotation (signature M-parmi-N : la compromission d'une clé ne suffit pas à publier),
**Sigstore** pour la signature et la provenance des artefacts.

**Conséquences.** On assemble la cryptographie et on développe uniquement
l'orchestration (voir `07`). Une mise à jour non vérifiable est refusée, sans exception.

**Condition de révision.** Aucune sur le principe.

---

## ADR-012 — Event Ledger append-only, chaîné par hash

**Statut : RATIFIÉ**

**Contexte.** Le journal est la seule source de vérité quand le modèle affirme avoir
fait quelque chose. S'il est modifiable, la propriété « Jarvis répond depuis son
journal » ne vaut rien.

**Décision.** Table append-only ; chaque événement porte le hash du précédent. Aucun
`UPDATE` ni `DELETE` — interdit au niveau des permissions PostgreSQL, pas seulement
par convention applicative. La suppression d'une mémoire produit un événement
`MEMORY_DELETED` **sans recopier le contenu supprimé dans le journal**.

**Conséquences.** Une altération devient détectable. Le journal croît indéfiniment :
prévoir une politique d'archivage qui préserve la chaîne.

**Condition de révision.** Aucune.

---

## ADR-013 — iOS : App Intents, avec les contraintes assumées

**Statut : RATIFIÉ**

**Contexte.** SiriKit a été formellement déprécié à la WWDC 2026 ; App Intents est
désormais le seul chemin par lequel Siri appelle une application tierce. Trois
contraintes structurent le design et ne sont pas contournables :

- un App Intent dispose de **30 secondes** ; `LongRunningIntent` (iOS 27) étend la
  fenêtre en la matérialisant par une Live Activity ;
- `AudioRecordingIntent` **ne peut pas démarrer un enregistrement depuis un état
  d'arrière-plan froid** — la session doit avoir été initiée au premier plan ;
- l'indicateur système d'enregistrement reste visible, par conception.

**Décision.** Exposer les capacités Jarvis via App Intents (`AskJarvis`, `AddMemory`,
`CreateTask`, `GetBriefing`, `SearchMemory`, `StartPrivateMode`, `StopJarvis`). Siri
est une **porte d'entrée**, jamais le cerveau. Ne jamais concevoir une fonctionnalité
qui suppose une conversation Siri illimitée en arrière-plan.

**Conséquences.** L'expérience « Jarvis m'écoute en permanence » n'est pas réalisable
sur iOS dans les règles d'Apple, et nous ne la promettons pas. C'est aligné avec
l'interdiction d'écoute invisible (`03`).

**Condition de révision.** Évolution des capacités d'arrière-plan d'iOS.

---

## ADR-014 — Lunettes : adaptateur, jamais dépendance

**Statut : RATIFIÉ**

**Contexte.** Le Meta Wearables Device Access Toolkit donne accès à la caméra, à
l'audio et à l'affichage — **depuis une application mobile compagnon**. Le SDK ne
permet pas d'exécuter de la logique sur les lunettes elles-mêmes (contraintes de taille
et de poids), et l'accès aux invocations « Hey Meta » n'en fait pas partie. Un Mock
Device Kit permet de développer sans matériel.

**Décision.** Interfaces `VisionSource` / `AudioSource` / `AudioSink`. Implémentations :
caméra iPhone, Ray-Ban Meta, futures lunettes. Aucune dépendance de production aux
lunettes. Aucun contournement non documenté.

**Conséquences.** Il faut être honnête sur ce que sera l'expérience : **Jarvis tourne
sur le téléphone et utilise les lunettes comme micro, caméra et écran.** Ce n'est pas
« Jarvis dans les lunettes ». Le Mock Device Kit permet d'écrire l'adaptateur et ses
tests avant tout achat de matériel.

**Condition de révision.** Meta ouvre l'exécution embarquée ou les invocations vocales.

---

## ADR-015 — Home Assistant et n8n restent à la périphérie

**Statut : RATIFIÉ**

**Contexte.** Home Assistant est philosophiquement proche : son pipeline Assist tourne
entièrement en local (openWakeWord → STT → intentions → TTS Piper), relié par le
protocole Wyoming — une abstraction de transport audio déjà éprouvée. n8n est un
excellent intégrateur, mais sa Sustainable Use License **n'est pas une licence open
source OSI** : l'usage interne personnel est libre, la revente en service hébergé ne
l'est pas, et certaines fonctionnalités « Enterprise » sont hors licence communautaire.

**Décision.** Home Assistant est un **DeviceProvider** et, potentiellement, une source
d'inspiration pour l'abstraction audio (Wyoming). n8n, s'il est utilisé, reste une
couche d'intégration en bordure. **Aucune logique métier Jarvis ne réside dans l'un ou
l'autre.**

**Conséquences.** Leur indisponibilité dégrade une capacité, jamais le noyau. La
contrainte de licence n8n est documentée dans `04` et surveillée.

**Condition de révision.** Changement de licence n8n, ou dérive constatée de logique
métier vers ces couches (à vérifier à chaque revue d'architecture).

---

## ADR-016 — Stack d'implémentation du noyau

**Statut : RATIFIÉ** *(9 août 2026)*

**Contexte.** Aucun langage n'est imposé par le pack v0.1, et le dépôt est vide. Le
noyau est un service local de longue durée, orienté orchestration et E/S : le calcul
lourd vit dans des processus séparés (whisper.cpp, Ollama). Trois options crédibles :

| Option | Pour | Contre |
|---|---|---|
| **TypeScript / Node** | schémas stricts (Zod) alignés sur les contrats d'outils ; un seul langage noyau + UI web ; correspond à la compétence existante, donc coût de maintenance réel plus bas | processus long moins robuste que Go/Rust ; écosystème ML plus distant |
| **Python** | proximité maximale avec l'écosystème ML ; Pydantic | packaging et gestion de versions pénibles pour un service auto-mis-à-jour |
| **Go / Rust** | binaire unique, excellente tenue en service long, distribution simple | vitesse d'itération plus lente ; deuxième langage à maintenir avec Swift |

**Décision.** **TypeScript pour le noyau, Swift pour iOS**, les runtimes d'inférence
traités comme services hors processus.

Le facteur décisif n'est pas la performance brute — le noyau n'est pas le goulot — mais
le **coût de maintenance à long terme** pour un système personnel qui doit rester
compréhensible par une seule personne. C'est un objectif produit explicite (`00 §R6`),
pas une préférence.

**Conséquences.** L'ADR-003 devient d'autant plus important : les runtimes sont
consommés via HTTP/IPC, ce qui renforce naturellement leur remplaçabilité.

Trois conséquences à assumer dès la Phase 0, parce qu'elles ne se rattrapent pas plus
tard :

- **Typage aux frontières.** TypeScript ne valide rien à l'exécution. Tout ce qui entre
  dans le noyau — entrée utilisateur, sortie de modèle, réponse d'outil, ligne de base
  de données — passe par un schéma runtime (Zod). Un `as` sur une frontière est un
  défaut, pas un raccourci.
- **Tenue en service long.** C'est la faiblesse relative de Node face à Go ou Rust. Elle
  se compense par de la discipline opérationnelle : surveillance mémoire, redémarrage
  supervisé, et le fait que l'auto-maintenance a explicitement le droit de redémarrer un
  service (`07 §14`).
- **Distance à l'écosystème ML.** Assumée et neutralisée par construction : le calcul
  vit dans des processus séparés (whisper.cpp, Ollama), consommés via HTTP/IPC. Le
  noyau orchestre, il ne calcule pas.

**Condition de révision.** Si la tenue en service long devient un problème mesuré
(fuites mémoire non maîtrisées, redémarrages fréquents en usage réel), le noyau est
suffisamment contractuel pour qu'un portage progressif vers Go reste possible —
composant par composant, pas en réécriture.

---

## ADR-017 — Data-local-first + compute-adaptive

**Statut : RATIFIÉ** *(9 août 2026)* — remplace la formulation « tout local »

**Contexte.** OpenJarvis (arXiv 2605.17172) mesure ce que coûte la substitution
naïve d'un modèle frontière par un modèle local générique : **25 à 39 points**
de précision sur des tâches d'IA personnelle. Une pile décomposée revient à
**3,2 points** pour un coût marginal ~**800×** inférieur.

**Décision.** Les **données** restent locales par défaut ; le **calcul** s'adapte.
Le cloud reste coupable globalement, et une donnée RED ne sort jamais. Quand
l'escalade a lieu, le cloud reçoit le minimum nécessaire — passages pertinents,
version anonymisée, résumé local — jamais le document entier par défaut.

**Conséquences.** L'objectif économique devient « 0 € marginal sur 80–95 % des
interactions », mesurable, au lieu de « 0 € », qui masquait une dégradation.

**Condition de révision.** Lecture intégrale de la section expérimentale du
papier (`10 §5.3`) : si la méthodologie ne tient pas, revenir à la formulation
d'origine.

---

## ADR-018 — Deux axes de classification mémoire

**Statut : RATIFIÉ** *(9 août 2026)*

**Contexte.** `provenance` conflait deux questions distinctes : « cette valeur
peut-elle alimenter un paramètre sensible ? » (sécurité) et « quel crédit
mérite cette information ? » (épistémologie). Conséquence concrète : « Julien
préfère le matin » déclaré et le même énoncé déduit étaient indistinguables une
fois écrits.

**Décision.** Deux colonnes, deux rôles :

- `provenance` — axe de **sécurité**, consommé par le Policy Gate. Inchangé.
- `source_type` — axe **épistémique** : `USER_EXPLICIT`, `USER_INFERRED`,
  `MODEL_INFERRED`, `TOOL_VERIFIED`, `EXTERNAL_SOURCE`, `SYSTEM`.

La provenance est **dérivée** de l'origine, jamais fournie : déclarer une source
externe avec une provenance de confiance devient impossible, et la base impose
la même cohérence (`source_matches_provenance`).

Deux plafonds de confiance indépendants — par crédit et par origine — dont on
applique le minimum.

**Conséquences.** Le Guard peut désormais refuser à un proposant de s'attribuer
l'explicitness : sans confirmation, `USER_EXPLICIT` redevient `USER_INFERRED`.

**Condition de révision.** Aucune. Cette décision devait être prise avant la
première donnée réelle ; elle ne se rattrape pas.

---

## ADR-019 — Toute mutation capture de quoi être annulée

**Statut : RATIFIÉ** *(9 août 2026)*

**Contexte.** Le contrat d'outil décrivait `rollback` comme une **chaîne de
description**, pas comme du code. La réversibilité était documentée, pas
outillée. Or annuler exige d'avoir capturé l'état antérieur **au moment de
l'écriture** : une action exécutée sans capture est définitivement non annulable.

**Décision.** Deux mécaniques, choisies selon la nature de la mutation :

- **`INVERSE_OPERATION`** — création. On stocke l'appel qui défait. Aucune
  donnée métier n'est copiée.
- **`STATE_RESTORE`** — modification. On copie les valeurs antérieures, avec
  leur propre classification de confidentialité.
- **`NOT_UNDOABLE`** — déclaré explicitement, jamais par omission.

Les instantanés **expirent** (7 jours) : un instantané n'est pas un archivage.

**Conséquences.** L'interface « annule la dernière action » peut arriver plus
tard sans rien coûter. La capture, elle, est le coût irrécupérable.

**Condition de révision.** Aucune sur le principe.

---

## ADR-020 — Memory Inbox : une proposition non confirmée attend

**Statut : RATIFIÉ** *(9 août 2026)*

**Contexte.** Le Guard refusait une préférence non confirmée — et la
proposition était **perdue**. Jarvis ne pouvait jamais dire « j'ai remarqué
ceci, dois-je le retenir ? ».

**Décision.** Table `memory_candidates`. Une `PREFERENCE` ou une `RULE` non
confirmée y est déposée plutôt que refusée. Déduplication sur les candidats en
attente ; expiration à 30 jours.

**Conséquences.** L'interface de confirmation viendra plus tard. La file, non :
sans elle, chaque mois d'usage serait un mois d'apprentissage non rattrapable.

**Condition de révision.** Si la file se révèle ignorée en usage réel, revoir la
présentation — pas le mécanisme.

---

## ADR-021 — Registre des dérivés

**Statut : RATIFIÉ** *(9 août 2026)*

**Contexte.** « Oublie ça » doit supprimer la mémoire **et tous ses dérivés**.
Aujourd'hui l'embedding vit sur la même ligne, donc il disparaît en cascade —
ce ne sera plus vrai au premier index externe ou au premier cache.

**Décision.** Tout artefact dérivé est enregistré à sa création, avec son
emplacement et le fait qu'il disparaisse ou non en cascade.

**Conséquences.** La garantie de suppression reste vraie quand l'architecture
s'étendra, au lieu qu'on découvre alors qu'on ne sait plus où sont les copies.

**Condition de révision.** Aucune.

---

## ADR-022 — OpenClaw n'est pas notre Tool Bus

**Statut : RATIFIÉ** *(9 août 2026)*

**Contexte.** OpenClaw est le projet open source le plus proche de « assistant
personnel qui agit réellement » : passerelle auto-hébergée, multi-canaux,
multi-modèles, très forte adoption. La question de l'adopter comme couche
d'outils s'est posée sérieusement.

**Décision. Non.** Deux faits, vérifiés en `10 §1.4` :

- l'accès **shell** est une fonctionnalité centrale — invariant **S2** violé ;
- il route vers le cloud par défaut, et le papier OpenJarvis le cite nommément
  comme pile envoyant des données locales sensibles au cloud — invariant **I5**
  violé.

On ne pose pas une politique au-dessus d'une couche dont la valeur principale
est de ne pas en avoir : le Policy Engine deviendrait décoratif.

**Conséquences.** Ses **connecteurs de canaux** (WhatsApp, Signal, iMessage)
restent intéressants et pourront devenir un `MessagingProvider` **derrière**
notre Tool Gateway. À rouvrir en Phase 3+, pas avant.

**Condition de révision.** Si OpenClaw introduit un mode sans exécution shell et
sans routage cloud par défaut, réévaluer le connecteur — jamais le bus.

---

## ADR-023 — Passerelle web locale authentifiée, plutôt qu'une application native

**Statut : RATIFIÉ** *(10 août 2026)*

**Contexte.** Jarvis n'était joignable que depuis le clavier de la machine qui
l'héberge. L'usage réel — noter une idée, ajouter une tâche, interroger la
mémoire — arrive rarement devant ce clavier. Trois voies existaient :

| Voie | Délai | Ce qu'elle coûte |
|---|---|---|
| Application iOS native (Swift, ADR-016) | semaines | compte développeur, cycle de signature, une seconde implémentation de la boucle |
| Tunnel vers un service tiers (ngrok, Tailscale Funnel…) | minutes | expose Jarvis hors du domicile, dépendance à un tiers — **I5** et §30 |
| Passerelle HTTP sur le réseau local, authentifiée | heures | élargit la surface d'attaque au Wi-Fi domestique |

**Décision.** La troisième. Une passerelle HTTP servie sur **une adresse privée
nommée**, protégée par un jeton obligatoire, sans aucune ressource distante.
L'application iOS reste la cible (ADR-016) ; elle parlera à cette même API.

**Ce que la décision change au modèle de menace — et ce qui l'encadre.**

Ouvrir Jarvis au Wi-Fi domestique est un élargissement réel : la mémoire
personnelle devient joignable par tout appareil du réseau, y compris un objet
connecté compromis qui ne demande la permission de personne pour scanner un
port. Cinq contraintes, toutes vérifiées par des tests :

1. **Jeton obligatoire sur `/api/*`**, comparé en temps constant. 256 bits,
   généré par `jarvis:setup`, jamais dans le dépôt.
2. **Verrouillage par adresse** après 5 échecs, une minute. Il tient même face
   au bon jeton : une force brute qui aurait trouvé au 6ᵉ essai est arrêtée.
3. **Écoute sur une adresse privée nommée, jamais sur `0.0.0.0`.** Le risque
   n'est pas l'inventaire du moment, c'est le VPN ou le partage de connexion
   qui apparaît plus tard sans nouvelle décision. L'ouverture explicite reste
   possible (`JARVIS_WEB_ALLOW_PUBLIC=yes`) parce qu'un garde-fou qu'on ne peut
   pas lever se contourne en le retirant du code — mais elle est refusée par
   défaut et signalée à chaque démarrage.
4. **Refus de démarrer si la chaîne d'audit est rompue.** Servir la mémoire sur
   le réseau alors qu'on ne peut plus dire ce qui lui est arrivé, c'est perdre
   la seule chose qui rend l'incident analysable.
5. **Aucune ressource distante dans la page**, ce qui rend tenable une CSP
   `default-src 'self'` : une page qui ne peut charger que ses propres
   ressources ne peut rien exfiltrer, même injectée.

**Deux choix de conception qui portent la sécurité.**

*Le jeton voyage dans le fragment d'URL (`#t=…`), pas dans la requête.* Un
fragment n'est jamais transmis au serveur : il n'entre ni dans les journaux
d'accès, ni dans l'en-tête `Referer`, ni dans l'historique d'un proxy. Le
navigateur le range une fois dans `localStorage`, retire le fragment de la barre
d'adresse, puis l'envoie en en-tête `Authorization` à chaque appel.

*Aucun cookie, donc aucun CSRF.* Un navigateur n'attache pas spontanément un
en-tête `Authorization` à une requête déclenchée par un autre site. Le vecteur
n'existe pas — ce n'est pas une mitigation, c'est une absence.

**Ce que la passerelle ne fait pas.** Elle n'exécute rien elle-même. Elle appelle
le même `Assistant` que le CLI, donc le même Policy Gate, le même Memory Guard,
le même Verification Engine et le même journal. Un chemin d'exécution propre au
web serait un chemin où une barrière peut manquer ; il n'y en a pas.

**Une propriété exploitée : la confirmation est sans état serveur.** L'Intent
Engine étant déterministe (Tier 0, règles), rejouer le même texte produit la
même proposition. Le client renvoie donc le texte d'origine avec la clé
d'opération, et Jarvis redérive puis exécute. Aucune session de confirmation à
stocker, donc aucune à détourner — et le bouton « Confirmer » reste sûr sur un
téléphone dont le Wi-Fi vacille, par idempotence (ADR-013).

**Conséquences.** `pnpm jarvis:web`. Un `JARVIS_WEB_TOKEN` dans `.env`.
`src/core/assistant.ts` et `src/apps/runtime.ts` extraits pour que CLI et web
partagent la boucle plutôt que de la dupliquer.

**Condition de révision.** Quand l'application iOS existe, la page web reste
utile (Android, ordinateur d'appoint) mais cesse d'être le chemin principal. Si
l'accès hors domicile devient nécessaire, ce ne sera ni un tunnel tiers ni une
ouverture de port : ce sera un ADR distinct, avec son propre modèle de menace.

---

## ADR-024 — Une IA propose, elle ne s'élève jamais au rang d'autorité

**Statut : RATIFIÉ** *(10 août 2026)*

**Contexte.** L'audit `docs/11` a trouvé un défaut que la relecture ne montrait
pas : `provenanceOf('MODEL_INFERRED')` rendait `'SYSTEM'`, c'est-à-dire la même
provenance que ce que le **noyau** produit lui-même. `isUntrusted('SYSTEM')`
étant faux, une valeur déduite par un modèle pouvait alimenter un paramètre
sensible **sans confirmation**.

Le défaut était invisible pour deux raisons, et les deux méritent d'être notées :

- l'axe épistémique, lui, fonctionnait (`SOURCE_CEILING.MODEL_INFERRED = 0.7`).
  Un lecteur pressé voyait la déduction correctement dégradée et concluait que
  tout allait bien — sur le mauvais axe ;
- aucun modèle ne tourne encore. Le défaut n'avait donc **aucune conséquence
  observable**, et aucun test ne pouvait le révéler par l'usage.

**Décision.** Le principe est verrouillé, au-delà du seul correctif :

> **Une IA peut proposer. Elle ne peut jamais s'auto-élever au rang
> d'autorité, ni augmenter elle-même son niveau de confiance ou ses
> permissions.**

Conséquences immédiates, toutes appliquées :

1. Nouvelle provenance `MODEL_OUTPUT`, membre de `UNTRUSTED_PROVENANCES` ;
2. `MODEL_INFERRED → MODEL_OUTPUT`, jamais `SYSTEM` ;
3. `SYSTEM` redevient ce qu'il n'aurait jamais dû cesser d'être : **ce que le
   noyau a produit lui-même**, et rien d'autre ;
4. la base impose la correspondance
   (`(source_type = 'MODEL_INFERRED') = (provenance = 'MODEL_OUTPUT')`), de
   sorte qu'aucun chemin applicatif ne puisse blanchir une déduction.

**Pourquoi une provenance distincte plutôt que ranger dans
`EXTERNAL_UNTRUSTED`.** Les deux sont non fiables, mais pas pour la même
raison, et confondre les deux serait irréversible :

| Provenance | Pourquoi elle n'est pas fiable |
|---|---|
| `EXTERNAL_UNTRUSTED` | un tiers a écrit ce texte — **il peut être hostile** |
| `MODEL_OUTPUT` | personne n'est hostile — **rien ne garantit l'exactitude** |

On ne peut pas reconstruire après coup une distinction qu'on n'a pas écrite.

**Portée : tous les modèles, présents et futurs.** GPT, Claude, Gemini, Llama,
Qwen, Mistral ou un modèle local produisent tous la même chose : une
`Intent`, un `Plan`, un `ToolCall`. C'est le noyau qui décide si la proposition
est acceptable. Le modèle est donc remplaçable — et c'est aussi la meilleure
protection contre l'enfermement fournisseur.

**Ce que cette décision n'autorise pas.** Aucun réglage, aucune configuration,
aucune règle apprise ne peut faire passer `MODEL_OUTPUT` du côté fiable. La
hiérarchie de `03 §5` s'applique intégralement : une préférence n'assouplit
jamais une règle de sécurité.

**Condition de révision.** Aucune. Si un jour un modèle doit voir sa sortie
traitée différemment, ce sera par une **vérification indépendante** de cette
sortie — un outil qui relit l'état réel, comme le fait déjà le Verification
Engine — jamais par une élévation de sa provenance.

---

## ADR-025 — Architecture de vérité : six étapes, et une observation à la fin

**Statut : RATIFIÉ** *(10 août 2026)* — **deux arbitrages ouverts, §A et §B.**

**Contexte.** Jusqu'ici, la chaîne était décrite en quatre temps :
`LLM → proposition → Policy Engine → outil → exécution → vérification → journal`.
Elle décrit correctement *qui décide*, mais pas *ce que Jarvis sait*. Or trois
énoncés que le langage courant confond sont techniquement différents :

> « J'ai envoyé le mail. »
> « J'ai demandé à Gmail d'envoyer le mail. »
> « Gmail confirme que le mail est parti. »

C'est précisément là que les agents deviennent dangereux : ils prononcent le
premier en n'ayant fait que le deuxième.

**Décision.** Le pipeline devient une loi fondamentale à six étapes :

```text
SOURCE          d'où vient l'information brute
   ↓
EVIDENCE        ce qui a été réellement observé, avec sa provenance
   ↓
INTERPRETATION  ce qu'on en déduit — jamais confondu avec l'evidence
   ↓
DECISION        ce que le système décide de faire — le Policy Gate tranche ici
   ↓
ACTION          ce qui a été TENTÉ, avec sa clé d'opération
   ↓
OBSERVATION     ce qui a été CONSTATÉ après coup, indépendamment de l'outil
```

Les cinq états doivent rester techniquement distinguables jusque dans le
journal :

| Étape | Exemple concret | Ce qu'on ne doit jamais en conclure |
|---|---|---|
| `EVIDENCE` | « le document indique 4 130 € » | que c'est le bon document |
| `INTERPRETATION` | « cela ressemble à deux mois de salaire » | que c'en est |
| `DECISION` | « je propose de vérifier les bulletins » | que la vérification a eu lieu |
| `ACTION` | « j'ai lancé la recherche » | qu'elle a abouti |
| `OBSERVATION` | « le système externe confirme 2 résultats » | rien de plus que 2 résultats |

**Ce que le noyau possède déjà, et qu'il faut nommer plutôt que reconstruire.**
Une partie d'`OBSERVATION` existe : le Verification Engine distingue
`READ_BACK` (relecture indépendante) de `PROVIDER_PROOF` (parole du
fournisseur), et `confirmed()` exige une preuve. C'est exactement la
distinction « l'outil a dit » / « j'ai constaté ». Trois manques subsistent :

1. **`PARTIAL` n'existe pas.** Aucune façon d'exprimer « 3 destinataires sur
   5 ». Ce statut doit exister **avant** le premier outil capable de réussir à
   moitié — après, la migration coûtera cher.
2. **L'observation n'a pas d'identité.** On sait *qu'*une relecture a eu lieu ;
   on ne sait ni quand, ni contre quelle source, ni avec quel identifiant de
   preuve. Une observation sans identité n'est pas rejouable.
3. **`INTERPRETATION` n'est nulle part.** Aujourd'hui l'Intent Engine passe
   directement de la phrase à l'appel d'outil. C'est acceptable au Tier 0
   (règles déterministes, l'interprétation est le motif lui-même) et le
   deviendra beaucoup moins dès qu'un modèle s'en mêlera.

### §A — Arbitrage ouvert : les états de connaissance ne forment pas une énumération

Le brief demande sept états :
`KNOWN / UNKNOWN / CONFLICTING / STALE / UNVERIFIED / NOT_AUTHORIZED / OUT_OF_SCOPE`.

**Je propose de ne pas en faire une seule énumération**, et voici pourquoi : ils
ne répondent pas à la même question, et les mettre sur un même axe produira des
cas indécidables dès la première semaine d'usage. Que vaut une information à la
fois `CONFLICTING` et `STALE` ? Le code devra choisir, et choisira mal.

Décomposition proposée — **trois axes indépendants** :

```text
VERDICT      KNOWN │ UNKNOWN │ CONFLICTING        ← mutuellement exclusifs
QUALIFIERS   STALE │ UNVERIFIED │ LOW_CONFIDENCE  ← qualifient un KNOWN
COVERAGE     NOT_AUTHORIZED │ OUT_OF_SCOPE │      ← disent ce qui n'a PAS été
             UNREACHABLE                            consulté, et pourquoi
```

L'axe `COVERAGE` est le prolongement direct du `scope` posé au Sprint 1. Il
répond à la question que l'utilisateur ne pense pas à poser :

> « Sur quelles données as-tu réellement travaillé ? »

Et il s'applique **aussi à un `KNOWN`** : « j'ai trouvé un devis à 4 800 € dans
ta mémoire ; je n'ai pas consulté tes emails, tu ne m'y as pas autorisé » est
une réponse plus honnête que « le devis est à 4 800 € ».

Exemples, avec les trois axes :

| Réponse de Jarvis | Verdict | Qualifiers | Coverage |
|---|---|---|---|
| « Devis de Pierre du 12 juillet : 4 800 € » | `KNOWN` | — | mémoire seule |
| « J'ai 4 800 € et 5 200 €, sans savoir lequel est le dernier » | `CONFLICTING` | — | mémoire seule |
| « 4 800 €, mais l'information date de 8 mois » | `KNOWN` | `STALE` | mémoire seule |
| « Aucun devis dans ce à quoi j'ai accès » | `UNKNOWN` | — | `NOT_AUTHORIZED` (emails) |
| « Je ne sais pas chercher dans tes documents » | `UNKNOWN` | — | `OUT_OF_SCOPE` |

**Issue :** validée. Les trois axes sont définis dans `src/core/types/domain.ts`.
L'axe 2 a été retenu dans la forme du brief — `VERIFIED / UNVERIFIED / STALE`,
trois valeurs exclusives — plutôt que dans la mienne : une information ne peut
pas être à la fois fraîchement vérifiée et périmée.

### §B — Arbitré et CORRIGÉ : une opération est enregistrée AVANT d'être tentée
*(validé le 10 août 2026, implémenté en ADR-027)*

**Défaut trouvé en écrivant cet ADR**, et il appartient au domaine
`ACTION → OBSERVATION`.

`src/core/tools/gateway.ts` vérifie l'idempotence (ligne 342), exécute
(ligne 427), puis enregistre l'opération (ligne 479). L'écriture dans
`tool_operations` a donc lieu **après** l'exécution.

Conséquence : si le processus meurt, si le réseau tombe ou si l'outil expire
**pendant** l'exécution, aucune ligne n'existe. Un rejeu avec la même clé
d'opération ne trouve rien — et **réexécute**.

Pour les cinq outils actuels, l'effet est nul : ils écrivent dans PostgreSQL,
de façon transactionnelle. Pour un outil d'envoi d'email, c'est un **double
envoi**. C'est exactement la ligne « timeout APRÈS action → ne pas réessayer
aveuglément » de la matrice adversariale.

Correction proposée — **journal d'intention** (write-ahead) :

```text
        AUJOURD'HUI                        PROPOSÉ
   vérifier l'idempotence            vérifier l'idempotence
   exécuter                     →    enregistrer ATTEMPTED   ← avant
   enregistrer                       exécuter
                                     enregistrer l'observation
```

Un rejeu trouvant une ligne `ATTEMPTED` sans observation sait qu'il est dans le
cas le plus délicat : *l'action a peut-être eu lieu*. Il ne réexécute pas, il
**relit l'état réel** — ce que le Gateway sait déjà faire — et rend `UNKNOWN`
si la relecture ne tranche pas.

**Issue :** validée en P0, gel levé pour cette seule correction. Implémentée et
éprouvée par sept scénarios de crash réels — voir **ADR-027** et `docs/12 §5`.

**Conséquences.** Nouveau document `docs/12`. `PARTIAL` et l'identité
d'observation entrent dans le périmètre du Sprint 2 ; le journal d'intention
attend un arbitrage.

**Condition de révision.** Si un jour une étape supplémentaire s'impose entre
`DECISION` et `ACTION` — une planification multi-outils —, elle s'insère sans
casser les autres : chaque étape ne connaît que celle qui la précède.

---

## ADR-026 — Mémoire bitemporelle : l'ancienne information n'est pas fausse

**Statut : RATIFIÉ** *(10 août 2026)* — **un arbitrage ouvert, §A.**

**Contexte.** L'audit `docs/11` a établi qu'aucune gestion de contradiction
n'existe : deux informations incompatibles cohabitent comme deux `FACT` de même
confiance. Le réflexe serait d'ajouter `superseded_by` et de considérer
l'ancienne comme périmée.

**C'est le mauvais modèle**, et le brief a raison de s'en méfier :

> « Le mariage est le 12 septembre » n'est pas devenu *faux*.
> C'était *vrai jusqu'au 18 juin*.

La différence n'est pas philosophique. Elle décide de ce que Jarvis peut
répondre dans trois ans à :

> « Pourquoi pensais-tu que le mariage était le 12 septembre ? »
> — « Parce que c'est la date que tu m'as donnée le 4 juin. Elle a été
> remplacée le 18 juin. »

**Décision.** La mémoire devient **bitemporelle**. Ce n'est pas une invention :
c'est un modèle établi (temps de validité vs temps de transaction, normalisé
par SQL:2011), et le nommer permet d'en reprendre les pièges connus plutôt que
de les redécouvrir.

Deux axes de temps, indépendants :

| Axe | Colonnes | Répond à |
|---|---|---|
| **Temps de validité** | `valid_from`, `valid_until` | *quand est-ce vrai dans le monde ?* |
| **Temps de transaction** | `recorded_at`, `superseded_at` | *quand l'ai-je su ?* |

Un fait n'est jamais modifié ni supprimé : il est **clos** (`valid_until`
renseigné) et un nouveau est écrit. C'est la même discipline que l'Event
Ledger, appliquée à la mémoire.

```text
Projet mariage — date

  recorded_at 4 juin    valid_from 4 juin    valid_until 18 juin   12 septembre
  recorded_at 18 juin   valid_from 18 juin   valid_until ∞         19 septembre
```

Quatre questions deviennent alors répondables, et aucune ne l'est aujourd'hui :

- *que sais-tu ?* → l'état courant ;
- *que savais-tu le 10 juin ?* → l'état tel que connu à cette date ;
- *depuis quand le sais-tu ?* → `recorded_at` ;
- *qu'est-ce qui a changé cette semaine ?* → le différentiel de transaction.

### §A — Arbitrage ouvert : trois façons de dire la même chose se contrediront

Le brief propose le jeu de champs suivant :

```text
value · valid_from · valid_until · recorded_at · source · confidence
      · superseded_by · status
```

**Je propose de retirer `status`, et de dériver `superseded_by` au lieu de le
stocker.** Raison : `valid_until`, `superseded_by` et `status` encodent tous
les trois « ce fait n'est plus le courant ». Trois écritures pour une vérité,
c'est trois occasions de diverger — et le jour où elles divergeront, aucune des
trois ne fera autorité.

Ce que je propose de conserver :

```text
value          la valeur
valid_from     ┐ temps de validité
valid_until    ┘ NULL = toujours vrai — c'est LE seul marqueur de « courant »
recorded_at    ┐ temps de transaction
superseded_at  ┘ NULL = jamais remplacé
source         la provenance (ADR-024)
confidence     plafonnée par origine
subject/predicate  ce sur quoi porte le fait — nécessaire pour DÉTECTER le conflit
```

`status` se lit : `valid_until IS NULL`. `superseded_by` se retrouve par
requête sur `(subject, predicate)`.

**La contrepartie, qu'il faut assumer maintenant :** la bitemporalité rend
**toute** requête plus difficile. Chaque `SELECT` doit désormais dire « à quelle
date ? », sur deux axes. C'est une taxe permanente sur tout le code de lecture.

Atténuation retenue : une vue `memories_current` (`valid_until IS NULL AND
superseded_at IS NULL`) que le code ordinaire interroge sans y penser. Seules
les questions historiques descendent au modèle complet. Sans cette vue, la
bitemporalité se paiera à chaque ligne de code écrite pendant trois ans.

**Ce que cette décision ne résout pas.** Détecter qu'une information *contredit*
une autre est un problème distinct, et beaucoup plus difficile, que savoir la
représenter. Le modèle bitemporel rend la contradiction *exprimable* ; il ne la
détecte pas. La détection exige un `(subject, predicate)` structuré — donc une
extraction — et c'est le vrai chantier du Sprint 2.

**Issue :** validé le 10 août 2026, avec une contrainte ajoutée par le
propriétaire : *la bitemporalité ne doit pas devenir une complexité permanente
pour le reste du code*. La vue `memories_current` n'est donc pas facultative.

**Conséquences.** Migration à écrire (non écrite : gel). `docs/12 §3` en donne
la forme et les tests exigés.

**Condition de révision.** Si le coût de lecture se révèle insoutenable à
l'usage, on peut dénormaliser un indicateur `is_current` — **calculé par
trigger**, jamais écrit par l'applicatif. Jamais l'inverse.

---

## ADR-027 — Journal d'intention : l'absence de trace doit être une information

**Statut : RATIFIÉ et IMPLÉMENTÉ** *(10 août 2026)*

**Contexte.** Le Tool Gateway vérifiait l'idempotence, exécutait, **puis**
enregistrait l'opération. Un arrêt pendant l'exécution ne laissait donc aucune
ligne — et un rejeu avec la même clé, ne trouvant rien, **réexécutait**.

Nul pour les cinq outils actuels : ils écrivent dans PostgreSQL, de façon
transactionnelle. **Double envoi** pour un outil d'email. C'est la différence
entre un agent conversationnel et un système capable d'agir dans le monde.

**Décision.** Toute action est inscrite **avant** d'être tentée.

```text
PLANNED                  décidée, rien de tenté
    ↓
COMMITTED_TO_EXECUTION   barrière de durabilité, appel imminent
    ↓
EXECUTING                l'appel est parti — un effet est POSSIBLE
    ↓
SUCCEEDED │ FAILED │ UNKNOWN
```

La règle qui gouverne l'ensemble :

> **Le système ne doit jamais déduire « non exécuté » de « aucune trace ».**

Elle n'est tenable *que parce que* la trace précède tout effet externe. C'est
une inversion de dépendance : l'absence de ligne cesse d'être un pari pour
devenir une information — mais seulement au prix de l'ordre d'écriture.

### Le biais est délibéré : vers `UNKNOWN`, jamais vers la réexécution

Un arrêt entre `COMMITTED_TO_EXECUTION` et `EXECUTING` laisse un état d'où l'on
sait qu'aucun appel n'est parti. Un arrêt après laisse `EXECUTING` : on ne sait
pas. Et si l'écriture `EXECUTING` aboutit alors que le processus meurt juste
avant l'appel, on conclura `UNKNOWN` pour une action qui n'a jamais eu lieu.

**C'est voulu.** Un doute coûte une question à l'utilisateur ; une réexécution
coûte un second virement.

### La reprise cherche à savoir, elle ne rejoue jamais

Depuis `EXECUTING` ou `UNKNOWN`, trois issues :

| Ce que dit le fournisseur | Conduite |
|---|---|
| `EFFECT_CONFIRMED` | `CONFIRMED`, **sans réexécution** |
| `NO_EFFECT` | seul chemin qui rouvre l'exécution — exige une affirmation **positive** d'absence |
| `INCONCLUSIVE` — ou aucune vérification possible | `UNKNOWN`, et Jarvis le dit |

Le contrat d'outil déclare donc `attemptVerification: 'NONE' | 'BY_OPERATION_KEY'`.
Promettre `BY_OPERATION_KEY` sans fournir `verifyAttempt` est refusé **à
l'enregistrement** : un outil qui prétend savoir vérifier sans savoir le faire
est pire qu'un outil qui l'avoue — la reprise croirait pouvoir trancher.

**Les cinq outils du noyau déclarent `NONE`.** C'est honnête et c'est une dette
nommée : les rendre vérifiables suppose d'écrire la clé d'opération dans la
ressource créée.

### Aucun rejeu automatique

`maxRetries` figure dans les contrats et n'est **consommé par personne**. C'est
délibéré tant que la sémantique d'`UNKNOWN` n'est pas éprouvée en usage réel.
Un test structurel interdit d'en introduire un par inadvertance.

**Vérification.** Sept points d'arrêt, chacun dans un processus enfant réellement
tué, chacun suivi d'un **vrai redémarrage** qui rejoue la même clé. Aucun
scénario ne produit deux effets ; le compteur de tentatives ne dépasse jamais 1.
Voir `docs/12 §4`.

**Condition de révision.** Si un fournisseur impose une sémantique de reprise
incompatible, elle s'exprime dans son adaptateur via `verifyAttempt` — jamais en
assouplissant le Gateway.

---

## ADR-028 — Un effet externe se déclare, il ne se devine pas

**Statut :** accepté (Foundation 3).
**Contexte :** `docs/16 §1` avait spécifié un champ `effect` sans le mettre en
vigueur. Le banc de défaillance a montré ce que son absence coûtait.

Le Tool Gateway concluait `FAILED` de toute erreur d'exécution qui n'était pas
un timeout. Autrement dit, il **affirmait l'absence d'effet sur la parole du
fournisseur**. Le banc met en scène le cas qui l'invalide : un fournisseur qui
produit l'effet, puis répond `500`.

**Décision.** Tout outil déclare :

```ts
effect: 'LOCAL_TRANSACTIONAL' | 'EXTERNAL'
```

`LOCAL_TRANSACTIONAL` signifie que l'effet est écrit dans la même base que le
journal d'intention. Une erreur y entraîne un `ROLLBACK`, et l'absence d'effet
est garantie **par PostgreSQL, pas par une déclaration**. `FAILED` reste alors
légitime.

`EXTERNAL` signifie que l'effet échappe à nos transactions. Une erreur ne prouve
rien : le seul état honnête est `UNKNOWN`.

**Arbitrage.** On aurait pu déduire ce champ de `networkRequired`. Refusé :
ce sont deux questions différentes. Un outil d'écriture de fichier local est
`networkRequired: false` et pourtant non transactionnel. Faire porter une
décision de vérité par un champ qui parle de réseau aurait fonctionné jusqu'au
premier outil de ce genre.

**Ce que cette décision NE fait pas.** Elle n'interdit pas encore d'enregistrer
un outil `EXTERNAL` avec `attemptVerification: 'NONE'`. `docs/16 §3` recommande
cette garde ; elle exclurait des familles entières d'outils légitimes et relève
d'un choix produit, pas d'une correction. Elle reste ouverte.

**Condition de révision.** Si une troisième catégorie apparaît — un effet
externe mais transactionnel, via un protocole à deux phases — elle s'ajoute
comme valeur, jamais comme exception dans le Gateway.

---

## ADR-029 — Le journal d'intention protège du temps ; il fallait aussi le protéger de l'espace

**Statut :** accepté (Foundation 3).
**Contexte :** ADR-027 a rendu Jarvis correct face au TEMPS — un crash, un
redémarrage, un rejeu plus tard. `docs/17 §6` nommait la concurrence comme « le
plus probable prochain endroit où une faille se cache ». Elle s'y cachait.

### Ce que le banc a mesuré

Sur une même clé d'opération, avec un outil à effet réellement externe :

| Appels simultanés | Effets produits |
|---|---|
| 2 | 1 |
| 10 | 1 |
| **100** | **20** |
| 1 000 | 1 |

Le défaut est **dépendant de la charge**. Un banc qui n'aurait éprouvé que
1 000 appels aurait conclu que tout allait bien.

### La cause

Trois écritures d'état étaient des `UPDATE` **inconditionnels**, et une lecture
précédait une insertion :

```text
SELECT … WHERE operation_id = $1       ← N appelants lisent « rien »
INSERT …                               ← N appelants concluent « je suis le premier »
UPDATE … SET state='COMMITTED'         ← aucune garde
UPDATE … SET state='EXECUTING'         ← aucune garde
```

Correct dans le temps, inopérant dans l'espace.

### La décision

Toute transition d'état d'une opération est un **compare-and-swap en base** :

```sql
INSERT … ON CONFLICT (operation_id) DO NOTHING

UPDATE tool_operations SET state = 'COMMITTED_TO_EXECUTION'
 WHERE operation_id = $1 AND state = 'PLANNED'

UPDATE tool_operations SET state = 'EXECUTING', attempts = attempts + 1
 WHERE operation_id = $1 AND state = 'COMMITTED_TO_EXECUTION'
```

`rowCount = 0` signifie « un autre appelant a pris l'engagement ». Cet appelant
reçoit `OPERATION_IN_FLIGHT` — une famille d'erreur distincte de `CONFLICT`,
parce que ce n'est pas un défaut d'appelant et que **rien n'a été tenté**.

### Le cas qui a exigé un numéro de version

Le retour à `PLANNED` du chemin `NO_EFFECT` était lui aussi inconditionnel. Sur
des reprises concurrentes, il pouvait **ramener en arrière une opération
qu'une autre reprise venait d'engager**, rouvrant l'exécution d'un appel déjà
en vol.

Une garde d'état ne suffit pas ici : `EXECUTING` ne dit pas si l'exécutant est
mort ou bien vivant. `attempts` sert donc de numéro de version, et la reprise
ne rembobine que ce qu'elle a elle-même observé :

```sql
UPDATE … SET state = 'PLANNED'
 WHERE operation_id = $1
   AND state IN ('EXECUTING','UNKNOWN')
   AND attempts = <valeur lue au départ>
```

**Arbitrage.** Un verrou en mémoire aurait été plus simple et aurait passé le
test intra-processus. Il se serait effondré au premier second processus — un
worker, un cron, le CLI et l'application mobile ouverts ensemble. Le goulot doit
être là où l'état est partagé : en base.

Un `SELECT … FOR UPDATE` tenu pendant l'appel aurait aussi fonctionné, au prix
de garder une connexion PostgreSQL ouverte pendant un appel réseau de 30 s.
Refusé.

**Conséquence acceptée.** Sur N appels simultanés, un seul agit et N−1
reçoivent un refus explicite. C'est le comportement des API à clé
d'idempotence, et c'est `FAIL CLOSED` appliqué à la concurrence : on ne sait
pas, donc on n'agit pas, et on le dit.

**Ce que cette décision ne couvre pas.** Elle protège une CLÉ. Un appelant qui
frappe une nouvelle clé pour « réessayer ailleurs » n'effectue pas un repli : il
lance une seconde action, et le noyau ne peut pas le deviner. C'est l'invariant
que Foundation 4 doit rendre structurel — voir `docs/19 §3`.

**Condition de révision.** Si Jarvis devient multi-machines, la garantie repose
toujours sur PostgreSQL comme point de sérialisation unique. Le jour où la base
serait répliquée en écriture, cet ADR doit être rouvert avant tout autre travail.

---

## ADR-030 — Hiérarchie de preuve : `FAILED` doit se mériter autant que `CONFIRMED`

**Statut :** accepté (Foundation 4).
**Contexte :** `docs/18 §5` avait nommé le fournisseur asynchrone comme dette.
Elle était plus grave qu'une dette : elle invalidait le sens de `FAILED`.

```text
Jarvis → fournisseur → ACK → Jarvis relit → « rien » → FAILED
                                                ↓
                                    300 ms plus tard : l'effet arrive
```

### La dissymétrie corrigée

`confirmed()` exigeait une preuve depuis la Phase 2. `failed()` n'exigeait
rien — une chaîne de caractères suffisait. On pouvait donc affirmer un échec
sur un `500`, alors qu'affirmer un succès sur un `200` était interdit.

**Décision.** Symétrie stricte :

```text
CONFIRMED  ← preuve POSITIVE d'effet          (POSITIVE_PRESENCE)
FAILED     ← preuve POSITIVE d'ABSENCE        (POSITIVE_ABSENCE)
UNKNOWN    ← aucune preuve suffisante
```

et quatre corollaires, tous testés :

```text
timeout           ≠ FAILED
500               ≠ FAILED
connection reset  ≠ FAILED
ACK sans preuve   ≠ CONFIRMED
```

`failed()` prend désormais une `Absence`, qui exige un champ
`conclusiveBecause` : **pourquoi cette observation tranche**. C'est le champ
coûteux à remplir honnêtement, et c'est le point. « J'ai relu, il n'y a rien »
ne suffit pas face à une file d'attente.

### Trois catégories de vérifiabilité

Le mandat demandait de ne pas interdire les outils non vérifiables, mais
d'empêcher **l'illusion de fiabilité**. D'où :

| `verifiability` | Peut prouver | Verdict maximal |
|---|---|---|
| `VERIFIABLE` | présence **et** absence | `CONFIRMED` / `FAILED` |
| `OBSERVABLE` | présence seulement | `CONFIRMED` / jamais `FAILED` |
| `UNVERIFIABLE` | ni l'une ni l'autre | `PROBABLE` au mieux |

Le Verification Engine **bride** le verdict à la déclaration : un outil
`OBSERVABLE` qui rend `FAILED` obtient `UNKNOWN`. Comme pour
`attemptVerification`, on déclare puis on vérifie — on ne fait pas confiance.

### La règle qui remplace une interdiction

```text
effet EXTERNAL + UNVERIFIABLE + autonomie automatique  →  REFUSÉ
```

L'outil reste possible ; il exige `L3` (approbation) ou `L4`. Un effet externe
que le système ne sait pas observer ne se produit jamais sans qu'un humain
l'ait voulu.

### Identité d'opération immuable

`OperationIdentity` est un type **marqué** : une chaîne ordinaire n'y est pas
assignable. `mint()` représente une intention neuve, `sameOperation()` un
repli. Écrire `invoke({ ...call, operationId: mint() })` dans un chemin de
repli devient un acte visible, et l'invariant I5 vérifie que `mint()` n'est
appelé qu'aux deux points d'entrée légitimes.

**Ce qui reste ouvert.** Le type empêche la faute par accident ; il n'empêche
pas quelqu'un de frapper délibérément une clé neuve. I5 le rend visible en
revue, ce qui est la meilleure garantie disponible sans routeur.

---

## ADR-031 — L'unité d'effet est la CIBLE, pas l'opération

**Statut :** accepté (Foundation 4). **Implémenté, non branché.**
**Contexte :** `docs/19 §2` spécifiait `PARTIAL`. Le mandat a précisé ce qui
manquait : un statut seul ne suffit pas, il faut un modèle d'effet.

```text
Opération
 ├── cible A → CONFIRMED
 ├── cible B → CONFIRMED
 ├── cible C → UNKNOWN
 ├── cible D → FAILED
 └── cible E → NOT_ATTEMPTED
        ↓
     PARTIAL          ← projeté, jamais déclaré
```

**Décision.** `VerificationStatus` gagne deux valeurs, `PARTIAL` et
`NOT_ATTEMPTED`, et `projectStatus()` calcule le statut global à partir des
résultats par cible. Un outil ne peut pas se dire `PARTIAL` pour éviter de
trancher — même discipline que `confirmed()`.

**La garde qui a manqué de peu.** Le test structurel de `redteam/failure-modes`
a signalé que `outcome.ts` pouvait *retourner* un `CONFIRMED`. Il avait raison.
La réponse n'a pas été d'assouplir le test mais d'exiger la preuve : une cible
`CONFIRMED` sans `POSITIVE_PRESENCE` ne compte pas dans la projection. La
projection ne peut donc pas inventer un succès qu'aucune observation n'étaye.

**Reprise par cible :**

```text
CONFIRMED      → jamais resservir
NOT_ATTEMPTED  → exécutable
FAILED         → exécutable, SEULEMENT sur POSITIVE_ABSENCE
UNKNOWN        → vérifier, jamais rejouer
PROBABLE       → jamais
```

**État réel.** Le module existe, il est testé, et il n'est **pas branché** au
Tool Gateway — qui n'a aujourd'hui aucune notion de cible à lui transmettre.
`redteam/wiring` le liste explicitement parmi les modules qu'aucun point
d'entrée n'atteint, pour que la dette reste visible.

---

## ADR-032 — Un bail d'exécution, parce que le compteur ne distingue pas un mort d'un vivant

**Statut :** accepté (Foundation 4).
**Contexte :** trouvé par le chaos runner, pas par relecture.

### Le contre-exemple minimal

Trois appels simultanés, un outil capable de vérifier ses tentatives :

```text
A gagne le CAS, part exécuter (60 ms de latence)
B lit EXECUTING, interroge le monde — encore VIDE
B conclut NO_EFFECT, rembobine, exécute
   → DEUX EFFETS
```

### Pourquoi ADR-029 ne suffisait pas

ADR-029 utilisait `attempts` comme numéro de version, sur ce raisonnement
écrit noir sur blanc :

> « L'état seul ne suffit pas : il ne dit pas si le `EXECUTING` observé est
> celui d'un processus mort ou d'un appelant bien vivant. Le compteur, lui,
> les distingue. »

**C'était faux.** Un exécutant vivant porte `EXECUTING, attempts = 1` —
exactement ce que lit un repreneur qui croit succéder à un mort. Le
raisonnement ne tenait que pour un crash, où plus personne ne bouge. Les tests
de crash de Foundation 3 passaient donc, et masquaient le cas symétrique.

### La décision

Ce qui distingue réellement les deux est **le temps**. Le Gateway impose
lui-même `withTimeout(def.timeoutMs)` : passé `executing_at + timeoutMs`, un
exécutant vivant a forcément écrit un état terminal. Si l'opération est
toujours en `EXECUTING` au-delà, il est mort.

```sql
SELECT executing_at > now() - ($2 || ' milliseconds')::interval AS live
```

Évalué **par la base**, jamais par l'horloge du processus : comparer avec une
horloge locale introduirait une dérive entre machines, précisément là où le
bail compte le plus.

Avant expiration, la seule réponse honnête est `OPERATION_IN_FLIGHT` — « je
n'ai rien tenté ».

**Le prix, assumé.** Une reprise après crash n'est plus immédiate : elle est
bornée par le `timeoutMs` de l'outil plus une marge de 5 s. On échange une
latence de reprise contre la certitude de ne jamais doubler un effet.
`lab/crash-concurrency` en fait une propriété testée plutôt qu'un effet de
bord subi.

**Arbitrage.** Un battement de cœur donnerait une détection plus rapide, au
prix d'une écriture périodique par opération en vol et d'un nouveau mode de
panne (le battement qui s'arrête sans que le processus soit mort). Refusé tant
qu'aucune mesure ne montre que la latence de reprise gêne.

**Condition de révision.** Si un outil doit déclarer un `timeoutMs` très long
— un traitement de plusieurs minutes — le bail devient trop long pour être
praticable. Il faudra alors un battement de cœur, et cet ADR doit être rouvert
avant, pas après.

---

## ADR-033 — Un bail expiré ne prouve rien sur le monde extérieur

**Statut :** accepté (Foundation 4.1). **Corrige ADR-032.**

### La phrase à retirer de l'architecture

ADR-032 affirmait : *« ce qui distingue un exécutant mort d'un vivant est le
temps »*. C'est faux, et deux fois plutôt qu'une.

Un bail ne mesure pas la vie d'un processus. Il mesure :

> depuis combien de temps personne n'a renouvelé le bail.

Ce n'est pas la même chose. Et même en supposant le processus réellement mort,
**sa requête, elle, peut encore vivre chez le fournisseur.**

### Cinq notions qu'on avait confondues

```text
PROCESS LIVENESS               le processus tourne-t-il encore ?
LEASE EXPIRATION               le bail a-t-il été renouvelé ?
REQUEST CANCELLATION           le fournisseur a-t-il cessé de traiter ?
EXTERNAL EFFECT                le monde a-t-il changé ?
EXTERNAL EFFECT VERIFICATION   peut-on le CONSTATER, maintenant ?
```

`withTimeout()` côté Jarvis n'établit **aucune** des quatre dernières. Il rend
la main, c'est tout. Un développeur qui lit `timeout → UNKNOWN` pourrait en
conclure « l'appel est terminé » : il aurait tort, et c'est la raison d'être de
ce paragraphe.

### Le contre-exemple, mesuré

```text
A envoie sa requête, puis gèle ou meurt
le bail expire — mais la requête vit toujours
B vérifie : le monde est encore VIDE  →  NO_EFFECT
B exécute                             →  EFFET B
la requête de A aboutit enfin         →  EFFET A
                                         ══════════
                                          2 EFFETS
```

Aucune observation ne pouvait sauver B : **au moment où il regarde, il n'y a
rien à voir.** Ce n'est pas un défaut de vérification, c'est une limite de
l'observation elle-même.

### L'invariant définitif

> **L'expiration d'un bail ne constitue jamais une preuve d'absence d'effet
> externe.**
>
> `UNKNOWN` + bail expiré ≠ autorisation de rejeu.

Le bail garde une utilité — libérer une coordination interne, autoriser à
*interroger* — mais il n'autorise plus, à lui seul, une nouvelle exécution
externe.

### La décision : `EffectContract`

Le moteur ne demande plus « puis-je réessayer ? », question à laquelle on
répond par optimisme. Il demande « quel contrat d'effet possède cet outil ? ».

| Contrat | `FAILED` possible ? | Rejeu après `UNKNOWN` |
|---|---|---|
| `NO_EXTERNAL_EFFECT` | ✅ | ✅ libre |
| `LOCAL_TRANSACTIONAL` | ✅ le rollback prouve l'absence | ✅ |
| `PROVIDER_IDEMPOTENT` | ❌ | ✅ **avec la même identité** |
| `EXTERNALLY_VERIFIABLE` | ❌ | ❌ peut confirmer, jamais rejouer |
| `UNVERIFIABLE` | ❌ | ❌ `UNKNOWN` définitif |

`mayReplayAfterUnknown()` est une fonction **totale** sur l'énumération :
ajouter un contrat sans décider de sa politique de rejeu ne compile pas.

**Pourquoi `PROVIDER_IDEMPOTENT` est le seul contrat externe rejouable.** Sa
garantie ne dépend pas de notre observation. Même si la requête de A aboutit
dix minutes plus tard, le fournisseur la dédoublonne. C'est la seule
construction qui survit à une requête en vol — parce qu'elle n'essaie pas de la
détecter.

**Pourquoi `EXTERNALLY_VERIFIABLE` ne suffit pas.** Interroger le fournisseur
répond à « existe-t-il un effet **maintenant** ? ». Cela permet de passer de
`UNKNOWN` à `CONFIRMED`. Cela ne dit rien de ce qui est en vol.

### Le défaut que cette épreuve a révélé au passage

Le rembobinage `UNKNOWN → PLANNED` laissait `observed_at` renseigné et violait
la contrainte `terminal_states_are_observed`. Le chemin de reprise depuis
`UNKNOWN` **n'a donc jamais fonctionné depuis Foundation 3** : il levait une
exception, que `guarded()` transformait en `INTERNAL`.

Conséquence directe : la première version de cette épreuve adversariale était
**verte pour la pire des raisons** — non pas parce qu'une garantie tenait, mais
parce que le code plantait avant de pouvoir nuire. Corrigé, et c'est
précisément pourquoi un test vert doit être expliqué avant d'être cru.

### Risque résiduel, assumé et nommé

La garantie de `PROVIDER_IDEMPOTENT` vient d'un **tiers**. Nous ne pouvons que
le croire. Un fournisseur qui déclare dédoublonner sans le faire produit un
double effet, et rien dans Jarvis ne peut l'empêcher.

`tests/lab/lease-adversarial.test.ts` met ce cas en scène et **mesure les deux
effets** plutôt que de faire semblant. C'est la frontière du système :

```text
┌── JARVIS ──────────────┐
│ politique · mémoire    │
│ vérification · audit   │   ← nos invariants s'appliquent
│ identité d'opération   │
└───────────┬────────────┘
            │  frontière
┌───────────▼────────────┐
│  MONDE EXTÉRIEUR       │   ← nos invariants ne s'appliquent PAS
└────────────────────────┘
```

**Condition de révision.** Si un fournisseur permet de sceller une requête —
un jeton à usage unique consommé côté serveur — la frontière recule d'un cran
et ce contrat mérite une sixième valeur. Pas avant.

---

## ADR-034 — Le rejeu est une CONDITION, pas une liste

**Statut :** accepté (avant Foundation 5). **Précise ADR-033.**

ADR-033 écrivait : *« `PROVIDER_IDEMPOTENT` est le seul contrat externe
rejouable »*. Vrai aujourd'hui, et dangereux comme énoncé d'architecture.

**Décision.** La règle est une condition :

> Une opération externe après `UNKNOWN` n'est rejouable que si son contrat
> fournit une garantie **démontrable** que le rejeu ne peut produire un second
> effet.

`PROVIDER_IDEMPOTENT` est le **premier contrat concret** qui la satisfait, pas
la définition de la condition. D'autres mécanismes la satisferaient sans être
une clé d'idempotence :

```text
transaction distribuée à deux phases · réservation puis validation ·
déduplication portée par la ressource · opération intrinsèquement idempotente ·
compensation vérifiée
```

**Encodage.** `REPLAY_SAFE_CONTRACTS` est un registre où chaque entrée doit
justifier deux choses :

| Champ | Ce qu'il exige |
|---|---|
| `guarantee` | la garantie invoquée, démontrable et non plausible |
| `independentOfObservation` | pourquoi elle ne dépend pas de ce que NOUS observons |

Le second champ est celui qui trie. Une garantie fondée sur notre observation
ne vaut rien face à une requête encore en vol : au moment où on regarde, il n'y
a rien à voir (`docs/21 §2`).

**Pourquoi un registre plutôt qu'un `switch`.** Un `switch` cache le
raisonnement derrière des `return true`. Le registre oblige à écrire la
justification à côté de la décision, et rend l'ajout d'un contrat futur
lisible en revue. L'omission vaut refus : `FAIL CLOSED` appliqué à l'extension
du registre lui-même.

**Condition de révision.** Chaque nouveau contrat candidat doit d'abord passer
par un contre-exemple : *quelle séquence rendrait cette garantie fausse ?* Si
la question n'a pas de réponse écrite, le contrat n'entre pas au registre.

---

## ADR-035 — Sémantique du bail, et cloisonnement par génération

**Statut :** accepté (Foundation 5.1). **Corrige un défaut MESURÉ**
(`docs/23 §6`). **Précise ADR-032 / ADR-033.**

### Le défaut

Mesuré, pas supposé :

```text
opération en EXECUTING, démarrée il y a une heure
B reprend et clôt      →  state = SUCCEEDED, « repris par B »
A, zombie, revient     →  state = UNKNOWN,   « écriture tardive de A »
                          ═══════════════════════════════════════════
état final : celui de A
```

L'écriture terminale du Gateway était inconditionnelle. Un exécutant dont
l'autorité avait expiré possédait exactement les mêmes droits qu'un exécutant
courant. Jarvis racontait l'histoire de A à propos d'un monde façonné par B.

### Ce qu'est un bail — une phrase, et pas une autre

> Jusqu'à cet instant, cet exécutant possède le **droit logique d'écrire** dans
> l'état de cette opération.

Ce qu'un bail n'est **jamais** :

| ✗ | Pourquoi |
|---|---|
| une mesure de la vie d'un processus | `docs/21` — mesuré faux |
| une preuve d'absence d'effet externe | ADR-033 |
| une annulation de requête | rien dans la pile ne l'offre |

### Sémantique, champ par champ

La question posée n'était pas *« quelle horloge est juste ? »* mais *« quelle
horloge peut ouvrir une reprise prématurée ? »*. La réponse diffère selon le
champ, et c'est pour cela que le tableau existe.

| Champ | Horloge | Évaluée | Dans quelle transaction | Propriété |
|---|---|---|---|---|
| `lease_generation` | **aucune** | à l'acquisition | celle du `UPDATE` | **sûreté** |
| `lease_expires_at` | `clock_timestamp()` | à l'acquisition | celle du `UPDATE` | vivacité |
| `executing_at` | `clock_timestamp()` | à l'acquisition | celle du `UPDATE` | vivacité |
| contrôle d'expiration | `now()` côté base | à la reprise | celle du `SELECT` | vivacité |
| `lease_owner` | — | à l'acquisition | — | diagnostic seul |

**La ligne qui compte est la première.** Le droit d'écrire est porté par la
**génération**, pas par le temps. Aucune horloge ne participe à la sûreté :
un dérèglement d'horloge coûte de la disponibilité, jamais de la sûreté.

L'échéance ne sert qu'à décider **quand un autre exécutant a le droit de
prendre la relève**. Elle ne conclut rien sur le monde.

#### Pourquoi `clock_timestamp()` et non `now()`

`now()` est un alias de `transaction_timestamp()` : il rend l'heure de **début
de transaction**. Mesuré en couche 01 : figé à 0 ms sur deux secondes réelles.

La direction de l'erreur décide de tout :

```text
now() figé au CONTRÔLE   →  bail SUR-estimé   →  reprise BLOQUÉE     →  DISPONIBILITÉ
now() figé à l'ÉCRITURE  →  bail SOUS-estimé  →  reprise PRÉMATURÉE  →  SÛRETÉ
```

Le second est le contre-exemple de `docs/23 §3.2` : une estampille écrite dans
une transaction longue naît vieille, et l'opération est déclarée expirée à
l'instant où elle démarre.

**Mesure d'exposition réelle** (`docs/24 §2`) : le Gateway est structurellement
immun. `deps.db.query()` prend une connexion distincte du pool ; la transaction
d'un appelant ne l'englobe jamais. Mesuré : estampille écrite 2,6 s après le
`now()` de la transaction enveloppante, âgée de 39 ms à la relecture.

> La protection principale est l'**isolation de connexion**, pas la fonction
> d'horloge. `clock_timestamp()` est une défense en profondeur — et on le dit,
> plutôt que de laisser croire qu'une ligne de SQL a fermé le sujet.

### Décision — le cloisonnement

1. `lease_generation INTEGER NOT NULL DEFAULT 0`, monotone.
2. Frappée dans le **même compare-and-swap** que la prise de bail : deux
   exécutants ne peuvent jamais obtenir la même génération.
3. **Toute** écriture d'un détenteur de bail passe par une primitive unique,
   `writeAuthoritative`, gardée par `lease_generation = <celle du détenteur>`.
4. Une écriture périmée n'est **pas une erreur** : elle rend `false`. Être
   périmé n'est pas une panne, c'est une perte d'autorité.
5. Nouvelle famille d'erreur `STALE_EXECUTOR`, distincte d'`OPERATION_IN_FLIGHT` :
   l'un n'a jamais eu l'autorité, l'autre l'a eue et l'a perdue.

**Une seule garde pour toutes les colonnes.** Un cloisonnement écrit colonne par
colonne aurait la faiblesse qu'il prétend corriger : un `SET` oublié rouvrirait
le passage sans que rien ne le signale.

### La catégorie d'exception, nommée plutôt que tolérée

Deux écritures **ne peuvent pas** être cloisonnées : ce sont celles qui rendent
la frappe du bail possible.

```text
PLANNED                 → COMMITTED_TO_EXECUTION
COMMITTED_TO_EXECUTION  → PLANNED   (reprise, aucun appel n'est parti)
```

Leur garde est un **littéral d'état d'où aucun effet externe n'est possible**.
Un exécutant périmé est en `EXECUTING` ou au-delà : la clause l'exclut. La
propriété est vérifiée par test, pas affirmée
(`fencing-adversarial.test.ts`).

### L'invariant structurel I17

> Tout `UPDATE tool_operations` de `src/` est soit cloisonné par
> `lease_generation`, soit cantonné à un état d'où aucun effet n'est possible.

Fermé par défaut : toute forme que l'analyseur ne sait pas lire est comptée
comme non gardée. Six contrôles négatifs attaquent l'analyseur, dont la faute
exacte de `docs/23 §6` et la garde par `attempts` qui a réellement échoué —
sans quoi « aucune violation » ne prouverait rien.

**Ce qu'I17 ne prouve pas, et il faut le dire ici :** il lit du texte. Il
établit qu'une garde est **écrite**, pas qu'elle porte la bonne valeur. La
sémantique est établie par les épreuves comportementales. Les deux sont
nécessaires, aucun ne remplace l'autre.

### LA FRONTIÈRE — à ne jamais déplacer

```text
le cloisonnement PROTÈGE       l'état interne de Jarvis contre ses anciens
                               exécutants

le cloisonnement NE PROTÈGE    le monde extérieur contre une requête déjà
PAS                            partie

    fencing ≠ annulation ≠ idempotence ≠ vérification ≠ absence d'effet
```

Un test mesure explicitement la moitié négative : A est déclaré périmé, son
écriture est refusée — **et son effet existe quand même dans le monde**. Un
système qui conclurait « écriture refusée, donc pas d'effet » aurait remplacé
un défaut par un mensonge.

### Le journal n'est pas effacé, il est marqué

Le journal était un second chemin parallèle : un exécutant périmé y inscrivait
`…_FAILED`, et l'audit lisait une histoire contradictoire avec l'état.

Le supprimer aurait été pire — c'est parfois la **seule trace qu'une requête
est partie vers le monde**. Un exécutant périmé produit donc un événement
`…_STALE` au statut `UNKNOWN` : l'exécution est conservée, l'opinion ne l'est
pas.

### Ce qui reste NON GARANTI

| | |
|---|---|
| qu'un exécutant périmé n'ait pas produit d'effet | **NON GARANTI**, et hors de portée du mécanisme |
| que sa requête soit annulée | **NON GARANTI** — rien ne l'offre |
| le comportement sur deux hôtes physiques | **NON TESTÉ** — une seule instance |
| une dérive d'horloge entre deux serveurs PostgreSQL | **NON TESTABLE** ici |

### Condition de révision

Si une mesure montre que la latence de reprise gêne réellement, rouvrir la
question du battement de cœur — **pas avant**. Aucune mesure ne le justifie
aujourd'hui, et il ajouterait une écriture périodique et un mode de panne neuf.

---

## ADR-036 — L'échéance d'un bail est LUE, jamais recalculée

**Statut :** accepté (Foundation 5, couche 02). **Corrige un défaut LATENT
découvert par audit** (`docs/24 §7 bis`). **Précise ADR-032 et ADR-035.**

### Le défaut

La colonne `lease_expires_at`, ajoutée par la migration 0008, était **écrite
et jamais lue**. Le contrôle d'expiration reconstituait l'échéance :

```sql
executing_at > now() − (def.timeoutMs + LEASE_MARGIN_MS)
```

avec le `timeoutMs` que **le repreneur** connaît. Or l'échéance est une
propriété de l'**acquisition** : c'est l'exécutant parti qui l'a fixée, avec le
délai qu'il appliquait vraiment.

```text
A part avec timeoutMs = 30 000        →  échéance réelle : +35 s
6 secondes passent
le contrat change, redéploiement      →  timeoutMs = 2 000
B reprend et RECALCULE                →  seuil à 7 s : « expiré depuis 800 ms »
                                         ⟹ REPRISE PRÉMATURÉE de 29 s
```

Reproduit sans aucun `sleep`, sur un état que le système sait produire.

### La quatrième occurrence d'un même motif

C'est ce qui justifie un invariant plutôt qu'un correctif :

| Sprint | La phrase qu'on croyait vraie | Verdict |
|---|---|---|
| Foundation 3 | `attempts` distingue un mort d'un vivant | **faux** |
| Foundation 4 | idem — retrouvé par le chaos (CRIT-5) | **faux** |
| F5.1 | `attempts` garde le rembobinage | **faux** |
| F5.2 | le `timeoutMs` du repreneur donne l'échéance | **faux** |

> **L'OBSERVATEUR REDÉFINIT LE PASSÉ.**
> Quatre fois, sous quatre déguisements. Un fait établi par celui qui agissait
> a été reconstitué par celui qui regardait.

### Décision

```sql
COALESCE(lease_expires_at, 'infinity'::timestamptz) > now()
```

1. L'échéance est **lue**. `def.timeoutMs` ne participe plus à aucune décision
   de reprise ; il ne sert qu'à **fixer** l'échéance, à l'acquisition.
2. `COALESCE(…, 'infinity')` est du **FAIL CLOSED**. Une échéance nulle sur un
   `EXECUTING` est impossible par contrainte ; si elle survenait, bloquer une
   reprise coûte une attente là où la permettre coûterait un second effet.
3. `now()` est **conservé** au contrôle. Figé, il ne peut que sur-estimer le
   bail, donc bloquer — la direction qui protège (`docs/23 §3.1`).

**Effet de bord bénéfique :** `LEASE_MARGIN_MS` était appliqué deux fois — une
fois à l'acquisition, une fois au contrôle. Il ne l'est plus qu'une.

### Invariant I18

> L'échéance d'un bail est lue dans `lease_expires_at`, jamais recalculée à
> partir d'`executing_at` et du `timeoutMs` de l'observateur.

Mécanique : toute **comparaison** portant sur `executing_at` dans `src/` est
une violation. `executing_at` est un fait d'archive — *quand l'appel est parti*
— et en faire une borne de décision oblige à lui ajouter une durée, donc à
laisser l'observateur trancher.

I16 et I18 se partagent la colonne sans se recouvrir :

| | Garde | Question |
|---|---|---|
| **I16** | `executing_at =` | avec quelle horloge l'écrit-on ? |
| **I18** | `executing_at <` `>` | s'en sert-on pour décider ? |

### Ce que la mesure a AUSSI corrigé — dans mon assertion, pas dans le code

En éprouvant vingt reprises concurrentes, j'attendais « exactement un
vainqueur ». La mesure en a rendu quatre, et le système avait raison : le bail
ne garde que la reprise depuis `EXECUTING`. Une opération en `UNKNOWN` n'a plus
d'exécutant vivant — celui qui a écrit `UNKNOWN` avait terminé — donc plus de
bail à respecter. Les repreneurs se succèdent par génération et re-constatent
la même ignorance.

La propriété n'a jamais été « un seul vainqueur ». C'est **aucune seconde
exécution, et aucun verdict affirmatif fabriqué**.

### Condition de révision

Si un mécanisme de renouvellement est un jour introduit, `lease_expires_at`
devra être repoussé **par le détenteur du bail courant uniquement** — donc via
`writeAuthoritative`, sous cloisonnement. Un renouvellement non cloisonné
ressusciterait exactement le défaut qu'ADR-035 a fermé.

---

## ADR-037 — Qui compare doit estampiller

**Statut :** accepté (balayage « zones d'ombre »). **Corrige un défaut MESURÉ.**
**Élargit I14 au-delà du bail.**

### Le défaut

`docs/23 §4` avait établi I14 : *le verdict de bail est indépendant de
l'horloge du processus*. **Elle ne valait que pour le bail.**

Deux autres tables portaient des échéances, écrites avec `Date.now()` et
comparées avec `now()` côté base. Deux horloges pour un même fait.

| Table | TTL | Avec +1 an de dérive applicative |
|---|---|---|
| `action_snapshots` | 7 j | **371 jours** |
| `memory_candidates` | 30 j | **394 jours** |

`action_snapshots` conserve l'**état antérieur** d'une ressource, classé
jusqu'à `ORANGE`. Une rétention de 371 jours est une violation de `docs/14`,
pas une gêne d'exploitation. En dérive inverse, l'instantané naissait **déjà
expiré** : l'annulation devenait silencieusement impossible.

### Ce qui distingue ce défaut d'ADR-036

Il en est le **voisin**, et c'est pour cela qu'il était resté invisible :

```text
ADR-036   l'observateur RECALCULE une échéance qu'il n'a pas fixée
ADR-037   l'échéance est bien fixée UNE fois — mais par la mauvaise horloge
```

### Décision

> **Qui compare doit estampiller.**

Toute échéance destinée à être comparée par la base est **frappée par la
base** :

```sql
clock_timestamp() + ($n || ' days')::interval
```

`Date.now()` reste libre partout où il mesure une durée, horodate un journal ou
verrouille **en mémoire** — `auth.ts` compare son verrou à `Date.now()` des
deux côtés, donc reste cohérent.

### Invariant I19

> Une échéance persistée est frappée par la base, jamais par l'horloge du
> processus.

Contrôle volontairement **grossier et fermé par défaut** : un fichier qui écrit
`expires_at` et manipule `Date.now() +` est signalé. Suivre un paramètre `$11`
jusqu'à sa valeur demanderait une analyse de flot que la moindre
refactorisation casserait ; la cohabitation des deux suffit à exiger une
relecture, et c'est ce qu'on attend d'une garde.

Quatre contrôles, dont le défaut exact mesuré et une vérification que
`Date.now()` **n'est pas** signalé là où il chronomètre — une garde qui
interdirait `Date.now()` partout serait désactivée dans la semaine, et le vrai
défaut repasserait avec elle.

### Condition de révision

Toute nouvelle colonne d'échéance rejoint `DECISION_TIMESTAMPS` (I16) et le
périmètre d'I19. Une échéance qui ne serait **jamais** comparée par la base
peut rester applicative — mais il faudra l'écrire, pas le supposer.

---

## ADR-038 — `PROVIDER_CONTRACT_VIOLATION` : un verdict sur la SOURCE

**Statut :** accepté (Foundation 5, couches 04-05). **Référence :** `docs/22 §9`.

### Le besoin

Un fournisseur byzantin n'est pas exotique : c'est un service qui a un bogue,
une version qui change sans préavis, ou une documentation optimiste.

Le cas canonique — deux effets pour une identité unique chez un fournisseur
**déclaré idempotent** — n'entrait dans aucun statut existant, et le
« meilleur » choix disponible était **faux** :

| Statut | Pourquoi il ment ici |
|---|---|
| `CONFIRMED` | masquerait la violation |
| `FAILED` | affirmerait l'absence alors que **deux** effets existent |
| `UNKNOWN` | vrai mais insuffisant : on sait quelque chose de plus |

### La faute de modélisation trouvée en chemin

`hostile-tool.ts` rendait `FAILED` sur `count > 1`. Or `FAILED` signifie
**preuve positive d'absence**. Annoncer « ça n'a pas marché » à propos de deux
virements passés est le mensonge le plus coûteux que ce dépôt puisse produire —
et il violait I3 au passage.

### Décision

```text
PROVIDER_CONTRACT_VIOLATION
  ne qualifie pas L'ACTION mais LA SOURCE
  plus fort qu'UNKNOWN : on ignore l'issue, ET on sait qu'on ne peut plus
  croire celui qui la raconte
```

La fabrique exige un `ContractBreach { promised, observed }` — comme
`Evidence` et `Absence`. Une rupture de confiance annoncée sans constat serait
la faute que la hiérarchie de preuve a corrigée pour `FAILED`.

`constrainToVerifiability` ne la dégrade **jamais** : elle bride ce qu'un outil
affirme sur *le monde*, or une violation porte sur *la source* et a été
constatée par nous.

### La mesure se fait PAR CIBLE — et un test me l'a appris

Première version : `count > 1`. Trois destinataires servis sur cinq devenaient
une « rupture de contrat », alors que c'est le succès partiel le plus banal.

La violation est `maxEffectsPerTarget > 1` — l'inégalité par cible d'ADR-031.
Trois branches distinctes en découlent :

| Constat | Verdict |
|---|---|
| deux effets sur **une même** cible | `PROVIDER_CONTRACT_VIOLATION` |
| plusieurs cibles, aucune deux fois | `UNKNOWN` — succès partiel que le verdict global ne sait pas dire |
| un effet, une cible | `CONFIRMED` |

### Classification honnête — et ce qu'il ne faut pas promettre

`docs/22 §9` impose de classer plutôt que promettre :

| Classe | Ce fournisseur |
|---|---|
| A — empêchable | **non** |
| B — impossible à empêcher | **oui** |
| C — détectable après coup | **oui**, sur cible unique ou ensemble déclaré |
| D — non détectable | **oui**, dès que l'ensemble des cibles n'est pas déclaré |

> **Ne jamais annoncer A quand seul C est possible.**

La limite de classe D est **mesurée** par un test dédié : deux effets sur deux
cibles différentes sont indiscernables d'un envoi légitime à deux
destinataires. Aucune violation n'est détectée, et c'est **correct**.

### Ce que la migration 0009 a révélé

Le `CHECK` de `tool_operations.status` n'autorisait que quatre valeurs alors
que `VerificationStatus` en déclarait **six** depuis Foundation 3. `PARTIAL` et
`NOT_ATTEMPTED` auraient été **refusés par la base**.

C'était une seconde raison, indépendante et non documentée, pour laquelle
`PARTIAL` était inatteignable — `docs/26 §4.1` n'en connaissait qu'une.

`event_ledger.status` portait la **même** contrainte, trouvée en exécutant le
premier test byzantin : le registre acceptait le verdict, le journal le
refusait, et l'opération échouait en `INTERNAL` — une rupture de confiance qui
fait planter au lieu d'être consignée.

**Un type et un schéma qui divergent en silence, c'est la validation aux
frontières prise en défaut à l'intérieur.**

### Condition de révision

Tout nouveau statut doit être ajouté **aux deux** contraintes en même temps que
l'énumération TypeScript. Le jour où une seconde forme de rupture de confiance
existera, `isTrustBreach()` est le seul endroit à changer.

---

## ADR-039 — Cycle de vie de la confiance, et provenance de l'appel

**Statut :** accepté (Foundation 5). **Référence :** `docs/22 §9`, §10.
**Implémente I12 et I13.**

### I12 — aucune action nouvelle sur une information compromise

Quand un fournisseur a rompu son contrat, le Gateway refuse d'engager une
action nouvelle par ce service. Erreur dédiée `PROVIDER_TRUST_REVOKED`,
distincte de `PROVIDER_UNAVAILABLE` : le premier ne répond pas, le second **a
répondu**, et a fait autre chose que ce qu'il annonçait.

**Où la garde est posée, et pourquoi c'est le point délicat.** Tout ce qui
précède l'engagement est de l'**observation** — relire un état, constater une
reprise, rendre un verdict déjà écrit. Une garde placée trop haut aurait fermé
la lecture au moment précis où l'on a besoin d'auditer. Un système qui se
verrouille quand il faut le comprendre est pire qu'un système sans garde.

Elle est donc posée **juste avant la barrière de durabilité** : après tous les
chemins d'observation, avant toute action nouvelle. Un test dédié vérifie que
la relecture reste possible.

**La question se pose au JOURNAL, pas au registre** — et c'est un test qui l'a
appris. Le registre ne garde que le dernier état d'une opération, et une
violation est constatée lors d'une *relecture*, qui ne le réécrit pas
(ADR-025). Le journal, lui, est append-only et chaîné : une garde qui
interroge une source effaçable n'est pas une garde.

**L'intention reste inscrite** — `PLANNED`, `attempts = 0`, sans verdict.
Elle a bien existé, et si la confiance est rétablie, l'opération repart de là
plutôt que d'être perdue.

### Le rétablissement — la lacune que l'exécution a révélée

Une violation consignée dans un journal append-only condamnait l'outil
**définitivement**. Un bogue de fournisseur, corrigé le lendemain, laissait
Jarvis muet pour toujours : un déni de service offert au premier service qui a
un défaut. Or le mandat demande de **dégrader** la confiance, pas de la
détruire.

`restoreTrust(toolId, actor, reason)` :

| Règle | Pourquoi |
|---|---|
| réservé à `USER` | Jarvis ne se rend pas à lui-même une confiance qu'un constat lui a retirée |
| motif obligatoire | un rétablissement sans motif n'est pas auditable |
| journalisé | personne ne doit pouvoir rendre une confiance en silence |

La garde `actor === 'USER'` est ce qui donne son sens au mécanisme : si le
système pouvait se rétablir seul, la rupture ne coûterait rien et le constat
n'aurait aucune conséquence.

La confiance se perd **par source**, jamais globalement — sinon un seul
fournisseur fautif arrêterait tout le système.

### I13 — la chaîne de provenance

`docs/22 §10` relevait le trou nommément : *« le Gateway ne journalise pas
l'appel lui-même »*. Le registre savait qu'une opération était passée en
`EXECUTING` ; le journal ne portait rien entre la décision et son issue.

Un événement `…_REQUEST_SENT` est désormais émis **après la prise de bail et
avant l'appel** — le seul instant où « la requête part maintenant » est vrai.
Statut `UNKNOWN` : `NOT_ATTEMPTED` serait faux, l'appel PART.

Sans lui, à la question *« pourquoi refuses-tu de recommencer ? »*, la seule
réponse lisible était un état terminal — jamais le fait qu'un appel ait
réellement quitté le processus.

**Conséquence sur `findByOperationId`.** Une opération a maintenant plusieurs
événements ; rendre le *premier* rendait le moins informatif. La fonction rend
désormais le **dernier** : qui pose la question veut savoir ce qui s'est passé.

### La limite, mesurée et assumée

> La provenance prouve **le raisonnement**, jamais **le monde**.

Un fournisseur qui répond `200` sans rien faire produit une chaîne complète,
cohérente — et un verdict qui serait faux si rien d'autre ne le retenait. Ce
qui sauve n'est pas la traçabilité : c'est la relecture indépendante du monde.

Un test le mesure explicitement, pour que la provenance ne soit jamais
présentée comme une garantie sur la réalité.

### Ce qui n'est PAS fait

Les identifiants typés `intentId`, `attemptId`, `requestId`,
`providerRequestId`, `effectId` de `docs/22 §10` **n'existent pas**. La chaîne
est reconstructible par lecture — monde → opération → journal → intention — et
un test la reconstruit sans rien déduire. Mais chaque maillon est identifié par
la clé d'opération, pas par un identifiant propre.

Suffisant pour les deux questions posées. Insuffisant le jour où une opération
portera plusieurs tentatives adressant plusieurs fournisseurs.

---

## ADR-040 — Le CostGate ne peut que RESTREINDRE

**Statut :** accepté (Phase 4). **Référence :** `docs/04 §9-11`, `docs/14 §4`.

### Le problème, qui n'était pas « compter »

`docs/04` pose **0 € récurrent** comme invariant. Il était tenu **par absence
de dépense** — aucun fournisseur cloud n'est branché — et non **par
mécanisme**.

> Un invariant qui repose sur le fait que rien n'est branché cesse d'être un
> invariant au premier branchement.

### La propriété de sûreté, et c'est la seule

`docs/14 §4` fixe l'ordre :

```text
REQUÊTE → CLASSIFICATION → POLITIQUE → CAPACITÉS AUTORISÉES
        → CHOIX DU MODÈLE (le moins cher parmi les ÉLIGIBLES)
        → BUDGET
```

Et **jamais** `LOCAL → échec → CLOUD → échec → PREMIUM`.

D'où la décision structurante :

> **Le CostGate ne peut que RESTREINDRE.**
> Il transforme un `ALLOW_CLOUD` en `DENY` quand le budget est atteint. Il ne
> transforme **jamais** un `LOCAL_ONLY` en `ALLOW_CLOUD` — quel que soit le
> budget disponible, l'importance de la requête, ou l'indisponibilité du
> local.

Encodé par le type : l'entrée porte une `PolicyAllowance` déjà tranchée en
amont. Le coût n'a aucun moyen de la rouvrir, et le premier test du module
attaque exactement ce point avec un budget d'un million d'euros.

Si le coût pouvait promouvoir, **il suffirait d'avoir de l'argent pour
contourner la confidentialité.**

### La monnaie est en entiers

`cost_micros` — millionièmes d'euro, en `BIGINT`.

Un budget en flottant dérive : additionner dix mille appels à 0,0001 € ne rend
pas exactement 1 €, et « blocage dur à 100 % » devient « blocage dur *vers*
100 % ». Sur un seuil, l'approximation n'est pas acceptable — c'est le genre de
défaut qu'on ne voit qu'après le dépassement.

**Les arrondis vont tous dans la direction qui protège** : au supérieur, des
deux côtés. Un budget arrondi vers le bas serait dépassé sans le dire ; une
estimation arrondie vers le bas laisserait passer un appel qui déborde. Les
deux erreurs iraient dans le même mauvais sens.

### « Aucun dépassement silencieux, jamais »

La décision porte sur `dépensé + estimation`, **pas sur `dépensé`**. Décider
sur le dépensé seul autoriserait un appel qui déborde, et le dépassement ne
serait constaté qu'après coup.

Reste le cas qu'on ne peut pas empêcher : une **estimation basse**. Le blocage
travaille sur l'estimation, donc le seuil peut être franchi sur le coût réel.
Ce n'est pas évitable ; ce qui l'est, c'est que ça passe inaperçu — `record()`
rend `overrun`, et l'appelant doit le dire.

**`ASK_USER` plutôt que `DENY` pour une requête `IMPORTANT`.** `docs/04`
interdit le dépassement *silencieux*, pas la question posée. Refuser sans rien
dire une opération importante serait une dégradation invisible — le défaut
symétrique.

### Le plafond ne se contourne pas en effaçant l'historique

Le rôle applicatif a `SELECT, INSERT` sur `cloud_spend`. **Ni `DELETE` ni
`UPDATE`.**

Si l'application pouvait supprimer des lignes, elle pourrait remettre le
compteur à zéro — et le plafond deviendrait une suggestion. Le contournement ne
demanderait même pas de malveillance : un « nettoyage » de maintenance
suffirait.

Même raisonnement que pour `event_ledger` : ce qui sert de preuve ne s'écrit
qu'une fois. La correction d'une erreur passe par une écriture compensatoire,
visible, jamais par un effacement.

### Le mois est calculé par la base

`date_trunc('month', clock_timestamp())`, jamais une borne calculée en
JavaScript. C'est ADR-036 et ADR-037 réunis, appliqués d'emblée : un processus
dont l'horloge dérive d'un mois lirait un budget vide et dépenserait deux fois
le plafond sans que rien ne le signale.

### Sabotage

| Ligne remise dans son état fautif | Tests rouges |
|---|---|
| le coût peut promouvoir `LOCAL_ONLY` | **3 / 16** |
| décision sur `dépensé` seul | **3 / 16** |
| mois calculé par le processus | **2 / 16** |

### Ce qui n'est PAS fait

Le **Model Router** de `docs/04 §10` — choisir le moins cher *parmi les
éligibles* — n'existe pas. Le CostGate décide si un appel passe ; il ne choisit
pas encore quel modèle. Tant qu'aucun fournisseur n'est branché, la question ne
se pose pas — mais l'ordre de `docs/14 §4` devra être respecté à ce
moment-là, et c'est le point à ne pas manquer.

### Condition de révision

Si un jour un appel cloud doit être engagé **sans** estimation préalable, tout
le mécanisme tombe : le blocage dur repose entièrement sur le fait qu'on sait
estimer avant d'appeler. Ce serait une décision d'architecture, pas un
ajustement.

---

## ADR-041 — L'audit lit le JOURNAL, et l'interdit est structurel

**Statut :** accepté (Phase 3). **Référence :** `docs/12`, `docs/05 §A9`,
`docs/14 §2`.

### Le problème, qui n'était pas « afficher une liste »

`docs/05 §A9` pose la question la plus banale qu'on puisse adresser à un
assistant — « qu'as-tu fait aujourd'hui ? » — et l'assortit d'une clause qui
n'est pas banale du tout :

> réponse construite **depuis l'Event Ledger**.
> **Interdit :** réponse reconstruite par le modèle de mémoire.

Les deux implémentations rendent le même écran. Elles ne prouvent pas la même
chose.

| | Ce que ça rapporte |
|---|---|
| depuis la mémoire ou `tool_operations` | ce que le système **croit** avoir fait, dans son état **courant** |
| depuis `event_ledger` | ce qui a **été écrit** au moment où ça s'est produit |

L'écart entre les deux est exactement l'espace où un audit cesse de servir : une
source révisable ne prouve rien. `tool_operations` est un registre mutable qui
ne garde que le dernier état — c'est son rôle, et c'est ce qui le disqualifie
ici. Le journal est append-only et chaîné ; c'est sa seule raison d'exister.

### La décision

> **`audit_query` lit `event_ledger`, et rien d'autre.**
> Pas de jointure, pas de mémoire, pas de résumé de modèle.

Et surtout : **l'interdit est vérifié sur le TEXTE de la source**, pas sur le
comportement.

```ts
expect(source).toContain('FROM event_ledger');
for (const interdite of ['FROM tool_operations', 'FROM memories',
                         'FROM notes', 'FROM tasks', 'JOIN']) { … }
for (const interdit of ['provider', 'complete(', 'chat(', 'embed(', 'summar']) { … }
```

C'est délibéré, et c'est le point de l'ADR. Une garantie comportementale
resterait verte le jour où quelqu'un ajoute une jointure « pour enrichir
l'affichage » — le résultat serait toujours plausible. Une garantie
structurelle échoue à la ligne ajoutée. **L'outil ne reçoit aucun fournisseur de
modèle et n'en importe aucun : ce n'est pas une discipline, c'est une
impossibilité de construction.**

### Un trou dans le journal se RAPPORTE, il ne se comble pas

Corollaire direct : `truncated` est rendu explicitement. Montrer cinquante
lignes sur trois cents sans le dire est la seule façon dont une lecture honnête
peut mentir — et elle mentirait d'autant mieux qu'elle n'invente rien.

### La fenêtre est calculée par la base

`date_trunc($1, clock_timestamp())`. ADR-036 et ADR-037 appliqués d'emblée : un
appelant dont l'horloge dérive verrait « aujourd'hui » ailleurs qu'aujourd'hui.
**Un audit qui montre le mauvais jour est pire qu'un audit absent, parce qu'il
inspire confiance.**

### Les deux classifications qui ne vont pas de soi

**`ORANGE`, pas `GREEN`.** Le journal ne contient aucune charge utile — que des
empreintes. Mais l'**enchaînement** des actions est en soi une information sur
la vie de l'utilisateur. Classer `GREEN` reviendrait à affirmer que la liste de
ce qu'on a fait ne dit rien de soi.

**`reversible: false`.** Non pas « irréversible » mais « **rien à défaire** ».
Le validateur de contrat refuse `true` sans procédure d'annulation décrite, et
il a raison : promettre une annulation qui ne peut pas exister est pire que de
ne rien promettre. Même valeur que `task_list`, pour la même raison.

### L'audit s'audite

L'interrogation émet `AUDIT_QUERIED`. Un audit qui ne se journalise pas laisse
un angle mort exactement là où il ne devrait pas y en avoir : **qui a consulté
le journal, et quand.**

### Sabotage

| Ligne remise dans son état fautif | Tests rouges |
|---|---|
| lecture sur `tool_operations` au lieu du journal | **4 / 7** |
| fenêtre calculée par l'horloge du processus | **1 / 7** |
| `truncated` toujours `false` | **1 / 7** |

Les trois discriminent : « l'audit n'appelle aucun modèle » et « l'audit est
journalisé » restent verts dans les trois cas, ce qui est correct — ils
éprouvent autre chose.

### Effet de bord assumé sur la porte de sortie Phase 2

G2.7 vérifiait `ids.length === 5`. Cette formulation devenait fausse au premier
outil de Phase 3 — or `docs/02` en prévoit dix. Reformulée en : **les cinq
premiers sont présents ET tout outil enregistré passe `validateDefinition`.**
La garantie est plus forte, pas plus faible : elle porte désormais sur la
conformité de chaque outil, pas sur un décompte.

### Condition de révision

Si le journal devait un jour être élagué pour tenir en volume, cette ADR ne
tomberait pas — mais l'outil devrait alors **rapporter la borne d'élagage** dans
sa réponse. Un audit qui ne dit pas où commence sa mémoire laisse croire que
rien ne s'est passé avant.

---

## ADR-042 — Une modification ne se défait qu'en restaurant l'état OBSERVÉ

**Statut :** accepté (Phase 3). **Référence :** `docs/02 §Phase 3`, ADR-019,
invariant S6, `docs/26 §3`.

### Ce que `task_complete` a révélé, et que les cinq premiers outils cachaient

Les cinq outils de Phase 2 **créent**. `task_complete` est le premier qui
**modifie**, et la différence n'est pas de degré :

> Une suppression n'a besoin de rien savoir du passé.
> Une restauration n'est correcte que si l'état antérieur a été LU.

`note_delete`, `task_cancel` : l'annulation d'une création n'a besoin que de
l'identifiant. Annuler une modification exige de savoir **ce qui était là** — et
personne ne peut le reconstituer après coup, parce que c'est précisément ce que
la modification a effacé.

### La décision

> **La mutation et la capture de l'état antérieur sont la MÊME instruction.**

```sql
UPDATE tasks AS t
   SET state = 'DONE', updated_at = now()
  FROM tasks AS prior          -- l'instantané pris au DÉBUT de la commande
 WHERE t.id = $1 AND prior.id = t.id AND prior.state <> 'CANCELLED'
RETURNING t.id, t.title, t.state, prior.state AS prior_state
```

Un `SELECT` suivi d'un `UPDATE` ouvrirait entre les deux une fenêtre où l'état
peut changer. La capture décrirait alors **un passé qui n'a jamais existé** — et
l'annulation restaurerait cet inexistant. C'est le motif « l'observateur
redéfinit le passé » (`docs/26 §3`) dans sa forme la plus coûteuse : ici
l'observation n'est pas un rapport, c'est la seule chose qui rendra l'annulation
possible.

**Corollaire : jamais d'état antérieur supposé.** Terminer une tâche déjà
terminée capture `DONE`, pas `OPEN`. Un outil qui écrirait « l'état normal avant
une complétion » passerait le cas nominal et inventerait un passé dans l'autre —
annuler rouvrirait une tâche que l'utilisateur avait terminée *avant* l'appel.

### Le validateur de contrat a eu raison contre la première rédaction

Écrit `NATURALLY_IDEMPOTENT` — l'état final ne dépend pas du nombre
d'exécutions. Refusé :

```text
task_complete mute mais se déclare naturellement idempotent.
Une mutation exige une clé d'opération (invariant S6).
```

L'objection porte plus loin que la règle qui l'énonce. **L'idempotence valait
pour l'ÉTAT, pas pour la CAPTURE.** Une seconde exécution aurait observé `DONE`
et enregistré `priorState: 'DONE'` par-dessus la première : l'état inchangé,
l'action devenue irréversible, et rien de visible dans la seule chose qu'on
regardait.

> Une mutation n'est jamais « naturellement » idempotente tant qu'elle traîne un
> effet de bord qui, lui, ne l'est pas.

C'est aussi pourquoi `attemptVerification: 'NONE'` est ici un **choix** et non un
défaut d'outillage : un rejeu serait plus dangereux qu'un doublon, donc la
reprise conclut `UNKNOWN` et refuse de rejouer (ADR-027).

### Deux refus explicites

**Une tâche `CANCELLED` ne devient pas `DONE`.** La conversion effacerait une
décision de l'utilisateur du seul état qu'il consulte. Le journal la garderait —
mais personne ne lit le journal pour savoir où en est sa liste. Refus `CONFLICT`,
avec la marche à suivre.

**Un état observé ≠ `DONE` après coup ne rend pas `FAILED`.** L'`UPDATE` a rendu
une ligne : l'écriture a eu lieu. Observer autre chose ensuite prouve qu'un
**autre écrivain** est passé après le commit, pas que l'écriture a échoué.
Annoncer `FAILED` serait un échec inventé, et l'utilisateur relancerait une
action déjà faite. Verdict : `UNKNOWN` / `EXTERNAL_STATE` — « externe » signifiant
ici *extérieur à cette exécution*, pas extérieur à la machine.

### Sabotage

| Ligne remise dans son état fautif | Tests rouges |
|---|---|
| `prior` lu APRÈS l'écriture (capture ≡ état courant) | **4 / 9** |
| état antérieur écrit en dur (`'OPEN'`) | **1 / 9** |
| conversion silencieuse d'une tâche `CANCELLED` | **1 / 9** |
| relecture annonçant `FAILED` au lieu d'`UNKNOWN` | **1 / 9** |

Les trois derniers sont des défauts étroits, chacun couvert par le test écrit
pour lui. Le premier casse largement, ce qui est attendu : il vide la capture de
sa substance sans rien changer à l'état, donc tout ce qui regarde le passé tombe.

### Condition de révision

Si un jour une mutation doit porter sur plusieurs lignes, `RETURNING` ne suffira
plus à capturer l'avant : il faudra un instantané explicite dans la même
transaction. Cette ADR ne tomberait pas, mais sa mise en œuvre en une instruction
oui — et c'est le moment où il faudra revenir ici plutôt qu'improviser.

---

## ADR-043 — Un agenda inaccessible n'est pas un agenda vide

**Statut :** accepté (Phase 3). **Référence :** `docs/02 §Phase 3`, `docs/16 §3`,
`docs/14 §2`, `docs/26 §4.5`, invariant S2.

### Le mode de panne que cet outil existe pour empêcher

`calendar_read` est le premier outil du dépôt qui dépend d'un système que nous
ne possédons pas. Sa difficulté tient en une phrase :

> Un agenda vide et un agenda inaccessible se ressemblent, et se racontent
> différemment.

« Tu n'as rien aujourd'hui » quand le fournisseur est injoignable est un énoncé
**faux sur le monde**. Aucune exception n'est levée, aucune erreur n'apparaît,
et Jarvis vient de mentir sur une journée entière. C'est la règle 3 — *jamais de
succès non vérifié* — dans sa forme la plus discrète : ici le succès non vérifié
ne ressemble même pas à un succès, il ressemble à une information.

**Décision :** l'absence de fournisseur est un **échec nommé**
(`PROVIDER_UNAVAILABLE`), jamais une liste vide. Et une erreur du fournisseur
remonte telle quelle — la rattraper pour rendre `[]` reproduirait le même défaut
une couche plus bas, cette fois avec un fournisseur configuré, donc sans le
moindre indice pour l'utilisateur.

Un agenda **réellement** vide reste distinguable des deux : c'est le contrôle
négatif sans lequel les deux propriétés ci-dessus seraient vertes en échouant
toujours.

### `NO_EXTERNAL_EFFECT` et `networkRequired: true` ne se contredisent pas

L'un décrit **l'effet**, l'autre **le trajet**. Une lecture ne change rien, nulle
part — y compris chez le fournisseur. Elle sort quand même du processus. Les
confondre ferait d'un outil réseau un outil mutant, ou l'inverse.

### Le pessimisme du contrat, assumé

`egress` est dérivé de `networkRequired`. Or l'outil **ne peut pas savoir** si
l'appel quitte la machine : cela dépend du fournisseur branché, connu seulement à
l'exécution. Un contrat statique devant une inconnue déclare le **pire cas**.

Conséquence acceptée : en mode privé, ou cloud coupé, `calendar_read` est refusé
**même avec un fournisseur local**. C'est un refus faux, et c'est le bon sens du
compromis — l'erreur inverse laisserait un agenda partir sans que le Gate le
voie. Le défaut de modélisation sous-jacent est consigné en `docs/26 §4.5` ; il
appartient au Data Firewall, pas à un outil.

### L'outil s'enregistre même sans fournisseur

Ne pas l'enregistrer serait une autre façon de mentir : l'utilisateur
demanderait son agenda et Jarvis répondrait qu'il ne sait pas faire, alors qu'il
sait faire et qu'il lui manque un branchement. C'est la distinction du dépôt
depuis le début — **« CAPACITÉ ABSENTE (dit) »**.

Aucun adaptateur n'est écrit. Le choix du backend est une décision de dépendance
au sens de `docs/04`, et l'interface `CalendarProvider` est la couture qui permet
de la prendre plus tard sans réécrire l'outil.

### L'invariant S2 a changé de fondation, et c'est le vrai livrable

Deux tests de red team tenaient par **absence de capacité**, et l'avaient écrit :

```text
authority.test.ts  « il n'existe encore aucun outil réseau à refuser »
injection.test.ts  « à re-tester le jour où le premier outil sortant apparaîtra »
```

Ce jour est arrivé, et les deux sont tombés. **Aucune exemption n'a été
ajoutée** — exempter un identifiant aurait remplacé une preuve par une liste, et
la liste aurait grandi. Les deux propriétés ont été reformulées vers ce qu'elles
visaient vraiment :

> **Rien ne sort sans autorisation d'égression** — prouvé par le refus, plus par
> le vide.

Chacune porte désormais un contrôle négatif (`sortants.length > 0`) : le jour où
plus aucun outil ne déclare `networkRequired`, la boucle serait vide et le test
vert pour rien.

**Détail qui a failli rendre ces tests creux :** le Gateway valide le schéma
**avant** d'interroger la politique. Une entrée vide rendait `VALIDATION`, et le
test n'atteignait jamais la barrière qu'il prétendait éprouver. D'où la table
`ENTREES_VALIDES`, qui **échoue** sur un outil sortant sans entrée déclarée
plutôt que de laisser glisser le suivant.

### Sabotage

| Ligne remise dans son état fautif | Tests rouges |
|---|---|
| absence de fournisseur rendue comme agenda vide | **1 / 11** |
| panne du fournisseur avalée en agenda vide | **1 / 11** |

Deux défauts étroits, chacun couvert par le test écrit pour lui — et chacun
serait invisible en exploitation, ce qui est précisément pourquoi ils sont
testés.

### Condition de révision

Le jour où un adaptateur réel existe, `verification: 'NONE'` devra être
réexaminé : lire un agenda distant n'a rien à vérifier, mais un agenda qui répond
**partiellement** (page tronquée, fenêtre écrêtée côté serveur) est un cas que
cette ADR ne couvre pas — et qui ressemble beaucoup, encore une fois, à un agenda
vide.

---

## ADR-044 — Le premier effet externe, et ce qu'on refuse de promettre

**Statut :** accepté (Phase 3). **Référence :** `docs/02 §Phase 3`, `docs/03 §120`,
`docs/16 §3`, `docs/21 §2`, ADR-030, ADR-033, ADR-034, `docs/26 §4.6`.

### Ce qui change avec `calendar_create`

Les huit outils précédents écrivent dans PostgreSQL ou ne changent rien. Celui-ci
modifie un monde que nos transactions ne couvrent pas.

**Toute la machinerie construite ces dernières semaines existait pour ce cas
sans qu'aucun code de production ne l'exerce** : contrats d'effet, `UNKNOWN`
définitif, refus de rejeu, classification byzantine, deux mondes du banc. Le
constat mesuré avant d'écrire l'outil : `grep "effect:" src/tools/*.ts` ne
rendait que `NO_EXTERNAL_EFFECT` et `LOCAL_TRANSACTIONAL`.

### La propriété qui structure tout

> Une ligne absente après commit **prouve** l'absence.
> Un événement absent chez un fournisseur distant prouve seulement qu'il n'est
> pas là **à cet instant.**

D'où `verifiability: 'OBSERVABLE'` et un `readBack` qui rend `UNKNOWN` sur une
absence, jamais `FAILED`. L'utilisateur qui entendrait « échec » recréerait le
rendez-vous, et il en aurait deux — la requête peut arriver une seconde plus
tard (`docs/21 §2`).

### Les trois déclarations, chacune choisie CONTRE une option plus flatteuse

**`effect: 'EXTERNALLY_VERIFIABLE'`, et surtout pas `PROVIDER_IDEMPOTENT`.**

La signature `createEvent(event, operationId)` *invite* à déclarer l'idempotence :
la clé est là, le fournisseur pourrait dédoublonner. Mais **« pourrait » n'est pas
« garantit »**, et `PROVIDER_IDEMPOTENT` est le seul contrat externe qui autorise
un rejeu après `UNKNOWN` (ADR-034).

Aucun fournisseur n'existe. Le déclarer serait promettre **au nom** d'un
adaptateur que personne n'a écrit — et le jour où quelqu'un brancherait un CalDAV
qui ignore la clé, un rejeu créerait un second rendez-vous en silence. C'est la
déclaration la plus dangereuse du dépôt si elle était fausse.

**`maxRetries: 0`.** Une seconde requête après un échec réseau créerait un doublon
si la première a abouti sans que la réponse nous parvienne. Aucune observation de
notre part ne peut l'exclure.

**`attemptVerification: 'NONE'`** — une limite d'interface, pas une paresse.
`verifyEvent(id)` exige l'identifiant de l'événement, précisément ce qu'on n'a pas
après un crash. Détaillé en `docs/26 §4.6`, avec la divergence
`docs/16 §3` ↔ ADR-030 qu'il faut trancher.

**`autonomy: 'L3'`** — `docs/03 §120` nomme explicitement « déplacer un
rendez-vous » comme exemple d'APPROVAL. Le niveau est lu, pas déduit. Et le
fournisseur ne reçoit **rien** tant que la confirmation n'est pas donnée : une
action préparée n'a pas le droit de toucher le monde extérieur « pour préparer ».

### Sabotage

| Ligne remise dans son état fautif | Tests rouges |
|---|---|
| `readBack` conclut `FAILED` sur une absence | **1 / 12** |
| `effect` requalifié `PROVIDER_IDEMPOTENT` | **1 / 12** |
| `maxRetries` remonté à 2 | **1 / 12** |
| `L3` abaissé en `L2` | **2 / 12** |

**Le premier sabotage mérite d'être lu deux fois.** Un seul test rougit — et le
verdict rendu à l'utilisateur **reste `UNKNOWN`**, parce que
`constrainToVerifiability` dégrade tout `FAILED` venant d'un outil `OBSERVABLE`
(`engine.ts:200`). La redondance est donc réelle et non décorative, et il fallait
la mesurer pour le savoir. Le test qui rougit est celui qui empêche la barrière
de l'outil de pourrir sans bruit derrière celle du moteur.

### Ce qui n'est PAS fait

Aucun adaptateur. `calendar_delete`, déclaré comme outil inverse, n'existe pas —
ADR-019 l'autorise explicitement (« la capture est un enregistrement, pas une
exécution »), mais la dette rejoint `task_cancel`, `note_delete` et
`memory_forget` : **quatre outils inverses déclarés, zéro écrit.** L'Undo Engine
devra les livrer ensemble.

### Condition de révision

Le jour où un adaptateur réel existe, deux choses tombent et doivent être
reprises ici : `effect` peut devenir `PROVIDER_IDEMPOTENT` **si et seulement si**
le fournisseur documente sa déduplication par clé — la fiche `ReplaySafety`
d'ADR-034 exige alors un `independentOfObservation` démontrable, pas plausible.
Et un `findByOperationId` sur `CalendarProvider` rendrait `BY_OPERATION_KEY`
honnête.

---

## ADR-045 — Le fournisseur déclare ce qu'il a remplacé

**Statut :** accepté (Phase 3). **Référence :** ADR-042, ADR-019, ADR-038,
`docs/03 §120`, `docs/26 §4.7`.

### Le problème qu'ADR-042 ne pouvait pas résoudre deux fois

ADR-042 a établi qu'une modification ne se défait qu'en restaurant l'état
**observé**, et l'a obtenu par une fusion :

```sql
UPDATE tasks AS t SET … FROM tasks AS prior WHERE …
RETURNING …, prior.state AS prior_state
```

Une seule instruction, donc aucune fenêtre. **Chez un fournisseur distant, cette
fusion n'existe pas.** Il n'y a ni transaction commune, ni comparaison-et-échange.
Lire puis écrire laisse entre les deux un intervalle où le téléphone de
l'utilisateur peut modifier le même agenda — et la capture décrirait alors un
passé qui n'était déjà plus vrai au moment de l'écriture.

C'est exactement le défaut qu'ADR-042 a fermé, rouvert par la distance.

### La décision

> **On ne ferme pas la fenêtre. On déplace l'obligation.**
> Le fournisseur — seule partie à avoir réellement effectué l'échange — déclare
> ce qu'il a remplacé.

```ts
updateEvent(id, changes, operationId): Promise<Result<CalendarUpdate>>

interface CalendarUpdate {
  readonly previous: CalendarEvent;   // ce qu'il a remplacé
  readonly updated: CalendarEvent;
}
```

**L'obligation est dans la signature, pas dans une convention.** Un fournisseur
qui ne sait rendre que `updated` ne peut pas satisfaire `CalendarProvider` — et
c'est voulu : un système incapable de dire ce qu'il a remplacé ne peut pas
héberger d'action annulable, et il vaut mieux l'apprendre à l'écriture du premier
adaptateur qu'à la première annulation.

### Et on ne le croit pas sur parole

Le fournisseur vient de remettre l'état sur lequel repose toute possibilité
d'annuler. S'il parle d'un autre événement que celui demandé, la capture est
syntaxiquement parfaite — et le jour de l'annulation, Jarvis **écraserait un
tiers** avec cet état. Il détruirait un rendez-vous que personne n'a demandé de
toucher.

> Une capture inutilisable vaut mieux qu'une capture destructrice.

D'où le refus `INTEGRITY` quand `previous.id` ou `updated.id` ne correspond pas.

### Ce que la décision ne fait PAS

Elle n'établit pas une atomicité. `docs/26 §4.7` écrit le résidu : le `previous`
du fournisseur peut être périmé de quelques millisecondes, et deux modifications
concurrentes peuvent encore s'écraser. Le mécanisme qui fermerait les deux existe
et porte un nom — **la mise à jour conditionnelle** (`If-Match` sur un ETag, que
CalDAV expose). Il n'est pas ajouté aujourd'hui : un champ qu'aucun adaptateur ne
remplit serait spéculatif au sens de `docs/04`, et donnerait l'illusion d'une
garantie.

### Sabotage — et ce qu'il a trouvé dans MES TESTS

| Ligne remise dans son état fautif | Tests rouges |
|---|---|
| capture de l'état ÉCRIT au lieu de l'état remplacé | **2 / 15** |
| garde d'intégrité retirée (fournisseur cru sur parole) | **2 / 15** |
| demande vide acceptée | **1 / 15** |
| `readBack` conclut `FAILED` sur une absence | **0 / 14** ⚠ puis **1 / 15** |

**La dernière ligne est le vrai résultat de ce point.** Au premier passage, ce
sabotage ne cassait rien : `constrainToVerifiability` dégrade tout `FAILED` venant
d'un outil `OBSERVABLE`, donc le verdict rendu à l'utilisateur restait correct — et
la discipline propre de l'outil pouvait pourrir sans bruit derrière celle du
moteur.

ADR-044 avait pourtant nommé ce risque mot pour mot, et j'ai omis d'appliquer la
leçon au fichier suivant. Le test manquant a été ajouté, et le sabotage rejoué le
trouve.

> **La redondance ne se teste pas toute seule.** Chaque barrière a besoin de son
> propre test, sinon seule la dernière est réellement éprouvée — et rien ne
> signale que les autres ont cessé de tenir.

### Condition de révision

Au premier adaptateur réel : si le fournisseur expose un jeton de version,
`updateEvent` doit le prendre et le renvoyer, et `docs/26 §4.7` disparaît. S'il ne
l'expose pas, ce résidu devient irréductible pour ce fournisseur et remonte en
`docs/26 §5`.

---

## ADR-046 — Le disque se lit sous racine autorisée, ou pas du tout

**Statut :** accepté (Phase 3). **Référence :** `CLAUDE.md`, `docs/03 §106`,
`docs/05 §B2`, `docs/14 §2`, ADR-043.

### La borne est posée par `CLAUDE.md`, pas par moi

> Ne jamais donner un accès shell non contraint à un modèle.

`file_search` est le premier outil qui touche autre chose que PostgreSQL et un
fournisseur déclaré. La forme en découle : **une racine explicitement autorisée,
ou rien.** Pas de chemin libre, pas de valeur par défaut commode, pas de
« juste le répertoire personnel » — une racine par défaut serait exactement
l'accès non contraint, avec un nom rassurant.

Aucune racine n'est configurée aujourd'hui. L'outil s'enregistre quand même et
**refuse** (`CONFIGURATION`), pour la raison d'ADR-043 : « aucun fichier trouvé »
quand on n'a regardé nulle part est un mensonge sans erreur.

### Le confinement se fait sur le DISQUE, pas sur la chaîne

C'est le piège de cet outil, et il est facile à manquer :

```ts
resolve(racine, sousChemin)   // travaille sur le TEXTE
realpath(candidat)            // suit les liens
```

Un lien symbolique placé **dans** la racine et pointant dehors produit un chemin
qui commence par la racine et désigne autre chose. `resolve()` le laisse passer.
Seul `realpath` le démasque — et il faut l'appliquer à **chaque entrée
rencontrée**, pas seulement au point de départ : un lien posé au fond de
l'arborescence est découvert pendant la descente.

Un chemin absolu est refusé **avant** toute résolution : `resolve(racine, '/etc')`
rend `/etc`, l'argument absolu gagne silencieusement.

### Deux citations du pack, qui ne se devinent pas

**`docs/03 §106` nomme littéralement « chemin de fichier »** dans la liste des
paramètres sensibles. `sensitive: true` n'est donc pas une précaution, c'est une
citation — et le scénario réel est celui de `docs/05 §B10` transposé : un PDF
contient un chemin, le modèle le recopie, l'outil irait le lire. La confirmation
doit porter sur la valeur concrète.

**`docs/05 §B2`** fait du contenu d'un document une donnée possiblement hostile.
Ce que l'outil rend est étiqueté `EXTERNAL_UNTRUSTED` : de la donnée, jamais une
instruction.

### « Pas trouvé » ≠ « pas pu regarder »

Le mode de panne qui structure l'outil, et il est plus discret que celui de
l'agenda :

> Un fichier illisible **omis** transforme « je n'ai pas pu regarder partout » en
> « je n'ai pas trouvé ».

Et il est plus facile à commettre, parce qu'**ignorer une erreur de lecture
ressemble à de la robustesse**. D'où le champ `gaps` — `unreadable`,
`outsideRoot`, `depthLimited` — rendu explicitement. Une réponse honnête dit ce
qu'elle n'a pas pu voir.

Le chemin rendu est **relatif**. L'absolu révélerait l'arborescence de la machine
à quiconque lit la réponse, ou le journal, qui la conserve.

### Sabotage

| Ligne remise dans son état fautif | Tests rouges |
|---|---|
| confinement par chaînes (`resolve`) au lieu de `realpath` | **2 / 14** |
| erreurs de lecture avalées au lieu d'être comptées | **1 / 14** |
| aucune racine ⇒ résultat vide au lieu d'un refus | **1 / 14** |
| chemin absolu non refusé en amont | **1 / 14** |

### Une leçon sur les TESTS, pas sur le code

Le cas « répertoire illisible » a d'abord été écrit avec un `chmod 000`. Il est
resté **muet** : la suite tourne en root dans le conteneur, et root lit tout. Le
test aurait été vert ailleurs et sans effet ici — sans rien signaler.

Remplacé par un **lien symbolique cassé**, dont `realpath` échoue pour tout le
monde, root compris. Et l'assertion « le fichier caché n'apparaît pas » a été
retirée : elle n'est vraie que sous un utilisateur ordinaire.

> Une assertion vraie seulement sur certaines machines n'est pas une preuve.
> C'est un test qui ment la moitié du temps, et il ment du côté rassurant.

### Condition de révision

Le jour où une racine est réellement configurée, deux questions s'ouvrent et ne
sont pas traitées ici : la **lecture de contenu** (`readWithinRoot` existe, aucun
outil ne l'expose) et la **classification par racine** — `docs/14` place les
documents en `SENSITIVE`, ce que `PrivacyClass` à trois valeurs ne sait pas
exprimer. Même limite que l'agenda, même chantier (`docs/14 §5`).

---

## ADR-047 — Un briefing partiel se déclare partiel

**Statut :** accepté (Phase 3). **Référence :** `docs/05 §A7`, ADR-037, ADR-043,
`docs/26 §4.8`.

### Le mensonge d'ADR-043, élevé au cube

`docs/05 §A7` demande « agenda + tâches urgentes + points en attente », avec une
contrainte dure : **« Aucune modification. »**

La partie difficile n'est ni l'agrégation ni l'interdit d'écriture. C'est que
**les trois sources peuvent manquer indépendamment** :

> Un briefing qui présente deux tiers de la journée comme si c'était la journée
> entière ne se contente pas d'omettre — il **compose** une image cohérente et
> fausse.

Et il est plus difficile à repérer qu'un agenda vide : rien ne manque
visiblement. La réponse a la bonne forme, les bonnes rubriques, un contenu
plausible.

**Décision :** chaque section porte son propre état — `OK` avec son contenu, ou
`INDISPONIBLE` avec son motif. Aucune section ne peut être vide « par défaut ».

Et un drapeau `complet: false` en tête, parce qu'un lecteur pressé — humain ou
interface — regarde le contenu, pas l'état de chaque rubrique.

**Échouer entièrement serait excessif**, contrairement à `calendar_read` : les
tâches et les points en attente sont connus. Une réponse partielle vaut mieux
qu'aucune réponse — **à condition qu'elle dise qu'elle est partielle.**

### Ce que cet outil n'appelle PAS

Il ne passe **pas** par le Tool Gateway pour composer `calendar_read` et
`task_list`. Mesuré avant d'écrire : **aucun outil du dépôt n'invoque le
Gateway.** La composition d'outils — opérations imbriquées, baux imbriqués,
journaux imbriqués — est un terrain non éprouvé, et on ne l'inaugure pas dans un
outil de confort.

Le jour où elle sera un chantier assumé, le test structurel qui l'interdit ici
sera le premier à retirer, sciemment.

### Un défaut trouvé par la suite complète, pas par le test

Le test A7 passait **seul** et échouait **en suite complète**. La cause n'était
pas dans le test :

```sql
ORDER BY (due_at IS NULL), due_at ASC        -- tri PARTIEL
```

Toutes les tâches sans échéance étant ex æquo, PostgreSQL rendait un ordre libre.
Avec plus de `limit` tâches ouvertes, **deux briefings successifs pouvaient
montrer des tâches différentes sans que rien n'ait changé.**

> Un briefing irreproductible est pire qu'un briefing incomplet : il donne
> l'impression que la journée a bougé.

Corrigé par un tri **total** (`created_at DESC, id ASC`). Et le test crée
désormais une tâche avec échéance, ce qui le rend indépendant du reste de la
suite plutôt que chanceux.

### Les bornes du jour viennent de la base

`date_trunc('day', clock_timestamp())`, jamais `Date.now()`. Leçon d'ADR-037 : un
processus dont l'horloge dérive préparerait la mauvaise journée — **avec l'aplomb
de celui qui a tout regardé.**

### Sabotage

| Ligne remise dans son état fautif | Tests rouges |
|---|---|
| agenda absent rendu comme section `OK` vide | **1 / 9** |
| `complet` toujours vrai | **2 / 9** |
| bornes du jour calculées par le processus | **1 / 9** |

### Effet sur le contrat doré

**A7 quitte la liste des scénarios bloqués** : 25 couverts, 5 bloqués. Le
compteur est asserté dans `tests/golden/contract.test.ts`, qui aurait échoué si
on avait livré l'outil sans retirer l'entrée.

### Condition de révision

Si un jour le briefing doit **résumer** au sens fort — reformuler, hiérarchiser,
juger de l'urgence autrement que par une échéance — il lui faudra un modèle, et
cette ADR tombe : ce serait un outil d'une autre nature, soumis à `docs/15` et à
la règle « une sortie de modèle est une entrée non fiable ». Aujourd'hui,
« résumé » veut dire *présenté par rubriques*, et rien d'autre.

---

## ADR-048 — Un rappel qui ne sonne pas le dit

**Statut :** accepté (Phase 3). **Référence :** `docs/02 §Phase 3`, `CLAUDE.md`
règle 3, ADR-047.

### L'arbitrage, posé avant d'écrire

Mesuré : **il n'existe dans le dépôt ni ordonnanceur, ni minuterie applicative,
ni canal de notification.** Rien ne peut faire sonner quoi que ce soit à une
heure donnée.

> Un « rappel » qui ne sonne pas est un mensonge porté par son nom.

C'est la règle 3 — *jamais de succès non vérifié* — appliquée non pas à un effet
mais à une **promesse**. Et c'est sa forme la plus difficile à repérer : rien
n'échoue, rien ne s'affiche en rouge, la déception arrive des heures plus tard.

### Trois issues, et une seule tient

| | |
|---|---|
| ne pas écrire l'outil | `docs/02` le nomme ; réduire le périmètre n'est pas ma décision |
| l'écrire et se taire | exactement le mensonge ci-dessus |
| **l'écrire et le dire** | retenu |

**Décision :** l'outil crée le rappel et **déclare** qu'aucun mécanisme ne le
délivrera — `delivery: 'NONE'`, avec le motif en toutes lettres.

### Ce qui empêche que ce soit du théâtre

Un rappel stocké et invisible ne vaut rien. Il gagne son existence parce que
`briefing_generate` existe :

> Il ne sonne pas. **Il se présente.**

Une quatrième section a donc été ajoutée au briefing. A7 en nomme trois et n'en
interdit pas une de plus — son seul interdit porte sur la modification. Sans
elle, `reminder_create` ne livrerait rien du tout, et la promesse
`surfacedIn: ['briefing_generate']` serait le même mensonge, déplacé d'un cran.
D'où un test qui vérifie la promesse **là où elle est faite** : le rappel créé
doit apparaître dans le briefing.

### L'horloge de la base tranche, et doublement

`reminder_create` refuse une échéance déjà passée — puisque rien ne sonne, un
rappel créé dans le passé n'aurait aucune chance de servir. La comparaison est
faite par `clock_timestamp()`, jamais par `Date.now()` : l'échéance sera relue
par le briefing, qui interroge lui aussi l'horloge de la base. Deux horloges pour
un même fait produiraient un rappel accepté comme futur par l'outil et déjà
dépassé pour le briefing.

### Sabotage

| Ligne remise dans son état fautif | Tests rouges |
|---|---|
| `delivery` / `surfacedIn` retirés (promesse muette) | **1 / 7** |
| section rappels retirée du briefing | **1 / 7** |
| « déjà passé » tranché par le processus | **1 / 7** |

### La dette d'annulation, comptée

`reminder_cancel` est le **cinquième** outil inverse déclaré et non écrit, après
`task_cancel`, `note_delete`, `memory_forget`, `calendar_delete`. ADR-019
l'autorise explicitement — « la capture est un enregistrement, pas une
exécution » — mais le lot grandit à chaque outil mutant, et l'Undo Engine devra
les livrer ensemble.

### Condition de révision

Le jour où un ordonnanceur existe, `delivery` doit changer de valeur **et** le
mécanisme doit être vérifiable au sens de `docs/16` : « le rappel a sonné » ne
sera pas plus crédible que « l'email est envoyé » sans preuve de délivrance.

---

## ADR-049 — Un état qui ne peut pas alerter ne dit rien

**Statut :** accepté (Phase 3). **Référence :** `docs/02 §Phase 3`, ADR-019,
ADR-036, ADR-037.

### Le mode de panne d'un tableau de bord

> Un « tout va bien » est la réponse la plus facile à écrire et la plus facile à
> rendre fausse : il suffit de ne pas regarder, ou de regarder ce qui ne risque
> rien.

D'où trois choix de forme :

**Trois contrôles seulement**, chacun parce qu'il peut mal aller *sans bruit* :
la chaîne du journal (seule vérification qui invalide **rétroactivement** ce qui
a déjà été affirmé), les opérations sans issue, les instantanés d'annulation qui
expirent — sept jours, après quoi l'action devient définitivement non annulable
sans que rien ne le signale.

**Pas de « base OK ».** Si la base ne répondait pas, cet outil ne répondrait pas
non plus. Un contrôle qui ne peut pas échouer séparément de son appelant ne
mesure rien.

**`INCONNU` est un troisième verdict.** Ne pas avoir pu regarder n'est pas avoir
regardé, et fondre les deux est exactement ce qui rend un tableau de bord
rassurant et inutile. Le verdict global est le **pire** des contrôles, jamais une
moyenne.

### Le défaut que le premier test a démoli

Première rédaction du contrôle 2 :

```sql
WHERE state IN ('UNKNOWN', 'COMMITTED_TO_EXECUTION', 'EXECUTING')
```

**`system_status` est lui-même `EXECUTING` pendant qu'il compte.** L'observateur
se comptait dans ce qu'il observait, et le tableau de bord signalait une
opération en suspens *en permanence*.

> Une alerte toujours allumée est une alerte éteinte.

La correction n'a pas été de s'exclure par identifiant — emplâtre qui aurait
laissé passer toute autre opération en cours. Elle a été de distinguer **en vol**
d'**abandonné**, information que le bail porte déjà (ADR-035) :

| État | Lecture |
|---|---|
| `UNKNOWN` | terminal, observé, issue inconnue → un humain |
| en vol, bail **vivant** | quelqu'un travaille → rien à signaler |
| en vol, bail **périmé** | plus personne ne travaille → abandonnée |

### Le sens du `COALESCE` est INVERSE de celui d'ADR-036

Et c'est délibéré. ADR-036 décide s'il faut **laisser écrire** : *fail-closed* y
signifie « en cas de doute, refuser », donc un bail sans échéance vaut `infinity`.

Ici on décide s'il faut **prévenir un humain** : *fail-closed* signifie « en cas
de doute, prévenir ». Une opération déclarée en vol sans échéance de bail n'est
pas vivante pour l'éternité — c'est une anomalie, et elle se rapporte.

Deux directions opposées pour un même mot, parce que la question n'est pas la
même. Le noter ici évite qu'on « harmonise » un jour les deux.

### Sabotage

| Ligne remise dans son état fautif | Tests rouges |
|---|---|
| retour à la première rédaction (l'observateur se compte) | **2 / 9** |
| verdict global optimiste (`OK` dès qu'un contrôle est `OK`) | **3 / 9** |
| un contrôle retiré en silence | **3 / 9** |

### Condition de révision

Chaque nouveau mécanisme qui peut se dégrader silencieusement doit ajouter son
contrôle ici — et le compteur `controlesEffectues`, asserté en test, est ce qui
empêche qu'un contrôle disparaisse « parce qu'il était bruyant ».

---

## ADR-050 — Le Data Firewall se construit dans l'ordre qui ne peut pas élargir

**Statut :** accepté (Phase 4, étape F1). **Référence :** `docs/14`,
`docs/02 §Phase 4`, ADR-017, `docs/26 §4.5`.

### Ce qui distingue ce chantier de tous les précédents

**Tout ce que ce dépôt a construit jusqu'ici RÉTRÉCIT.** Le cloisonnement refuse
plus d'écritures, le bail refuse plus d'exécutions, `UNKNOWN` affirme moins,
`PROVIDER_CONTRACT_VIOLATION` retire une confiance. Un défaut dans l'un d'eux
bloque une action légitime — c'est ennuyeux, c'est visible, ça se corrige.

Le Data Firewall contient le premier pas dont le mode de panne est
l'**élargissement** : faire passer une donnée `GREEN` en `PUBLIC`, c'est-à-dire
*envoyable*. `docs/14 §5` le signale lui-même :

> ⚠ **à vérifier ligne par ligne avant migration.** Une donnée aujourd'hui
> `GREEN` par défaut d'attention deviendrait publiquement envoyable. **La
> migration doit défaillir plutôt que deviner.**

Un défaut là ne bloque rien. Il expose, en silence, et rien ne le signale.

### La décomposition, et le critère qui la fonde

| Étape | Direction | |
|---|---|---|
| **F1** `DataLevel` + classification, branchée à rien | pure | **fait** |
| **F2** le Policy Gate consulte le niveau **EN PLUS** de la règle existante | rétrécit | à venir |
| **F3** journal d'égression consultable | additif | à venir |
| **F4** migration des colonnes stockées | **élargit** | **pas sans relecture humaine** |

Le critère n'est pas la taille des étapes : c'est leur **direction**. F1 à F3 ne
peuvent que refuser davantage ou observer ; F4 est le seul qui autorise.

**F2 est possible sans F4**, et c'est ce qui rend la découpe utile plutôt que
dilatoire : en Cedar, `forbid` prime toujours sur `permit`. Ajouter un `forbid`
sur `niveau ≥ SENSITIVE + egress` ne retire aucune protection existante — la
règle `RED + egress → DENY` reste. La protection arrive donc **avant** la
migration des données, pas après.

### Ce que F1 livre

La table `DataCategory → plancher` de `docs/14 §3`, écrite **en toutes lettres**
plutôt que déduite d'une heuristique : une catégorie oubliée doit provoquer une
erreur de compilation, pas un repli silencieux vers le niveau le plus bas.

`strictest()` a été **généralisé plutôt que dupliqué**, parce que `docs/14 §3`
l'exige mot pour mot — « ce doit être le même code, pas un second mécanisme qui
lui ressemble ». Deux fonctions jumelles divergent toujours : l'une reçoit une
correction que l'autre ignore, et le jour où elles ne disent plus la même chose,
aucune ne fait autorité.

`fromLegacy` rend un **`Result`**, et c'est le cœur de l'ADR. `RED` et `ORANGE`
se convertissent seuls — ils ne peuvent que rester au moins aussi protégés.
`GREEN` n'est accepté que si la catégorie le confirme ; sinon la conversion
**échoue**, bruyamment, et la ligne remonte à un humain. C'est le seul endroit du
chantier où l'erreur exposerait une donnée : il rend donc une erreur là où il
serait tentant de rendre une valeur.

### Un module orphelin, déclaré comme tel

`wiring.test.ts` a signalé `privacy/classify.ts` dès son écriture — c'est son
travail, et c'était le résultat attendu. Il rejoint la liste des orphelins
déclarés avec son motif, à côté du CostGate, et le compteur est passé de six à
sept. **Il en sortira à F2, et le test le signalera si on l'oublie.**

### Sabotage

| Ligne remise dans son état fautif | Tests rouges |
|---|---|
| `OTHER` tombe sur `PUBLIC` (défaut ouvert) | **3 / 12** |
| la demande utilisateur écrase le plancher | **2 / 12** |
| `GREEN` se convertit silencieusement en `PUBLIC` | **1 / 12** |
| un ensemble prend le premier niveau au lieu du maximum | **1 / 12** |

### Le test que F1 ne peut PAS écrire

`docs/14 §6` nomme le plus important de ses sept :

> une donnée `SENSITIVE` n'atteint aucun palier cloud, **même si tous les
> paliers locaux sont indisponibles** — c'est celui qui prouve que le coût ne
> décide pas de la confidentialité.

Il n'est pas atteignable tant que rien n'appelle la classification. L'écrire
maintenant reviendrait à éprouver la simulation. Il arrive avec F2, et son
absence est écrite en tête du fichier de tests plutôt que passée sous silence.

### Condition de révision

Si `DataLevel` devait un jour remplacer `PrivacyClass` **avant** F2 — pour une
raison de calendrier, par exemple — cette ADR tombe : l'ordre est la décision,
pas les composants. Le reprendre à l'envers ferait du Data Firewall le rattrapage
d'un trou qu'on aurait ouvert soi-même.

---

## ADR-051 — L'égression se décide sur la destination, pas sur le trajet

**Statut :** accepté (Phase 4, étape F2). **Référence :** `docs/14 §5`,
`docs/26 §4.5` (levée), `docs/26 §4.9` (créée), ADR-050.

### Ce que F2 a rendu urgent

F2 applique la règle de `docs/14 §5` : **« niveau ≥ SENSITIVE + egress → DENY »**.
Elle est **ajoutée** à la règle `RED + egress`, jamais substituée — remplacer
reviendrait à la retirer le temps d'un commit, sur la foi d'une équivalence
qu'on croit vraie.

Mesuré immédiatement après le branchement : **les quatre outils sortants du
dépôt manipulent tous de l'agenda.** L'agenda est `CALENDAR`, donc `SENSITIVE`.
Ils devenaient donc **tous définitivement refusés — y compris sur un CalDAV
purement local.**

`docs/26 §4.5` cessait d'être une gêne théorique. Le défaut qu'elle décrivait
bloquait la capacité entière.

### Le défaut, et là où l'information existe

Un booléen répondait à deux questions :

| Question | Champ |
|---|---|
| l'appel quitte-t-il le **processus** ? | `networkRequired` |
| la destination est-elle hors de la **machine** ? | *(personne)* |

Ni le contrat d'outil (statique) ni le Gate (qui ignore les fournisseurs) ne
savent où va l'appel. **Le seul moment où c'est connu est le branchement** :
l'outil reçoit son fournisseur à la construction, et `ProviderCapabilities`
porte déjà `local`.

> **Décision :** `networkRequired` est dérivé du fournisseur, au branchement.

### Ce que la levée coûte — et pourquoi ce n'est pas gratuit

`capabilities.local` est une **déclaration** du fournisseur. Un adaptateur qui
mentirait échapperait au Gate. Avant, `networkRequired: true` était
inconditionnel et ce chemin n'existait pas.

**C'est un troc, et il est assumé.** L'alternative rendait la capacité
inutilisable — et une protection qui interdit l'usage normal n'est pas
conservée par les utilisateurs, elle est désactivée. La contrepartie est écrite
en `docs/26 §4.9` avec sa condition de levée : `isPrivateAddress` existe déjà et
saura corroborer l'adresse au premier adaptateur réel.

**Naming a residue is not the same as removing it.** §4.5 disparaît, §4.9
apparaît. Le solde est positif — un blocage total contre une déclaration à
vérifier — mais il n'est pas nul, et l'écrire est la seule façon de ne pas le
perdre de vue.

### Le niveau est DÉRIVÉ, jamais déclaré

`ToolDefinition` gagne `dataCategory` — **de quoi l'outil parle**, un fait. Le
niveau est calculé par le Gateway (`floorFor`).

> Si un outil déclarait son niveau, il suffirait d'écrire `PUBLIC` pour
> contourner la classification — et ce serait tentant le jour où un outil
> légitime se ferait refuser.

C'est `docs/14 §3` appliqué aux outils comme aux modèles : *« le système le
détermine avant lui »*.

### Le test que `docs/14 §6` désigne comme le plus important

> une donnée `SENSITIVE` n'atteint aucun palier cloud, **même si tous les
> paliers locaux sont indisponibles** — c'est celui qui prouve que le coût ne
> décide pas de la confidentialité.

Il était inatteignable à F1 faute d'appelant. **Il est écrit et il passe** : un
agenda cloud est refusé `POLICY_DENIED` avec `cloudEnabled: true`.

### Trois tests avaient annoncé leur propre fin, et ils ont tenu parole

| Test | Ce qu'il avait écrit |
|---|---|
| `calendar-read` §4.5 | « il DATE le constat et échouera le jour où le Data Firewall le rendra faux » |
| `classify` F1 | « le jour où ce test rougit, c'est que F2 a eu lieu — remplacé par la preuve du REFUS, pas par une exemption » |
| `wiring` orphelins | « il redescendra à F2 » — sept modules → six |

Aucun n'a été assoupli. Les trois ont été retournés en preuve de la correction.

### Un effet de bord qui mérite d'être dit

**Le dépôt n'a plus aucun outil sortant par défaut**, puisque aucun fournisseur
n'est configuré. Les deux tests de red team qui éprouvent « rien ne sort sans
autorisation » auraient donc bouclé sur le vide — verts par vacuité.

Ils construisent désormais une pile **avec un fournisseur cloud fictif**, pour
que la propriété ait de quoi s'éprouver. C'est plus honnête qu'assouplir
l'assertion : le jour où un fournisseur cloud existera, c'est exactement cette
configuration qui tournera.

### Sabotage

| Ligne remise dans son état fautif | Tests rouges |
|---|---|
| la règle ajoutée retirée du Gate | **2 / 35** |
| le niveau déclaré (`'PUBLIC'`) au lieu d'être dérivé | **2 / 35** |
| un fournisseur cloud traité comme local | **3 / 35** |

### Condition de révision

Si un fournisseur devait un jour être à la fois local ET distant — un cache
local d'un service cloud, par exemple — `capabilities.local` deviendrait
insuffisant : la question se poserait par requête, pas par fournisseur. Ce
serait une décision d'architecture, et elle passerait par ici.

---

## ADR-052 — Ce qui est parti s'écrit au moment où ça part

**Statut :** accepté (Phase 4, étape F3). **Référence :** `docs/05 §C4`,
`docs/02 §Phase 4`, ADR-041, ADR-051.

### Trois colonnes, et aucune n'est décorative

`docs/05 §C4` : « Montre-moi ce qui est parti sur Internet » → **destination,
classe de données, raison.** Aucune n'était enregistrée : le journal savait dire
qui a fait quoi avec quel verdict, pas **où c'est allé**.

« Trois requêtes sont sorties » ne répond à rien. La question porte sur ce qu'on
ne peut pas reconstituer soi-même.

### La source est le journal, et elle ne se déduit pas

Une console alimentée par une seconde table pourrait diverger — et le jour où
elles divergent, aucune ne fait autorité (ADR-041).

**Et surtout, rien n'est reconstitué après coup.** Déduire l'égression d'un
`networkRequired` relu plus tard serait « l'observateur redéfinit le passé »
appliqué à l'audit : depuis ADR-051 ce champ dépend du fournisseur branché, donc
un rebranchement réécrirait l'histoire. Les trois faits sont écrits **au moment
où la sortie a lieu**.

La destination vient de l'**outil** — le Gateway connaît le contrat, pas le
fournisseur. Prétendre le contraire produirait une console qui invente sa colonne
la plus utile.

### Le hachage : en queue, et seulement s'il existe

C'était le point délicat. La chaîne couvre une liste **ordonnée** de champs ; y
insérer trois positions changerait le hachage de toutes les lignes déjà écrites.
**Le seul mécanisme de preuve du dépôt deviendrait faux au moment précis où on en
ajoute un.**

```ts
const fields = [ …quinze champs…, prevHash ];
if (event.egress) fields.push(destination, dataLevel, reason);
```

Une ligne sans égression produit une liste byte-identique à l'ancienne — donc le
même hachage, donc une chaîne intacte. Une ligne avec égression étend la liste,
donc les trois faits sont couverts comme le reste. `JSON.stringify` d'un tableau
reste non ambigu : deux listes de longueurs différentes ne peuvent pas produire
la même sérialisation.

### Un sabotage qui n'a rien cassé — et ce qu'il a révélé

| Ligne remise dans son état fautif | Tests rouges |
|---|---|
| l'égression n'est plus journalisée | **1 / 15** |
| la console avale la raison | **1 / 15** |
| **l'égression sort du hachage** | **0 / 15** ⚠ puis **1 / 15** |

La troisième ligne est le résultat du point. **Retirer les champs du hachage ne
cassait aucun test** : la console C4 aurait affiché des destinations
réécrivables sans trace — une console d'audit falsifiable, c'est-à-dire pire
qu'aucune console.

Un test a été ajouté (`ledger-chain.test.ts`) : il écrit une ligne avec
égression, réécrit sa destination triggers désactivés, et exige que
`verifyChain` la déclare rompue. Le sabotage rejoué le trouve.

C'est la **troisième fois** de ce chantier qu'un sabotage révèle un test
manquant plutôt qu'un défaut de code. Le motif est stable : une barrière
redondante n'est pas testée par la barrière qu'elle double.

### Deux erreurs dans MES tests, dites plutôt que corrigées en silence

**Un test structurel interdisait un mot, pas un comportement.** Il proscrivait
`networkRequired` dans la console — et le trouvait dans le commentaire
expliquant pourquoi on ne s'en sert pas, puis, une fois les commentaires
dépouillés, dans la déclaration légitime de la console elle-même. La propriété
visée n'a jamais été « ce mot n'apparaît pas » mais « la console ne lit pas les
contrats des autres outils ».

**Un test était creux** : il assertait `count >= 0`. Le corriger a révélé un
fait notable — **aucun outil du dépôt ne peut produire une égression** : les
quatre qui sortent manipulent tous de l'agenda, donc `SENSITIVE`, donc refusés
par F2. La console C4 est livrée sans producteur en production, et le test
enregistre une sonde `WEATHER` — seule catégorie dont le plancher est `PUBLIC`.
Ce n'est pas un défaut : c'est la protection qui fonctionne.

### Condition de révision

Le jour où plusieurs sorties partagent une même opération, une ligne de journal
par opération ne suffira plus. Ce serait une table dédiée — et il faudra alors
répondre à la question que cette ADR évite : comment garder deux sources
d'accord.

---

## ADR-053 — La migration qui élargit ne s'applique pas toute seule

**Statut :** accepté (Phase 4, étape F4 — **écrite, non appliquée**).
**Référence :** `docs/14 §5`, `docs/29`, ADR-050.

### La seule migration du dépôt dont l'erreur expose

Toutes les autres rétrécissent. Un défaut y bloque une action légitime :
ennuyeux, visible, corrigible. Celle-ci **élargit** — une ligne `GREEN` mal
convertie devient `PUBLIC`, c'est-à-dire *envoyable*. Le défaut ne bloque rien,
il expose en silence, et rien ne le signale.

`docs/14 §5` exige une vérification **ligne par ligne** portant sur des données
réelles. **Ce n'est pas une décision d'agent.**

### La décision est portée par la STRUCTURE, pas par une note

Les fichiers vivent dans `migrations-en-attente/`, que `ops/db/migrate.ts` ne lit
pas. Une note « ne pas appliquer » dans un répertoire scanné serait une
discipline ; un répertoire hors chemin est un fait. Le jour où quelqu'un les
déplace, c'est un geste délibéré — pas un oubli.

Deux tests le vérifient : aucun fichier `data_level` dans `migrations/`, et
aucune colonne `data_level` en base.

### Elle refuse en NOMMANT ce qui bloque

Un refus qu'on ne peut pas instruire ne sert qu'à bloquer. La migration liste les
identifiants et leurs catégories, et rappelle la règle. `notes` n'ayant aucune
colonne de catégorie, **aucune** de ses lignes `GREEN` ne peut être confirmée :
leur seule présence bloque, par construction plutôt que par vigilance.

### Le test qui a failli appliquer ce qu'il devait empêcher

Première rédaction : `db.query('BEGIN')`, semis, migration, `db.query('ROLLBACK')`.
Sur un **pool**, ces quatre appels empruntent des connexions différentes. Le
`BEGIN` n'englobe rien, la migration s'auto-valide, le `ROLLBACK` annule une
transaction vide.

Mesuré : **la colonne `data_level` s'était réellement créée en base.** Un test
censé prouver que la migration n'est pas appliquée l'appliquait. Corrigé par
`db.transaction`, qui donne un client dédié.

> Le danger d'une migration n'est pas seulement dans son SQL. Il est aussi dans
> l'outillage qui prétend l'essayer sans l'appliquer.

### Ce qui reste vrai si elle n'est jamais appliquée

**La protection est déjà là.** F2 est livrée : une donnée `SENSITIVE` n'atteint
aucun palier cloud, même cloud activé. F4 n'ajoute pas de protection — elle rend
la classification plus fine en base, et conditionne le Model Router de
`docs/04 §10`.

Rien ne presse, et c'est exactement pour ça qu'elle attend. Marche à suivre en
`docs/29`.

### Condition de révision

Si `notes` gagnait une colonne de catégorie, son blocage inconditionnel
deviendrait excessif et cette ADR devrait être reprise — pas contournée.

---

## ADR-054 — Un chiffre qui n'est pas dans un test finit par mentir

**Statut :** accepté (correction de mesure — aucune fonctionnalité).
**Référence :** `docs/03 §2`, `docs/28 §2`, `tests/security/invariants-contract.test.ts`,
ADR-041 (une seule source qui fait autorité).

### Le fait

`docs/28` a publié pendant plusieurs sprints : « **9 des 15** invariants de
sécurité nommément référencés dans les tests ». La mesure — `\bS\d+\b` sur
`tests/` — en donne **sept** :

```text
référencés   S1 · S2 · S3 · S6 · S7 · S14 · S15
absents      S4 · S5 · S8 · S9 · S10 · S11 · S12 · S13
```

Le neuf avait été hérité d'un rapport antérieur et recopié sans être revérifié.
La moyenne de profondeur de preuve passe de **≈ 80 %** à **≈ 75 %**.

### Ce qui compte n'est pas l'écart, c'est sa direction

Il penchait du côté flatteur — le sens dans lequel une erreur survit le plus
longtemps, parce que rien ne pousse à la vérifier. Une erreur pessimiste se
fait corriger par le premier lecteur qui se sent lésé ; une erreur optimiste
attend qu'on la cherche.

C'est la deuxième fois exactement. `docs/05` avait déjà connu la même dérive :
quatorze scénarios dorés sans aucun test, invisibles parce que rien ne les
comptait. La réponse d'alors n'avait pas été d'écrire les tests manquants —
c'avait été de **lier le document à la suite** (`tests/golden/contract.test.ts`).

**On avait tiré la leçon sur un document et pas sur l'autre.** La règle
généralisée : *tout chiffre publié sur l'état du système vit dans un test, ou
il dérive.*

### La décision

`tests/security/invariants-contract.test.ts` fait pour `docs/03` ce que le test
doré fait pour `docs/05`. Trois états, et le deuxième est une dette :

| | | |
|---|---|---|
| **NOMMÉ** | un test cite `Sn` | rien à dire |
| **TRACÉ** | la propriété est éprouvée ailleurs | la preuve est **désignée** |
| **NON EXIGIBLE** | le sous-système n'existe pas | l'absence est **vérifiée** |

### « Non nommé » n'est pas « non prouvé »

Distinction essentielle, et c'est elle qui rend le chiffre lisible. S8 — *toute
sortie réseau est contrôlée par la politique* — est tenu par le Data Firewall
depuis F2 : la propriété est éprouvée, seul le nom manque.

Compter les noms mesure la **traçabilité** de la preuve, pas son existence.
Fondre les deux donnerait un nombre qu'on ne saurait plus interpréter — et
c'est probablement ainsi qu'un « 7 » est devenu « 9 ».

### Ce qui empêche le registre d'être une liste d'excuses

Chaque déclaration est **falsifiable** :

- un **TRACÉ** désigne des fichiers qui doivent exister **et porter un marqueur
  précis**. Effacer l'assertion qui porte l'invariant suffit à faire rougir le
  test — pas seulement supprimer le fichier ;
- un **NON EXIGIBLE** désigne un chemin qui doit rester **absent**. Le jour où
  `src/core/update` existe, l'exemption de S11 tombe d'elle-même.

Trois sabotages le confirment : retirer `S8` du registre → 2 tests rouges ;
fausser un marqueur → rouge en nommant l'invariant ; créer `src/core/update` →
l'exemption S11 rouge.

### Deux réserves sont chiffrées plutôt que fondues

| | Ce que la preuve ne couvre pas |
|---|---|
| **S12** | la **capture** de quoi défaire est prouvée, pas l'**exécution** : cinq outils inverses déclarés, **zéro écrit**, aucun moteur ne rejoue une capture |
| **S13** | le cloud est éteint **en dur** — `config/default.json` expose `cloud.enabled`, le runtime écrit `false` en littéral. L'invariant dit que l'**utilisateur** peut l'éteindre ; ce n'est pas la même phrase |

S13 est le motif « CostGate » une deuxième fois : **tenu par absence, pas par
mécanisme**. Le compter comme acquis aurait produit un registre plus flatteur
et moins vrai.

### Le correctif qui a rougi deux fois pour rien

Le marqueur cherchait `l'appel` dans un source où il est écrit `l\'appel`. Le
test signalait une preuve manquante là où seule la syntaxe différait. Corrigé
par `sansEchappement`, avec son contrôle négatif — une normalisation trop large
rendrait *tout* marqueur trouvable, donc le test vert quoi qu'il arrive.

> Un test structurel doit viser la propriété, jamais l'encodage. Même
> raisonnement que `stripComments`, qui existe déjà pour empêcher un test de
> proscrire un vocabulaire au lieu d'un comportement.

### Condition de révision

Si un invariant devenait vérifiable par exécution plutôt que par citation, sa
ligne devrait quitter ce registre pour un vrai test. Ce fichier mesure la
traçabilité ; **il ne prouve aucun invariant, et ne doit jamais être invoqué
comme s'il le faisait.**

---

## ADR-055 — Un outil déclare ce que vaut sa sortie, et la quarantaine entre en circuit

**Statut :** accepté (Phase 3 point 6 — `web_search` ; ADR-004 mis en circuit).
**Référence :** `docs/03 §3`, `docs/05 §B4`, `docs/26 §4.1`, ADR-004, ADR-054.

### Le fait qui rendait ADR-004 décoratif

`docs/26 §4.1` recensait `quarantine/processor.ts` — la séparation
Privileged/Quarantined, **défense principale contre T1** — comme :

> implémentée, testée, **JAMAIS APPELÉE** : rien n'ingère aujourd'hui de contenu
> externe.

Ce n'était pas un défaut tant que rien n'ingérait. Ça le devenait au premier
outil qui rapporterait du contenu de tiers. `web_search` est cet outil, et il
arrive **après** le Data Firewall — sans classification, une requête sortante
n'aurait été bornée par rien.

### Le champ qui manquait

Le Tool Gateway n'avait aucun moyen de savoir qu'une sortie contenait du texte
écrit par un inconnu. `ToolDefinition` gagne :

```ts
readonly outputProvenance: Provenance;   // TOOL_OUTPUT | EXTERNAL_UNTRUSTED
```

**Dans la DÉFINITION, pas dans l'exécution** — même discipline que
`dataCategory`. Le laisser à l'exécution reviendrait à ce que la valeur
potentiellement hostile choisisse sa propre étiquette.

Le champ est **obligatoire**, sans valeur par défaut : les quinze outils
existants ont dû se déclarer. Un défaut aurait laissé un futur outil ingérant
passer pour du `TOOL_OUTPUT` par omission — le mode de panne exact qu'on veut
rendre impossible.

### Deux règles de contrat, et la seconde ferme un trou réel

| | |
|---|---|
| Une sortie ne vaut que `TOOL_OUTPUT` ou `EXTERNAL_UNTRUSTED` | `USER`/`SYSTEM`/`MEMORY` permettraient de rendre du contenu web comme une parole de l'utilisateur |
| **Un outil qui ingère est en LECTURE SEULE** | ingérer et muter dans le même appel supprime la frontière : le contenu hostile atteint l'effet sans repasser par le Policy Gate |

### `sealExternal` — un chemin sans modèle, et il n'affaiblit rien

`createQuarantine` suppose qu'un modèle extraie une donnée typée d'un texte
libre : c'est le cas d'un email ou d'un PDF. Ce n'est pas celui d'un
fournisseur qui rend déjà `{ title, url }` — la structure existe, seuls les
contenus viennent de tiers.

Exiger un modèle là où il n'y a rien à extraire aurait un coût et un seul effet :
décourager l'ingestion, donc **laisser la séparation hors circuit**. Ce qui est
scellé est identique dans les deux chemins : l'étiquetage n'est pas conditionnel,
et la détection d'injection est la même fonction. **Le modèle n'a jamais été la
protection** — il est l'outil d'extraction.

### B4 — on REFUSE, on n'assainit pas silencieusement

`docs/05 §B4` dit « la requête web est minimale et **assainie** ». Retirer
discrètement un IBAN produirait le pire résultat : l'utilisateur croit avoir
cherché ce qu'il a écrit, obtient autre chose, et **rien ne le lui dit**.

On refuse donc, **avant tout appel réseau**, en nommant la NATURE de ce qui
bloque — jamais sa valeur, qui atterrirait dans le journal. C'est plus strict
que « assaini », et `CLAUDE.md` tranche : la sécurité gagne.

Le détecteur est **explicitement pas la protection principale** contre T2 — le
Data Firewall l'est, en amont, par le niveau de la donnée. Il attrape ce que le
niveau ne voit pas : un identifiant glissé dans une requête `PERSONAL`
légitime. Un détecteur pris pour une barrière est le mensonge le plus coûteux
qu'on puisse écrire.

### Le faux négatif sur le mot que B4 nomme

Premier motif de montant : `…(?:€|EUR|euros?|\$|USD)\b`. Le `\b` final ne peut
jamais s'ancrer après `€` ou `$` — caractères non-mot, et une frontière exige
une transition. **`1 250,00 €` passait au travers**, sur l'exemple même que B4
cite (« identifiants, **montants** ou données personnelles »).

Le contrôle négatif l'a trouvé ; le cas nominal seul ne l'aurait pas fait.

### Ce que cette étape a révélé sur le test doré — et qui est CORRIGÉ

`docs/28` affirmait, à propos de `tests/golden/contract.test.ts` :

> le compteur `couverts/bloqués` aurait échoué si on avait livré l'outil sans
> retirer l'entrée.

**C'était faux, et mesuré comme tel :**

```text
couverts = ids.length - bloques          ← ne lit pas le code
bloques  = Object.keys(BLOQUES).length   ← ne lit pas le code
```

Les deux assertions se calculent uniquement à partir de la table. Livrer
`web_search` en laissant `B4` déclaré bloqué laissait le test **vert**.

C'est la même classe de défaut qu'ADR-054 : *une affirmation sur un mécanisme
que le mécanisme ne fournit pas*. Deuxième occurrence en deux sprints, sur deux
documents différents.

**Corrigé de la même manière :** chaque entrée bloquée déclare désormais ce qui
doit rester **absent**, et le test le vérifie — le registre des outils ne
mentionne pas la capacité, ou `wiring.test.ts` liste encore le module comme
orphelin. Un sabotage le confirme : réintroduire `B4` alors que `webSearchTool`
est enregistré fait rougir le test en le nommant.

### Ce qui bouge, mesuré

| | Avant | Après |
|---|---|---|
| Scénarios dorés couverts | 26/30 | **27/30** (B4 payé) |
| Modules de logique hors circuit | 6 | **5** (`quarantine/processor.ts` branché) |
| Outils enregistrés | 15 | **16** |

### Condition de révision

Le jour où un outil devra appeler un modèle, `MODEL_OUTPUT` deviendra une
sortie légitime et la première règle de contrat devra être reprise — **pas
contournée**. De même, si un besoin réel d'ingestion mutante apparaît, il faudra
deux outils et un passage par le Policy Gate entre eux, jamais un assouplissement
de la seconde règle.

---

## ADR-056 — Un test qui corrompt un objet partagé doit le rendre intact

**Statut :** accepté (infrastructure de test — aucun changement produit).
**Référence :** `docs/26 §2.3`, ADR-012, ADR-055.

### Trouvé en ajoutant un fichier, pas en cherchant

`tests/security/ledger-chain.test.ts` corrompt **délibérément** l'Event Ledger —
triggers désactivés, ligne réécrite — pour prouver que le chaînage par hash
détecte l'altération quand les deux premières barrières tombent. C'est un bon
test, et il doit exister.

Deux de ses cas ne remettaient pas l'état :

| Cas | Ce qui restait après |
|---|---|
| modification de contenu | `status = 'FAILED'` — chaîne rompue |
| **suppression de maillon** | **le maillon manquant, définitivement** |

Le journal est **partagé par toute la suite**. Quatre fichiers y appellent
`verifyChain()`, et `system_status` le fait en production.

**Mesuré :** `intent/flow.test.ts` — « la chaîne d'audit reste intacte après une
session complète » — **vert seul, rouge en suite complète**. Ajouter
`web-search.test.ts` a suffi à déplacer l'ordonnancement.

### Ce qui rendait le défaut invisible

Le second cas se « réparait » incidemment : le test SUIVANT du même fichier
remettait le statut du premier.

> Une dépendance d'ordre entre deux `it()` n'est pas un mécanisme. C'est une
> coïncidence — qu'on remarque le jour où elle cesse.

### La tentation, et pourquoi elle était mauvaise

Le réflexe naturel devant un test rouge en suite et vert seul est de le
soupçonner, lui. **L'assertion avait raison :** c'est la seule vérification
d'intégrité de bout en bout du dépôt, et la relâcher aurait supprimé la
détection au moment précis où elle venait de fonctionner.

### La décision

1. **Rendre l'objet intact.** Le maillon supprimé est sauvegardé puis réinséré
   par `CREATE TABLE … AS SELECT *` — sans énumérer les colonnes, qui se
   périmeraient à la prochaine migration. C'est exactement ce qui est arrivé
   aux champs d'égression (ADR-052), et la leçon se réapplique ici.
2. **Exclure les lecteurs pendant la fenêtre.** `withLedgerExclusive` prend un
   verrou consultatif PostgreSQL sur une transaction dédiée. **Côté tests
   uniquement** — le produit n'apprend rien de la suite qui l'exerce.

`pg_advisory_xact_lock` et non sa variante de session : sur un pool, une
connexion rendue conserverait un verrou de session et le relâcherait à un
moment qu'on ne contrôle pas.

### La règle qui généralise

> On ne peut pas vérifier globalement l'intégrité d'un objet pendant qu'on le
> corrompt volontairement ailleurs. Un test qui casse un invariant partagé doit
> **le rétablir** et **exclure les autres** pendant qu'il le casse.

### Condition de révision

Si la suite passait à une base par fichier de test, l'exclusion deviendrait
inutile — mais la **restauration** resterait exigible : elle protège aussi les
`it()` du même fichier les uns des autres.

---

## ADR-057 — L'arrêt d'urgence, et un scénario CRITIQUE compté par collision de chaîne

**Statut :** accepté (`docs/05 §C2`).
**Référence :** `docs/05 §C2`, `docs/26 §5`, ADR-035 (I17), ADR-055, ADR-056.

### Le fait, d'abord

`docs/05 §C2` — **Arrêt d'urgence**, marqué `CRITIQUE` — était compté parmi les
27/30 scénarios couverts. Aucune capacité de ce genre n'existait.

Le compteur cherchait `\bC2\b`. Le seul « C2 » du dépôt vivait dans
`intent-journal.test.ts` : « matrice adversariale **ligne C2** » — la ligne d'un
tout autre tableau.

**Un identifiant de deux caractères est trop court pour valoir preuve.** La
reconnaissance exige désormais un rattachement : `05/C2`, `docs/05 … C2`,
`**C2**`, ou un titre de test `'C2 — …`.

> Et la première version de cette règle était **trop stricte** : elle exigeait
> `05/` collé à l'identifiant et perdait `B3`, cité dans « scénarios 05/B1, B2,
> B3, B10 ». Un filtre qui resserre trop invente des trous et fait perdre
> confiance dans les vrais.

C'est la **troisième** dérive de la même famille en trois sprints — après le
« 9 des 15 » (ADR-054) et le compteur doré creux (ADR-055).

### Ce n'est pas un outil, et c'est la première décision

Un outil franchit le Policy Gate, qui peut le refuser. **Un arrêt d'urgence que
la politique peut refuser n'est pas un arrêt d'urgence** — et le moment où l'on
appuie sur le bouton est précisément celui où quelque chose ne va pas.

`engage()` est donc une primitive du noyau, appelable directement.

### En base, parce qu'un arrêt que le redémarrage efface n'en est pas un

Le cas visé est celui où le processus peut tomber. Une histoire (une ligne par
engagement) plutôt qu'un booléen : les questions qui comptent après coup sont
« qui, quand, pourquoi, et qui a levé ». L'état courant est **dérivé** — arrêté
⇔ il existe une ligne non relevée — et un index partiel unique interdit deux
arrêts actifs.

### La dissymétrie engager / lever

| | |
|---|---|
| **ENGAGER** | sens sûr. Un modèle manipulé qui déclenche un arrêt n'obtient qu'un Jarvis arrêté : bruyant, visible, sans dommage. Non contraint, et **idempotent** — « stop » tapé trois fois par quelqu'un qui panique ne doit pas échouer sur une violation d'unicité. |
| **LEVER** | sens dangereux. Seul `USER` y est autorisé. Sans cette règle, une injection indirecte enchaînerait arrêt → levée et n'aurait fait que du bruit. |

Lever un arrêt inexistant est une **erreur**, pas un succès silencieux : rendre
`ok` laisserait croire qu'on vient de rétablir quelque chose.

### Ce que l'arrêt bloque — plus large que la lettre, et assumé

`docs/05` dit « actions **externes** bloquées ». S'y tenir laisserait Jarvis
écrire dans la mémoire de l'utilisateur après qu'il a dit « stop ».

On bloque donc tout ce qui n'est pas une **lecture locale** (`L1` ET
`networkRequired === false`). `audit_query`, `system_status` et `egress_review`
restent disponibles — après avoir appuyé sur le bouton, on a **plus** besoin de
comprendre, pas moins. C'est le raisonnement de l'invariant I12, qui place déjà
sa garde après l'observation et non avant.

### Ce que l'arrêt NE fait PAS, et qui est écrit plutôt que tu

Il n'annule pas une requête déjà partie. `docs/26 §5` l'établit comme
irréductible. Une opération `COMMITTED_TO_EXECUTION` a peut-être produit son
effet ; la marquer annulée effacerait la seule trace qu'une requête est partie.

`engage()` rend donc **deux compteurs séparés** — `cancelledPending` et
`inFlightUntouched` — jamais fondus en un chiffre rassurant. `docs/05 §C2` dit
« actions **en attente** annulées », pas « en vol » : le document et la limite
disent la même chose.

### L'état s'appelle `PLANNED`, et j'avais supposé `PENDING`

Avec la mauvaise valeur, l'`UPDATE` aurait trouvé **zéro ligne** : aucune
erreur, aucun test rouge, et un arrêt d'urgence qui n'annule rien. Le nom est
désormais éprouvé sur des lignes réelles.

L'invariant **I17** classe cette écriture `PRE_LEASE` — la catégorie prévue pour
un compare-and-swap sur un état d'où aucun effet externe n'est possible. Vérifié
en exécutant le classifieur, pas en le supposant.

### Le sabotage qui n'a rien attrapé

Remplacer `if (!rows.ok) return rows;` par `return ok({ halted: false })`
laissait **les treize tests verts**. C'est pourtant le mode de panne le plus
coûteux du fichier : une panne de lecture transformée en autorisation d'agir.

Deux tests ajoutés — un `Db` en échec pour la primitive, un `REVOKE SELECT` réel
pour le Gateway (restauré dans un `finally`, discipline d'ADR-056).

> **Troisième fois qu'un sabotage révèle un test manquant plutôt qu'un défaut
> de code.** Le motif est stable : *un chemin d'erreur que rien ne provoque
> n'est pas éprouvé, il est seulement écrit.*

### Le verrou est LU, jamais reçu

Comme `egress` (ADR-052), l'état d'arrêt est établi par une lecture de la base
dans le Gateway, pas fourni dans `call.context` — sinon il suffirait de mentir
sur un champ pour traverser l'arrêt d'urgence.

Et l'`EmergencyHalt` est **construit** par le Gateway, jamais injecté : une
doublure répondant toujours « pas arrêté » rendrait la protection invisible dans
tous les tests de bout en bout. `stack.ts` pose la règle — « aucun composant
simulé côté sécurité ».

### Condition de révision

Le jour où une sortie en flux existera, « sorties interrompues » deviendra
exigible et cette ADR devra être reprise : aujourd'hui rien ne stream, et le
prétendre serait un mensonge porté par un nom.

---

## ADR-058 — Un chiffre publié vit à un seul endroit, ou il diverge

**Statut :** accepté (cohérence documentaire — aucun changement fonctionnel).
**Référence :** ADR-041, ADR-054, ADR-055, ADR-057,
`tests/architecture/coherence-des-chiffres.test.ts`.

### Quatre fois le même défaut, en quatre sprints

| | |
|---|---|
| ADR-054 | « 9 des 15 invariants » — la mesure en donnait **7** |
| ADR-055 | « le compteur aurait échoué » — il ne lisait que sa propre table |
| ADR-057 | un scénario **CRITIQUE** compté couvert par collision de chaîne |
| **ici** | **`docs/28` se contredisait LUI-MÊME** |

Le quatrième est le plus embarrassant : `## 1. Étendue fonctionnelle — ≈ 65 %`
et le bloc de synthèse final du **même document** affichaient 65 % et 64 %,
76 % et 80 %. Deux corrections successives avaient touché les sections sans
toucher le résumé, cent lignes plus bas.

Et il n'était pas seul. Balayage complet des documents d'état :

```text
README      « ≈ 51 % » d'étendue      — périmé de deux révisions
README      « 670 tests » ligne 82
README      « 154 tests » ligne 141   — deux comptes contradictoires
README      « 670 tests » ligne 168     dans le MÊME fichier
QUICKSTART  « 345 tests »             — périmé de plusieurs sprints
README      récit des outils arrêté à `system_status` — `egress_review` et
            `web_search` existaient sans y figurer, sous une introduction qui
            annonçait encore « les sept outils écrits » devant dix noms
```

### La cause n'est pas l'inattention, c'est la DUPLICATION

Corriger le quatrième défaut sans corriger la cause aurait garanti un
cinquième. Et le dépôt connaît déjà cette cause — ADR-041 l'a tranchée pour les
données :

> Une console alimentée par une seconde table pourrait diverger — et le jour où
> elles divergent, aucune ne fait autorité.

C'est exactement ce qui est arrivé à la documentation. L'étendue fonctionnelle
vivait à trois endroits ; les trois ont fini par dire trois choses.

### La décision

**`docs/28` est la seule source des chiffres du projet.** README et QUICKSTART
n'en republient aucun : ils pointent vers lui.

Un compte de tests ne peut d'ailleurs pas être vérifié sans exécuter la suite.
Le figer en prose garantit qu'il se périme — on le retire, et on garde la
commande qui produit la vérité.

### Ce que le test vérifie, et ce qu'il ne peut pas vérifier

| Vérifié | Comment |
|---|---|
| cohérence interne de `docs/28` | résumé = en-têtes ; TOTAL = titre ; moyenne = moyenne de ses lignes |
| fidélité au réel | ADR, outils, scénarios dorés, invariants : **comptés**, pas relus |
| accord avec les tests qui portent la mesure | le chiffre publié doit être celui que `contract.test.ts`, `invariants-contract.test.ts` et `wiring.test.ts` figent |
| non-duplication | aucun compte de tests ni pourcentage concurrent ailleurs |
| exhaustivité du README | chaque outil enregistré y est nommé |

**Il n'établit PAS que les pondérations de `docs/28 §1` sont justes.** Ce sont
des jugements, écrits pour être contestés, et aucun test ne tranche un jugement.
Il établit qu'un chiffre écrit quelque part correspond à ce qu'on peut compter
ailleurs — c'est tout, et c'est précisément ce qui manquait.

### La règle qui va dans l'autre sens, et qui est figée aussi

`docs/09`, `docs/11`, `docs/12` sont des **audits datés**. « 121 tests »,
« 345 tests » y sont des constats d'alors. Les mettre à jour serait falsifier un
rapport et rendrait incompréhensible la progression qu'ils documentent.

Le test l'exige explicitement : ces documents **doivent** continuer à porter
leurs chiffres d'époque. Sans cette clause, un futur balayage « de cohérence »
les corrigerait par excès de zèle — et personne ne le remarquerait.

### Cinq sabotages

Résumé divergent · compte de tests réintroduit dans le README · `docs/26`
annonçant six modules quand `wiring.test.ts` en dit cinq · compte d'ADR faussé ·
moyenne ne suivant plus ses lignes. Chacun fait rougir exactement le test visé,
et aucun autre.

### Condition de révision

Si `docs/28` cessait d'être tenu à jour, ce test deviendrait un frein plutôt
qu'une garde : il faudrait alors retirer les chiffres du document plutôt que
d'assouplir le test. Un chiffre qu'on n'entretient pas doit disparaître, pas
devenir approximatif.

---

## ADR-059 — Une garde non sabotée n'est pas une garde

**Statut :** accepté (preuve — aucun changement fonctionnel).
**Référence :** ADR-016, ADR-057, `docs/26 §2.6`, `tests/security/refus-eprouves.test.ts`.

### L'hypothèse, et pourquoi ce n'est pas de la chasse au pourcentage

ADR-057 s'est terminée sur une observation isolée : un sabotage du repli fermé
de l'arrêt d'urgence n'avait **rien** fait rougir.

> Un chemin d'erreur que rien ne provoque n'est pas éprouvé. Il est seulement
> écrit.

On en a fait une **hypothèse testable** : prendre les branches non couvertes des
modules de sécurité, et saboter chacune.

Viser un taux de couverture aurait produit des tests là où c'est facile. La
question posée est plus étroite et plus utile : *cette garde-ci tient-elle si on
la retire ?*

### Le résultat — quatre gardes, zéro test

```text
ledger.ts    validation à la frontière retirée   → 89 tests verts
vault.ts     inspection rendant le secret NU     → 72 tests verts
halt.ts      levée sans note acceptée            → 16 tests verts
event.ts     empreinte sans repli                → 89 tests verts
```

**La deuxième est la plus grave.** `Secret[inspect.custom]` est la garde
anti-fuite de la Phase 0 : c'est elle que Node appelle pour
`console.log(secret)`. `toString()` et `toJSON()` étaient éprouvés — la
concaténation et la sérialisation. Pas l'affichage, qui est le plus fréquent des
trois.

**La première est la plus contradictoire.** ADR-016 fait de la validation aux
frontières une obligation — « un `as` sur une frontière est un défaut ». Le
journal l'avait ; rien ne prouvait qu'elle tenait.

### Le sabotage qui ne prouvait rien

Le premier sabotage du coffre écrivait `this.value` là où le champ s'appelle
`#value`. Il rendait `undefined` : les tests restaient verts **pour une raison
sans rapport**, et j'ai failli conclure. Refait avec `this.#value`, il a
confirmé le trou.

> Un sabotage qu'on ne vérifie pas est une conclusion qu'on s'offre.

### Ce qui est délibérément laissé sans test

Deux branches non couvertes sont des **gardes sur états impossibles** —
`INSERT … RETURNING` sans ligne, arrêt inscrit sans identifiant. Elles existent
parce que `noUncheckedIndexedAccess` l'exige, pas parce que le cas survient.

Les tester demanderait de fabriquer un monde qui n'existe pas ; les supprimer
transformerait un refus nommé en plantage plus loin. **On les garde et on dit
pourquoi elles ne sont pas testées** — c'est la seule des trois options qui ne
mente pas.

Restent ouvertes, nommées : le rejeu dont la relecture échoue (`gateway.ts`), et
le cas d'un secret manquant, aujourd'hui inatteignable puisque **aucun outil du
dépôt ne déclare de secret requis**.

### La trouvaille latérale : un test qui ne passait que 23 heures sur 24

Pendant le balayage, `reminders.test.ts` a rougi sans rapport avec le sabotage.
Cause : il plaçait un rappel « dans une heure » et attendait de le voir dans le
briefing. Or le briefing borne à `date_trunc('day', clock_timestamp()) +
1 day`. **Entre 23 h et minuit, « dans une heure » tombe demain.**

Le produit avait raison — un rappel de demain n'est pas dans le briefing
d'aujourd'hui. C'est le **test** qui supposait que « dans une heure » restait
aujourd'hui.

Corrigé par la doctrine du dépôt (ADR-036/037) : **la fenêtre est calculée par
la base**, jamais devinée par le processus. Le test demande à la base où finit
la journée et place le rappel à l'intérieur.

> Il aurait été classé « flaky » par quiconque l'aurait croisé une fois — et
> c'est exactement ainsi qu'un défaut d'horloge survit.

Vérification la plus forte possible : le correctif a été validé **à 23 h 12 UTC**,
dans la fenêtre précise où le test échouait.

### Condition de révision

Si un outil venait à déclarer un `requiredSecrets` non vide, le refus
correspondant deviendrait atteignable et devrait être éprouvé le jour même —
pas ajouté à une liste.

---

## ADR-060 — Une porte qui éprouve un module ne franchit pas une phase

**Statut :** accepté (correction de mesure — aucun changement fonctionnel).
**Référence :** `docs/02 §Phase 1`, `docs/26 §4.12`, ADR-004, ADR-058.

### Ce qui a été cherché, et ce qui a été trouvé à la place

La question posée était : *reste-t-il une zone d'ombre avant de continuer ?*
Le candidat suivant était le **Model Router**, dernier ✗ de la Phase 4.

**Il n'est pas justifié, et l'argument tient en une ligne.** `docs/05 §C5`
demande « fournisseur cloud indisponible → **Jarvis fonctionne** ». C'est déjà
vrai, trivialement : aucun modèle n'est dans la boucle. Écrire un routeur pour
le prouver serait circulaire — prouver une propriété d'un composant hors du
chemin produit — et ajouterait un sixième module orphelin.

La position déjà écrite dans `exfiltration.test.ts` — « les simuler ne
prouverait que la simulation » — **tient**. Ma contestation a échoué, et c'est
le résultat.

### Le vrai trou était ailleurs, et il était dans un chiffre

`docs/02` liste parmi les livrables de la **Phase 1** : « Context Engine :
résolution … détection d'ambiguïté ». Sa porte coche :

> Face à trois « Pierre » connus, **Jarvis** demande — il ne choisit pas.

Or `ops/gates/phase1.ts` appelle `createEntityResolver` **directement**. Son
libellé est honnête — « **le résolveur** demande » — mais la case du document
dit **Jarvis**.

> Une porte qui éprouve un module ne franchit pas une phase dont le livrable est
> un comportement. Les deux ne se confondent que si on lit vite.

**Cinquième occurrence** de la famille ADR-054 / 055 / 057 / 058 : une
affirmation que le mécanisme censé l'établir n'établit pas.

### Et le registre décrivait mal sa propre zone d'ombre

`docs/26 §4.1` disait : « la boucle réelle ne résout pas les entités »,
condition de réouverture « `QUICKSTART` promet la levée d'ambiguïté ».

**Les deux moitiés étaient fausses.**

`QUICKSTART` ne promet rien — il déclare l'absence, mot pour mot : « la
désambiguïsation … n'existe **pas encore** ». Et « pas branché » n'est pas la
cause :

```text
resolveAnaphora  lit session_turns.mentioned_entity_ids
                 → les DEUX appelants du produit l'omettent
                   (http.ts:141, cli/main.ts:271)
resolveMention   lit entities / entity_aliases
                 → AUCUN INSERT hors des tests
```

Brancher le résolveur aujourd'hui le ferait répondre `NOT_FOUND` à chaque
appel. **On aurait retiré deux orphelins du compteur sans rien rendre
possible** — la pire façon de payer une dette : celle qui change le tableau de
bord et pas le produit.

### La décision

1. **La Phase 1 passe de 100 % à 90 %.** L'étendue fonctionnelle mesure *ce que
   Jarvis sait faire* ; il ne désambiguïse pas. Le total passe de 65 % à 64 %.
2. **La condition de réouverture est réécrite** : une capacité de
   reconnaissance d'entités dans du texte libre — donc un modèle, or l'Intent
   Engine est **Tier 0 par conception**. C'est un chantier de Phase 5+ ou d'un
   Tier 1, pas un oubli de câblage.
3. **Le blocage doré A2 devient falsifiable** : `tableJamaisPeuplee: 'entities'`.
   Le jour où du code de `src/` y insère, le test rougit en le nommant.
   Sabotage vérifié.

### Ce que cette ADR ne prétend pas

Elle ne dit pas que la Phase 1 est mal faite. Le Memory Engine, le Memory
Guard, la recherche hybride et le hors-ligne sont livrés et éprouvés. Elle dit
qu'**un** de ses six livrables n'est pas atteignable, et que le compter comme
acquis rendait le chiffre faux.

### Condition de révision

Si un jour la reconnaissance d'entités arrive par un chemin non prévu — un
outil qui crée explicitement une entité sur demande de l'utilisateur, sans
modèle — alors A2 se débloquerait sans Tier 1, et cette ADR devrait être
reprise.

---

## ADR-061 — Lire un consentement est une décision de sûreté, pas de l'affichage

**Statut :** accepté (`docs/26 §4.2`, `PRD §135`).
**Référence :** ADR-004, ADR-059, `docs/03 §3`, `tests/unit/consentement.test.ts`.

### La question que je me suis posée

Cinq sprints à corriger des affirmations fausses. L'étendue est passée de 64 %
à 65 % puis retour à 64 %. Le produit n'a gagné aucune capacité depuis
`web_search` et l'arrêt d'urgence, pendant que la machinerie de preuve
grossissait.

> Ai-je commencé à optimiser l'appareil de mesure plutôt que la chose mesurée ?

Reformulé autrement : **744 tests prouvent le moteur, zéro prouve le volant.**
Le CLI est la seule chose qu'un humain touche, et `docs/26 §4.2` le laissait à
0 % avec une phrase rassurante.

### La phrase rassurante était fausse

> le CLI n'exécute aucune action en propre […] le risque porte sur
> l'**ergonomie et le rendu**, pas sur la sûreté.

`src/apps/cli/report.ts` porte `isAffirmative` et `isNegative` : elles décident
si l'utilisateur a **consenti** à une action `L3` / `L4`.

C'est la dernière décision de la chaîne, et la seule qu'aucun Policy Gate ne
rattrape — le Gate a déjà rendu son verdict, il a dit « demande à l'humain ».
Ce qui suit est le seul juge.

### Mesuré avant d'être corrigé

```text
isNegative → return false     → 744 tests verts
ancrage ^…$ retiré            → « oui mais non » lu comme un OUI
```

Le premier sabotage est bénin : le défaut fermé rattrape, l'utilisateur voit
« je n'ai pas compris » au lieu d'« annulé ». **Le second exécute une action
`L4` que personne n'a confirmée.**

### La décision

Sortir la décision du shell, plutôt que d'ajouter des tests autour d'elle :

```ts
export type ConfirmationReading = 'CONFIRM' | 'REFUSE' | 'UNCLEAR';
export function readConfirmation(answer: string): ConfirmationReading
```

**Trois issues, pas deux.** `PRD §135` : *le doute n'est pas une confirmation*.
Un booléen forcerait à ranger « peut-être » d'un côté ou de l'autre ; trois
issues laissent l'ambiguïté exister avec sa propre réponse — et sa propre
phrase à l'écran.

Le refus est lu **en premier**. Les deux listes sont disjointes aujourd'hui,
donc l'ordre n'est pas observable — et le test le dit plutôt que de le
maquiller. Ce qui est éprouvé, c'est la **disjonction** : le jour où quelqu'un
ajoute un mot des deux côtés, ce test rougit et l'oblige à trancher l'ordre.

### Ce que cette ADR ne prétend pas

La boucle du CLI reste non traversée : affichage, lecture d'entrée, commandes.
Ce qui est sorti de l'ombre, c'est la **décision** — elle vit dans une fonction
pure et éprouvée plutôt que dans une chaîne de `if` au milieu du rendu.

`docs/26 §4.2` garde donc sa condition (« à couvrir avant toute promesse de
disponibilité produit »), mais sans la phrase qui la minimisait.

### Condition de révision

Si la passerelle web venait à lire un consentement en texte libre — elle prend
aujourd'hui un booléen typé, donc elle n'en lit pas — elle devrait passer par
la même fonction. Deux lectures du consentement finiraient par diverger, et le
jour où elles divergent, aucune ne fait autorité (ADR-041).

---

## ADR-062 — Le statut peut être juste et la phrase mentir

**Statut :** accepté (`CLAUDE.md` règle 3, `docs/12`).
**Référence :** ADR-030, ADR-041, ADR-061, `tests/unit/annonce.test.ts`.

### Le fait

```text
case 'UNKNOWN' → return "C'est fait."   → 752 tests VERTS
```

Toute la machinerie de vérification — Verification Engine,
`constrainToVerifiability`, la distinction `UNKNOWN` / `FAILED` d'ADR-030, le
contrat d'effet d'ADR-033 — existe pour établir **quel statut est vrai**. Puis
ce statut devient une phrase, dans le fichier qu'aucun test ne référençait.

> **Le statut peut être juste et la phrase mentir.** Ce sont deux choses, et
> une seule était éprouvée.

C'est la règle 3 de `CLAUDE.md` — celle qui ne se négocie pas — rompue au
dernier pouce.

### Et la passerelle web disait autre chose que le CLI

`ui.ts` portait sa **propre** table statut → phrase, écrite à la main dans le
script servi au navigateur. Elle connaissait **quatre statuts sur sept** :

| Statut | CLI | Web (avant) |
|---|---|---|
| `PARTIAL` | `±` + phrase | **absent** → `·` + « PARTIAL » brut |
| `NOT_ATTEMPTED` | `·` + phrase | **absent** → `·` + brut |
| `PROVIDER_CONTRACT_VIOLATION` | `⚠` + phrase complète | **absent** → `·` + brut |

`·` est, dans le CLI, le marqueur de `NOT_ATTEMPTED`. **Le signal le plus fort
du système portait donc, sur le web, le symbole du plus bénin** — et
l'utilisateur lisait l'identifiant d'énumération brut.

ADR-041 l'avait déjà tranché pour les données : *le jour où deux sources
divergent, aucune ne fait autorité.* Ici elles avaient divergé.

### La décision

1. **`headline(status)`** — la phrase seule, extraite d'`announce`. Une table,
   deux rendus : le CLI y ajoute le détail, le web l'affiche séparément.
2. **Le web DÉRIVE** ses tables de `report.ts`, en itérant l'**énumération**.
   Un statut ajouté demain apparaît des deux côtés sans que personne y pense.

### Ce que les tests vérifient — et ce qu'ils évitent de figer

**Pas la formulation.** Geler « C'est fait. » interdirait de reformuler sans
rien garantir. Ce qui est éprouvé, ce sont des **propriétés** :

- seul `CONFIRMED` produit la phrase qui affirme le succès, *quelle qu'elle
  soit* — la phrase est lue depuis le code, pas recopiée dans le test ;
- tout statut non confirmé porte le détail ;
- l'incertitude a plus de mots que la réussite — la règle que le fichier se
  donne à lui-même, rendue vérifiable ;
- les sept phrases et les sept signes sont **distincts** ;
- le web dit **exactement** ce que dit le CLI.

Six sabotages, tous rattrapés. Le plus grave — `UNKNOWN` annonçant le succès —
en déclenche cinq.

### Un test rouge doit s'expliquer

La première version laissait remonter « Expected property name or '}' in
JSON » : exact, et inutilisable. Le message dit désormais *quelle* table,
*pourquoi* c'est grave, et *ce qui* a probablement été fait.

> Un test rouge qu'on ne comprend pas finit désactivé. L'expliquer fait partie
> de la garde, pas de son confort.

### Condition de révision

Si une troisième surface devait rendre un statut — une application mobile, une
notification — elle devrait dériver de `headline` et `mark`, jamais recopier.
Le test compare aujourd'hui **une** surface au CLI ; il faudrait l'étendre, pas
le dupliquer.

---

## ADR-063 — Ce qu'on montre est ce qui sera fait, en entier

**Statut :** accepté (`docs/03 §3`).
**Référence :** ADR-041, ADR-061, ADR-062, `src/core/tools/confirmation.ts`.

### Comment c'est arrivé

Après le consentement (ADR-061) et l'annonce (ADR-062), la question a été
posée à la surface produit entière plutôt qu'à un fichier :

```text
quels exports de src/apps/ ne sont cités par AUCUN test ?
```

Neuf. Dont `confirmationPrompt` — la fonction qui montre à l'humain **ce qu'il
confirme**. Le pendant exact du consentement : la lecture était éprouvée, pas
ce sur quoi elle porte.

### Deux défauts, et le second était ACTIF

**1. Une liste NOIRE là où il fallait une liste blanche.**

Les valeurs voyageaient dans `error.details`, mêlées aux métadonnées, et
**deux** consommateurs les triaient chacun de leur côté par
`key !== 'tool' && key !== 'autonomy'`. Or le Gateway étalait
`...sensitiveValues` **après** ces clés :

```ts
{ tool: def.id, autonomy: policy.effectiveAutonomy, ...sensitiveValues }
```

Un paramètre nommé `tool` aurait écrasé la métadonnée, puis aurait été filtré
par les deux consommateurs. **L'humain aurait confirmé une valeur qu'il n'a
jamais vue.** Aucun outil ne porte ce nom aujourd'hui — c'est un piège, pas un
incident, et un piège qu'on ne déclenche pas est un piège qu'on oublie.

**2. Une troncature SILENCIEUSE — et celle-là était le comportement du jour.**

`.slice(0, 200)` coupait sans le dire. `web_search.query` accepte **256**
caractères : cinquante-six pouvaient disparaître de ce qu'on confirme.

> Confirmer ce qu'on n'a pas vu n'est pas confirmer.

### La décision

Un module, `src/core/tools/confirmation.ts`, qui **assemble et relit au même
endroit** — le Gateway écrit, l'Assistant et le CLI lisent.

| | |
|---|---|
| **Liste blanche** | les valeurs voyagent sous un préfixe `valeur.` ; tout le reste est de la métadonnée. Une clé inconnue est **ignorée**, pas affichée — défaut fermé appliqué au rendu |
| **Troncature dite** | `…(tronqué — N caractères au total)`, **dans la chaîne** |
| **Ordre stable** | trié par nom : un ordre qui bouge fait relire, et ce qu'on relit trop souvent finit par ne plus être lu |

**La mention de troncature est dans le TEXTE, pas dans un drapeau.** Un booléen
à côté de la valeur suppose que chaque affichage pense à le lire — il y en a
trois, CLI, passerelle web, et le prochain. Le texte survit à un consommateur
distrait.

### La doublure de test qui pouvait dériver du vrai

`assistant.test.ts` fabriquait ses clés à la main (`montant: 50`). Elle est
passée par `confirmableKey` et `renderConfirmable` — **les mêmes fonctions que
la production**. Une doublure qui écrit son propre format finit par éprouver un
protocole que personne n'implémente.

Et `gateway.test.ts` lit désormais par `readConfirmables` plutôt que par la clé
nue : le test éprouve la **propriété** — la valeur est exposée à l'humain — et
non la forme de transport, qui a justement changé.

### Sabotage

Quatre passes. La dernière reproduit l'**état d'origine exact** — liste noire
*et* clés nues — et fait rougir le test qui encode précisément la trouvaille
(« un paramètre nommé `tool` est MONTRÉ »). Les trois premières l'auraient
laissé vert : une seule moitié du défaut ne suffit pas à le reproduire.

> Un sabotage partiel donne une conclusion partielle. Reproduire l'état
> d'origine coûte une passe de plus et vaut la différence.

### Condition de révision

Si `error.details` devait un jour porter d'autres familles de données —
diagnostics, suggestions — chacune aurait son préfixe, jamais une exception
dans le filtre. Le jour où l'on écrit `key !== …` ici, la liste noire est
revenue.

---

## ADR-064 — L'audit du jour est complet, et sa borne appartient à la base

**Statut :** accepté (`docs/05 §A9`).
**Référence :** ADR-036, ADR-037, ADR-041, `src/core/ledger/ledger.ts`,
`src/apps/reports.ts`.

### Comment c'est arrivé — en re-mesurant, pas en se souvenant

Une itération plus tôt, j'avais conclu le balayage « quels exports de
`src/apps/` ne sont cités par aucun test ? » ainsi : *« les huit restants ne
portent aucune décision de sûreté — des constantes, du balisage statique. »*

À la question suivante, j'ai relancé le balayage plutôt que de citer ma propre
conclusion. `src/apps/reports.ts` est apparu, avec trois exports que la
première passe n'avait pas listés.

> **L'affirmation était fausse**, et elle était de moi. Une conclusion qu'on
> recopie est une mesure qui a cessé d'en être une.

### Les deux défauts

`auditReport` répond à « qu'as-tu fait aujourd'hui ? ». Il lisait
`recent(200)`, puis filtrait par `new Date().toISOString().slice(0, 10)`.

| | |
|---|---|
| **Fenêtre au mauvais poignet** | la borne du jour venait du **processus**. ADR-036 et ADR-037 ont tranché l'inverse : un appelant dont l'horloge dérive voit « aujourd'hui » ailleurs qu'aujourd'hui |
| **Plafond silencieux à 200** | au-delà, la réponse omettait des événements **sans le dire**. Le journal enregistre chaque opération d'outil et chaque décision de politique : deux cents, c'est une journée ordinaire |

Le second est le plus grave, et pas pour la donnée perdue. Un audit est la
contrepartie de l'autonomie : c'est par lui que l'utilisateur peut prendre
Jarvis en défaut. **Un audit incomplet qui se présente comme complet ne coûte
pas une information — il rassure.**

### Ce que cette trouvaille apprend de plus qu'un bug

Il existait **déjà** une bonne réponse. L'outil `audit_query`
(`src/tools/audit.ts`) borne par `date_trunc('day', clock_timestamp())` depuis
son écriture. Deux registres du même fait, ce qu'ADR-041 interdit — avec une
aggravation que la formule d'ADR-041 n'avait pas prévue :

> Le registre JUSTE était celui que personne n'affichait. Le registre FAUX
> était la surface produit — CLI **et** passerelle web appellent `auditReport`.

Un doublon n'est pas symétrique. Celui qu'on voit gagne, quel que soit celui
qui a raison.

### La décision

Une méthode `Ledger.dayTally()`, et un seul chemin pour tout le monde.
L'agrégation est faite **en SQL** : la borne, le regroupement et le total.

**On ne signale pas la troncature — on la rend impossible.** Un `count(*)` ne
dépend d'aucune limite de lignes. Rendre `truncated: true` aurait été honnête
et aurait laissé au lecteur une réponse partielle à interpréter ; l'agrégation
en base n'a rien à interpréter.

### Le cas limite qui ramenait le défaut par la porte de derrière

Une agrégation sans ligne ne rend **aucune** ligne — donc aucune date. La
tentation est de retomber sur `new Date()` là, et seulement là : le défaut ne
se serait vu qu'un jour sans activité, c'est-à-dire jamais en test et un jour
en production. La base est donc interrogée une seconde fois plutôt que devinée,
et un contrôle négatif vérifie que cette seconde question **est posée**.

### Sabotage

Trois passes, chacune reproduisant un défaut d'origine, chacune faisant rougir
exactement un test :

```text
least(count(*), 200)         → « AU-DELÀ DE 200 ÉVÉNEMENTS » rouge
WHERE retiré                 → « un événement d'HIER » rouge
repli sur new Date()         → « MÊME quand la journée est vide » rouge
```

### Ce que le dépôt m'a appris pendant l'écriture du test

La première version antidatait l'événement avec le rôle applicatif.
**L'`UPDATE` a été refusé.** La barrière d'immuabilité du journal a fait son
travail sur mon propre test — il a fallu le superutilisateur et la fenêtre
exclusive de `ledger-chain.test.ts`.

### Condition de révision

Le jour où un rapport de `src/apps/` calcule une fenêtre temporelle en
JavaScript, ADR-036, ADR-037 et celui-ci sont contournés ensemble. La borne se
demande à la base, ou ne se demande pas.

---

## ADR-065 — Un succès peut être une ABSENCE

**Statut :** accepté (`docs/05 §C3`, CRITIQUE).
**Référence :** ADR-004, ADR-019, ADR-031, ADR-041, `docs/03` (échelle L0–L4),
`docs/19 §2`, `src/tools/memory.ts`, `src/core/verification/engine.ts`.

### Ce qu'il fallait livrer

`memory_forget` — le **premier des cinq outils inverses déclarés** à être écrit,
et celui-là d'abord parce que `docs/05 §C3` est CRITIQUE quand les quatre autres
sont du confort.

```text
Entrée   : « Oublie cette information. »
Attendu  : mémoire + embeddings + relations + cache + dérivés supprimés ;
           événement MEMORY_DELETED.
Interdit : que le contenu supprimé survive dans le journal.
```

### Le défaut de vocabulaire que l'écriture a révélé

Tous les outils du dépôt réussissent en **faisant apparaître** quelque chose, et
se vérifient en le relisant. `confirmed()` code donc en dur
`evidence: 'POSITIVE_PRESENCE'`, et la seule fabrique rendant
`POSITIVE_ABSENCE` était… `failed()`.

> **Un outil dont le succès EST une absence ne pouvait pas annoncer son succès
> honnêtement.** Il lui restait à mentir sur la preuve — `confirmed`, en
> prétendant avoir observé une présence — ou à sous-déclarer en `unknown`.

Le commentaire d'`EvidenceKind` disait d'ailleurs « seule preuve qui autorise
`CONFIRMED` ». C'était vrai tant que tout effet était additif ; il est corrigé
plutôt que laissé mentir.

**Ajouté :** `erased()`, qui rend `CONFIRMED` sur preuve `POSITIVE_ABSENCE`, et
qui **exige le même `conclusiveBecause` que `failed()`** — prouver une absence
oblige à dire pourquoi l'observation est concluante.

**Généralisé :** `projectStatus(targets, successEvidence)`. L'axe est unique et
bascule les deux bornes, car la preuve d'échec est toujours l'observation
contraire. Par défaut, le comportement d'origine — aucun appelant existant ne
change.

### Trois arbitrages, et aucun n'est anodin

| | Décision | Pourquoi |
|---|---|---|
| **Suppression réelle** | `DELETE`, pas `state = 'DELETED'` | `memory_add.rollback` annonçait l'effacement doux. Une ligne `DELETED` garde `content` : dire « oublié » serait une fausse confirmation **portant sur une promesse de confidentialité** — l'utilisateur cesse de se méfier d'une donnée qui existe encore |
| **`NOT_UNDOABLE`** | la capture existe et ne garde RIEN | ADR-019 veut que toute mutation capture de quoi être annulée. Appliqué tel quel, cela recopierait le contenu dans `action_snapshots` : on n'aurait rien oublié, on aurait **déplacé**. Le schéma avait prévu la sortie |
| **L4** | pas un choix de prudence | `docs/03` nomme la ligne : *« Paiement, suppression, données sensibles, irréversible »* |

> Un oubli qu'on peut défaire n'est pas un oubli.

### `PARTIAL` cesse d'être décoratif

Une mémoire ne vit pas qu'à un endroit. Les dérivés `cascades = false` — export,
sauvegarde, cache externe — survivent au `DELETE`. Tant qu'il en reste un, le
statut est `PARTIAL`, et il **sort de `projectStatus`** : `docs/19 §2` l'exigeait,
*un outil ne peut pas se dire `PARTIAL` pour éviter de trancher*.

`src/core/tools/outcome.ts` figurait depuis Foundation 4 dans les modules hors
circuit, avec ce commentaire : « jusqu'à ce qu'un outil multi-cibles existe ».
Cet outil existe. **La dette nommée est payée, et c'est `wiring.test.ts` qui
l'aura suivie du premier au dernier jour** — cinq modules morts, désormais
quatre.

### Ce que les tests ont attrapé

**Mon propre outil, par son contrôle négatif.** La relecture concluait
« absente, donc effacée » — vrai aussi d'une mémoire qui n'a **jamais existé**.
`memory_forget` annonçait un oubli `CONFIRMED` sur un identifiant inconnu.
`execute` savait la différence, `readBack` l'ignorait.

**La barrière d'immuabilité, sur un test précédent.** Elle avait déjà refusé un
`UPDATE` du rôle applicatif (ADR-064). Ici, sept tests du dépôt ont rougi en
même temps — chacun affirmait l'absence de ce qui venait d'être écrit :

```text
redteam/memory.test.ts    « aucun outil ne permet d'oublier »   → it.fails devenu vrai
golden/contract.test.ts   C3 déclaré bloqué                     → le blocage n'a plus de motif
redteam/wiring.test.ts    outcome.ts orphelin                   → il ne l'est plus
coherence-des-chiffres    16 outils, 27/30 scénarios            → 17 et 28/30
```

C'est le dépôt qui dicte la mise à jour, pas l'inverse. Aucun de ces tests n'a
été affaibli : chacun enregistre désormais une vérité différente.

### Sabotage

```text
UPDATE state='DELETED' au lieu de DELETE   → 3 rouges
priorState conservé dans l'instantané      → 1 rouge (l'INTERDIT)
dérivés hors cascade ignorés               → 1 rouge (le PARTIAL)
```

### Condition de révision

Le jour où un outil appelle `erased()` sans pouvoir fermer sa fenêtre
d'observation, la fabrique ment aussi sûrement que `confirmed()` mentait ici.
`conclusiveBecause` est obligatoire pour cette raison, et non par symétrie
esthétique avec `failed()`.

Et si un second outil d'effacement apparaît, `PARTIAL` doit rester **projeté**.
Le jour où quelqu'un écrit `status: 'PARTIAL'` en dur dans un `readBack`, la
discipline de `docs/19 §2` est perdue.
