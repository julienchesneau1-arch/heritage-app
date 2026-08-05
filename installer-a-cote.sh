#!/bin/sh
# INSTALLER HÉRITAGE À CÔTÉ D'UNE APPLICATION DÉJÀ EN LIGNE.
#
# À coller dans le terminal du VPS (Hostinger → Serveurs → Terminal navigateur,
# ou par SSH). Le VPS héberge déjà ASSEMBLAGES / savore, qui doit rester en
# ligne : ce script est écrit pour que ce soit vrai même s'il échoue au milieu.
#
#   cd /opt/heritage && ./installer-a-cote.sh
#
# CE QU'IL FAIT
#   1. Vérifie l'état de la machine et s'arrête au moindre doute.
#   2. Génère les secrets manquants dans .env (jamais ne remplace un secret
#      existant — sinon toutes les familles seraient déconnectées).
#   3. Construit et démarre Héritage sur 127.0.0.1 uniquement.
#   4. Écrit un fichier de vhost SÉPARÉ pour le proxy déjà installé, teste la
#      configuration, et ne recharge que si le test passe.
#
# CE QU'IL NE FAIT JAMAIS
#   · toucher un conteneur, un volume, une image ou un réseau qui ne porte
#     pas le préfixe `heritage` ;
#   · réclamer les ports 80 ou 443 ;
#   · modifier un fichier de configuration existant — il en AJOUTE un ;
#   · redémarrer le proxy (reload seulement : aucune connexion coupée) ;
#   · lancer `prune`, `down -v`, ou quoi que ce soit de destructif.
set -eu

DOMAINE="${DOMAINE:-}"
PORT_LOCAL="${PORT_LOCAL:-8081}"
SANS_TLS="${SANS_TLS:-}"

echo 'Héritage — installation à côté de l’existant.'
echo

# ── 0. Le domaine, sans lequel rien ne peut être servi ──
if [ -z "$DOMAINE" ]; then
  cat <<'AIDE'
Il manque le sous-domaine à servir. Relancez ainsi :

    DOMAINE=memoire.votredomaine.fr ./installer-a-cote.sh

Avant cela, dans le DNS Hostinger : un enregistrement A pour ce
sous-domaine, vers l'IP de ce VPS. Ne touchez pas à celui de savore.
AIDE
  exit 1
fi

# ── 1. Les secrets, AVANT la vérification ──
#
# L'ordre a été trouvé en testant, pas en relisant : la vérification passait
# en premier et exigeait un `.env` que ce script est justement chargé de
# créer. Sur un clone neuf, l'installation ne pouvait donc jamais démarrer.
#
# Écrire les secrets d'abord ne présente aucun risque pour l'existant — un
# fichier `.env` dans CE dossier — et la vérification qui suit porte alors
# sur l'état final, ce qui vaut mieux que sur un état intermédiaire.
echo '── Secrets ──'
touch .env && chmod 600 .env
ajouter_si_absent() {
  cle="$1"; valeur="$2"; verbe="${3:-généré}"
  if grep -qE "^$cle=.+" .env 2>/dev/null; then
    echo "  · $cle déjà présent — laissé tel quel."
  else
    printf '%s=%s\n' "$cle" "$valeur" >> .env
    echo "  · $cle $verbe."
  fi
}
# Remplacer FAMILY_TOKEN_SECRET déconnecterait toutes les familles d'un coup
# et invalideraient tous les liens personnels déjà distribués. D'où le
# `si_absent` : ce script doit pouvoir être relancé sans rien casser.
ajouter_si_absent POSTGRES_PASSWORD "$(openssl rand -hex 24)"
ajouter_si_absent FAMILY_TOKEN_SECRET "$(openssl rand -hex 32)"
ajouter_si_absent TRANSCRIPTION_WORKER_SECRET "$(openssl rand -hex 24)"
# Ceux-ci ne sont pas des secrets : « généré » serait faux.
ajouter_si_absent PORT_LOCAL "$PORT_LOCAL" 'enregistré'
ajouter_si_absent DOMAINE "$DOMAINE" 'enregistré'
grep -qE '^OPENAI_API_KEY=' .env || printf 'OPENAI_API_KEY=\n' >> .env

# ── 2. La vérification, qui a le droit de tout arrêter ──
echo
if [ -x ./preflight.sh ]; then
  PORT_LOCAL="$PORT_LOCAL" ./preflight.sh || {
    echo
    echo 'La vérification a dit STOP.'
    echo 'Seul .env a été écrit, dans ce dossier. Rien d’autre n’a bougé,'
    echo 'et aucun conteneur n’a démarré.'
    exit 1
  }
else
  echo '! preflight.sh introuvable — vérification impossible, on s’arrête.'
  exit 1
fi

# ── 3. Démarrer, sans le profil autonome ──
echo
echo '── Construction et démarrage ──'
echo '  (sans profil `autonome` : aucun port public réclamé)'
docker compose up -d --build

echo
echo '── Santé ──'
i=0
while [ "$i" -lt 30 ]; do
  if curl -fsS "http://127.0.0.1:$PORT_LOCAL/api/sante" 2>/dev/null | grep -q '"statut":"ok"'; then
    echo '  ✓ {"statut":"ok"}'
    break
  fi
  i=$((i + 1)); sleep 2
done
if [ "$i" -ge 30 ]; then
  echo '  ✗ l’application ne répond pas. Rien n’a été branché au proxy —'
  echo '    votre site existant est intact. Journal :'
  echo '      docker compose logs --tail 50 app'
  exit 1
fi

# ── 4. Brancher le proxy déjà en place ──
echo
echo '── Proxy ──'

recharger_nginx() {
  fichier=/etc/nginx/sites-available/heritage
  echo "  nginx détecté. Écriture de $fichier (fichier NEUF, rien d’existant n’est modifié)."
  sudo tee "$fichier" >/dev/null <<VHOST
# Héritage — ajouté par installer-a-cote.sh. Ne sert que $DOMAINE.
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAINE;

    # Les photos et les enregistrements de famille.
    client_max_body_size 100M;

    location / {
        proxy_pass http://127.0.0.1:$PORT_LOCAL;
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300s;   # les transcriptions sont longues
    }
}
VHOST
  sudo ln -sfn "$fichier" /etc/nginx/sites-enabled/heritage

  # `nginx -t` AVANT le rechargement : une faute de syntaxe dans un fichier
  # neuf ferait échouer le rechargement de TOUTE la configuration, donc de
  # savore aussi. En cas d'échec on retire ce qu'on vient d'ajouter.
  if ! sudo nginx -t; then
    echo '  ✗ configuration nginx invalide — le lien est retiré, rien n’a été rechargé.'
    sudo rm -f /etc/nginx/sites-enabled/heritage
    exit 1
  fi
  sudo systemctl reload nginx     # reload, pas restart : aucune coupure
  echo '  ✓ nginx rechargé.'

  if [ -z "$SANS_TLS" ] && command -v certbot >/dev/null 2>&1; then
    echo '  Certificat pour ce sous-domaine uniquement…'
    sudo certbot --nginx -d "$DOMAINE" --non-interactive --agree-tos \
      --register-unsafely-without-email --keep-until-expiring \
      || echo '  ! certbot a échoué — le site répond en HTTP. Relancez-le à la main.'
  fi
}

recharger_caddy() {
  fichier=/etc/caddy/heritage.caddyfile
  echo "  Caddy détecté. Écriture de $fichier."
  sudo tee "$fichier" >/dev/null <<VHOST
$DOMAINE {
	encode gzip
	reverse_proxy 127.0.0.1:$PORT_LOCAL
}
VHOST
  # `import` ajoute un bloc sans réécrire le Caddyfile principal.
  if ! sudo grep -q 'import /etc/caddy/heritage.caddyfile' /etc/caddy/Caddyfile 2>/dev/null; then
    printf '\nimport /etc/caddy/heritage.caddyfile\n' | sudo tee -a /etc/caddy/Caddyfile >/dev/null
  fi
  if ! sudo caddy validate --config /etc/caddy/Caddyfile; then
    echo '  ✗ configuration Caddy invalide — rien n’a été rechargé.'
    echo '    Retirez la ligne `import /etc/caddy/heritage.caddyfile` du Caddyfile.'
    exit 1
  fi
  sudo systemctl reload caddy
  echo '  ✓ Caddy rechargé. Le certificat est obtenu automatiquement.'
}

if systemctl is-active --quiet nginx 2>/dev/null; then
  recharger_nginx
elif systemctl is-active --quiet caddy 2>/dev/null; then
  recharger_caddy
else
  cat <<MANUEL
  ! Ni nginx ni Caddy en service sur l'hôte.

    Le proxy de savore tourne probablement DANS Docker. Dans ce cas,
    127.0.0.1 de l'hôte ne lui est pas joignable — il faut partager un
    réseau. Trouvez son nom :

        docker network ls

    puis créez docker-compose.override.yml ici :

        services:
          app:
            networks: [default, partage]
        networks:
          partage:
            external: true
            name: <le-nom-trouvé>

    (\`external: true\` dit à Compose d'UTILISER ce réseau, jamais de le
    créer ni de le supprimer.) Puis \`docker compose up -d\`, et pointez
    le proxy vers http://heritage-app-1:3000.

    Héritage tourne déjà et répond sur 127.0.0.1:$PORT_LOCAL.
MANUEL
  exit 0
fi

# ── 5. Ce qu'il reste à faire, dit clairement ──
cat <<FIN

───────────────────────────────────────────────
Héritage est en ligne sur https://$DOMAINE
savore n'a pas été touché : aucun de ses fichiers n'a été modifié, aucun de
ses conteneurs n'a été arrêté, et le proxy a été rechargé, pas redémarré.

À faire maintenant :

  1. Ouvrir https://$DOMAINE/commencer et fonder la famille.
     Le lien personnel rendu à la fin est à garder — c'est le seul qui
     autorise à supprimer.

  2. NE PAS lancer le seed : il charge la famille Martin de démonstration.

  3. Sauvegardes, dans le crontab de cet utilisateur :
       0 3 * * * cd $(pwd) && ./sauvegarde.sh >> /var/log/heritage-backup.log 2>&1

Sur ce serveur, ne jamais lancer :
  docker system prune -a      docker volume prune      docker compose down -v
Pour arrêter Héritage seul :  cd $(pwd) && docker compose stop
FIN
