#!/usr/bin/env bash
#
# Back up the running instance: a consistent SQLite snapshot + an archive of
# uploaded files.
#
# Why not just `cp store.db`? SQLite keeps a write-ahead log (store.db-wal)
# beside the database, so copying the main file while the server is running can
# capture a half-checkpointed database that will not open when you need it.
# scripts/sqlite-backup.js uses SQLite's backup API instead and runs inside the
# container so it can reuse the app's own better-sqlite3 build.
#
# Usage:
#   ./scripts/backup.sh
#   BACKUP_DIR=/mnt/nas/notepad RETENTION_DAYS=30 ./scripts/backup.sh
#
# Suggested cron (daily at 03:00):
#   0 3 * * * cd /srv/comark-notepad && ./scripts/backup.sh >> /var/log/notepad-backup.log 2>&1

set -euo pipefail

CONTAINER="${CONTAINER:-comark-notepad}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "error: container '$CONTAINER' is not running" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

# Snapshots are staged inside the data volume, copied out, then deleted, so a
# half-written archive never lands in the host backup directory.
echo "[$STAMP] creating snapshot inside container..."
docker cp "$SCRIPT_DIR/sqlite-backup.js" "$CONTAINER":/tmp/sqlite-backup.js
docker exec -e STAMP="$STAMP" "$CONTAINER" node /tmp/sqlite-backup.js

if docker exec "$CONTAINER" test -d /app/data/files; then
  docker exec -e STAMP="$STAMP" "$CONTAINER" \
    sh -c 'tar czf "/app/data/backups/${STAMP}-files.tgz" -C /app/data files'
  echo "  uploads archive ok"
else
  echo "  no uploads directory yet, skipping archive"
fi

echo "[$STAMP] copying to host: $BACKUP_DIR"
docker cp "$CONTAINER:/app/data/backups/$STAMP.db" "$BACKUP_DIR/$STAMP.db"
if docker exec "$CONTAINER" test -f "/app/data/backups/$STAMP-files.tgz"; then
  docker cp "$CONTAINER:/app/data/backups/$STAMP-files.tgz" "$BACKUP_DIR/$STAMP-files.tgz"
fi

# Leave nothing staged behind in the data volume.
docker exec "$CONTAINER" rm -f \
  "/app/data/backups/$STAMP.db" \
  "/app/data/backups/$STAMP-files.tgz" \
  /tmp/sqlite-backup.js

echo "[$STAMP] pruning local backups older than ${RETENTION_DAYS} days"
find "$BACKUP_DIR" -name '*.db' -mtime "+${RETENTION_DAYS}" -delete
find "$BACKUP_DIR" -name '*-files.tgz' -mtime "+${RETENTION_DAYS}" -delete

echo "[$STAMP] backup complete:"
ls -lh "$BACKUP_DIR/$STAMP.db"
