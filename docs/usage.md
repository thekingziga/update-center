# Using Update Center

## Dashboard (Hosts)
One card per server: online dot, uptime, OS, CPU / RAM / disk bars, Raspberry Pi temperature and badges:
`N updates · M security`, `reboot required`, `approval pending`, `failed unit(s)`, `auto 04:00`.

- **Check all** — every online host re-checks its available updates.
- **Update all** — installs updates on every online host that has some (asks for confirmation first).

Click a card to open the host.

## Host page

Buttons at the top:

| Button | What happens |
|---|---|
| **Check updates** | Refreshes the package list (`apt-get update` + simulation; dnf/pacman/zypper/apk equivalents) |
| **Update now** | Full upgrade (apt: `apt-get --with-new-pkgs upgrade` + `autoremove`), output streams live in **Jobs** |
| **Security only** | Only security updates (apt via `unattended-upgrade`, dnf `--security`, zypper security patches) |
| **Reboot** | Reboots after a confirmation; you're notified when it's back (or if it isn't after 10 min) |
| **Remove** | Deletes the host from the hub and revokes its agent secret |
| ✎ | Rename the host |

Tabs:
- **Overview** — system info (OS, kernel, CPU, memory, IPs, virtualization), live CPU/RAM charts (last hour),
  load/swap/network/temperature, disks, top processes, failed systemd units, Docker containers.
- **Updates** — every pending package with installed → available version; security updates are marked.
  Shows which packages require a reboot.
- **Terminal** — a full root shell in the browser. Everything works: `htop`, `bashtop`/`btop`, `nano`, `vim`,
  `journalctl -f`, `docker ps`… Closing the tab or leaving the page ends the session. **New session** starts a fresh one.
  (Install `bashtop` with `sudo apt install bashtop` or `btop`.)
- **Jobs** — history of upgrades, reboots and commands with full output. The **Run** box executes any shell
  command as root (`sh -c`, 1 hour timeout) and streams the output.
- **Policy** — automation for this host (below).
- **Activity** — everything that happened to this host.

## Policies (automation)

| Setting | Meaning |
|---|---|
| Install updates automatically | Run an upgrade on the selected **days** at the selected **time** (hub time zone, `TZ`). If the hub was down at that moment it still runs within the next 60 minutes. |
| Security updates only | Scheduled runs install only security updates. |
| When an update needs a reboot | **Ask me first** → approval in Discord + web; **Reboot automatically**; **Never** → only a notification. Applies to every upgrade (manual or scheduled). |
| Check for new updates every N hours | How often the hub asks the agent to refresh the package list (default 6). |
| Notify when the host goes offline | Alert after 2 minutes without connection, and again when it's back. |
| Disk usage alert at % | Alert once when any disk reaches this level (0 = off); re-arms when it drops 5 % below. |

Suggested setups:
- **Raspberry Pi at home:** daily 04:00, all updates, reboot = *Ask me first*.
- **Production VPS:** daily 03:30, security only, reboot = *Ask me first*; run full updates manually.
- **Test box:** daily, all updates, reboot = *Reboot automatically*.

## Approvals
The **Approvals** page (badge in the menu) lists pending requests with **Approve / Deny** and a history of decisions.
The same requests appear as a banner on the host page and as buttons in Discord — whoever answers first wins.

## Activity
Global log of everything: updates found, jobs started/finished (and by whom: `web:admin`, `discord:ziga`,
`schedule`, `policy`, `approval:…`), terminals opened, offline/online, disk alerts.

## Settings
Change your password (signs out all sessions) and sign out.
