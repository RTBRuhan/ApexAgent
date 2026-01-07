#!/usr/bin/env node

import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { connect } from 'net';
import { createInterface } from 'readline';

const PORT = parseInt(process.env.PORT) || 3052;
const log = (m) => process.stderr.write(`[MCP] ${m}\n`);

let chromeClient = null;
let pendingRequests = new Map();
let requestId = 0;
let serverStarted = false;

const TOOLS = [
  // Browser Control
  { name: 'browser_navigate', description: 'Navigate to URL', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'browser_click', description: 'Click element by CSS selector', inputSchema: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] } },
  { name: 'browser_type', description: 'Type text into element', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, text: { type: 'string' } }, required: ['selector', 'text'] } },
  { name: 'browser_snapshot', description: 'Get page snapshot with interactive elements', inputSchema: { type: 'object', properties: {} } },
  { name: 'browser_scroll', description: 'Scroll page', inputSchema: { type: 'object', properties: { direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, amount: { type: 'number' } } } },
  { name: 'browser_evaluate', description: 'Run JavaScript code', inputSchema: { type: 'object', properties: { script: { type: 'string' } }, required: ['script'] } },
  
  // DevTools Inspection
  { name: 'inspect_element', description: 'Deep inspect element - get computed styles, box model, attributes', inputSchema: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] } },
  { name: 'get_dom_tree', description: 'Get DOM tree structure from element or document', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, depth: { type: 'number', default: 3 } } } },
  { name: 'get_computed_styles', description: 'Get computed CSS styles for element', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, properties: { type: 'array', items: { type: 'string' } } }, required: ['selector'] } },
  { name: 'get_element_html', description: 'Get innerHTML or outerHTML of element', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, outer: { type: 'boolean', default: true } }, required: ['selector'] } },
  { name: 'query_all', description: 'Find all elements matching selector', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, limit: { type: 'number', default: 20 } }, required: ['selector'] } },
  { name: 'find_by_text', description: 'Find elements containing text', inputSchema: { type: 'object', properties: { text: { type: 'string' }, tag: { type: 'string' } }, required: ['text'] } },
  { name: 'get_attributes', description: 'Get all attributes and data-* properties', inputSchema: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] } },
  
  // Page Info
  { name: 'get_page_metrics', description: 'Get page performance metrics, element counts, memory', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_console_logs', description: 'Get captured console logs (log, warn, error)', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_network_info', description: 'Get network requests and performance timing', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_storage', description: 'Get localStorage or sessionStorage contents', inputSchema: { type: 'object', properties: { type: { type: 'string', enum: ['local', 'session'], default: 'local' } } } },
  { name: 'get_cookies', description: 'Get document cookies', inputSchema: { type: 'object', properties: {} } }
];

// ============ STDIN - Handle line-based JSON (what Cursor actually sends) ============
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });

rl.on('line', (line) => {
  if (!line.trim()) return;
  log(`Got line: ${line.slice(0, 80)}`);
  
  try {
    const msg = JSON.parse(line);
    handleMcp(msg);
  } catch (e) {
    log(`Parse error: ${e.message}`);
  }
});

rl.on('close', () => process.exit(0));

log('Ready');

// ============ MCP PROTOCOL ============

function sendMcp(obj) {
  const s = JSON.stringify(obj);
  // Send as line-based JSON (matching what Cursor sends)
  process.stdout.write(s + '\n');
  log(`Sent: ${obj.id ? 'id=' + obj.id : 'notification'}`);
}

function handleMcp(msg) {
  const { id, method, params } = msg;
  log(`Method: ${method}`);
  
  if (method === 'initialize') {
    sendMcp({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        serverInfo: { name: 'chrome-debug-hand', version: '1.0.0' },
        capabilities: { tools: {} }
      }
    });
    if (!serverStarted) {
      serverStarted = true;
      setTimeout(startWsServer, 50);
    }
    return;
  }
  
  if (method === 'notifications/initialized') return;
  
  if (method === 'tools/list') {
    sendMcp({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }
  
  if (method === 'tools/call') {
    const { name, arguments: args } = params;
    log(`Tool: ${name}`);
    callTool(name, args || {}).then(result => {
      let text;
      if (result.error) text = `Error: ${result.error}`;
      else if (result.elements) {
        text = `URL: ${result.url}\nTitle: ${result.title}\n\nElements:\n`;
        result.elements.slice(0, 30).forEach(e => {
          text += `[${e.ref}] <${e.tag}> ${(e.text || '').slice(0, 30)}\n`;
        });
      } else text = JSON.stringify(result, null, 2);
      
      sendMcp({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
    });
    return;
  }
  
  if (method === 'resources/list') {
    sendMcp({ jsonrpc: '2.0', id, result: { resources: [] } });
    return;
  }
  
  if (method === 'prompts/list') {
    sendMcp({ jsonrpc: '2.0', id, result: { prompts: [] } });
    return;
  }
  
  sendMcp({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unknown' } });
}

// ============ WEBSOCKET ============

function startWsServer() {
  const checker = connect({ port: PORT, host: '127.0.0.1' });
  checker.on('connect', () => { checker.end(); connectAsClient(); });
  checker.on('error', () => {
    const httpServer = createServer();
    const wss = new WebSocketServer({ server: httpServer });
    wss.on('error', () => {});
    httpServer.on('error', () => {});
    wss.on('connection', (ws) => {
      log('Extension connected');
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'register') {
            chromeClient = ws;
            log('Extension registered');
            ws.send(JSON.stringify({ type: 'registered' }));
          } else if (msg.type === 'tool_result') {
            const p = pendingRequests.get(msg.id);
            if (p) { p(msg.result); pendingRequests.delete(msg.id); }
          }
        } catch (e) {}
      });
      ws.on('close', () => { if (ws === chromeClient) chromeClient = null; });
    });
    httpServer.listen(PORT, '127.0.0.1', () => log(`WS:${PORT}`));
  });
  setTimeout(() => checker.destroy(), 200);
}

function connectAsClient() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  ws.on('open', () => {
    log('WS client mode');
    chromeClient = ws;
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'tool_result') {
          const p = pendingRequests.get(msg.id);
          if (p) { p(msg.result); pendingRequests.delete(msg.id); }
        }
      } catch (e) {}
    });
  });
  ws.on('error', () => {});
}

async function callTool(name, args) {
  if (!chromeClient || chromeClient.readyState !== WebSocket.OPEN) {
    return { error: 'Extension not connected. Open extension popup and click Connect.' };
  }
  const id = ++requestId;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pendingRequests.delete(id); resolve({ error: 'Timeout' }); }, 30000);
    pendingRequests.set(id, (r) => { clearTimeout(timer); resolve(r); });
    chromeClient.send(JSON.stringify({ type: 'tool_call', id, tool: name, params: args }));
  });
}
