# Installing the agent on a server

Install the agent on **every server you want to manage** (VPS, Raspberry Pi, home server).
It opens one **outbound** connection to the hub — no ports to open, works behind NAT / home routers.

- [Before you start](#before-you-start)
- [Option A — install script (recommended)](#option-a--install-script-recommended)
- [Option B — Docker container](#option-b--docker-container)
- [Checking that it works](#checking-that-it-works) · [Updating](#updating-the-agent) · [Uninstalling](#uninstalling) · [Moving to a new hub](#moving-to-a-new-hub) · [Troubleshooting](#troubleshooting)

## Before you start

- The hub is running ([hub.md](hub.md)) and its `PUBLIC_URL` is reachable **from the server**.
  Test on the server: `curl -I http://YOUR-HUB:8080/install.sh` (or your https URL) → `HTTP/1.1 200`.
- You have root (`sudo`) on the server.
- In the hub UI open **Add host → Generate install command**. The token inside the command
  **works once** and **expires after 24 hours** — generate a new one for every server.

Supported systems:

| Distribution | Package manager | Notes |
|---|---|---|
| Debian 10+, Ubuntu 20.04+, Raspberry Pi OS | apt | Security-only updates need `unattended-upgrades` |
| Fedora, RHEL / Rocky / Alma 8+, CentOS Stream | dnf / yum | Reboot detection uses `needs-restarting` (dnf-utils) |
| Arch Linux, Manjaro | pacman | Uses `checkupdates` (pacman-contrib) when installed |
| openSUSE Leap / Tumbleweed | zypper | |
| Alpine | apk | No systemd: start the agent with OpenRC/your init |

The agent needs **python3** (preinstalled on Debian/Ubuntu/Raspberry Pi OS; the script installs it otherwise).

## Option A — install script (recommended)

Copy the command from **Add host** and run it on the server. It looks like this:
```bash
curl -fsSL https://hub.example.com/install.sh | sudo sh -s -- --hub https://hub.example.com --token AbCdEf...
```
What it does:
1. installs `python3` if missing,
2. downloads the agent to `/opt/update-center/uc-agent.py`,
3. enrolls the server with the one-time token and stores its own secret in `/etc/update-center/agent.json` (mode 600),
4. creates and starts the systemd service `uc-agent`.

No `curl`? Use `wget -qO- https://hub.example.com/install.sh | sudo sh -s -- --hub … --token …`.

## Option B — Docker container

For servers where you prefer Docker. The container is a small **launcher**: it enters the host's
namespaces and runs the agent *on the host* (with the host's `python3`), so updates, reboots and the
terminal act on the real server, not inside a container. That's why it needs `--privileged` and `--pid host`.

**Requirements:** Docker, `python3` on the host, systemd recommended.

**With `docker run`** (copy it from **Add host → Option B**):
```bash
docker run -d --name uc-agent --restart unless-stopped --privileged --pid host \
  -e UC_HUB=https://hub.example.com \
  -e UC_TOKEN=AbCdEf... \
  thekingziga/update-center-agent:latest
```

**With Docker Compose:**
```bash
mkdir -p ~/uc-agent && cd ~/uc-agent
curl -fsSLO https://raw.githubusercontent.com/thekingziga/update-center/main/agent/docker-compose.yml
cat > .env <<'EOF'
UC_HUB=https://hub.example.com
UC_TOKEN=AbCdEf...
EOF
docker compose up -d
docker compose logs -f
```
After the first successful start the token is used up and no longer needed (the secret lives on the host in
`/etc/update-center/agent.json`), so you can delete `UC_TOKEN` from `.env`.

Notes:
- Upgrades started from the container run as transient systemd units (`systemd-run`) on the host, so an
  upgrade that restarts Docker itself cannot kill `apt`/`dpkg` halfway through.
- Use **either** Option A **or** Option B on a server, not both. The container refuses to start if the
  `uc-agent` service from Option A is running.

## Checking that it works

- The server appears on the hub dashboard within a few seconds with a green dot.
- Option A: `systemctl status uc-agent` and `journalctl -u uc-agent -f`.
- Option B: `docker logs -f uc-agent`.

A healthy log contains `connected to https://hub.example.com`.

## Updating the agent

- **Option A:** re-run the installer **without** `--token` (keeps the enrollment):
  ```bash
  curl -fsSL https://hub.example.com/install.sh | sudo sh -s -- --hub https://hub.example.com
  ```
  (You can also run it from the hub's web terminal; the session drops for a moment while the agent restarts.)
- **Option B:** `docker pull thekingziga/update-center-agent:latest && docker rm -f uc-agent` and start it again
  without `UC_TOKEN` (Compose: `docker compose pull && docker compose up -d`).

## Uninstalling

1. In the hub: open the host → **Remove** (this revokes the agent's secret immediately).
2. On the server:
   - Option A: `curl -fsSL https://hub.example.com/install.sh | sudo sh -s -- --uninstall`
   - Option B: `docker rm -f uc-agent && sudo rm -rf /opt/update-center /etc/update-center`

## Moving to a new hub

Delete the old enrollment and enroll again with a token from the new hub:
```bash
sudo rm /etc/update-center/agent.json
curl -fsSL https://NEW-HUB/install.sh | sudo sh -s -- --hub https://NEW-HUB --token NEW-TOKEN
```

## Troubleshooting

| Symptom (in the agent log) | Fix |
|---|---|
| `enrollment failed: 403 … invalid, used or expired` | Generate a new command in **Add host** — each token works once, for 24 h. |
| `connection lost: [Errno 111] Connection refused` / timeouts | Hub URL not reachable from the server: check `PUBLIC_URL`, firewall, DNS. The agent retries automatically. |
| `CERTIFICATE_VERIFY_FAILED` | The hub's HTTPS certificate isn't trusted (self-signed?). Use Caddy/Let's Encrypt or Tailscale with http. |
| `hub rejected credentials … host removed?` | The host was removed in the UI. Re-enroll (see *Moving to a new hub*). |
| `WARNING: hub URL is not HTTPS` | Fine on a LAN/VPN; use HTTPS over the internet. |
| Docker: `run with --pid=host and --privileged` | Add both options — they are required. |
| Docker: `the host needs python3` | `sudo apt install python3` on the host. |
| Updates list stays empty on Arch | `sudo pacman -S pacman-contrib` (provides `checkupdates`). |
| "Security only" fails on Debian/Ubuntu | `sudo apt install unattended-upgrades`. |

Ubuntu and Debian may also run their own automatic `unattended-upgrades`. Keep it (daily security patches)
or disable it so only Update Center installs updates:
`sudo systemctl disable --now apt-daily-upgrade.timer`.
