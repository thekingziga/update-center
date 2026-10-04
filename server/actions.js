// Domain actions: jobs (upgrade / reboot / exec), reboot policy, approvals.
import { db, now, getHost, setHostJson, jobRow } from './db.js';
import { sendToAgent, isOnline } from './agents.js';
import { broadcast } from './ui.js';
import { notify } from './notify.js';

export const JOB_KINDS = ['upgrade', 'reboot', 'exec'];
const MAX_OUTPUT = 512 * 1024;

/**
 * Starts a job on a host. `source` is who asked: 'web:<user>', 'discord:<user>', 'schedule', 'policy', 'approval'.
 * Throws Error with a user-facing message if the job cannot start.
 */
export function startJob(hostId, kind, params, source) {
  const host = getHost(hostId);
  if (!host) throw new Error('unknown host');
  if (!JOB_KINDS.includes(kind)) throw new Error('unknown job kind');
  if (kind === 'exec' && (typeof params.command !== 'string' || !params.command.trim())) throw new Error('command required');
  if (!isOnline(hostId)) throw new Error(`${host.name} is offline`);
  const busy = db.prepare(`SELECT id FROM jobs WHERE host_id = ? AND status = 'running' AND kind IN ('upgrade','reboot')`).get(hostId);
  if (kind !== 'exec' && busy) throw new Error(`${host.name} already has a running upgrade/reboot job (#${busy.id})`);

  const clean = kind === 'upgrade' ? { security_only: !!params.security_only }
    : kind === 'exec' ? { command: params.command } : {};
  const info = db.prepare(`INSERT INTO jobs (host_id, kind, params, source, status, created_at)
    VALUES (?, ?, ?, ?, 'running', ?)`).run(hostId, kind, JSON.stringify(clean), source, now());
  const job = jobRow(db.prepare('SELECT * FROM jobs WHERE id = ?').get(info.lastInsertRowid));
  if (kind === 'reboot') setHostJson(hostId, 'state', { ...host.state, rebooting: true });
  sendToAgent(hostId, { type: 'job', job_id: job.id, kind, params: clean });
  broadcast({ type: 'job_update', job });
  const what = kind === 'exec' ? `\`${clean.command.slice(0, 80)}\`` : kind + (clean.security_only ? ' (security only)' : '');
  notify(`▶️ **${host.name}**: ${what} started by ${source}.`, { hostId, quiet: kind === 'exec' });
  return job;
}

export function appendJobOutput(hostId, jobId, data) {
  const r = db.prepare(`UPDATE jobs SET output = substr(output || ?, -${MAX_OUTPUT})
    WHERE id = ? AND host_id = ? AND status = 'running'`).run(data, jobId, hostId);
  if (r.changes) broadcast({ type: 'job_output', job_id: jobId, data });
}

export function finishJob(hostId, m) {
  const row = db.prepare(`SELECT * FROM jobs WHERE id = ? AND host_id = ? AND status = 'running'`).get(m.job_id, hostId);
  if (!row) return;
  const ok = m.exit_code === 0;
  db.prepare('UPDATE jobs SET status = ?, exit_code = ?, result = ?, finished_at = ? WHERE id = ?')
    .run(ok ? 'success' : 'failed', m.exit_code ?? null, JSON.stringify(m.result || {}), now(), row.id);
  const job = jobRow(db.prepare('SELECT * FROM jobs WHERE id = ?').get(row.id));
  broadcast({ type: 'job_update', job });
  const host = getHost(hostId);

  if (job.kind === 'reboot') {
    if (!ok) {
      setHostJson(hostId, 'state', { ...host.state, rebooting: false });
      notify(`❌ **${host.name}**: reboot failed (exit ${m.exit_code}).`, { hostId, level: 'error' });
    } else notify(`🔄 **${host.name}** is rebooting…`, { hostId });
    return;
  }
  if (job.kind === 'exec') return;

  // upgrade
  if (!ok) {
    notify(`❌ **${host.name}**: upgrade failed (exit ${m.exit_code}). See job #${job.id}.`, { hostId, level: 'error' });
    return;
  }
  const n = job.result.upgraded ?? '?';
  notify(`✅ **${host.name}**: upgrade finished (${n} package(s)).${job.result.reboot_required ? ' Reboot required.' : ''}`, { hostId });
  if (job.result.reboot_required) applyRebootPolicy(host, job);
}

function applyRebootPolicy(host, job) {
  const mode = host.policy.reboot;
  if (mode === 'auto') {
    try { startJob(host.id, 'reboot', {}, 'policy'); } catch (e) { notify(`⚠️ **${host.name}**: auto reboot failed: ${e.message}`, { hostId: host.id, level: 'warn' }); }
  } else if (mode === 'ask') {
    requestApproval(host.id, 'reboot', `Upgrade job #${job.id} requires a reboot`);
  } else {
    notify(`ℹ️ **${host.name}** needs a reboot (policy: never auto-reboot).`, { hostId: host.id });
  }
}

/** Marks running jobs as failed when the agent goes away (a reboot job counts as success). */
export function failRunningJobs(hostId, reason) {
  const rows = db.prepare(`SELECT id, kind FROM jobs WHERE host_id = ? AND status = 'running'`).all(hostId);
  for (const r of rows) {
    const success = r.kind === 'reboot';
    db.prepare(`UPDATE jobs SET status = ?, output = output || ?, finished_at = ? WHERE id = ?`)
      .run(success ? 'success' : 'failed', `\n[${reason}]\n`, now(), r.id);
    broadcast({ type: 'job_update', job: jobRow(db.prepare('SELECT * FROM jobs WHERE id = ?').get(r.id)) });
  }
}

export const approvalRow = (id) => db.prepare(
  'SELECT a.*, h.name AS host_name FROM approvals a JOIN hosts h ON h.id = a.host_id WHERE a.id = ?').get(id);

export const pendingApprovals = (hostId) => db.prepare(`SELECT a.*, h.name AS host_name FROM approvals a
  JOIN hosts h ON h.id = a.host_id WHERE a.status = 'pending' ${hostId ? 'AND a.host_id = ?' : ''} ORDER BY a.id`)
  .all(...(hostId ? [hostId] : []));

export function requestApproval(hostId, kind, reason) {
  const existing = db.prepare(`SELECT id FROM approvals WHERE host_id = ? AND kind = ? AND status = 'pending'`).get(hostId, kind);
  if (existing) return approvalRow(existing.id);
  const info = db.prepare('INSERT INTO approvals (host_id, kind, reason, created_at) VALUES (?, ?, ?, ?)')
    .run(hostId, kind, reason, now());
  const a = approvalRow(info.lastInsertRowid);
  broadcast({ type: 'approval_update', approval: a });
  notify(`❓ **${a.host_name}**: ${kind} requested — ${reason}. Approve?`, { hostId, approval: a });
  return a;
}

/** Approve or deny. Returns the updated approval; throws on invalid state. */
export function decideApproval(id, approve, by) {
  const a = approvalRow(id);
  if (!a) throw new Error('unknown approval');
  if (a.status !== 'pending') throw new Error(`already ${a.status} by ${a.decided_by}`);
  if (approve && a.kind === 'reboot') startJob(a.host_id, 'reboot', {}, `approval:${by}`); // throws if offline
  db.prepare('UPDATE approvals SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?')
    .run(approve ? 'approved' : 'denied', now(), by, id);
  const updated = approvalRow(id);
  broadcast({ type: 'approval_update', approval: updated });
  if (!approve) notify(`🚫 **${a.host_name}**: ${a.kind} denied by ${by}.`, { hostId: a.host_id });
  return updated;
}

/** Ask the agent to re-check available updates. */
export function refreshHost(hostId) {
  if (!sendToAgent(hostId, { type: 'refresh' })) throw new Error('host is offline');
  const host = getHost(hostId);
  setHostJson(hostId, 'state', { ...host.state, refresh_requested_at: now() });
}
