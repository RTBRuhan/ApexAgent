// Chrome MCP - Popup Script

// State
let isRecording = false;
let isPaused = false;
let recordingStartTime = null;
let pausedDuration = 0;
let pauseStartTime = null;
let timerInterval = null;
let mcpConnected = false;
let currentFilter = 'all';
let searchQuery = '';
let allLogs = [];

// Elements
const elements = {
  // Status
  statusIndicator: document.getElementById('statusIndicator'),
  
  // Tabs
  tabs: document.querySelectorAll('.tab'),
  tabContents: document.querySelectorAll('.tab-content'),
  
  // Record
  recordBtn: document.getElementById('recordBtn'),
  pauseBtn: document.getElementById('pauseBtn'),
  recordTimer: document.getElementById('recordTimer'),
  logContainer: document.getElementById('logContainer'),
  logCount: document.getElementById('logCount'),
  logSearch: document.getElementById('logSearch'),
  filterBtns: document.querySelectorAll('.filter-btn'),
  copyLogBtn: document.getElementById('copyLogBtn'),
  clearLogBtn: document.getElementById('clearLogBtn'),
  exportLogBtn: document.getElementById('exportLogBtn'),
  
  // Recording options
  trackClicks: document.getElementById('trackClicks'),
  trackKeyboard: document.getElementById('trackKeyboard'),
  trackScroll: document.getElementById('trackScroll'),
  trackDOMChanges: document.getElementById('trackDOMChanges'),
  skipDynamic: document.getElementById('skipDynamic'),
  dynamicThreshold: document.getElementById('dynamicThreshold'),
  thresholdValue: document.getElementById('thresholdValue'),
  
  // Collapsibles
  collapsibles: document.querySelectorAll('.collapsible'),
  
  // MCP
  mcpIndicator: document.getElementById('mcpIndicator'),
  mcpStatusText: document.getElementById('mcpStatusText'),
  mcpPort: document.getElementById('mcpPort'),
  mcpHost: document.getElementById('mcpHost'),
  startMcpBtn: document.getElementById('startMcpBtn'),
  copyConfigBtn: document.getElementById('copyConfigBtn'),
  mcpConfigCode: document.getElementById('mcpConfigCode'),
  
  // Agent
  agentEnabled: document.getElementById('agentEnabled'),
  agentActivityLog: document.getElementById('agentActivityLog'),
  allowMouse: document.getElementById('allowMouse'),
  allowKeyboard: document.getElementById('allowKeyboard'),
  allowNavigation: document.getElementById('allowNavigation'),
  allowScripts: document.getElementById('allowScripts'),
  allowScreenshot: document.getElementById('allowScreenshot'),
  showCursor: document.getElementById('showCursor'),
  highlightTarget: document.getElementById('highlightTarget'),
  showTooltips: document.getElementById('showTooltips'),
  
  // Footer
  shortcutsLink: document.getElementById('shortcutsLink'),
  helpLink: document.getElementById('helpLink'),
};

// Initialize
async function init() {
  setupTabs();
  setupCollapsibles();
  setupRecordControls();
  setupFilters();
  setupSearch();
  setupMCPControls();
  setupAgentControls();
  setupKeyboardShortcuts();
  setupFooterLinks();
  await loadSettings();
  await checkMCPStatus();
  await loadRecordingState();
}

// Tab Navigation
function setupTabs() {
  elements.tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const tabId = tab.dataset.tab;
      
      elements.tabs.forEach(t => t.classList.remove('active'));
      elements.tabContents.forEach(c => c.classList.remove('active'));
      
      tab.classList.add('active');
      document.getElementById(`${tabId}Tab`).classList.add('active');
      
      // Save active tab
      chrome.storage.local.set({ activeTab: tabId });
    });
  });
}

// Collapsible Sections
function setupCollapsibles() {
  elements.collapsibles.forEach(collapsible => {
    const header = collapsible.querySelector('.collapsible-header');
    header.addEventListener('click', () => {
      collapsible.classList.toggle('collapsed');
      saveCollapsibleStates();
    });
  });
}

function saveCollapsibleStates() {
  const states = {};
  elements.collapsibles.forEach(c => {
    states[c.id] = c.classList.contains('collapsed');
  });
  chrome.storage.local.set({ collapsibleStates: states });
}

function loadCollapsibleStates(states) {
  if (!states) return;
  Object.entries(states).forEach(([id, collapsed]) => {
    const el = document.getElementById(id);
    if (el) {
      el.classList.toggle('collapsed', collapsed);
    }
  });
}

// Record Controls
function setupRecordControls() {
  elements.recordBtn.addEventListener('click', toggleRecording);
  elements.pauseBtn.addEventListener('click', togglePause);
  elements.copyLogBtn.addEventListener('click', copyLog);
  elements.clearLogBtn.addEventListener('click', clearLog);
  elements.exportLogBtn.addEventListener('click', exportLog);
  
  // Threshold slider
  elements.dynamicThreshold.addEventListener('input', (e) => {
    elements.thresholdValue.textContent = `${e.target.value}ms`;
    saveSettings();
  });
  
  // Options change
  [elements.trackClicks, elements.trackKeyboard, elements.trackScroll, 
   elements.trackDOMChanges, elements.skipDynamic].forEach(el => {
    el.addEventListener('change', () => {
      saveSettings();
      updateRecordingOptions();
    });
  });
}

async function toggleRecording() {
  if (isRecording) {
    // Stop recording
    isRecording = false;
    isPaused = false;
    stopTimer();
    elements.recordBtn.classList.remove('recording', 'paused');
    elements.recordBtn.querySelector('.record-text').textContent = 'Record';
    elements.pauseBtn.disabled = true;
    elements.statusIndicator.classList.remove('recording', 'paused');
    elements.statusIndicator.querySelector('.status-text').textContent = 'Idle';
    
    await sendToActiveTab({ type: 'STOP_RECORDING' });
  } else {
    // Start recording
    isRecording = true;
    isPaused = false;
    recordingStartTime = Date.now();
    pausedDuration = 0;
    startTimer();
    elements.recordBtn.classList.add('recording');
    elements.recordBtn.querySelector('.record-text').textContent = 'Stop';
    elements.pauseBtn.disabled = false;
    elements.statusIndicator.classList.add('recording');
    elements.statusIndicator.querySelector('.status-text').textContent = 'Recording';
    
    await sendToActiveTab({
      type: 'START_RECORDING',
      options: getRecordingOptions()
    });
  }
  
  chrome.storage.local.set({ isRecording, isPaused, recordingStartTime, pausedDuration });
}

async function togglePause() {
  if (!isRecording) return;
  
  isPaused = !isPaused;
  
  if (isPaused) {
    pauseStartTime = Date.now();
    elements.recordBtn.classList.remove('recording');
    elements.recordBtn.classList.add('paused');
    elements.recordBtn.querySelector('.record-text').textContent = 'Paused';
    elements.pauseBtn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="currentColor">
        <polygon points="5,3 19,12 5,21"/>
      </svg>
    `;
    elements.statusIndicator.classList.remove('recording');
    elements.statusIndicator.classList.add('paused');
    elements.statusIndicator.querySelector('.status-text').textContent = 'Paused';
    
    await sendToActiveTab({ type: 'PAUSE_RECORDING' });
  } else {
    pausedDuration += Date.now() - pauseStartTime;
    elements.recordBtn.classList.remove('paused');
    elements.recordBtn.classList.add('recording');
    elements.recordBtn.querySelector('.record-text').textContent = 'Stop';
    elements.pauseBtn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="currentColor">
        <rect x="6" y="4" width="4" height="16"/>
        <rect x="14" y="4" width="4" height="16"/>
      </svg>
    `;
    elements.statusIndicator.classList.remove('paused');
    elements.statusIndicator.classList.add('recording');
    elements.statusIndicator.querySelector('.status-text').textContent = 'Recording';
    
    await sendToActiveTab({ type: 'RESUME_RECORDING' });
  }
  
  chrome.storage.local.set({ isPaused, pausedDuration });
}

async function updateRecordingOptions() {
  if (isRecording && !isPaused) {
    await sendToActiveTab({
      type: 'UPDATE_OPTIONS',
      options: getRecordingOptions()
    });
  }
}

function getRecordingOptions() {
  return {
    trackClicks: elements.trackClicks.checked,
    trackKeyboard: elements.trackKeyboard.checked,
    trackScroll: elements.trackScroll.checked,
    trackDOMChanges: elements.trackDOMChanges.checked,
    skipDynamic: elements.skipDynamic.checked,
    dynamicThreshold: parseInt(elements.dynamicThreshold.value)
  };
}

function startTimer() {
  updateTimer();
  timerInterval = setInterval(updateTimer, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
  elements.recordTimer.textContent = '00:00';
}

function updateTimer() {
  if (!recordingStartTime) return;
  
  let elapsed = Math.floor((Date.now() - recordingStartTime - pausedDuration) / 1000);
  if (isPaused && pauseStartTime) {
    elapsed = Math.floor((pauseStartTime - recordingStartTime - pausedDuration) / 1000);
  }
  
  const minutes = Math.floor(elapsed / 60).toString().padStart(2, '0');
  const seconds = (elapsed % 60).toString().padStart(2, '0');
  elements.recordTimer.textContent = `${minutes}:${seconds}`;
}

async function loadRecordingState() {
  const state = await chrome.storage.local.get([
    'isRecording', 'isPaused', 'recordingStartTime', 'pausedDuration', 'recordLog', 'activeTab'
  ]);
  
  // Default to MCP tab, or restore saved tab
  const activeTab = state.activeTab || 'mcp';
  const tab = document.querySelector(`.tab[data-tab="${activeTab}"]`);
  if (tab && activeTab !== 'mcp') tab.click(); // Only click if not already default
  
  if (state.isRecording) {
    isRecording = true;
    isPaused = state.isPaused || false;
    recordingStartTime = state.recordingStartTime;
    pausedDuration = state.pausedDuration || 0;
    
    if (isPaused) {
      pauseStartTime = Date.now();
      elements.recordBtn.classList.add('paused');
      elements.recordBtn.querySelector('.record-text').textContent = 'Paused';
      elements.statusIndicator.classList.add('paused');
      elements.statusIndicator.querySelector('.status-text').textContent = 'Paused';
      elements.pauseBtn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="currentColor">
          <polygon points="5,3 19,12 5,21"/>
        </svg>
      `;
    } else {
      elements.recordBtn.classList.add('recording');
      elements.recordBtn.querySelector('.record-text').textContent = 'Stop';
      elements.statusIndicator.classList.add('recording');
      elements.statusIndicator.querySelector('.status-text').textContent = 'Recording';
    }
    elements.pauseBtn.disabled = false;
    startTimer();
  }
  
  if (state.recordLog && state.recordLog.length > 0) {
    allLogs = state.recordLog;
    renderFilteredLogs();
  }
}

// Filters
function setupFilters() {
  elements.filterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      elements.filterBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.filter;
      renderFilteredLogs();
    });
  });
}

// Search
function setupSearch() {
  let debounceTimer;
  elements.logSearch.addEventListener('input', (e) => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      searchQuery = e.target.value.toLowerCase();
      renderFilteredLogs();
    }, 150);
  });
}

function renderFilteredLogs() {
  let filtered = allLogs;
  
  // Apply type filter
  if (currentFilter !== 'all') {
    filtered = filtered.filter(log => log.type.toLowerCase() === currentFilter);
  }
  
  // Apply search
  if (searchQuery) {
    filtered = filtered.filter(log => 
      log.details.toLowerCase().includes(searchQuery) ||
      log.type.toLowerCase().includes(searchQuery)
    );
  }
  
  // Update count
  elements.logCount.textContent = `${filtered.length} ${filtered.length === 1 ? 'entry' : 'entries'}`;
  
  // Render
  if (filtered.length === 0) {
    if (allLogs.length === 0) {
      clearLogDisplay();
    } else {
      elements.logContainer.innerHTML = `
        <div class="log-empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="11" cy="11" r="8"/>
            <path d="M21 21L16.65 16.65"/>
          </svg>
          <p>No matching entries</p>
        </div>
      `;
    }
  } else {
    elements.logContainer.innerHTML = '';
    filtered.forEach(entry => addLogEntryElement(entry));
  }
}

function clearLogDisplay() {
  elements.logContainer.innerHTML = `
    <div class="log-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="12" cy="12" r="10"/>
        <path d="M12 8V12L14 14"/>
      </svg>
      <p>Start recording to capture interactions</p>
    </div>
  `;
  elements.logCount.textContent = '0 entries';
}

function addLogEntryElement(entry) {
  const emptyState = elements.logContainer.querySelector('.log-empty');
  if (emptyState) emptyState.remove();
  
  const div = document.createElement('div');
  div.className = 'log-entry';
  div.dataset.type = entry.type.toLowerCase();
  
  const typeClass = entry.type.toLowerCase();
  const time = formatTime(entry.timestamp);
  
  let changeHtml = '';
  if (entry.before !== undefined && entry.after !== undefined) {
    changeHtml = `
      <div class="log-change">
        <div class="log-change-before">- ${escapeHtml(truncate(String(entry.before), 80))}</div>
        <div class="log-change-after">+ ${escapeHtml(truncate(String(entry.after), 80))}</div>
      </div>
    `;
  }
  
  div.innerHTML = `
    <div class="log-entry-header">
      <span class="log-type ${typeClass}">${entry.type}</span>
      <span class="log-time">${time}</span>
    </div>
    <div class="log-details">${escapeHtml(entry.details)}</div>
    ${changeHtml}
  `;
  
  elements.logContainer.appendChild(div);
  elements.logContainer.scrollTop = elements.logContainer.scrollHeight;
}

function addLogEntry(entry) {
  allLogs.push(entry);
  
  // Keep max 500 entries
  if (allLogs.length > 500) {
    allLogs = allLogs.slice(-500);
  }
  
  // Only add to DOM if matches current filter
  const matchesFilter = currentFilter === 'all' || entry.type.toLowerCase() === currentFilter;
  const matchesSearch = !searchQuery || 
    entry.details.toLowerCase().includes(searchQuery) ||
    entry.type.toLowerCase().includes(searchQuery);
  
  if (matchesFilter && matchesSearch) {
    addLogEntryElement(entry);
  }
  
  // Update count
  const visibleCount = elements.logContainer.querySelectorAll('.log-entry').length;
  elements.logCount.textContent = `${visibleCount} ${visibleCount === 1 ? 'entry' : 'entries'}`;
}

function formatTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-US', { 
    hour12: false, 
    hour: '2-digit', 
    minute: '2-digit', 
    second: '2-digit' 
  });
}

function escapeHtml(str) {
  if (typeof str !== 'string') str = String(str);
  return str.replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}

function truncate(str, maxLen) {
  if (typeof str !== 'string') str = String(str);
  return str.length > maxLen ? str.slice(0, maxLen) + '…' : str;
}

async function copyLog() {
  if (allLogs.length === 0) {
    showToast('No log to copy', 'error');
    return;
  }
  
  // Format for clipboard
  const formatted = allLogs.map(entry => {
    let line = `[${formatTime(entry.timestamp)}] ${entry.type}: ${entry.details}`;
    if (entry.before !== undefined && entry.after !== undefined) {
      line += `\n  - Before: ${entry.before}\n  + After: ${entry.after}`;
    }
    return line;
  }).join('\n\n');
  
  await navigator.clipboard.writeText(formatted);
  showToast('Copied to clipboard');
}

async function clearLog() {
  allLogs = [];
  await chrome.storage.local.set({ recordLog: [] });
  clearLogDisplay();
  showToast('Log cleared');
}

async function exportLog() {
  if (allLogs.length === 0) {
    showToast('No log to export', 'error');
    return;
  }
  
  const blob = new Blob([JSON.stringify(allLogs, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `chrome-mcp-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Exported successfully');
}

// MCP Controls
function setupMCPControls() {
  elements.startMcpBtn.addEventListener('click', toggleMCPServer);
  elements.copyConfigBtn.addEventListener('click', copyMCPConfig);
  elements.mcpPort.addEventListener('change', updateMCPConfig);
  elements.mcpHost.addEventListener('change', updateMCPConfig);
}

async function checkMCPStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_MCP_STATUS' });
    updateMCPUI(response?.connected || false);
  } catch (e) {
    updateMCPUI(false);
  }
}

function updateMCPUI(connected) {
  mcpConnected = connected;
  
  if (connected) {
    elements.mcpIndicator.classList.add('connected');
    elements.mcpStatusText.textContent = `Connected (${elements.mcpHost.value}:${elements.mcpPort.value})`;
    elements.startMcpBtn.textContent = 'Disconnect';
    elements.startMcpBtn.classList.add('active');
    elements.statusIndicator.classList.add('connected');
    if (!isRecording) {
      elements.statusIndicator.querySelector('.status-text').textContent = 'Connected';
    }
  } else {
    elements.mcpIndicator.classList.remove('connected');
    elements.mcpStatusText.textContent = 'Not Connected';
    elements.startMcpBtn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polygon points="5,3 19,12 5,21"/>
      </svg>
      Connect
    `;
    elements.startMcpBtn.classList.remove('active');
    if (!isRecording) {
      elements.statusIndicator.classList.remove('connected');
      elements.statusIndicator.querySelector('.status-text').textContent = 'Idle';
    }
  }
}

async function toggleMCPServer() {
  if (mcpConnected) {
    await chrome.runtime.sendMessage({ type: 'STOP_MCP_SERVER' });
    updateMCPUI(false);
    showToast('Disconnected');
  } else {
    const port = parseInt(elements.mcpPort.value);
    const host = elements.mcpHost.value;
    
    elements.startMcpBtn.textContent = 'Connecting...';
    elements.startMcpBtn.disabled = true;
    
    const response = await chrome.runtime.sendMessage({ 
      type: 'START_MCP_SERVER',
      port,
      host
    });
    
    elements.startMcpBtn.disabled = false;
    
    if (response?.success) {
      updateMCPUI(true);
      showToast('Connected successfully');
    } else {
      updateMCPUI(false);
      showToast(response?.error || 'Connection failed', 'error');
    }
  }
}

function updateMCPConfig() {
  const port = elements.mcpPort.value;
  const config = {
    "chrome-mcp": {
      command: "node",
      args: ["/path/to/ChromeMCP/mcp-server/index.js"],
      env: { PORT: port }
    }
  };
  elements.mcpConfigCode.textContent = JSON.stringify(config, null, 2);
  saveSettings();
}

async function copyMCPConfig() {
  await navigator.clipboard.writeText(elements.mcpConfigCode.textContent);
  showToast('Config copied');
}

// Agent Controls
function setupAgentControls() {
  elements.agentEnabled.addEventListener('change', toggleAgent);
  
  [elements.allowMouse, elements.allowKeyboard, elements.allowNavigation,
   elements.allowScripts, elements.allowScreenshot, elements.showCursor,
   elements.highlightTarget, elements.showTooltips].forEach(el => {
    el.addEventListener('change', () => {
      saveSettings();
      updateAgentPermissions();
    });
  });
}

async function toggleAgent() {
  const enabled = elements.agentEnabled.checked;
  
  await chrome.runtime.sendMessage({
    type: 'SET_AGENT_ENABLED',
    enabled,
    permissions: getAgentPermissions()
  });
  
  showToast(enabled ? 'Agent enabled' : 'Agent disabled');
  saveSettings();
}

async function updateAgentPermissions() {
  if (elements.agentEnabled.checked) {
    await chrome.runtime.sendMessage({
      type: 'SET_AGENT_ENABLED',
      enabled: true,
      permissions: getAgentPermissions()
    });
  }
}

function getAgentPermissions() {
  return {
    mouse: elements.allowMouse.checked,
    keyboard: elements.allowKeyboard.checked,
    navigation: elements.allowNavigation.checked,
    scripts: elements.allowScripts.checked,
    screenshot: elements.allowScreenshot.checked,
    showCursor: elements.showCursor.checked,
    highlightTarget: elements.highlightTarget.checked,
    showTooltips: elements.showTooltips.checked
  };
}

function addAgentActivity(action) {
  const emptyState = elements.agentActivityLog.querySelector('.activity-empty');
  if (emptyState) emptyState.remove();
  
  const div = document.createElement('div');
  div.className = 'log-entry';
  div.innerHTML = `
    <div class="log-entry-header">
      <span class="log-type">${action.type}</span>
      <span class="log-time">${formatTime(Date.now())}</span>
    </div>
    <div class="log-details">${escapeHtml(action.details)}</div>
  `;
  
  elements.agentActivityLog.appendChild(div);
  elements.agentActivityLog.scrollTop = elements.agentActivityLog.scrollHeight;
  
  // Keep max 50 entries
  const entries = elements.agentActivityLog.querySelectorAll('.log-entry');
  if (entries.length > 50) {
    entries[0].remove();
  }
}

// Keyboard Shortcuts
function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Ctrl/Cmd + R: Toggle recording
    if ((e.ctrlKey || e.metaKey) && e.key === 'r') {
      e.preventDefault();
      toggleRecording();
    }
    // Ctrl/Cmd + P: Toggle pause
    if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
      e.preventDefault();
      if (isRecording) togglePause();
    }
    // Ctrl/Cmd + C: Copy log (when not in input)
    if ((e.ctrlKey || e.metaKey) && e.key === 'c' && document.activeElement.tagName !== 'INPUT') {
      // Let default copy work, but if no selection, copy log
      if (!window.getSelection().toString()) {
        e.preventDefault();
        copyLog();
      }
    }
    // Escape: Clear search
    if (e.key === 'Escape' && document.activeElement === elements.logSearch) {
      elements.logSearch.value = '';
      searchQuery = '';
      renderFilteredLogs();
    }
  });
}

// Footer Links
function setupFooterLinks() {
  elements.shortcutsLink.addEventListener('click', (e) => {
    e.preventDefault();
    showToast('Ctrl+R: Record | Ctrl+P: Pause | Esc: Clear search');
  });
  
  elements.helpLink.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'https://github.com' });
  });
}

// Settings
async function loadSettings() {
  const settings = await chrome.storage.local.get([
    'trackClicks', 'trackKeyboard', 'trackScroll', 'trackDOMChanges',
    'skipDynamic', 'dynamicThreshold', 'mcpPort', 'mcpHost',
    'agentEnabled', 'allowMouse', 'allowKeyboard', 'allowNavigation',
    'allowScripts', 'allowScreenshot', 'showCursor', 'highlightTarget', 
    'showTooltips', 'collapsibleStates'
  ]);
  
  // Apply settings with defaults
  elements.trackClicks.checked = settings.trackClicks ?? true;
  elements.trackKeyboard.checked = settings.trackKeyboard ?? true;
  elements.trackScroll.checked = settings.trackScroll ?? true;
  elements.trackDOMChanges.checked = settings.trackDOMChanges ?? true;
  elements.skipDynamic.checked = settings.skipDynamic ?? true;
  elements.dynamicThreshold.value = settings.dynamicThreshold ?? 500;
  elements.thresholdValue.textContent = `${settings.dynamicThreshold ?? 500}ms`;
  elements.mcpPort.value = settings.mcpPort ?? 3052;
  elements.mcpHost.value = settings.mcpHost ?? 'localhost';
  elements.agentEnabled.checked = settings.agentEnabled ?? false;
  elements.allowMouse.checked = settings.allowMouse ?? true;
  elements.allowKeyboard.checked = settings.allowKeyboard ?? true;
  elements.allowNavigation.checked = settings.allowNavigation ?? true;
  elements.allowScripts.checked = settings.allowScripts ?? true;
  elements.allowScreenshot.checked = settings.allowScreenshot ?? false;
  elements.showCursor.checked = settings.showCursor ?? true;
  elements.highlightTarget.checked = settings.highlightTarget ?? true;
  elements.showTooltips.checked = settings.showTooltips ?? true;
  
  loadCollapsibleStates(settings.collapsibleStates);
  updateMCPConfig();
}

function saveSettings() {
  chrome.storage.local.set({
    trackClicks: elements.trackClicks.checked,
    trackKeyboard: elements.trackKeyboard.checked,
    trackScroll: elements.trackScroll.checked,
    trackDOMChanges: elements.trackDOMChanges.checked,
    skipDynamic: elements.skipDynamic.checked,
    dynamicThreshold: parseInt(elements.dynamicThreshold.value),
    mcpPort: parseInt(elements.mcpPort.value),
    mcpHost: elements.mcpHost.value,
    agentEnabled: elements.agentEnabled.checked,
    allowMouse: elements.allowMouse.checked,
    allowKeyboard: elements.allowKeyboard.checked,
    allowNavigation: elements.allowNavigation.checked,
    allowScripts: elements.allowScripts.checked,
    allowScreenshot: elements.allowScreenshot.checked,
    showCursor: elements.showCursor.checked,
    highlightTarget: elements.highlightTarget.checked,
    showTooltips: elements.showTooltips.checked
  });
}

// Utility
async function sendToActiveTab(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    try {
      await chrome.tabs.sendMessage(tab.id, message);
    } catch (e) {
      // Content script may not be loaded
    }
  }
}

function showToast(message, type = 'success') {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  
  requestAnimationFrame(() => {
    toast.classList.add('show');
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 200);
    }, 2000);
  });
}

// Listen for messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'LOG_ENTRY') {
    addLogEntry(message.entry);
  } else if (message.type === 'AGENT_ACTIVITY') {
    addAgentActivity(message.action);
  } else if (message.type === 'MCP_STATUS_CHANGED') {
    updateMCPUI(message.connected);
  }
});

// Initialize
document.addEventListener('DOMContentLoaded', init);
