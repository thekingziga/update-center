// Discord integration: notifications (bot channel or webhook) and a slash-command bot.
import {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags,
} from 'discord.js';
import { listHosts, findHostByName } from './db.js';
import { publicHost } from './agents.js';
import { startJob, refreshHost, requestApproval, decideApproval, pendingApprovals } from './actions.js';

const { DISCORD_TOKEN, DISCORD_CHANNEL_ID, DISCORD_GUILD_ID, DISCORD_WEBHOOK_URL, PUBLIC_URL } = process.env;
const allowed = new Set((process.env.DISCORD_ALLOWED_USERS || '').split(',').map((s) => s.trim()).filter(Boolean));
let client = null;
let channel = null;

const approvalButtons = (a) => [new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(`approval:${a.id}:yes`).setLabel(`Approve ${a.kind}`).setStyle(ButtonStyle.Success),
  new ButtonBuilder().setCustomId(`approval:${a.id}:no`).setLabel('Deny').setStyle(ButtonStyle.Danger),
)];

export async function sendDiscord(text, approval = null) {
  if (channel) {
    const mention = approval ? [...allowed].map((id) => `<@${id}> `).join('') : '';
    await channel.send({ content: (mention + text).slice(0, 2000), components: approval ? approvalButtons(approval) : [] });
  } else if (DISCORD_WEBHOOK_URL) {
    const extra = approval && PUBLIC_URL ? `\nApprove in the dashboard: ${PUBLIC_URL}/#/approvals` : '';
    const r = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: (text + extra).slice(0, 2000), allowed_mentions: { parse: [] } }),
    });
    if (!r.ok) throw new Error(`webhook HTTP ${r.status}`);
  }
}

export function hostLine(h) {
  const inv = h.inventory || {};
  const n = inv.updates?.length ?? '?';
  const sec = inv.updates?.filter((u) => u.security).length || 0;
  const m = h.metrics || {};
  const disk = Math.max(0, ...(m.disks || []).map((d) => d.pct));
  return `${h.online ? '🟢' : '🔴'} **${h.name}** — ${h.info.os || '?'} · ${n} updates${sec ? ` (${sec} sec)` : ''}`
    + `${inv.reboot_required ? ' · ⚠️ reboot needed' : ''}`
    + (h.online ? ` · cpu ${m.cpu_pct ?? '?'}% · mem ${m.mem_pct ?? '?'}% · disk ${disk}%` : '');
}

const hostOpt = (o) => o.setName('host').setDescription('Host name').setRequired(true).setAutocomplete(true);
const commands = [
  new SlashCommandBuilder().setName('hosts').setDescription('List all managed hosts'),
  new SlashCommandBuilder().setName('status').setDescription('Show host details').addStringOption(hostOpt),
  new SlashCommandBuilder().setName('check').setDescription('Re-check available updates').addStringOption(hostOpt),
  new SlashCommandBuilder().setName('update').setDescription('Install updates now').addStringOption(hostOpt)
    .addBooleanOption((o) => o.setName('security_only').setDescription('Only security updates')),
  new SlashCommandBuilder().setName('reboot').setDescription('Reboot a host (asks for confirmation)').addStringOption(hostOpt),
  new SlashCommandBuilder().setName('approvals').setDescription('Show pending approvals'),
];

async function onCommand(i) {
  const by = `discord:${i.user.username}`;
  const reply = (content, extra = {}) => i.reply({ content: content.slice(0, 2000), ...extra });
  if (i.commandName === 'hosts') {
    const hosts = listHosts().map(publicHost);
    return reply(hosts.length ? hosts.map(hostLine).join('\n') : 'No hosts yet.');
  }
  if (i.commandName === 'approvals') {
    const list = pendingApprovals();
    if (!list.length) return reply('No pending approvals.');
    return reply(`Pending: ${list.length}`).then(() => Promise.all(list.map((a) => i.followUp({
      content: `❓ **${a.host_name}**: ${a.kind} — ${a.reason}`, components: approvalButtons(a) }))));
  }
  const host = publicHost(findHostByName(i.options.getString('host')));
  if (!host) return reply('Unknown host.', { flags: MessageFlags.Ephemeral });
  if (i.commandName === 'status') {
    const inv = host.inventory;
    const pkgs = (inv.updates || []).slice(0, 25).map((u) => `${u.security ? '🔒' : '•'} ${u.name} ${u.version || ''}`).join('\n');
    return reply(`${hostLine(host)}\nKernel ${host.info.kernel || '?'} · uptime ${Math.round((host.metrics.uptime || 0) / 3600)}h`
      + `\nPolicy: auto-update ${host.policy.auto_update ? `at ${host.policy.time}` : 'off'}, reboot: ${host.policy.reboot}`
      + (pkgs ? `\n\`\`\`\n${pkgs}\n\`\`\`` : ''));
  }
  if (i.commandName === 'check') { refreshHost(host.id); return reply(`🔍 Checking updates on **${host.name}**…`); }
  if (i.commandName === 'update') {
    const job = startJob(host.id, 'upgrade', { security_only: !!i.options.getBoolean('security_only') }, by);
    return reply(`Started upgrade job #${job.id} on **${host.name}**. I'll report back here.`);
  }
  if (i.commandName === 'reboot') {
    requestApproval(host.id, 'reboot', `requested by ${i.user.username} via Discord`);
    return reply(`Reboot of **${host.name}** needs confirmation — use the buttons on the approval message.`,
      { flags: MessageFlags.Ephemeral });
  }
}

async function onButton(i) {
  const [, id, answer] = i.customId.split(':');
  const a = decideApproval(Number(id), answer === 'yes', `discord:${i.user.username}`);
  await i.update({ content: `${i.message.content}\n${a.status === 'approved' ? '✅ Approved' : '🚫 Denied'} by ${i.user.username}`, components: [] });
}

export async function startDiscordBot() {
  if (!DISCORD_TOKEN) {
    console.log(DISCORD_WEBHOOK_URL ? 'Discord: webhook notifications only' : 'Discord: disabled');
    return;
  }
  if (!allowed.size) console.warn('Discord: DISCORD_ALLOWED_USERS is empty — nobody can run bot commands');
  client = new Client({ intents: [GatewayIntentBits.Guilds] });
  client.once('clientReady', async (c) => {
    console.log(`Discord: logged in as ${c.user.tag}`);
    const rest = new REST().setToken(DISCORD_TOKEN);
    const body = commands.map((cmd) => cmd.toJSON());
    await rest.put(DISCORD_GUILD_ID ? Routes.applicationGuildCommands(c.user.id, DISCORD_GUILD_ID)
      : Routes.applicationCommands(c.user.id), { body });
    if (DISCORD_CHANNEL_ID) channel = await c.channels.fetch(DISCORD_CHANNEL_ID).catch((e) => {
      console.error('Discord: cannot open channel', DISCORD_CHANNEL_ID, e.message); return null;
    });
  });
  client.on('interactionCreate', async (i) => {
    try {
      if (i.isAutocomplete()) {
        const q = String(i.options.getFocused()).toLowerCase();
        return await i.respond(listHosts().filter((h) => h.name.toLowerCase().includes(q)).slice(0, 25)
          .map((h) => ({ name: h.name, value: h.name })));
      }
      if (!allowed.has(i.user.id)) {
        if (i.isRepliable()) await i.reply({ content: 'You are not allowed to manage hosts.', flags: MessageFlags.Ephemeral });
        return;
      }
      if (i.isChatInputCommand()) await onCommand(i);
      else if (i.isButton() && i.customId.startsWith('approval:')) await onButton(i);
    } catch (e) {
      if (i.isRepliable() && !i.replied) await i.reply({ content: `⚠️ ${e.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  });
  await client.login(DISCORD_TOKEN);
}
