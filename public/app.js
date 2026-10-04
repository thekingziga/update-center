'use strict';
// Update Center web UI — vanilla JS, hash router, live updates over /ws/ui.

const $ = (sel, root = document) => root.querySelector(sel);
const app = $('#app');
const S = { user: null, hosts: new Map(), approvals: [], ws: null, view: null, detail: null };

// ---------------------------------------------------------------- utils
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Discord-style **bold** and `code` (input already escaped).
const md = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>');
const bytes = (n) => { if (n == null) return '?'; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (n >= 1024 && i < 4) { n /= 1024; i++; } return `${n.toFixed(n < 10 && i ? 1 : 0)} ${u[i]}`; };
const ago = (t) => { if (!t) return 'never'; const s = (Date.now() - t) / 1000; if (s < 60) return 'just now'; if (s < 3600) return `${Math.floor(s / 60)}m ago`; if (s < 86400) return `${Math.floor(s / 3600)}h ago`; return `${Math.floor(s / 86400)}d ago`; };
const dur = (s) => { if (!s) return '?'; const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`; };
const when = (t) => t ? new Date(t).toLocaleString() : '';
const level = (p) => p >= 90 ? 'err' : p >= 75 ? 'warn' : '';
const maxDisk = (m) => Math.max(0, ...((m && m.disks) || []).map((d) => d.pct));

function toast(msg, isErr = false) {
  const el = document.createElement('div');
  el.className = isErr ? 'err' : '';
  el.textContent = msg;
  $('#toast').append(el);
  setTimeout(() => el.remove(), isErr ? 7000 : 4000);
}

async function api(method, path, body) {
  const r = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/api/login') { S.user = null; route(); }
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}
const run = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { toast(e.message, true); } };

// ---------------------------------------------------------------- live socket
function connect() {
  if (S.ws) return;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/ui`);
  S.ws = ws;
  ws.onopen = () => $('#conn').classList.add('on');
  ws.onclose = () => {
    $('#conn').classList.remove('on');
    S.ws = null;
    if (S.detail?.term) S.detail.term.write('\r\n\x1b[31m[connection to hub lost]\x1b[0m\r\n');
    if (S.user) setTimeout(() => { connect(); loadHosts(); }, 3000);
  };
  ws.onmessage = (e) => onLive(JSON.parse(e.data));
}
const wsSend = (m) => S.ws?.readyState === 1 && S.ws.send(JSON.stringify(m));

function onLive(m) {
  const d = S.detail;
  switch (m.type) {
    case 'host_update':
      S.hosts.set(m.host.id, m.host);
      if (S.view === 'hosts') renderHostGrid();
      if (d?.id === m.host.id) renderDetailParts();
      break;
    case 'host_removed':
      S.hosts.delete(m.id);
      if (S.view === 'hosts') renderHostGrid();
      break;
    case 'host_metrics': {
      const h = S.hosts.get(m.id);
      if (h) { h.metrics = m.metrics; h.online = true; }
      if (S.view === 'hosts') renderHostGrid();
      if (d?.id === m.id) {
        d.history.push({ t: m.metrics.at, cpu: m.metrics.cpu_pct, mem: m.metrics.mem_pct, load: m.metrics.load?.[0] });
        if (d.history.length > 360) d.history.shift();
        renderOverview();
      }
      break;
    }
    case 'job_update':
      if (d?.id === m.job.host_id) {
        const i = d.jobs.findIndex((j) => j.id === m.job.id);
        if (i >= 0) d.jobs[i] = m.job; else d.jobs.unshift(m.job);
        renderJobs();
      }
      break;
    case 'job_output':
      if (d?.openJob === m.job_id) {
        const pre = $('#job-log');
        const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
        pre.textContent += m.data;
        if (atBottom) pre.scrollTop = pre.scrollHeight;
      }
      break;
    case 'approval_update':
      S.approvals = S.approvals.filter((a) => a.id !== m.approval.id);
      if (m.approval.status === 'pending') S.approvals.push(m.approval);
      renderBadge();
      if (S.view === 'approvals') viewApprovals();
      if (d?.id === m.approval.host_id) renderDetailParts();
      break;
    case 'event':
      if (S.view === 'activity') prependEvent(m.event);
      if (m.event.level === 'error') toast(m.event.message.replace(/\*\*|`/g, ''), true);
      break;
    case 'term_output':
      if (d?.sid === m.sid) d.term.write(Uint8Array.from(atob(m.data), (c) => c.charCodeAt(0)));
      break;
    case 'term_exit':
      if (d?.sid === m.sid) { d.term.write(`\r\n\x1b[33m[session ended${m.reason ? ': ' + m.reason : ''}]\x1b[0m\r\n`); d.sid = null; renderTermBar(); }
      break;
  }
}

async function loadHosts() {
  const [hosts, appr] = await Promise.all([api('GET', '/api/hosts'), api('GET', '/api/approvals')]);
  S.hosts = new Map(hosts.map((h) => [h.id, h]));
  S.approvals = appr.pending;
  renderBadge();
  if (S.view === 'hosts') renderHostGrid();
}

function renderBadge() {
  const b = $('#approval-badge');
  b.hidden = !S.approvals.length;
  b.textContent = S.approvals.length;
}

// ---------------------------------------------------------------- router
async function route() {
  closeTerminal();
  S.detail = null;
  if (!S.user) {
    const st = await api('GET', '/api/state');
    S.user = st.user;
    if (!S.user) { $('#topbar').hidden = true; return viewAuth(st.setup_needed); }
    await startSession();
  }
  $('#topbar').hidden = false;
  const [, page, id] = location.hash.replace(/^#/, '').split('/');
  for (const a of document.querySelectorAll('nav a')) a.classList.toggle('active', a.getAttribute('href') === `#/${page || ''}`);
  if (page === 'host' && id) return viewHost(decodeURIComponent(id));
  if (page === 'approvals') return viewApprovals();
  if (page === 'activity') return viewActivity();
  if (page === 'add') return viewAdd();
  if (page === 'settings') return viewSettings();
  return viewHosts();
}
window.addEventListener('hashchange', run(route));

// ---------------------------------------------------------------- auth
function viewAuth(setup) {
  S.view = 'auth';
  app.innerHTML = `<form class="card auth stack" id="auth">
    <h1>${setup ? 'Create admin account' : 'Sign in'}</h1>
    ${setup ? '<p class="muted">First run: this account has full control over every connected server. Use a strong password.</p>' : ''}
    <label class="field">Username <input name="username" autocomplete="username" required></label>
    <label class="field">Password <input name="password" type="password" autocomplete="${setup ? 'new-password' : 'current-password'}" required ${setup ? 'minlength="10"' : ''}></label>
    <button class="primary">${setup ? 'Create account' : 'Sign in'}</button></form>`;
  $('#auth').onsubmit = run(async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const r = await api('POST', setup ? '/api/setup' : '/api/login', { username: f.get('username'), password: f.get('password') });
    S.user = r.user;
    await startSession();
    route();
  });
}

async function startSession() {
  connect();
  await loadHosts();
}

// ---------------------------------------------------------------- hosts grid
function viewHosts() {
  S.view = 'hosts';
  app.innerHTML = `<div class="row spread"><h1>Hosts</h1><div class="row">
      <button id="check-all">Check all</button><button id="update-all" class="primary">Update all</button></div></div>
    <div id="host-grid" class="grid" style="margin-top:16px"></div>`;
  $('#check-all').onclick = run(async () => {
    const online = [...S.hosts.values()].filter((h) => h.online);
    await Promise.all(online.map((h) => api('POST', `/api/hosts/${h.id}/refresh`)));
    toast(`Checking ${online.length} host(s)…`);
  });
  $('#update-all').onclick = run(async () => {
    const targets = [...S.hosts.values()].filter((h) => h.online && h.inventory.updates?.length);
    if (!targets.length) return toast('Nothing to update.');
    if (!confirm(`Install updates on ${targets.length} host(s): ${targets.map((h) => h.name).join(', ')}?`)) return;
    const res = await Promise.allSettled(targets.map((h) => api('POST', `/api/hosts/${h.id}/jobs`, { kind: 'upgrade' })));
    toast(`Started ${res.filter((r) => r.status === 'fulfilled').length} upgrade(s).`);
  });
  renderHostGrid();
}

function meter(label, pct, text) {
  return `<div class="meter"><span>${label}</span><div class="bar"><i class="${level(pct)}" style="width:${Math.min(100, pct || 0)}%"></i></div><span>${text ?? (pct == null ? '–' : Math.round(pct) + '%')}</span></div>`;
}

function renderHostGrid() {
  const grid = $('#host-grid');
  if (!grid) return;
  const hosts = [...S.hosts.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (!hosts.length) {
    grid.innerHTML = `<div class="card"><h2>No hosts yet</h2><p class="muted">Install the agent on a server to see it here.</p><a class="btn" href="#/add">Add your first host</a></div>`;
    return;
  }
  grid.innerHTML = hosts.map((h) => {
    const m = h.online ? h.metrics : {};
    const ups = h.inventory.updates;
    const sec = ups?.filter((u) => u.security).length;
    const pending = S.approvals.some((a) => a.host_id === h.id);
    return `<a class="card host-card stack" href="#/host/${encodeURIComponent(h.id)}">
      <div class="row spread"><span class="row" style="gap:8px"><span class="dot ${h.online ? 'on' : ''}"></span><span class="name">${esc(h.name)}</span></span>
        <span class="muted small">${h.online ? 'up ' + dur(m.uptime) : 'seen ' + ago(h.last_seen)}</span></div>
      <div class="muted small">${esc(h.info.os || 'waiting for agent…')} · ${esc(h.info.arch || '')}${m.temp != null ? ` · ${m.temp}°C` : ''}</div>
      <div>${meter('CPU', m.cpu_pct)}${meter('RAM', m.mem_pct)}${meter('Disk', h.online ? maxDisk(m) : null)}</div>
      <div class="row" style="gap:6px">
        ${ups == null ? '<span class="badge">updates: ?</span>' : ups.length ? `<span class="badge warn">${ups.length} updates${sec ? ` · ${sec} security` : ''}</span>` : '<span class="badge ok">up to date</span>'}
        ${h.inventory.reboot_required ? '<span class="badge err">reboot required</span>' : ''}
        ${pending ? '<span class="badge warn">approval pending</span>' : ''}
        ${h.inventory.failed_units?.length ? `<span class="badge err">${h.inventory.failed_units.length} failed unit(s)</span>` : ''}
        ${h.policy.auto_update ? `<span class="badge">auto ${esc(h.policy.time)}</span>` : ''}
      </div></a>`;
  }).join('');
}

// ---------------------------------------------------------------- host detail
const TABS = ['overview', 'updates', 'terminal', 'jobs', 'policy', 'activity'];

async function viewHost(id) {
  S.view = 'host';
  const data = await api('GET', `/api/hosts/${encodeURIComponent(id)}`);
  S.hosts.set(id, data.host);
  S.detail = { id, history: data.history, jobs: data.jobs, approvals: data.approvals, tab: 'overview', openJob: null, term: null, sid: null };
  app.innerHTML = `<div id="host-head"></div><div id="host-approval"></div>
    <div class="tabs" role="tablist">${TABS.map((t) => `<button role="tab" data-tab="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div>
    <section data-panel="overview" id="p-overview"></section>
    <section data-panel="updates" id="p-updates"></section>
    <section data-panel="terminal"><div class="row spread" style="margin-bottom:8px" id="term-bar"></div><div id="terminal"></div></section>
    <section data-panel="jobs" class="stack"><form id="exec-form" class="row card">
        <input name="command" placeholder="Run a command as root, e.g. systemctl restart nginx" style="flex:1;min-width:220px" required>
        <button class="primary">Run</button></form>
      <div class="grid2"><div class="card table-wrap"><table><thead><tr><th>#</th><th>Job</th><th>Status</th><th>By</th><th>When</th></tr></thead><tbody id="jobs-body"></tbody></table></div>
      <div class="card"><h3 id="job-title">Select a job to see its output</h3><pre class="log" id="job-log"></pre></div></div></section>
    <section data-panel="policy" id="p-policy"></section>
    <section data-panel="activity" id="p-activity"></section>`;
  for (const b of document.querySelectorAll('.tabs button')) b.onclick = () => showTab(b.dataset.tab);
  $('#exec-form').onsubmit = run(async (e) => {
    e.preventDefault();
    const job = await api('POST', `/api/hosts/${id}/jobs`, { kind: 'exec', params: { command: e.target.command.value } });
    e.target.reset();
    openJob(job.id);
  });
  renderDetailParts();
  renderPolicy();
  showTab('overview');
}

const host = () => S.hosts.get(S.detail.id);

function showTab(tab) {
  S.detail.tab = tab;
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.tab === tab);
  for (const p of document.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== tab;
  if (tab === 'terminal') { if (!S.detail.term) openTerminal(); else S.detail.fit.fit(); S.detail.term.focus(); }
  if (tab === 'jobs') renderJobs();
  if (tab === 'activity') renderHostActivity();
}

function renderDetailParts() {
  renderHead();
  renderApproval();
  renderOverview();
  renderUpdates();
  renderTermBar();
}

function renderHead() {
  const h = host();
  const busy = S.detail.jobs.some((j) => j.status === 'running' && j.kind !== 'exec');
  const off = !h.online;
  $('#host-head').innerHTML = `<div class="row spread">
    <div class="row"><span class="dot ${h.online ? 'on' : ''}"></span><h1>${esc(h.name)}</h1>
      <button class="small" id="rename" title="Rename">✎</button>
      <span class="muted">${h.online ? 'online' : 'offline · last seen ' + ago(h.last_seen)}</span></div>
    <div class="row">
      <button id="a-check" ${off ? 'disabled' : ''}>Check updates</button>
      <button id="a-update" class="primary" ${off || busy ? 'disabled' : ''}>Update now</button>
      <button id="a-security" ${off || busy ? 'disabled' : ''}>Security only</button>
      <button id="a-reboot" class="danger" ${off || busy ? 'disabled' : ''}>Reboot</button>
      <button id="a-remove" class="danger">Remove</button>
    </div></div>`;
  const id = h.id;
  $('#rename').onclick = run(async () => {
    const name = prompt('New name', h.name);
    if (name && name !== h.name) await api('PATCH', `/api/hosts/${id}`, { name });
  });
  $('#a-check').onclick = run(async () => { await api('POST', `/api/hosts/${id}/refresh`); toast('Checking for updates…'); });
  const upgrade = (security_only) => run(async () => {
    const job = await api('POST', `/api/hosts/${id}/jobs`, { kind: 'upgrade', params: { security_only } });
    showTab('jobs'); openJob(job.id);
  });
  $('#a-update').onclick = upgrade(false);
  $('#a-security').onclick = upgrade(true);
  $('#a-reboot').onclick = run(async () => {
    if (!confirm(`Reboot ${h.name} now?`)) return;
    await api('POST', `/api/hosts/${id}/jobs`, { kind: 'reboot' });
    toast(`${h.name} is rebooting…`);
  });
  $('#a-remove').onclick = run(async () => {
    if (!confirm(`Remove ${h.name}? Its agent will be disconnected and can no longer log in.\nTo uninstall on the server run:\ncurl -fsSL ${location.origin}/install.sh | sudo sh -s -- --uninstall`)) return;
    await api('DELETE', `/api/hosts/${id}`);
    location.hash = '#/';
  });
}

function renderApproval() {
  const list = S.approvals.filter((a) => a.host_id === S.detail.id);
  $('#host-approval').innerHTML = list.map((a) => `<div class="banner row spread" style="margin-top:12px">
    <span>⚠️ <b>${esc(a.kind)}</b> waiting for approval — ${esc(a.reason)} <span class="muted">(${ago(a.created_at)})</span></span>
    <span class="row"><button class="primary" data-approve="${a.id}">Approve</button><button data-deny="${a.id}">Deny</button></span></div>`).join('');
  bindApprovalButtons($('#host-approval'));
}

function bindApprovalButtons(root) {
  for (const b of root.querySelectorAll('[data-approve],[data-deny]')) {
    b.onclick = run(async () => {
      const id = b.dataset.approve || b.dataset.deny;
      await api('POST', `/api/approvals/${id}`, { approve: !!b.dataset.approve });
    });
  }
}

function spark(points, key, color, max = 100) {
  const pts = points.filter((p) => p[key] != null);
  if (pts.length < 2) return '<p class="muted small">collecting data…</p>';
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t || t0 + 1;
  const top = Math.max(max, ...pts.map((p) => p[key]));
  const coords = pts.map((p) => `${((p.t - t0) / (t1 - t0 || 1) * 300).toFixed(1)},${(60 - p[key] / top * 58).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 300 60" preserveAspectRatio="none" role="img" aria-label="${key} history"><polyline points="${coords}" stroke="${color}"/></svg>`;
}

function renderOverview() {
  const el = $('#p-overview');
  if (!el) return;
  const h = host(), m = h.online ? h.metrics : {}, i = h.info, inv = h.inventory, hist = S.detail.history;
  el.innerHTML = `<div class="grid2">
    <div class="card"><h2>System</h2><dl class="kv">
      <dt>OS</dt><dd>${esc(i.os)}</dd><dt>Kernel</dt><dd>${esc(i.kernel)} (${esc(i.arch)})</dd>
      <dt>CPU</dt><dd>${esc([i.cpu, i.cpus && `${i.cpus} cores`].filter(Boolean).join(' · '))}</dd><dt>Memory</dt><dd>${bytes(i.mem_total)}</dd>
      <dt>IPs</dt><dd class="mono">${esc((i.ips || []).join(' '))}</dd><dt>Virtualization</dt><dd>${esc(i.virt || 'none')}</dd>
      <dt>Uptime</dt><dd>${dur(m.uptime)}</dd><dt>Packages</dt><dd>${esc(i.pkg_manager || 'unsupported')}</dd>
      <dt>Agent</dt><dd>v${esc(i.agent_version)} · Python ${esc(i.python)}</dd>
    </dl></div>
    <div class="card"><h2>Live</h2>
      ${meter('CPU', m.cpu_pct)}${spark(hist, 'cpu', 'var(--accent)')}
      ${meter('RAM', m.mem_pct, m.mem_used ? bytes(m.mem_used) : undefined)}${spark(hist, 'mem', 'var(--ok)')}
      <p class="muted small">Load ${(m.load || []).map((x) => x.toFixed(2)).join(' / ') || '–'} · Swap ${m.swap_pct ?? '–'}% · ${m.procs ?? '–'} processes
        ${m.temp != null ? ` · <span class="${m.temp > 75 ? 'err' : ''}">${m.temp}°C</span>` : ''}
        ${m.net ? ` · ↓ ${bytes(m.net.rx)}/s ↑ ${bytes(m.net.tx)}/s` : ''}</p></div>
    <div class="card"><h2>Disks</h2>${(m.disks || []).map((d) => `${meter(esc(d.mount.length > 6 ? '…' + d.mount.slice(-5) : d.mount), d.pct)}
      <p class="muted small" style="margin:0 0 8px 52px">${esc(d.mount)} · ${esc(d.fs)} · ${bytes(d.used)} / ${bytes(d.total)}</p>`).join('') || '<p class="muted">–</p>'}</div>
    <div class="card table-wrap"><h2>Top processes</h2><table><thead><tr><th>PID</th><th>CPU%</th><th>MEM%</th><th>Command</th></tr></thead>
      <tbody>${(m.top || []).map((p) => `<tr><td>${p.pid}</td><td>${p.cpu}</td><td>${p.mem}</td><td class="mono">${esc(p.cmd)}</td></tr>`).join('')}</tbody></table>
      <p class="muted small">For a full view open the Terminal tab and run <code>htop</code> or <code>bashtop</code>.</p></div>
    <div class="card"><h2>Services</h2>${inv.failed_units?.length
      ? `<p class="err">Failed systemd units:</p><ul>${inv.failed_units.map((u) => `<li class="mono">${esc(u)}</li>`).join('')}</ul>`
      : '<p class="ok">No failed systemd units.</p>'}</div>
    ${inv.containers ? `<div class="card table-wrap"><h2>Docker containers</h2><table><thead><tr><th>Name</th><th>Image</th><th>Status</th></tr></thead><tbody>
      ${inv.containers.map((c) => `<tr><td>${esc(c.name)}</td><td class="mono small">${esc(c.image)}</td><td class="${c.state === 'running' ? 'ok' : 'warn'}">${esc(c.status)}</td></tr>`).join('')}</tbody></table></div>` : ''}
  </div>`;
}

function renderUpdates() {
  const inv = host().inventory, ups = inv.updates || [];
  $('#p-updates').innerHTML = `<div class="card table-wrap">
    <div class="row spread"><h2>${ups.length} available update(s)</h2><span class="muted small">checked ${ago(inv.checked_at)}</span></div>
    ${inv.reboot_required ? `<p class="err">Reboot required${inv.reboot_pkgs?.length ? ' by: ' + esc(inv.reboot_pkgs.join(', ')) : ''}.</p>` : ''}
    ${ups.length ? `<table><thead><tr><th>Package</th><th>Installed</th><th>Available</th><th></th></tr></thead><tbody>
      ${ups.map((u) => `<tr><td class="mono">${esc(u.name)}</td><td class="mono muted">${esc(u.current || '')}</td><td class="mono">${esc(u.version || '')}</td>
        <td>${u.security ? '<span class="badge err">security</span>' : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="ok">Everything is up to date.</p>'}</div>`;
}

function renderJobs() {
  const body = $('#jobs-body');
  if (!body) return;
  const icon = { running: '⏳', success: '✅', failed: '❌' };
  body.innerHTML = S.detail.jobs.map((j) => `<tr class="clickable ${S.detail.openJob === j.id ? 'selected' : ''}" data-job="${j.id}">
    <td>${j.id}</td><td>${esc(j.kind === 'exec' ? j.params.command : j.kind + (j.params.security_only ? ' (security)' : ''))}</td>
    <td>${icon[j.status] || ''} ${esc(j.status)}${j.exit_code != null && j.exit_code !== 0 ? ` (${j.exit_code})` : ''}</td>
    <td class="small muted">${esc(j.source)}</td><td class="small muted">${ago(j.created_at)}</td></tr>`).join('')
    || '<tr><td colspan="5" class="muted">No jobs yet.</td></tr>';
  for (const tr of body.querySelectorAll('[data-job]')) tr.onclick = () => openJob(Number(tr.dataset.job));
  renderHead();
}

const openJob = run(async (id) => {
  S.detail.openJob = id;
  renderJobs();
  const job = await api('GET', `/api/jobs/${id}`);
  if (S.detail?.openJob !== id) return;
  $('#job-title').textContent = `#${job.id} ${job.kind === 'exec' ? job.params.command : job.kind} — ${job.status}`;
  const pre = $('#job-log');
  pre.textContent = job.output || (job.status === 'running' ? 'waiting for output…\n' : '(no output)');
  pre.scrollTop = pre.scrollHeight;
});

function renderPolicy() {
  const p = host().policy;
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  $('#p-policy').innerHTML = `<form id="policy-form" class="card stack" style="max-width:640px">
    <h2>Automatic updates</h2>
    <label class="check"><input type="checkbox" name="auto_update" ${p.auto_update ? 'checked' : ''}> Install updates automatically</label>
    <div class="row">${days.map((d, i) => `<label class="check"><input type="checkbox" name="day" value="${i}" ${p.days.includes(i) ? 'checked' : ''}> ${d}</label>`).join('')}</div>
    <label class="field" style="max-width:200px">At (hub local time) <input type="time" name="time" value="${esc(p.time)}" required></label>
    <label class="check"><input type="checkbox" name="security_only" ${p.security_only ? 'checked' : ''}> Security updates only (apt needs unattended-upgrades)</label>
    <label class="field" style="max-width:420px">When an update needs a reboot
      <select name="reboot">
        <option value="ask" ${p.reboot === 'ask' ? 'selected' : ''}>Ask me first (Discord buttons + web)</option>
        <option value="auto" ${p.reboot === 'auto' ? 'selected' : ''}>Reboot automatically</option>
        <option value="never" ${p.reboot === 'never' ? 'selected' : ''}>Never — just notify me</option>
      </select></label>
    <label class="field" style="max-width:260px">Check for new updates every (hours) <input type="number" name="check_hours" min="1" max="168" value="${p.check_hours}"></label>
    <h2>Alerts</h2>
    <label class="check"><input type="checkbox" name="alert_offline" ${p.alert_offline ? 'checked' : ''}> Notify when the host goes offline</label>
    <label class="field" style="max-width:260px">Disk usage alert at % (0 = off) <input type="number" name="alert_disk_pct" min="0" max="100" value="${p.alert_disk_pct}"></label>
    <div><button class="primary">Save policy</button></div></form>`;
  $('#policy-form').onsubmit = run(async (e) => {
    e.preventDefault();
    const f = e.target;
    const policy = {
      auto_update: f.auto_update.checked, security_only: f.security_only.checked, alert_offline: f.alert_offline.checked,
      days: [...f.querySelectorAll('[name=day]:checked')].map((c) => Number(c.value)),
      time: f.time.value, reboot: f.reboot.value, check_hours: Number(f.check_hours.value), alert_disk_pct: Number(f.alert_disk_pct.value),
    };
    await api('PATCH', `/api/hosts/${S.detail.id}`, { policy });
    toast('Policy saved.');
  });
}

async function renderHostActivity() {
  const events = await api('GET', `/api/events?host=${encodeURIComponent(S.detail.id)}`);
  $('#p-activity').innerHTML = `<div class="card">${events.map(eventHtml).join('') || '<p class="muted">No activity yet.</p>'}</div>`;
}

// ---------------------------------------------------------------- terminal
function renderTermBar() {
  const bar = $('#term-bar');
  if (!bar) return;
  const d = S.detail;
  bar.innerHTML = `<span class="muted small">Root shell on <b>${esc(host().name)}</b> via agent · try <code>htop</code>, <code>bashtop</code>, <code>journalctl -f</code></span>
    <button id="term-restart" ${d.sid ? 'disabled' : ''}>New session</button>`;
  $('#term-restart').onclick = () => { closeTerminal(); openTerminal(); };
}

function openTerminal() {
  const d = S.detail;
  const term = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: 'ui-monospace, Menlo, Consolas, monospace', scrollback: 5000, theme: { background: '#000000' } });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open($('#terminal'));
  fit.fit();
  d.term = term; d.fit = fit; d.sid = crypto.randomUUID();
  if (!host().online) term.write('\x1b[31mHost is offline.\x1b[0m\r\n');
  wsSend({ type: 'term_open', sid: d.sid, host_id: d.id, cols: term.cols, rows: term.rows });
  term.onData((data) => d.sid && wsSend({ type: 'term_input', sid: d.sid, data }));
  term.onResize(({ cols, rows }) => d.sid && wsSend({ type: 'term_resize', sid: d.sid, cols, rows }));
  d.ro = new ResizeObserver(() => { if (d.tab === 'terminal') fit.fit(); });
  d.ro.observe($('#terminal'));
  renderTermBar();
}

function closeTerminal() {
  const d = S.detail;
  if (!d?.term) return;
  if (d.sid) wsSend({ type: 'term_close', sid: d.sid });
  d.ro?.disconnect();
  d.term.dispose();
  d.term = null; d.sid = null;
  $('#terminal')?.replaceChildren();
}

// ---------------------------------------------------------------- approvals / activity / add / settings
async function viewApprovals() {
  S.view = 'approvals';
  const { pending, recent } = await api('GET', '/api/approvals');
  S.approvals = pending;
  renderBadge();
  app.innerHTML = `<h1>Approvals</h1><div class="stack" style="margin-top:16px">
    ${pending.map((a) => `<div class="banner row spread"><span>⚠️ <a href="#/host/${encodeURIComponent(a.host_id)}"><b>${esc(a.host_name)}</b></a>: ${esc(a.kind)} — ${esc(a.reason)} <span class="muted">(${ago(a.created_at)})</span></span>
      <span class="row"><button class="primary" data-approve="${a.id}">Approve</button><button data-deny="${a.id}">Deny</button></span></div>`).join('') || '<p class="muted">Nothing is waiting for approval.</p>'}
    <div class="card table-wrap"><h2>Recent decisions</h2><table><thead><tr><th>Host</th><th>Action</th><th>Decision</th><th>By</th><th>When</th></tr></thead><tbody>
      ${recent.map((a) => `<tr><td>${esc(a.host_name)}</td><td>${esc(a.kind)}</td><td class="${a.status === 'approved' ? 'ok' : 'err'}">${esc(a.status)}</td><td>${esc(a.decided_by)}</td><td>${when(a.decided_at)}</td></tr>`).join('')}
    </tbody></table></div></div>`;
  bindApprovalButtons(app);
}

const eventHtml = (e) => `<div class="event"><span class="muted small">${when(e.created_at)}</span><span class="${e.level === 'error' ? 'err' : e.level === 'warn' ? 'warn' : ''}">${md(e.message)}</span></div>`;

async function viewActivity() {
  S.view = 'activity';
  const events = await api('GET', '/api/events');
  app.innerHTML = `<h1>Activity</h1><div class="card" id="events" style="margin-top:16px">${events.map(eventHtml).join('') || '<p class="muted">No activity yet.</p>'}</div>`;
}
function prependEvent(e) { $('#events')?.insertAdjacentHTML('afterbegin', eventHtml(e)); }

function viewAdd() {
  S.view = 'add';
  app.innerHTML = `<h1>Add a host</h1><div class="card stack" style="margin-top:16px;max-width:860px">
    <p>Works on Debian, Ubuntu, Raspberry Pi OS, Fedora/RHEL, Arch, openSUSE and Alpine. The agent only makes an <b>outbound</b> connection to this hub — no ports to open on the server.</p>
    <ol><li>Click <b>Generate install command</b> (single-use, valid 24 hours).</li><li>Run it on the server as root.</li><li>The host appears on the dashboard within seconds.</li></ol>
    <div class="row"><input id="label" placeholder="Label (optional, e.g. rpi4-garage)"><button class="primary" id="gen">Generate install command</button></div>
    <div id="cmd"></div>
    <p class="muted small">Make sure the URL in the command is reachable from the server. Set <code>PUBLIC_URL</code> on the hub (and use HTTPS) for servers on the internet.</p></div>`;
  $('#gen').onclick = run(async () => {
    const r = await api('POST', '/api/enroll-tokens', { label: $('#label').value });
    const box = (title, cmd, i) => `<h3>${title}</h3><div class="copy-box"><code>${esc(cmd)}</code><button data-copy="${i}">Copy</button></div>`;
    $('#cmd').innerHTML = `<div class="stack">${box('Option A — install script (recommended)', r.command, 0)}
      ${box('Option B — Docker container (host needs Docker + python3)', r.docker_command, 1)}
      <p class="muted small">Use only one option per server. The token works once.</p></div>`;
    for (const b of document.querySelectorAll('[data-copy]')) {
      b.onclick = () => navigator.clipboard.writeText([r.command, r.docker_command][b.dataset.copy]).then(() => toast('Copied.'));
    }
  });
}

function viewSettings() {
  S.view = 'settings';
  app.innerHTML = `<h1>Settings</h1><div class="grid2" style="margin-top:16px">
    <form class="card stack" id="pw"><h2>Change password</h2>
      <label class="field">Current password <input type="password" name="old" autocomplete="current-password" required></label>
      <label class="field">New password <input type="password" name="new" autocomplete="new-password" minlength="10" required></label>
      <div><button class="primary">Change password</button></div></form>
    <div class="card stack"><h2>Signed in as ${esc(S.user.username)}</h2>
      <p class="muted">Discord bot, webhook and public URL are configured in the hub's <code>.env</code> file — see README.</p>
      <div><button id="logout">Sign out</button></div></div></div>`;
  $('#pw').onsubmit = run(async (e) => {
    e.preventDefault();
    await api('POST', '/api/password', { old: e.target.old.value, new: e.target.new.value });
    toast('Password changed — please sign in again.');
    S.user = null; S.ws?.close(); route();
  });
  $('#logout').onclick = run(async () => { await api('POST', '/api/logout'); S.user = null; S.ws?.close(); location.hash = '#/'; route(); });
}

run(route)();
// Keep "x ago" labels fresh.
setInterval(() => { if (S.view === 'hosts') renderHostGrid(); }, 30_000);
