// Apex Agent - Background Service Worker
// Handles communication between popup, content scripts, and MCP server

// State
let mcpServerRunning = false;
let mcpPort = 3052;
let mcpHost = 'localhost';
let agentEnabled = true;
let agentPermissions = {
  mouse: true,
  keyboard: true,
  navigation: true,
  scripts: true,
  screenshot: true,
  showCursor: true,
  highlightTarget: true,
  showTooltips: true
};
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
    chrome.action.setTitle({ title: 'Apex Agent - Connected' });
  } else if (reconnecting) {
    chrome.action.setBadgeText({ text: '◐' });
    chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' }); // Orange
    chrome.action.setTitle({ title: 'Apex Agent - Reconnecting...' });
  } else {
    chrome.action.setBadgeText({ text: '○' });
    chrome.action.setBadgeBackgroundColor({ color: '#666666' }); // Gray
    chrome.action.setTitle({ title: 'Apex Agent - Disconnected' });
  }
}

// Initialize
chrome.runtime.onInstalled.addListener(() => {
  console.log('Apex Agent installed');
  updateBadge(false);
  
  chrome.storage.local.set({
    isRecording: false,
    recordLog: [],
    mcpPort: 3052,
    mcpHost: 'localhost',
    agentEnabled: true,
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
    case 'SIDEBAR_TOOL_CALL':
      // Handle tool calls from the AI sidebar
      return await executeToolCall(message.tool, message.params);
    
    case 'OPEN_SIDEBAR':
      // Open the side panel
      try {
        await chrome.sidePanel.open({ windowId: (await chrome.windows.getCurrent()).id });
        return { success: true };
      } catch (e) {
        return { error: e.message };
      }
    
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
          client: 'apex-agent'
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
  // Extension management tools don't require agent to be enabled
  const noAgentRequired = [
    'browser_snapshot', 'get_page_info', 
    'list_extensions', 'reload_extension', 'get_extension_info', 
    'enable_extension', 'disable_extension',
    'open_extension_popup', 'open_extension_options', 'open_extension_devtools',
    'open_extension_errors', 'trigger_extension_action', 'get_extension_popup_content', 
    'interact_with_extension', 'close_tab', 'cdp_attach', 'cdp_detach', 'cdp_command'
  ];
  
  if (!agentEnabled && !noAgentRequired.includes(tool)) {
    return { error: 'Agent control is disabled' };
  }
  
  // Tools that manage their own tabs or don't need one
  const noTabRequired = [
    'list_extensions', 'reload_extension', 'get_extension_info',
    'enable_extension', 'disable_extension',
    'open_extension_popup', 'open_extension_options', 'open_extension_devtools',
    'open_extension_errors', 'trigger_extension_action', 'get_extension_popup_content', 
    'interact_with_extension', 'close_tab'
  ];
  
  let tab = null;
  if (!noTabRequired.includes(tool)) {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab) {
      return { error: 'No active tab' };
    }
    tab = activeTab;
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
      
      case 'browser_press_key':
        return await forwardAgentAction({
          type: 'PRESS_KEY',
          key: params.key,
          options: {
            selector: params.selector || params.ref,
            modifiers: params.modifiers || [],
            repeat: params.repeat || 1,
            delay: params.delay || 50
          }
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
      
      case 'browser_click_by_text':
        return await forwardAgentAction({
          type: 'CLICK_BY_TEXT',
          text: params.text,
          options: {
            tag: params.tag,
            exact: params.exact || false,
            index: params.index || 0
          }
        });
      
      case 'browser_wait_for_element':
        return await forwardAgentAction({
          type: 'WAIT_FOR_ELEMENT',
          selector: params.selector,
          options: {
            timeout: params.timeout || 10000,
            visible: params.visible !== false
          }
        });
      
      case 'browser_execute_safe':
        return await forwardAgentAction({
          type: 'EXECUTE_SAFE',
          code: params.code || params.script
        });
      
      case 'browser_execute_on_element':
        return await forwardAgentAction({
          type: 'EXECUTE_ON_ELEMENT',
          selector: params.selector,
          code: params.code || params.script
        });
      
      case 'get_attributes':
        return await forwardAgentAction({
          type: 'GET_ATTRIBUTES',
          selector: params.selector
        });
      
      // ===== EXTENSION MANAGEMENT TOOLS =====
      case 'list_extensions':
        return await listExtensions(params.includeDisabled);
      
      case 'reload_extension':
        return await reloadExtension(params.extensionId);
      
      case 'get_extension_info':
        return await getExtensionInfo(params.extensionId);
      
      case 'enable_extension':
        return await setExtensionEnabled(params.extensionId, true);
      
      case 'disable_extension':
        return await setExtensionEnabled(params.extensionId, false);
      
      // ===== EXTENSION POPUP INTERACTION =====
      case 'open_extension_popup':
        return await openExtensionPopup(params.extensionId, params);
      
      case 'open_extension_options':
        return await openExtensionOptionsPage(params.extensionId);
      
      case 'open_extension_devtools':
        return await openExtensionDevTools(params.extensionId);
      
      case 'open_extension_errors':
        return await openExtensionErrors(params.extensionId);
      
      case 'trigger_extension_action':
        return await triggerExtensionAction(params.extensionId);
      
      case 'get_extension_popup_content':
        return await getExtensionPopupContent(params.extensionId, params);
      
      case 'interact_with_extension':
        return await interactWithExtensionPopup(params.extensionId, params.actions || []);
      
      case 'close_tab':
        return await closeExtensionTab(params.tabId);
      
      // ===== CDP DEVTOOLS TOOLS =====
      case 'cdp_attach':
        return await attachDebugger(tab.id);
      
      case 'cdp_detach':
        return await detachDebugger(tab.id);
      
      case 'cdp_command':
        return await sendCDPCommand(tab.id, params.method, params.params || {});
      
      case 'get_event_listeners':
        return await getEventListeners(tab.id, params.selector);
      
      case 'start_network_monitor':
        return await startNetworkMonitoring(tab.id);
      
      case 'get_network_requests':
        return await getNetworkRequests(tab.id);
      
      case 'start_cpu_profile':
        return await startCPUProfile(tab.id);
      
      case 'stop_cpu_profile':
        return await stopCPUProfile(tab.id);
      
      case 'take_heap_snapshot':
        return await takeHeapSnapshot(tab.id);
      
      case 'set_dom_breakpoint':
        return await setDOMBreakpoint(tab.id, params.selector, params.type || 'subtree-modified');
      
      case 'remove_dom_breakpoint':
        return await removeDOMBreakpoint(tab.id, params.selector, params.type || 'subtree-modified');
      
      case 'start_css_coverage':
        return await startCSSCoverage(tab.id);
      
      case 'stop_css_coverage':
        return await stopCSSCoverage(tab.id);
      
      case 'start_js_coverage':
        return await startJSCoverage(tab.id);
      
      case 'stop_js_coverage':
        return await stopJSCoverage(tab.id);
      
      case 'get_cdp_console_logs':
        return await getCDPConsoleLogs(tab.id);
      
      case 'get_performance_metrics':
        return await getPerformanceMetrics(tab.id);
      
      case 'get_accessibility_tree':
        return await getAccessibilityTree(tab.id, params.selector);
      
      case 'get_layer_tree':
        return await getLayerTree(tab.id);
      
      case 'get_animations':
        return await getAnimations(tab.id);
      
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

// ============ EXTENSION MANAGEMENT ============
async function listExtensions(includeDisabled = true) {
  try {
    const extensions = await chrome.management.getAll();
    const filtered = extensions.filter(ext => {
      // Exclude self
      if (ext.id === chrome.runtime.id) return false;
      // Filter by enabled state if requested
      if (!includeDisabled && !ext.enabled) return false;
      return true;
    });
    
    return filtered.map(ext => ({
      id: ext.id,
      name: ext.name,
      version: ext.version,
      enabled: ext.enabled,
      type: ext.type,
      description: ext.description?.slice(0, 100),
      hasErrors: ext.installType === 'development' // Dev extensions might have errors
    }));
  } catch (error) {
    return { error: error.message };
  }
}

async function reloadExtension(extensionId) {
  try {
    if (!extensionId) {
      return { error: 'Extension ID is required' };
    }
    
    // Special case: reload self
    if (extensionId === chrome.runtime.id || extensionId === 'self') {
      // Can't use management API on self, use runtime.reload
      chrome.runtime.reload();
      return { success: true, message: 'Self-reload triggered' };
    }
    
    // Get extension info first to check if it exists
    const extInfo = await chrome.management.get(extensionId);
    if (!extInfo) {
      return { error: `Extension ${extensionId} not found` };
    }
    
    // Toggle OFF then ON to force reload
    await chrome.management.setEnabled(extensionId, false);
    await new Promise(resolve => setTimeout(resolve, 100)); // Brief pause
    await chrome.management.setEnabled(extensionId, true);
    
    return { 
      success: true, 
      message: `Extension ${extInfo.name} (${extensionId}) reloaded`,
      extension: {
        id: extensionId,
        name: extInfo.name,
        enabled: true
      }
    };
  } catch (error) {
    return { error: error.message };
  }
}

async function getExtensionInfo(extensionId) {
  try {
    if (!extensionId) {
      return { error: 'Extension ID is required' };
    }
    
    const ext = await chrome.management.get(extensionId);
    
    return {
      id: ext.id,
      name: ext.name,
      version: ext.version,
      description: ext.description,
      enabled: ext.enabled,
      type: ext.type,
      installType: ext.installType,
      mayDisable: ext.mayDisable,
      permissions: ext.permissions,
      hostPermissions: ext.hostPermissions,
      homepageUrl: ext.homepageUrl,
      updateUrl: ext.updateUrl,
      offlineEnabled: ext.offlineEnabled,
      icons: ext.icons
    };
  } catch (error) {
    return { error: error.message };
  }
}

async function setExtensionEnabled(extensionId, enabled) {
  try {
    if (!extensionId) {
      return { error: 'Extension ID is required' };
    }
    
    await chrome.management.setEnabled(extensionId, enabled);
    const ext = await chrome.management.get(extensionId);
    
    return {
      success: true,
      message: `Extension ${ext.name} ${enabled ? 'enabled' : 'disabled'}`,
      extension: {
        id: extensionId,
        name: ext.name,
        enabled: ext.enabled
      }
    };
  } catch (error) {
    return { error: error.message };
  }
}

// ============ EXTENSION POPUP INTERACTION ============
async function openExtensionPopup(extensionId, options = {}) {
  try {
    if (!extensionId) {
      return { error: 'Extension ID is required' };
    }
    
    // Get extension info to find popup URL
    const ext = await chrome.management.get(extensionId);
    if (!ext) {
      return { error: `Extension ${extensionId} not found` };
    }
    
    // Construct popup URL - standard locations
    const popupUrls = [
      `chrome-extension://${extensionId}/popup.html`,
      `chrome-extension://${extensionId}/popup/popup.html`,
      `chrome-extension://${extensionId}/index.html`,
      `chrome-extension://${extensionId}/src/popup.html`,
      `chrome-extension://${extensionId}/dist/popup.html`
    ];
    
    // Use custom path if provided
    if (options.popupPath) {
      popupUrls.unshift(`chrome-extension://${extensionId}/${options.popupPath}`);
    }
    
    // Try to open the popup as a new tab
    let tab = null;
    for (const url of popupUrls) {
      try {
        tab = await chrome.tabs.create({ 
          url, 
          active: true,
          windowId: options.windowId
        });
        
        // Wait for tab to load
        await new Promise((resolve) => {
          const listener = (tabId, info) => {
            if (tabId === tab.id && info.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(listener);
              resolve();
            }
          };
          chrome.tabs.onUpdated.addListener(listener);
          setTimeout(resolve, 5000); // Timeout after 5s
        });
        
        // Check if page loaded successfully (not error page)
        const updatedTab = await chrome.tabs.get(tab.id);
        if (!updatedTab.url?.includes('chrome-error://')) {
          return {
            success: true,
            tabId: tab.id,
            url: updatedTab.url,
            extensionName: ext.name,
            message: `Opened ${ext.name} popup in tab ${tab.id}`
          };
        }
      } catch (e) {
        // Try next URL
        continue;
      }
    }
    
    return { error: `Could not find popup for extension ${ext.name}. Try specifying popupPath.` };
  } catch (error) {
    return { error: error.message };
  }
}

async function openExtensionOptionsPage(extensionId) {
  try {
    if (!extensionId) {
      return { error: 'Extension ID is required' };
    }
    
    const ext = await chrome.management.get(extensionId);
    if (!ext) {
      return { error: `Extension ${extensionId} not found` };
    }
    
    if (!ext.optionsUrl) {
      return { error: `Extension ${ext.name} has no options page` };
    }
    
    const tab = await chrome.tabs.create({ url: ext.optionsUrl, active: true });
    
    // Wait for load
    await new Promise((resolve) => {
      const listener = (tabId, info) => {
        if (tabId === tab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(resolve, 5000);
    });
    
    return {
      success: true,
      tabId: tab.id,
      url: ext.optionsUrl,
      extensionName: ext.name,
      message: `Opened ${ext.name} options page in tab ${tab.id}`
    };
  } catch (error) {
    return { error: error.message };
  }
}

async function openExtensionDevTools(extensionId) {
  try {
    if (!extensionId) {
      return { error: 'Extension ID is required' };
    }
    
    // Open the extension's service worker/background page in DevTools
    // This opens chrome://extensions/?id=extensionId
    const url = `chrome://extensions/?id=${extensionId}`;
    const tab = await chrome.tabs.create({ url, active: true });
    
    return {
      success: true,
      tabId: tab.id,
      url,
      message: `Opened extension management page for ${extensionId}. Click "Inspect views" to see service worker.`
    };
  } catch (error) {
    return { error: error.message };
  }
}

async function openExtensionErrors(extensionId) {
  try {
    if (!extensionId) {
      return { error: 'Extension ID is required' };
    }
    
    // Open the extension errors page directly
    const url = `chrome://extensions/?id=${extensionId}&errors`;
    const tab = await chrome.tabs.create({ url, active: true });
    
    return {
      success: true,
      tabId: tab.id,
      url,
      message: `Opened extension errors page for ${extensionId}.`
    };
  } catch (error) {
    return { error: error.message };
  }
}

async function triggerExtensionAction(extensionId) {
  try {
    if (!extensionId) {
      return { error: 'Extension ID is required' };
    }
    
    // Note: chrome.action.openPopup() requires user gesture in most browsers
    // We'll try it, but fallback to opening as tab
    try {
      // This only works for the current extension or with special permissions
      await chrome.action.openPopup();
      return { success: true, message: 'Popup triggered via action API' };
    } catch (e) {
      // Fallback: open as tab
      return await openExtensionPopup(extensionId);
    }
  } catch (error) {
    return { error: error.message };
  }
}

async function getExtensionPopupContent(extensionId, options = {}) {
  try {
    // First open the popup
    const result = await openExtensionPopup(extensionId, options);
    if (result.error) return result;
    
    // Give it a moment to render
    await new Promise(r => setTimeout(r, 500));
    
    // Get snapshot of the popup content
    const snapshot = await forwardAgentAction({ type: 'GET_SNAPSHOT' }, result.tabId);
    
    return {
      ...result,
      snapshot
    };
  } catch (error) {
    return { error: error.message };
  }
}

async function interactWithExtensionPopup(extensionId, actions) {
  try {
    // Open popup first
    const openResult = await openExtensionPopup(extensionId);
    if (openResult.error) return openResult;
    
    const tabId = openResult.tabId;
    const results = [];
    
    // Wait for popup to fully load
    await new Promise(r => setTimeout(r, 500));
    
    // Execute each action in sequence
    for (const action of actions) {
      let result;
      switch (action.type) {
        case 'click':
          result = await forwardAgentAction({
            type: 'CLICK',
            selector: action.selector,
            options: action.options || {}
          }, tabId);
          break;
        case 'type':
          result = await forwardAgentAction({
            type: 'TYPE',
            selector: action.selector,
            text: action.text,
            options: action.options || {}
          }, tabId);
          break;
        case 'snapshot':
          result = await forwardAgentAction({ type: 'GET_SNAPSHOT' }, tabId);
          break;
        case 'wait':
          await new Promise(r => setTimeout(r, action.ms || 500));
          result = { success: true, waited: action.ms || 500 };
          break;
        default:
          result = { error: `Unknown action type: ${action.type}` };
      }
      
      results.push({ action: action.type, result });
      
      // Small delay between actions
      if (action.delay) {
        await new Promise(r => setTimeout(r, action.delay));
      }
    }
    
    return {
      success: true,
      extensionId,
      tabId,
      results
    };
  } catch (error) {
    return { error: error.message };
  }
}

async function closeExtensionTab(tabId) {
  try {
    await chrome.tabs.remove(tabId);
    return { success: true, message: `Tab ${tabId} closed` };
  } catch (error) {
    return { error: error.message };
  }
}

// ============ CDP DEBUGGER MANAGER ============
let debuggerAttached = new Map(); // tabId -> { attached, domains }

async function attachDebugger(tabId) {
  if (debuggerAttached.get(tabId)?.attached) {
    return { success: true, already: true };
  }
  
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    debuggerAttached.set(tabId, { attached: true, domains: new Set() });
    console.log(`CDP debugger attached to tab ${tabId}`);
    return { success: true };
  } catch (error) {
    return { error: error.message };
  }
}

async function detachDebugger(tabId) {
  if (!debuggerAttached.get(tabId)?.attached) {
    return { success: true, already: true };
  }
  
  try {
    await chrome.debugger.detach({ tabId });
    debuggerAttached.delete(tabId);
    console.log(`CDP debugger detached from tab ${tabId}`);
    return { success: true };
  } catch (error) {
    return { error: error.message };
  }
}

async function sendCDPCommand(tabId, method, params = {}) {
  // Auto-attach if not attached
  if (!debuggerAttached.get(tabId)?.attached) {
    const attachResult = await attachDebugger(tabId);
    if (attachResult.error) return attachResult;
  }
  
  try {
    const result = await chrome.debugger.sendCommand({ tabId }, method, params);
    return result;
  } catch (error) {
    return { error: error.message };
  }
}

async function enableCDPDomain(tabId, domain) {
  const tabData = debuggerAttached.get(tabId);
  if (tabData?.domains?.has(domain)) {
    return { success: true, already: true };
  }
  
  const result = await sendCDPCommand(tabId, `${domain}.enable`);
  if (!result?.error) {
    tabData?.domains?.add(domain);
  }
  return result;
}

// CDP-based Event Listeners
async function getEventListeners(tabId, selector) {
  try {
    await enableCDPDomain(tabId, 'DOM');
    await enableCDPDomain(tabId, 'DOMDebugger');
    
    // Get document
    const doc = await sendCDPCommand(tabId, 'DOM.getDocument', { depth: 0 });
    if (doc?.error) return doc;
    
    // Query for element
    const nodeResult = await sendCDPCommand(tabId, 'DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector: selector
    });
    
    if (nodeResult?.error || !nodeResult?.nodeId) {
      return { error: `Element not found: ${selector}` };
    }
    
    // Resolve to object for getEventListeners
    const objResult = await sendCDPCommand(tabId, 'DOM.resolveNode', {
      nodeId: nodeResult.nodeId
    });
    
    if (objResult?.error) return objResult;
    
    // Get event listeners
    const listeners = await sendCDPCommand(tabId, 'DOMDebugger.getEventListeners', {
      objectId: objResult.object.objectId,
      depth: 1,
      pierce: true
    });
    
    if (listeners?.error) return listeners;
    
    return {
      selector,
      listeners: listeners.listeners?.map(l => ({
        type: l.type,
        useCapture: l.useCapture,
        passive: l.passive,
        once: l.once,
        handler: l.handler?.description?.slice(0, 200),
        scriptId: l.scriptId,
        lineNumber: l.lineNumber,
        columnNumber: l.columnNumber
      })) || []
    };
  } catch (error) {
    return { error: error.message };
  }
}

// CDP Network monitoring
let networkRequests = new Map(); // tabId -> requests[]

async function startNetworkMonitoring(tabId) {
  try {
    await enableCDPDomain(tabId, 'Network');
    networkRequests.set(tabId, []);
    return { success: true, message: 'Network monitoring started' };
  } catch (error) {
    return { error: error.message };
  }
}

async function getNetworkRequests(tabId) {
  return {
    requests: networkRequests.get(tabId) || [],
    count: (networkRequests.get(tabId) || []).length
  };
}

// CDP Performance profiling
async function startCPUProfile(tabId) {
  try {
    await enableCDPDomain(tabId, 'Profiler');
    await sendCDPCommand(tabId, 'Profiler.start');
    return { success: true, message: 'CPU profiling started' };
  } catch (error) {
    return { error: error.message };
  }
}

async function stopCPUProfile(tabId) {
  try {
    const profile = await sendCDPCommand(tabId, 'Profiler.stop');
    return { success: true, profile };
  } catch (error) {
    return { error: error.message };
  }
}

// CDP Heap profiling
async function takeHeapSnapshot(tabId) {
  try {
    await enableCDPDomain(tabId, 'HeapProfiler');
    
    let chunks = [];
    // Note: In real implementation, we'd need to handle events
    await sendCDPCommand(tabId, 'HeapProfiler.takeHeapSnapshot', {
      reportProgress: false
    });
    
    return { success: true, message: 'Heap snapshot taken' };
  } catch (error) {
    return { error: error.message };
  }
}

// CDP DOM breakpoints
async function setDOMBreakpoint(tabId, selector, type = 'subtree-modified') {
  try {
    await enableCDPDomain(tabId, 'DOM');
    await enableCDPDomain(tabId, 'DOMDebugger');
    
    const doc = await sendCDPCommand(tabId, 'DOM.getDocument', { depth: 0 });
    if (doc?.error) return doc;
    
    const nodeResult = await sendCDPCommand(tabId, 'DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector: selector
    });
    
    if (!nodeResult?.nodeId) {
      return { error: `Element not found: ${selector}` };
    }
    
    await sendCDPCommand(tabId, 'DOMDebugger.setDOMBreakpoint', {
      nodeId: nodeResult.nodeId,
      type: type // 'subtree-modified', 'attribute-modified', 'node-removed'
    });
    
    return { success: true, selector, type };
  } catch (error) {
    return { error: error.message };
  }
}

async function removeDOMBreakpoint(tabId, selector, type = 'subtree-modified') {
  try {
    const doc = await sendCDPCommand(tabId, 'DOM.getDocument', { depth: 0 });
    if (doc?.error) return doc;
    
    const nodeResult = await sendCDPCommand(tabId, 'DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector: selector
    });
    
    if (!nodeResult?.nodeId) {
      return { error: `Element not found: ${selector}` };
    }
    
    await sendCDPCommand(tabId, 'DOMDebugger.removeDOMBreakpoint', {
      nodeId: nodeResult.nodeId,
      type: type
    });
    
    return { success: true, selector, type };
  } catch (error) {
    return { error: error.message };
  }
}

// CDP CSS Coverage
async function startCSSCoverage(tabId) {
  try {
    await enableCDPDomain(tabId, 'CSS');
    await sendCDPCommand(tabId, 'CSS.startRuleUsageTracking');
    return { success: true, message: 'CSS coverage tracking started' };
  } catch (error) {
    return { error: error.message };
  }
}

async function stopCSSCoverage(tabId) {
  try {
    const result = await sendCDPCommand(tabId, 'CSS.stopRuleUsageTracking');
    return { success: true, coverage: result };
  } catch (error) {
    return { error: error.message };
  }
}

// CDP JS Coverage
async function startJSCoverage(tabId) {
  try {
    await enableCDPDomain(tabId, 'Profiler');
    await sendCDPCommand(tabId, 'Profiler.startPreciseCoverage', {
      callCount: true,
      detailed: true
    });
    return { success: true, message: 'JS coverage tracking started' };
  } catch (error) {
    return { error: error.message };
  }
}

async function stopJSCoverage(tabId) {
  try {
    const result = await sendCDPCommand(tabId, 'Profiler.takePreciseCoverage');
    await sendCDPCommand(tabId, 'Profiler.stopPreciseCoverage');
    return { success: true, coverage: result };
  } catch (error) {
    return { error: error.message };
  }
}

// CDP Runtime - Console
async function getCDPConsoleLogs(tabId) {
  try {
    await enableCDPDomain(tabId, 'Runtime');
    // Console messages are collected via events
    // Return stored messages
    return { logs: consoleLogs.get(tabId) || [] };
  } catch (error) {
    return { error: error.message };
  }
}

let consoleLogs = new Map(); // tabId -> logs[]

// CDP Performance metrics
async function getPerformanceMetrics(tabId) {
  try {
    await enableCDPDomain(tabId, 'Performance');
    const metrics = await sendCDPCommand(tabId, 'Performance.getMetrics');
    return { metrics: metrics?.metrics || [] };
  } catch (error) {
    return { error: error.message };
  }
}

// CDP Accessibility
async function getAccessibilityTree(tabId, selector) {
  try {
    await enableCDPDomain(tabId, 'Accessibility');
    await enableCDPDomain(tabId, 'DOM');
    
    let nodeId = null;
    if (selector) {
      const doc = await sendCDPCommand(tabId, 'DOM.getDocument', { depth: 0 });
      const nodeResult = await sendCDPCommand(tabId, 'DOM.querySelector', {
        nodeId: doc.root.nodeId,
        selector
      });
      nodeId = nodeResult?.nodeId;
    }
    
    const tree = await sendCDPCommand(tabId, 'Accessibility.getFullAXTree', {
      depth: 3,
      max_depth: 3
    });
    
    return { tree: tree?.nodes?.slice(0, 50) || [] };
  } catch (error) {
    return { error: error.message };
  }
}

// CDP Layer info
async function getLayerTree(tabId) {
  try {
    await enableCDPDomain(tabId, 'LayerTree');
    const layers = await sendCDPCommand(tabId, 'LayerTree.getLayers');
    return { layers: layers?.layers || [] };
  } catch (error) {
    return { error: error.message };
  }
}

// CDP Animation
async function getAnimations(tabId) {
  try {
    await enableCDPDomain(tabId, 'Animation');
    // Animations are tracked via events
    return { animations: animations.get(tabId) || [] };
  } catch (error) {
    return { error: error.message };
  }
}

let animations = new Map();

// Handle debugger events
chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  
  // Network events
  if (method === 'Network.requestWillBeSent') {
    const requests = networkRequests.get(tabId) || [];
    requests.push({
      requestId: params.requestId,
      url: params.request.url,
      method: params.request.method,
      timestamp: params.timestamp,
      type: params.type,
      initiator: params.initiator?.type
    });
    if (requests.length > 100) requests.shift();
    networkRequests.set(tabId, requests);
  }
  
  if (method === 'Network.responseReceived') {
    const requests = networkRequests.get(tabId) || [];
    const req = requests.find(r => r.requestId === params.requestId);
    if (req) {
      req.status = params.response.status;
      req.statusText = params.response.statusText;
      req.mimeType = params.response.mimeType;
      req.responseTime = params.timestamp;
    }
  }
  
  // Console events
  if (method === 'Runtime.consoleAPICalled') {
    const logs = consoleLogs.get(tabId) || [];
    logs.push({
      type: params.type,
      args: params.args?.map(a => a.value || a.description || a.type).slice(0, 5),
      timestamp: params.timestamp,
      stackTrace: params.stackTrace?.callFrames?.[0]
    });
    if (logs.length > 100) logs.shift();
    consoleLogs.set(tabId, logs);
  }
  
  // Exception events
  if (method === 'Runtime.exceptionThrown') {
    const logs = consoleLogs.get(tabId) || [];
    logs.push({
      type: 'error',
      exception: params.exceptionDetails?.text,
      description: params.exceptionDetails?.exception?.description?.slice(0, 200),
      url: params.exceptionDetails?.url,
      lineNumber: params.exceptionDetails?.lineNumber,
      timestamp: params.timestamp
    });
    consoleLogs.set(tabId, logs);
  }
  
  // Animation events
  if (method === 'Animation.animationCreated' || method === 'Animation.animationStarted') {
    const anims = animations.get(tabId) || [];
    anims.push({
      id: params.id || params.animation?.id,
      name: params.animation?.name,
      type: params.animation?.type,
      duration: params.animation?.source?.duration,
      delay: params.animation?.source?.delay
    });
    if (anims.length > 50) anims.shift();
    animations.set(tabId, anims);
  }
});

// Cleanup on tab close
chrome.tabs.onRemoved.addListener((tabId) => {
  if (debuggerAttached.has(tabId)) {
    debuggerAttached.delete(tabId);
  }
  networkRequests.delete(tabId);
  consoleLogs.delete(tabId);
  animations.delete(tabId);
});

chrome.debugger.onDetach.addListener((source, reason) => {
  console.log(`Debugger detached from tab ${source.tabId}: ${reason}`);
  debuggerAttached.delete(source.tabId);
});

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

console.log('Apex Agent started');
