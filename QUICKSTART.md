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

> ⚠ **UN SECOND CLONE CASSE LE PREMIER, et rien ne prévient.**
>
> `jarvis:setup` **régénère les mots de passe de tous les rôles PostgreSQL**.
> Si vous installez Jarvis une seconde fois — un autre dossier, une autre
> machine partageant la même base — le premier clone répondra à la requête
> suivante :
>
> ```text
> ✗ query: password authentication failed for user "jarvis_app"
> ```
>
> Ce n'est pas une panne : c'est le comportement normal d'un script qui génère
> des secrets. Mais le message n'oriente vers rien.
>
> **Deux issues** : relancer `pnpm jarvis:setup` dans le clone cassé (il
> régénère à son tour), ou recopier les trois lignes `*_PASSWORD` du `.env` le
> plus récent vers l'autre. *Trouvé en installant un clone neuf pour vérifier
> que le démarrage à froid fonctionne — ADR-100.*

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

## Le modèle local — optionnel, et il faut choisir en connaissance de cause

Jarvis fonctionne **sans aucun modèle** : c'est le défaut livré, et un invariant
produit (I1, I2). Un modèle local n'ajoute qu'une chose — la compréhension de
formulations qu'aucune règle ne couvre (`Tier 1`, ADR-081).

```bash
brew install ollama && brew services start ollama
ollama pull <modèle>
```

Puis dans `config/default.json` : `"localModel": { "enabled": true, … }`.

### Ce qui décide vraiment : le processeur, pas la RAM

| Machine | Ce qu'il faut savoir |
|---|---|
| **Apple Silicon** (M1…M4) | Ollama accélère par Metal. Un 7B est confortable ; un 14B passe à partir de 16 Go |
| **Mac Intel** | **aucune accélération** — les graphiques Intel intégrés ne sont pas utilisés. L'inférence tourne sur le CPU seul, et c'est LE facteur limitant |
| **8 Go de RAM** | un 7B quantifié (~4 Go) tient à peine à côté de macOS, PostgreSQL et Node. Viser 2–3 Go de modèle |

### Choisir la taille — la tâche est plus étroite qu'on ne croit

Le `Tier 1` ne discute pas : il choisit **un outil dans un catalogue fermé** et
remplit des paramètres, en JSON strict, à `temperature: 0`. Ce n'est pas du
raisonnement ouvert, et un petit modèle peut suffire.

| Modèle | Poids | Licence |
|---|---|---|
| `qwen2.5:3b` | ~2 Go | Apache 2.0 |
| `mistral:7b` | ~4 Go | Apache 2.0 |
| `qwen2.5:14b` | ~9 Go | Apache 2.0 |
| `llama3.x` | — | ⚠ restrictions d'usage commercial (`docs/04 §3`) |

### Mesurer AVANT de brancher

```bash
time ollama run qwen2.5:3b "Réponds uniquement par OK"
```

Aucun chiffre n'est donné ici volontairement : la vitesse dépend de la machine,
et ce dépôt ne publie pas d'estimation déguisée en mesure. Si la réponse prend
dix secondes, le local ne tiendra pas une conversation sur cette machine — et
**c'est une information, pas un échec**.

### Vérifier que le modèle répond VRAIMENT

```
/diagnostic
```

```text
Modèle local   ollama:qwen2.5:3b — répond
```

⚠ **Cette ligne n'existait pas avant ADR-086, et son absence était un piège.**
Un Ollama non lancé, un nom de modèle mal tapé ou une URL erronée produisaient
**exactement** le comportement d'une absence de modèle : Jarvis comprenait
moins bien, ne disait rien, et on en concluait que le modèle n'apportait rien —
alors qu'il n'avait jamais répondu.

Pour la même raison, `pnpm test:redteam` **refuse désormais de produire un
chiffre** quand un modèle est demandé sans répondre, et imprime toujours la
configuration avec laquelle il a mesuré. Un chiffre sans sa configuration est
un chiffre qui ment.

### Et si la machine ne suffit pas

Trois issues, dans l'ordre de préférence :

1. **Un modèle plus petit** — `qwen2.5:1.5b`. La tâche est étroite.
2. **Rester en `Tier 0`.** 43 % des tours d'une conversation réelle aboutissent
   sans aucun modèle (ADR-080), et les refus sont formulés, jamais des
   plantages. C'est un état de fonctionnement, pas une panne.
3. **Un fournisseur cloud** — possible, mais ce n'est pas une simple option de
   configuration : les énoncés quittent alors la machine, et rien ne les classe
   aujourd'hui (`docs/26 §4.14`). C'est une décision d'architecture, pas un
   réglage.

> Faire tourner le modèle sur une **autre machine du réseau local** est refusé
> par construction : `createOllama` n'accepte que la boucle locale. « Local »
> est une adresse, pas une intention (ADR-082). Lever ce refus serait une ADR à
> part entière.

---

## Ce que Jarvis sait faire aujourd'hui

**La liste qui fait foi est `/aide`**, et elle est *dérivée des règles du
moteur* (ADR-075) : une capacité ne peut pas exister sans être annoncée, ni être
annoncée sans exister. Celle-ci en est une copie — vérifiée par
`tests/architecture/quickstart-promesses.test.ts`, qui échoue si elle dérive.

```text
retiens que …                         mémoriser un fait
je préfère …                          retenir une préférence (Jarvis le dit)
que sais-tu sur …                     chercher en mémoire
enregistre <nom> comme personne       créer une entité
ajoute … à ma liste                   créer une tâche
rappelle-moi jeudi de …               créer un rappel DATÉ
mes tâches                            lister les tâches ouvertes
note …                                prendre une note
cherche sur le web …                  rechercher en ligne
cherche dans mes documents …          rechercher dans les fichiers
fais-moi un point                     briefing du jour
comment vas-tu                        état du système

marque la première comme faite        ⚠ une POSITION dans la dernière liste
supprime la deuxième                  ⚠ idem — pas un titre, un rang
termine la tâche …                    marquer une tâche terminée
annule la tâche …                     annuler une tâche
annule le rappel …                    annuler un rappel
supprime la note …                    ⚠ suppression définitive
oublie que …                          ⚠ suppression définitive
supprime la fiche de …                ⚠ suppression définitive
qu’as-tu fait …                       le journal d'exécution
qu’est-ce qui est sorti de la machine ce qui a quitté la machine

qu’ai-je de prévu demain              lire l'agenda        ⚠ compte Google requis
crée un rendez-vous jeudi à 14h …     créer un événement   ⚠ compte Google requis
```

> **Les deux dernières attendent un compte Google.** Sans lui, Jarvis répond
> « aucun agenda connecté » — pas une erreur, un prérequis que tu peux fournir.
> Les trois secrets vont dans `.env` : `GOOGLE_OAUTH_CLIENT_ID`,
> `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN`. L'agenda
> s'active tout seul au démarrage suivant.
>
> **Comment les obtenir** (ADR-108) — et jusqu'à cette décision, aucun fichier
> du dépôt ne le disait :
>
> 1. [console.cloud.google.com/apis/credentials](https://console.cloud.google.com/apis/credentials)
>    → « Créer des identifiants » → « ID client OAuth » → **Application de
>    bureau**. Cela donne les deux premières valeurs ; copie-les dans `.env`.
> 2. Active l'API Agenda pour ce projet :
>    [console.cloud.google.com/apis/library/calendar-json.googleapis.com](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com)
> 3. La troisième ne se tape pas — elle s'échange :
>
> ```bash
> pnpm google:connecter
> ```
>
> Il imprime un lien de consentement, écoute la boucle locale sur `127.0.0.1`,
> échange le code, et écrit le jeton dans `.env` (droits `600`).
> **Il ne l'affiche jamais** — un jeton dans l'historique du terminal est un
> jeton qui traîne. Portée demandée : `calendar` seulement. Pas Gmail, pas
> Drive, pas Contacts.
>
> ⚠ **Ce script n'a jamais tourné contre Google** : aucun compte n'était
> connecté là où il a été écrit. Sa boucle locale, ses quatre refus et sa
> réécriture de `.env` sont éprouvés en exécution réelle ; la réponse du
> serveur de jetons ne l'est pas. Si le premier lancement échoue, c'est cette
> réserve qui se paie — dis-le, elle se lève en une fois.
>
> ⚠ **Et ces trois valeurs ne sortent jamais de ta machine.** Ni dans un
> message, ni dans une conversation avec un modèle, ni dans une capture
> d'écran.
>
> **Les huit précédentes sont arrivées avec ADR-096.** Leurs outils existaient
> déjà — il leur manquait seulement de quoi désigner la cible. Les trois
> marquées ⚠ sont `L4` : Jarvis te montre **ce qu'il a trouvé** et attend ta
> confirmation avant d'effacer.
>
> **Un pronom ne suffit pas.** « efface ça » n'est pas une désignation : Jarvis
> demande laquelle. Et si ta phrase correspond à plusieurs lignes, il les
> énumère au lieu d'en choisir une.

Commandes : `/audit` · `/annule` · `/inbox` · `/diagnostic` · `/aide` · `/quitter`

> ⚠ **« cherche … » tout court n'est volontairement pas accepté.** Il y a trois
> portées — mémoire, web, documents — et deviner laquelle reviendrait à chercher
> ailleurs que là où vous croyiez, puis à annoncer un succès. Jarvis pose la
> question et propose les trois.

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
Demandez « Retrouve le devis du carreleur » : il **demande où chercher**, en
proposant les trois portées. Il ne fait pas une recherche dans votre mémoire
personnelle en répondant « c'est fait ».

Une recherche mémoire annonce toujours **où** elle a cherché — donc aussi ce
qu'elle n'a pas consulté.

**Il résout « ça », et il demande quand c'est ambigu.**
Enregistrez deux personnes nommées Jean, puis parlez de « Jean » : il demande
lequel plutôt que d'en choisir un. Dites « ajoute ça à ma liste » juste après
avoir parlé d'une chose : il résout le référent depuis le tour précédent, et
refuse s'il n'y a rien à quoi se rattacher.

> ⚠ **Cette page a affirmé le contraire pendant trois ADR.** Elle disait que la
> désambiguïsation « n'existe pas encore » et qu'un rappel daté « est refusé ».
> Les deux étaient vrais à la date d'écriture, et faux depuis ADR-073 et
> ADR-077 — une documentation qui décourage d'essayer ce qui marche coûte
> exactement autant qu'une qui promet ce qui ne marche pas.
>
> C'est pour ça que `tests/architecture/quickstart-promesses.test.ts` existe
> désormais : chaque promesse de cette page est rejouée sur le moteur réel.

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
pnpm test            # la suite entière
pnpm gate:phase0     # journal inaltérable, isolation fournisseurs, secrets
pnpm gate:phase1     # mémoire, contexte, ambiguïté, hors ligne
pnpm gate:phase2     # outils, idempotence, vérification, injection
pnpm gate:phase3     # enchaîne 0-1-2 et clôt la Phase 3 (ADR-087)
pnpm gate:phase7     # Update Engine : imprime aussi ce qui MANQUE
pnpm secrets:scan    # arbre de travail ET historique git
```

> `gate:phase7` est le seul qui imprime une liste d'**absences** à chaque
> passage — vérificateur de signature, exécutant, canary, sauvegardes. Une
> limite qu'il faut aller chercher dans un ADR n'est pas une limite déclarée
> (ADR-087).

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
