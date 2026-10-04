# Security

Update Center gives **root on every connected server** to whoever is logged into the hub.
Treat the hub like the keys to all your servers.

## Checklist
- [ ] Hub only over **HTTPS** (Caddy profile) or only inside a **VPN** (Tailscale/WireGuard).
- [ ] Strong, unique admin password (≥ 10 characters, use a password manager).
- [ ] `DISCORD_ALLOWED_USERS` contains only you (and people you trust with root), channel is private.
- [ ] Back up `hub.db` and keep the backup private.
- [ ] Remove hosts you no longer manage (revokes their secret).
- [ ] Keep the hub image updated (`docker compose pull && docker compose up -d`).

## How it is protected

| Area | Mechanism |
|---|---|
| Passwords | scrypt with a random salt; constant-time comparison |
| Sessions | random 256-bit token, stored only as SHA-256; cookie `HttpOnly`, `SameSite=Strict`, `Secure` on HTTPS; 7-day lifetime |
| Brute force | 10 failed logins per IP → 15 minute lock |
| CSRF | state-changing API calls require `Content-Type: application/json` + SameSite cookies |
| WebSocket hijacking | browser socket checks that `Origin` matches the host |
| Browser hardening | strict Content-Security-Policy, `X-Frame-Options: DENY`, `nosniff`, no referrer |
| Agent enrollment | single-use token, valid 24 h, stored hashed |
| Agent identity | each agent gets its own random secret (stored hashed on the hub, mode 600 on the server) |
| Network | agents connect **out** to the hub; servers expose no ports. TLS is verified by the agent. |
| Discord | allow-list of user IDs for commands and buttons |
| Audit | every job, terminal session, approval and decision is logged with who did it |

## Known limits
- One admin account (no roles / 2FA yet — on the roadmap).
- The hub stores job output (may contain package names / command output) in its database.
- If the hub is compromised, all agents can be controlled. That is inherent to the design.

## Reporting a vulnerability
Please open a private security advisory on GitHub
(**Security → Report a vulnerability**) instead of a public issue.
