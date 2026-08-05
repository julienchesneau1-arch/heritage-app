#!/bin/sh
# À LANCER AVANT LE PREMIER DÉMARRAGE, sur un VPS qui héberge déjà autre chose.
#
#   cd /opt/heritage && ./preflight.sh
#
# Ce script ne modifie RIEN. Il lit l'état de la machine et répond à une
# seule question : est-ce que démarrer Héritage ici peut mettre hors ligne
# l'application déjà en production ?
#
# Il refuse de donner son feu vert plutôt que de laisser passer un doute.
# Un déploiement qui casse un site existant coûte infiniment plus cher que
# dix minutes de vérification.
set -eu

PORT_LOCAL="${PORT_LOCAL:-8081}"
rouge=''
avertissements=0

dire() { printf '%s\n' "$1"; }
titre() { printf '\n── %s ──\n' "$1"; }
faute() { printf '  ✗ %s\n' "$1"; rouge='oui'; }
alerte() { printf '  ! %s\n' "$1"; avertissements=$((avertissements + 1)); }
bien() { printf '  ✓ %s\n' "$1"; }

dire 'Héritage — vérification avant déploiement.'
dire 'Aucune modification ne sera faite par ce script.'

# ── 1. Ce qui tourne déjà, et qu'il ne faut pas déranger ──
titre 'Ce qui tourne déjà sur cette machine'
if command -v docker >/dev/null 2>&1; then
  autres=$(docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}' 2>/dev/null | grep -v '^heritage[-_]' || true)
  if [ -n "$autres" ]; then
    printf '%s\n' "$autres" | sed 's/^/  · /'
    dire ''
    dire '  Ces conteneurs ne sont pas à moi. Aucune commande de ce dépôt ne'
    dire '  les vise : `docker compose` filtré par `name: heritage` ne touche'
    dire '  que les miens. Ne JAMAIS lancer ici `docker system prune -a`,'
    dire '  `docker volume prune` ni `docker compose down` hors de ce dossier.'
  else
    bien 'aucun autre conteneur en cours.'
  fi
else
  faute 'docker introuvable — installez-le avant de continuer.'
fi

# ── 2. Les ports : la seule vraie collision possible ──
#
# La première version de cette fonction essayait `ss`, sinon `netstat`, et
# renvoyait « libre » quand aucun des deux n'existait — l'échec de la
# commande se lisait exactement comme un port disponible. Un garde-fou qui
# donne son feu vert sans avoir rien regardé est pire que pas de garde-fou :
# il autorise au nom d'une vérification qui n'a pas eu lieu.
#
# Trois états, jamais deux : 0 occupé, 1 libre, 2 INCONNU. Et « inconnu »
# arrête le déploiement.
titre 'Ports'

# L'ORDRE compte, et il a été établi en le testant, pas en le supposant :
# `lsof` était consulté en premier et rendait « rien en écoute » sur un port
# où un serveur répondait — il ne voit pas toujours les sockets d'autres
# utilisateurs ou d'autres espaces de noms. Un faux négatif ici autorise le
# déploiement qui écrase le site existant : c'est la seule erreur que ce
# script n'a pas le droit de commettre.
#
# La table du noyau (`/proc/net/tcp`) passe donc devant : elle ne dépend
# d'aucun paquet installé et ne ment pas sur ce qui écoute.
outil=''
if [ -r /proc/net/tcp ]; then
  outil='proc'
else
  for candidat in ss netstat lsof fuser; do
    command -v "$candidat" >/dev/null 2>&1 && { outil="$candidat"; break; }
  done
fi

occupe() {
  port="$1"
  case "$outil" in
    ss)      ss -ltnH 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$port\$" ;;
    netstat) netstat -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$port\$" ;;
    lsof)    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 ;;
    fuser)   fuser "$port"/tcp >/dev/null 2>&1 ;;
    # La table du noyau. Le port y est en hexadécimal, et 0A est LISTEN.
    # `tcp6` n'existe pas sur une machine sans IPv6 : awk sortirait alors en
    # code 2 sur un fichier introuvable, et « indéterminable » remplacerait
    # une réponse que `tcp` seul suffisait à donner.
    proc)    tables='/proc/net/tcp'
             [ -r /proc/net/tcp6 ] && tables="$tables /proc/net/tcp6"
             # shellcheck disable=SC2086
             awk -v p="$(printf '%04X' "$port")" \
               '$4 == "0A" { split($2, a, ":"); if (a[2] == p) trouve = 1 } END { exit !trouve }' \
               $tables 2>/dev/null ;;
    *)       return 2 ;;
  esac
}

if [ -z "$outil" ]; then
  faute 'impossible de lire les ports ouverts : ni ss, ni netstat, ni lsof,'
  dire  '     ni fuser, ni /proc/net/tcp. Je ne peux donc PAS garantir que'
  dire  '     démarrer ici ne prendra pas la place du site existant.'
  dire  '     Installez de quoi vérifier :  apt install iproute2'
else
  # `set -e` tuerait le script au premier port libre, puisque « libre » est
  # un code de retour non nul. Le `|| etat=$?` en fait une condition.
  etat_de() { etat=0; occupe "$1" || etat=$?; }

  dire "  (lu avec : $outil)"
  for port in 80 443; do
    etat_de "$port"
    case "$etat" in
      0) alerte "le port $port est déjà pris — c'est normal, c'est votre site actuel." ;;
      1) bien "port $port libre." ;;
      *) faute "état du port $port indéterminable." ;;
    esac
  done

  etat_de "$PORT_LOCAL"
  case "$etat" in
    0) faute "le port $PORT_LOCAL est déjà pris. Choisissez-en un autre :"
       dire  "     echo 'PORT_LOCAL=8082' >> .env" ;;
    1) bien "port $PORT_LOCAL libre pour Héritage (boucle locale seulement)." ;;
    *) faute "état du port $PORT_LOCAL indéterminable." ;;
  esac
fi

# ── 3. Le profil autonome ne doit pas être demandé par mégarde ──
titre 'Reverse-proxy'
if [ -z "$outil" ]; then
  dire '  Indéterminable sans outil de lecture des ports. Par prudence,'
  dire '  considérez que la machine est occupée et NE lancez PAS le profil'
  dire '  `autonome` : il réclamerait 80 et 443.'
elif { occupe 80 || occupe 443; }; then
  dire '  Un proxy sert déjà cette machine. Héritage NE DOIT PAS démarrer'
  dire '  son propre Caddy : il réclamerait 80 et 443, et votre site tomberait.'
  dire ''
  dire "  Commande à utiliser :  docker compose up -d --build"
  dire "  Commande à ÉVITER   :  docker compose --profile autonome up -d"
  dire ''
  dire "  Puis ajoutez un vhost au proxy en place, vers 127.0.0.1:$PORT_LOCAL."
  dire '  Voir DEPLOIEMENT.md, section « Cohabiter ».'
else
  bien 'rien ne sert encore cette machine — le profil `autonome` est utilisable.'
fi

# ── 4. Les secrets, sans lesquels l'application sert des 500 ──
titre 'Secrets'
if [ ! -f .env ]; then
  faute '.env absent. Voir DEPLOIEMENT.md, étape 3.'
else
  for cle in POSTGRES_PASSWORD FAMILY_TOKEN_SECRET; do
    valeur=$(grep -E "^$cle=" .env 2>/dev/null | head -n1 | cut -d= -f2- || true)
    if [ -z "$valeur" ]; then
      faute "$cle manquant ou vide dans .env."
    elif [ "${#valeur}" -lt 32 ] && [ "$cle" = 'FAMILY_TOKEN_SECRET' ]; then
      faute "FAMILY_TOKEN_SECRET fait moins de 32 caractères — openssl rand -hex 32."
    else
      bien "$cle renseigné."
    fi
  done
  droits=$(stat -c '%a' .env 2>/dev/null || echo '?')
  [ "$droits" = '600' ] || alerte ".env est en $droits — préférez chmod 600 .env"
fi

# ── 5. Le dossier : deux applications ne partagent pas un répertoire ──
titre 'Dossier'
dire "  $(pwd)"
if [ -f ../docker-compose.yml ] || [ -f ../package.json ]; then
  alerte 'le dossier parent ressemble à un projet — vérifiez que vous avez'
  dire '     cloné Héritage dans SON PROPRE répertoire, et non dans celui'
  dire '     de l’application existante.'
else
  bien 'répertoire dédié.'
fi

# ── Verdict ──
printf '\n───────────────────────────────────────────────\n'
if [ -n "$rouge" ]; then
  dire 'STOP. Corrigez les points marqués ✗ avant de démarrer.'
  exit 1
fi
if [ "$avertissements" -gt 0 ]; then
  dire 'PRÊT — avec cohabitation.'
  dire 'Démarrer :  docker compose up -d --build'
  dire 'Puis brancher le proxy existant. Sans profil `autonome`.'
else
  dire 'PRÊT — machine vierge.'
  dire 'Démarrer :  docker compose --profile autonome up -d --build'
fi
exit 0
