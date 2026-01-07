// Chrome MCP - Background Service Worker
// Handles communication between popup, content scripts, and MCP server

// State
let mcpServerRunning = false;
let mcpPort = 3052;
let mcpHost = 'localhost';
let agentEnabled = false;
let agentPermissions = {};
let mcpWebSocket = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
let shouldReconnect = false;

const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAY = 3000;

// ============ BADGE STATUS ============
function updateBadge(connected, reconnecting = false) {
  if (connected) {
    chrome.action.setBadgeText({ text: '●' });
    chrome.action.setBadgeBackgroundColor({ color: '#22c55e' }); // Green
    chrome.action.setTitle({ title: 'Chrome MCP - Connected' });
  } else if (reconnecting) {
    chrome.action.setBadgeText({ text: '◐' });
    chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' }); // Orange
    chrome.action.setTitle({ title: 'Chrome MCP - Reconnecting...' });
  } else {
    chrome.action.setBadgeText({ text: '○' });
    chrome.action.setBadgeBackgroundColor({ color: '#666666' }); // Gray
    chrome.action.setTitle({ title: 'Chrome MCP - Disconnected' });
  }
}

// Initialize
chrome.runtime.onInstalled.addListener(() => {
  console.log('Chrome MCP installed');
  updateBadge(false);
  
  chrome.storage.local.set({
    isRecording: false,
    recordLog: [],
    mcpPort: 3052,
    mcpHost: 'localhost',
    agentEnabled: false,
    autoReconnect: true
  });
});

// Set initial badge state
updateBadge(false);

// ============ MESSAGE HANDLER ============
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse);
  return true;
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case 'GET_MCP_STATUS':
      return { connected: mcpServerRunning, reconnecting: reconnectTimer !== null };
    
    case 'START_MCP_SERVER':
      shouldReconnect = true;
      reconnectAttempts = 0;
      return await startMCPServer(message.port, message.host);
    
    case 'STOP_MCP_SERVER':
      shouldReconnect = false;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      return await stopMCPServer();
    
    case 'SET_AGENT_ENABLED':
      agentEnabled = message.enabled;
      agentPermissions = message.permissions || {};
      return { success: true };
    
    case 'GET_AGENT_STATUS':
      return { enabled: agentEnabled, permissions: agentPermissions };
    
    case 'LOG_ENTRY':
      chrome.runtime.sendMessage({ type: 'LOG_ENTRY', entry: message.entry }).catch(() => {});
      return { success: true };
    
    case 'GET_ACTIVE_TAB':
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return tab;
    
    case 'NAVIGATE':
      return await navigateTab(message.url, message.tabId);
    
    case 'TAKE_SCREENSHOT':
      return await takeScreenshot(message.options);
    
    case 'EXECUTE_SCRIPT':
      return await executeScript(message.tabId, message.script);
    
    case 'GET_TAB_INFO':
      return await getTabInfo(message.tabId);
    
    case 'AGENT_ACTION':
      return await forwardAgentAction(message.action, message.tabId);
    
    default:
      return { error: 'Unknown message type' };
  }
}

// ============ MCP SERVER CONNECTION ============
async function startMCPServer(port, host) {
  try {
    mcpPort = port || 3052;
    mcpHost = host || 'localhost';
    
    // Clear any existing reconnect timer
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    
    return new Promise((resolve) => {
      try {
        mcpWebSocket = new WebSocket(`ws://${mcpHost}:${mcpPort}`);
      } catch (e) {
        updateBadge(false);
        resolve({ success: false, error: 'Invalid WebSocket URL' });
        return;
      }
      
      mcpWebSocket.onopen = () => {
        mcpServerRunning = true;
        reconnectAttempts = 0;
        updateBadge(true);
        console.log(`Connected to MCP server on ${mcpHost}:${mcpPort}`);
        
        mcpWebSocket.send(JSON.stringify({
          type: 'register',
          client: 'chrome-mcp'
        }));
        
        // Start keepalive ping
        startKeepalive();
        
        resolve({ success: true, port: mcpPort, host: mcpHost });
      };
      
      mcpWebSocket.onerror = (error) => {
        console.error('MCP WebSocket error:', error);
        mcpServerRunning = false;
        updateBadge(false);
        resolve({ success: false, error: 'Failed to connect. Make sure MCP server is running.' });
      };
      
      mcpWebSocket.onclose = (event) => {
        console.log('WebSocket closed:', event.code, event.reason);
        mcpServerRunning = false;
        stopKeepalive();
        
        // Auto-reconnect if enabled
        if (shouldReconnect && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          reconnectAttempts++;
          updateBadge(false, true);
          console.log(`Reconnecting... attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`);
          
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            startMCPServer(mcpPort, mcpHost);
          }, RECONNECT_DELAY);
        } else {
          updateBadge(false);
        }
        
        chrome.runtime.sendMessage({ type: 'MCP_STATUS_CHANGED', connected: false }).catch(() => {});
      };
      
      mcpWebSocket.onmessage = (event) => {
        try {
          handleMCPMessage(JSON.parse(event.data));
        } catch (e) {
          console.error('Failed to parse MCP message:', e);
        }
      };
      
      setTimeout(() => {
        if (!mcpServerRunning && mcpWebSocket?.readyState === WebSocket.CONNECTING) {
          mcpWebSocket.close();
          updateBadge(false);
          resolve({ success: false, error: 'Connection timeout.' });
        }
      }, 5000);
    });
  } catch (error) {
    updateBadge(false);
    return { success: false, error: error.message };
  }
}

// Keepalive ping to prevent disconnection
let keepaliveInterval = null;

function startKeepalive() {
  stopKeepalive();
  keepaliveInterval = setInterval(() => {
    if (mcpWebSocket && mcpWebSocket.readyState === WebSocket.OPEN) {
      mcpWebSocket.send(JSON.stringify({ type: 'ping' }));
    }
  }, 30000); // Ping every 30 seconds
}

function stopKeepalive() {
  if (keepaliveInterval) {
    clearInterval(keepaliveInterval);
    keepaliveInterval = null;
  }
}

async function stopMCPServer() {
  stopKeepalive();
  if (mcpWebSocket) {
    mcpWebSocket.close();
    mcpWebSocket = null;
  }
  mcpServerRunning = false;
  updateBadge(false);
  return { success: true };
}

async function handleMCPMessage(message) {
  console.log('MCP message:', message);
  
  if (message.type === 'pong') {
    return; // Keepalive response
  }
  
  if (message.type === 'tool_call') {
    const result = await executeToolCall(message.tool, message.params);
    
    if (mcpWebSocket && mcpWebSocket.readyState === WebSocket.OPEN) {
      mcpWebSocket.send(JSON.stringify({
        type: 'tool_result',
        id: message.id,
        result
      }));
    }
  }
}

async function executeToolCall(tool, params) {
  if (!agentEnabled && tool !== 'browser_snapshot' && tool !== 'get_page_info') {
    return { error: 'Agent control is disabled' };
  }
  
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    return { error: 'No active tab' };
  }
  
  try {
    switch (tool) {
      case 'browser_navigate':
        return await navigateTab(params.url);
      
      case 'browser_click':
        return await forwardAgentAction({
          type: 'CLICK',
          selector: params.selector || params.ref,
          options: params
        });
      
      case 'browser_type':
        return await forwardAgentAction({
          type: 'TYPE',
          selector: params.selector || params.ref,
          text: params.text,
          options: params
        });
      
      case 'browser_scroll':
        return await forwardAgentAction({
          type: 'SCROLL',
          selector: params.selector || 'window',
          options: params
        });
      
      case 'browser_hover':
        return await forwardAgentAction({
          type: 'HOVER',
          selector: params.selector || params.ref
        });
      
      case 'browser_snapshot':
        return await forwardAgentAction({ type: 'GET_SNAPSHOT' });
      
      case 'browser_evaluate':
        return await forwardAgentAction({
          type: 'EVALUATE',
          script: params.script || params.code
        });
      
      case 'browser_wait':
        return await forwardAgentAction({
          type: 'WAIT',
          condition: params,
          timeout: params.timeout
        });
      
      case 'browser_screenshot':
        return await takeScreenshot(params);
      
      case 'get_page_info':
        return await forwardAgentAction({ type: 'GET_PAGE_STATE' });
      
      case 'get_element_info':
        return await chrome.tabs.sendMessage(tab.id, {
          type: 'GET_ELEMENT_INFO',
          selector: params.selector
        });
      
      // ===== DEVTOOLS INSPECTION TOOLS =====
      case 'inspect_element':
        return await forwardAgentAction({
          type: 'INSPECT_ELEMENT',
          selector: params.selector
        });
      
      case 'get_dom_tree':
        return await forwardAgentAction({
          type: 'GET_DOM_TREE',
          selector: params.selector || null,
          depth: params.depth || 3
        });
      
      case 'get_computed_styles':
        return await forwardAgentAction({
          type: 'GET_COMPUTED_STYLES',
          selector: params.selector,
          properties: params.properties || null
        });
      
      case 'get_element_html':
        return await forwardAgentAction({
          type: 'GET_ELEMENT_HTML',
          selector: params.selector,
          outer: params.outer !== false
        });
      
      case 'query_all':
        return await forwardAgentAction({
          type: 'QUERY_ALL',
          selector: params.selector,
          limit: params.limit || 20
        });
      
      case 'get_console_logs':
        return await forwardAgentAction({ type: 'GET_CONSOLE_LOGS' });
      
      case 'get_network_info':
        return await forwardAgentAction({ type: 'GET_NETWORK_INFO' });
      
      case 'get_storage':
        return await forwardAgentAction({
          type: 'GET_STORAGE',
          storageType: params.type || 'local'
        });
      
      case 'get_cookies':
        return await forwardAgentAction({ type: 'GET_COOKIES' });
      
      case 'get_page_metrics':
        return await forwardAgentAction({ type: 'GET_PAGE_METRICS' });
      
      case 'find_by_text':
        return await forwardAgentAction({
          type: 'FIND_BY_TEXT',
          text: params.text,
          tag: params.tag || null
        });
      
      case 'get_attributes':
        return await forwardAgentAction({
          type: 'GET_ATTRIBUTES',
          selector: params.selector
        });
      
      default:
        return { error: `Unknown tool: ${tool}` };
    }
  } catch (error) {
    return { error: error.message };
  }
}

// ============ TAB OPERATIONS ============
async function navigateTab(url, tabId) {
  try {
    if (!agentPermissions.navigation && agentEnabled) {
      return { error: 'Navigation not permitted' };
    }
    
    if (tabId) {
      await chrome.tabs.update(tabId, { url });
    } else {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        await chrome.tabs.update(tab.id, { url });
      }
    }
    
    return new Promise(resolve => {
      chrome.tabs.onUpdated.addListener(function listener(updatedTabId, info) {
        if (info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve({ success: true, url });
        }
      });
      setTimeout(() => resolve({ success: true, url }), 10000);
    });
  } catch (error) {
    return { error: error.message };
  }
}

async function takeScreenshot(options = {}) {
  try {
    if (!agentPermissions.screenshot && agentEnabled) {
      return { error: 'Screenshots not permitted' };
    }
    
    const dataUrl = await chrome.tabs.captureVisibleTab(null, {
      format: options.format || 'png',
      quality: options.quality || 90
    });
    
    return { success: true, dataUrl };
  } catch (error) {
    return { error: error.message };
  }
}

async function executeScript(tabId, script) {
  try {
    if (!agentPermissions.scripts && agentEnabled) {
      return { error: 'Script execution not permitted' };
    }
    
    const targetTabId = tabId || (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
    if (!targetTabId) return { error: 'No target tab' };
    
    const results = await chrome.scripting.executeScript({
      target: { tabId: targetTabId },
      func: (code) => { try { return eval(code); } catch (e) { return { error: e.message }; } },
      args: [script]
    });
    
    return { success: true, result: results[0]?.result };
  } catch (error) {
    return { error: error.message };
  }
}

async function getTabInfo(tabId) {
  try {
    const targetTabId = tabId || (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
    if (!targetTabId) return { error: 'No target tab' };
    
    const tab = await chrome.tabs.get(targetTabId);
    return { id: tab.id, url: tab.url, title: tab.title, active: tab.active, status: tab.status };
  } catch (error) {
    return { error: error.message };
  }
}

async function forwardAgentAction(action, tabId) {
  try {
    const targetTabId = tabId || (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
    if (!targetTabId) return { error: 'No target tab' };
    
    const result = await chrome.tabs.sendMessage(targetTabId, { type: 'AGENT_ACTION', action });
    
    chrome.runtime.sendMessage({
      type: 'AGENT_ACTIVITY',
      action: { type: action.type, details: JSON.stringify(action).slice(0, 100) }
    }).catch(() => {});
    
    return result;
  } catch (error) {
    return { error: error.message };
  }
}

// ============ EVENT LISTENERS ============
chrome.runtime.onConnectExternal.addListener((port) => {
  port.onMessage.addListener(async (message) => {
    const result = await handleMessage(message, port.sender);
    port.postMessage(result);
  });
});

chrome.webNavigation.onCompleted.addListener((details) => {
  if (details.frameId === 0) {
    chrome.storage.local.get('isRecording', ({ isRecording }) => {
      if (isRecording) {
        chrome.storage.local.get('recordLog', ({ recordLog = [] }) => {
          recordLog.push({
            type: 'NAVIGATION',
            details: `Page loaded: ${details.url}`,
            timestamp: Date.now(),
            url: details.url
          });
          chrome.storage.local.set({ recordLog });
        });
      }
    });
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && mcpServerRunning && mcpWebSocket) {
    try {
      mcpWebSocket.send(JSON.stringify({
        type: 'page_changed',
        url: tab.url,
        title: tab.title
      }));
    } catch (e) {
      console.error('Failed to send page_changed:', e);
    }
  }
});

// Service worker keepalive - prevent idle termination
chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') {
    // Just keep the service worker alive
    console.log('Keepalive tick');
  }
});

console.log('Chrome MCP started');
