# Héritage

Application de mémoire familiale. Pas un réseau social, pas une bibliothèque : un rite.

**Primitive** : une histoire doit pouvoir engendrer une autre histoire.
Tout le produit se mesure à `transmission_rate` — la part des récits qui en ont suscité au moins un autre.

La spécification qui fait foi est [`HERITAGE_SPEC.md`](./HERITAGE_SPEC.md). Ce README explique comment faire tourner le code.

---

## Installation (moins de 10 minutes)

Il faut Node 20+ et un PostgreSQL 15+. Redis et OpenAI sont facultatifs.

```bash
git clone <ce-dépôt> && cd heritage-app
npm install
cp .env.example .env          # renseigner au minimum DATABASE_URL
npx prisma migrate dev        # crée le schéma
npm run db:seed               # charge la famille Martin
npm run dev
```

Le seed affiche le lien familial :

```
Famille Martin créée.
Lien familial : /f/cmsd7vodd0000jeoxqdli408g
```

Ouvrir `http://localhost:3000/f/<cet-identifiant>`. Ce lien pose le cookie familial, puis demande qui consulte.

Pour une vraie famille, passer plutôt par **`/commencer`** : la page fonde une famille avec son premier membre, puis `/famille` permet d'ajouter les autres et de leur transmettre leur lien personnel.

### Sans Redis, sans OpenAI

- **Sans `REDIS_URL`** : les compteurs (parcimonie du Passeur, quarantaine, rate limiting) passent sur un store mémoire. Parfait en développement ; en production multi-instances il faut un vrai Redis, sinon chaque instance compte pour elle seule.
- **Sans `OPENAI_API_KEY`** : le `LLMOperatorService` renvoie directement ses fallbacks. Le Passeur pose alors ses questions déterministes, la classification narrative retombe sur `evenement-marquant`, l'extraction d'entités reste manuelle. **Aucune fonctionnalité ne casse** — c'est délibéré : le LLM est un opérateur, pas une dépendance vitale.

---

## Commandes

| Commande | Effet |
|---|---|
| `npm run dev` | Serveur de développement |
| `npm run build` | Build de production (génère le client Prisma) |
| `npm test` | Suite de tests |
| `npm run typecheck` | `tsc --noEmit`, mode strict |
| `npm run db:migrate` | Crée et applique une migration |
| `npm run db:seed` | Charge la famille Martin (idempotent) |
| `npm run db:reset` | Réinitialise la base, puis re-seed |

---

## Architecture

```
src/
├── app/                    Pages (App Router) + routes API + actions serveur
│   ├── page.tsx            « Aujourd'hui »  — au plus 1 Passeur, 1 signal
│   ├── commencer/          Fonder une famille
│   ├── famille/            Membres, liens personnels, révocation
│   ├── restaurer/          Recréer une famille depuis un export
│   ├── brouillons/         Transcriptions à écouter et relire avant validation
│   ├── veillee/            Trois récits à lire à voix haute, ensemble
│   ├── recits/             Liste, lecture, création
│   ├── archives/           Photos, documents, enregistrements
│   ├── traditions/         Rituels cycliques
│   ├── graphe/             Graphe SVG déterministe (§5.3)
│   ├── transmission/       Métriques, y compris celles qui accusent le produit
│   ├── f/[familyId]/       Porte d'entrée : pose le cookie familial
│   └── api/family/[id]/    Contrat REST de la §4.2
├── services/               Les 4 acteurs algorithmiques + story/tradition/export/metrics
├── lib/                    Constitution, validation Zod, store, session, normalisation
└── components/             Navigation
```

### Les quatre acteurs

| Service | Mission | Ce qu'il ne fait jamais |
|---|---|---|
| `TriggerModelService` | Détecter quand le présent active le passé | Lire une donnée non déclarée dans l'app (GPS, contacts, calendrier) ; envoyer une notification |
| `ConservateurService` | Empêcher qu'une histoire devienne inaccessible par effet d'algorithme | Modifier l'ordre d'affichage ; booster un récit oublié ; corriger un biais qu'il a mesuré |
| `PasseurService` | Augmenter la probabilité qu'une histoire en engendre une autre | Poser plus d'une question par session ; poser une question sans justification ; parcourir tout le corpus |
| `LLMOperatorService` | Exécuter des opérations informationnelles vérifiables | Décider ; inventer un fait ; inférer une émotion |

Chaque service est indépendant. Ils communiquent par la base, jamais entre eux — sauf le Passeur, qui consulte le Conservateur pour écarter les récits sur-exposés.

---

## La Constitution est testée, pas commentée

`tests/constitution.test.ts` est normatif. Si un test échoue, le code ne part pas.

- **Amendement 1 — pas d'inférence émotionnelle.** Toute sortie LLM traverse `constitutionEmotionFilter`. Une sortie qui infère une émotion devient un fallback, même si la vérification propre à l'opération est passée. Les apostrophes typographiques ne permettent pas de contourner le filtre.
- **Amendement 3 — la famille possède ses données.** `GET /api/family/:id/export` renvoie tout, sans traitement, sans filtre : archivés, quarantaine et journaux de visibilité compris.
- **Amendement 5 — pas d'imposition algorithmique.** L'ordre d'affichage est chronologique partout. Le Conservateur ne peut qu'exclure des suggestions et documenter.
- **Parcimonie.** Elle est appliquée dans les services, pas dans le CSS : `TriggerModelService` renvoie au plus un signal, `PasseurService` au plus une question par heure et par membre.

### Coût du Passeur

Chaque règle déclare une requête bornée (`where` + `take`) plutôt que de filtrer tout le corpus en mémoire, et la reformulation par le LLM n'intervient qu'**après** la sélection, sur la seule question affichée. Un test vérifie qu'une session ne produit qu'un appel au modèle, quel que soit le nombre de candidats.

Une lecture n'est journalisée qu'une fois par membre et par récit sur 30 minutes : le budget de visibilité se calcule sur ces journaux, donc sans déduplication un rafraîchissement de page suffirait à faire sortir un récit des suggestions.

### Le jeu sans la gamification

La Constitution interdit le score, le badge, la série et le flux infini (§6.1, §12). Elle n'interdit pas le rite — la fiche d'identité en fait même la définition du produit.

**La veillée** (`/veillee`) est la forme retenue : trois récits en gros caractères, un par écran, faits pour être lus à voix haute quand la famille est réunie ; puis un dernier écran qui invite à répondre de vive voix et à reposer le téléphone. Rien ne la déclenche — elle se demande. Elle a une fin. On ne la gagne pas. Le premier qui l'ouvre la fixe pour toute la famille jusqu'au lendemain matin : deux téléphones dans la même pièce montrent les mêmes récits.

C'est aussi ce qui donne enfin un usage au rappel patrimonial du Conservateur : l'amendement 5 lui interdit d'injecter un récit oublié dans le flux passif, mais la veillée est une demande explicite, pas une imposition.

**Les questions en un geste** règlent l'autre exclusion : le plus jeune membre a sept ans et n'écrira pas dans un champ de texte. Quatre questions préécrites créent la même `Conversation` qu'une question rédigée. Ce n'est pas une suggestion — rien n'est classé ni poussé — c'est une saisie sans clavier.

### Faire une place à toute la famille

**Narrateur ≠ scribe.** `authorId` désigne qui a saisi le récit ; `narratorId`, qui l'a raconté. Sans cette distinction, Jeanne (92 ans, ne tape pas) et Lucas (7 ans, ne tape pas non plus) disparaissaient de leur propre mémoire familiale — tout était attribué à celui qui tenait le clavier. La métrique de distorsion compte désormais la voix, pas le clavier : un test montre qu'elle aurait sinon déclaré la mémoire parfaitement fidèle au moment précis où une voix s'éteignait.

**Les photos sont enfin visibles.** Dépôt réel depuis la page d'un récit, affichage dans le récit et dans les archives. Aucun fichier n'est exposé à une URL publique : tout passe par une route authentifiée qui vérifie la famille avant de servir un octet, et répond `Cache-Control: private`. Une photo de famille sur un bucket public est une photo de famille indexable.

**Taille du texte réglable**, par appareil et non par membre : la tablette de la grand-mère et le téléphone de sa petite-fille n'ont pas les mêmes yeux, et c'est souvent le même compte familial qui sert sur les deux.

### Deux liens, deux niveaux d'identité

Il n'y a toujours pas de mot de passe — c'est le choix de la spec, et il tient pour **lire**. Il ne tenait pas pour **détruire** : l'identité se choisissait dans une liste, et la suppression la vérifiait contre un `?memberId=` fourni par l'appelant. La garde demandait à quelqu'un s'il avait le droit, et le croyait.

| Lien | Identité | Peut |
|---|---|---|
| `/f/<familyId>` | déclarée | lire, écrire, questionner, répondre, archiver |
| `/f/<familyId>/m/<memberId>/<jeton>` | vérifiée | tout cela, **et supprimer ses propres récits** |

Le cookie de membre est signé, niveau compris — sinon il suffirait de remplacer `declared` par `verified` à la main. Le jeton personnel intègre un numéro de version : l'incrémenter **révoque le lien d'un seul membre**, sans déconnecter le reste de la famille. Les routes API dérivent l'identité du cookie signé, jamais d'un paramètre.

### Corriger sans perdre la transmission

`/recits/<id>/modifier` corrige le texte d'un récit. Ce n'est pas du confort : avant, la seule façon de rattraper une faute dans un récit dicté était de supprimer et retaper, et `DELETE` efface les `Passage` attachés. Corriger une virgule coûtait une chaîne de transmission — la seule chose que le produit mesure.

### La transcription ne garantit rien — l'architecture, si

Whisper **invente**. C'est un modèle génératif : sur un silence ou une hésitation, il rend la suite la plus probable, pas le silence. Il produit des phrases entières jamais prononcées, et davantage sur les voix âgées — celles pour qui la fonction existe. Aucun réglage ne supprime ça.

Le produit ne promet donc pas l'exactitude. Il organise la vérification :

- **L'audio est l'original**, conservé et rattaché au récit. Le texte n'en est qu'une copie contestable.
- **Une transcription n'est pas un récit** : elle attend dans `/brouillons` et ne compte dans aucune métrique tant qu'un membre n'a pas écouté et relu.
- **Le doute est visible** : chaque segment porte les indicateurs de Whisper lui-même (`avg_logprob`, `compression_ratio`, `no_speech_prob`), avec les seuils de son implémentation de référence.
- **Les inventions connues sont retirées** et listées à l'écran ; **le doute, lui, est conservé et signalé** — supprimer un passage peut-être réel serait décider à la place de la famille.
- **La provenance est affichée** sur le récit final.

`whisper-1` (pas `gpt-4o-transcribe`, qui lisse et n'expose pas le doute), `temperature: 0`, langue forcée, **aucun prompt**. Des tests fixent chacun de ces réglages.

Clé : https://platform.openai.com/api-keys. Sans elle, tout le reste fonctionne — l'enregistrement audio marche seul.

### Isolation des familles

Toute requête filtre par `familyId` (§2.1 règle 3). Les routes API vérifient le cookie signé ; une requête portant sur une autre famille reçoit `403`.

---

## Variables d'environnement

| Variable | Obligatoire | Rôle |
|---|---|---|
| `DATABASE_URL` | oui | PostgreSQL |
| `FAMILY_TOKEN_SECRET` | en production | Signature HMAC du cookie familial |
| `REDIS_URL` | non | Compteurs partagés entre instances |
| `OPENAI_API_KEY` | non | Classification, extraction d'entités, formulation des questions |
| `STORAGE_DIR` | non | Répertoire des archives (défaut `.data/archives`) |
| `TRANSCRIPTION_WORKER_SECRET` | si transcription | Protège la route qui dépile la file (elle déclenche des appels facturés). |
| `STORAGE_S3_*` | en production | Bucket S3/R2. Sans lui, sur un hébergement éphémère, les photos disparaissent au redéploiement. |

---

## État d'avancement

Sprints 0 à 6 de la roadmap (§10) : schéma et seed, CRUD des récits, graphe et entités, Trigger Model et Passeur, Conservateur, opérateur LLM (classification, extraction d'entités, formulation), traditions, conversations, export et page métriques.

Sprint 7, fait : Service Worker (réseau d'abord, cache en secours, page hors-ligne), lien d'évitement clavier, page courante annoncée.

Depuis : création de famille et gestion des membres, correction des récits, identité vérifiée pour supprimer avec liens révocables individuellement, restauration d'un export, pilote S3/R2, sourdine par membre au lieu d'une quarantaine globale, seuil de sur-exposition relatif à la taille du corpus, distorsion agrégée en base, recherche insensible aux accents, graphe centré, intégration continue.

Ouvert : transcription Whisper ; audit axe-core automatisé — les règles d'accessibilité de la §6.4 sont appliquées à la main, pas vérifiées par un outil. Le pilote S3 est écrit mais n'a pas pu être testé contre un vrai bucket depuis cet environnement.
