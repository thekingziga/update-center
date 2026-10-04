# Installing the hub

The hub is the website + API + Discord bot. Run **one** hub; every server's agent connects to it.
Choose any machine that is always on: a small VPS, a home server, or even a Raspberry Pi 4.

- [Option 1 — Docker Compose (recommended)](#option-1--docker-compose-recommended)
- [Option 2 — Docker Compose with automatic HTTPS (Caddy)](#option-2--docker-compose-with-automatic-https-caddy)
- [Option 3 — plain `docker run`](#option-3--plain-docker-run)
- [Option 4 — without Docker (Node.js + systemd)](#option-4--without-docker-nodejs--systemd)
- [First login](#first-login) · [Configuration](#configuration-reference) · [Updating](#updating-the-hub) · [Backup & restore](#backup--restore) · [Troubleshooting](#troubleshooting)

Images are multi-arch (`linux/amd64`, `linux/arm64`, `linux/arm/v7`), so the same commands work on a VPS and on a Raspberry Pi.

---

## Option 1 — Docker Compose (recommended)

**Requirements:** Docker Engine with the Compose plugin (`docker compose version` must work).
Install Docker on Debian/Ubuntu/Raspberry Pi OS:
```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER   # log out and back in afterwards
```

**1. Get the files**
```bash
mkdir -p ~/update-center && cd ~/update-center
curl -fsSLO https://raw.githubusercontent.com/thekingziga/update-center/main/docker-compose.yml
curl -fsSL  https://raw.githubusercontent.com/thekingziga/update-center/main/.env.example -o .env
mkdir -p deploy && curl -fsSL https://raw.githubusercontent.com/thekingziga/update-center/main/deploy/Caddyfile -o deploy/Caddyfile
```
(Or simply `git clone https://github.com/thekingziga/update-center.git && cd update-center && cp .env.example .env`.)

**2. Edit `.env`** — at minimum set the URL under which servers will reach the hub:
```ini
PUBLIC_URL=http://192.168.1.10:8080     # LAN example
TZ=Europe/Ljubljana                      # time zone used for update schedules
```

**3. Start**
```bash
docker compose up -d
docker compose logs -f hub     # Ctrl+C to stop following
```
Open `http://<server-ip>:8080` and continue with [First login](#first-login).

> Plain HTTP is fine inside a home LAN or over a VPN (Tailscale/WireGuard).
> If the hub is reachable from the internet, **use Option 2** — the web terminal gives root on all servers.

---

## Option 2 — Docker Compose with automatic HTTPS (Caddy)

**Requirements:** a domain name (e.g. `hub.example.com`) whose DNS **A/AAAA record points to this server**,
and ports **80 and 443** open in the firewall / cloud security group.

1. Do steps 1–2 from Option 1.
2. In `.env` set:
   ```ini
   DOMAIN=hub.example.com
   PUBLIC_URL=https://hub.example.com
   TRUST_PROXY=1
   HUB_BIND=127.0.0.1:8080     # hub only reachable through Caddy
   TZ=Europe/Ljubljana
   ```
3. Start with the `https` profile:
   ```bash
   docker compose --profile https up -d
   ```
4. Open `https://hub.example.com`. Caddy gets and renews a Let's Encrypt certificate automatically
   (check `docker compose logs caddy` if it doesn't work — usually DNS or a closed port 80).

From now on always use `docker compose --profile https …` (or put `COMPOSE_PROFILES=https` into `.env`).

**Alternative: Tailscale (no public ports at all).** Install Tailscale on the hub and on every server,
set `PUBLIC_URL=http://<hub-tailscale-name>:8080`, and keep the hub off the internet. Tailscale encrypts traffic.

---

## Option 3 — plain `docker run`

```bash
docker volume create update-center-data
docker run -d --name update-center --restart unless-stopped \
  -p 8080:8080 \
  -v update-center-data:/data \
  -e PUBLIC_URL=http://192.168.1.10:8080 \
  -e TZ=Europe/Ljubljana \
  thekingziga/update-center-hub:latest
```
Add more `-e NAME=value` options for Discord (see [discord.md](discord.md)), or use `--env-file .env`.

---

## Option 4 — without Docker (Node.js + systemd)

**Requirements:** Node.js **22.13 or newer** (`node -v`).
```bash
# Node.js 24 on Debian/Ubuntu/Raspberry Pi OS (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs git

sudo useradd --system --create-home --home-dir /opt/update-center-hub updatecenter
sudo -u updatecenter git clone https://github.com/thekingziga/update-center.git /opt/update-center-hub/app
cd /opt/update-center-hub/app
sudo -u updatecenter npm ci --omit=dev
sudo -u updatecenter cp .env.example .env    # then edit .env
```
Create `/etc/systemd/system/update-center.service`:
```ini
[Unit]
Description=Update Center hub
After=network-online.target
Wants=network-online.target

[Service]
User=updatecenter
WorkingDirectory=/opt/update-center-hub/app
ExecStart=/usr/bin/node --env-file-if-exists=.env server/index.js
Restart=always

[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now update-center
journalctl -u update-center -f
```
For HTTPS without Docker install Caddy (`sudo apt install caddy`) and use this `/etc/caddy/Caddyfile`:
```
hub.example.com {
    reverse_proxy 127.0.0.1:8080
}
```
then set `HOST=127.0.0.1`, `PUBLIC_URL=https://hub.example.com`, `TRUST_PROXY=1` and `sudo systemctl reload caddy`.

---

## First login

1. Open the hub in a browser. The first visit shows **Create admin account** — choose a username and a
   password of **at least 10 characters**. This account controls every server as root; use a password manager.
2. Go to **Add host** and follow [agent.md](agent.md) for each server.
3. Optional: set up Discord with [discord.md](discord.md).

## Configuration reference

All settings are environment variables (in `.env` for Compose / Node, or `-e` for `docker run`).

| Variable | Default | Description |
|---|---|---|
| `PUBLIC_URL` | taken from the browser request | URL agents use to reach the hub; appears in the install commands. **Set it.** |
| `PORT` | `8080` | Port inside the container / process |
| `HOST` | `0.0.0.0` | Listen address (Node install: `127.0.0.1` behind Caddy) |
| `TRUST_PROXY` | off | `1` when behind Caddy/nginx — trusts `X-Forwarded-For/Proto` |
| `TZ` | UTC in Docker | Time zone for auto-update schedules, e.g. `Europe/Ljubljana` |
| `DB_PATH` | `/data/hub.db` (Docker) | SQLite database file |
| `AGENT_IMAGE` | `thekingziga/update-center-agent:latest` | Image used in the "Docker" install command |
| `DISCORD_WEBHOOK_URL` | – | Notifications via webhook ([discord.md](discord.md)) |
| `DISCORD_TOKEN`, `DISCORD_CHANNEL_ID`, `DISCORD_GUILD_ID`, `DISCORD_ALLOWED_USERS` | – | Discord bot ([discord.md](discord.md)) |
| `HUB_BIND` *(Compose only)* | `8080` | Published port, e.g. `127.0.0.1:8080` |
| `DOMAIN` *(Compose only)* | – | Domain for the Caddy `https` profile |
| `UC_VERSION` *(Compose only)* | `latest` | Image tag, e.g. `0.1.0` to pin a version |

After changing `.env`: `docker compose up -d` (Compose recreates the container) or `sudo systemctl restart update-center`.

## Updating the hub

```bash
cd ~/update-center
docker compose pull
docker compose up -d
docker image prune -f
```
Node install: `cd /opt/update-center-hub/app && sudo -u updatecenter git pull && sudo -u updatecenter npm ci --omit=dev && sudo systemctl restart update-center`.

Agents keep running during a hub update and reconnect automatically.

## Backup & restore

Everything (users, hosts, agent secrets, policies, job history) is in one SQLite file.
```bash
# Backup (Compose) — consistent copy while running
docker compose exec hub node -e "new (require('node:sqlite').DatabaseSync)('/data/hub.db').exec(\"VACUUM INTO '/data/backup.db'\")"
docker compose cp hub:/data/backup.db ./hub-backup-$(date +%F).db

# Restore
docker compose down
docker run --rm -v update-center_hub-data:/data -v "$PWD":/b alpine cp /b/hub-backup-YYYY-MM-DD.db /data/hub.db
docker compose up -d
```
(The volume name is `<folder>_hub-data`; see `docker volume ls`.)
Keep backups private — they contain password hashes and agent secret hashes.

## Troubleshooting

| Problem | Fix |
|---|---|
| Page doesn't load | `docker compose ps` / `docker compose logs hub`; check the firewall (`sudo ufw allow 8080/tcp`). |
| Forgot the admin password | Stop the hub, then `docker compose run --rm hub node -e "const d=new (require('node:sqlite').DatabaseSync)('/data/hub.db');d.exec('DELETE FROM sessions; DELETE FROM users')"` and start again — you'll get the *Create admin account* screen. Hosts are kept. |
| "too many attempts" on login | 10 failed logins per IP lock that IP for 15 minutes. Wait. |
| Install command shows `localhost` | Set `PUBLIC_URL` in `.env` and recreate the container. |
| Schedules run at the wrong hour | Set `TZ` (Docker defaults to UTC). |
| Caddy has no certificate | DNS must point to this server and ports 80/443 must be reachable from the internet. |
