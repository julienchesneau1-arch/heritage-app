#!/bin/sh
# Sauvegarde de la mémoire familiale.
#
# À lancer par cron sur le VPS. Une application dont la promesse est de
# garder cinquante ans de récits ne peut pas dépendre d'un seul disque.
#
#   0 3 * * * cd /opt/heritage && ./sauvegarde.sh >> /var/log/heritage-backup.log 2>&1
#
# ─────────────────────────────────────────────────────────────────────
# CE SCRIPT DISAIT « SAUVEGARDE FAITE » SANS RIEN SAVOIR.
#
# Il écrivait `pg_dump ... | gzip > fichier`. Dans un tube, c'est le
# DERNIER maillon qui donne le code de retour : si `pg_dump` échouait —
# base arrêtée, mot de passe changé, conteneur absent — `gzip` compressait
# consciencieusement zéro octet, sortait en 0, et `set -e` ne voyait rien.
# Le script écrivait un fichier de vingt octets et annonçait le succès.
#
# Pire : la purge des trente jours s'exécutait quand même. Trente nuits
# d'échec silencieux, et la dernière sauvegarde valide était effacée par
# le script censé la protéger.
#
# `set -o pipefail` réglerait le premier point, mais `/bin/sh` est `dash`
# sur Debian et ne le garantit pas. On écrit donc dans un fichier
# temporaire, on vérifie le code de retour ET le contenu, et on ne
# promeut le fichier définitif qu'après. La purge ne tourne qu'une fois
# les deux sauvegardes du jour établies.
#
# Un mensonge dans une sauvegarde ne se découvre que le jour où l'on
# restaure, c'est-à-dire le seul jour où il coûte tout.
# ─────────────────────────────────────────────────────────────────────
set -eu

HORODATAGE=$(date +%Y-%m-%d)
DOSSIER=${DOSSIER_SAUVEGARDES:-./sauvegardes}
JOURS=${JOURS_CONSERVES:-30}
mkdir -p "$DOSSIER"

echoerr() { echo "$@" >&2; }

# Le plancher porte sur la sortie BRUTE, avant compression. Mesuré après
# `gzip`, il ne veut rien dire : deux cents lignes identiques se réduisent
# à cent vingt octets, et un vrai `pg_dump` de famille modeste passerait
# sous n'importe quel seuil qu'on jugerait « raisonnable ». Ce contrôle ne
# prétend pas juger la taille d'une sauvegarde — seulement distinguer une
# réponse d'une absence de réponse.
TAILLE_MINIMALE=${TAILLE_MINIMALE:-100}

# capturer <destination> <description> <commande...>
#
# Exécute la commande, compresse sa sortie, et ne garde le résultat que si
# la commande a réussi, que l'archive est lisible et qu'elle n'est pas
# vide. En cas d'échec, rien n'est écrit et le script s'arrête : une
# sauvegarde partielle qui remplace la précédente est pire que pas de
# sauvegarde du tout.
capturer() {
  destination=$1
  description=$2
  shift 2

  temporaire="$destination.en-cours"
  code=0
  "$@" > "$temporaire.brut" 2>"$temporaire.erreur" || code=$?

  if [ "$code" -ne 0 ]; then
    echoerr "$(date -Iseconds) — ÉCHEC : $description (code $code)"
    echoerr "$(sed -n '1,10p' "$temporaire.erreur")"
    rm -f "$temporaire.brut" "$temporaire.erreur"
    exit 1
  fi

  brute=$(wc -c < "$temporaire.brut")
  if [ "$brute" -lt "$TAILLE_MINIMALE" ]; then
    echoerr "$(date -Iseconds) — ÉCHEC : $description, sortie vide ($brute octets)"
    echoerr "$(sed -n '1,10p' "$temporaire.erreur")"
    rm -f "$temporaire.brut" "$temporaire.erreur"
    exit 1
  fi

  gzip -c "$temporaire.brut" > "$temporaire"
  rm -f "$temporaire.brut" "$temporaire.erreur"

  # `gzip -t` relit l'archive : un fichier tronqué par un disque plein
  # passerait toutes les vérifications précédentes.
  if ! gzip -t "$temporaire" 2>/dev/null; then
    echoerr "$(date -Iseconds) — ÉCHEC : $description, archive illisible"
    rm -f "$temporaire"
    exit 1
  fi

  taille=$(wc -c < "$temporaire")

  mv "$temporaire" "$destination"
  echo "$(date -Iseconds) — $description : $brute octets, $taille compressés"
}

# 1. La base.
capturer "$DOSSIER/heritage-$HORODATAGE.sql.gz" "base de données" \
  docker compose exec -T db pg_dump -U heritage -d heritage

# 2. Les archives binaires (photos, enregistrements).
#
# Une famille qui n'a encore déposé aucune photo produit tout de même un
# `tar` de plusieurs kilo-octets — l'en-tête du dossier et le bourrage de
# fin. C'est bien une réponse, et le plancher la laisse passer.
capturer "$DOSSIER/archives-$HORODATAGE.tar.gz" "archives binaires" \
  docker compose exec -T app tar -cf - -C /data archives

# 3. La purge, et seulement maintenant.
#
# Elle ne s'exécute qu'une fois les deux sauvegardes du jour ÉTABLIES —
# les `exit 1` ci-dessus la court-circuitent. Le hors-site est la ligne
# suivante, à décommenter une fois rclone configuré vers Cloudflare R2
# (10 Go gratuits, largement au-delà de ce qu'une famille produira).
find "$DOSSIER" -name '*.gz' -mtime "+$JOURS" -delete
# rclone copy "$DOSSIER" r2:heritage-sauvegardes --max-age 25h

# Les fichiers en cours d'écriture d'une exécution interrompue n'ont rien
# à faire là au matin.
find "$DOSSIER" -name '*.en-cours*' -mtime +1 -delete

echo "$(date -Iseconds) — sauvegarde faite : $(ls -1 "$DOSSIER" | wc -l) fichiers conservés, $JOURS jours."
