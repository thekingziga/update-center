// Browser WebSocket clients: live broadcasts + terminal session relay.
import { sendToAgent, isOnline } from './agents.js';
import { logEvent } from './db.js';

const clients = new Set();
const terminals = new Map(); // sid -> { ws, hostId }

export function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of clients) if (ws.readyState === 1) ws.send(data);
}

export function handleUiConnection(ws, user) {
  clients.add(ws);
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (typeof m.sid !== 'string' || m.sid.length > 64) return;
    const t = terminals.get(m.sid);
    if (m.type === 'term_open') {
      if (t || !isOnline(m.host_id)) return ws.send(JSON.stringify({ type: 'term_exit', sid: m.sid, reason: 'host offline' }));
      terminals.set(m.sid, { ws, hostId: m.host_id });
      sendToAgent(m.host_id, { type: 'term_open', sid: m.sid, cols: m.cols | 0 || 80, rows: m.rows | 0 || 24 });
      broadcast({ type: 'event', event: logEvent(m.host_id, 'info', `Terminal opened by ${user.username}`) });
      return;
    }
    if (!t || t.ws !== ws) return; // only the owner may drive a terminal
    if (m.type === 'term_input' && typeof m.data === 'string') sendToAgent(t.hostId, { type: 'term_input', sid: m.sid, data: m.data });
    else if (m.type === 'term_resize') sendToAgent(t.hostId, { type: 'term_resize', sid: m.sid, cols: m.cols | 0, rows: m.rows | 0 });
    else if (m.type === 'term_close') closeTerminal(m.sid, true);
  });
  ws.on('close', () => {
    clients.delete(ws);
    for (const [sid, t] of terminals) if (t.ws === ws) closeTerminal(sid, true);
  });
}

function closeTerminal(sid, tellAgent) {
  const t = terminals.get(sid);
  if (!t) return;
  terminals.delete(sid);
  if (tellAgent) sendToAgent(t.hostId, { type: 'term_close', sid });
}

/** Called by the agent side for term_output / term_exit messages. */
export function toTerminal(hostId, m) {
  const t = terminals.get(m.sid);
  if (!t || t.hostId !== hostId) return;
  if (t.ws.readyState === 1) t.ws.send(JSON.stringify(m));
  if (m.type === 'term_exit') closeTerminal(m.sid, false);
}

/** Agent disconnected: end all its terminals. */
export function endHostTerminals(hostId) {
  for (const [sid, t] of terminals) {
    if (t.hostId !== hostId) continue;
    if (t.ws.readyState === 1) t.ws.send(JSON.stringify({ type: 'term_exit', sid, reason: 'agent disconnected' }));
    terminals.delete(sid);
  }
}
