#!/bin/sh
# Sauvegarde de la mémoire familiale.
#
# À lancer par cron sur le VPS. Une application dont la promesse est de
# garder cinquante ans de récits ne peut pas dépendre d'un seul disque.
#
#   0 3 * * * cd /opt/heritage && ./sauvegarde.sh >> /var/log/heritage-backup.log 2>&1
set -eu

HORODATAGE=$(date +%Y-%m-%d)
DOSSIER=./sauvegardes
mkdir -p "$DOSSIER"

# 1. La base, compressée.
docker compose exec -T db pg_dump -U heritage -d heritage \
  | gzip > "$DOSSIER/heritage-$HORODATAGE.sql.gz"

# 2. Les archives binaires (photos, enregistrements).
docker compose exec -T app tar -cf - -C /data archives \
  | gzip > "$DOSSIER/archives-$HORODATAGE.tar.gz"

# 3. On garde trente jours sur place. Le hors-site, c'est la ligne suivante,
#    à décommenter une fois rclone configuré vers Cloudflare R2 (10 Go
#    gratuits, largement au-delà de ce qu'une famille produira).
find "$DOSSIER" -name '*.gz' -mtime +30 -delete
# rclone copy "$DOSSIER" r2:heritage-sauvegardes --max-age 25h

echo "$(date -Iseconds) — sauvegarde faite : $(ls -1 "$DOSSIER" | wc -l) fichiers conservés."
