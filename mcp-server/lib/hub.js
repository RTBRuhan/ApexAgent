import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WebSocketServer } from 'ws';
import { ERROR_CODES } from './tools.js';

const PORT = parseInt(process.env.APEX_PORT || '3052', 10);
const CONFIG_DIR = path.join(os.homedir(), '.apex-agent');
const TOKEN_FILE = path.join(CONFIG_DIR, 'token');
const PAIRING_FILE = path.join(CONFIG_DIR, 'pairing-code');
const LOCK_FILE = path.join(CONFIG_DIR, 'hub.lock');
const HUB_VERSION = '2.0.0';

export function log(level, ...args) {
  console.error(`[${new Date().toISOString()}] [${level}]`, ...args);
}

// Ensure ~/.apex-agent exists
function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { mode: 0o700, recursive: true });
  }
}

// Singletons
export function manageLock() {
  ensureConfigDir();
  if (fs.existsSync(LOCK_FILE)) {
    try {
      const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8'), 10);
      if (pid) {
        process.kill(pid, 0); // Throws ESRCH if not running
        log('INFO', `Hub already running with PID ${pid}. Exiting.`);
        process.exit(0);
      }
    } catch (e) {
      if (e.code !== 'ESRCH') {
        log('WARN', `Error reading lockfile: ${e.message}`);
      }
    }
  }
  
  fs.writeFileSync(LOCK_FILE, String(process.pid));
  
  const cleanup = () => {
    try {
      if (fs.existsSync(LOCK_FILE) && fs.readFileSync(LOCK_FILE, 'utf8') === String(process.pid)) {
        fs.unlinkSync(LOCK_FILE);
      }
    } catch (e) {}
    process.exit(0);
  };
  
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('exit', cleanup);
}

// Token management
export function getToken() {
  ensureConfigDir();
  if (!fs.existsSync(TOKEN_FILE)) {
    const token = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  }
  return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
}

// State
export const clients = new Set();
export const requestMap = new Map(); // hubId -> { client, rid }
export const eventBuffers = new Map(); // tabId -> { console: [], network: [], dialog: [] }
export const blockedExtensions = new Map(); // extensionId -> block expiry time

let extensionWs = null;
let extensionInfo = null;
let pendingPairing = null;
let hubIdSeq = 0;
let clientIdSeq = 0;
let keepaliveInterval = null;

// Helpers
function send(ws, frame) {
  if (ws && ws.readyState === 1 /* OPEN */) {
    ws.send(JSON.stringify(frame));
  }
}

function handleUnsupportedProtocol(ws) {
  send(ws, {
    v: 1, type: 'error',
    code: 'UNSUPPORTED_PROTOCOL',
    message: ERROR_CODES.UNSUPPORTED_PROTOCOL.hint
  });
  ws.close(1002, 'Unsupported protocol version');
}

function broadcastEvent(frame) {
  for (const client of clients) {
    send(client.ws, frame);
  }
}

function getTabBuffers(tabId) {
  if (!eventBuffers.has(tabId)) {
    eventBuffers.set(tabId, { console: [], network: [], dialog: [] });
  }
  return eventBuffers.get(tabId);
}

// Server setup
export const server = http.createServer((req, res) => {
  res.writeHead(404);
  res.end('Not Found');
});

export const wssClient = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
export const wssExtension = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });

server.on('upgrade', (request, socket, head) => {
  const origin = request.headers.origin;
  const url = new URL(request.url, 'http://localhost');

  if (url.pathname === '/client') {
    if (origin) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      return socket.destroy();
    }
    const token = url.searchParams.get('token');
    if (token !== getToken()) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      return socket.destroy();
    }
    wssClient.handleUpgrade(request, socket, head, (ws) => {
      wssClient.emit('connection', ws, request);
    });
  } else if (url.pathname === '/extension') {
    if (!origin || !origin.startsWith('chrome-extension://')) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      return socket.destroy();
    }
    wssExtension.handleUpgrade(request, socket, head, (ws) => {
      wssExtension.emit('connection', ws, request);
    });
  } else {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  }
});

// Client Logic
wssClient.on('connection', (ws) => {
  const client = {
    ws,
    id: `client-${++clientIdSeq}`,
    tabId: null,
    inflight: new Set(),
    info: null
  };
  clients.add(client);

  ws.on('message', (message) => {
    try {
      const frame = JSON.parse(message);
      if (frame.v !== 1) return handleUnsupportedProtocol(ws);

      switch (frame.type) {
        case 'hello':
          client.info = { name: frame.clientName, version: frame.clientVersion, pid: frame.pid };
          send(ws, {
            v: 1, type: 'welcome',
            hubVersion: HUB_VERSION,
            clientId: client.id,
            extension: extensionInfo ? { connected: true, extensionVersion: extensionInfo.version, capabilities: extensionInfo.capabilities } : { connected: false },
            peers: clients.size - 1
          });
          break;

        case 'ping':
          send(ws, { v: 1, type: 'pong' });
          break;

        case 'call': {
          if (!extensionWs) {
            send(ws, {
              v: 1, type: 'result', rid: frame.rid, ok: false,
              error: { code: 'NO_EXTENSION', message: 'No extension connected.', hint: ERROR_CODES.NO_EXTENSION.hint, retryable: ERROR_CODES.NO_EXTENSION.retryable }
            });
            return;
          }
          if (extensionInfo && !extensionInfo.paired) {
            send(ws, {
              v: 1, type: 'result', rid: frame.rid, ok: false,
              error: { code: 'NOT_PAIRED', message: 'Extension not paired.', hint: ERROR_CODES.NOT_PAIRED.hint, retryable: ERROR_CODES.NOT_PAIRED.retryable }
            });
            return;
          }

          const hubId = `h${++hubIdSeq}`;
          requestMap.set(hubId, { client, rid: frame.rid });
          client.inflight.add(hubId);

          let tabId = frame.tabId !== undefined ? frame.tabId : client.tabId;
          
          if (frame.tool === 'browser_tabs' && frame.params && frame.params.action === 'select' && frame.params.tabId !== undefined) {
            client.tabId = frame.params.tabId;
            tabId = frame.params.tabId;
          }
          
          const params = frame.params && typeof frame.params === 'object' ? { ...frame.params } : {};
          if (params.extensionId && params.id === undefined) {
            params.id = params.extensionId;
          }
          send(extensionWs, {
            v: 1, type: 'call', id: hubId,
            tool: frame.tool,
            params,
            tabId: tabId,
            clientId: client.id,
            deadlineAt: Date.now() + Math.max(1000, Math.min(300000, frame.timeoutMs || 30000))
          });
          break;
        }

        case 'cancel': {
          let targetHubId = null;
          for (const [hId, req] of requestMap.entries()) {
            if (req.client === client && req.rid === frame.rid) {
              targetHubId = hId;
              break;
            }
          }
          if (targetHubId && extensionWs) {
            send(extensionWs, { v: 1, type: 'cancel', id: targetHubId });
            requestMap.delete(targetHubId);
            client.inflight.delete(targetHubId);
          }
          break;
        }

        default:
          log('WARN', `Unknown frame type from client: ${frame.type}`);
      }
    } catch (e) {
      log('ERROR', `Client message parse error: ${e.message}`);
    }
  });

  ws.on('close', () => {
    clients.delete(client);
    if (extensionWs) {
      for (const hubId of client.inflight) {
        send(extensionWs, { v: 1, type: 'cancel', id: hubId });
        requestMap.delete(hubId);
      }
    }
  });
});

// Extension Logic
wssExtension.on('connection', (ws) => {
  if (extensionWs && extensionWs.readyState === 1) {
    extensionWs.close(4009, 'REPLACED');
  }
  
  extensionWs = ws;
  let extensionId = '';
  let pingPongTimeout = null;

  function resetPingTimeout() {
    clearTimeout(pingPongTimeout);
    pingPongTimeout = setTimeout(() => {
      log('WARN', 'Extension keepalive timeout. Disconnecting.');
      ws.close();
    }, 10000);
  }

  ws.on('message', (message) => {
    try {
      const frame = JSON.parse(message);
      if (frame.v !== 1) return handleUnsupportedProtocol(ws);

      switch (frame.type) {
        case 'register': {
          extensionId = frame.extensionId;
          const blockedUntil = blockedExtensions.get(extensionId);
          if (blockedUntil && Date.now() < blockedUntil) {
            ws.close(1008, 'Blocked due to failed pairing');
            return;
          }

          if (frame.token === getToken()) {
            extensionInfo = { version: frame.extensionVersion, capabilities: frame.capabilities, paired: true };
            send(ws, { v: 1, type: 'registered', token: getToken(), hubVersion: HUB_VERSION });
            broadcastEvent({ v: 1, type: 'event', event: 'extension_state', data: { connected: true, reason: 'registered' }});
          } else {
            const code = Math.floor(100000 + Math.random() * 900000).toString();
            pendingPairing = {
              code,
              expiresAt: Date.now() + 120000,
              attempts: 0,
              extensionId,
              version: frame.extensionVersion,
              capabilities: frame.capabilities
            };
            ensureConfigDir();
            fs.writeFileSync(PAIRING_FILE, code, { mode: 0o600 });
            log('INFO', `Pairing code required: ${code}`);
            send(ws, { v: 1, type: 'pair_required', code, expiresInMs: 120000 });
          }
          break;
        }

        case 'pair_approve': {
          if (!pendingPairing || pendingPairing.extensionId !== extensionId || Date.now() > pendingPairing.expiresAt) {
            return;
          }
          if (frame.code === pendingPairing.code) {
            extensionInfo = { version: pendingPairing.version, capabilities: pendingPairing.capabilities, paired: true };
            send(ws, { v: 1, type: 'registered', token: getToken(), hubVersion: HUB_VERSION });
            pendingPairing = null;
            try { fs.unlinkSync(PAIRING_FILE); } catch(e){}
            broadcastEvent({ v: 1, type: 'event', event: 'extension_state', data: { connected: true, reason: 'paired' }});
          } else {
            pendingPairing.attempts++;
            if (pendingPairing.attempts >= 3) {
              blockedExtensions.set(extensionId, Date.now() + 60000);
              pendingPairing = null;
              ws.close(1008, 'Too many failed pairing attempts');
            }
          }
          break;
        }

        case 'result': {
          const req = requestMap.get(frame.id);
          if (req) {
            requestMap.delete(frame.id);
            req.client.inflight.delete(frame.id);
            
            const clientMsg = {
              v: 1, type: 'result', rid: req.rid, ok: frame.ok
            };
            if (frame.ok) {
              clientMsg.data = frame.data;
              if (frame.meta) clientMsg.meta = frame.meta;
            } else {
              clientMsg.error = frame.error;
            }
            send(req.client.ws, clientMsg);
          }
          break;
        }

        case 'event': {
          const tabId = frame.data && frame.data.tabId;
          if (tabId && ['console', 'network', 'dialog'].includes(frame.event)) {
            const bufs = getTabBuffers(tabId);
            if (bufs[frame.event]) {
              bufs[frame.event].push(frame.data);
              if (bufs[frame.event].length > 500) bufs[frame.event].shift();
            }
          }
          broadcastEvent(frame);
          break;
        }

        case 'pong':
          resetPingTimeout();
          break;

        default:
          log('WARN', `Unknown frame type from extension: ${frame.type}`);
      }
    } catch (e) {
      log('ERROR', `Extension message parse error: ${e.message}`);
    }
  });

  ws.on('close', () => {
    clearTimeout(pingPongTimeout);
    if (extensionWs === ws) {
      extensionWs = null;
      extensionInfo = null;
      broadcastEvent({ v: 1, type: 'event', event: 'extension_state', data: { connected: false, reason: 'socket_closed' }});
    }
  });

  resetPingTimeout();
});

keepaliveInterval = setInterval(() => {
  if (extensionWs && extensionWs.readyState === 1) {
    send(extensionWs, { v: 1, type: 'ping' });
  }
}, 20000);

// CLI Entrypoint
if (import.meta.url && (import.meta.url === `file://${process.argv[1]}` || import.meta.url.replace(/\\/g, '/').endsWith(process.argv[1]?.replace(/\\/g, '/')))) {
  manageLock();
  server.listen(PORT, '127.0.0.1', () => {
    log('INFO', `Hub listening on ws://127.0.0.1:${PORT}`);
  });
}
