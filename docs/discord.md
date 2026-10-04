# Discord notifications and bot

Two levels — pick one or use both:

| | Webhook | Bot |
|---|---|---|
| Notifications (updates, offline, disk, reboots…) | ✅ | ✅ |
| Approve / Deny buttons for reboots | – (link to the web UI instead) | ✅ |
| Slash commands `/hosts /status /check /update /reboot /approvals` | – | ✅ |
| Setup time | 1 minute | ~5 minutes |

If the bot is configured, notifications go to the bot's channel and the webhook is ignored.

## Webhook (notifications only)

1. In Discord: **Server Settings → Integrations → Webhooks → New Webhook**.
2. Choose the channel, click **Copy Webhook URL**.
3. Add to the hub's `.env`:
   ```ini
   DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/123.../abc...
   ```
4. Restart the hub: `docker compose up -d` (Docker) or `sudo systemctl restart update-center`.

## Bot (commands + approval buttons)

### 1. Create the application
1. Open <https://discord.com/developers/applications> → **New Application** → name it *Update Center*.
2. Left menu **Bot** → **Reset Token** → copy the token (shown only once). This is `DISCORD_TOKEN`.
   Keep it secret — anyone with it controls the bot.
3. On the same page you can leave all *Privileged Gateway Intents* **off** (not needed).

### 2. Invite the bot to your server
1. Left menu **OAuth2 → URL Generator**.
2. Scopes: tick **`bot`** and **`applications.commands`**.
3. Bot permissions: **View Channels**, **Send Messages**.
4. Open the generated URL, choose your server, **Authorize**.

### 3. Collect the IDs
In Discord: **User Settings → Advanced → Developer Mode = on**. Then right-click and **Copy … ID**:
- your notification channel → `DISCORD_CHANNEL_ID`
- your server icon → `DISCORD_GUILD_ID` (makes commands appear instantly; without it global registration can take up to an hour)
- your own name → your user ID for `DISCORD_ALLOWED_USERS` (comma-separate several people)

### 4. Configure and restart the hub
```ini
DISCORD_TOKEN=MTIz...
DISCORD_CHANNEL_ID=123456789012345678
DISCORD_GUILD_ID=123456789012345678
DISCORD_ALLOWED_USERS=123456789012345678,234567890123456789
```
Restart the hub and check the log — you should see `Discord: logged in as Update Center#1234`.
```bash
docker compose logs hub | grep -i discord
```

## Using the bot

| Command | What it does |
|---|---|
| `/hosts` | All hosts: online, OS, updates (security), reboot needed, CPU/RAM/disk |
| `/status host:<name>` | Details, policy and the list of pending packages |
| `/check host:<name>` | Re-check available updates now |
| `/update host:<name> [security_only]` | Install updates now; result is posted when done |
| `/reboot host:<name>` | Posts an approval message — press **Approve reboot** to confirm |
| `/approvals` | Lists everything waiting for approval, with buttons |

Host names autocomplete while you type.

### The "ask before reboot" flow
1. In the web UI set a host's policy: *Install updates automatically* at e.g. 04:00 and
   *When an update needs a reboot* = **Ask me first**.
2. At 04:00 the hub upgrades the host and posts `✅ upgrade finished … Reboot required.`
3. Right after it posts `❓ host: reboot requested … Approve?` and **mentions** every allowed user, with
   **Approve reboot** / **Deny** buttons.
4. Press **Approve** → the host reboots → `🔄 rebooting…` → `🟢 back online after reboot (kernel …)`.
   If it doesn't come back within 10 minutes you get `🔴 has not come back`.
5. **Deny** keeps the host running; the reboot stays pending and you can approve later from the web UI
   (**Approvals**) or with `/approvals`.

### Permissions
Only users in `DISCORD_ALLOWED_USERS` can run commands or press buttons; everybody else gets
"You are not allowed to manage hosts." Still, use a **private channel** — notifications reveal host names
and package versions.

## Troubleshooting

| Problem | Fix |
|---|---|
| No `Discord: logged in` in the log | Wrong token → reset it in the developer portal and update `.env`. |
| `cannot open channel` | Wrong `DISCORD_CHANNEL_ID`, or the bot can't see that channel (channel permissions). |
| Slash commands don't appear | Set `DISCORD_GUILD_ID`; restart Discord (Ctrl+R). Check the bot was invited with `applications.commands`. |
| "You are not allowed" | Your user ID isn't in `DISCORD_ALLOWED_USERS` (IDs, not usernames). |
| Approve button says "already approved" | Someone already decided (web UI or another user). |
