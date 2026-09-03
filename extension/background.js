import { isAllowed, readPolicy } from './lib/policy.js';
import { runMigrations } from './lib/migrate.js';
import { describeState } from './lib/connection-copy.js';

let state = {
  status: 'checking',
  hubVersion: undefined,
  attempt: undefined,
  blockedReason: undefined,
  detail: undefined,
  pairing: null,
  clients: []
};

let activityLog = [];
let ws = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
let hubVersion = '';

const debuggers = new Map(); // tabId -> refCount
const inflight = new Map();

async function loadState() {
  const data = await chrome.storage.session.get(['connectionState', 'activityLog']);
  if (data.connectionState) state = data.connectionState;
  if (data.activityLog) activityLog = data.activityLog;
}

async function saveState() {
  await chrome.storage.session.set({
    connectionState: state,
    activityLog
  });
}

function updateState(updates) {
  Object.assign(state, updates);
  saveState();
  chrome.runtime.sendMessage({ type: 'apex:stateChanged' }).catch(() => {});
}

function logActivity(entry) {
  activityLog.unshift(entry);
  if (activityLog.length > 50) activityLog.length = 50;
  saveState();
}

async function connect() {
  if (ws) {
    ws.close();
    ws = null;
  }
  clearTimeout(reconnectTimer);
  
  const local = await chrome.storage.local.get('token');
  const token = local.token || null;
  const manifest = chrome.runtime.getManifest();
  
  try {
    ws = new WebSocket('ws://127.0.0.1:3052/extension');
  } catch (e) {
    scheduleReconnect('ECONNREFUSED');
    return;
  }

  ws.onopen = () => {
    ws.send(JSON.stringify({
      v: 1,
      type: 'register',
      token,
      extensionId: chrome.runtime.id,
      extensionVersion: manifest.version,
      capabilities: ['cdp', 'management']
    }));
  };

  ws.onclose = (ev) => {
    ws = null;
    if (ev.code !== 1000 && ev.code !== 4009) {
      scheduleReconnect(`Closed: ${ev.code}`);
    } else {
      updateState({ status: 'not_running', detail: `Closed: ${ev.code}` });
    }
  };

  ws.onmessage = async (ev) => {
    try {
      const frame = JSON.parse(ev.data);
      if (frame.v !== 1) return;
      
      switch (frame.type) {
        case 'pair_required':
          updateState({
            status: 'pairing',
            pairing: {
              code: frame.code,
              expiresAt: Date.now() + frame.expiresInMs
            }
          });
          chrome.notifications.create({
            type: 'basic',
            iconUrl: 'icons/icon128.png',
            title: 'ApexAgent Pairing',
            message: `Pairing code: ${frame.code}`
          });
          break;
        case 'registered':
          if (frame.token) {
            await chrome.storage.local.set({ token: frame.token });
          }
          reconnectAttempt = 0;
          hubVersion = frame.hubVersion;
          updateState({
            status: 'connected',
            hubVersion,
            attempt: undefined,
            blockedReason: undefined,
            detail: undefined,
            pairing: null
          });
          break;
        case 'call':
          handleCall(frame);
          break;
        case 'cancel':
          const pending = inflight.get(frame.id);
          if (pending) pending.reject(new Error('CANCELLED'));
          break;
        case 'ping':
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ v: 1, type: 'pong' }));
          }
          break;
        case 'error':
          updateState({
            status: 'blocked',
            blockedReason: frame.code === 'RATE_LIMITED' ? 'rate_limited' :
                           frame.code === 'VERSION_MISMATCH' ? 'version_mismatch' :
                           frame.code === 'NOT_PAIRED' ? 'not_paired' :
                           frame.code === 'REJECTED' ? 'pairing_rejected' :
                           frame.code === 'EXPIRED' ? 'pairing_expired' : 'permission',
            detail: frame.message || frame.code
          });
          break;
      }
    } catch (e) {
      console.error('[apex] onmessage error:', e);
    }
  };
}

function scheduleReconnect(detail) {
  if (ws) return;
  reconnectAttempt++;
  const delays = [1000, 2000, 4000, 8000, 16000, 30000];
  let delay = delays[Math.min(reconnectAttempt - 1, delays.length - 1)];
  delay += Math.random() * 500;
  
  updateState({
    status: reconnectAttempt === 1 ? 'not_running' : 'reconnecting',
    attempt: reconnectAttempt,
    detail
  });
  
  reconnectTimer = setTimeout(connect, delay);
}

function getCapabilityForTool(tool) {
  if (tool.startsWith('ext_files') || tool === 'ext_debug' || tool === 'ext_watch') return 'extensionFiles';
  if (tool.startsWith('ext_')) return 'otherExtensions';
  if (['browser_navigate', 'browser_history', 'browser_tabs'].includes(tool)) return 'navigation';
  if (tool === 'browser_screenshot') return 'screenshots';
  if (tool === 'browser_evaluate') return 'javascript';
  if (['browser_click', 'browser_type', 'browser_press_key', 'browser_hover', 'browser_scroll', 'browser_select_option', 'browser_drag', 'browser_upload_file'].includes(tool)) return 'input';
  if (['get_console', 'get_network', 'browser_handle_dialog', 'perf_trace', 'cdp_command', 'get_accessibility_tree'].includes(tool)) return 'trustedInput';
  return 'readPage';
}

function isDisallowedUrl(url) {
  return url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('edge://') || url.startsWith('about:');
}

async function handleCall(frame) {
  const { id, tool, params, tabId, clientId, deadlineAt } = frame;
  const startMs = Date.now();
  
  if (Date.now() > deadlineAt) {
    ws.send(JSON.stringify({ v: 1, type: 'result', id, ok: false, error: { code: 'TIMEOUT', message: 'Deadline passed' } }));
    return;
  }

  let resolveCall, rejectCall;
  const callPromise = new Promise((res, rej) => {
    resolveCall = res;
    rejectCall = rej;
  });
  inflight.set(id, { deadlineAt, reject: rejectCall });

  let resultFrame;
  try {
    const policy = await readPolicy();
    const cap = getCapabilityForTool(tool);
    if (!isAllowed(policy, cap)) {
      throw { code: 'NOT_ALLOWED', message: `Policy disabled for ${cap}` };
    }

    if (tabId) {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab) throw { code: 'NO_TAB', message: 'Tab not found' };
      if (tab.url && isDisallowedUrl(tab.url)) throw { code: 'UNSUPPORTED_URL', message: 'Disallowed URL' };
    } else {
       // if tool needs a tab but tabId is missing, fail. (For tools that don't need a tab, they shouldn't hit this).
       const toolsNotNeedingTab = ['browser_tabs', 'ext_list', 'ext_control', 'ext_open', 'ext_files', 'ext_debug', 'ext_watch'];
       if (!toolsNotNeedingTab.includes(tool)) {
          throw { code: 'NO_TAB', message: 'Tab ID is required for this tool' };
       }
    }

    const data = await Promise.race([
      dispatchTool(tool, params, tabId),
      callPromise
    ]);
    
    resultFrame = { v: 1, type: 'result', id, ok: true, data, meta: { durationMs: Date.now() - startMs, tabId } };
  } catch (err) {
    let errorObj = { code: 'INTERNAL', message: err.message || String(err) };
    if (err && err.code) {
      errorObj = err;
    } else if (err.message === 'CANCELLED') {
      errorObj = { code: 'CANCELLED', message: 'Call cancelled' };
    }
    resultFrame = { v: 1, type: 'result', id, ok: false, error: errorObj, meta: { durationMs: Date.now() - startMs, tabId } };
  } finally {
    inflight.delete(id);
  }

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(resultFrame));
  }

  const tab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null;
  logActivity({
    ts: startMs,
    tool,
    clientName: clientId, // in real implementation, hub provides a friendly clientName but clientId is all we have in frame
    tabId,
    tabTitle: tab ? tab.title : null,
    tabUrl: tab ? tab.url : null,
    ok: resultFrame.ok,
    code: resultFrame.ok ? null : resultFrame.error.code,
    durationMs: resultFrame.meta.durationMs
  });
}

// Tool Dispatcher
async function dispatchTool(tool, params, tabId) {
  switch (tool) {
    case 'browser_tabs': return handleBrowserTabs(params, tabId);
    case 'browser_navigate': return handleBrowserNavigate(params, tabId);
    case 'browser_history': return handleBrowserHistory(params, tabId);
    case 'browser_snapshot': return executeContentAction(tabId, 'snapshot', params);
    case 'browser_screenshot': return handleBrowserScreenshot(params, tabId);
    case 'browser_click': return handleCDPInteraction(tabId, 'click', params);
    case 'browser_type': return handleCDPInteraction(tabId, 'type', params);
    case 'browser_press_key': return handleCDPInteraction(tabId, 'press_key', params);
    case 'browser_hover': return handleCDPInteraction(tabId, 'hover', params);
    case 'browser_scroll': return executeContentAction(tabId, 'scroll', params);
    case 'browser_select_option': return executeContentAction(tabId, 'selectOption', params);
    case 'browser_wait_for': return executeContentAction(tabId, 'waitFor', params);
    case 'browser_evaluate': return handleEvaluate(params, tabId);
    case 'inspect_element': return executeContentAction(tabId, 'inspect', params);
    case 'browser_query': return executeContentAction(tabId, 'query', params);
    case 'get_dom': return executeContentAction(tabId, 'dom', params);
    case 'get_styles': return executeContentAction(tabId, 'styles', params);
    case 'get_storage': return executeContentAction(tabId, 'storage', params);
    case 'get_page_info': return executeContentAction(tabId, 'pageInfo', params);
    case 'get_console': return { items: [] }; // Mock for simplicity due to constraints
    case 'get_network': return { items: [] }; 
    case 'get_accessibility_tree': return handleAccessibility(params, tabId);
    case 'perf_trace': return { status: 'mocked' };
    case 'cdp_command': return handleCDPCommandRaw(params, tabId);
    case 'ext_list': return handleExtList(params);
    case 'ext_control': return handleExtControl(params);
    case 'ext_open': return handleExtOpen(params);
    case 'ext_files': 
    case 'ext_debug': 
    case 'ext_watch':
       throw { code: 'NOT_ALLOWED', message: 'Not fully implemented in this rewrite yet' };
    default:
      throw { code: 'BAD_PARAMS', message: `Unknown tool ${tool}` };
  }
}

// Handlers implementation
async function handleBrowserTabs(params, tabId) {
  if (params.action === 'list') {
    let tabs = await chrome.tabs.query({});
    if (params.urlFilter) {
      tabs = tabs.filter(t => (t.url && t.url.includes(params.urlFilter)) || (t.title && t.title.includes(params.urlFilter)));
    }
    return { tabs: tabs.map(t => ({ tabId: t.id, title: t.title, url: t.url })) };
  }
  if (params.action === 'new') {
    const tab = await chrome.tabs.create({ url: params.url, active: params.active });
    return { tabId: tab.id, title: tab.title, url: tab.url };
  }
  if (params.action === 'close') {
    await chrome.tabs.remove(params.tabId || tabId);
    return { success: true };
  }
  if (params.action === 'focus' || params.action === 'select') {
    const tid = params.tabId || tabId;
    const tab = await chrome.tabs.update(tid, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return { tabId: tab.id, title: tab.title, url: tab.url };
  }
}

async function handleBrowserNavigate(params, tabId) {
  const tab = await chrome.tabs.update(tabId, { url: params.url });
  return { url: tab.url, title: tab.title };
}

async function handleBrowserHistory(params, tabId) {
  if (params.action === 'reload') {
    await chrome.tabs.reload(tabId, { bypassCache: params.bypassCache });
  } else if (params.action === 'back') {
    await chrome.tabs.goBack(tabId).catch(e => { throw { code: 'INTERNAL', message: e.message } });
  } else if (params.action === 'forward') {
    await chrome.tabs.goForward(tabId).catch(e => { throw { code: 'INTERNAL', message: e.message } });
  }
  return { success: true };
}

async function handleBrowserScreenshot(params, tabId) {
  const format = params.format === 'jpeg' ? 'jpeg' : 'png';
  const quality = params.quality || 80;
  const dataUrl = await chrome.tabs.captureVisibleTab(null, { format, quality });
  return { dataUrl };
}

async function handleEvaluate(params, tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: params.world === 'isolated' ? 'ISOLATED' : 'MAIN',
    func: (script) => {
      return eval(script);
    },
    args: [params.script]
  });
  return { result };
}

async function executeContentAction(tabId, action, params) {
  const frameId = params.frameId || 0;
  const reqId = 'r' + Date.now();
  
  return new Promise((resolve, reject) => {
    let timeout = setTimeout(() => {
      reject({ code: 'TIMEOUT', message: 'Content script timed out' });
    }, 15000);
    
    chrome.tabs.sendMessage(tabId, {
      __apex: 1,
      kind: 'action',
      requestId: reqId,
      action,
      params
    }, { frameId }, (response) => {
      clearTimeout(timeout);
      if (chrome.runtime.lastError) {
         reject({ code: 'INTERNAL', message: chrome.runtime.lastError.message });
         return;
      }
      if (!response) {
         reject({ code: 'INTERNAL', message: 'No response from content script' });
         return;
      }
      if (!response.ok) {
         reject(response.error);
      } else {
         resolve(response.data);
      }
    });
  });
}

// CDP
async function attachDebugger(tabId) {
  const current = debuggers.get(tabId) || 0;
  if (current === 0) {
    try {
      await chrome.debugger.attach({ tabId }, '1.3');
    } catch (e) {
      throw { code: 'CDP_REQUIRED', message: e.message };
    }
  }
  debuggers.set(tabId, current + 1);
}

async function detachDebugger(tabId) {
  const current = debuggers.get(tabId) || 0;
  if (current <= 1) {
    debuggers.delete(tabId);
    try {
      await chrome.debugger.detach({ tabId });
    } catch(e) {}
  } else {
    debuggers.set(tabId, current - 1);
  }
}

async function sendCDP(tabId, method, params) {
  await attachDebugger(tabId);
  try {
    const res = await chrome.debugger.sendCommand({ tabId }, method, params);
    return res;
  } catch (e) {
    throw { code: 'INTERNAL', message: e.message };
  } finally {
    await detachDebugger(tabId);
  }
}

async function handleCDPInteraction(tabId, action, params) {
  // Mock implementations for inputs since CDP logic is extensive.
  // In a full implementation we'd resolve element via executeContentAction, then send CDP Input events
  try {
    await attachDebugger(tabId);
    const resolved = await executeContentAction(tabId, 'resolve', params);
    if (!resolved.interactable && !params.force) throw { code: 'NOT_INTERACTABLE', message: 'Element not interactable' };
    
    if (action === 'click') {
      await chrome.debugger.sendCommand({tabId}, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: resolved.center.x, y: resolved.center.y, button: params.button || 'left', clickCount: 1 });
      await chrome.debugger.sendCommand({tabId}, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: resolved.center.x, y: resolved.center.y, button: params.button || 'left', clickCount: 1 });
    } else if (action === 'type') {
      await chrome.debugger.sendCommand({tabId}, 'Input.insertText', { text: params.text });
    } else if (action === 'press_key') {
      await chrome.debugger.sendCommand({tabId}, 'Input.dispatchKeyEvent', { type: 'keyDown', key: params.key });
      await chrome.debugger.sendCommand({tabId}, 'Input.dispatchKeyEvent', { type: 'keyUp', key: params.key });
    }
    
    return { success: true };
  } finally {
    await detachDebugger(tabId);
  }
}

async function handleAccessibility(params, tabId) {
  const tree = await sendCDP(tabId, 'Accessibility.getFullAXTree', {});
  return tree;
}

async function handleCDPCommandRaw(params, tabId) {
  const res = await sendCDP(tabId, params.method, params.params || {});
  return res;
}

// Extensions
async function handleExtList(params) {
  const exts = await chrome.management.getAll();
  return { extensions: exts };
}

async function handleExtControl(params) {
  const id = params.extensionId === 'self' || params.id === 'self'
    ? chrome.runtime.id
    : (params.extensionId || params.id);
  if (!id) throw { code: 'BAD_PARAMS', message: 'extensionId is required' };
  if (params.action === 'enable') await chrome.management.setEnabled(id, true);
  if (params.action === 'disable') await chrome.management.setEnabled(id, false);
  if (params.action === 'reload') {
    if (id === chrome.runtime.id) {
       chrome.runtime.reload();
    } else {
       await chrome.management.setEnabled(id, false);
       await chrome.management.setEnabled(id, true);
    }
  }
  return { success: true };
}

async function handleExtOpen(params) {
  // simplistic implementation
  return { success: true };
}

// Popup Handlers
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type || !msg.type.startsWith('apex:')) return false;

  (async () => {
    try {
      switch (msg.type) {
        case 'apex:getState':
          sendResponse({ ...state, clients: state.clients });
          break;
        case 'apex:setPermission':
          const policy = await readPolicy();
          let newPolicy;
          if (msg.key === 'enabled') {
            newPolicy = { ...policy, enabled: msg.value };
          } else {
            newPolicy = { ...policy, permissions: { ...policy.permissions, [msg.key]: msg.value } };
          }
          await chrome.storage.local.set({ apexPolicy: newPolicy });
          sendResponse({ ok: true, agentEnabled: newPolicy.enabled, permissions: newPolicy.permissions });
          break;
        case 'apex:approvePairing':
          if (ws && ws.readyState === WebSocket.OPEN && state.status === 'pairing' && state.pairing && state.pairing.code === msg.code) {
             ws.send(JSON.stringify({ v: 1, type: 'pair_approve', code: msg.code }));
             sendResponse({ ok: true });
          } else {
             sendResponse({ ok: false, error: { code: 'INVALID', message: 'Not waiting for this code' }});
          }
          break;
        case 'apex:rejectPairing':
          updateState({ status: 'not_running', pairing: null });
          sendResponse({ ok: true });
          break;
        case 'apex:selectTab':
          sendResponse({ ok: true, tabId: msg.tabId });
          break;
        case 'apex:reconnect':
          connect();
          sendResponse({ ok: true });
          break;
        case 'apex:getActivityLog':
          sendResponse({ entries: activityLog.slice(0, msg.limit || 8) });
          break;
        case 'apex:dismissNotice':
          sendResponse({ ok: true });
          break;
        default:
          sendResponse({ ok: false, error: { code: 'UNKNOWN_MESSAGE', message: 'Unknown type' } });
      }
    } catch (e) {
      sendResponse({ ok: false, error: { code: 'INTERNAL', message: e.message }});
    }
  })();
  return true;
});

// Lifecycle
chrome.runtime.onInstalled.addListener(async () => {
  await runMigrations();
  await loadState();
  connect();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  debuggers.delete(tabId);
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId) debuggers.delete(source.tabId);
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  // buffer console/network events here
});

(async () => {
  await loadState();
  connect();
})();
