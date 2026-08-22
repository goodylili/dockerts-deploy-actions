#!/usr/bin/env bash
#
# Server-side half of the deployment. Copied to the EC2 host by
# .github/workflows/deploy.yml and executed there over SSH.
#
# Everything here is safe to run repeatedly with the same inputs: it writes the
# same .env, pulls the same immutable image tags and converges the same stack.
set -euo pipefail

APP_DIR="${APP_DIR:-/home/ubuntu/app}"
COMPOSE_FILE="${APP_DIR}/docker-compose.prod.yml"

: "${BACKEND_IMAGE:?BACKEND_IMAGE is required}"
: "${FRONTEND_IMAGE:?FRONTEND_IMAGE is required}"

cd "$APP_DIR"

# ---------------------------------------------------------------- docker cmd --
# The ubuntu user is in the docker group, but fall back to sudo on a host where
# it is not so the deploy still works on a freshly provisioned box.
if docker info >/dev/null 2>&1; then
  DOCKER="docker"
else
  DOCKER="sudo docker"
fi
COMPOSE="$DOCKER compose -f $COMPOSE_FILE"

# ------------------------------------------------------------------- registry --
if [ -n "${REGISTRY_TOKEN:-}" ]; then
  echo "==> Logging in to ${REGISTRY:-ghcr.io}"
  echo "$REGISTRY_TOKEN" | $DOCKER login "${REGISTRY:-ghcr.io}" \
    -u "${REGISTRY_USER:?REGISTRY_USER is required}" --password-stdin
fi

# ------------------------------------------------------------------------ env --
# Rendered fresh every deploy so the file on disk always matches the workflow
# inputs. Written atomically; 0600 because it holds the database password.
echo "==> Writing ${APP_DIR}/.env"
umask 077
cat > .env.tmp <<ENV
POSTGRES_USER=${POSTGRES_USER}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
POSTGRES_DB=${POSTGRES_DB}
POSTGRES_HOST_PORT=${POSTGRES_HOST_PORT}
DATABASE_URL=postgresql+psycopg://${POSTGRES_USER}:${POSTGRES_PASSWORD}@db:5432/${POSTGRES_DB}
BACKEND_IMAGE=${BACKEND_IMAGE}
FRONTEND_IMAGE=${FRONTEND_IMAGE}
BACKEND_HOST_PORT=${BACKEND_HOST_PORT}
FRONTEND_HOST_PORT=${FRONTEND_HOST_PORT}
BACKEND_URL=http://backend:8000
CORS_ORIGINS=${CORS_ORIGINS}
LOG_LEVEL=${LOG_LEVEL}
ENV
mv .env.tmp .env
umask 022

# ---------------------------------------------------------------- disk headroom --
# This box is small; reclaim dangling layers and build cache before pulling so a
# deploy cannot fail halfway through on a full disk.
echo "==> Reclaiming disk before pull"
$DOCKER image prune -f >/dev/null 2>&1 || true
$DOCKER builder prune -f >/dev/null 2>&1 || true
df -h / | tail -1

# ------------------------------------------------------------------- rollout --
echo "==> Pulling images"
echo "    backend  ${BACKEND_IMAGE}"
echo "    frontend ${FRONTEND_IMAGE}"
$COMPOSE pull

echo "==> Starting stack"
$COMPOSE up -d --remove-orphans --wait --wait-timeout 180

# ------------------------------------------------------------------- verify --
echo "==> Verifying endpoints"
ok=0
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${BACKEND_HOST_PORT}/health" | grep -q '"status":"ok"' \
     && curl -fsS -o /dev/null "http://127.0.0.1:${FRONTEND_HOST_PORT}/"; then
    ok=1
    break
  fi
  sleep 2
done

if [ "$ok" -ne 1 ]; then
  echo "Health verification failed — recent logs:" >&2
  $COMPOSE ps
  $COMPOSE logs --tail=120
  exit 1
fi

echo "==> Healthy"
$COMPOSE ps

# ------------------------------------------------------------------ cleanup --
$DOCKER image prune -f >/dev/null 2>&1 || true
echo "==> Deploy complete"
