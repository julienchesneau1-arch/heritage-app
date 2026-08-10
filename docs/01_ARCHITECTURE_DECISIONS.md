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
