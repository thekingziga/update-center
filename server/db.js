import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const file = process.env.DB_PATH || 'data/hub.db';
mkdirSync(dirname(file), { recursive: true });
export const db = new DatabaseSync(file);
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, pass_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS enroll_tokens (
  token_hash TEXT PRIMARY KEY, label TEXT, expires_at INTEGER NOT NULL, used_at INTEGER);
CREATE TABLE IF NOT EXISTS hosts (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL,
  info TEXT NOT NULL DEFAULT '{}', metrics TEXT NOT NULL DEFAULT '{}', inventory TEXT NOT NULL DEFAULT '{}',
  policy TEXT NOT NULL DEFAULT '{}', state TEXT NOT NULL DEFAULT '{}',
  last_seen INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY, host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, params TEXT NOT NULL DEFAULT '{}', source TEXT NOT NULL,
  status TEXT NOT NULL, exit_code INTEGER, output TEXT NOT NULL DEFAULT '', result TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL, finished_at INTEGER);
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY, host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, reason TEXT, status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL, decided_at INTEGER, decided_by TEXT);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY, host_id TEXT, level TEXT NOT NULL, message TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS jobs_host ON jobs(host_id, id);
CREATE INDEX IF NOT EXISTS events_time ON events(id);
`);

export const now = () => Date.now();

export const DEFAULT_POLICY = {
  auto_update: false,     // run upgrades on schedule
  days: [0, 1, 2, 3, 4, 5, 6], // 0 = Sunday
  time: '04:00',          // hub local time
  security_only: false,
  reboot: 'ask',          // 'auto' | 'ask' | 'never' — applied when an upgrade needs a reboot
  check_hours: 6,         // how often to refresh the available-updates list
  alert_offline: true,
  alert_disk_pct: 90,
};

const parse = (s) => JSON.parse(s || '{}');

export function hostRow(row) {
  if (!row) return null;
  return {
    id: row.id, name: row.name, last_seen: row.last_seen, created_at: row.created_at,
    info: parse(row.info), metrics: parse(row.metrics), inventory: parse(row.inventory),
    policy: { ...DEFAULT_POLICY, ...parse(row.policy) }, state: parse(row.state),
  };
}

export const getHost = (id) => hostRow(db.prepare('SELECT * FROM hosts WHERE id = ?').get(id));
export const listHosts = () => db.prepare('SELECT * FROM hosts ORDER BY name').all().map(hostRow);
export const findHostByName = (name) =>
  hostRow(db.prepare('SELECT * FROM hosts WHERE lower(name) = lower(?) OR id = ?').get(name, name));

/** Replace one JSON column of a host (column name is from a fixed set, never user input). */
export function setHostJson(id, column, value) {
  if (!['info', 'metrics', 'inventory', 'policy', 'state'].includes(column)) throw new Error('bad column');
  db.prepare(`UPDATE hosts SET ${column} = ? WHERE id = ?`).run(JSON.stringify(value), id);
}

export function jobRow(row, withOutput = false) {
  if (!row) return null;
  const j = { ...row, params: parse(row.params), result: parse(row.result) };
  if (!withOutput) delete j.output;
  return j;
}

export function logEvent(hostId, level, message) {
  const info = db.prepare('INSERT INTO events (host_id, level, message, created_at) VALUES (?, ?, ?, ?)')
    .run(hostId, level, message, now());
  return { id: Number(info.lastInsertRowid), host_id: hostId, level, message, created_at: now() };
}
