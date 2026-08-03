# HÉRITAGE — Spécification Technique pour Claude Code
## Version 1.0 | 28 Juillet 2026

---

## 0. FICHE D'IDENTITÉ (à lire en 60 secondes)

**Mission** : Maintenir un rituel de transmission familiale. Une histoire doit pouvoir engendrer une autre histoire.

**Produit** : Application web PWA (mobile-first) de mémoire familiale. Pas un réseau social. Pas une bibliothèque. Un rite.

**Public** : Familles multigénérationnelles (4 générations, 6 rôles comportementaux dynamiques).

**Primitive** : `transmission_rate` = histoires ayant engendré au moins une autre histoire / total histoires.

**Différenciateur** : Parcimonie (montrer le minimum), Constitution éthique (pas d'inférence émotionnelle), Dispensabilité (le succès = la famille continue sans l'app).

**Stack cible** : Next.js 14 (App Router) + TypeScript + Prisma + PostgreSQL + Redis + OpenAI API (GPT-4o) + Vercel.

---

## 1. ARCHITECTURE GLOBALE

```
┌─────────────────────────────────────────────────────────────┐
│  CLIENT (Next.js 14, PWA, Tailwind)                         │
│  ├── App Shell (layout parcimonieux)                        │
│  ├── 7 Pages : Aujourd'hui, Veillée, Récits, Archives,      │
│  │             Traditions, Graphe, Transmission             │
│  ├── Service Worker (cache offline, sync différé)           │
│  └── Composants : PasseurWidget, StoryCard, GraphCanvas,    │
│                   TraditionReminder, ExportButton           │
├─────────────────────────────────────────────────────────────┤
│  API LAYER (Next.js API Routes / Route Handlers)            │
│  ├── /api/stories (CRUD + search)                           │
│  ├── /api/passeur (génération question)                     │
│  ├── /api/conversations (Q&A thread)                        │
│  ├── /api/traditions (activation cyclique)                  │
│  ├── /api/graph (nœuds + liens)                             │
│  ├── /api/export (JSON complet, GDPR)                       │
│  └── /api/webhook (ingestion audio/image future)            │
├─────────────────────────────────────────────────────────────┤
│  MÉTIERS / SERVICES (fonctions serverless)                  │
│  ├── TriggerModelService (déclencheurs temporels)           │
│  ├── ConservateurService (budget visibilité, quarantaine)   │
│  ├── PasseurService (génération questions)                  │
│  └── LLMOperatorService (pipeline vérifié)                  │
├─────────────────────────────────────────────────────────────┤
│  DATA LAYER                                                 │
│  ├── PostgreSQL (Prisma ORM) — données relationnelles       │
│  ├── Redis — sessions, cache Passeur, rate limiting         │
│  └── Object Storage (S3/Cloudflare R2) — archives binaires  │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. MODÈLE DE DONNÉES

Le schéma de référence est `prisma/schema.prisma`. Aucune table ne peut être ajoutée sans mise à jour de ce document.

### Entités

| Modèle | Rôle |
|---|---|
| `Family` | Le tenant. Tout est cloisonné par famille. |
| `Member` | Utilisateur au sens familial. Génération, dates de naissance/décès. Soft-delete via `isDeleted`. |
| `Story` | Le cœur du produit. Texte brut, type narratif imposé, ton, longueur déduite. **Deux personnes** : `authorId` (qui a saisi) et `narratorId` (qui a raconté). |
| `Entity` | Nœud du graphe : PERSON, PLACE, OBJECT, DATE, CONCEPT. Matching par `normalizedName`. |
| `Archive` | Photo, document, audio, vidéo. Binaire sur stockage objet, métadonnées en base. |
| `Tradition` | Rituel cyclique. Peut s'endormir ; le sommeil n'est pas un échec. |
| `Conversation` | Q&A autour d'un récit. Peut se convertir en récit. |
| `Passage` | Lien de transmission parent → enfant. **La primitive du produit.** |
| `VisibilityLog` | Audit du Conservateur. Toute impression est traçable. |

### 2.1 Règles de modèle (non négociables)

1. **Toute suppression de Member** : soft-delete uniquement (flag `isDeleted`). Les histoires restent, l'auteur devient « Auteur anonymisé ».
2. **Toute suppression de Story** : possible uniquement par l'auteur ou un admin familial.
3. **Family est le tenant isolé** : toute requête SQL doit filtrer par `familyId`. Jamais de requête cross-family.
4. **Entity.normalizedName** : lowercase, sans accent, sans ponctuation. Utilisé pour le matching.

### 2.2 Écarts assumés par rapport à la v1.0 du document

Trois points de la spec d'origine ne pouvaient pas être implémentés tels quels. Les décisions prises :

- **`Member.storiesMentioned`** (relation `MentionedIn`) n'avait pas de champ miroir sur `Story` : Prisma refuse le schéma. Les mentions passent par `Entity.memberId` ↔ `Story.linkedEntities`, qui portent déjà l'information. Le champ est retiré.
- **`Entity.member`** n'avait pas non plus de back-relation sur `Member` ; elle a été ajoutée (`Member.entities`).
- **`Member.isDeleted`** est exigé par la règle 1 mais absent du modèle. Il a été ajouté.
- **Annexe B** annonce « 30 types » et en liste 33, dont `maison-deménagement` (accent fautif). Les 33 sont conservés, l'accent est corrigé en `maison-demenagement`.
- **`Passage.triggerType`** reçoit une sixième valeur, `veillee` (§5.4), distincte de `tradition` qui désigne un rituel daté. **`VisibilityLog.context`** reçoit de même un contexte `veillee`.

### 2.3 Narrateur et scribe — ajout hors spec v1.0, assumé

La spec ne connaît qu'un `authorId`. Or dans une famille de quatre générations, **celui qui raconte n'est presque jamais celui qui tape**. Jeanne a 92 ans : chaque récit qu'elle transmet aurait été attribué à Claire, qui tenait le clavier. Lucas a sept ans : pareil, dans l'autre sens.

Deux conséquences, l'une humaine, l'autre technique :

- Les deux générations extrêmes — celles qui ont le plus à transmettre et le plus à recevoir — **disparaissaient de leur propre mémoire familiale**.
- La métrique de distorsion (§3.2) mesure l'écart entre qui s'exprime et qui est lu. En comptant le clavier, elle aurait déclaré la mémoire parfaitement fidèle au moment précis où une voix s'éteignait. Un test le démontre sur le jeu de la famille Martin.

`Story.narratorId` est donc ajouté, nullable — la plupart des récits sont saisis par celui qui les raconte. Le formulaire demande « Qui raconte ? » avant le titre. L'affichage dit « Raconté par Jeanne Martin, noté par Claire Martin ». La distorsion compte le narrateur quand il existe, l'auteur sinon.

### 2.4 Onboarding — ajout hors spec v1.0, assumé

La spec ne prévoyait aucun moyen de créer une famille ou d'ajouter un membre : `family.create` n'existait que dans le seed. L'application ne pouvait servir qu'une seule famille, fictive.

- `/commencer` fonde une famille avec son premier membre. Le fondateur repart avec une identité vérifiée : c'est lui qui distribuera les liens.
- `/famille` liste les membres, permet de les ajouter, de les corriger, de les retirer (soft-delete, §2.1 règle 1), et affiche le lien personnel de chacun avec un bouton de révocation.
- `/restaurer` recrée une famille depuis un export.

### 2.5 Correction d'un récit

`PATCH` ne savait qu'archiver. Une faute dans un récit dicté ne se rattrapait qu'en supprimant puis retapant — or `DELETE` efface les `Passage` attachés : **corriger une virgule coûtait une chaîne de transmission**, c'est-à-dire la seule chose que le produit mesure.

`/recits/<id>/modifier` corrige le titre, le texte, le type, le ton et la date. L'auteur, le narrateur, les passages et les conversations ne bougent pas. Réservé à celui qui a saisi et à celui qui a raconté — personne d'autre n'a autorité sur ces mots.

### 2.6 Sourdine par membre — remplace la quarantaine globale

Le §3.2 comptait les rejets par membre mais appliquait la quarantaine globalement : trois refus d'Emma faisaient taire un récit pour Jeanne, qui n'avait rien demandé. Un membre peut décider de ne plus voir un récit ; il ne peut pas décider à la place des autres.

Table `StoryMute`, portée par le couple (récit, membre), réversible par l'intéressé seul.

### 2.7 Recherche insensible aux accents

`Story.searchText` contient le titre et le contenu normalisés (sans accent, sans ponctuation), maintenu à la création et à la correction. Personne ne tape les accents sur un téléphone : « demenagement » doit trouver « déménagement ».

### 2.8 Stockage des archives

Les fichiers **ne sont jamais exposés à une URL publique**, même longue et imprévisible : une photo de famille sur un bucket public est une photo de famille indexable. Tout passe par `GET /api/family/:id/archives/:archiveId/file`, qui vérifie la famille avant de servir un octet, et répond `Cache-Control: private`.

Deux pilotes derrière la même interface — poser, lire, retirer des octets. Disque par défaut (`STORAGE_DIR`) ; **S3/R2 dès que `STORAGE_S3_BUCKET` est renseigné**, indispensable sur un hébergement au système de fichiers éphémère où les photos disparaîtraient au premier redéploiement. Le bucket n'a pas à être public, et ne doit pas l'être.

Le type MIME déclaré doit figurer dans une liste fermée (JPEG, PNG, WebP, HEIC, PDF, MP3, M4A, WAV, WebM, MP4) et c'est lui qui détermine le type d'archive : la famille n'a rien à choisir. SVG est refusé — c'est un vecteur de script. Plafond : 25 Mo. La clé de stockage est cloisonnée par famille et n'est jamais dérivée du nom de fichier fourni.

**Sur le nombre de pages.** L'application en compte sept, pas six : la veillée s'ajoute. La parcimonie du §6.1 porte sur le nombre de suggestions par écran, pas sur la taille de la carte — un rite qu'on ne trouve pas est un rite qui n'a pas lieu.

---

## 3. LES 4 ACTEURS ALGORITHMIQUES

### 3.1 TriggerModelService — `src/services/trigger-model.service.ts`

**Mission** : Détecter quand le présent active le passé. Générer un signal contextuel, jamais une notification froide.

**Entrées autorisées** : dates déclarées dans l'app (anniversaires, dates d'événements, traditions), actions explicites dans l'app, données saisies par l'utilisateur.

**Entrées interdites** : localisation GPS, historique d'appels, messages texte, activité sur d'autres apps, toute donnée externe non déclarée. La garantie est structurelle : le service ne lit que la base de la famille.

**Types de signaux et priorités** :

| Type | Priorité | Déclencheur |
|---|---|---|
| `TRADITION` | 5 | Une tradition tombe aujourd'hui |
| `ANNIVERSARY` (décès) | 5 | Date de décès enregistrée |
| `ANNIVERSARY` (naissance) | 4 | Date de naissance enregistrée |
| `TEMPORAL` | 3 | Un récit a été raconté ce jour-là, une année antérieure |
| `PASSIVE` | 1 | Rien d'autre. Écran neutre. |

**Règles de gouvernance** :
- Jamais de push notification. Le signal s'affiche uniquement quand l'utilisateur est déjà dans l'app.
- La justification est toujours affichée en petit texte sous le message.
- Un signal fermé 3 fois de suite par un membre est muet 30 jours pour ce membre.
- **Un seul signal** est renvoyé, quel que soit le nombre de candidats. Le repli passif s'applique après le filtre de silence : un membre qui a tout fait taire retrouve l'écran neutre, pas un écran vide.

### 3.2 ConservateurService — `src/services/conservateur.service.ts`

**Mission** : Garantir que rien ne devient inaccessible par effet d'algorithme. Ne jamais imposer, toujours préserver la possibilité.

**Principe d'Accessibilité Active** : aucune histoire ne devient inaccessible par effet d'algorithme. Mais aucune n'est artificiellement boostée.

| Mécanisme | Seuil | Effet |
|---|---|---|
| Budget de visibilité | > `max(15 %, 2 × part uniforme)` sur 12 mois | Le récit sort des **suggestions**. Il reste lisible, cherchable, exportable. |
| Rappel patrimonial | Non vu depuis 12 mois | Listé sur la page Transmission. Jamais injecté dans le flux. |
| Quarantaine | 3 rejets explicites **du même membre** | Retiré des suggestions. Réversible à tout moment. |
| Distorsion | — | Écart entre qui écrit et qui est lu. Mesuré, affiché, **jamais corrigé**. |

**Seuil relatif.** Les 15 % de la spec supposent un corpus fourni. Sur une famille de cinq récits, la part moyenne de chacun est déjà de 20 % : tous seraient déclarés sur-exposés dès les premières lectures et le Passeur n'aurait plus rien à proposer. Le seuil est donc le double de la part uniforme, avec 15 % pour plancher — un récit n'est sur-exposé que s'il capte deux fois ce qu'il capterait si l'attention était également répartie.

**Coût de la distorsion.** Les impressions sont agrégées en base et bornées à 12 mois. La version précédente chargeait chaque ligne du journal en mémoire : sur dix ans d'usage, des centaines de milliers d'enregistrements à chaque ouverture de la page Transmission. Les impressions d'un récit supprimé sont écartées des deux côtés du calcul — les compter au seul dénominateur inventerait une distorsion qui n'existe pas.

**Déduplication des impressions.** Une lecture n'est journalisée qu'une fois par membre et par récit sur 30 minutes. Ce n'est pas une optimisation : le budget de visibilité se calcule sur ces journaux, donc sans déduplication un membre qui rafraîchit sa page pousse le récit au-delà des 15 % et l'exclut des suggestions. L'algorithme sanctionnerait une histoire pour un appui sur F5.

**Règles de gouvernance** :
- Le Conservateur ne force jamais une histoire dans le flux passif.
- Il documente les biais (`distortionScore`) sans les corriger artificiellement.
- La quarantaine est par membre, pas globale.

### 3.3 PasseurService — `src/services/passeur.service.ts`

**Mission** : Augmenter la probabilité qu'une histoire engendre une autre. Poser des questions, jamais imposer des réponses.

**Règles de génération** :
1. Une seule question par session (1 par heure et par membre).
2. La question doit être justifiable en une phrase.
3. La question ne doit jamais inférer une émotion.
4. La question doit pointer vers un vide informationnel.

**Règles implémentées** :

| ID | Poids | Confiance | Vide visé |
|---|---|---|---|
| `UNANSWERED_QUESTION` | 1.0 | 0.95 | Un membre a posé une question, personne n'a répondu |
| `TENSION_UNRESOLVED` | 1.0 | 0.8 | Un fait est dit, sa raison ne l'est pas |
| `MISSING_VIEWPOINT` | 0.9 | 0.7 | Un membre lié n'a pas donné sa version |
| `RARE_PATRIMONY` | 0.8 | 0.6 | Récit ancien, peu lu |
| `TEMPORAL_LINK` | 0.7 | 0.5 | Deux ans ou plus se sont écoulés |

Sélection par `confiance × poids`. Une paire (récit, règle) déjà jouée ne revient pas avant 14 jours pour ce membre. Les récits sur-exposés sont écartés.

**`UNANSWERED_QUESTION` — ajout hors spec v1.0, assumé.** Sans elle, une question posée par un membre n'était visible qu'en rouvrant le récit exact sur lequel elle portait : autant dire qu'elle se perdait, et avec elle le chemin le plus direct vers un nouveau récit. C'est aussi le seul vide informationnel que le produit n'a pas déduit d'un texte — quelqu'un l'a formulé. Elle passe donc devant les règles inférées, et ne renvoie jamais à un membre sa propre question. La réponse attendue est « Répondre », pas « Raconter la suite ».

**Coût.** Une règle ne parcourt jamais le corpus : elle déclare une requête bornée (`where` + `take`) qui décrit ce qu'elle cherche. La formulation par le LLM intervient **après** la sélection, sur la seule question retenue — l'appeler pour chaque candidat reviendrait à payer cinquante appels pour en afficher un.

**Note d'implémentation** : le test de `TENSION_UNRESOLVED` proposé dans la spec v1.0 cherchait les mots `ne`, `pas`, `mais`, `toujours`. Ce test est vrai sur presque tout texte français : il aurait fait de chaque récit une tension, donc d'aucun. Il a été remplacé par des marqueurs de tension explicites (« il refusait », « on n'a jamais su », « sans expliquer »).

### 3.4 LLMOperatorService — `src/services/llm-operator.service.ts`

**Mission** : Exécuter des opérations informationnelles vérifiables. Ne jamais décider. Ne jamais inférer d'émotion.

| Opération | Autorisée | Vérifiée par |
|---|---|---|
| Reformuler une phrase | oui | L'utilisateur lit et valide |
| Classer par thème | oui | Règle système (33 types prédéfinis) |
| Résumer un texte long | oui | L'utilisateur compare |
| Extraire une entité | oui | Parsing strict + grammaire des types |
| Transcrire un audio | oui | L'utilisateur écoute et corrige |
| Formuler une question Passeur | oui | Règle Passeur + vérification post-génération |
| Fusionner 2 histoires | **non** | Décision métier |
| Inventer une émotion | **non** | — |
| Choisir l'ordre d'affichage | **non** | Décision Conservateur |
| Générer une histoire fictive | **non** | Hallucination |

Toute sortie traverse deux filtres : la vérification propre à l'opération, puis le filtre constitutionnel. Une sortie qui échoue devient un fallback déterministe. **Sans clé API, le service renvoie directement les fallbacks** : l'application reste entièrement fonctionnelle.

**Extraction d'entités.** Elle ne se déclenche que si la famille n'a nommé aucune entité elle-même. Le LLM comble le silence ; il ne corrige ni ne complète une liste déjà donnée. Un type hors grammaire ne crée aucun nœud.

**Rattachement aux membres.** Dans un récit on écrit « Robert », pas « Robert Martin ». Le rattachement accepte donc l'inclusion sur mots entiers, et refuse dès que deux membres répondent : un prénom ambigu vaut mieux non rattaché que rattaché au mauvais.

### 3.5 Transcription — opération vérifiée par l'humain

**Aucune garantie d'exactitude n'est possible, et le produit ne prétend pas en offrir.** Whisper est un modèle génératif : il ne reconnaît pas des mots, il prédit la suite la plus probable. Sur un silence, une respiration ou une hésitation, il ne rend pas du vide — il rend ce qui vient statistiquement ensuite. Il invente donc des phrases entières, grammaticalement parfaites et jamais prononcées, et il le fait davantage sur les voix âgées et hésitantes : le profil exact de ceux pour qui cette fonction existe.

La charte du §3.4 l'avait déjà inscrit — « transcrire audio → vérifié par : l'utilisateur écoute et corrige ». Pour toutes les autres opérations LLM, la vérification est mécanisable. Pour celle-ci, elle est humaine, et rien ne la remplace.

**L'architecture porte donc la justesse, pas le modèle.**

| Principe | Mise en œuvre |
|---|---|
| L'audio est l'original | L'enregistrement est conservé et rattaché au récit. Le texte n'en est qu'une copie contestable. |
| Une transcription n'est pas un récit | `TranscriptionDraft`, modèle séparé. Tant qu'elle n'est pas validée, elle ne compte dans aucune métrique et n'apparaît ni dans la veillée ni chez le Passeur. |
| Le doute est visible | Chaque segment porte les indicateurs du modèle lui-même, avec les seuils de l'implémentation de référence de Whisper : `avg_logprob < -1.0`, `compression_ratio > 2.4`, `no_speech_prob > 0.6`. |
| L'absence d'indicateur est dite | « Le modèle s'est déclaré sûr » et « le modèle n'a rien dit de sa confiance » ne sont **pas** la même chose. Le moteur local ne rend que des horodatages : l'écran annonce alors que rien ne peut être signalé et que tout est à vérifier, au lieu d'un « aucun passage signalé » qui laisserait croire à une assurance inexistante. |
| Les inventions connues sont retirées | Artefacts de sous-titrage (« Sous-titres réalisés par… », « Merci d'avoir regardé… ») supprimés et listés explicitement à l'écran. |
| Le doute n'est jamais supprimé | Un passage douteux mais possiblement réel est **conservé et signalé**. Supprimer serait décider à la place de la famille. |
| La provenance est affichée | « Transcrit automatiquement (whisper-1), vérifié par Claire le 3 août. » |

**Choix du modèle : `whisper-1`, pas `gpt-4o-transcribe`.** Le second rend un texte plus lisse, donc plus reformulé — or la façon dont quelqu'un construit ses phrases fait partie de ce qui se transmet. Surtout, `whisper-1` en `verbose_json` est le seul à exposer les indicateurs de doute par segment. Sans eux, la relecture humaine se ferait à l'aveugle sur tout le texte.

**Réglages :** `temperature: 0`, `language: 'fr'` forcé, et **aucun `prompt`** — un prompt oriente la sortie vers ce qu'il contient, précisément le biais qu'on refuse. Un test vérifie chacun de ces réglages.

### 3.5.1 Coût nul et durée illimitée — transcription locale

**Le coût était la vraie barrière d'accès.** Facturer à la minute revient à demander à une famille de peser si un souvenir vaut son prix, et à écourter les récits longs — c'est-à-dire les plus précieux. La transcription tourne donc, par défaut, **dans le navigateur de la famille** (`transformers.js`, WebGPU sinon WASM).

| | Local | API |
|---|---|---|
| 1 min | 0 $ | 0,006 $ |
| 60 min | 0 $ | 0,36 $ |
| 180 min | 0 $ | 1,08 $ |

La durée n'est plus un paramètre économique. Elle n'est plus qu'un temps d'attente sur l'appareil.

**L'audio ne sort pas.** C'est l'engagement, et il est tenu. En revanche la bibliothèque et les poids du modèle sont téléchargés depuis un CDN, une fois, puis mis en cache. Une famille qui veut un appareil totalement isolé doit héberger ces fichiers elle-même. La distinction est réelle et doit être dite comme telle.

**Contrepartie assumée** : le modèle local est plus petit, donc moins juste que celui de l'API. C'est compensé par les deux mécanismes ci-dessous, et par la relecture humaine qui reste obligatoire dans tous les cas.

### 3.5.2 Retrait des silences — la mitigation en amont

Whisper invente **sur le vide**. Ne pas lui donner de vide supprime l'occasion. C'est la seule mitigation qui agisse avant la génération plutôt qu'après.

Une détection d'activité vocale (énergie par fenêtre de 20 ms, seuil **relatif** au niveau de l'enregistrement — un seuil absolu déclarerait muette une aïeule qui parle doucement) isole les passages parlés et ne transmet qu'eux. Sur un récit réel de trois minutes ponctué de longues pauses : **43 % de parole, 102 secondes de silence jamais soumises au modèle**.

Le découpage sert aussi la durée : un enregistrement d'une heure devient une suite de morceaux bornés. Les frontières sont choisies **dans les silences** — jamais au milieu d'une phrase, car une coupe en pleine parole produit deux moitiés de mot que le modèle complète, c'est-à-dire invente.

**Recalage des horodatages.** Le modèle reçoit l'audio débarrassé de ses silences : ses repères comptent dans un temps où les blancs n'existent pas. Affichés tels quels, ils envoient la famille écouter au mauvais endroit — sur un récit à 43 % de parole, un passage réellement situé à 02:20 s'affichait à 01:04, soit **77 secondes d'écart**. Chaque horodatage est donc remonté à sa position dans le fichier réellement écouté. Sans ce recalage, la confrontation texte ↔ audio ne vaut rien, et avec elle tout l'édifice de vérification.

### 3.5.3 Consensus — le levier de précision le plus fort

Deux modèles indépendants n'inventent pratiquement jamais la **même** chose : une hallucination est le produit d'un chemin de décodage particulier, pas d'une propriété du son.

D'où une règle plus forte que n'importe quel indicateur de confiance :

- Là où deux transcriptions coïncident mot pour mot, le texte est très probablement ce qui a été dit.
- Là où elles divergent, il faut écouter. Sans exception.

Cela transforme la relecture : au lieu de vérifier trois minutes de texte, on vérifie les quatre endroits de désaccord. Un second avis local coûte lui aussi zéro.

L'alignement se fait par plus longue sous-séquence commune — un alignement mot à mot déraillerait dès la première insertion et déclarerait divergent tout ce qui suit. La ponctuation, la casse et les accents ne comptent pas comme des désaccords : les signaler noierait les vrais écarts. Deux divergences séparées par un seul mot commun sont fusionnées : « quatre heures douze » contre « seize heures trente » est **un** passage à réécouter, pas deux.

**Ce qui n'est jamais fait : fusionner automatiquement les deux versions.** Le résultat serait un texte que personne n'a prononcé ni validé. La version principale reste la référence ; le second avis ne fait que désigner où regarder.

**Coût et échelle.** La transcription par API ne tourne jamais dans le cycle d'une requête : dix minutes d'audio dépassent le délai d'une fonction serverless. `POST /api/transcriptions/process`, protégée par un secret, dépile la file ; à appeler par une tâche planifiée. Le brouillon apparaît ensuite dans « À mettre au propre » — aucune notification, conformément au §12.

L'API reste disponible comme second avis ou comme recours pour un appareil trop faible. Mais elle n'est plus le chemin par défaut : le défaut est gratuit.

---

## 4. API REST

### 4.1 Authentification — amendée

V1 n'avait qu'un secret : l'URL de la famille. Suffisant pour **lire** — c'est le choix assumé de la spec, il n'y a pas de mot de passe. Insuffisant pour **détruire** : l'identité du membre se choisissait librement dans une liste, et la suppression d'un récit la vérifiait contre un `?memberId=` fourni par l'appelant lui-même. La garde consistait à demander à quelqu'un s'il avait le droit, et à le croire.

Deux niveaux désormais :

| Lien | Forme | Identité | Peut |
|---|---|---|---|
| Familial | `/f/<familyId>` | **déclarée** | lire, écrire, questionner, répondre, archiver |
| Personnel | `/f/<familyId>/m/<memberId>/<jeton>` | **vérifiée** | tout cela, **et supprimer ses propres récits** |

Le cookie de membre est signé, niveau compris — sans quoi il suffirait de remplacer `declared` par `verified` à la main. Le jeton personnel intègre `Member.tokenVersion` : l'incrémenter **révoque le lien d'un seul membre**, sans déconnecter le reste de la famille. Retirer quelqu'un de la famille révoque son lien au passage.

Les routes API dérivent l'identité du cookie signé, jamais d'un paramètre.

### 4.2 Endpoints

```
GET    /api/family/:id/home                       → { signal, passeur }
GET    /api/family/:id/stories                    → { stories, total }
POST   /api/family/:id/stories                    → { id }
GET    /api/family/:id/stories/:storyId           → Story + entités + conversations + passages
PATCH  /api/family/:id/stories/:storyId           → archiver / sortir de quarantaine
DELETE /api/family/:id/stories/:storyId           → suppression (auteur uniquement)
POST   /api/family/:id/stories/:storyId/view      → journalise une lecture
POST   /api/family/:id/stories/:storyId/dismiss   → journalise un rejet

GET    /api/family/:id/archives                   → { archives }
POST   /api/family/:id/archives                   → métadonnées d'une archive déposée

GET    /api/family/:id/traditions                 → { traditions, activeTodayIds }
POST   /api/family/:id/traditions                 → créer
PATCH  /api/family/:id/traditions/:traditionId    → activate | sleep | wake

GET    /api/family/:id/conversations              → { conversations }
POST   /api/family/:id/conversations              → poser une question
PATCH  /api/family/:id/conversations/:id          → répondre

GET    /api/family/:id/graph                      → { nodes, links }
DELETE /api/family/:id/stories/:storyId           → suppression (identité vérifiée, auteur seul)
GET    /api/family/:id/archives/:archiveId/file   → le fichier, sous authentification
GET    /api/family/:id/export                     → JSON complet (téléchargement)
GET    /api/family/:id/metrics                    → { transmission, conservateur }
```

### 4.3 Codes d'erreur standardisés

| Code | Signification | Action client |
|---|---|---|
| `PARCIMONY_LIMIT` | Limite de parcimonie atteinte | Ne rien afficher de plus |
| `CONSTITUTION_BLOCK` | Action interdite par la Constitution | Afficher message explicatif |
| `QUARANTINE_ACTIVE` | Histoire en quarantaine | Ne pas suggérer, garder accessible |
| `NO_SIGNAL` | Aucun trigger détecté | Afficher écran d'accueil vide |

---

## 5. PARCOURS UTILISATEUR

### 5.1 « Aujourd'hui » (page par défaut)

```
┌─────────────────────────────┐
│  Héritage                   │
│  [Aujourd'hui] [Récits]...  │
├─────────────────────────────┤
│  La mémoire de la           │
│  famille Martin.            │
├─────────────────────────────┤
│  LE PASSEUR                 │
│                             │
│  « Les vélos de la rue des  │
│   Peupliers » raconte un    │
│   fait sans en donner la    │
│   raison. Quelqu'un         │
│   connaît-il le reste ?     │
│                             │
│  Cette histoire contient    │
│  une tension non résolue.   │
│                             │
│  [Raconter la suite]        │
├─────────────────────────────┤
│  RAPPEL TEMPOREL            │
│                             │
│  Aujourd'hui : « La tarte   │
│  aux poires d'automne »     │
├─────────────────────────────┤
│  [Exporter la mémoire]      │
└─────────────────────────────┘
```

**Règles d'affichage** :
- 1 Passeur max. S'il n'y en a pas, la section disparaît.
- 1 signal temporel max. S'il n'y en a pas, la section disparaît.
- Si les deux sont absents, seul le message d'accueil reste.
- Le bouton « Raconter » est toujours visible dans la navigation.

### 5.2 Lecture d'un récit

Titre, auteur, date, texte intégral, entités liées, chaînes de transmission (ce récit est né de X, il a engendré Y), conversations, puis « Poser une question », « Archiver », « Raconter la suite ».

### 5.3 Graphe familial — centré

La disposition en deux anneaux tenait avec six entités ; à cinquante, les étiquettes se chevauchaient et le graphe ne disait plus rien. Le §5.3 interdit le zoom et la physique de particules, et il a raison : ce n'est pas un outil d'exploration, c'est une image à saisir d'un coup d'œil.

L'interdit est conservé, la forme change : le graphe est **centré**. On entre par une personne, un lieu ou un objet — l'index propose les plus reliés — puis on voit ses voisins immédiats et on se déplace de proche en proche. Au plus 8 récits et 12 éléments affichés à la fois : le nombre de nœuds est borné par construction, quelle que soit la taille de la mémoire.

- Cercles colorés : bleu (personne), marron (lieu), orange (objet), rouge (récit).
- Lignes grises = liens déclarés, jamais déduits.

### 5.4 La veillée — extension hors spec v1.0, assumée

Trois récits, un par écran, en gros caractères, faits pour être lus à voix haute quand la famille est réunie. Puis un dernier écran : « Quelqu'un se souvient-il d'autre chose ? C'est le moment de le dire à voix haute — pas de l'écrire. »

**Pourquoi ce n'est pas de la gamification.** L'anti-pattern du §12 vise l'optimisation d'engagement : score, série, badge, flux infini. Ce qui les caractérise, c'est qu'ils jouent *contre* l'individu — un badge dit « tu es en retard », une série dit « ne me lâche pas ». La veillée fait l'inverse :

- Rien ne la déclenche. Elle se demande. Aucune notification, aucun rappel.
- Elle a une fin. Trois récits, puis l'écran dit de reposer le téléphone. Un flux infini capte l'attention ; celui-ci la rend.
- Aucun score, aucun classement, aucun badge. On ne gagne pas une veillée.

C'est la lecture littérale de la fiche d'identité : « Pas un réseau social. Pas une bibliothèque. **Un rite.** »

**Pourquoi elle peut montrer les récits oubliés.** L'amendement 5 interdit au Conservateur d'injecter un récit oublié dans le flux passif. Ici la famille demande explicitement qu'on lui montre quelque chose : ce n'est plus une imposition algorithmique, c'est la réponse à une question posée. La veillée donne enfin un usage au rappel patrimonial, qui n'existait jusque-là que comme ligne de métrique.

**Trois places, trois raisons, toutes dites à la famille** (§3, exclusion justifiée) :

| Place | Choix | Justification affichée |
|---|---|---|
| 1 | Le récit que personne n'a relu | « Personne ne l'a relu depuis le … » |
| 2 | Celui qui relie le plus d'entités | « C'est le récit qui relie le plus de personnes, de lieux et d'objets (N). » |
| 3 | Le dernier arrivé | « C'est le récit le plus récemment ajouté. » |

Si le corpus ne fournit pas trois récits, la veillée en compte moins. Jamais de remplissage.

**Une veillée par soir, la même pour tous.** Le premier qui l'ouvre la fixe ; elle tient jusqu'au lendemain 5 h. Deux téléphones dans la même pièce doivent montrer les mêmes récits — sans quoi il n'y a pas de veillée, seulement deux personnes qui lisent.

Un récit né d'une veillée crée un `Passage` de type `veillee`, ajouté à l'énumération de la §2.

### 5.5 Questions en un geste

Le plus jeune membre de la famille Martin a sept ans. Il ne rédigera pas une question dans un champ de texte — donc, en l'état, il ne participait pas. Or l'enfant qui demande « pourquoi ? » est, dans une famille réelle, le premier moteur de transmission.

Quatre questions préécrites, sous le champ libre, chacune créant la même `Conversation` qu'une question rédigée : « Qui est-ce ? », « C'était quand ? », « C'était où ? », « Et après, qu'est-ce qui s'est passé ? »

Ce ne sont pas des suggestions au sens du §6.1 : rien n'est recommandé, classé ni poussé. C'est une autre façon de saisir la même chose, pour ceux qui n'écrivent pas — les enfants, et tous ceux que la page blanche arrête. Un test vérifie qu'elles franchissent le filtre constitutionnel et le contrôle de langage non coercitif.

---

## 6. RÈGLES UI/UX CONSTITUTIONNELLES

### 6.1 Parcimonie visuelle
- Jamais plus d'une suggestion par écran.
- Jamais de carousel infini.
- Jamais de badge ni de notification rouge.
- Jamais de compteur « Vous avez 12 nouvelles histoires ».

### 6.2 Langage
- Ne jamais dire : « Vous n'avez pas lu… » (chantage émotionnel).
- Ne jamais dire : « Il y a longtemps que… » (guilt-tripping).
- Toujours dire : « Cette histoire… » (neutre, factuel).
- Toujours afficher la justification du Passeur en petit texte gris.

### 6.3 Contrôle utilisateur
- Bouton « Ne plus me montrer » sur chaque suggestion (loggé comme rejet).
- Bouton « Archiver » visible sur chaque récit, pas caché dans un menu.
- Bouton « Exporter » visible dans le pied de chaque page.

### 6.4 Accessibilité
- Contraste minimum 4.5:1 — ink/paper ≈ 15.6:1, muted/paper ≈ 5.3:1, accent/paper ≈ 7.2:1.
- Taille de police minimum 16px sur mobile.
- Cibles tactiles minimum 44×44px.
- Libellés associés à chaque champ, `aria-label` sur le graphe, focus visible.
- Lien d'évitement vers le contenu, révélé au focus clavier.
- **Taille du texte réglable** (normale / grande / très grande), sur la page « Qui êtes-vous ? ». Le réglage est **par appareil**, pas par membre : la tablette de la grand-mère n'a pas les mêmes yeux que le téléphone de sa petite-fille, et c'est souvent le même compte familial qui sert sur les deux. Ce n'est pas une préférence esthétique mais une condition d'accès — un récit qu'on ne peut pas lire n'est pas transmis.
- Page courante marquée `aria-current="page"` **et** soulignée : la couleur seule ne dirait rien à qui ne la perçoit pas.

---

## 7. STACK TECHNIQUE

| Technologie | Version | Rôle |
|---|---|---|
| Next.js | 14 | Framework fullstack, App Router |
| TypeScript | 5.3+ | Typage strict |
| Tailwind CSS | 3.4+ | Styling |
| Prisma | 5.7+ | ORM, migrations |
| PostgreSQL | 15+ | Base de données |
| Redis | 7+ | Cache, rate limiting (optionnel en dev) |
| OpenAI API (gpt-4o) | — | Opérations linguistiques (optionnel) |
| Vitest | 1.6 | Tests |

---

## 8. SÉCURITÉ & ÉTHIQUE

### 8.1 Constitution technique

**Amendement 1 — Pas d'inférence émotionnelle.** `src/lib/constitution.ts`. Filtre appliqué à toute sortie LLM. Les apostrophes typographiques sont normalisées avant test : « tu as l'air » et « tu as l’air » sont la même phrase.

**Amendement 3 — La famille possède ses données.** `/api/family/:id/export` renvoie toutes les données, sans traitement, sans filtre.

**Amendement 5 — Pas d'imposition algorithmique.** Le Conservateur ne modifie jamais l'ordre d'affichage par défaut (chronologique). Il peut seulement exclure une histoire sur-exposée des suggestions, et documenter.

### 8.2 Sécurité classique
- HSTS, `X-Content-Type-Options`, `X-Frame-Options`, `Permissions-Policy` (géoloc/caméra/micro désactivés).
- Cookies `HttpOnly`, `Secure` en production, `SameSite=Strict`.
- Validation Zod sur tous les inputs API.
- Rate limiting : 100 req/min par IP, 10 req/min par famille sur les routes Passeur.
- Pas de stockage de données personnelles hors nom, date de naissance et date de décès.
- Comparaison du jeton familial en temps constant (`timingSafeEqual`).

---

## 9. MÉTRIQUES

### 9.0 Une mesure impossible ne vaut pas zéro

Défaut de forme trouvé en auditant la page Transmission : **le produit affichait des zéros là où il n'avait rien pu mesurer.**

| Affiché | Signification réelle | Comment ça se lisait |
|---|---|---|
| `distorsion 0 / 100` | aucune lecture enregistrée | « mémoire parfaitement fidèle » |
| `0 récit sur-exposé` | aucune impression à examiner | « nous avons vérifié, tout va bien » |
| `transmission 0 %` | trois récits, corpus trop mince | « cette famille ne transmet pas » |
| `conversion 0 %` | aucune question posée | « le Passeur ne sert à rien » |

Ces quatre chiffres portent désormais `null`, et la page écrit « — » avec la raison. **Un zéro doit être un constat, jamais un aveu d'ignorance déguisé.**

Le seuil de `MIN_STORIES_FOR_RATE = 5` n'est pas arbitraire : la cible V1 est « une histoire sur cinq ». En dessous de cinq récits, la mesure ne peut prendre que 0, 25, 50, 75 ou 100 % — elle saute par-dessus le seuil qu'elle est censée évaluer.

**Erreur de fait corrigée au passage.** Un récit jamais relu était compté comme « non relu depuis douze mois » quelle que soit sa date de création : un récit écrit la veille était donc déclaré patrimoine en péril. C'était faux, et cela remplissait la première place de la veillée avec des nouveautés. La condition exige désormais que le récit **existe** depuis douze mois pour avoir pu être oublié pendant douze mois.

### 9.1 North Star

```
transmission_rate = récits ayant engendré au moins un autre récit / total récits
```

Objectif V1 : > 20 %.

**Précision d'implémentation** : la spec v1.0 écrivait `passages_count / stories_count` tout en définissant la primitive comme « histoires ayant engendré au moins une autre ». Les deux divergent dès qu'un récit en engendre plusieurs. `transmissionRate` compte les **parents distincts** ; `rawPassageRatio` expose le ratio brut pour comparaison.

### 9.2 Métriques produit

| Métrique | Définition | Cible V1 |
|---|---|---|
| `transmission_rate` | Récits ayant transmis / total | > 20 % |
| `medianLatencyDays` | Délai médian parent → enfant | — |
| `maxChainDepth` | Plus longue chaîne de transmission | — |
| `passeur_conversion` | Conversations devenues récit | > 15 % |
| `quarantine_rate` | Récits en quarantaine | < 5 % |
| `distortionScore` | Écart écriture / lecture par auteur | mesuré, non corrigé |

---

## 10. ROADMAP

| Sprint | Contenu | État |
|---|---|---|
| 0 | Setup, schéma, migrations, seed | fait |
| 1 | CRUD récits, pages, tests | fait |
| 2 | Entités, graphe SVG | fait |
| 3 | Trigger Model, Passeur, parcimonie | fait |
| 4 | Conservateur, VisibilityLog, quarantaine, distorsion | fait |
| 5 | LLM Operator, filtre constitutionnel | fait |
| 6 | Traditions, conversations, export, métriques | fait |
| 7 | Service Worker, hors-ligne, lien d'évitement, page courante annoncée | fait |
| — | La veillée (§5.4), questions en un geste (§5.5) | fait |
| — | Narrateur ≠ scribe (§2.3), stockage et affichage des archives (§2.4), taille du texte | fait |
| — | Onboarding (§2.4), correction (§2.5), sourdine par membre (§2.6), recherche (§2.7), pilote S3 (§2.8), identité (§4.1), graphe centré (§5.3), restauration, CI | fait |
| — | Transcription vérifiée par l'humain (§3.5) | fait |
| 7 | Audit axe-core automatisé | ouvert |

---

## 11. ANNEXES

### Annexe A — Constitution de la Mémoire

1. **Primitive** : une histoire doit pouvoir engendrer une autre histoire.
2. **Parcimonie** : montrer le minimum nécessaire. Jamais le maximum possible.
3. **Exclusion justifiée** : toute histoire affichée exclut les autres. Cette exclusion doit être défendable.
4. **Pas d'inférence émotionnelle** : le produit ne déduit jamais une émotion à partir d'une donnée.
5. **Accessibilité active** : aucune histoire ne devient inaccessible par effet d'algorithme.
6. **Oubli = droit** : archivage, silence, suppression sont des décisions familiales absolues.
7. **Dispensabilité** : le succès ultime est que la famille continue de transmettre sans l'app.

### Annexe B — Types de structure narrative

Source de vérité : `src/lib/structure-types.ts`.

```
objet-emotionnel, tradition-origine, lieu-sensoriel, trait-caractere,
evenement-marquant, recette-familiale, voyage-souvenir, rencontre-decisive,
secret-revele, echec-apprentissage, rituel-quotidien, heritage-symbole,
dispute-reconciliation, deuil-memoire, naissance-naissance, metier-savoir,
migration-racine, passion-transmise, peur-surmontee, croyance-familiale,
objet-perdu-retrouve, chanson-danse, jeu-enfance, maison-demenagement,
animal-familier, ecole-apprentissage, guerre-paix, fete-tradition,
amour-rencontre, argent-pauvrete, sante-maladie, reve-non-accompli,
lettre-non-envoyee
```

### Annexe C — Checklist pré-déploiement

- [x] Schéma Prisma validé (`prisma validate`)
- [x] Migrations testées sur base vierge
- [x] Seed « Famille Martin » chargeable
- [x] Rate limiting actif sur les routes API
- [x] Filtre émotionnel actif sur les sorties LLM
- [x] Export JSON testé
- [x] Isolation cross-family vérifiée (403)
- [x] Pas de données personnelles sensibles en base
- [x] Variables d'environnement documentées (`.env.example`)
- [x] README d'installation < 10 minutes
- [x] Service Worker (réseau d'abord, cache en secours, page hors-ligne)
- [x] Lien d'évitement clavier, page courante annoncée (`aria-current`)
- [x] Création de famille et gestion des membres
- [x] Correction d'un récit sans perte des passages
- [x] Identité vérifiée exigée pour supprimer ; liens révocables individuellement
- [x] Restauration d'un export
- [x] Intégration continue (`.github/workflows/ci.yml`)
- [ ] Accessibilité : audit axe-core automatisé
- [x] Upload binaire des archives, servi sous authentification
- [x] Taille du texte réglable par appareil

---

## 12. ANTI-PATTERNS

- Ne pas utiliser de machine à états complexe pour les rôles utilisateurs. Utiliser des signaux comportementaux.
- Ne pas ajouter de « feed » ou « timeline » infini. C'est contraire à la parcimonie.
- Ne pas envoyer de notifications push. Jamais.
- Ne pas utiliser de « like » ni de score. Pas d'optimisation d'engagement.
- Ne pas stocker de données externes (GPS, contacts, calendrier).

---

**Document rédigé le 28 juillet 2026. Version 1.0.**
**Basé sur la Constitution de la Mémoire V7.5 et le PRD Héritage V1.0.**
**Amendé lors de l'implémentation : voir §2.2, §3.3 et §9.1 pour les écarts assumés.**
