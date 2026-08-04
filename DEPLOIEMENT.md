# Mettre Héritage en ligne

Pile complète sur **un seul VPS** : l'application, sa base, son proxy TLS.
Aucun service managé facturé au mois. À l'échelle d'une famille — quelques
milliers de récits, une poignée de lecteurs — c'est à la fois le moins cher
et le plus simple à tenir.

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

### 1. Préparer le serveur

```bash
ssh root@<ip-du-vps>
adduser heritage && usermod -aG docker,sudo heritage
# Une application accessible en SSH par mot de passe finit par être visitée.
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/;s/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
```

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

### 4. Démarrer

```bash
docker compose up -d --build
docker compose logs -f app     # les migrations s'appliquent au démarrage
```

Vérifier : `curl https://<votre-domaine>/api/sante` doit rendre
`{"statut":"ok"}`. Tout autre résultat est décrit dans la réponse.

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
