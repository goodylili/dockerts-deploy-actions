# Student Notes — Shipping an App to a Server, From Zero

These notes teach the whole pipeline this project uses, assuming you know **nothing**
about Docker, servers, or CI/CD. Every concept is introduced before it is used, and
every example is real code from this repository.

If you just want the commands, read [`actions.md`](./actions.md) instead. This
document explains *why* each piece exists.

---

## Table of contents

1. [The problem we are solving](#1-the-problem-we-are-solving)
2. [What this app is made of](#2-what-this-app-is-made-of)
3. [Docker: images and containers](#3-docker-images-and-containers)
4. [Reading a real Dockerfile](#4-reading-a-real-dockerfile)
5. [Docker Compose: running several containers together](#5-docker-compose-running-several-containers-together)
6. [The server: EC2, SSH and firewalls](#6-the-server-ec2-ssh-and-firewalls)
7. [Registries: where images live](#7-registries-where-images-live)
8. [CI/CD and GitHub Actions](#8-cicd-and-github-actions)
9. [Our pipeline, line by line](#9-our-pipeline-line-by-line)
10. [The deploy script, line by line](#10-the-deploy-script-line-by-line)
11. [Operating it after launch](#11-operating-it-after-launch)
12. [Mistakes we actually hit](#12-mistakes-we-actually-hit)
13. [Glossary](#13-glossary)
14. [Exercises](#14-exercises)

---

## 1. The problem we are solving

You have written an app. It runs on your laptop. You type `npm run dev`, open
`localhost:3000`, and it works.

Now you want other people to use it. That means it has to run on a computer that is
always on and reachable from the internet — a **server**. And that raises problems
your laptop never had:

**Problem 1: "It works on my machine."**
Your laptop has Python 3.12, Node 22, a particular Postgres version, and a hundred
libraries you installed over the years. The server is a bare Ubuntu box. Copying your
code across is not enough; the environment has to come with it.

**Problem 2: Deploying by hand is slow and easy to get wrong.**
The manual version is: SSH into the server, `git pull`, install dependencies, run
database migrations, restart the app, hope. Miss a step at 2am and the site is down.
Do it ten times and you will do it ten slightly different ways.

**Problem 3: No record of what is running.**
If deployment is a human typing commands, then "what version is live?" has no reliable
answer.

The industry answer to all three:

- **Docker** packages the app *with* its environment, so it runs identically anywhere.
- **CI/CD** makes a robot do the deploy, identically, every time.
- **Image tags** give every deployment a name you can point at and roll back to.

That is the whole subject. Everything below is detail.

---

## 2. What this app is made of

Three pieces that must all be running:

| Piece | What it is | Technology |
| --- | --- | --- |
| **db** | Stores the data permanently | PostgreSQL 16 |
| **backend** | The API — validates and saves records | Python, FastAPI |
| **frontend** | The web page people actually see | Next.js (React) |

They talk in a chain:

```
your browser  →  frontend (port 3000)  →  backend (port 8000)  →  db (port 5432)
```

An important detail: **your browser never talks to the backend directly.** The
frontend server fetches from the backend on the browser's behalf. This is why, later,
we can keep the backend's port closed to the internet entirely.

> **Port**: a numbered door on a computer. One machine can run many programs; the port
> says which one you want. `localhost:3000` means "this machine, door 3000".

---

## 3. Docker: images and containers

### The core idea

Docker packages your app together with everything it needs to run — the operating
system files, the language runtime, the libraries, your code — into one bundle. That
bundle runs the same on your Mac, on a colleague's Windows laptop, and on a Linux
server.

### Image vs container — the distinction everything else rests on

This trips up every beginner, so be precise:

- An **image** is a *blueprint*. A frozen, read-only snapshot. Like a class in
  programming, or a recipe, or an ISO file.
- A **container** is a *running instance* of an image. Like an object, or the actual
  meal, or the booted machine.

One image → many containers. Delete a container and the image is untouched.

```bash
docker images      # list blueprints on this machine
docker ps          # list running containers
docker ps -a       # list all containers, including stopped ones
```

### Why not just a virtual machine?

A VM emulates a whole computer including its own OS kernel — gigabytes, slow to boot.
Containers share the host's kernel and isolate only what is needed. Megabytes, boot in
under a second. That is why you can casually run three containers on a small server.

### Layers, and why they matter

An image is built in **layers**, one per instruction. Each layer is cached. If a layer
and everything before it are unchanged, Docker reuses the cache instead of redoing the
work.

This drives how you order a Dockerfile: **things that change rarely go first, things
that change constantly go last.** Your dependency list changes monthly; your source
code changes hourly. So copy the dependency list and install *before* copying source.
Otherwise every one-character code edit re-installs every dependency.

You will see this exact trick in the next section.

---

## 4. Reading a real Dockerfile

A `Dockerfile` is the recipe for an image. Here is this project's backend one, with
commentary. Full file: `backend/Dockerfile`.

```dockerfile
FROM python:3.12-slim AS builder
```

`FROM` = start from an existing image. `python:3.12-slim` is an official image with
Python pre-installed; `slim` means a trimmed-down variant. `AS builder` names this
stage — see multi-stage below.

```dockerfile
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project --no-dev
```

Copy **only** the dependency files, then install. Because of layer caching, this
expensive step re-runs only when `pyproject.toml` or `uv.lock` changes — not when you
edit a Python file.

```dockerfile
COPY . .
RUN uv sync --frozen --no-dev
```

*Now* copy the source. This layer rebuilds constantly, but it is cheap.

### Multi-stage builds

Look at what comes next:

```dockerfile
FROM python:3.12-slim AS runtime
COPY --from=builder --chown=1001:1001 /app /app
```

A second `FROM` starts a **fresh, empty image**. We copy in only the finished result
from the `builder` stage. Compilers, caches, and build tools are left behind.

Why bother? A smaller image is faster to push, faster to pull, and — more importantly
— has less in it that could be exploited. A compiler on a production server is a tool
for an attacker.

The frontend does the same thing more aggressively, in four stages: install all deps →
build the app → install *production-only* deps → assemble a runner with just the built
output and production deps.

### Running as a non-root user

```dockerfile
RUN groupadd --system --gid 1001 app && useradd --system --uid 1001 --gid app ...
USER 1001:1001
```

By default a container runs as `root`. If someone finds a hole in your app, they get
root inside the container — a much better starting position for breaking out onto the
host. Creating an unprivileged user and switching to it costs two lines and removes a
whole class of escalation. Do it always.

### Healthchecks

```dockerfile
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=6 \
    CMD ["python", "-c", "...urlopen('http://127.0.0.1:8000/health')..."]
```

This teaches Docker how to tell whether the app is *actually working*, not merely
whether the process is alive. A process can be running and still be broken — hung,
unable to reach the database, stuck in a boot loop.

`start-period=20s` is a grace window: failures during startup don't count against it.

This matters enormously later: our deploy waits for healthchecks and **fails the
deployment** if they never pass. Without healthchecks, a broken deploy looks
successful.

### CMD

```dockerfile
CMD ["uvicorn", "biodata.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

The default command when a container starts.

> `0.0.0.0` means "accept connections on all network interfaces". A common beginner
> bug is binding to `127.0.0.1` inside a container — that means "only from inside this
> container", so nothing outside can ever reach it.

### Building and running by hand

```bash
docker build -t my-backend ./backend       # -t gives the image a name (tag)
docker run -p 8000:8000 my-backend         # -p maps host port : container port
```

`-p 8000:8000` = "connect door 8000 on my machine to door 8000 in the container".

### .dockerignore

Like `.gitignore`, but for builds. Excluding `node_modules`, `.git` and `.venv` keeps
the build fast and prevents secrets in local files from being baked into an image.

---

## 5. Docker Compose: running several containers together

Running three containers by hand means three long `docker run` commands, in the right
order, with the right network wiring. **Compose** puts that in one file.

From `docker-compose.yml`:

```yaml
name: biodata

services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-biodata}
    ports:
      - "${POSTGRES_HOST_PORT:-5432}:5432"
    volumes:
      - db_data:/var/lib/postgresql/data
```

Concepts, one at a time:

### Services

Each entry under `services:` becomes a container. The key (`db`, `backend`,
`frontend`) is its name.

### The private network

Compose puts all services on one private network where **they can reach each other by
service name**. That is why the backend's database address is:

```
postgresql+psycopg://biodata:biodata@db:5432/biodata
                                     ^^
                                     the service name, used as a hostname
```

No IP addresses anywhere. This is also why the backend never needs a public port: the
frontend reaches it at `http://backend:8000` over this private network.

### Volumes — where your data survives

**Containers are disposable.** Delete one and everything written inside it is gone.
That is fine for an app; catastrophic for a database.

A **volume** is storage that lives outside the container:

```yaml
volumes:
  - db_data:/var/lib/postgresql/data
```

"Mount the volume named `db_data` at that path inside the container." Destroy and
recreate the container as often as you like — the data is in the volume.

> ⚠️ **The single most dangerous command in this document:**
> `docker compose down -v`
> The `-v` deletes volumes. That is your production database, permanently. Plain
> `docker compose down` is safe. In this project we deliberately ran `down` **without**
> `-v` when redeploying, and confirmed afterwards that the records were still there.

### Environment variables and `${VAR:-default}`

`${POSTGRES_USER:-biodata}` means "use `POSTGRES_USER` if it is set, otherwise
`biodata`". Compose reads these from a `.env` file sitting next to the compose file.

This is how the same file works in development and production with different values —
and it is why secrets never need to be written into the file itself.

There is a second, stricter form we use in production:

```yaml
image: ${BACKEND_IMAGE:?BACKEND_IMAGE must be set}
```

`:?` means "if this is missing, **fail with this message**". Use `:-` for things with a
sensible default; use `:?` for things where guessing would be dangerous.

### depends_on and startup order

```yaml
depends_on:
  db:
    condition: service_healthy
```

"Do not start the backend until the db's healthcheck passes."

The naive version, `depends_on: [db]`, only waits for the container to *start* — not
for Postgres to finish initialising and accept connections. The backend would launch,
fail to connect, and crash. `condition: service_healthy` is what you almost always
want.

### Everyday commands

```bash
docker compose up -d          # start everything, -d = detached (background)
docker compose ps             # what is running
docker compose logs -f        # follow logs (Ctrl-C to stop watching)
docker compose logs -f backend  # just one service
docker compose down           # stop and remove containers (volumes SURVIVE)
docker compose pull           # fetch newer images
```

---

## 6. The server: EC2, SSH and firewalls

### What a VPS is

A **VPS** (virtual private server) is a computer you rent in a datacentre. AWS calls
theirs **EC2**. It is always on, has a public IP address, and you control it entirely.
Ours is Ubuntu at `3.87.157.251`.

### SSH: logging into a computer you cannot touch

**SSH** gives you an encrypted terminal on a remote machine.

```bash
ssh -i ~/.ssh/henry.pem ubuntu@3.87.157.251
```

- `ubuntu` — the username on the server
- `3.87.157.251` — its address
- `-i ~/.ssh/henry.pem` — the **private key** to authenticate with

### Key pairs, briefly

Servers use **key pairs** instead of passwords. Two matching files:

- **Public key** — lives on the server. Shareable.
- **Private key** — stays with you (`henry.pem`). **Never share it. Never commit it.**

The server challenges you in a way only the private key holder can answer. No secret
crosses the network, so there is nothing to intercept, and nothing to brute-force.

Keys must be private to you or SSH refuses them:

```bash
chmod 600 ~/.ssh/henry.pem
```

### Security groups (the firewall)

A **security group** is AWS's firewall: which ports the internet may reach. Ours:

| Port | Purpose | Open? |
| --- | --- | --- |
| 22 | SSH | ✅ |
| 3000 | frontend — what users load | ✅ |
| 8000 | backend API | ❌ closed |
| 5433 | Postgres | ❌ closed |

**Why close 8000 and 5433?** Because nothing outside needs them. The browser only
loads the frontend; the frontend reaches the backend over Compose's private network;
the backend reaches the db the same way.

Every open port is a door someone can try. This is the **principle of least
privilege**: grant exactly what is needed and nothing more.

We enforced the database one in the compose file too:

```yaml
ports:
  - "127.0.0.1:5433:5432"     # only this machine can connect
```

versus the default `"5433:5432"`, which listens on *every* interface — meaning a
Postgres exposed to the entire internet. It genuinely was, before we fixed it.

---

## 7. Registries: where images live

You build an image in one place (GitHub's build machine) and run it in another (your
server). A **container registry** is the warehouse in between — like npm for
containers.

Docker Hub is the famous one. We use **GHCR** (GitHub Container Registry) because it
comes free with the repo and authenticates with credentials CI already has.

```
ghcr.io/goodylili/dockerts-deploy-actions/backend:8e87b66
└─┬──┘ └───┬────┘ └──────────┬──────────┘ └──┬──┘ └──┬──┘
registry  owner            repo          image   tag
```

### Tags, and why `latest` is a trap

A **tag** labels a version. `:latest` is conventional but treacherous: it is a moving
pointer. Ask for `latest` twice and you can get two different images. You cannot say
"roll back to the previous latest" — the information does not exist.

So we publish **two** tags for every build:

- `:8e87b66…` — the **git commit SHA**. Immutable. Exactly one image forever.
- `:latest` — convenience for humans.

**The server always deploys the SHA tag.** That gives us:

1. Certainty about what is running.
2. Rollback: every past commit's image is still in the registry under its own SHA.
3. Correct updates — more on this next.

### The subtle bug SHA tags prevent

If the server has `myapp:latest` cached and you ask it to run `myapp:latest`, Docker
may reasonably conclude it already has it and skip the download — leaving your old
code running while CI reports success. With a SHA tag, the name is genuinely new, so
there is nothing to mistake.

We belt-and-brace it with `pull_policy: always`.

---

## 8. CI/CD and GitHub Actions

### The terms

- **CI (Continuous Integration)** — on every push, automatically build and test.
  Catches breakage in minutes rather than in production.
- **CD (Continuous Deployment)** — when tests pass, automatically deploy.

Together: you `git push`, and some minutes later it is live, with no human typing
commands on a server.

### GitHub Actions vocabulary

A **workflow** is a YAML file in `.github/workflows/`. It runs on a **runner** — a
fresh virtual machine GitHub gives you, which is destroyed afterwards. That freshness
is a feature: nothing lingers between runs, so it cannot "work because of something
installed last Tuesday".

The hierarchy:

```
workflow          one YAML file
└── job           runs on its own machine; jobs run in parallel unless told otherwise
    └── step      one command, or one reusable "action"
```

```yaml
on:                      # WHEN to run
  push:
    branches: [main]
  workflow_dispatch:     # also allow a manual button/CLI trigger

jobs:
  build:                 # a job
    runs-on: ubuntu-latest
    steps:               # its steps, in order
      - uses: actions/checkout@v4     # a prebuilt action someone else wrote
      - run: echo hello               # a shell command
```

- `uses:` — run a published action. `actions/checkout@v4` copies your repo onto the
  runner. (A runner starts empty — **without this step your code is not there.**)
- `run:` — run a shell command.

### Secrets

Passwords and keys must never be committed. GitHub stores them encrypted and injects
them at runtime as `${{ secrets.NAME }}`. They are masked as `***` in logs — you can
see this in our deploy log, where the project name appears as `***`.

Set them with the GitHub CLI:

```bash
gh secret set EC2_HOST --body "3.87.157.251"
gh secret set EC2_SSH_KEY < ~/.ssh/henry.pem     # from a file, keeping newlines
```

> Note the `<`. An SSH key is multi-line. Pasting it as a shell string mangles it, and
> you get an unhelpful "handshake failed" later. Feed it from the file.

**Secrets vs variables:** `secrets` for anything sensitive; `vars` for non-sensitive
config (we use `vars.CORS_ORIGINS`). Variables are readable in logs, which is
convenient when they are not secret.

`GITHUB_TOKEN` is special — GitHub creates it automatically for each run. We never set
it. It is what lets the workflow push images, granted by:

```yaml
permissions:
  packages: write
```

---

## 9. Our pipeline, line by line

The full file is `.github/workflows/deploy.yml`. Two jobs.

```yaml
on:
  push:
    branches: [main]
  workflow_dispatch:
```

Deploy on every push to `main`, and allow manual runs (useful for testing on a branch,
and for redeploying without a code change).

```yaml
concurrency:
  group: deploy-${{ github.ref }}
  cancel-in-progress: false
```

Only one deploy at a time. Two simultaneous deploys would fight over the same server.
`cancel-in-progress: false` is deliberate: killing a deploy halfway through leaves the
server in an unknown state, which is worse than waiting.

### Job 1 — build

```yaml
repo="$(echo "${{ github.repository }}" | tr '[:upper:]' '[:lower:]')"
```

GHCR rejects uppercase letters in image paths, but GitHub usernames may contain them.
Lowercase it or hit a confusing `invalid reference format`.

```yaml
- uses: docker/login-action@v3
  with:
    registry: ghcr.io
    username: ${{ github.actor }}
    password: ${{ secrets.GITHUB_TOKEN }}
```

Authenticate to the registry so we may push.

```yaml
- uses: docker/build-push-action@v6
  with:
    context: ./backend
    push: true
    tags: |
      ghcr.io/…/backend:${{ github.sha }}
      ghcr.io/…/backend:latest
    cache-from: type=gha,scope=backend
    cache-to: type=gha,mode=max,scope=backend
```

Build and push. `cache-from`/`cache-to` store the layer cache in GitHub, so the next
run reuses unchanged layers — the difference between a 4-minute and a 40-second build.

```yaml
outputs:
  backend_image: ${{ steps.images.outputs.backend }}
```

Jobs run on separate machines and share nothing. **Outputs** are how one job passes a
value to the next — here, the exact image reference to deploy.

### Job 2 — deploy

```yaml
needs: build
```

Wait for `build`; skip if it failed. Without `needs`, both jobs would start at once and
we would deploy images that do not exist yet.

```yaml
- uses: appleboy/scp-action@v0.1.7
  with:
    source: "deploy/docker-compose.prod.yml,deploy/deploy.sh"
    target: ${{ secrets.EC2_TARGET_DIR }}
    strip_components: 1
```

Copy two files to the server over SSH. `strip_components: 1` removes the leading
`deploy/` so they land directly in the target directory.

**The server receives only these two files.** No source code, no git clone. It does not
build anything — it only pulls finished images.

```yaml
- uses: appleboy/ssh-action@v1.2.0
  with:
    envs: APP_DIR,REGISTRY_TOKEN,BACKEND_IMAGE,...
    script: bash "$APP_DIR/deploy.sh"
  env:
    REGISTRY_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    BACKEND_IMAGE: ${{ needs.build.outputs.backend_image }}
```

Log in over SSH and run the script.

Note the shape: `script:` is **one line**. All the values arrive as environment
variables. If we had pasted secrets into the script text, they would appear in the
remote shell's process list and history. This way they do not.

**`envs:` and `env:` must agree.** `envs:` lists which variables to forward; `env:`
gives them values. Naming one in `envs:` without defining it in `env:` silently
forwards an empty string. That exact mistake is why the previous version of this
workflow failed — see §12.

---

## 10. The deploy script, line by line

`deploy/deploy.sh` runs **on the server**. Full file in the repo.

```bash
set -euo pipefail
```

Four safety switches every production bash script should open with:

- `-e` — exit immediately if any command fails. Without it, bash charges on after an
  error and "succeeds" at the end.
- `-u` — error on undefined variables. Catches typos instead of silently using "".
- `-o pipefail` — a pipeline fails if *any* stage fails, not just the last one.

```bash
: "${BACKEND_IMAGE:?BACKEND_IMAGE is required}"
```

Fail loudly and immediately if the workflow forgot to pass an image.

```bash
if docker info >/dev/null 2>&1; then DOCKER="docker"; else DOCKER="sudo docker"; fi
```

Use `docker` if permitted, else `sudo docker`. Our user is in the `docker` group; this
keeps the script working on a freshly provisioned box that is not yet set up.

```bash
echo "$REGISTRY_TOKEN" | $DOCKER login ghcr.io -u "$REGISTRY_USER" --password-stdin
```

`--password-stdin` pipes the token in rather than putting it on the command line. Any
user on the machine can read the process list; passwords in arguments are visible
there.

```bash
umask 077
cat > .env.tmp <<ENV
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
...
ENV
mv .env.tmp .env
```

Two techniques worth learning:

- `umask 077` — new files are readable only by their owner. This one holds a database
  password.
- **Write to a temp file, then `mv`.** Renaming is atomic: the file is either the old
  version or the new one, never half-written. If you write in place and the process
  dies midway, you are left with a corrupt file.

```bash
$DOCKER image prune -f
$DOCKER builder prune -f
```

Free disk **before** pulling. Our server had ~1.3GB free on a 6.7GB disk; a deploy that
runs out of space halfway through is a bad way to find out.

```bash
$COMPOSE up -d --remove-orphans --wait --wait-timeout 180
```

The heart of it. `--wait` blocks until every service reports **healthy** (those
healthchecks from §4), or fails after 180 seconds. This is what makes a broken deploy
turn the CI job red instead of green.

```bash
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:8000/health" | grep -q '"status":"ok"' \
     && curl -fsS -o /dev/null "http://127.0.0.1:3000/"; then ok=1; break; fi
  sleep 2
done
if [ "$ok" -ne 1 ]; then
  $COMPOSE logs --tail=120
  exit 1
fi
```

An independent check on top of the healthchecks — belt and braces — and on failure it
prints the logs *into the CI output*, so you can diagnose from GitHub without SSHing
anywhere.

### Idempotency — an idea worth internalising

**Idempotent** = running it twice does the same thing as running it once.

This script is idempotent by design: same inputs → same `.env`, same images, same
running stack. That means a retried job, a double-click, or a re-run after a network
blip is harmless.

Database migrations are the interesting case:

```yaml
command: sh -c "uv run alembic upgrade head && uv run python -m biodata"
```

`alembic upgrade head` applies any migrations not yet applied. If the schema is already
current it does nothing. So it can run on every single container start, forever, and
never cause harm — no separate "migration step" to remember or to get wrong.

---

## 11. Operating it after launch

### Deploying

```bash
git push origin main                       # that's it
gh workflow run deploy.yml --ref main      # or redeploy without a code change
```

### Watching

```bash
gh run list --workflow=deploy.yml --limit 5
gh run watch <run-id>
gh run view --log-failed                   # only the failed steps
```

### Reading logs on the server

```bash
ssh -i ~/.ssh/henry.pem ubuntu@3.87.157.251
docker compose -f /home/ubuntu/app/docker-compose.prod.yml logs -f --tail=100 backend
```

### Rolling back

This is where SHA tags pay off. Every past commit's image is still in the registry:

```bash
cd /home/ubuntu/app
sed -i "s|/backend:.*|/backend:<older-sha>|" .env
docker compose -f docker-compose.prod.yml up -d --wait
```

Under a minute, no rebuild.

### Checking what is actually live

```bash
docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}"
```

The image column shows the SHA, which maps to an exact commit. "What is running?" has a
precise answer.

---

## 12. Mistakes we actually hit

Real bugs from building this, and the lesson in each.

### 1. The registry login silently did nothing

The old workflow had:

```yaml
envs: GITHUB_ACTOR,GITHUB_TOKEN     # forwarded to the server
# ...but no matching env: block gave them values
```

`envs:` only forwards variables that **exist**. They did not, so the server ran
`docker login` with an empty password. Every deploy failed.

> **Lesson:** an empty variable is not an error in bash — it is an empty string. Check
> that both halves of a mechanism are wired, not just the visible one.

### 2. The wrong compose file went to the server

The development `docker-compose.yml` contains:

```yaml
build:
  context: ./backend
```

The server has no `./backend` — it never receives source code. Any build attempt dies
on a missing directory.

**Fix:** a separate `deploy/docker-compose.prod.yml` with no `build:` sections at all,
so building there is not merely discouraged but impossible.

> **Lesson:** development and production have genuinely different needs. Make the wrong
> thing unrepresentable rather than relying on remembering.

### 3. Deploying `:latest`

Covered in §7. Ambiguous, and no rollback.

### 4. Postgres open to the internet

`"5433:5432"` publishes on all interfaces. On a public server that is a database
anyone can attempt to connect to. It was live that way.

**Fix:** `"127.0.0.1:5433:5432"`.

### 5. Changing the database password did not change the database password

Postgres reads `POSTGRES_PASSWORD` **only when creating a brand-new data directory**.
Change the secret against an existing volume and Postgres ignores it — while your app
starts using the new value and fails to authenticate.

To rotate properly: change it inside the database first, then update the secret.

```sql
ALTER USER biodata WITH PASSWORD 'new-password';
```

> **Lesson:** "initialisation-time only" settings are everywhere in infrastructure.
> When a config change appears to have no effect, ask whether it is only read at
> creation.

### 6. Nearly running out of disk

A 6.7GB disk, ~1.7GB of images, and each deploy pulls more. Hence the prune step before
pulling.

> **Lesson:** servers are not laptops. Disk, memory and bandwidth are finite and
> smaller than you are used to.

---

## 13. Glossary

| Term | Meaning |
| --- | --- |
| **Image** | Read-only blueprint of an app plus its environment |
| **Container** | A running instance of an image |
| **Dockerfile** | Recipe for building an image |
| **Layer** | One cached step of an image build |
| **Multi-stage build** | Build in one stage, copy only results into a clean final stage |
| **Volume** | Storage that outlives the container — where databases keep data |
| **Compose** | Tool for defining and running multi-container apps from one YAML file |
| **Healthcheck** | A command that reports whether an app truly works |
| **Registry** | Warehouse for images (GHCR, Docker Hub) |
| **Tag** | A version label on an image |
| **SHA** | The unique id of a git commit; our immutable image tag |
| **CI/CD** | Automated build/test, then automated deploy |
| **Workflow / job / step** | Actions hierarchy: file → machine → command |
| **Runner** | The fresh VM a job runs on |
| **Secret** | Encrypted value injected at runtime, masked in logs |
| **SSH** | Encrypted remote terminal |
| **Key pair** | Public key on the server, private key with you |
| **Security group** | AWS firewall — which ports the internet may reach |
| **Port** | Numbered door identifying a program on a machine |
| **Idempotent** | Running twice has the same effect as running once |
| **Migration** | A versioned change to the database schema |
| **Least privilege** | Grant only what is needed, nothing more |

---

## 14. Exercises

Work roughly in order; each builds on the last.

**Understand what exists**

1. Run `docker ps` on the server. Which image is each container running? Which git
   commit does that SHA correspond to?
2. Draw the request path for loading the homepage, from browser to database and back.
   Which hops cross the public internet, and which stay on the private network?
3. Explain in your own words why the backend does not need an open port.

**Read the code**

4. Open `backend/Dockerfile`. Why is `COPY pyproject.toml uv.lock` before `COPY . .`?
   What would break if they were swapped? (Nothing *breaks* — but something gets much
   slower. What, and why?)
5. Find every place `${VAR:-default}` appears in `docker-compose.yml`. For each, decide
   whether `:?` would be safer in production.
6. In `deploy.sh`, why write `.env.tmp` and then `mv` it, rather than writing `.env`
   directly?

**Make changes**

7. Add a third tag to the built images: the branch name. What would you use it for?
8. Add a step that fails the deploy if the frontend takes more than 5 seconds to
   respond.
9. Make the deploy post a message to Slack on failure. (Hint: a webhook URL is a
   secret, not a variable — why?)

**Break things on purpose** *(do this on a throwaway server, never production)*

10. Remove `condition: service_healthy` from `depends_on` and deploy. What happens, and
    what do the logs say?
11. Set `POSTGRES_PASSWORD` to something new against an existing volume. Predict the
    error before you look, then confirm it.
12. Fill the disk, then deploy. Was the failure message useful? How would you make it
    clearer?

**Go further**

13. Add a staging environment: a second server deployed from a `staging` branch.
14. Add a smoke test that runs after deploy and rolls back automatically on failure.
15. Put a reverse proxy (Caddy or nginx) in front so the site serves HTTPS on port 443
    with a real domain instead of `:3000`.

---

## Where to go next

- **Docker** — [docs.docker.com/get-started](https://docs.docker.com/get-started/)
- **Compose file reference** — [docs.docker.com/compose/compose-file](https://docs.docker.com/compose/compose-file/)
- **GitHub Actions** — [docs.github.com/actions](https://docs.github.com/en/actions)
- **The Twelve-Factor App** — [12factor.net](https://12factor.net/) — the reasoning
  behind config-in-environment, disposable processes, and dev/prod parity. Short, and
  it explains *why* the patterns in these notes are the patterns.
