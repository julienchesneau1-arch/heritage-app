# Tester Jarvis

Trois commandes. Jarvis fonctionne **sans Internet et sans aucun modèle
installé** — l'analyse d'intention se fait par règles.

```bash
git clone https://github.com/julienchesneau1-arch/heritage-app.git
cd heritage-app
pnpm install
pnpm jarvis:setup
pnpm jarvis
```

---

## Prérequis

| | Version | Note |
|---|---|---|
| **Node** | 22+ | `nvm install 22` |
| **pnpm** | 10+ | `corepack enable` |
| **PostgreSQL** | 16+ | voir ci-dessous |

### PostgreSQL — deux chemins

**A. Vous l'avez déjà** (Postgres.app, Homebrew, service système)

```bash
pnpm jarvis:setup
```

Le script détecte le serveur, génère des mots de passe aléatoires dans `.env`
(ignoré par git), crée les rôles et applique les migrations.

S'il ne peut pas se connecter en superutilisateur, renseignez
`JARVIS_DB_SUPERUSER_PASSWORD` dans `.env` puis relancez.

**B. Vous partez de zéro — Docker**

```bash
docker compose -f infrastructure/docker/docker-compose.yml up -d
# puis dans .env : JARVIS_DB_SUPERUSER_PASSWORD=jarvis_local_superuser
pnpm jarvis:setup
```

L'image `pgvector/pgvector:pg16` embarque déjà l'extension vectorielle.

> ⚠️ **Ce chemin Docker n'a pas pu être exécuté avant livraison** — l'environnement
> de développement avait le client Docker mais pas le démon. Le chemin A est
> vérifié de bout en bout. Si le B coince, dites-le moi.

### pgvector

Pas indispensable pour commencer. Sans lui, la **voie sémantique** de la
recherche est indisponible ; les voies structurée et lexicale fonctionnent, et
Jarvis le dit à chaque recherche plutôt que de rendre une liste plus courte sans
explication.

```bash
brew install pgvector          # macOS
apt install postgresql-16-pgvector   # Debian/Ubuntu
```

---

## Ce que Jarvis sait faire aujourd'hui

```text
note <texte>                    créer une note
ajoute <chose> à ma liste       créer une tâche
rappelle-moi de <chose>         créer une tâche
mes tâches                      lister les tâches ouvertes
retiens que <fait>              mémoriser
que sais-tu sur <sujet>         chercher en mémoire
```

Commandes : `/audit` · `/inbox` · `/diagnostic` · `/aide` · `/quitter`

---

## Une session réelle

```text
> Ajoute du terreau à ma liste
  ✓ C'est fait.

> Retiens que le carrelage est un Marazzi Treverk 20x120
  ✓ C'est fait.

> Que sais-tu sur Marazzi
  ✓ C'est fait.
  (recherche sans la voie sémantique — aucun modèle d'embeddings)
  • le carrelage est un Marazzi Treverk 20x120  [FACT]

> Mes tâches
  ✓ C'est fait.
  • du terreau

> Qu'as-tu fait aujourd'hui ?
  Depuis le journal d'exécution :
      1 × MEMORY_ADDED [CONFIRMED]
      1 × MEMORY_SEARCHED [CONFIRMED]
      1 × TASK_CREATED [CONFIRMED]
      1 × TASK_LISTED [CONFIRMED]

  Chaîne d'audit intacte (4 événements).
```

---

## Ce qui vaut la peine d'être éprouvé

Ce ne sont pas des fonctionnalités — ce sont les propriétés que le système
prétend garantir. Essayez de les prendre en défaut.

**Il ne prétend jamais avoir fait ce qu'il n'a pas fait.**
`✓ C'est fait` n'apparaît qu'après relecture de l'état réel. Coupez PostgreSQL
en cours de route : vous obtiendrez `?` ou `✗`, jamais un faux succès.

**Il dit ce qu'il ne sait pas faire, et distingue deux cas.**
« Envoie un mail à Paul » → il a compris, la capacité n'existe pas.
« zzz flurb » → il n'a pas compris la formulation. Deux réponses différentes.

**Il ne devine pas.**
Créez deux contacts homonymes, puis parlez de l'un d'eux : il demande lequel,
au lieu de choisir.

**Le journal fait foi.**
`/audit` répond depuis la chaîne d'événements, pas depuis une reconstruction.
La chaîne est vérifiée par hash à chaque consultation.

**Rien ne sort de la machine.**
Aucun appel réseau. `/diagnostic` le confirme.

---

## Vérifier soi-même

```bash
pnpm test            # 221 tests
pnpm gate:phase0     # journal inaltérable, isolation fournisseurs, secrets
pnpm gate:phase1     # mémoire, contexte, ambiguïté, hors ligne
pnpm gate:phase2     # outils, idempotence, vérification, injection
```

Les tests tournent sur une base **séparée** (`jarvis_test`). Un garde-fou refuse
de les lancer si la base visée ne contient pas « test » dans son nom — la suite
recrée le schéma à chaque exécution et détruirait des données réelles.

---

## Répondre à trois questions ouvertes de l'audit

Sur votre Mac, avec Ollama :

```bash
ollama pull qwen3
pnpm bench
```

Le banc mesure le seuil des 32 Go pour MLX, l'inventaire des runtimes locaux, et
l'appel d'outils en français — **y compris deux familles de cas que les
classements publics ignorent** : l'ambiguïté et l'injection. Un modèle qui
obtient 90 % au global mais 0 % sur l'injection est inutilisable ici.

Les quatre autres questions attendent soit un corpus audio que vous seul pouvez
fournir, soit des phases non construites. Le banc le dit à chaque exécution
plutôt que de renvoyer une valeur inventée.

---

## Si quelque chose casse

Chaque échec devrait expliquer quoi corriger. Si vous tombez sur une erreur
opaque, c'est un défaut en soi — envoyez-la moi.

Et chaque fois que Jarvis répond mal, **la phrase exacte** fait un bon scénario
de non-régression. C'est ainsi que le benchmark personnel se remplira de vécu
plutôt que d'imaginé.
