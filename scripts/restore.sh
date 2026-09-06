#!/usr/bin/env bash
#
# Restore a backup produced by scripts/backup.sh into the running deployment.
# Automates the manual procedure in docs/DEPLOYMENT.md §5, including the one
# step that silently corrupts data when skipped: deleting the -wal / -shm
# files, without which SQLite replays the OLD write-ahead log over the newly
# restored database.
#
# Usage:
#   ./scripts/restore.sh <stamp>            # e.g. ./scripts/restore.sh 20260906-030000
#   BACKUP_DIR=/mnt/nas/notepad ./scripts/restore.sh 20260906-030000
#
# The instance is stopped for the duration and restarted afterwards; verify
# with `curl -sf http://localhost:8000/api/health/ready` once it comes back.

set -euo pipefail

CONTAINER="${CONTAINER:-comark-notepad}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
STAMP="${1:?usage: ./scripts/restore.sh <stamp, e.g. 20260906-030000>}"

DB_SRC="$BACKUP_DIR/$STAMP.db"
FILES_SRC="$BACKUP_DIR/$STAMP-files.tgz"

[ -f "$DB_SRC" ] || { echo "error: $DB_SRC not found" >&2; exit 1; }
docker inspect "$CONTAINER" >/dev/null 2>&1 || {
  echo "error: container '$CONTAINER' does not exist" >&2
  exit 1
}

echo "[$STAMP] stopping container..."
docker stop "$CONTAINER" >/dev/null

echo "[$STAMP] restoring database..."
docker cp "$DB_SRC" "$CONTAINER":/app/data/store.db
# The snapshot from the backup API is self-contained; a stale WAL from the
# crashed/previous instance must never be replayed on top of it.
docker exec "$CONTAINER" sh -c 'rm -f /app/data/store.db-wal /app/data/store.db-shm'

if [ -f "$FILES_SRC" ]; then
  echo "[$STAMP] restoring uploads archive..."
  docker cp "$FILES_SRC" "$CONTAINER":/tmp/restore-files.tgz
  docker exec "$CONTAINER" sh -c 'rm -rf /app/data/files && tar xzf /tmp/restore-files.tgz -C /app/data && rm -f /tmp/restore-files.tgz'
else
  echo "[$STAMP] no files archive for this stamp, leaving uploads untouched"
fi

echo "[$STAMP] starting container..."
docker start "$CONTAINER" >/dev/null

echo "[$STAMP] restore complete — verify with:"
echo "  curl -sf http://localhost:8000/api/health/ready"
echo "  docker compose logs --tail=50 comark-notepad"
