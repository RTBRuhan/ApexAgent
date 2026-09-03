// ApexAgent Content Script (MV3)
// Implements the contracts defined in CONTENT_ACTIONS.md and INTERNAL_PROTOCOL.md

let currentGeneration = 0;
const refRegistry = new Map(); // Map<string, WeakRef<Element>>
let selfFrameId = performance.now() + Math.random();

// --- 1. Wire Format & Lifecycle ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.__apex !== 1 || message.kind !== 'action') {
    return false;
  }

  // Sync generation from worker if provided
  if (typeof message.generation === 'number' && message.generation > currentGeneration) {
    currentGeneration = message.generation;
  }

  handleAction(message).then(
    (data) => {
      sendResponse({ __apex: 1, requestId: message.requestId, ok: true, data });
    },
    (error) => {
      sendResponse({
        __apex: 1,
        requestId: message.requestId,
        ok: false,
        error: {
          code: error.code || 'INTERNAL',
          message: error.message || String(error),
          hint: error.hint || ''
        }
      });
    }
  );

  return true; // Keep message channel open for async response
});

// Generation advances on nav events
window.addEventListener('pagehide', () => currentGeneration++);
window.addEventListener('popstate', () => currentGeneration++);
const origPushState = history.pushState;
history.pushState = function(...args) {
  currentGeneration++;
  return origPushState.apply(this, args);
};


// --- Error Classes ---
class ApexError extends Error {
  constructor(code, message, hint) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

// --- Overlay Management ---
const overlayHost = document.createElement('div');
overlayHost.style.all = 'initial';
const shadow = overlayHost.attachShadow({ mode: 'closed' });
// Don't append yet, only when needed.

let overlayElements = {};

function getOverlayRoot() {
  if (!overlayHost.isConnected) {
    document.documentElement.appendChild(overlayHost);
  }
  return shadow;
}

// Ensure overlay persists if body is replaced
const observer = new MutationObserver((mutations) => {
  if (!overlayHost.isConnected && Object.keys(overlayElements).length > 0) {
    document.documentElement.appendChild(overlayHost);
  }
});
observer.observe(document.documentElement, { childList: true });

function updateOverlay(action, params) {
  const root = getOverlayRoot();
  
  if (action === 'hide') {
    overlayHost.style.display = 'none';
    return { visible: false };
  } else if (action === 'show') {
    overlayHost.style.display = 'block';
    return { visible: true };
  } else if (action === 'cursor') {
    if (!overlayElements.cursor) {
      const cursor = document.createElement('div');
      cursor.style.cssText = 'position:fixed; width:20px; height:20px; background:red; border-radius:50%; pointer-events:none; z-index:2147483647; transform:translate(-50%,-50%);';
      root.appendChild(cursor);
      overlayElements.cursor = cursor;
    }
    overlayElements.cursor.style.left = `${params.x}px`;
    overlayElements.cursor.style.top = `${params.y}px`;
  } else if (action === 'highlight') {
    if (!overlayElements.highlight) {
      const hl = document.createElement('div');
      hl.style.cssText = 'position:fixed; background:rgba(255, 255, 0, 0.3); border:2px solid yellow; pointer-events:none; z-index:2147483646; box-sizing:border-box;';
      root.appendChild(hl);
      overlayElements.highlight = hl;
    }
    overlayElements.highlight.style.left = `${params.rect[0]}px`;
    overlayElements.highlight.style.top = `${params.rect[1]}px`;
    overlayElements.highlight.style.width = `${params.rect[2]}px`;
    overlayElements.highlight.style.height = `${params.rect[3]}px`;
  } else if (action === 'toast' || action === 'state') {
    if (!overlayElements.toast) {
      const toast = document.createElement('div');
      toast.style.cssText = 'position:fixed; bottom:20px; right:20px; background:rgba(0,0,0,0.8); color:white; padding:10px 20px; border-radius:5px; font-family:sans-serif; z-index:2147483647; pointer-events:none;';
      root.appendChild(toast);
      overlayElements.toast = toast;
    }
    overlayElements.toast.textContent = params.text;
  }
  
  return { visible: overlayHost.style.display !== 'none' };
}


// --- 2. Ref Registry ---
function resolveRef(ref) {
  const match = /^e(\d+)-(\d+)$/.exec(ref);
  if (!match) throw new ApexError('BAD_PARAMS', `Invalid ref format: ${ref}`);
  
  const gen = parseInt(match[1], 10);
  if (gen < currentGeneration) {
    throw new ApexError('STALE_REF', `Ref ${ref} is from snapshot generation ${gen}; the page is now at generation ${currentGeneration}.`, 'Call browser_snapshot again and use a ref from the new snapshot.');
  }
  
  const weakRef = refRegistry.get(ref);
  if (!weakRef) {
    throw new ApexError('NOT_FOUND', `Ref ${ref} not found in registry.`, 'The element may not have been captured in the last snapshot.');
  }
  
  const el = weakRef.deref();
  if (!el || !el.isConnected) {
    throw new ApexError('NODE_DETACHED', `Ref ${ref} resolved but the node has left the document.`, 'The page re-rendered; re-snapshot.');
  }
  
  return el;
}

// --- 3. Target Resolution ---
function querySelectorDeepAll(root, selector) {
  const results = [];
  const walk = (node) => {
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.matches && node.matches(selector)) {
        results.push(node);
      }
      if (node.shadowRoot) {
        walk(node.shadowRoot);
      }
    }
    let child = node.firstElementChild;
    while (child) {
      walk(child);
      child = child.nextElementSibling;
    }
  };
  walk(root);
  return results;
}

function resolveTarget(target) {
  if (!target) throw new ApexError('BAD_PARAMS', 'Missing target parameter');
  
  if (target.ref) {
    return resolveRef(target.ref);
  }
  
  if (target.selector) {
    const matches = querySelectorDeepAll(document.documentElement, target.selector);
    if (matches.length === 0) throw new ApexError('NOT_FOUND', `Selector ${target.selector} matched nothing.`);
    if (matches.length > 1) throw new ApexError('AMBIGUOUS', `Selector ${target.selector} matched ${matches.length} elements.`);
    return matches[0];
  }
  
  if (target.text) {
    const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT, null, false);
    const matches = [];
    let node;
    while (node = walker.nextNode()) {
      if (node.nodeValue.includes(target.text)) {
        if (node.parentElement && node.parentElement.isConnected) {
          matches.push(node.parentElement);
        }
      }
    }
    if (matches.length === 0) throw new ApexError('NOT_FOUND', `Text "${target.text}" matched nothing.`);
    if (matches.length > 1) throw new ApexError('AMBIGUOUS', `Text "${target.text}" matched ${matches.length} elements.`);
    return matches[0];
  }
  
  throw new ApexError('BAD_PARAMS', 'Target must specify one of: ref, selector, text');
}

// --- Helpers ---
function getElementRect(el) {
  const rect = el.getBoundingClientRect();
  return [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)];
}

function isElementVisible(el) {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  return true;
}

function getCenter(rectArr) {
  return {
    x: Math.round(rectArr[0] + rectArr[2] / 2),
    y: Math.round(rectArr[1] + rectArr[3] / 2)
  };
}

function getAccessibleName(el) {
  if (el.hasAttribute('aria-labelledby')) {
    const ids = el.getAttribute('aria-labelledby').split(/\s+/);
    const texts = ids.map(id => document.getElementById(id)?.textContent?.trim()).filter(Boolean);
    if (texts.length) return texts.join(' ');
  }
  if (el.hasAttribute('aria-label')) return el.getAttribute('aria-label').trim();
  
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) return label.textContent.trim();
    }
    const parentLabel = el.closest('label');
    if (parentLabel) return parentLabel.textContent.trim();
  }
  
  if (el.tagName === 'IMG' || el.tagName === 'AREA' || (el.tagName === 'INPUT' && el.type === 'image')) {
    if (el.hasAttribute('alt')) return el.getAttribute('alt').trim();
  }
  
  if (el.hasAttribute('title')) return el.getAttribute('title').trim();
  
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    if (el.hasAttribute('placeholder')) return el.getAttribute('placeholder').trim();
  }
  
  const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
  if (text.length > 100) return text.substring(0, 100) + '...';
  return text;
}

function getStates(el) {
  const states = [];
  if (el.disabled) states.push('disabled');
  if (el.checked) states.push('checked');
  if (el.selected) states.push('selected');
  if (el.hasAttribute('aria-expanded')) states.push('expanded');
  if (el.required || el.hasAttribute('aria-required')) states.push('required');
  if (el.hasAttribute('aria-invalid')) states.push('invalid');
  if (el.readOnly) states.push('readonly');
  if (document.activeElement === el) states.push('focused');
  if (el.tabIndex >= 0) states.push('focusable');
  return states;
}

function nextFrame() {
  return new Promise(resolve => requestAnimationFrame(resolve));
}


// --- 4. Actions ---

async function handleAction(message) {
  const { action, params } = message;
  
  switch (action) {
    case 'snapshot':
      return await actionSnapshot(params);
    case 'resolve':
      return actionResolve(params);
    case 'scrollIntoView':
      return await actionScrollIntoView(params);
    case 'query':
      return actionQuery(params);
    case 'inspect':
      return actionInspect(params);
    case 'styles':
      return actionStyles(params);
    case 'dom':
      return actionDom(params);
    case 'pageInfo':
      return actionPageInfo(params);
    case 'storage':
      return actionStorage(params);
    case 'scroll':
      return actionScroll(params);
    case 'selectOption':
      return actionSelectOption(params);
    case 'waitFor':
      return await actionWaitFor(params);
    case 'clickFallback':
      return await actionClickFallback(params);
    case 'typeFallback':
      return actionTypeFallback(params);
    case 'hoverFallback':
      return actionHoverFallback(params);
    case 'a11yFallback':
      return actionA11yFallback(params);
    case 'overlay':
      return updateOverlay(params.action, params);
    case 'fileInputInfo':
      return actionFileInputInfo(params);
    case 'ping':
      return { generation: currentGeneration, url: location.href, frameId: window.top === window ? 0 : selfFrameId, ready: true };
    default:
      throw new ApexError('BAD_PARAMS', `Unknown action: ${action}`);
  }
}

async function actionSnapshot(params) {
  currentGeneration++; // Advance generation on snapshot
  refRegistry.clear();
  
  const { mode = 'interactive', selector, maxElements = 1500, includeInvisible = false } = params;
  
  const allElements = [];
  
  if (mode === 'interactive') {
    const q = `a[href], button, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="tab"], [role="menuitem"], [role="option"], [role="switch"], [role="combobox"], [role="textbox"], [role="slider"], [role="treeitem"], [onclick], [tabindex], details>summary, [contenteditable]`;
    allElements.push(...querySelectorDeepAll(document.documentElement, q));
  } else if (mode === 'full') {
    allElements.push(...querySelectorDeepAll(document.documentElement, '*'));
  } else if (mode === 'text') {
    // Collect all leaf elements with text
    const els = querySelectorDeepAll(document.documentElement, '*');
    els.forEach(el => {
      if (el.childElementCount === 0 && el.textContent.trim()) {
        allElements.push(el);
      }
    });
  }
  
  let ordinal = 0;
  const elements = [];
  let truncated = false;
  
  for (const el of allElements) {
    if (el === overlayHost || overlayHost.contains(el)) continue; // Skip overlay
    
    if (selector && !el.matches(selector)) continue;
    
    if (!includeInvisible && !isElementVisible(el)) continue;
    
    if (elements.length >= maxElements) {
      truncated = true;
      break;
    }
    
    ordinal++;
    const ref = `e${currentGeneration}-${ordinal}`;
    refRegistry.set(ref, new WeakRef(el));
    el.setAttribute('data-apex-ref', ref);
    
    const rect = getElementRect(el);
    const center = getCenter(rect);
    let hint = undefined;
    
    if (rect[0] < 0 || rect[1] < 0 || rect[0] > window.innerWidth || rect[1] > window.innerHeight) {
      hint = 'offscreen';
    } else {
      const topEl = document.elementFromPoint(center.x, center.y);
      if (topEl && topEl !== el && !el.contains(topEl)) {
        hint = 'occluded';
      }
    }
    
    let depth = 0;
    let curr = el;
    while (curr && curr !== document.body) {
      depth++;
      curr = curr.parentElement;
    }
    
    let role = el.getAttribute('role');
    if (!role) {
      if (el.tagName === 'BUTTON') role = 'button';
      else if (el.tagName === 'A') role = 'link';
      else if (el.tagName === 'INPUT' && el.type === 'checkbox') role = 'checkbox';
      // simple heuristics for missing roles
    }
    
    const nodeData = {
      ref,
      role: role || undefined,
      name: getAccessibleName(el) || undefined,
      tag: el.tagName.toLowerCase(),
      value: el.value || undefined,
      state: getStates(el),
      level: /^H[1-6]$/.test(el.tagName) ? parseInt(el.tagName.charAt(1), 10) : undefined,
      frameId: window.top === window ? 0 : selfFrameId,
      depth,
      rect,
    };
    if (hint) nodeData.hint = hint;
    
    elements.push(nodeData);
  }
  
  return {
    generation: currentGeneration,
    url: location.href,
    title: document.title,
    frameId: window.top === window ? 0 : selfFrameId,
    elements,
    truncated,
    counts: { total: elements.length }
  };
}

function actionResolve(params) {
  const target = resolveTarget(params); // could throw
  const rect = getElementRect(target);
  const center = getCenter(rect);
  
  const visible = isElementVisible(target);
  const style = window.getComputedStyle(target);
  const interactable = !target.disabled && visible && style.pointerEvents !== 'none';
  
  const topEl = document.elementFromPoint(center.x, center.y);
  let occludedBy = undefined;
  if (topEl && topEl !== target && !target.contains(topEl)) {
    occludedBy = getUniqueSelector(topEl);
  }
  
  const inViewport = (rect[0] >= 0 && rect[1] >= 0 && rect[2] > 0 && rect[3] > 0 && rect[0] < window.innerWidth && rect[1] < window.innerHeight);
  
  return {
    rect,
    center,
    tagName: target.tagName.toLowerCase(),
    role: target.getAttribute('role') || undefined,
    name: getAccessibleName(target),
    visible,
    interactable,
    occludedBy,
    inViewport,
    frameOffset: { x: 0, y: 0 }
  };
}

async function actionScrollIntoView(params) {
  const target = resolveTarget(params);
  target.scrollIntoView({ block: params.block || 'center', behavior: 'instant' });
  await nextFrame();
  const rect = getElementRect(target);
  return { scrolled: true, rect, center: getCenter(rect) };
}

function actionQuery(params) {
  const { selector, text, role, limit = 50, attributes = [] } = params;
  let matches = [];
  
  if (selector) {
    matches = querySelectorDeepAll(document.documentElement, selector);
  } else if (text) {
    const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT, null, false);
    let node;
    while (node = walker.nextNode()) {
      if (node.nodeValue.includes(text)) {
        if (node.parentElement && node.parentElement.isConnected) {
          matches.push(node.parentElement);
        }
      }
    }
  } else if (role) {
    matches = querySelectorDeepAll(document.documentElement, `[role="${CSS.escape(role)}"]`);
  }
  
  const uniqueMatches = Array.from(new Set(matches));
  const total = uniqueMatches.length;
  const sliced = uniqueMatches.slice(0, limit);
  
  const results = sliced.map(el => {
    const ref = el.getAttribute('data-apex-ref');
    const res = {
      ref,
      tagName: el.tagName.toLowerCase(),
      role: el.getAttribute('role'),
      name: getAccessibleName(el),
      text: el.textContent.substring(0, 100),
      rect: getElementRect(el)
    };
    if (attributes.length > 0) {
      res.attributes = {};
      attributes.forEach(attr => res.attributes[attr] = el.getAttribute(attr));
    }
    return res;
  });
  
  return { matches: results, total, truncated: total > limit };
}

function actionInspect(params) {
  const target = resolveTarget(params);
  const includes = params.include || ['box', 'styles', 'attributes', 'accessibility', 'listeners', 'interactability'];
  
  const res = {};
  if (includes.includes('box')) {
    res.box = getElementRect(target);
  }
  if (includes.includes('styles')) {
    const cs = window.getComputedStyle(target);
    res.styles = {
      display: cs.display,
      position: cs.position,
      visibility: cs.visibility,
      opacity: cs.opacity
    };
  }
  if (includes.includes('attributes')) {
    res.attributes = {};
    for (const attr of target.attributes) {
      res.attributes[attr.name] = attr.value;
    }
  }
  if (includes.includes('accessibility')) {
    res.accessibility = {
      name: getAccessibleName(target),
      role: target.getAttribute('role'),
      states: getStates(target)
    };
  }
  if (includes.includes('interactability')) {
    const visible = isElementVisible(target);
    const style = window.getComputedStyle(target);
    res.interactability = {
      visible,
      disabled: !!target.disabled,
      pointerEvents: style.pointerEvents !== 'none'
    };
  }
  
  // Note: we can't truly get all event listeners from the DOM natively in MV3 content scripts.
  // We skip listeners or return an empty object since it's typically done via CDP.
  if (includes.includes('listeners')) {
    res.listeners = [];
  }
  
  return res;
}

function actionStyles(params) {
  const target = resolveTarget(params);
  const cs = window.getComputedStyle(target);
  const properties = params.properties || ['display', 'visibility', 'opacity', 'color', 'background-color', 'font-size'];
  
  const computed = {};
  for (const prop of properties) {
    computed[prop] = cs.getPropertyValue(prop);
  }
  return { computed };
}

function actionDom(params) {
  const { action, selector, depth = 1, maxBytes = 1000000 } = params;
  const root = selector ? (querySelectorDeepAll(document.documentElement, selector)[0] || document.documentElement) : document.documentElement;
  
  if (action === 'html') {
    const html = params.outer ? root.outerHTML : root.innerHTML;
    if (html.length > maxBytes) {
      return { html: html.substring(0, maxBytes), truncated: true, bytes: html.length };
    }
    return { html, truncated: false, bytes: html.length };
  } else if (action === 'tree') {
    // simplified tree structure
    const buildTree = (node, d) => {
      if (d > depth) return null;
      if (node.nodeType === Node.TEXT_NODE) {
        return { type: 'text', value: node.nodeValue.trim() };
      }
      if (node.nodeType === Node.ELEMENT_NODE) {
        const children = [];
        let child = node.firstChild;
        while (child) {
          const c = buildTree(child, d + 1);
          if (c && (c.type !== 'text' || c.value)) children.push(c);
          child = child.nextSibling;
        }
        return {
          type: 'element',
          tag: node.tagName.toLowerCase(),
          id: node.id || undefined,
          className: typeof node.className === 'string' ? node.className : undefined,
          children: children.length > 0 ? children : undefined
        };
      }
      return null;
    };
    return { tree: buildTree(root, 0) };
  }
}

function actionPageInfo(params) {
  const includes = params.include || ['basic', 'viewport', 'meta', 'performance', 'counts'];
  const res = {};
  
  if (includes.includes('basic')) {
    res.basic = { url: location.href, title: document.title };
  }
  if (includes.includes('viewport')) {
    res.viewport = { width: window.innerWidth, height: window.innerHeight, scrollX: window.scrollX, scrollY: window.scrollY };
  }
  if (includes.includes('meta')) {
    res.meta = {};
    const metas = document.querySelectorAll('meta');
    metas.forEach(m => {
      if (m.name) res.meta[m.name] = m.content;
      if (m.getAttribute('property')) res.meta[m.getAttribute('property')] = m.content;
    });
  }
  if (includes.includes('performance')) {
    if (window.performance && performance.timing) {
      res.performance = { loadEventEnd: performance.timing.loadEventEnd, domComplete: performance.timing.domComplete };
    }
  }
  if (includes.includes('counts')) {
    res.counts = { elements: document.getElementsByTagName('*').length };
  }
  
  return res;
}

function actionStorage(params) {
  const { type, keyContains, redactValues } = params;
  const res = {};
  
  const filterAndFormat = (store) => {
    const data = {};
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (keyContains && !key.includes(keyContains)) continue;
      data[key] = redactValues ? '***' : store.getItem(key);
    }
    return data;
  };
  
  if (type === 'local' || type === 'all') {
    try { res.local = filterAndFormat(window.localStorage); } catch (e) {}
  }
  if (type === 'session' || type === 'all') {
    try { res.session = filterAndFormat(window.sessionStorage); } catch (e) {}
  }
  if (type === 'cookies' || type === 'all') {
    res.cookies = redactValues ? '***' : document.cookie;
  }
  
  return res;
}

function actionScroll(params) {
  const { direction, amount = 500, container } = params;
  const scrollContainer = container ? resolveTarget({ selector: container }) : window;
  
  const x = scrollContainer === window ? window.scrollX : scrollContainer.scrollLeft;
  const y = scrollContainer === window ? window.scrollY : scrollContainer.scrollTop;
  
  let dX = 0, dY = 0;
  if (direction === 'up') dY = -amount;
  if (direction === 'down') dY = amount;
  if (direction === 'left') dX = -amount;
  if (direction === 'right') dX = amount;
  
  scrollContainer.scrollBy({ left: dX, top: dY, behavior: 'instant' });
  
  const newX = scrollContainer === window ? window.scrollX : scrollContainer.scrollLeft;
  const newY = scrollContainer === window ? window.scrollY : scrollContainer.scrollTop;
  
  const maxX = scrollContainer === window ? document.documentElement.scrollWidth - window.innerWidth : scrollContainer.scrollWidth - scrollContainer.clientWidth;
  const maxY = scrollContainer === window ? document.documentElement.scrollHeight - window.innerHeight : scrollContainer.scrollHeight - scrollContainer.clientHeight;
  
  return { x: newX, y: newY, maxX, maxY, atEnd: newY >= maxY, moved: x !== newX || y !== newY };
}

function actionSelectOption(params) {
  const target = resolveTarget(params);
  if (target.tagName !== 'SELECT') throw new ApexError('BAD_PARAMS', 'Target must be a <select> element');
  
  const { values, labels, indices } = params;
  const selected = [];
  
  for (let i = 0; i < target.options.length; i++) {
    const opt = target.options[i];
    let match = false;
    if (values && values.includes(opt.value)) match = true;
    if (labels && labels.includes(opt.label || opt.text)) match = true;
    if (indices && indices.includes(i)) match = true;
    
    if (match) {
      opt.selected = true;
      selected.push({ value: opt.value, label: opt.label || opt.text, index: i });
      if (!target.multiple) break;
    }
  }
  
  target.dispatchEvent(new Event('change', { bubbles: true }));
  return { selected };
}

async function actionWaitFor(params) {
  const { state, timeoutMs = 5000, delayMs = 100 } = params;
  const start = Date.now();
  
  while (Date.now() - start < timeoutMs) {
    let met = false;
    let target = null;
    
    try {
      target = resolveTarget(params); // this throws if NOT_FOUND, so catch is necessary for some states
    } catch (e) {
      if (state === 'detached') met = true;
    }
    
    if (target) {
      if (state === 'attached') met = true;
      else if (state === 'visible') met = isElementVisible(target);
      else if (state === 'hidden') met = !isElementVisible(target);
    }
    
    if (met) {
      return { met: true, waitedMs: Date.now() - start, ref: target ? target.getAttribute('data-apex-ref') : undefined };
    }
    
    await new Promise(r => setTimeout(r, delayMs));
  }
  
  return { met: false, waitedMs: Date.now() - start };
}

async function actionClickFallback(params) {
  const target = resolveTarget(params);
  
  target.scrollIntoView({ block: 'center', behavior: 'instant' });
  await nextFrame();
  
  const rect = getElementRect(target);
  const center = getCenter(rect);
  
  const topEl = document.elementFromPoint(center.x, center.y);
  if (topEl && topEl !== target && !target.contains(topEl) && !params.force) {
    throw new ApexError('OCCLUDED', 'Element is occluded by another element.', 'Use force:true to click anyway.');
  }
  
  const style = window.getComputedStyle(target);
  if (target.disabled || target.inert || style.pointerEvents === 'none') {
    throw new ApexError('NOT_INTERACTABLE', 'Element is not interactable (disabled, inert, or pointer-events:none).');
  }
  
  const events = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
  if (params.button === 'right') events.push('contextmenu');
  if (params.clickCount === 2) events.push('dblclick');
  
  for (const ev of events) {
    target.dispatchEvent(new MouseEvent(ev, {
      bubbles: true, cancelable: true, view: window,
      clientX: center.x, clientY: center.y,
      button: params.button === 'right' ? 2 : 0,
      buttons: params.button === 'right' ? 2 : 1
    }));
  }
  
  return { dispatched: true, trusted: false, warning: 'Synthetic events dispatched. Native trust missing.' };
}

function actionTypeFallback(params) {
  const target = resolveTarget(params);
  const { text, clear, submit } = params;
  
  target.focus();
  
  if (clear) {
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
      target.value = '';
    } else if (target.isContentEditable) {
      target.textContent = '';
    }
  }
  
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set || 
                   Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) {
      setter.call(target, target.value + text);
    } else {
      target.value += text;
    }
  } else if (target.isContentEditable) {
    document.execCommand('insertText', false, text);
  }
  
  target.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, data: text }));
  target.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
  target.dispatchEvent(new Event('change', { bubbles: true }));
  
  if (submit) {
    const form = target.closest('form');
    if (form) {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    } else if (target.tagName === 'INPUT' && target.type === 'text') {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
    }
  }
  
  return { typed: true, trusted: false, warning: 'Synthetic typing executed.', value: target.value || target.textContent };
}

function actionHoverFallback(params) {
  const target = resolveTarget(params);
  const rect = getElementRect(target);
  const center = getCenter(rect);
  
  const events = ['pointerenter', 'pointerover', 'mouseenter', 'mouseover', 'mousemove'];
  for (const ev of events) {
    target.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, clientX: center.x, clientY: center.y }));
  }
  
  return { dispatched: true, trusted: false };
}

function actionA11yFallback(params) {
  // Simplified a11y tree since CDP isn't available
  const root = params.selector ? resolveTarget(params) : document.body;
  
  const buildA11y = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const val = node.nodeValue.trim();
      return val ? { role: 'text', name: val } : null;
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (!isElementVisible(node)) return null;
      
      const role = node.getAttribute('role') || node.tagName.toLowerCase();
      const name = getAccessibleName(node);
      const children = [];
      
      let child = node.firstChild;
      while (child) {
        const c = buildA11y(child);
        if (c) children.push(c);
        child = child.nextSibling;
      }
      
      if (!name && children.length === 0 && !['button', 'input', 'a'].includes(node.tagName.toLowerCase())) {
        // Skip uninteresting divs
        if (params.interestingOnly) return children.length === 1 ? children[0] : null;
      }
      
      return {
        role,
        name: name || undefined,
        children: children.length > 0 ? children : undefined
      };
    }
    return null;
  };
  
  return { tree: buildA11y(root) };
}

function actionFileInputInfo(params) {
  const target = resolveTarget(params);
  if (target.tagName !== 'INPUT' || target.type !== 'file') {
    throw new ApexError('BAD_PARAMS', 'Target is not a file input.');
  }
  
  return {
    multiple: target.multiple,
    accept: target.getAttribute('accept') || ''
  };
}

// --- 5. getUniqueSelector ---
function getUniqueSelector(el) {
  if (el.id) {
    const sel = '#' + CSS.escape(el.id);
    if (document.querySelectorAll(sel).length === 1) return sel;
  }
  
  if (el === document.body) return 'body';
  
  let path = [];
  let current = el;
  while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement) {
    let selector = current.localName;
    if (current.id) {
      selector += '#' + CSS.escape(current.id);
      path.unshift(selector);
      if (document.querySelectorAll(path.join(' > ')).length === 1) {
        return path.join(' > ');
      }
    } else {
      let sibling = current;
      let nth = 1;
      while (sibling = sibling.previousElementSibling) nth++;
      selector += `:nth-child(${nth})`;
      path.unshift(selector);
    }
    current = current.parentElement;
  }
  
  return path.join(' > ');
}
