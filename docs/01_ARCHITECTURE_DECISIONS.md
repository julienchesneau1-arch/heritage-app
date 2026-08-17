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
