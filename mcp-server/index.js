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

const TOOLS = [
  // Browser Control
  { name: 'browser_navigate', description: 'Navigate to URL', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'browser_click', description: 'Click element by CSS selector', inputSchema: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] } },
  { name: 'browser_type', description: 'Type text into element', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, text: { type: 'string' } }, required: ['selector', 'text'] } },
  { name: 'browser_snapshot', description: 'Get page snapshot with interactive elements', inputSchema: { type: 'object', properties: {} } },
  { name: 'browser_scroll', description: 'Scroll page', inputSchema: { type: 'object', properties: { direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, amount: { type: 'number' } } } },
  { name: 'browser_press_key', description: 'Press a keyboard key (Enter, Escape, ArrowUp, ArrowDown, Tab, etc.)', inputSchema: { type: 'object', properties: { key: { type: 'string', description: 'Key to press: Enter, Escape, Tab, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Backspace, Delete, Space, F1-F12, or any character' }, selector: { type: 'string', description: 'Optional element selector to focus before pressing' }, modifiers: { type: 'array', items: { type: 'string', enum: ['ctrl', 'shift', 'alt', 'meta'] }, description: 'Modifier keys to hold' }, repeat: { type: 'number', description: 'Number of times to press the key' } }, required: ['key'] } },
  { name: 'browser_evaluate', description: 'Run JavaScript code', inputSchema: { type: 'object', properties: { script: { type: 'string' } }, required: ['script'] } },
  { name: 'browser_screenshot', description: 'Take a screenshot of the current page', inputSchema: { type: 'object', properties: { fullPage: { type: 'boolean', description: 'Capture full scrollable page' } } } },
  { name: 'browser_click_by_text', description: 'Click an element by its text content', inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'Text to search for' }, tag: { type: 'string', description: 'Optional HTML tag filter (button, a, div, etc.)' }, exact: { type: 'boolean', description: 'Exact text match vs contains' }, index: { type: 'number', description: 'Which match to click if multiple (0-based)' } }, required: ['text'] } },
  { name: 'browser_wait_for_element', description: 'Wait for an element to appear in the DOM', inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'CSS selector to wait for' }, timeout: { type: 'number', description: 'Max wait time in ms (default: 10000)' }, visible: { type: 'boolean', description: 'Wait for element to be visible (default: true)' } }, required: ['selector'] } },
  { name: 'browser_execute_safe', description: 'Execute JavaScript in content script context (bypasses page CSP)', inputSchema: { type: 'object', properties: { code: { type: 'string', description: 'JavaScript code to execute' } }, required: ['code'] } },
  { name: 'browser_execute_on_element', description: 'Execute JavaScript on a specific element (CSP-safe)', inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'CSS selector of target element' }, code: { type: 'string', description: 'JavaScript code with "element" variable available' } }, required: ['selector', 'code'] } },
  
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
  { name: 'get_cookies', description: 'Get document cookies', inputSchema: { type: 'object', properties: {} } },
  
  // Extension Management (for extension developers)
  { name: 'list_extensions', description: 'List all installed extensions', inputSchema: { type: 'object', properties: { includeDisabled: { type: 'boolean', default: true } } } },
  { name: 'reload_extension', description: 'Reload an extension by ID (toggle off/on). Use "self" to reload Apex Agent', inputSchema: { type: 'object', properties: { extensionId: { type: 'string' } }, required: ['extensionId'] } },
  { name: 'get_extension_info', description: 'Get detailed info about an extension', inputSchema: { type: 'object', properties: { extensionId: { type: 'string' } }, required: ['extensionId'] } },
  { name: 'enable_extension', description: 'Enable an extension by ID', inputSchema: { type: 'object', properties: { extensionId: { type: 'string' } }, required: ['extensionId'] } },
  { name: 'disable_extension', description: 'Disable an extension by ID', inputSchema: { type: 'object', properties: { extensionId: { type: 'string' } }, required: ['extensionId'] } },
  
  // Extension Popup Interaction (for automated extension testing)
  { name: 'open_extension_popup', description: 'Open an extension popup as a tab for interaction', inputSchema: { type: 'object', properties: { extensionId: { type: 'string', description: 'Extension ID to open' }, popupPath: { type: 'string', description: 'Custom popup path if not standard (e.g., "src/popup.html")' } }, required: ['extensionId'] } },
  { name: 'open_extension_options', description: 'Open an extension options/settings page', inputSchema: { type: 'object', properties: { extensionId: { type: 'string' } }, required: ['extensionId'] } },
  { name: 'open_extension_devtools', description: 'Open extension management page to access DevTools', inputSchema: { type: 'object', properties: { extensionId: { type: 'string' } }, required: ['extensionId'] } },
  { name: 'open_extension_errors', description: 'Open extension errors page directly', inputSchema: { type: 'object', properties: { extensionId: { type: 'string' } }, required: ['extensionId'] } },
  { name: 'trigger_extension_action', description: 'Try to trigger extension action (open popup)', inputSchema: { type: 'object', properties: { extensionId: { type: 'string' } }, required: ['extensionId'] } },
  { name: 'get_extension_popup_content', description: 'Open extension popup and get its DOM snapshot', inputSchema: { type: 'object', properties: { extensionId: { type: 'string' }, popupPath: { type: 'string' } }, required: ['extensionId'] } },
  { name: 'interact_with_extension', description: 'Open extension popup and run a sequence of actions', inputSchema: { type: 'object', properties: { extensionId: { type: 'string' }, actions: { type: 'array', items: { type: 'object', properties: { type: { type: 'string', enum: ['click', 'type', 'snapshot', 'wait'] }, selector: { type: 'string' }, text: { type: 'string' }, ms: { type: 'number' }, delay: { type: 'number' } } }, description: 'Array of actions: {type, selector, text, ms, delay}' } }, required: ['extensionId', 'actions'] } },
  { name: 'close_tab', description: 'Close a browser tab by ID', inputSchema: { type: 'object', properties: { tabId: { type: 'number' } }, required: ['tabId'] } },
  
  // CDP DevTools (Chrome DevTools Protocol - true DevTools access)
  { name: 'cdp_attach', description: 'Attach Chrome DevTools Protocol debugger to current tab (shows debugging banner)', inputSchema: { type: 'object', properties: {} } },
  { name: 'cdp_detach', description: 'Detach CDP debugger from current tab', inputSchema: { type: 'object', properties: {} } },
  { name: 'cdp_command', description: 'Send raw CDP command (advanced)', inputSchema: { type: 'object', properties: { method: { type: 'string', description: 'CDP method like DOM.getDocument, Network.enable' }, params: { type: 'object', description: 'CDP method parameters' } }, required: ['method'] } },
  { name: 'get_event_listeners', description: 'Get all event listeners attached to an element (click, keydown, etc.)', inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'CSS selector of element to inspect' } }, required: ['selector'] } },
  { name: 'start_network_monitor', description: 'Start monitoring network requests via CDP', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_network_requests', description: 'Get captured network requests (after starting monitor)', inputSchema: { type: 'object', properties: {} } },
  { name: 'start_cpu_profile', description: 'Start CPU profiling', inputSchema: { type: 'object', properties: {} } },
  { name: 'stop_cpu_profile', description: 'Stop CPU profiling and get results', inputSchema: { type: 'object', properties: {} } },
  { name: 'take_heap_snapshot', description: 'Take a heap memory snapshot', inputSchema: { type: 'object', properties: {} } },
  { name: 'set_dom_breakpoint', description: 'Set a DOM breakpoint on element mutations', inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'CSS selector' }, type: { type: 'string', enum: ['subtree-modified', 'attribute-modified', 'node-removed'], default: 'subtree-modified' } }, required: ['selector'] } },
  { name: 'remove_dom_breakpoint', description: 'Remove a DOM breakpoint', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, type: { type: 'string', enum: ['subtree-modified', 'attribute-modified', 'node-removed'], default: 'subtree-modified' } }, required: ['selector'] } },
  { name: 'start_css_coverage', description: 'Start tracking CSS coverage (unused CSS rules)', inputSchema: { type: 'object', properties: {} } },
  { name: 'stop_css_coverage', description: 'Stop CSS coverage and get results', inputSchema: { type: 'object', properties: {} } },
  { name: 'start_js_coverage', description: 'Start tracking JavaScript coverage', inputSchema: { type: 'object', properties: {} } },
  { name: 'stop_js_coverage', description: 'Stop JS coverage and get results', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_cdp_console_logs', description: 'Get console logs captured via CDP (more detailed than content script)', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_performance_metrics', description: 'Get detailed performance metrics via CDP', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_accessibility_tree', description: 'Get accessibility tree for page or element', inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'Optional CSS selector to focus on specific element' } } } },
  { name: 'get_layer_tree', description: 'Get compositing layer information', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_animations', description: 'Get active CSS/JS animations', inputSchema: { type: 'object', properties: {} } }
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

rl.on('close', () => {
  // Don't exit if we have WebSocket clients - keep server running for extension
  log('Stdin closed. WebSocket server still running...');
});

// Start WebSocket server immediately
startWsServer();

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
        serverInfo: { name: 'apex-agent', version: '1.6.0' },
        capabilities: { tools: {} }
      }
    });
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
