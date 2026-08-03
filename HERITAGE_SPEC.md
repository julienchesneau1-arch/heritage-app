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
│  ├── 6 Pages : Aujourd'hui, Récits, Archives, Traditions,   │
│  │             Graphe, Transmission (métriques)             │
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
| `Story` | Le cœur du produit. Texte brut, type narratif imposé, ton, longueur déduite. |
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
| Budget de visibilité | > 15 % des impressions sur 12 mois | Le récit sort des **suggestions**. Il reste lisible, cherchable, exportable. |
| Rappel patrimonial | Non vu depuis 12 mois | Listé sur la page Transmission. Jamais injecté dans le flux. |
| Quarantaine | 3 rejets explicites **du même membre** | Retiré des suggestions. Réversible à tout moment. |
| Distorsion | — | Écart entre qui écrit et qui est lu. Mesuré, affiché, **jamais corrigé**. |

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

---

## 4. API REST

### 4.1 Authentification

V1 : accès par URL privée (`/f/<familyId>`) + cookie familial signé (HMAC). Pas de mot de passe. L'URL est le secret partagé.

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

### 5.3 Graphe familial

- Cercles colorés : bleu (personne), marron (lieu), orange (objet), rouge (récit).
- Lignes grises = liens déclarés, jamais déduits.
- Cliquer sur un nœud filtre les récits liés.
- Disposition déterministe en deux anneaux. Pas de zoom, pas de physique de particules.

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
| 7 | Upload binaire des archives, transcription Whisper, audit axe-core | ouvert |

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
- [ ] Accessibilité : audit axe-core automatisé
- [ ] Upload binaire des archives (l'API n'enregistre que les métadonnées)

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
