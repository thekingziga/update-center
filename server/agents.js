// Agent connections: authentication, message handling, liveness and alerts.
import { db, now, getHost, setHostJson } from './db.js';
import { sha256 } from './auth.js';
import { broadcast, toTerminal, endHostTerminals } from './ui.js';
import { finishJob, appendJobOutput, failRunningJobs } from './actions.js';
import { notify } from './notify.js';

const agents = new Map();   // hostId -> ws
const history = new Map();  // hostId -> [{t, cpu, mem, load}] last hour at 10s resolution
const offlineTimers = new Map();
const OFFLINE_GRACE_MS = 2 * 60 * 1000;
const REBOOT_GRACE_MS = 10 * 60 * 1000;

export const isOnline = (id) => agents.has(id);
export const metricsHistory = (id) => history.get(id) || [];

export function sendToAgent(id, msg) {
  const ws = agents.get(id);
  if (!ws || ws.readyState !== 1) return false;
  ws.send(JSON.stringify(msg));
  return true;
}

export function disconnectAgent(id) {
  agents.get(id)?.close(4001, 'removed');
}

/** Public view of a host for the UI/Discord. */
export const publicHost = (h) => h && ({ ...h, online: isOnline(h.id) });

/** Validates "Authorization: Bearer <hostId>:<secret>"; returns hostId or null. */
export function authenticateAgent(req) {
  const m = /^Bearer ([\w-]+):(\S+)$/.exec(req.headers.authorization || '');
  if (!m) return null;
  const row = db.prepare('SELECT token_hash FROM hosts WHERE id = ?').get(m[1]);
  return row && row.token_hash === sha256(m[2]) ? m[1] : null;
}

export function handleAgentConnection(ws, hostId) {
  agents.get(hostId)?.terminate(); // a newer connection replaces an old one
  agents.set(hostId, ws);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    try { onMessage(hostId, m); } catch (e) { console.error(`agent ${hostId}:`, e); }
  });
  ws.on('close', () => {
    if (agents.get(hostId) !== ws) return;
    agents.delete(hostId);
    onDisconnect(hostId);
  });
}

function touch(id) {
  db.prepare('UPDATE hosts SET last_seen = ? WHERE id = ?').run(now(), id);
}

function onMessage(id, m) {
  touch(id);
  switch (m.type) {
    case 'hello': return onHello(id, m);
    case 'metrics': return onMetrics(id, m.metrics || {});
    case 'inventory': return onInventory(id, m.inventory || {});
    case 'job_output': return appendJobOutput(id, m.job_id, String(m.data ?? ''));
    case 'job_done': return finishJob(id, m);
    case 'term_output': case 'term_exit': return toTerminal(id, m);
  }
}

function onHello(id, m) {
  const host = getHost(id);
  setHostJson(id, 'info', { ...(m.info || {}), agent_version: m.agent_version });
  const state = { ...host.state };
  clearTimeout(offlineTimers.get(id));
  offlineTimers.delete(id);
  if (state.rebooting) notify(`🟢 **${host.name}** is back online after reboot (kernel ${m.info?.kernel || '?'}).`, { hostId: id });
  else if (state.offline_alerted) notify(`🟢 **${host.name}** is back online.`, { hostId: id });
  delete state.rebooting;
  delete state.offline_alerted;
  setHostJson(id, 'state', state);
  failRunningJobs(id, 'agent restarted');
  // Agent refreshes its update list on connect; hub only asks again when stale (scheduler).
  broadcast({ type: 'host_update', host: publicHost(getHost(id)) });
}

function onMetrics(id, metrics) {
  metrics.at = now();
  setHostJson(id, 'metrics', metrics);
  const h = history.get(id) || [];
  h.push({ t: metrics.at, cpu: metrics.cpu_pct, mem: metrics.mem_pct, load: metrics.load?.[0] });
  if (h.length > 360) h.shift();
  history.set(id, h);
  broadcast({ type: 'host_metrics', id, metrics });
  checkDisk(id, metrics);
}

function checkDisk(id, metrics) {
  const host = getHost(id);
  const limit = host.policy.alert_disk_pct;
  if (!limit) return;
  const worst = Math.max(0, ...(metrics.disks || []).map((d) => d.pct));
  const state = host.state;
  if (worst >= limit && !state.disk_alerted) {
    const disk = metrics.disks.find((d) => d.pct === worst);
    notify(`💾 **${host.name}**: disk \`${disk.mount}\` is ${worst}% full.`, { hostId: id, level: 'warn' });
    setHostJson(id, 'state', { ...state, disk_alerted: true });
  } else if (worst < limit - 5 && state.disk_alerted) {
    setHostJson(id, 'state', { ...state, disk_alerted: false });
  }
}

function onInventory(id, inv) {
  const host = getHost(id);
  const prev = host.inventory.updates?.length || 0;
  inv.checked_at = now();
  setHostJson(id, 'inventory', inv);
  const n = inv.updates?.length || 0;
  if (n > prev) {
    const sec = inv.updates.filter((u) => u.security).length;
    notify(`📦 **${host.name}**: ${n} update(s) available${sec ? ` (${sec} security)` : ''}.`, { hostId: id });
  }
  broadcast({ type: 'host_update', host: publicHost(getHost(id)) });
}

function onDisconnect(id) {
  endHostTerminals(id);
  failRunningJobs(id, 'agent disconnected');
  const host = getHost(id);
  if (!host) return;
  broadcast({ type: 'host_update', host: publicHost(host) });
  const rebooting = host.state.rebooting;
  if (!rebooting && !host.policy.alert_offline) return;
  offlineTimers.set(id, setTimeout(() => {
    offlineTimers.delete(id);
    const h = getHost(id);
    if (!h || isOnline(id)) return;
    setHostJson(id, 'state', { ...h.state, offline_alerted: true });
    notify(rebooting
      ? `🔴 **${h.name}** has not come back 10 minutes after reboot!`
      : `🔴 **${h.name}** is offline (no connection for 2 minutes).`, { hostId: id, level: 'error' });
  }, rebooting ? REBOOT_GRACE_MS : OFFLINE_GRACE_MS));
}

// Drop agents that stopped answering pings (half-open TCP).
setInterval(() => {
  for (const ws of agents.values()) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000).unref();

