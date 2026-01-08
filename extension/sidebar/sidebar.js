// Apex Agent Sidebar - AI Assistant
// Handles chat interface and AI API integration

// ============ STATE ============
let settings = {
  provider: 'openai',
  apiKey: '',
  model: 'gpt-4o',
  autoExecute: true,
  showThinking: false
};

let chatHistory = [];
let isProcessing = false;

// ============ ELEMENTS ============
const elements = {
  settingsBtn: document.getElementById('settingsBtn'),
  settingsPanel: document.getElementById('settingsPanel'),
  closeSettings: document.getElementById('closeSettings'),
  aiProvider: document.getElementById('aiProvider'),
  apiKey: document.getElementById('apiKey'),
  toggleApiKey: document.getElementById('toggleApiKey'),
  modelSelect: document.getElementById('modelSelect'),
  autoExecute: document.getElementById('autoExecute'),
  showThinking: document.getElementById('showThinking'),
  saveSettings: document.getElementById('saveSettings'),
  settingsStatus: document.getElementById('settingsStatus'),
  chatMessages: document.getElementById('chatMessages'),
  userInput: document.getElementById('userInput'),
  sendBtn: document.getElementById('sendBtn'),
  statusIndicator: document.getElementById('statusIndicator'),
  statusText: document.getElementById('statusText')
};

// ============ TOOLS DEFINITION ============
const TOOLS = [
  { name: 'browser_navigate', description: 'Navigate to a URL', parameters: { url: 'string (required)' } },
  { name: 'browser_click', description: 'Click an element', parameters: { selector: 'CSS selector' } },
  { name: 'browser_type', description: 'Type text into an element', parameters: { selector: 'CSS selector', text: 'text to type' } },
  { name: 'browser_snapshot', description: 'Get page elements snapshot', parameters: {} },
  { name: 'browser_scroll', description: 'Scroll the page', parameters: { direction: 'up|down|left|right', amount: 'pixels' } },
  { name: 'browser_screenshot', description: 'Take a screenshot', parameters: {} },
  { name: 'browser_press_key', description: 'Press a keyboard key', parameters: { key: 'Enter|Tab|Escape|etc', modifiers: '[ctrl|shift|alt]' } },
  { name: 'inspect_element', description: 'Inspect element details', parameters: { selector: 'CSS selector' } },
  { name: 'get_console_logs', description: 'Get browser console logs', parameters: {} },
  { name: 'get_page_metrics', description: 'Get page performance metrics', parameters: {} },
  { name: 'list_extensions', description: 'List installed extensions', parameters: {} },
  { name: 'get_event_listeners', description: 'Get event listeners on element', parameters: { selector: 'CSS selector' } }
];

const SYSTEM_PROMPT = `You are an AI browser assistant integrated into Apex Agent extension. You can control the browser to help users.

Available tools (call them using JSON format):
${TOOLS.map(t => `- ${t.name}: ${t.description}`).join('\n')}

When you need to perform an action, respond with a JSON block like this:
\`\`\`tool
{"tool": "browser_navigate", "params": {"url": "https://example.com"}}
\`\`\`

You can use multiple tools in sequence. Always explain what you're doing.
After executing tools, describe the results to the user.
Be concise but helpful. If you need to see the page first, use browser_snapshot.`;

// ============ INITIALIZATION ============
async function init() {
  await loadSettings();
  setupEventListeners();
  updateStatus();
  updateModelOptions();
}

async function loadSettings() {
  try {
    const stored = await chrome.storage.local.get([
      'aiProvider', 'aiApiKey', 'aiModel', 'aiAutoExecute', 'aiShowThinking', 'aiChatHistory', 'aiEnabled'
    ]);
    
    settings.provider = stored.aiProvider || 'openai';
    settings.apiKey = stored.aiApiKey || '';
    settings.model = stored.aiModel || 'gpt-4o';
    settings.autoExecute = stored.aiAutoExecute !== false;
    settings.showThinking = stored.aiShowThinking || false;
    chatHistory = stored.aiChatHistory || [];
    
    // Check if AI is enabled
    if (!stored.aiEnabled) {
      // Show message that AI needs to be enabled in popup settings
      const welcomeMsg = elements.chatMessages.querySelector('.message.assistant .message-content');
      if (welcomeMsg) {
        welcomeMsg.innerHTML = `
          <p>⚠️ AI Assistant is not enabled.</p>
          <p>To enable:</p>
          <ol>
            <li>Click the extension icon</li>
            <li>Click the ⚙ Settings button</li>
            <li>Check "Enable AI Sidebar"</li>
            <li>Enter your API key</li>
          </ol>
        `;
      }
    }
    
    // Update UI
    elements.aiProvider.value = settings.provider;
    elements.apiKey.value = settings.apiKey;
    elements.modelSelect.value = settings.model;
    elements.autoExecute.checked = settings.autoExecute;
    elements.showThinking.checked = settings.showThinking;
    
    // Restore chat history
    if (chatHistory.length > 0) {
      elements.chatMessages.innerHTML = '';
      chatHistory.forEach(msg => {
        addMessageToUI(msg.role, msg.content, false);
      });
    }
  } catch (e) {
    console.error('Failed to load settings:', e);
  }
}

async function saveSettingsToStorage() {
  try {
    settings.provider = elements.aiProvider.value;
    settings.apiKey = elements.apiKey.value;
    settings.model = elements.modelSelect.value;
    settings.autoExecute = elements.autoExecute.checked;
    settings.showThinking = elements.showThinking.checked;
    
    await chrome.storage.local.set({
      aiProvider: settings.provider,
      aiApiKey: settings.apiKey,
      aiModel: settings.model,
      aiAutoExecute: settings.autoExecute,
      aiShowThinking: settings.showThinking
    });
    
    showSettingsStatus('Settings saved!', 'success');
    updateStatus();
    updateModelOptions();
  } catch (e) {
    showSettingsStatus('Failed to save: ' + e.message, 'error');
  }
}

function showSettingsStatus(msg, type) {
  elements.settingsStatus.textContent = msg;
  elements.settingsStatus.className = `status-msg ${type}`;
  setTimeout(() => {
    elements.settingsStatus.textContent = '';
  }, 3000);
}

// ============ EVENT LISTENERS ============
function setupEventListeners() {
  // Settings toggle
  elements.settingsBtn.addEventListener('click', () => {
    elements.settingsPanel.classList.toggle('hidden');
  });
  
  elements.closeSettings.addEventListener('click', () => {
    elements.settingsPanel.classList.add('hidden');
  });
  
  // API key visibility toggle
  elements.toggleApiKey.addEventListener('click', () => {
    const type = elements.apiKey.type === 'password' ? 'text' : 'password';
    elements.apiKey.type = type;
    elements.toggleApiKey.textContent = type === 'password' ? '👁' : '🔒';
  });
  
  // Provider change updates model options
  elements.aiProvider.addEventListener('change', updateModelOptions);
  
  // Save settings
  elements.saveSettings.addEventListener('click', saveSettingsToStorage);
  
  // Input handling
  elements.userInput.addEventListener('input', () => {
    autoResizeTextarea();
    updateSendButton();
  });
  
  elements.userInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  
  elements.sendBtn.addEventListener('click', sendMessage);
  
  // Quick actions
  document.querySelectorAll('.quick-btn').forEach(btn => {
    btn.addEventListener('click', () => handleQuickAction(btn.dataset.action));
  });
}

function updateModelOptions() {
  const provider = elements.aiProvider.value;
  const modelSelect = elements.modelSelect;
  
  const models = {
    openai: [
      { value: 'gpt-4o', label: 'GPT-4o' },
      { value: 'gpt-4o-mini', label: 'GPT-4o Mini' },
      { value: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
      { value: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo' }
    ],
    anthropic: [
      { value: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
      { value: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet' },
      { value: 'claude-3-haiku-20240307', label: 'Claude 3 Haiku' }
    ],
    google: [
      { value: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro' },
      { value: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash' },
      { value: 'gemini-pro', label: 'Gemini Pro' }
    ],
    openrouter: [
      { value: 'openai/gpt-4o', label: 'GPT-4o (OpenRouter)' },
      { value: 'anthropic/claude-sonnet-4-20250514', label: 'Claude Sonnet 4 (OpenRouter)' },
      { value: 'google/gemini-pro-1.5', label: 'Gemini 1.5 Pro (OpenRouter)' },
      { value: 'meta-llama/llama-3-70b-instruct', label: 'Llama 3 70B' }
    ]
  };
  
  modelSelect.innerHTML = '';
  (models[provider] || []).forEach(m => {
    const option = document.createElement('option');
    option.value = m.value;
    option.textContent = m.label;
    modelSelect.appendChild(option);
  });
  
  // Try to restore previous selection
  if (settings.model && modelSelect.querySelector(`option[value="${settings.model}"]`)) {
    modelSelect.value = settings.model;
  }
}

function autoResizeTextarea() {
  const textarea = elements.userInput;
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
}

function updateSendButton() {
  const hasInput = elements.userInput.value.trim().length > 0;
  const hasApiKey = settings.apiKey.length > 0;
  elements.sendBtn.disabled = !hasInput || !hasApiKey || isProcessing;
}

function updateStatus() {
  const hasApiKey = settings.apiKey.length > 0;
  
  if (isProcessing) {
    elements.statusIndicator.className = 'status-dot working';
    elements.statusText.textContent = 'Processing...';
  } else if (hasApiKey) {
    elements.statusIndicator.className = 'status-dot connected';
    elements.statusText.textContent = `${settings.provider} - ${settings.model}`;
  } else {
    elements.statusIndicator.className = 'status-dot disconnected';
    elements.statusText.textContent = 'API not configured';
  }
  
  updateSendButton();
}

// ============ CHAT FUNCTIONS ============
async function sendMessage() {
  const text = elements.userInput.value.trim();
  if (!text || isProcessing) return;
  
  // Clear input
  elements.userInput.value = '';
  autoResizeTextarea();
  
  // Add user message
  addMessage('user', text);
  
  // Process with AI
  isProcessing = true;
  updateStatus();
  
  try {
    const response = await callAI(text);
    await processAIResponse(response);
  } catch (error) {
    addMessage('assistant', `❌ Error: ${error.message}`);
  }
  
  isProcessing = false;
  updateStatus();
}

function addMessage(role, content, save = true) {
  if (save) {
    chatHistory.push({ role, content });
    saveChatHistory();
  }
  addMessageToUI(role, content, true);
}

function addMessageToUI(role, content, scroll = true) {
  const msgDiv = document.createElement('div');
  msgDiv.className = `message ${role}`;
  
  const contentDiv = document.createElement('div');
  contentDiv.className = 'message-content';
  contentDiv.innerHTML = formatMessage(content);
  
  msgDiv.appendChild(contentDiv);
  elements.chatMessages.appendChild(msgDiv);
  
  if (scroll) {
    elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
  }
}

function addActionMessage(title, content, status = '') {
  const msgDiv = document.createElement('div');
  msgDiv.className = `action-msg ${status}`;
  msgDiv.innerHTML = `
    <div class="action-title">${title}</div>
    <div>${content}</div>
  `;
  elements.chatMessages.appendChild(msgDiv);
  elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
}

function addThinking() {
  const thinkingDiv = document.createElement('div');
  thinkingDiv.className = 'thinking';
  thinkingDiv.id = 'thinking-indicator';
  thinkingDiv.innerHTML = `
    <div class="thinking-dots">
      <span></span><span></span><span></span>
    </div>
    <span>Thinking...</span>
  `;
  elements.chatMessages.appendChild(thinkingDiv);
  elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
}

function removeThinking() {
  const indicator = document.getElementById('thinking-indicator');
  if (indicator) indicator.remove();
}

function formatMessage(text) {
  // Convert markdown-like formatting
  return text
    .replace(/```(\w*)\n?([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
}

async function saveChatHistory() {
  // Keep last 50 messages
  const toSave = chatHistory.slice(-50);
  await chrome.storage.local.set({ aiChatHistory: toSave });
}

// ============ AI API CALLS ============
async function callAI(userMessage) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...chatHistory.slice(-10).map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage }
  ];
  
  if (settings.showThinking) addThinking();
  
  try {
    let response;
    
    switch (settings.provider) {
      case 'openai':
        response = await callOpenAI(messages);
        break;
      case 'anthropic':
        response = await callAnthropic(messages);
        break;
      case 'google':
        response = await callGoogle(messages);
        break;
      case 'openrouter':
        response = await callOpenRouter(messages);
        break;
      default:
        throw new Error('Unknown provider');
    }
    
    return response;
  } finally {
    removeThinking();
  }
}

async function callOpenAI(messages) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify({
      model: settings.model,
      messages,
      max_tokens: 2000
    })
  });
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || `API error: ${response.status}`);
  }
  
  const data = await response.json();
  return data.choices[0].message.content;
}

async function callAnthropic(messages) {
  // Anthropic uses different format
  const systemMsg = messages.find(m => m.role === 'system')?.content || '';
  const chatMsgs = messages.filter(m => m.role !== 'system');
  
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': settings.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: settings.model,
      max_tokens: 2000,
      system: systemMsg,
      messages: chatMsgs
    })
  });
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || `API error: ${response.status}`);
  }
  
  const data = await response.json();
  return data.content[0].text;
}

async function callGoogle(messages) {
  const systemMsg = messages.find(m => m.role === 'system')?.content || '';
  const chatMsgs = messages.filter(m => m.role !== 'system');
  
  // Convert to Gemini format
  const contents = chatMsgs.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));
  
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${settings.model}:generateContent?key=${settings.apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemMsg }] },
        contents
      })
    }
  );
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || `API error: ${response.status}`);
  }
  
  const data = await response.json();
  return data.candidates[0].content.parts[0].text;
}

async function callOpenRouter(messages) {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${settings.apiKey}`,
      'HTTP-Referer': chrome.runtime.getURL(''),
      'X-Title': 'Apex Agent'
    },
    body: JSON.stringify({
      model: settings.model,
      messages,
      max_tokens: 2000
    })
  });
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || `API error: ${response.status}`);
  }
  
  const data = await response.json();
  return data.choices[0].message.content;
}

// ============ TOOL EXECUTION ============
async function processAIResponse(response) {
  // Extract tool calls from response
  const toolRegex = /```tool\s*([\s\S]*?)```/g;
  let match;
  let lastIndex = 0;
  let hasTools = false;
  
  while ((match = toolRegex.exec(response)) !== null) {
    hasTools = true;
    
    // Add text before tool call
    const textBefore = response.substring(lastIndex, match.index).trim();
    if (textBefore) {
      addMessage('assistant', textBefore);
    }
    
    // Parse and execute tool
    try {
      const toolCall = JSON.parse(match[1]);
      
      if (settings.autoExecute) {
        addActionMessage(`🔧 ${toolCall.tool}`, JSON.stringify(toolCall.params || {}));
        
        const result = await executeTool(toolCall.tool, toolCall.params || {});
        
        if (result.error) {
          addActionMessage('❌ Error', result.error, 'error');
        } else {
          addActionMessage('✓ Success', formatToolResult(result), 'success');
          
          // If screenshot, show image
          if (result.dataUrl && result.dataUrl.startsWith('data:image')) {
            const img = document.createElement('img');
            img.src = result.dataUrl;
            img.className = 'message-image';
            img.onclick = () => window.open(result.dataUrl, '_blank');
            elements.chatMessages.appendChild(img);
          }
        }
      } else {
        // Ask for confirmation
        addConfirmationRequest(toolCall);
      }
    } catch (e) {
      addActionMessage('❌ Parse Error', e.message, 'error');
    }
    
    lastIndex = match.index + match[0].length;
  }
  
  // Add remaining text after last tool call
  const textAfter = response.substring(lastIndex).trim();
  if (textAfter) {
    addMessage('assistant', textAfter);
  }
  
  // If no tools, just show the response
  if (!hasTools) {
    addMessage('assistant', response);
  }
}

async function executeTool(name, params) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({
      type: 'SIDEBAR_TOOL_CALL',
      tool: name,
      params
    }, (response) => {
      resolve(response || { error: 'No response from extension' });
    });
  });
}

function formatToolResult(result) {
  if (typeof result === 'string') return result;
  
  // Truncate long results
  const str = JSON.stringify(result, null, 2);
  if (str.length > 500) {
    return str.substring(0, 500) + '...\n(truncated)';
  }
  return str;
}

function addConfirmationRequest(toolCall) {
  const msgDiv = document.createElement('div');
  msgDiv.className = 'message assistant';
  msgDiv.innerHTML = `
    <div class="message-content">
      <p>🔧 Requesting action: <strong>${toolCall.tool}</strong></p>
      <pre><code>${JSON.stringify(toolCall.params, null, 2)}</code></pre>
      <div class="confirm-actions">
        <button class="confirm-btn approve">✓ Execute</button>
        <button class="confirm-btn reject">✕ Skip</button>
      </div>
    </div>
  `;
  
  elements.chatMessages.appendChild(msgDiv);
  
  const approveBtn = msgDiv.querySelector('.approve');
  const rejectBtn = msgDiv.querySelector('.reject');
  
  approveBtn.onclick = async () => {
    approveBtn.disabled = true;
    rejectBtn.disabled = true;
    const result = await executeTool(toolCall.tool, toolCall.params);
    addActionMessage(result.error ? '❌ Error' : '✓ Executed', 
      result.error || formatToolResult(result), 
      result.error ? 'error' : 'success');
  };
  
  rejectBtn.onclick = () => {
    approveBtn.disabled = true;
    rejectBtn.disabled = true;
    addActionMessage('⏭ Skipped', toolCall.tool);
  };
  
  elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
}

// ============ QUICK ACTIONS ============
async function handleQuickAction(action) {
  let message;
  
  switch (action) {
    case 'screenshot':
      message = 'Take a screenshot of the current page';
      break;
    case 'snapshot':
      message = 'Get a snapshot of the page elements so I can see what\'s on screen';
      break;
    case 'console':
      message = 'Show me the browser console logs';
      break;
    default:
      return;
  }
  
  elements.userInput.value = message;
  sendMessage();
}

// ============ INIT ============
init();

