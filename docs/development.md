# Development & releases

## Project layout
```
server/          hub (Node.js ESM, no build step)
  index.js       HTTP server, static files, WebSocket upgrade
  api.js         REST API + validation
  agents.js      agent connections, metrics, alerts
  actions.js     jobs, reboot policy, approvals
  scheduler.js   scheduled upgrades + periodic checks
  discord.js     Discord bot + webhook
  notify.js      activity log + UI + Discord fan-out
  ui.js          browser WebSocket + terminal relay
  db.js auth.js  SQLite schema, sessions/passwords
public/          web UI (vanilla JS, hash router)
agent/           uc-agent.py (Python 3.7+, stdlib only), install.sh, Docker launcher
deploy/          Caddyfile
docs/            guides
```
Read `CONTEXT.md` for design decisions and the project history.

## Run locally
```bash
npm install
npm start                    # http://localhost:8080
```
Test agent in a Debian container (no systemd inside, so start it by hand):
```bash
docker run -d --name uc-test --add-host=host.docker.internal:host-gateway debian:12 sleep infinity
docker exec uc-test sh -c 'apt-get update && apt-get install -y curl python3 procps'
docker exec uc-test sh -c 'curl -fsSL http://host.docker.internal:8080/install.sh | sh -s -- --hub http://host.docker.internal:8080 --token TOKEN'
docker exec -d uc-test python3 /opt/update-center/uc-agent.py run
```
Or test the Docker agent against your Docker host/VM:
```bash
docker build -t uc-agent:dev agent
docker run -d --name uc-agent --privileged --pid host -e UC_HUB=http://127.0.0.1:8080 -e UC_TOKEN=TOKEN uc-agent:dev
```

## Building images
```bash
docker build -t update-center-hub:dev .
docker build -t update-center-agent:dev agent
```
Multi-arch build and push (needs `docker buildx` and QEMU for foreign architectures):
```bash
docker run --privileged --rm tonistiigi/binfmt --install all   # once
docker buildx create --use --name uc-builder                   # once
VERSION=0.1.0
docker buildx build --platform linux/amd64,linux/arm64,linux/arm/v7 \
  -t thekingziga/update-center-hub:$VERSION -t thekingziga/update-center-hub:latest --push .
docker buildx build --platform linux/amd64,linux/arm64,linux/arm/v7 \
  -t thekingziga/update-center-agent:$VERSION -t thekingziga/update-center-agent:latest --push agent
```

## Releasing with GitHub Actions
`.github/workflows/docker.yml` builds and pushes both images for all architectures when a tag `v*` is pushed.
One-time setup in the GitHub repo → **Settings → Secrets and variables → Actions**:
- `DOCKERHUB_USERNAME` — your Docker Hub username
- `DOCKERHUB_TOKEN` — a Docker Hub access token (hub.docker.com → Account settings → Personal access tokens, *Read & Write*)

Then:
```bash
# bump "version" in package.json and VERSION in agent/uc-agent.py
git commit -am "Release 0.2.0"
git tag v0.2.0
git push && git push --tags
```

## Checks
CI (`.github/workflows/ci.yml`) runs on every push: JS syntax, Python compile, shell syntax and a Docker build.
Locally:
```bash
for f in server/*.js public/app.js; do node --check "$f"; done
python3 -m py_compile agent/uc-agent.py
sh -n agent/install.sh agent/docker-entrypoint.sh
```
