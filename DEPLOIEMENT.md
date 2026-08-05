# Mettre Héritage en ligne

Pile complète sur **un seul VPS** : l'application, sa base, son proxy TLS.
Aucun service managé facturé au mois. À l'échelle d'une famille — quelques
milliers de récits, une poignée de lecteurs — c'est à la fois le moins cher
et le plus simple à tenir.

---

## ⚠ Cohabiter avec une application déjà en ligne

**Le VPS visé héberge déjà ASSEMBLAGES / savore. Il doit rester en ligne.**
C'est la contrainte qui gouverne tout ce document, et elle a demandé de
changer le kit de déploiement, pas seulement d'écrire une consigne.

### Où était le danger

Pas dans une commande de suppression : dans le `docker-compose.yml`. Il
réclamait les ports **80 et 443** en dur. Sur une machine où un proxy les
occupe déjà, deux issues, toutes deux mauvaises : le démarrage échoue, ou —
au redémarrage suivant de l'autre proxy — Héritage prend sa place et le site
existant tombe. C'est le mode de panne normal de deux piles qui s'ignorent.

### Ce qui rend la collision impossible

| Garde-fou | Ce qu'il empêche |
|---|---|
| `name: heritage` dans le compose | Le nom du projet ne dépend plus du dossier. Conteneurs, volumes et réseau portent tous le préfixe `heritage_`. `docker compose` ne voit **que** les siens. |
| `ports: 127.0.0.1:8081:3000` | L'application n'écoute que sur la boucle locale. Aucun port public réclamé, aucune règle de pare-feu à changer. Sans le préfixe `127.0.0.1:`, Docker ouvrirait le port sur toutes les interfaces **et percerait UFW au passage**. |
| Le proxy Caddy est sous `profiles: ['autonome']` | `docker compose up -d` ne le démarre **jamais**. Il faut l'écrire en toutes lettres, et cette commande ne vaut que pour une machine vierge. |
| `./preflight.sh` | Lit l'état de la machine sans rien modifier, et refuse de donner son feu vert si un port est pris — ou s'il n'a pas pu vérifier. |

### La marche à suivre sur ce VPS

```bash
# 1. Un dossier À PART. Jamais dans celui d'ASSEMBLAGES.
sudo mkdir -p /opt/heritage && sudo chown "$USER" /opt/heritage
git clone <url-du-dépôt> /opt/heritage && cd /opt/heritage

# 2. Les secrets (voir l'étape 3 plus bas), puis la vérification.
./preflight.sh          # doit finir par « PRÊT — avec cohabitation »

# 3. Démarrer — SANS le profil autonome.
docker compose up -d --build
curl http://127.0.0.1:8081/api/sante        # {"statut":"ok"}
```

À ce stade Héritage tourne et **n'est joignable que depuis la machine**.
ASSEMBLAGES n'a rien vu passer. Reste à lui ajouter une porte d'entrée.

### Brancher le proxy déjà en place

**Si c'est nginx sur l'hôte** — un fichier neuf, on ne touche à aucun autre :

```bash
sudo tee /etc/nginx/sites-available/heritage >/dev/null <<'EOF'
server {
    server_name memoire.example.fr;
    client_max_body_size 100M;          # les photos et les enregistrements
    location / {
        proxy_pass http://127.0.0.1:8081;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF
sudo ln -s /etc/nginx/sites-available/heritage /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx   # reload, pas restart
sudo certbot --nginx -d memoire.example.fr     # n'affecte que ce vhost
```

`nginx -t` avant le rechargement : une erreur de syntaxe dans un fichier
neuf ferait échouer le rechargement **de toute la configuration**, donc
d'ASSEMBLAGES aussi. `reload` et non `restart` : les connexions en cours ne
sont pas coupées.

**Si c'est Caddy sur l'hôte** — une entrée ajoutée au `/etc/caddy/Caddyfile`
existant, sans toucher aux blocs déjà présents :

```caddyfile
memoire.example.fr {
	encode gzip
	reverse_proxy 127.0.0.1:8081
}
```

```bash
sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

**Si le proxy d'ASSEMBLAGES tourne dans Docker**, il ne joindra pas
`127.0.0.1` de l'hôte. Rattacher Héritage à son réseau, sans le modifier —
un fichier d'appoint, que Compose lit en plus du principal :

```yaml
# docker-compose.override.yml — non versionné, propre à ce serveur
services:
  app:
    networks: [default, partage]
networks:
  partage:
    external: true
    name: <nom-du-réseau-d-assemblages>    # docker network ls
```

Le proxy vise alors `http://heritage-app-1:3000`. `external: true` est
essentiel : il dit à Compose d'**utiliser** ce réseau, jamais de le créer ni
de le supprimer.

### Les commandes à ne jamais lancer sur ce serveur

```bash
docker system prune -a        # détruit les images d'ASSEMBLAGES aussi
docker volume prune           # DÉTRUIT DES DONNÉES, toutes applications confondues
docker compose down -v        # -v supprime les volumes du projet courant
docker compose down           # depuis le mauvais dossier : arrête l'autre app
```

Pour arrêter Héritage et lui seul, depuis `/opt/heritage` :
`docker compose stop`. Le `name: heritage` garantit la portée, mais la
règle la plus sûre reste de vérifier `pwd` avant toute commande Docker.

---

## Quel hébergement Hostinger

> **L'hébergement mutualisé ne convient pas.** Il exécute PHP derrière Apache
> et ne fait pas tourner un processus Node en continu. Héritage est une
> application Next.js avec composants serveur, actions serveur et une base
> PostgreSQL : il lui faut une machine.

**Hostinger VPS, offre KVM 1** (2 vCPU, 8 Go RAM, 100 Go NVMe). C'est
large : l'application consomme quelques centaines de mégaoctets.

Au moment de la commande, choisir **Ubuntu 24.04 avec Docker** dans les
modèles proposés : Docker et Docker Compose sont alors déjà installés.

---

## Coût réel, tout compris

| Poste | Choix | Coût mensuel |
|---|---|---|
| Serveur | Hostinger VPS KVM 1 | ~5 € (promo) / ~9 € (renouvellement) |
| Base de données | PostgreSQL sur le même VPS | 0 € |
| Redis | **aucun** — inutile à une seule instance | 0 € |
| Stockage des archives | volume Docker sur le VPS | 0 € |
| Sauvegarde hors-site | Cloudflare R2, 10 Go gratuits | 0 € |
| Transcription | locale, dans le navigateur (WebGPU/WASM) | 0 € |
| Modèle de langue | facultatif — l'app fonctionne sans | 0 € |
| Domaine | `.fr` ou `.com` | ~1 €/mois |
| **Total** | | **~6 à 10 €/mois** |

Deux postes méritent une explication.

**Redis est absent volontairement.** Il ne sert qu'à partager les compteurs
(parcimonie du Passeur, quarantaine, limitation de débit) entre plusieurs
instances. Avec une seule, le store mémoire suffit et l'application le
signale au démarrage. Le jour où il faudra deux instances, `REDIS_URL`
suffira — le code est déjà écrit pour.

**Le modèle de langue est facultatif.** Sans `OPENAI_API_KEY`, le
`LLMOperatorService` rend ses replis déterministes : le Passeur pose ses
questions, la cristallisation d'un fil rend le fil lui-même ligne à ligne,
la classification retombe sur un type par défaut. Aucune fonctionnalité ne
casse. C'est délibéré, et c'est ce qui permet de tenir le coût près de zéro.

---

## Installation

> Cette section décrit un **serveur neuf**. Sur le VPS qui héberge déjà
> ASSEMBLAGES, sauter l'étape 1 en entier — le serveur est préparé, SSH est
> configuré, le pare-feu est en place — et suivre « Cohabiter » ci-dessus
> pour les étapes 4 et suivantes.

### 1. Préparer le serveur — machine neuve uniquement

```bash
ssh root@<ip-du-vps>
adduser heritage && usermod -aG docker,sudo heritage
# Une application accessible en SSH par mot de passe finit par être visitée.
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/;s/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
```

> **Ne pas rejouer ces lignes sur le VPS d'ASSEMBLAGES.** `sed` sur
> `sshd_config` et `ufw --force enable` réécrivent une configuration qui
> fonctionne déjà ; au mieux c'est redondant, au pire une session SSH se
> ferme derrière vous.

### 2. Pointer le domaine

Dans le DNS Hostinger, deux enregistrements **A** vers l'IP du VPS :
`@` et `www`. Attendre la propagation avant l'étape 4, sinon Let's Encrypt
échoue à délivrer le certificat.

### 3. Déposer le code et les secrets

```bash
su - heritage
git clone <url-du-dépôt> /opt/heritage && cd /opt/heritage

cat > .env <<'EOF'
DOMAINE=memoire.example.fr
POSTGRES_PASSWORD=<openssl rand -hex 24>
FAMILY_TOKEN_SECRET=<openssl rand -hex 32>
TRANSCRIPTION_WORKER_SECRET=<openssl rand -hex 24>
OPENAI_API_KEY=
EOF
chmod 600 .env
```

> **`FAMILY_TOKEN_SECRET` n'est pas optionnel.** Cette clé signe tous les
> accès : cookie familial, lien personnel, flux du calendrier. Sa valeur de
> développement est une constante publiée dans un dépôt public — laissée en
> place, n'importe qui pourrait forger le cookie de n'importe quelle famille
> et lire sa mémoire. L'application le vérifie : sans clé valide, elle
> journalise la cause exacte et **rend 500 sur toutes les requêtes**. Le
> serveur démarre, mais il ne sert rien.

Ajouter `PORT_LOCAL=8081` à ce `.env` si le port par défaut est déjà pris —
`./preflight.sh` le dit.

### 4. Démarrer

```bash
./preflight.sh                 # d'abord : il ne modifie rien, et il peut dire STOP
```

**Sur un serveur qui héberge déjà autre chose** — le cas de ce VPS :

```bash
docker compose up -d --build
docker compose logs -f app     # les migrations s'appliquent au démarrage
curl http://127.0.0.1:8081/api/sante        # {"statut":"ok"}
```

Puis brancher le proxy en place (section « Cohabiter »). L'application
n'est pas encore joignable de l'extérieur, et c'est normal.

**Sur une machine vierge**, et seulement là, Héritage peut porter son propre
proxy TLS :

```bash
docker compose --profile autonome up -d --build
curl https://<votre-domaine>/api/sante
```

Tout autre résultat que `{"statut":"ok"}` est décrit dans la réponse.

### 5. Fonder la première famille

Ouvrir `https://<votre-domaine>/commencer`. La page crée la famille et son
premier membre, et rend un lien personnel — c'est celui-là qu'il faut garder.
`/famille` permet ensuite d'ajouter les autres et de distribuer leurs liens.

**Ne pas lancer le seed en production** : il charge la famille Martin, qui
est un jeu de démonstration.

### 6. Les deux tâches planifiées

```bash
crontab -e
```

```cron
# Sauvegarde quotidienne, 3 h du matin.
0 3 * * * cd /opt/heritage && ./sauvegarde.sh >> /var/log/heritage-backup.log 2>&1

# File de transcription, toutes les dix minutes. Inutile si personne
# n'enregistre de voix — la transcription locale n'en dépend pas.
*/10 * * * * curl -fsS -X POST https://<domaine>/api/transcriptions/process \
  -H "x-worker-secret: <TRANSCRIPTION_WORKER_SECRET>" > /dev/null
```

---

## Sauvegardes

`sauvegarde.sh` produit chaque nuit un `pg_dump` compressé et une archive
des fichiers binaires, et garde trente jours sur place.

**Le hors-site n'est pas un luxe ici.** Un VPS est une seule machine, et la
promesse du produit est de garder cinquante ans de récits. Configurer
`rclone` vers Cloudflare R2 (10 Go gratuits, très au-delà de ce qu'une
famille produira) puis décommenter la dernière ligne du script.

Restaurer :

```bash
gunzip -c sauvegardes/heritage-2026-08-04.sql.gz \
  | docker compose exec -T db psql -U heritage -d heritage
```

L'export JSON de l'application (`/api/family/:id/export`) est une seconde
voie, indépendante : il se restaure depuis `/restaurer`, sur n'importe
quelle instance. C'est l'amendement 3 — la famille possède ses données, et
peut partir avec.

---

## Mettre à jour

```bash
cd /opt/heritage && git pull && docker compose up -d --build
```

`cd /opt/heritage` d'abord, toujours : `docker compose` agit sur le projet
du répertoire courant. Le `name: heritage` du compose limite la portée aux
conteneurs d'Héritage, mais la vérification du `pwd` reste la garantie qui
ne dépend de rien.

Les migrations Prisma s'appliquent au démarrage du conteneur, avant que le
serveur n'accepte une requête.

---

## Ce qui n'a pas été vérifié

Honnêteté sur l'état de ce document : l'image Docker **n'a pas pu être
construite** depuis l'environnement de développement, le registre Docker Hub
y étant inaccessible. Ont été vérifiés en conditions réelles : la sortie
autonome de Next (`output: 'standalone'`, 43 Mo), le démarrage en
`NODE_ENV=production`, le refus documenté sans clé de signature, la sonde
`/api/sante` dans ses trois états. Le `Dockerfile` et le `docker-compose.yml`
sont écrits mais **restent à éprouver au premier déploiement** — prévoir une
première mise en ligne accompagnée, pas un `up -d` lancé et oublié.
