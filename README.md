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

Ouvrir `http://localhost:3000/f/<cet-identifiant>`. Ce lien pose le cookie familial, puis demande qui consulte. C'est tout : il n'y a pas de mot de passe (§4.1 de la spec — l'URL est le secret partagé).

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
| `STORAGE_*` | non | Stockage objet des archives (S3 / R2) |

---

## État d'avancement

Sprints 0 à 6 de la roadmap (§10) : schéma et seed, CRUD des récits, graphe et entités, Trigger Model et Passeur, Conservateur, opérateur LLM (classification, extraction d'entités, formulation), traditions, conversations, export et page métriques.

Sprint 7, fait : Service Worker (réseau d'abord, cache en secours, page hors-ligne), lien d'évitement clavier, page courante annoncée.

Sprint 7, ouvert : upload binaire réel des archives — l'API enregistre aujourd'hui les métadonnées d'un fichier déjà déposé sur le stockage objet ; transcription Whisper ; audit axe-core automatisé — les règles d'accessibilité de la §6.4 sont appliquées à la main, pas vérifiées par un outil.
