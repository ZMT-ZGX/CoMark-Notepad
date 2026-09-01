#!/usr/bin/env bash
#
# Deploy Collab Notepad on this host, with automatic rollback on failure.
#
# Usage:
#   ./scripts/deploy.sh            # build from the current working tree and restart
#   ./scripts/deploy.sh --pull     # git pull first, then build and restart
#   ./scripts/deploy.sh --no-backup
#
# The script fails loudly and rolls back rather than leaving a broken instance
# up: before building it tags the currently running image, and if the new
# container does not become healthy it retags and restarts the old one.

set -euo pipefail

APP_SERVICE="${APP_SERVICE:-comark-notepad}"
IMAGE="${IMAGE:-comark-notepad:local}"
ROLLBACK_IMAGE="${ROLLBACK_IMAGE:-comark-notepad:rollback}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-120}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DO_PULL=0
DO_BACKUP=1
for arg in "$@"; do
  case "$arg" in
    --pull) DO_PULL=1 ;;
    --no-backup) DO_BACKUP=0 ;;
    -h | --help) sed -n '2,14p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 1 ;;
  esac
done

# --- Preflight ------------------------------------------------------------

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  echo "error: neither 'docker compose' nor 'docker-compose' is available" >&2
  exit 1
fi

if [ ! -f .env ]; then
  echo "error: .env is missing. Copy .env.example and fill in SESSION_SECRET and PUBLIC_ORIGIN." >&2
  exit 1
fi

if grep -q '^SESSION_SECRET=$' .env; then
  echo "error: SESSION_SECRET is empty in .env. Generate one with: openssl rand -hex 32" >&2
  exit 1
fi

# --- Helpers --------------------------------------------------------------

container_status() {
  docker inspect --format \
    '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
    "$APP_SERVICE" 2>/dev/null || echo "missing"
}

wait_healthy() {
  local elapsed=0
  while [ "$elapsed" -lt "$HEALTH_TIMEOUT" ]; do
    local status
    status="$(container_status)"
    if [ "$status" = "healthy" ]; then
      echo "container healthy after ${elapsed}s"
      return 0
    fi
    sleep 3
    elapsed=$((elapsed + 3))
  done
  echo "error: container did not become healthy within ${HEALTH_TIMEOUT}s (last status: $(container_status))" >&2
  return 1
}

rollback() {
  echo "!! deploy failed - rolling back" >&2
  if docker image inspect "$ROLLBACK_IMAGE" >/dev/null 2>&1; then
    docker tag "$ROLLBACK_IMAGE" "$IMAGE"
    "${COMPOSE[@]}" up -d --no-deps "$APP_SERVICE"
    if wait_healthy; then
      echo "rollback succeeded - previous version is running again"
    else
      echo "!! rollback did not become healthy - manual intervention required" >&2
      "${COMPOSE[@]}" logs --tail=100 "$APP_SERVICE" >&2 || true
    fi
  else
    echo "!! no rollback image was captured - cannot roll back automatically" >&2
    "${COMPOSE[@]}" logs --tail=100 "$APP_SERVICE" >&2 || true
  fi
  exit 1
}

# --- Deploy ---------------------------------------------------------------

if [ "$DO_PULL" -eq 1 ]; then
  echo "==> pulling latest code"
  git pull --ff-only
fi

if [ "$DO_BACKUP" -eq 1 ] && docker inspect "$APP_SERVICE" >/dev/null 2>&1; then
  echo "==> backing up before deploy"
  "$SCRIPT_DIR/backup.sh" || echo "warning: backup failed, continuing" >&2
fi

# Keep the currently running image so we can restore it if the new one is bad.
if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker tag "$IMAGE" "$ROLLBACK_IMAGE"
fi

echo "==> building"
"${COMPOSE[@]}" build "$APP_SERVICE"

echo "==> starting"
"${COMPOSE[@]}" up -d

echo "==> waiting for health check"
if ! wait_healthy; then
  rollback
fi

echo "==> done"
"${COMPOSE[@]}" ps
docker image prune -f >/dev/null 2>&1 || true
