import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, resolve, extname, sep } from 'node:path';
import { WebSocketServer } from 'ws';
import { handleApi, HttpError } from './api.js';
import { userFromRequest } from './auth.js';
import { authenticateAgent, handleAgentConnection } from './agents.js';
import { handleUiConnection } from './ui.js';
import { startScheduler } from './scheduler.js';
import { startDiscordBot } from './discord.js';

const root = resolve(import.meta.dirname, '..');
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.sh': 'text/x-shellscript; charset=utf-8', '.py': 'text/x-python; charset=utf-8', '.svg': 'image/svg+xml' };
// Explicit file map for things served outside public/.
const EXTRA = {
  '/install.sh': 'agent/install.sh',
  '/agent/uc-agent.py': 'agent/uc-agent.py',
  '/vendor/xterm.js': 'node_modules/@xterm/xterm/lib/xterm.js',
  '/vendor/xterm.css': 'node_modules/@xterm/xterm/css/xterm.css',
  '/vendor/addon-fit.js': 'node_modules/@xterm/addon-fit/lib/addon-fit.js',
};
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
};

async function serveStatic(res, pathname) {
  const pub = join(root, 'public');
  let file = EXTRA[pathname] ? join(root, EXTRA[pathname]) : resolve(pub, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!EXTRA[pathname] && !file.startsWith(pub + sep)) file = join(pub, 'index.html');
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
    res.end(data);
  } catch {
    res.writeHead(404, SECURITY_HEADERS).end('not found');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/api/')) return serveStatic(res, url.pathname);
  try {
    const result = await handleApi(req, res, url);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
    res.end(JSON.stringify(result ?? {}));
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: status === 500 ? 'internal error' : e.message }));
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://x');
  const reject = (code) => { socket.write(`HTTP/1.1 ${code} Unauthorized\r\n\r\n`); socket.destroy(); };
  if (pathname === '/ws/agent') {
    const hostId = authenticateAgent(req);
    if (!hostId) return reject(401);
    return wss.handleUpgrade(req, socket, head, (ws) => handleAgentConnection(ws, hostId));
  }
  if (pathname === '/ws/ui') {
    const user = userFromRequest(req);
    // Origin must match Host: blocks cross-site WebSocket hijacking.
    let originHost = null;
    try { originHost = new URL(req.headers.origin).host; } catch { /* missing/invalid */ }
    if (!user || originHost !== req.headers.host) return reject(401);
    return wss.handleUpgrade(req, socket, head, (ws) => handleUiConnection(ws, user));
  }
  socket.destroy();
});

server.listen(PORT, HOST, () => console.log(`Update Center hub on http://${HOST}:${PORT}`));
startScheduler();
startDiscordBot().catch((e) => console.error('Discord bot failed to start:', e.message));
