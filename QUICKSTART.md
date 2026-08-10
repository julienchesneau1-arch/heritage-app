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

## Sur le téléphone

```bash
pnpm jarvis:web
```

Le terminal affiche un lien à ouvrir sur le téléphone, connecté au **même
Wi-Fi** :

```text
  Ouvre ce lien sur le téléphone, connecté au même Wi-Fi :

    http://192.168.1.20:7375/#t=vraML156SBucThpMD2u_TIISg4DrP878MB6HZbcjPrI
```

Sur iPhone : **Partager → Sur l'écran d'accueil** en fait une icône qui s'ouvre
en plein écran, sans barre d'adresse. Ce n'est pas l'application native — celle-ci
viendra en Swift (ADR-016) et parlera à cette même API.

### Ce qui encadre cette ouverture

Rendre Jarvis joignable depuis le Wi-Fi, c'est le rendre joignable par **tout**
appareil du Wi-Fi. Le lien porte donc un jeton de 256 bits, exigé sur chaque
appel de données. Le serveur **refuse de démarrer** si le jeton manque, si
l'adresse d'écoute sort du réseau privé, ou si la chaîne d'audit est rompue.
Cinq échecs d'authentification verrouillent l'adresse pendant une minute — même
avec le bon jeton ensuite.

Le jeton est dans le **fragment** (`#`) du lien : un fragment n'est jamais
transmis au serveur, donc jamais écrit dans un journal d'accès. Le navigateur le
range une fois, retire le `#` de la barre d'adresse, puis l'envoie en en-tête.

Détails et limites assumées : [`docs/03 §14`](docs/03_SECURITY_AND_PRIVACY.md) et
ADR-023. Deux à connaître avant de s'en servir :

- **le trafic est en HTTP, non chiffré.** Sur un Wi-Fi partagé ou ouvert, un
  tiers peut lire le jeton. Réservez-le à votre réseau domestique ;
- **il n'y a pas de révocation par appareil.** Pour couper l'accès à un
  téléphone perdu : changer `JARVIS_WEB_TOKEN` dans `.env` et relancer — ce qui
  déconnecte tous les appareils.

```bash
JARVIS_WEB_PORT=7376 pnpm jarvis:web    # si le port est pris
JARVIS_WEB_HOST=192.168.1.30 pnpm jarvis:web    # choisir l'interface
```

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
`✓ C'est fait` n'apparaît qu'après relecture de l'état réel.

Coupez PostgreSQL en cours de session (`brew services stop postgresql`), puis
demandez-lui d'ajouter une tâche. Trois choses doivent se produire, et elles ont
été vérifiées en exécution :

1. **Jarvis ne meurt pas.** Le processus encaisse la coupure ;
2. il **refuse d'agir** au lieu de tenter à l'aveugle : *« La base de données
   est injoignable. Rien n'a été tenté. »* ;
3. ce qui ne demande pas la base — comprendre la phrase, dire ce qu'il ne sait
   pas faire — continue de fonctionner.

Redémarrez PostgreSQL : Jarvis repart **sans qu'il faille le relancer**, et
écrit un événement `DATABASE_RECOVERED` au journal. Un incident ne laisse pas
de trou inexpliqué dans `/audit`.

**Il dit ce qu'il ne sait pas faire, et distingue deux cas.**
« Envoie un mail à Paul » → il a compris, la capacité n'existe pas.
« zzz flurb » → il n'a pas compris la formulation. Deux réponses différentes.

**Il ne devine pas — et il ne substitue rien.**
Demandez « Retrouve le devis du carreleur » : il répond qu'il ne sait pas
chercher dans vos documents. Il ne fait **pas** une recherche dans votre mémoire
personnelle en répondant « c'est fait ». De même, « Rappelle-moi jeudi
d'appeler le médecin » est refusé plutôt que transformé en tâche sans date.

Une recherche mémoire annonce toujours **où** elle a cherché — donc aussi ce
qu'elle n'a pas consulté.

> ⚠ La désambiguïsation entre deux homonymes (« quel Jean ? ») n'existe **pas
> encore** : le Context Engine est écrit et testé, mais pas branché. C'est le
> chantier de la prochaine étape. Voir `docs/11`.

**Le journal fait foi.**
`/audit` répond depuis la chaîne d'événements, pas depuis une reconstruction.
La chaîne est vérifiée par hash à chaque consultation.

**Rien ne sort de la machine.**
Aucun appel réseau. `/diagnostic` le confirme.

**La passerelle web refuse de s'ouvrir sans garde-fou.**
Videz `JARVIS_WEB_TOKEN` dans `.env`, lancez `pnpm jarvis:web` : refus de
démarrer, avec la marche à suivre. Essayez `JARVIS_WEB_HOST=0.0.0.0` : refus
également — le joker servirait toute interface apparaissant plus tard.

---

## Vérifier soi-même

```bash
pnpm test            # 345 tests
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
