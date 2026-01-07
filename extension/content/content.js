// Chrome Debug Hand - Content Script
// Handles DOM tracking, interaction recording, and agent control

(function() {
  'use strict';

  // State
  let isRecording = false;
  let isPaused = false;
  let options = {
    trackClicks: true,
    trackKeyboard: true,
    trackScroll: true,
    trackDOMChanges: true,
    skipDynamic: true,
    dynamicThreshold: 500
  };

  // DOM Observer
  let mutationObserver = null;
  let pendingMutations = [];
  let mutationDebounceTimer = null;
  let lastMutationTime = 0;
  let dynamicElementTracker = new Map();

  // Agent UI
  let agentCursor = null;
  let agentHighlight = null;
  let agentTooltip = null;
  let recordingIndicator = null;

  // Initialize
  function init() {
    setupMessageListener();
    createAgentUI();
    checkRecordingState();
  }

  // Message Listener
  function setupMessageListener() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      switch (message.type) {
        case 'START_RECORDING':
          startRecording(message.options);
          sendResponse({ success: true });
          break;
        case 'STOP_RECORDING':
          stopRecording();
          sendResponse({ success: true });
          break;
        case 'PAUSE_RECORDING':
          pauseRecording();
          sendResponse({ success: true });
          break;
        case 'RESUME_RECORDING':
          resumeRecording();
          sendResponse({ success: true });
          break;
        case 'UPDATE_OPTIONS':
          options = { ...options, ...message.options };
          sendResponse({ success: true });
          break;
        case 'AGENT_ACTION':
          handleAgentAction(message.action).then(sendResponse);
          return true;
        case 'GET_PAGE_STATE':
          sendResponse(getPageState());
          break;
        case 'GET_ELEMENT_INFO':
          sendResponse(getElementInfo(message.selector));
          break;
        default:
          sendResponse({ error: 'Unknown message type' });
      }
    });
  }

  // Check if recording was in progress
  async function checkRecordingState() {
    const { isRecording: recording, isPaused: paused, recordingOptions } = 
      await chrome.storage.local.get(['isRecording', 'isPaused', 'recordingOptions']);
    
    if (recording) {
      startRecording(recordingOptions || options);
      if (paused) {
        pauseRecording();
      }
    }
  }

  // Recording Functions
  function startRecording(opts = {}) {
    options = { ...options, ...opts };
    isRecording = true;
    isPaused = false;
    
    chrome.storage.local.set({ recordingOptions: options });
    
    if (options.trackClicks) {
      document.addEventListener('click', handleClick, true);
      document.addEventListener('dblclick', handleDoubleClick, true);
      document.addEventListener('contextmenu', handleRightClick, true);
    }
    
    if (options.trackKeyboard) {
      document.addEventListener('keydown', handleKeyDown, true);
      document.addEventListener('input', handleInput, true);
    }
    
    if (options.trackScroll) {
      document.addEventListener('scroll', handleScroll, { passive: true, capture: true });
    }
    
    if (options.trackDOMChanges) {
      startMutationObserver();
    }
    
    window.addEventListener('beforeunload', handleBeforeUnload);
    
    showRecordingIndicator();
    logEvent('NAVIGATION', `Recording started on ${window.location.href}`);
  }

  function stopRecording() {
    isRecording = false;
    isPaused = false;
    
    document.removeEventListener('click', handleClick, true);
    document.removeEventListener('dblclick', handleDoubleClick, true);
    document.removeEventListener('contextmenu', handleRightClick, true);
    document.removeEventListener('keydown', handleKeyDown, true);
    document.removeEventListener('input', handleInput, true);
    document.removeEventListener('scroll', handleScroll, true);
    window.removeEventListener('beforeunload', handleBeforeUnload);
    
    if (mutationObserver) {
      mutationObserver.disconnect();
      mutationObserver = null;
    }
    
    dynamicElementTracker.clear();
    hideRecordingIndicator();
  }

  function pauseRecording() {
    isPaused = true;
    updateRecordingIndicator();
  }

  function resumeRecording() {
    isPaused = false;
    updateRecordingIndicator();
  }

  function showRecordingIndicator() {
    if (recordingIndicator) return;
    
    recordingIndicator = document.createElement('div');
    recordingIndicator.className = 'debug-hand-recording-indicator';
    recordingIndicator.textContent = 'Recording';
    document.body.appendChild(recordingIndicator);
  }

  function hideRecordingIndicator() {
    if (recordingIndicator) {
      recordingIndicator.remove();
      recordingIndicator = null;
    }
  }

  function updateRecordingIndicator() {
    if (!recordingIndicator) return;
    
    if (isPaused) {
      recordingIndicator.className = 'debug-hand-paused-indicator';
      recordingIndicator.textContent = 'Paused';
    } else {
      recordingIndicator.className = 'debug-hand-recording-indicator';
      recordingIndicator.textContent = 'Recording';
    }
  }

  // Event Handlers
  function handleClick(event) {
    if (!isRecording || isPaused) return;
    
    const target = event.target;
    const selector = getUniqueSelector(target);
    const position = { x: event.clientX, y: event.clientY };
    
    logEvent('CLICK', `Clicked ${getElementDescription(target)}`, {
      selector,
      position,
      button: event.button
    });
  }

  function handleDoubleClick(event) {
    if (!isRecording || isPaused) return;
    
    const target = event.target;
    
    logEvent('CLICK', `Double-clicked ${getElementDescription(target)}`, {
      selector: getUniqueSelector(target),
      doubleClick: true
    });
  }

  function handleRightClick(event) {
    if (!isRecording || isPaused) return;
    
    const target = event.target;
    
    logEvent('CLICK', `Right-clicked ${getElementDescription(target)}`, {
      selector: getUniqueSelector(target),
      rightClick: true
    });
  }

  function handleKeyDown(event) {
    if (!isRecording || isPaused) return;
    
    // Skip if typing in input (handled by input event)
    if (event.target.matches('input, textarea, [contenteditable]') && 
        !event.ctrlKey && !event.metaKey && !event.altKey &&
        event.key.length === 1) {
      return;
    }
    
    const modifiers = [];
    if (event.ctrlKey) modifiers.push('Ctrl');
    if (event.metaKey) modifiers.push('Meta');
    if (event.altKey) modifiers.push('Alt');
    if (event.shiftKey) modifiers.push('Shift');
    
    const keyCombo = [...modifiers, event.key].join('+');
    
    logEvent('KEYBOARD', `Key: ${keyCombo}`, {
      key: event.key,
      code: event.code,
      modifiers,
      target: getUniqueSelector(event.target)
    });
  }

  let inputDebounceTimer = null;
  let inputBuffer = { element: null, value: '', startValue: '' };

  function handleInput(event) {
    if (!isRecording || isPaused) return;
    
    const target = event.target;
    const selector = getUniqueSelector(target);
    const currentValue = target.value || target.textContent || '';
    
    if (inputBuffer.element !== selector) {
      if (inputBuffer.element && inputBuffer.value !== inputBuffer.startValue) {
        flushInputBuffer();
      }
      inputBuffer = {
        element: selector,
        value: currentValue,
        startValue: inputBuffer.element === selector ? inputBuffer.startValue : (target.dataset.prevValue || '')
      };
      target.dataset.prevValue = currentValue;
    } else {
      inputBuffer.value = currentValue;
    }
    
    clearTimeout(inputDebounceTimer);
    inputDebounceTimer = setTimeout(() => {
      flushInputBuffer();
      target.dataset.prevValue = currentValue;
    }, 500);
  }

  function flushInputBuffer() {
    if (inputBuffer.element && inputBuffer.value !== inputBuffer.startValue) {
      logEvent('KEYBOARD', `Typed in ${inputBuffer.element}`, {
        target: inputBuffer.element,
        before: inputBuffer.startValue,
        after: inputBuffer.value
      });
      inputBuffer.startValue = inputBuffer.value;
    }
  }

  let scrollDebounceTimer = null;
  let scrollStartPosition = null;

  function handleScroll(event) {
    if (!isRecording || isPaused) return;
    
    const target = event.target === document ? window : event.target;
    const scrollTop = target === window ? window.scrollY : target.scrollTop;
    const scrollLeft = target === window ? window.scrollX : target.scrollLeft;
    
    if (scrollStartPosition === null) {
      scrollStartPosition = { top: scrollTop, left: scrollLeft };
    }
    
    clearTimeout(scrollDebounceTimer);
    scrollDebounceTimer = setTimeout(() => {
      const selector = target === window ? 'window' : getUniqueSelector(target);
      const deltaY = Math.abs(scrollTop - scrollStartPosition.top);
      const direction = scrollTop > scrollStartPosition.top ? 'down' : 'up';
      
      logEvent('SCROLL', `Scrolled ${direction} ${deltaY}px`, {
        target: selector,
        from: scrollStartPosition,
        to: { top: scrollTop, left: scrollLeft }
      });
      
      scrollStartPosition = null;
    }, 300);
  }

  function handleBeforeUnload(event) {
    if (!isRecording || isPaused) return;
    logEvent('NAVIGATION', `Navigating away from ${window.location.href}`);
  }

  // Mutation Observer
  function startMutationObserver() {
    mutationObserver = new MutationObserver(handleMutations);
    
    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeOldValue: true,
      characterData: true,
      characterDataOldValue: true
    });
  }

  function handleMutations(mutations) {
    if (!isRecording || isPaused) return;
    
    const now = Date.now();
    
    const relevantMutations = mutations.filter(mutation => {
      const target = mutation.target;
      
      if (isAgentUIElement(target)) return false;
      if (target.nodeName === 'SCRIPT' || target.nodeName === 'STYLE') return false;
      if (target.id?.startsWith('debug-hand-')) return false;
      if (target.className?.includes?.('debug-hand-')) return false;
      
      if (options.skipDynamic) {
        const selector = getUniqueSelector(target);
        const tracker = dynamicElementTracker.get(selector);
        
        if (tracker) {
          const timeSinceLastChange = now - tracker.lastChange;
          tracker.changeCount++;
          tracker.lastChange = now;
          
          if (timeSinceLastChange < options.dynamicThreshold && tracker.changeCount > 3) {
            return false;
          }
        } else {
          dynamicElementTracker.set(selector, {
            changeCount: 1,
            lastChange: now
          });
        }
      }
      
      return true;
    });
    
    if (relevantMutations.length === 0) return;
    
    pendingMutations.push(...relevantMutations);
    
    clearTimeout(mutationDebounceTimer);
    mutationDebounceTimer = setTimeout(() => {
      processPendingMutations();
    }, 100);
    
    lastMutationTime = now;
  }

  function processPendingMutations() {
    if (pendingMutations.length === 0) return;
    
    const grouped = new Map();
    
    pendingMutations.forEach(mutation => {
      const selector = getUniqueSelector(mutation.target);
      if (!grouped.has(selector)) {
        grouped.set(selector, []);
      }
      grouped.get(selector).push(mutation);
    });
    
    grouped.forEach((mutations, selector) => {
      const changes = [];
      let beforeValue = null;
      let afterValue = null;
      
      mutations.forEach(mutation => {
        if (mutation.type === 'childList') {
          if (mutation.addedNodes.length > 0) {
            const added = Array.from(mutation.addedNodes)
              .filter(n => n.nodeType === 1)
              .map(n => n.tagName?.toLowerCase())
              .filter(Boolean)
              .join(', ');
            if (added) changes.push(`+${added}`);
          }
          if (mutation.removedNodes.length > 0) {
            const removed = Array.from(mutation.removedNodes)
              .filter(n => n.nodeType === 1)
              .map(n => n.tagName?.toLowerCase())
              .filter(Boolean)
              .join(', ');
            if (removed) changes.push(`-${removed}`);
          }
        } else if (mutation.type === 'attributes') {
          const attr = mutation.attributeName;
          if (attr !== 'data-prev-value') {
            beforeValue = mutation.oldValue;
            afterValue = mutation.target.getAttribute(attr);
            changes.push(`${attr} changed`);
          }
        } else if (mutation.type === 'characterData') {
          beforeValue = mutation.oldValue;
          afterValue = mutation.target.textContent;
          changes.push('text changed');
        }
      });
      
      if (changes.length > 0) {
        logEvent('DOM', `${selector}: ${changes.slice(0, 3).join(', ')}`, {
          target: selector,
          changes: changes.slice(0, 5),
          before: beforeValue ? truncate(beforeValue, 100) : undefined,
          after: afterValue ? truncate(afterValue, 100) : undefined
        });
      }
    });
    
    pendingMutations = [];
  }

  // Logging
  function logEvent(type, details, extra = {}) {
    const entry = {
      type,
      details,
      timestamp: Date.now(),
      url: window.location.href,
      ...extra
    };
    
    chrome.storage.local.get('recordLog', ({ recordLog = [] }) => {
      recordLog.push(entry);
      if (recordLog.length > 500) recordLog = recordLog.slice(-500);
      chrome.storage.local.set({ recordLog });
    });
    
    chrome.runtime.sendMessage({ type: 'LOG_ENTRY', entry }).catch(() => {});
  }

  // Agent UI
  function createAgentUI() {
    // Cursor
    agentCursor = document.createElement('div');
    agentCursor.id = 'debug-hand-cursor';
    agentCursor.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
        <path d="M5 3L19 12L12 13L9 20L5 3Z" fill="#3b82f6" stroke="#fff" stroke-width="1.5"/>
      </svg>
    `;
    document.body.appendChild(agentCursor);
    
    // Highlight
    agentHighlight = document.createElement('div');
    agentHighlight.id = 'debug-hand-highlight';
    document.body.appendChild(agentHighlight);
    
    // Tooltip
    agentTooltip = document.createElement('div');
    agentTooltip.id = 'debug-hand-tooltip';
    document.body.appendChild(agentTooltip);
  }

  function isAgentUIElement(element) {
    if (!element) return false;
    if (element.id?.startsWith('debug-hand-')) return true;
    if (element.className?.includes?.('debug-hand-')) return true;
    return false;
  }

  // Agent Actions
  async function handleAgentAction(action) {
    try {
      switch (action.type) {
        case 'MOVE_MOUSE':
          return await moveMouse(action.x, action.y, action.options);
        case 'CLICK':
          return await click(action.selector, action.options);
        case 'TYPE':
          return await typeText(action.selector, action.text, action.options);
        case 'SCROLL':
          return await scroll(action.selector, action.options);
        case 'HOVER':
          return await hover(action.selector);
        case 'GET_SNAPSHOT':
          return getPageSnapshot();
        case 'EVALUATE':
          return await evaluateScript(action.script);
        case 'WAIT':
          return await wait(action.condition, action.timeout);
        
        // ===== DEVTOOLS INSPECTION =====
        case 'INSPECT_ELEMENT':
          return inspectElement(action.selector);
        case 'GET_DOM_TREE':
          return getDOMTree(action.selector, action.depth);
        case 'GET_COMPUTED_STYLES':
          return getComputedStyles(action.selector, action.properties);
        case 'GET_ELEMENT_HTML':
          return getElementHTML(action.selector, action.outer);
        case 'QUERY_ALL':
          return queryAll(action.selector, action.limit);
        case 'GET_CONSOLE_LOGS':
          return getConsoleLogs();
        case 'GET_NETWORK_INFO':
          return getNetworkInfo();
        case 'GET_STORAGE':
          return getStorageData(action.storageType);
        case 'GET_COOKIES':
          return getCookies();
        case 'GET_PAGE_METRICS':
          return getPageMetrics();
        case 'FIND_BY_TEXT':
          return findByText(action.text, action.tag);
        case 'GET_ATTRIBUTES':
          return getAttributes(action.selector);
        case 'GET_EVENT_LISTENERS':
          return getEventListeners(action.selector);
        
        default:
          return { error: 'Unknown action type' };
      }
    } catch (error) {
      return { error: error.message };
    }
  }

  async function moveMouse(x, y, options = {}) {
    const { duration = 300, showCursor = true } = options;
    
    if (showCursor && agentCursor) {
      agentCursor.classList.add('visible');
      
      const startX = parseFloat(agentCursor.style.left) || 0;
      const startY = parseFloat(agentCursor.style.top) || 0;
      const startTime = performance.now();
      
      return new Promise(resolve => {
        function animate(currentTime) {
          const elapsed = currentTime - startTime;
          const progress = Math.min(elapsed / duration, 1);
          const easeProgress = 1 - Math.pow(1 - progress, 2);
          
          const currentX = startX + (x - startX) * easeProgress;
          const currentY = startY + (y - startY) * easeProgress;
          
          agentCursor.style.left = `${currentX}px`;
          agentCursor.style.top = `${currentY}px`;
          
          if (progress < 1) {
            requestAnimationFrame(animate);
          } else {
            resolve({ success: true, x, y });
          }
        }
        
        requestAnimationFrame(animate);
      });
    }
    
    return { success: true, x, y };
  }

  async function click(selector, options = {}) {
    const { button = 0, doubleClick = false, showHighlight = true } = options;
    
    const element = document.querySelector(selector);
    if (!element) {
      return { error: `Element not found: ${selector}` };
    }
    
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    
    await moveMouse(x, y);
    
    if (showHighlight && agentHighlight) {
      highlightElement(element);
    }
    
    showActionTooltip('Click', getElementDescription(element));
    
    const eventOptions = {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button
    };
    
    element.dispatchEvent(new MouseEvent('mousedown', eventOptions));
    element.dispatchEvent(new MouseEvent('mouseup', eventOptions));
    element.dispatchEvent(new MouseEvent('click', eventOptions));
    
    if (doubleClick) {
      element.dispatchEvent(new MouseEvent('dblclick', eventOptions));
    }
    
    if (element.focus) element.focus();
    
    return { 
      success: true, 
      element: getElementDescription(element),
      position: { x, y }
    };
  }

  async function typeText(selector, text, options = {}) {
    const { delay = 30, clear = false } = options;
    
    const element = document.querySelector(selector);
    if (!element) {
      return { error: `Element not found: ${selector}` };
    }
    
    element.focus();
    
    if (clear) {
      if (element.value !== undefined) {
        element.value = '';
      } else if (element.textContent !== undefined) {
        element.textContent = '';
      }
    }
    
    showActionTooltip('Typing', truncate(text, 20));
    
    for (const char of text) {
      const keyEvent = {
        bubbles: true,
        cancelable: true,
        key: char,
        code: `Key${char.toUpperCase()}`
      };
      
      element.dispatchEvent(new KeyboardEvent('keydown', keyEvent));
      element.dispatchEvent(new KeyboardEvent('keypress', keyEvent));
      
      if (element.value !== undefined) {
        element.value += char;
      } else if (element.textContent !== undefined) {
        element.textContent += char;
      }
      
      element.dispatchEvent(new InputEvent('input', { bubbles: true, data: char }));
      element.dispatchEvent(new KeyboardEvent('keyup', keyEvent));
      
      await sleep(delay);
    }
    
    return { success: true, text };
  }

  async function scroll(selector, options = {}) {
    const { direction = 'down', amount = 300 } = options;
    
    const element = selector === 'window' ? window : document.querySelector(selector);
    if (!element && selector !== 'window') {
      return { error: `Element not found: ${selector}` };
    }
    
    const target = element === window ? window : element;
    const scrollAmount = direction === 'down' || direction === 'right' ? amount : -amount;
    
    if (direction === 'down' || direction === 'up') {
      target.scrollBy({ top: scrollAmount, behavior: 'smooth' });
    } else {
      target.scrollBy({ left: scrollAmount, behavior: 'smooth' });
    }
    
    showActionTooltip('Scroll', direction);
    
    return { success: true, direction, amount };
  }

  async function hover(selector) {
    const element = document.querySelector(selector);
    if (!element) {
      return { error: `Element not found: ${selector}` };
    }
    
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    
    await moveMouse(x, y);
    highlightElement(element);
    
    element.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    
    return { success: true, element: getElementDescription(element) };
  }

  function getPageSnapshot() {
    const snapshot = {
      url: window.location.href,
      title: document.title,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight
      },
      scroll: {
        x: window.scrollX,
        y: window.scrollY
      },
      elements: []
    };
    
    const interactiveSelectors = [
      'a[href]', 'button', 'input', 'select', 'textarea',
      '[role="button"]', '[role="link"]', '[role="checkbox"]',
      '[role="radio"]', '[role="tab"]', '[onclick]', '[tabindex]'
    ];
    
    const elements = document.querySelectorAll(interactiveSelectors.join(','));
    
    elements.forEach((el, index) => {
      if (!isVisible(el)) return;
      
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      
      snapshot.elements.push({
        ref: `e${index}`,
        selector: getUniqueSelector(el),
        tag: el.tagName.toLowerCase(),
        type: el.type || null,
        text: truncate(el.textContent?.trim(), 100),
        placeholder: el.placeholder || null,
        value: el.value || null,
        href: el.href || null,
        role: el.getAttribute('role'),
        ariaLabel: el.getAttribute('aria-label'),
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      });
    });
    
    return snapshot;
  }

  async function evaluateScript(script) {
    try {
      const result = eval(script);
      return { success: true, result };
    } catch (error) {
      return { error: error.message };
    }
  }

  async function wait(condition, timeout = 5000) {
    const startTime = Date.now();
    
    if (condition.text) {
      return new Promise(resolve => {
        const check = () => {
          if (document.body.textContent.includes(condition.text)) {
            resolve({ success: true, found: condition.text });
          } else if (Date.now() - startTime > timeout) {
            resolve({ error: `Timeout waiting for text: ${condition.text}` });
          } else {
            setTimeout(check, 100);
          }
        };
        check();
      });
    } else if (condition.selector) {
      return new Promise(resolve => {
        const check = () => {
          if (document.querySelector(condition.selector)) {
            resolve({ success: true, found: condition.selector });
          } else if (Date.now() - startTime > timeout) {
            resolve({ error: `Timeout waiting for element: ${condition.selector}` });
          } else {
            setTimeout(check, 100);
          }
        };
        check();
      });
    } else if (condition.time) {
      await sleep(condition.time);
      return { success: true };
    }
    
    return { error: 'Invalid wait condition' };
  }

  // ===== DEVTOOLS INSPECTION FUNCTIONS =====
  
  // Capture console logs
  const consoleLogs = [];
  const maxConsoleLogs = 100;
  
  // Intercept console methods
  ['log', 'warn', 'error', 'info', 'debug'].forEach(method => {
    const original = console[method];
    console[method] = function(...args) {
      consoleLogs.push({
        type: method,
        message: args.map(a => {
          try {
            return typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a);
          } catch (e) {
            return String(a);
          }
        }).join(' '),
        timestamp: Date.now()
      });
      if (consoleLogs.length > maxConsoleLogs) consoleLogs.shift();
      return original.apply(console, args);
    };
  });

  function inspectElement(selector) {
    const el = document.querySelector(selector);
    if (!el) return { error: `Element not found: ${selector}` };
    
    const rect = el.getBoundingClientRect();
    const styles = window.getComputedStyle(el);
    
    // Get all attributes
    const attributes = {};
    for (const attr of el.attributes) {
      attributes[attr.name] = attr.value;
    }
    
    // Box model
    const boxModel = {
      margin: {
        top: parseFloat(styles.marginTop),
        right: parseFloat(styles.marginRight),
        bottom: parseFloat(styles.marginBottom),
        left: parseFloat(styles.marginLeft)
      },
      padding: {
        top: parseFloat(styles.paddingTop),
        right: parseFloat(styles.paddingRight),
        bottom: parseFloat(styles.paddingBottom),
        left: parseFloat(styles.paddingLeft)
      },
      border: {
        top: parseFloat(styles.borderTopWidth),
        right: parseFloat(styles.borderRightWidth),
        bottom: parseFloat(styles.borderBottomWidth),
        left: parseFloat(styles.borderLeftWidth)
      },
      content: {
        width: rect.width - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight) - parseFloat(styles.borderLeftWidth) - parseFloat(styles.borderRightWidth),
        height: rect.height - parseFloat(styles.paddingTop) - parseFloat(styles.paddingBottom) - parseFloat(styles.borderTopWidth) - parseFloat(styles.borderBottomWidth)
      }
    };
    
    // Key CSS properties
    const cssProperties = {
      display: styles.display,
      position: styles.position,
      top: styles.top,
      left: styles.left,
      right: styles.right,
      bottom: styles.bottom,
      width: styles.width,
      height: styles.height,
      color: styles.color,
      backgroundColor: styles.backgroundColor,
      fontSize: styles.fontSize,
      fontFamily: styles.fontFamily,
      fontWeight: styles.fontWeight,
      lineHeight: styles.lineHeight,
      textAlign: styles.textAlign,
      zIndex: styles.zIndex,
      overflow: styles.overflow,
      opacity: styles.opacity,
      visibility: styles.visibility,
      flex: styles.flex,
      flexDirection: styles.flexDirection,
      justifyContent: styles.justifyContent,
      alignItems: styles.alignItems,
      gridTemplateColumns: styles.gridTemplateColumns,
      gridTemplateRows: styles.gridTemplateRows
    };
    
    return {
      selector: selector,
      tagName: el.tagName.toLowerCase(),
      id: el.id || null,
      className: el.className || null,
      attributes: attributes,
      textContent: truncate(el.textContent?.trim(), 500),
      innerText: truncate(el.innerText?.trim(), 500),
      value: el.value || null,
      checked: el.checked,
      disabled: el.disabled,
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        top: Math.round(rect.top),
        right: Math.round(rect.right),
        bottom: Math.round(rect.bottom),
        left: Math.round(rect.left)
      },
      boxModel: boxModel,
      css: cssProperties,
      childCount: el.children.length,
      parentTag: el.parentElement?.tagName.toLowerCase(),
      visible: isVisible(el),
      inViewport: isInViewport(el)
    };
  }

  function getDOMTree(selector, depth = 3) {
    const root = selector ? document.querySelector(selector) : document.body;
    if (!root) return { error: `Element not found: ${selector}` };
    
    function buildTree(el, currentDepth) {
      if (currentDepth > depth) return null;
      if (!el || el.nodeType !== 1) return null;
      if (isAgentUIElement(el)) return null;
      
      const node = {
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        class: el.className && typeof el.className === 'string' ? el.className.split(' ').filter(c => c && !c.startsWith('debug-hand')).join(' ') : null,
        text: el.children.length === 0 ? truncate(el.textContent?.trim(), 50) : null,
        children: []
      };
      
      if (currentDepth < depth) {
        for (const child of el.children) {
          const childNode = buildTree(child, currentDepth + 1);
          if (childNode) node.children.push(childNode);
        }
      } else if (el.children.length > 0) {
        node.childCount = el.children.length;
      }
      
      return node;
    }
    
    return buildTree(root, 0);
  }

  function getComputedStyles(selector, properties = null) {
    const el = document.querySelector(selector);
    if (!el) return { error: `Element not found: ${selector}` };
    
    const styles = window.getComputedStyle(el);
    
    if (properties && Array.isArray(properties)) {
      const result = {};
      properties.forEach(prop => {
        result[prop] = styles.getPropertyValue(prop);
      });
      return result;
    }
    
    // Return all commonly used properties
    const allStyles = {};
    const commonProps = [
      'display', 'position', 'top', 'right', 'bottom', 'left',
      'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
      'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
      'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
      'border', 'border-width', 'border-style', 'border-color', 'border-radius',
      'background', 'background-color', 'background-image',
      'color', 'font-family', 'font-size', 'font-weight', 'line-height', 'text-align',
      'flex', 'flex-direction', 'flex-wrap', 'justify-content', 'align-items', 'gap',
      'grid-template-columns', 'grid-template-rows',
      'overflow', 'overflow-x', 'overflow-y',
      'z-index', 'opacity', 'visibility', 'cursor', 'pointer-events',
      'transform', 'transition', 'animation'
    ];
    
    commonProps.forEach(prop => {
      const value = styles.getPropertyValue(prop);
      if (value && value !== 'none' && value !== 'normal' && value !== 'auto' && value !== '0px' && value !== 'rgba(0, 0, 0, 0)') {
        allStyles[prop] = value;
      }
    });
    
    return allStyles;
  }

  function getElementHTML(selector, outer = true) {
    const el = document.querySelector(selector);
    if (!el) return { error: `Element not found: ${selector}` };
    
    return {
      html: outer ? el.outerHTML : el.innerHTML,
      length: outer ? el.outerHTML.length : el.innerHTML.length
    };
  }

  function queryAll(selector, limit = 20) {
    const elements = document.querySelectorAll(selector);
    const results = [];
    
    for (let i = 0; i < Math.min(elements.length, limit); i++) {
      const el = elements[i];
      const rect = el.getBoundingClientRect();
      
      results.push({
        index: i,
        selector: getUniqueSelector(el),
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        class: el.className || null,
        text: truncate(el.textContent?.trim(), 50),
        visible: isVisible(el),
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
      });
    }
    
    return {
      total: elements.length,
      showing: results.length,
      elements: results
    };
  }

  function getConsoleLogs() {
    return {
      logs: consoleLogs.slice(-50),
      total: consoleLogs.length
    };
  }

  function getNetworkInfo() {
    const entries = performance.getEntriesByType('resource');
    const requests = entries.slice(-30).map(entry => ({
      name: entry.name.split('/').pop().slice(0, 50) || entry.name.slice(0, 50),
      fullUrl: entry.name,
      type: entry.initiatorType,
      duration: Math.round(entry.duration),
      size: entry.transferSize || 0,
      startTime: Math.round(entry.startTime)
    }));
    
    const navigation = performance.getEntriesByType('navigation')[0];
    
    return {
      requests: requests,
      totalRequests: entries.length,
      navigation: navigation ? {
        domContentLoaded: Math.round(navigation.domContentLoadedEventEnd - navigation.startTime),
        load: Math.round(navigation.loadEventEnd - navigation.startTime),
        domInteractive: Math.round(navigation.domInteractive - navigation.startTime)
      } : null
    };
  }

  function getStorageData(storageType = 'local') {
    const storage = storageType === 'session' ? sessionStorage : localStorage;
    const data = {};
    
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      try {
        const value = storage.getItem(key);
        data[key] = value.length > 200 ? value.slice(0, 200) + '...' : value;
      } catch (e) {
        data[key] = '[Error reading]';
      }
    }
    
    return {
      type: storageType,
      count: storage.length,
      data: data
    };
  }

  function getCookies() {
    const cookies = document.cookie.split(';').map(c => {
      const [name, ...valueParts] = c.trim().split('=');
      return {
        name: name,
        value: truncate(valueParts.join('='), 100)
      };
    }).filter(c => c.name);
    
    return {
      count: cookies.length,
      cookies: cookies
    };
  }

  function getPageMetrics() {
    const timing = performance.timing;
    const memory = performance.memory || {};
    
    return {
      url: window.location.href,
      title: document.title,
      readyState: document.readyState,
      documentHeight: document.documentElement.scrollHeight,
      documentWidth: document.documentElement.scrollWidth,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight
      },
      scroll: {
        x: window.scrollX,
        y: window.scrollY,
        maxX: document.documentElement.scrollWidth - window.innerWidth,
        maxY: document.documentElement.scrollHeight - window.innerHeight
      },
      elements: {
        total: document.querySelectorAll('*').length,
        forms: document.forms.length,
        images: document.images.length,
        links: document.links.length,
        scripts: document.scripts.length
      },
      memory: {
        usedJSHeapSize: memory.usedJSHeapSize ? Math.round(memory.usedJSHeapSize / 1024 / 1024) + ' MB' : 'N/A',
        totalJSHeapSize: memory.totalJSHeapSize ? Math.round(memory.totalJSHeapSize / 1024 / 1024) + ' MB' : 'N/A'
      },
      timing: {
        pageLoad: timing.loadEventEnd - timing.navigationStart,
        domReady: timing.domContentLoadedEventEnd - timing.navigationStart,
        firstByte: timing.responseStart - timing.navigationStart
      }
    };
  }

  function findByText(text, tag = null) {
    const xpath = tag 
      ? `//${tag}[contains(text(), "${text}")]`
      : `//*[contains(text(), "${text}")]`;
    
    const result = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    const elements = [];
    
    for (let i = 0; i < Math.min(result.snapshotLength, 10); i++) {
      const el = result.snapshotItem(i);
      elements.push({
        selector: getUniqueSelector(el),
        tag: el.tagName.toLowerCase(),
        text: truncate(el.textContent, 100),
        visible: isVisible(el)
      });
    }
    
    return {
      found: result.snapshotLength,
      elements: elements
    };
  }

  function getAttributes(selector) {
    const el = document.querySelector(selector);
    if (!el) return { error: `Element not found: ${selector}` };
    
    const attributes = {};
    for (const attr of el.attributes) {
      attributes[attr.name] = attr.value;
    }
    
    // Also get data attributes
    const dataset = {};
    for (const key in el.dataset) {
      dataset[key] = el.dataset[key];
    }
    
    return {
      attributes: attributes,
      dataset: dataset,
      properties: {
        tagName: el.tagName,
        nodeName: el.nodeName,
        nodeType: el.nodeType,
        childElementCount: el.childElementCount,
        textContentLength: el.textContent?.length || 0
      }
    };
  }

  function getEventListeners(selector) {
    const el = document.querySelector(selector);
    if (!el) return { error: `Element not found: ${selector}` };
    
    // Check for common event handler attributes
    const inlineHandlers = [];
    const eventAttrs = ['onclick', 'onchange', 'onsubmit', 'onmouseover', 'onmouseout', 'onfocus', 'onblur', 'onkeydown', 'onkeyup', 'oninput'];
    
    eventAttrs.forEach(attr => {
      if (el.hasAttribute(attr)) {
        inlineHandlers.push({ event: attr.replace('on', ''), type: 'inline' });
      }
    });
    
    return {
      selector: selector,
      inlineHandlers: inlineHandlers,
      note: 'JS event listeners cannot be enumerated without getEventListeners() (DevTools only)'
    };
  }

  function isInViewport(el) {
    const rect = el.getBoundingClientRect();
    return (
      rect.top >= 0 &&
      rect.left >= 0 &&
      rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
      rect.right <= (window.innerWidth || document.documentElement.clientWidth)
    );
  }

  // Utility Functions
  function highlightElement(element) {
    if (!agentHighlight) return;
    
    const rect = element.getBoundingClientRect();
    agentHighlight.style.left = `${rect.left}px`;
    agentHighlight.style.top = `${rect.top}px`;
    agentHighlight.style.width = `${rect.width}px`;
    agentHighlight.style.height = `${rect.height}px`;
    agentHighlight.classList.add('visible');
    
    setTimeout(() => {
      agentHighlight.classList.remove('visible');
    }, 800);
  }

  function showActionTooltip(action, detail) {
    if (!agentTooltip) return;
    
    agentTooltip.textContent = `${action}: ${detail}`;
    agentTooltip.classList.add('visible');
    
    setTimeout(() => {
      agentTooltip.classList.remove('visible');
    }, 1200);
  }

  function getUniqueSelector(element) {
    if (!element || element === document) return '';
    
    if (element.id && !element.id.startsWith('debug-hand-')) {
      return `#${CSS.escape(element.id)}`;
    }
    
    const path = [];
    let current = element;
    
    while (current && current !== document.body) {
      let selector = current.tagName.toLowerCase();
      
      if (current.className && typeof current.className === 'string') {
        const classes = current.className.trim().split(/\s+/)
          .filter(c => !c.startsWith('debug-hand-'))
          .slice(0, 2);
        if (classes.length && classes[0]) {
          selector += '.' + classes.map(c => CSS.escape(c)).join('.');
        }
      }
      
      const siblings = current.parentElement?.children;
      if (siblings && siblings.length > 1) {
        const index = Array.from(siblings).indexOf(current) + 1;
        selector += `:nth-child(${index})`;
      }
      
      path.unshift(selector);
      current = current.parentElement;
      
      if (path.length > 4) break;
    }
    
    return path.join(' > ');
  }

  function getElementDescription(element) {
    if (!element) return '';
    
    let desc = element.tagName.toLowerCase();
    
    if (element.id && !element.id.startsWith('debug-hand-')) {
      desc += `#${element.id}`;
    } else if (element.className && typeof element.className === 'string') {
      const classes = element.className.trim().split(/\s+/)
        .filter(c => !c.startsWith('debug-hand-'))
        .slice(0, 1);
      if (classes.length && classes[0]) {
        desc += `.${classes[0]}`;
      }
    }
    
    const text = element.textContent?.trim().slice(0, 25);
    if (text) desc += ` "${text}${text.length >= 25 ? '…' : ''}"`;
    
    return desc;
  }

  function getElementInfo(selector) {
    const element = document.querySelector(selector);
    if (!element) return null;
    
    const rect = element.getBoundingClientRect();
    const styles = window.getComputedStyle(element);
    
    return {
      selector,
      tag: element.tagName.toLowerCase(),
      id: element.id,
      className: element.className,
      text: element.textContent?.trim().slice(0, 200),
      value: element.value,
      href: element.href,
      src: element.src,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      styles: {
        display: styles.display,
        visibility: styles.visibility,
        opacity: styles.opacity
      },
      visible: isVisible(element)
    };
  }

  function getPageState() {
    return {
      url: window.location.href,
      title: document.title,
      readyState: document.readyState,
      scroll: { x: window.scrollX, y: window.scrollY },
      viewport: { width: window.innerWidth, height: window.innerHeight }
    };
  }

  function isVisible(element) {
    if (!element) return false;
    
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function truncate(str, maxLen) {
    if (!str) return '';
    str = String(str);
    return str.length > maxLen ? str.slice(0, maxLen) + '…' : str;
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Initialize
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
