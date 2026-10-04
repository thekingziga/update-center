# Project Context — Update Center (Linux fleet manager)

> **For any AI agent / new chat:** read this file first, then `AGENTS.md`.
> Keep it updated: append to the **Conversation log** at the end of every session
> (what user asked, what was decided, what was built, what is next).
> Raw chat transcripts are auto-copied to `.context/transcripts/` (Claude Code Stop hook).

## Owner
- Ziga (GitHub: thekingziga). Runs several Ubuntu/Debian VPS + Raspberry Pi 4.
- Wants **all context and conversations saved to files** so any agent/chat can continue.

## Goal (user's words, condensed)
A self-hosted website + agent to manage any Linux distro:
- Install an agent on every VPS / RPi; it connects to the website → full control.
- SSH-like web terminal (run `bashtop`/`htop` etc.), updates, reboots, system info.
- Auto updates, auto reboot, per-host policies.
- Discord notifications **and** a Discord bot to manage hosts.
  Example: auto-update runs, policy is "ask before reboot" → bot asks in Discord
  with Approve/Deny buttons.
- "And much more" — add useful extras (alerts, docker, failed services…).

## Architecture (decided)
```
 Browser ──HTTPS/WSS──┐
 Discord bot ─────────┤  HUB  (Node.js, server/)  ── SQLite (data/hub.db)
                      │
 Agents ──outbound WSS┘  (Python 3 stdlib only, agent/uc-agent.py, runs as root via systemd)
```
- **Agents connect outbound** → works behind NAT (RPi at home), no open ports on servers.
- **Hub**: Node ≥22 (uses built-in `node:sqlite`, `node:crypto`). Deps: `ws`, `discord.js`, `@xterm/*`.
  No build step; vanilla JS frontend in `public/`.
- **Agent**: single Python 3 file, zero deps (own minimal WebSocket client), because python3
  is present on every Debian/Ubuntu/RPi OS. Uses `pty` for the terminal.
- Package managers supported: apt (primary), dnf/yum, pacman, zypper, apk.
- Hub owns schedules/policies (single source of truth). Agent only executes.
- TLS: put hub behind Caddy (auto HTTPS) — see README.

## Security model (important — agent = root on every server)
- Web login: username + scrypt password, session cookie HttpOnly + SameSite=Strict, login rate limit.
- Browser WS checks Origin. Mutating API requires JSON content-type (CSRF defense with SameSite).
- Agent enrollment: single-use enrollment token (24h). Agent then gets its own random secret;
  hub stores only SHA-256 hashes of all tokens.
- Discord: only user IDs in `DISCORD_ALLOWED_USERS` may run commands/press buttons.
- Hub compromise = root on all hosts → keep hub private (Tailscale/VPN or strong password + HTTPS).

## Reboot policy logic
After any upgrade job finishes and reboot is required:
- `auto` → reboot immediately · `ask` → approval (Discord buttons + web banner) · `never` → just notify.

## Status / Roadmap
See README "Roadmap". Done = MVP (see log). Next ideas: TOTP 2FA, multi-user/roles,
per-host maintenance windows for reboots, Prometheus export, file manager, backups,
Discord `/run` (gated), agent self-update.

---
## Conversation log
### 2026-10-04 — Session 1
- User asked: save all context to files for reuse by any agent; build website + agent
  for managing Linux servers (terminal, updates, reboots, auto-update/reboot, Discord
  notifications + bot with ask-before-reboot), "and much more".
- Decisions: Node hub + Python stdlib agent, outbound WS, SQLite, Discord via discord.js,
  context kept in CONTEXT.md + AGENTS.md + auto transcript copy hook.
- Built MVP (v0.1.0): hub (`server/*.js`), web UI (`public/`), agent + installer (`agent/`),
  README with Caddy/Discord/systemd setup, `.env.example`.
- Context saving: `CONTEXT.md` (this), `AGENTS.md`, `CLAUDE.md` (imports both),
  `.claude/settings.json` Stop hook → `scripts/save-transcript.py` writes
  `.context/transcripts/<session>.md` (readable) + `.jsonl` (raw, gitignored).
  Memory notes also saved in Claude's memory dir.
- Tested (macOS hub + Debian 12 container agent via colima): setup/login/rate-limit, CSRF (JSON-only),
  WS Origin check, single-use enrollment, install.sh, metrics, apt update list w/ security flags,
  upgrade job streaming, upgrade→reboot-required→`ask` approval→approve (double-approve rejected),
  scheduled auto-update→`auto` reboot, web terminal (real root shell, resize), exec jobs + exit codes,
  offline alert. Not tested live: Discord bot (needs user's token), real reboot (containers can't),
  dnf/pacman/zypper/apk parsers (written, untested).
- Fixed during testing: hosts not loading right after login; hidden badge showing "0".
- Next steps for user: deploy hub (VPS or home box) behind Caddy/Tailscale, create Discord bot,
  install agents. Then roadmap items (TOTP first).

### 2026-10-04 — Session 2
- User asked: Docker images pushed to Docker Hub, docker compose, full guides for each part,
  publish everything to GitHub as a new nice repo. Decisions (asked): public repo, English-only
  docs, name `update-center` → github.com/thekingziga/update-center, images
  `thekingziga/update-center-hub` + `thekingziga/update-center-agent` (multi-arch amd64/arm64/armv7).
- Hub image: `Dockerfile` (node:22-alpine for armv7 support, non-root, /data volume, healthcheck). `docker-compose.yml`
  with optional `https` profile (Caddy, `deploy/Caddyfile`, DOMAIN in .env).
- Agent image = privileged launcher (`agent/Dockerfile`, `agent/docker-entrypoint.sh`): needs
  `--privileged --pid host`, writes agent to host via nsenter and runs it in host namespaces with
  host python3; refuses if native `uc-agent` service is active. Sets `UC_DETACH_JOBS=1` → agent runs
  upgrade commands through `systemd-run --pipe --wait` so a Docker restart can't kill dpkg.
  `agent/docker-compose.yml` for compose usage. "Add host" UI shows script + docker command
  (`AGENT_IMAGE` env).
- Docs: `docs/hub.md`, `agent.md`, `discord.md`, `usage.md`, `security.md`, `development.md`;
  README rewritten with screenshots (`docs/img`, taken with headless Chrome via CDP).
- GitHub extras: MIT LICENSE (my default choice), CI workflow (syntax/compile/build), release
  workflow `docker.yml` (on `v*` tag; needs repo secrets DOCKERHUB_USERNAME/DOCKERHUB_TOKEN), issue template.
- Privacy: owner email removed from this file; `.context/transcripts/` gitignored (kept local only).
- Tested: hub image via compose (healthy, TZ works), agent container on colima VM (enrolled, real host
  info/disks, terminal, systemd-run wrapper output+exit code).
- Tooling installed on the Mac via brew: docker-buildx, docker-compose (colima has no Docker Desktop).
