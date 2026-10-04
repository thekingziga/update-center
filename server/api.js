// REST API. All /api routes except setup/login/agent-enroll require a session.
import { randomUUID } from 'node:crypto';
import { db, now, getHost, listHosts, setHostJson, jobRow, DEFAULT_POLICY } from './db.js';
import * as auth from './auth.js';
import { publicHost, metricsHistory, disconnectAgent } from './agents.js';
import { startJob, refreshHost, decideApproval, pendingApprovals, JOB_KINDS } from './actions.js';
import { broadcast } from './ui.js';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => { throw new HttpError(400, msg); };

export function baseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const proto = process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${req.headers.host}`;
}

export function clientIp(req) {
  return process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
}

function validatePolicy(input, current) {
  const p = { ...current };
  for (const [k, v] of Object.entries(input || {})) {
    if (!(k in DEFAULT_POLICY)) bad(`unknown policy field ${k}`);
    const ok = {
      auto_update: typeof v === 'boolean', security_only: typeof v === 'boolean', alert_offline: typeof v === 'boolean',
      days: Array.isArray(v) && v.every((d) => Number.isInteger(d) && d >= 0 && d <= 6),
      time: typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v),
      reboot: ['auto', 'ask', 'never'].includes(v),
      check_hours: Number.isInteger(v) && v >= 1 && v <= 168,
      alert_disk_pct: Number.isInteger(v) && v >= 0 && v <= 100,
    }[k];
    if (!ok) bad(`invalid value for ${k}`);
    p[k] = v;
  }
  return p;
}

const routes = [];
const route = (method, path, handler, { public: isPublic = false } = {}) => {
  const keys = [];
  const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, isPublic });
};

const hostOr404 = (id) => getHost(id) || (() => { throw new HttpError(404, 'host not found'); })();

// --- session ---------------------------------------------------------------
route('GET', '/api/state', ({ user }) => ({ setup_needed: !auth.hasUsers(), user }), { public: true });

route('POST', '/api/setup', ({ body, req, res }) => {
  if (auth.hasUsers()) throw new HttpError(403, 'already set up');
  if (typeof body.username !== 'string' || !/^[\w.-]{3,32}$/.test(body.username)) bad('username: 3-32 letters/digits');
  if (typeof body.password !== 'string' || body.password.length < 10) bad('password: at least 10 characters');
  auth.createUser(body.username, body.password);
  return loginResponse(req, res, auth.login(body.username, body.password));
}, { public: true });

route('POST', '/api/login', ({ body, req, res }) => {
  const ip = clientIp(req);
  if (!auth.loginAllowed(ip)) throw new HttpError(429, 'too many attempts, try again in 15 minutes');
  const u = typeof body.username === 'string' && typeof body.password === 'string' && auth.login(body.username, body.password);
  if (!u) { auth.loginFailed(ip); throw new HttpError(401, 'wrong username or password'); }
  auth.loginSucceeded(ip);
  return loginResponse(req, res, u);
}, { public: true });

function loginResponse(req, res, u) {
  res.setHeader('Set-Cookie', auth.sessionCookie(auth.createSession(u.id), baseUrl(req).startsWith('https')));
  return { user: { id: u.id, username: u.username } };
}

route('POST', '/api/logout', ({ req, res }) => {
  auth.destroySession(auth.parseCookies(req.headers.cookie)[auth.COOKIE]);
  res.setHeader('Set-Cookie', auth.sessionCookie('', false));
  return { ok: true };
});

route('POST', '/api/password', ({ body, user }) => {
  const row = db.prepare('SELECT pass_hash FROM users WHERE id = ?').get(user.id);
  if (typeof body.old !== 'string' || !auth.verifyPassword(body.old, row.pass_hash)) throw new HttpError(403, 'current password is wrong');
  if (typeof body.new !== 'string' || body.new.length < 10) bad('password: at least 10 characters');
  db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(auth.hashPassword(body.new), user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  return { ok: true };
});

// --- hosts -----------------------------------------------------------------
route('GET', '/api/hosts', () => listHosts().map(publicHost));

route('GET', '/api/hosts/:id', ({ params }) => ({
  host: publicHost(hostOr404(params.id)),
  history: metricsHistory(params.id),
  jobs: db.prepare('SELECT * FROM jobs WHERE host_id = ? ORDER BY id DESC LIMIT 30').all(params.id).map((r) => jobRow(r)),
  approvals: pendingApprovals(params.id),
}));

route('PATCH', '/api/hosts/:id', ({ params, body }) => {
  const host = hostOr404(params.id);
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !/^[\w.-]{1,63}$/.test(body.name)) bad('name: letters, digits, . _ -');
    db.prepare('UPDATE hosts SET name = ? WHERE id = ?').run(body.name, host.id);
  }
  if (body.policy !== undefined) setHostJson(host.id, 'policy', validatePolicy(body.policy, host.policy));
  const updated = publicHost(getHost(host.id));
  broadcast({ type: 'host_update', host: updated });
  return updated;
});

route('DELETE', '/api/hosts/:id', ({ params }) => {
  hostOr404(params.id);
  db.prepare('DELETE FROM hosts WHERE id = ?').run(params.id);
  disconnectAgent(params.id);
  broadcast({ type: 'host_removed', id: params.id });
  return { ok: true };
});

route('POST', '/api/hosts/:id/refresh', ({ params }) => {
  hostOr404(params.id);
  try { refreshHost(params.id); } catch (e) { throw new HttpError(409, e.message); }
  return { ok: true };
});

route('POST', '/api/hosts/:id/jobs', ({ params, body, user }) => {
  hostOr404(params.id);
  if (!JOB_KINDS.includes(body.kind)) bad('unknown job kind');
  try { return startJob(params.id, body.kind, body.params || {}, `web:${user.username}`); }
  catch (e) { throw new HttpError(409, e.message); }
});

// --- jobs, approvals, events -------------------------------------------------
route('GET', '/api/jobs/:id', ({ params }) =>
  jobRow(db.prepare('SELECT * FROM jobs WHERE id = ?').get(params.id), true) || (() => { throw new HttpError(404, 'job not found'); })());

route('GET', '/api/approvals', () => ({
  pending: pendingApprovals(),
  recent: db.prepare(`SELECT a.*, h.name AS host_name FROM approvals a JOIN hosts h ON h.id = a.host_id
    WHERE a.status != 'pending' ORDER BY a.id DESC LIMIT 20`).all(),
}));

route('POST', '/api/approvals/:id', ({ params, body, user }) => {
  try { return decideApproval(Number(params.id), body.approve === true, `web:${user.username}`); }
  catch (e) { throw new HttpError(409, e.message); }
});

route('GET', '/api/events', ({ url }) => {
  const host = url.searchParams.get('host');
  return db.prepare(`SELECT e.*, h.name AS host_name FROM events e LEFT JOIN hosts h ON h.id = e.host_id
    ${host ? 'WHERE e.host_id = ?' : ''} ORDER BY e.id DESC LIMIT 200`).all(...(host ? [host] : []));
});

// --- enrollment --------------------------------------------------------------
route('POST', '/api/enroll-tokens', ({ req, body }) => {
  const token = auth.randomToken(24);
  db.prepare('INSERT INTO enroll_tokens (token_hash, label, expires_at) VALUES (?, ?, ?)')
    .run(auth.sha256(token), String(body.label || '').slice(0, 64), now() + 24 * 3600e3);
  const base = baseUrl(req);
  const image = process.env.AGENT_IMAGE || 'thekingziga/update-center-agent:latest';
  return {
    token, expires_in_h: 24,
    command: `curl -fsSL ${base}/install.sh | sudo sh -s -- --hub ${base} --token ${token}`,
    docker_command: `docker run -d --name uc-agent --restart unless-stopped --privileged --pid host -e UC_HUB=${base} -e UC_TOKEN=${token} ${image}`,
  };
});

route('POST', '/api/agent/enroll', ({ body }) => {
  if (typeof body.token !== 'string') bad('token required');
  const used = db.prepare(`UPDATE enroll_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`)
    .run(now(), auth.sha256(body.token), now());
  if (!used.changes) throw new HttpError(403, 'invalid, used or expired enrollment token');
  let name = String(body.hostname || 'host').replace(/[^\w.-]/g, '-').slice(0, 50) || 'host';
  for (let i = 2; db.prepare('SELECT 1 FROM hosts WHERE name = ?').get(name); i++) name = `${name.replace(/-\d+$/, '')}-${i}`;
  const id = randomUUID();
  const secret = auth.randomToken();
  db.prepare('INSERT INTO hosts (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)').run(id, name, auth.sha256(secret), now());
  broadcast({ type: 'host_update', host: publicHost(getHost(id)) });
  return { host_id: id, secret, name };
}, { public: true });

// --- dispatcher --------------------------------------------------------------
export async function handleApi(req, res, url) {
  const user = auth.userFromRequest(req);
  for (const r of routes) {
    const m = r.method === req.method && r.re.exec(url.pathname);
    if (!m) continue;
    if (!r.isPublic && !user) throw new HttpError(401, 'login required');
    let body = {};
    if (req.method !== 'GET') {
      // JSON-only bodies + SameSite=Strict cookie = CSRF protection.
      if (!String(req.headers['content-type']).startsWith('application/json')) throw new HttpError(415, 'JSON required');
      body = await readJson(req);
    }
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    return r.handler({ req, res, url, user, body, params });
  }
  throw new HttpError(404, 'not found');
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 64 * 1024) throw new HttpError(413, 'body too large');
    chunks.push(c);
  }
  if (!size) return {};
  try { const v = JSON.parse(Buffer.concat(chunks)); return v && typeof v === 'object' ? v : {}; }
  catch { throw new HttpError(400, 'invalid JSON'); }
}
