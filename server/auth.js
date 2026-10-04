import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { db, now } from './db.js';

const SESSION_MS = 7 * 24 * 3600 * 1000;
export const COOKIE = 'uc_session';

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

export function hashPassword(pw) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(pw, salt, 64).toString('hex')}`;
}

export function verifyPassword(pw, stored) {
  const [, salt, hash] = stored.split('$');
  const actual = scryptSync(pw, Buffer.from(salt, 'hex'), 64);
  return timingSafeEqual(actual, Buffer.from(hash, 'hex'));
}

export const hasUsers = () => db.prepare('SELECT COUNT(*) n FROM users').get().n > 0;

export function createUser(username, password) {
  db.prepare('INSERT INTO users (username, pass_hash, created_at) VALUES (?, ?, ?)')
    .run(username, hashPassword(password), now());
}

export function createSession(userId) {
  const token = randomToken();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(sha256(token), userId, now() + SESSION_MS);
  return token;
}

export function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((p) => p.trim().split('=')).filter((p) => p[0])
    .map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}

/** Returns {id, username} for a valid session cookie, else null. */
export function userFromRequest(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const row = db.prepare(`SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?`).get(sha256(token), now());
  return row ? { id: row.id, username: row.username } : null;
}

export function sessionCookie(token, secure) {
  const maxAge = token ? SESSION_MS / 1000 : 0;
  return `${COOKIE}=${token || ''}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

// Login brute-force protection: max 10 failures per IP per 15 minutes.
const failures = new Map();
export function loginAllowed(ip) {
  const f = failures.get(ip);
  return !f || f.until < now() || f.count < 10;
}
export function loginFailed(ip) {
  const f = failures.get(ip);
  if (!f || f.until < now()) failures.set(ip, { count: 1, until: now() + 15 * 60 * 1000 });
  else f.count++;
}
export const loginSucceeded = (ip) => failures.delete(ip);

export function login(username, password) {
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  // Always run scrypt so response time does not reveal whether the user exists.
  const ok = verifyPassword(password, u ? u.pass_hash : hashPassword('x'));
  return ok && u ? u : null;
}
