# Deploying to EC2 with GitHub Actions

A step-by-step account of how this repo's stack (Postgres + FastAPI backend +
Next.js frontend) is built into container images by GitHub Actions and rolled out
onto an EC2 box over SSH.

Target host used here: `ubuntu@3.87.157.251`, key `~/.ssh/henry.pem`.

---

## How it works

```
push to main
     │
     ▼
┌──────────────────────────────┐
│ job: build                   │   builds ./backend and ./frontend with Buildx
│  → ghcr.io/<repo>/backend    │   and pushes each to GHCR twice:
│  → ghcr.io/<repo>/frontend   │     :<git-sha>   ← what the host deploys
└──────────────┬───────────────┘     :latest      ← human convenience pointer
               │
               ▼
┌──────────────────────────────┐
│ job: deploy                  │   1. scp deploy/ → /home/ubuntu/app
│  ssh ubuntu@<EC2_HOST>       │   2. ssh: bash /home/ubuntu/app/deploy.sh
└──────────────┬───────────────┘
               ▼
        EC2 host runs deploy.sh
        login GHCR → write .env → prune → pull → up -d --wait → health check
```

The host never builds anything and never clones the repo. It only ever receives
two files and pulls images by immutable tag.

---

## Step 1 — Confirm the host is ready

```bash
ssh -i ~/.ssh/henry.pem ubuntu@3.87.157.251 \
  'docker --version; docker compose version; groups'
```

You need three things to be true:

- Docker Engine is installed (`Docker version 29.7.2` here).
- Compose v2 is available as `docker compose` (`v5.4.0` here).
- The login user is in the `docker` group, so no `sudo` is needed.

If Docker is missing, install it once by hand:

```bash
ssh -i ~/.ssh/henry.pem ubuntu@3.87.157.251 'bash -s' <<'EOF'
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
EOF
```

Then reconnect so the new group membership takes effect.

### Security group

Only open what the public actually needs. For this stack that is:

| Port | Who needs it | State |
| --- | --- | --- |
| 22 | you / GitHub Actions SSH | open |
| 3000 | the public — Next.js frontend | open |
| 8000 | nobody — frontend proxies to it internally | **closed** |
| 5433 | nobody — bound to `127.0.0.1` in compose | **closed** |

The backend is reached by the frontend over the compose network as
`http://backend:8000`, so it never needs a public port. `deploy.sh` health-checks
it from the host over loopback.

---

## Step 2 — Add the deployment files

Three files do the work.

### `deploy/docker-compose.prod.yml`

A production copy of the root compose file with two deliberate differences:

- **No `build:` sections.** Every service uses `image:` only, so the host can
  bring the stack up without any source code. `BACKEND_IMAGE` / `FRONTEND_IMAGE`
  are declared `${VAR:?...}` so a missing value fails loudly instead of silently
  starting the wrong thing.
- **Postgres bound to loopback** (`127.0.0.1:5433:5432`) instead of `0.0.0.0`.

`name: biodata` is kept identical to the dev compose file. That matters: it makes
Compose adopt any already-running containers and, critically, reuse the existing
`biodata_db_data` volume rather than creating an empty second one.

### `deploy/deploy.sh`

The server-side half. Run repeatedly with the same inputs it converges to the
same state — same `.env`, same image tags, same stack — so a re-run or a retried
job is harmless. In order it:

1. Picks `docker` or falls back to `sudo docker`.
2. Logs in to GHCR from `$REGISTRY_TOKEN` on stdin (never on the command line).
3. Renders `/home/ubuntu/app/.env` atomically under `umask 077`, so the file
   holding the database password lands as `0600`.
4. Prunes dangling images and build cache **before** pulling — this box is small
   and a deploy must not die halfway through on a full disk.
5. `compose pull`, then `compose up -d --remove-orphans --wait --wait-timeout 180`.
   `--wait` blocks until every service reports its healthcheck healthy.
6. Independently curls `/health` on the backend and `/` on the frontend, and on
   failure dumps `ps` + the last 120 log lines before exiting non-zero.
7. Prunes again.

Database migrations are not a separate step: the backend's compose `command` runs
`alembic upgrade head` before starting the server, and that is a no-op when the
schema is already current.

### `.github/workflows/deploy.yml`

Two jobs, `build` then `deploy`.

The details that matter:

- **Lowercase the image path.** GHCR rejects uppercase, and `github.repository`
  preserves the owner's casing, so it is piped through `tr '[:upper:]' '[:lower:]'`.
- **Deploy the `:sha` tag, not `:latest`.** The `build` job exports the fully
  qualified `…/backend:<sha>` reference as a job output and the `deploy` job
  consumes it. This makes each rollout immutable and unambiguous, and means
  `compose up` genuinely detects a change and recreates the containers.
- **`concurrency` with `cancel-in-progress: false`.** Only one deploy runs at a
  time, but a half-applied rollout is never cancelled mid-flight.
- **Secrets reach the host as environment variables**, listed in the ssh-action's
  `envs:` and set in the step's `env:` block. The `script:` is a single line —
  `bash "$APP_DIR/deploy.sh"` — so no secret is ever interpolated into a command
  line or the remote shell history.

> A bug worth calling out, because the earlier version of this workflow had it:
> `appleboy/ssh-action`'s `envs:` only forwards variables that actually exist in
> the step's environment. Listing `GITHUB_TOKEN` there without a matching `env:`
> entry forwards an empty string, and the GHCR login on the host silently fails.
> Every name in `envs:` must have a corresponding line under `env:`.

---

## Step 3 — Set the secrets and variables

Run locally with the `gh` CLI:

```bash
gh secret set EC2_HOST       --body "3.87.157.251"
gh secret set EC2_USERNAME   --body "ubuntu"
gh secret set EC2_PORT       --body "22"
gh secret set EC2_TARGET_DIR --body "/home/ubuntu/app"
gh secret set EC2_SSH_KEY    < ~/.ssh/henry.pem

gh secret set POSTGRES_USER     --body "biodata"
gh secret set POSTGRES_PASSWORD --body "biodata"
gh secret set POSTGRES_DB       --body "biodata"

gh variable set CORS_ORIGINS --body "http://3.87.157.251:3000,http://localhost:3000"
```

Notes:

- `EC2_SSH_KEY` is fed from the file with `<` so the newlines survive. A key
  pasted into a shell string on one line will not parse. Verify yours first with
  `ssh-keygen -y -f ~/.ssh/henry.pem`.
- `EC2_TARGET_DIR` is an **absolute** path. `~/app` is not reliably expanded by
  the scp action.
- The `POSTGRES_*` values must match the credentials the existing
  `biodata_db_data` volume was initialised with. Postgres only reads
  `POSTGRES_PASSWORD` when it creates a fresh data directory, so changing the
  secret on an existing volume does *not* rotate the password — it just makes the
  backend fail to authenticate. To genuinely rotate it, change it inside the
  database first (`ALTER USER biodata WITH PASSWORD '…'`) and then update the
  secret to match.
- `GITHUB_TOKEN` is not set by you. Actions injects it, and
  `permissions: packages: write` is what lets it push to GHCR.

Confirm:

```bash
gh secret list
gh variable list
```

Create the deployment environment referenced by the job (a first run
auto-creates it, but doing it explicitly avoids surprises):

```bash
gh api -X PUT repos/<owner>/<repo>/environments/production
```

---

## Step 4 — Rehearse on the host before pushing

Do not find out whether the server half works by watching a red CI run. Test it
directly against the box first, using the images already on it.

```bash
ssh -i ~/.ssh/henry.pem ubuntu@3.87.157.251 'mkdir -p /home/ubuntu/app'
scp -i ~/.ssh/henry.pem deploy/docker-compose.prod.yml deploy/deploy.sh \
  ubuntu@3.87.157.251:/home/ubuntu/app/
```

Local images cannot be pulled, so override the pull policy just for the
rehearsal:

```bash
ssh -i ~/.ssh/henry.pem ubuntu@3.87.157.251 'cat > /home/ubuntu/app/rehearsal.override.yml <<YAML
services:
  backend:
    pull_policy: never
  frontend:
    pull_policy: never
YAML'

ssh -i ~/.ssh/henry.pem ubuntu@3.87.157.251 \
  'cd /home/ubuntu/app && sed "s|-f \$COMPOSE_FILE|-f \$COMPOSE_FILE -f /home/ubuntu/app/rehearsal.override.yml|" deploy.sh > rehearse.sh'

ssh -i ~/.ssh/henry.pem ubuntu@3.87.157.251 'cd /home/ubuntu/app && \
  APP_DIR=/home/ubuntu/app \
  BACKEND_IMAGE=biodata-backend:local FRONTEND_IMAGE=biodata-frontend:local \
  POSTGRES_USER=biodata POSTGRES_PASSWORD=biodata POSTGRES_DB=biodata \
  POSTGRES_HOST_PORT=5433 BACKEND_HOST_PORT=8000 FRONTEND_HOST_PORT=3000 \
  CORS_ORIGINS="http://3.87.157.251:3000" LOG_LEVEL=INFO \
  bash rehearse.sh'
```

Expected tail:

```
==> Verifying endpoints
==> Healthy
NAME                 IMAGE                    SERVICE    STATUS
biodata-backend-1    biodata-backend:local    backend    Up (healthy)
biodata-db-1         postgres:16-alpine       db         Up (healthy)   127.0.0.1:5433->5432/tcp
biodata-frontend-1   biodata-frontend:local   frontend   Up (healthy)   0.0.0.0:3000->3000/tcp
==> Deploy complete
```

Check the data survived the recreate, then clean up:

```bash
ssh -i ~/.ssh/henry.pem ubuntu@3.87.157.251 \
  'docker exec biodata-db-1 psql -U biodata -d biodata -c "\dt"'
ssh -i ~/.ssh/henry.pem ubuntu@3.87.157.251 \
  'rm -f /home/ubuntu/app/rehearse.sh /home/ubuntu/app/rehearsal.override.yml'
```

Also validate the YAML and shell locally before committing:

```bash
BACKEND_IMAGE=x FRONTEND_IMAGE=y docker compose -f deploy/docker-compose.prod.yml config -q
bash -n deploy/deploy.sh
```

---

## Step 5 — Ship it

```bash
git checkout -b ci/ec2-deploy
git add .github/workflows/deploy.yml deploy/ actions.md
git commit -m "Deploy stack to EC2 from GitHub Actions"
git push -u origin ci/ec2-deploy
```

Trigger a real run against the branch before merging. `workflow_dispatch` is
declared in the workflow, and dispatching on a ref works because `deploy.yml`
already exists on the default branch:

```bash
gh workflow run deploy.yml --ref ci/ec2-deploy
gh run watch "$(gh run list --workflow=deploy.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```

Once green, open the PR and merge. From then on every push to `main` deploys.

---

## Step 6 — Verify

```bash
curl -fsS -o /dev/null -w "frontend %{http_code}\n" http://3.87.157.251:3000/

ssh -i ~/.ssh/henry.pem ubuntu@3.87.157.251 \
  'curl -fsS http://127.0.0.1:8000/health; docker compose -f /home/ubuntu/app/docker-compose.prod.yml ps'
```

The workflow also writes a job summary listing the exact image references that
were deployed.

---

## Operating it

**Watch a run**

```bash
gh run list --workflow=deploy.yml --limit 5
gh run view --log-failed
```

**Read logs on the host**

```bash
ssh -i ~/.ssh/henry.pem ubuntu@3.87.157.251 \
  'docker compose -f /home/ubuntu/app/docker-compose.prod.yml logs -f --tail=100 backend'
```

**Roll back.** Every commit's images stay in GHCR under their sha, so a rollback
is just pointing the host at an older tag:

```bash
ssh -i ~/.ssh/henry.pem ubuntu@3.87.157.251
cd /home/ubuntu/app
sed -i "s|/backend:.*|/backend:<older-sha>|; s|/frontend:.*|/frontend:<older-sha>|" .env
docker compose -f docker-compose.prod.yml up -d --wait
```

Re-running the workflow on the older commit does the same thing through CI.

**Re-deploy without a code change**

```bash
gh workflow run deploy.yml --ref main
```

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `denied: permission_denied` on push to GHCR | `permissions: packages: write` missing | add it at the workflow or job level |
| `unauthorized` when the host pulls | `REGISTRY_TOKEN` empty — a name in `envs:` with no matching `env:` entry | make sure every `envs:` name is set under `env:` |
| `invalid reference format` | uppercase in the image path | lowercase `github.repository` before building the tag |
| `ssh: handshake failed` | key pasted as a single line, losing newlines | `gh secret set EC2_SSH_KEY < ~/.ssh/henry.pem` |
| scp writes to a literal `~/app` directory | tilde not expanded by the action | use an absolute `EC2_TARGET_DIR` |
| `no space left on device` mid-pull | small root volume | the pre-pull prune in `deploy.sh` covers this; if it persists, drop stale tagged images with `docker image rm` |
| backend unhealthy, `password authentication failed` | `POSTGRES_PASSWORD` changed against an existing volume | `ALTER USER` inside Postgres, or start from a fresh volume |
| `compose up` tries to build | the dev `docker-compose.yml` got deployed instead of the prod one | the host must only ever receive `deploy/docker-compose.prod.yml` |
