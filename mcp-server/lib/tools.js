/**
 * ApexAgent tool catalogue — the single source of truth.
 *
 * The hub, the shim, the service worker and the docs all derive from this file. If a tool is not
 * here it does not exist; if its schema is not here it is not validated.
 *
 * Version 1 exposed 73 tools. That was too many for three reasons: it cost a large fixed slice of
 * every turn's context window, it pushed some clients past their advertised tool limits, and about
 * twenty of the 73 were stubs that returned `{success:true}` with no data, so the catalogue was
 * actively misleading. This file has 33 tools and loses no working capability — the reduction comes
 * from collapsing families that differed only in an argument (get_dom_tree / get_element_html →
 * `get_dom` with an `action`) and from deleting things that never worked. Several genuinely new
 * capabilities arrive at the same time: option selection, drag, file upload, dialog handling,
 * history navigation, and real console and network capture.
 *
 * Conventions every tool follows:
 *
 *  - Targeting an element: `ref` (preferred, from browser_snapshot), or `selector`, or `text`.
 *    Exactly one. `ref` is the only one that is unambiguous under re-render.
 *  - Targeting a tab: optional `tabId`. Omitted means the calling client's attached tab, then the
 *    active tab. Resolved once, by the hub, and stamped into the frame.
 *  - Failure is always a failure. See INTERNAL_PROTOCOL.md §7.1.
 *  - Annotations are honest: `readOnlyHint` is only true if the tool cannot change page state,
 *    and `destructiveHint` is true for anything a user would want to be asked about.
 */

/** Frozen error vocabulary. Mirrors docs/INTERNAL_PROTOCOL.md §7. */
export const ERROR_CODES = Object.freeze({
  NO_EXTENSION: { retryable: true, hint: 'Open Chrome and make sure the ApexAgent extension is enabled and paired. Run `apex-agent doctor` to check.' },
  NOT_PAIRED: { retryable: false, hint: 'Click the ApexAgent toolbar icon and approve the pairing request.' },
  EXTENSION_BUSY: { retryable: true, hint: 'Too many calls in flight. Retry shortly.' },
  NO_TAB: { retryable: false, hint: 'Call browser_tabs with action "list" to see open tabs, then "select" one.' },
  UNSUPPORTED_URL: { retryable: false, hint: 'Chrome blocks extensions on chrome://, chrome-extension:// and Web Store pages. Navigate to a normal page first.' },
  TAB_CRASHED: { retryable: true, hint: 'The tab crashed. Reload it with browser_history action "reload".' },
  NOT_ALLOWED: { retryable: false, hint: 'The user has this capability switched off in the ApexAgent popup.' },
  NOT_FOUND: { retryable: false, hint: 'Nothing matched. Call browser_snapshot to see what is actually on the page.' },
  AMBIGUOUS: { retryable: false, hint: 'Several elements matched. Use a ref from browser_snapshot, or a more specific selector.' },
  STALE_REF: { retryable: true, hint: 'This ref came from an older snapshot. Call browser_snapshot again and use a fresh ref.' },
  NODE_DETACHED: { retryable: true, hint: 'The page re-rendered and this element is gone. Call browser_snapshot again.' },
  OCCLUDED: { retryable: true, hint: 'Something is covering the target. Dismiss the overlay or cookie banner first, or scroll.' },
  NOT_INTERACTABLE: { retryable: false, hint: 'The element is disabled, hidden or zero-sized. Check the snapshot for a different target.' },
  TIMEOUT: { retryable: true, hint: 'The operation did not finish in time. Consider browser_wait_for before retrying.' },
  CANCELLED: { retryable: false, hint: 'The caller cancelled this operation.' },
  CDP_REQUIRED: { retryable: false, hint: 'This needs Chrome DevTools access. Enable "Trusted input and deep inspection" in the ApexAgent popup.' },
  CDP_DETACHED: { retryable: true, hint: 'The debugger detached, usually because DevTools was opened manually. Close DevTools and retry.' },
  BAD_PARAMS: { retryable: false, hint: 'Check the parameter named in the message against the tool schema.' },
  TOO_LARGE: { retryable: false, hint: 'The result is too big to return. Narrow it with a selector, a limit, or a filter.' },
  UNSUPPORTED_PROTOCOL: { retryable: false, hint: 'Version mismatch between the extension and the server. Update both.' },
  INTERNAL: { retryable: true, hint: 'Unexpected failure. `apex-agent doctor --logs` shows the hub log.' },
});

/**
 * Tool profiles. A client can load a subset via `--profile`, which keeps the per-turn context cost
 * down for people who only want, say, web automation. `core` is always included.
 */
export const PROFILES = Object.freeze({
  core: 'Navigation, snapshotting and interaction. The tools you need to use a page like a person.',
  inspect: 'Read-only inspection: DOM, styles, console, network, storage, accessibility.',
  diagnose: 'Performance tracing, coverage, heap and the raw CDP escape hatch.',
  extension: 'Developing and debugging Chrome extensions, including driving other installed extensions.',
});

/** Shorthand builders, so the schemas below stay readable. */
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const int = (description, extra = {}) => ({ type: 'integer', description, ...extra });
const bool = (description, extra = {}) => ({ type: 'boolean', description, ...extra });
const enom = (values, description) => ({ type: 'string', enum: values, description });

const TAB_ID = int('Tab to act on. Omit to use the tab this client has selected, or the active tab.');

/** The three ways to name an element. Spread into a tool's properties. */
const TARGET = {
  ref: str('Element handle from browser_snapshot, e.g. "e7-12". The most reliable option: it survives re-render better than a selector and is never ambiguous.'),
  selector: str('CSS selector. Use when you know the page structure. Must match exactly one element unless the tool says otherwise.'),
  text: str('Visible text to match, case-insensitive substring. Convenient but fragile; prefer ref.'),
};
const TARGET_RULE = 'Provide exactly one of ref, selector or text.';

/**
 * @typedef {object} ToolDef
 * @property {string}  name
 * @property {string}  title        Human label for UI surfaces.
 * @property {keyof PROFILES} profile
 * @property {string}  description  Read by the model. Says what it does, when to use it, and what it returns.
 * @property {object}  inputSchema  JSON Schema, draft 2020-12 subset.
 * @property {object}  annotations  MCP tool annotations.
 * @property {string}  render       Formatter in lib/format.js: text | image | snapshot | table | json.
 * @property {boolean} [needsCdp]   Requires chrome.debugger, therefore the user's CDP consent.
 * @property {boolean} [needsTab]   Requires a resolvable target tab.
 */

/** @type {ToolDef[]} */
export const TOOLS = [
  // ───────────────────────────────────────────────────────────────── core ─────

  {
    name: 'browser_tabs',
    title: 'Tabs',
    profile: 'core',
    description:
      'List, select, open, close or focus tabs. Start here when you do not know what is open. ' +
      '"select" binds a tab to this client so later calls can omit tabId — two editors can drive ' +
      'two different tabs at once without interfering. Returns tab id, title, url, and which tab ' +
      'is currently selected by this client.',
    inputSchema: {
      type: 'object',
      properties: {
        action: enom(['list', 'select', 'new', 'close', 'focus'], 'What to do. "focus" brings the tab to the foreground without changing your selection.'),
        tabId: int('Tab to select, close or focus. Required for those actions.'),
        url: str('URL for action "new".'),
        active: bool('For "new": open in the foreground. Default false, so background work does not steal the user\'s focus.', { default: false }),
        urlFilter: str('For "list": only return tabs whose url or title contains this substring.'),
      },
      required: ['action'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    render: 'table',
  },

  {
    name: 'browser_navigate',
    title: 'Navigate',
    profile: 'core',
    description:
      'Go to a URL in the target tab and wait for it to be ready. Returns the final url after ' +
      'redirects, the http status when available, the page title, and whether a snapshot ' +
      'generation was invalidated. Navigating always invalidates existing refs, so re-snapshot ' +
      'afterwards.',
    inputSchema: {
      type: 'object',
      properties: {
        url: str('Absolute URL. http, https and file are accepted; chrome:// is not.'),
        tabId: TAB_ID,
        waitUntil: enom(['commit', 'domcontentloaded', 'load', 'networkidle'], 'How long to wait. "load" is the default and is right for most pages; "networkidle" suits single-page apps that fetch after load; "commit" returns as soon as navigation starts.'),
        timeoutMs: int('Give up after this long. Default 30000.', { minimum: 1000, maximum: 300000, default: 30000 }),
      },
      required: ['url'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    render: 'text',
    needsTab: true,
  },

  {
    name: 'browser_history',
    title: 'Back / forward / reload',
    profile: 'core',
    description: 'Move through the target tab\'s session history, or reload it. Invalidates refs.',
    inputSchema: {
      type: 'object',
      properties: {
        action: enom(['back', 'forward', 'reload'], 'Direction, or reload.'),
        bypassCache: bool('For "reload": ignore the http cache, like shift-reload.', { default: false }),
        tabId: TAB_ID,
      },
      required: ['action'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    render: 'text',
    needsTab: true,
  },

  {
    name: 'browser_snapshot',
    title: 'Snapshot page',
    profile: 'core',
    description:
      'The primary way to see a page. Returns a compact accessibility-oriented tree of the ' +
      'interactive and text-bearing elements, each with a stable ref like "e7-12" that you pass to ' +
      'browser_click, browser_type and the rest. Far cheaper and more reliable than a screenshot ' +
      'for deciding what to do, because it gives you roles, names, values and states rather than ' +
      'pixels. Covers every frame on the page, including iframes and open shadow roots. Each call ' +
      'starts a new generation and invalidates refs from previous calls.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: TAB_ID,
        mode: enom(['interactive', 'full', 'text'], '"interactive" (default) returns only things you can act on plus their labels — the right choice almost always. "full" adds structural and static nodes. "text" returns the readable text content only.'),
        selector: str('Limit the snapshot to the subtree under this selector. Use to keep large pages manageable.'),
        maxElements: int('Truncate after this many nodes. Default 1500. The response says whether truncation happened.', { minimum: 1, maximum: 20000, default: 1500 }),
        includeInvisible: bool('Include elements that are off-screen or visually hidden. Default false.', { default: false }),
        frameId: int('Only snapshot this frame. Omit to include all frames.'),
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    render: 'snapshot',
    needsTab: true,
  },

  {
    name: 'browser_screenshot',
    title: 'Screenshot',
    profile: 'core',
    description:
      'Capture the page, the viewport or a single element as a PNG, returned as an image you can ' +
      'actually look at. Use it to check visual layout, or when a snapshot leaves you unsure what ' +
      'the user is seeing — not as your default way of reading a page, which browser_snapshot does ' +
      'better and far more cheaply. ApexAgent\'s own on-page overlay is hidden automatically so it ' +
      'never appears in the image.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: TAB_ID,
        ...TARGET,
        fullPage: bool('Capture the entire scrollable page rather than the viewport. Ignored when targeting an element.', { default: false }),
        format: enom(['png', 'jpeg'], 'jpeg with quality is much smaller for photographic pages. Default png.'),
        quality: int('jpeg quality 1-100. Ignored for png.', { minimum: 1, maximum: 100, default: 80 }),
        maxWidth: int('Downscale so the image is at most this wide, preserving aspect ratio. Keeps large captures inside token budgets. Default 1600.', { default: 1600 }),
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    render: 'image',
    needsTab: true,
  },

  {
    name: 'browser_click',
    title: 'Click',
    profile: 'core',
    description:
      'Click an element the way a person would: scroll it into view, confirm nothing is covering ' +
      'the point that will be hit, then dispatch a real trusted mouse sequence at its centre. ' +
      'Because the events are trusted, handlers that check isTrusted, native form submission, ' +
      'label-to-input association and focus behaviour all work. Fails loudly with OCCLUDED, ' +
      'NOT_INTERACTABLE or NOT_FOUND rather than reporting a success that did nothing. ' + TARGET_RULE,
    inputSchema: {
      type: 'object',
      properties: {
        ...TARGET,
        tabId: TAB_ID,
        button: enom(['left', 'right', 'middle'], 'Default left. "right" opens the real context menu.'),
        clickCount: int('2 for double-click, 3 for triple-click (selects a paragraph).', { minimum: 1, maximum: 3, default: 1 }),
        modifiers: { type: 'array', items: enom(['Alt', 'Control', 'Meta', 'Shift'], 'Modifier key.'), description: 'Held during the click. Control or Meta click typically opens a link in a new tab.' },
        position: {
          type: 'object',
          description: 'Click this offset inside the element instead of its centre. Useful for canvases, sliders and maps.',
          properties: { x: int('Pixels from the left edge.'), y: int('Pixels from the top edge.') },
          required: ['x', 'y'],
          additionalProperties: false,
        },
        force: bool('Skip the occlusion check. Use only when you know an overlay is decorative and pointer-transparent.', { default: false }),
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    render: 'text',
    needsTab: true,
  },

  {
    name: 'browser_type',
    title: 'Type text',
    profile: 'core',
    description:
      'Focus a field and type into it with real key events, so React, Vue, Angular and every ' +
      'other framework see the change through their normal input path and their state actually ' +
      'updates. Handles ordinary inputs, textareas and contenteditable. Set submit to press Enter ' +
      'at the end, which triggers genuine form submission. ' + TARGET_RULE,
    inputSchema: {
      type: 'object',
      properties: {
        ...TARGET,
        text: str('Text to type. Newlines become Enter presses.'),
        tabId: TAB_ID,
        clear: bool('Select all and delete before typing. Default true, because appending to an existing value is rarely what you want.', { default: true }),
        submit: bool('Press Enter after typing.', { default: false }),
        delayMs: int('Pause between keystrokes. 0 is fastest; 20-50 helps pages that debounce or autocomplete as you type.', { minimum: 0, maximum: 1000, default: 0 }),
      },
      required: ['text'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    render: 'text',
    needsTab: true,
  },

  {
    name: 'browser_press_key',
    title: 'Press key',
    profile: 'core',
    description:
      'Send a single trusted keystroke to the page or to a specific element. This is how you drive ' +
      'keyboard-only interfaces: Tab to move focus, Escape to dismiss a modal, ArrowDown to walk a ' +
      'combobox, Enter to activate. Use the DOM key names, e.g. "Enter", "Escape", "Tab", ' +
      '"ArrowDown", "Backspace", "a".',
    inputSchema: {
      type: 'object',
      properties: {
        key: str('DOM key name, e.g. "Enter" or "ArrowDown".'),
        modifiers: { type: 'array', items: enom(['Alt', 'Control', 'Meta', 'Shift'], 'Modifier key.'), description: 'Held during the press.' },
        repeat: int('Press this many times.', { minimum: 1, maximum: 100, default: 1 }),
        ...TARGET,
        tabId: TAB_ID,
      },
      required: ['key'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    render: 'text',
    needsTab: true,
  },

  {
    name: 'browser_hover',
    title: 'Hover',
    profile: 'core',
    description:
      'Move the real cursor over an element and leave it there. Reveals hover menus, tooltips and ' +
      ':hover styling that are invisible to a snapshot taken without hovering. ' + TARGET_RULE,
    inputSchema: {
      type: 'object',
      properties: { ...TARGET, tabId: TAB_ID },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    render: 'text',
    needsTab: true,
  },

  {
    name: 'browser_scroll',
    title: 'Scroll',
    profile: 'core',
    description:
      'Scroll the page, a scrollable container, or an element into view. Use "to" with a target to ' +
      'bring something on screen; use direction with amount to page through a feed. Returns the ' +
      'resulting scroll position and whether the end was reached, so you can tell an infinite ' +
      'list from a finished one.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: enom(['up', 'down', 'left', 'right', 'top', 'bottom'], 'Which way to scroll.'),
        amount: int('Pixels. Defaults to about one viewport.'),
        ...TARGET,
        container: str('CSS selector of the scrollable container. Omit to scroll the page.'),
        tabId: TAB_ID,
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    render: 'text',
    needsTab: true,
  },

  {
    name: 'browser_select_option',
    title: 'Select option',
    profile: 'core',
    description:
      'Choose one or more options in a native <select>. Native selects render as an OS-level popup ' +
      'that synthetic clicks cannot touch, which is why this needs its own tool. Match options by ' +
      'value, visible label or index. Returns the options that ended up selected.',
    inputSchema: {
      type: 'object',
      properties: {
        ...TARGET,
        values: { type: 'array', items: { type: 'string' }, description: 'Option values to select.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Visible option labels to select.' },
        indices: { type: 'array', items: { type: 'integer' }, description: 'Zero-based option indices to select.' },
        tabId: TAB_ID,
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    render: 'text',
    needsTab: true,
  },

  {
    name: 'browser_drag',
    title: 'Drag and drop',
    profile: 'core',
    description:
      'Press at one point, move in steps, release at another — a real drag, so HTML5 drag-and-drop, ' +
      'sortable lists, sliders, canvas drawing and map panning all behave as they would under a ' +
      'human hand. Endpoints can be elements or raw coordinates.',
    inputSchema: {
      type: 'object',
      properties: {
        from: {
          type: 'object',
          description: 'Start point. One of ref, selector, or x and y.',
          properties: { ref: str('Element handle.'), selector: str('CSS selector.'), x: int('Viewport x.'), y: int('Viewport y.') },
          additionalProperties: false,
        },
        to: {
          type: 'object',
          description: 'End point. One of ref, selector, or x and y.',
          properties: { ref: str('Element handle.'), selector: str('CSS selector.'), x: int('Viewport x.'), y: int('Viewport y.') },
          additionalProperties: false,
        },
        steps: int('Intermediate move events. More steps look more human and satisfy libraries that require movement to register. Default 12.', { minimum: 1, maximum: 100, default: 12 }),
        tabId: TAB_ID,
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    render: 'text',
    needsTab: true,
    needsCdp: true,
  },

  {
    name: 'browser_upload_file',
    title: 'Upload file',
    profile: 'core',
    description:
      'Attach local files to a file input. The OS file picker cannot be automated, so this sets the ' +
      'input\'s files directly through the browser and fires the change event, which is what pages ' +
      'listen for. Paths are resolved on the machine running the ApexAgent server.',
    inputSchema: {
      type: 'object',
      properties: {
        ...TARGET,
        paths: { type: 'array', items: { type: 'string' }, description: 'Absolute paths to attach.', minItems: 1 },
        tabId: TAB_ID,
      },
      required: ['paths'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    render: 'text',
    needsTab: true,
    needsCdp: true,
  },

  {
    name: 'browser_handle_dialog',
    title: 'Handle dialog',
    profile: 'core',
    description:
      'Accept or dismiss a native alert, confirm, prompt or beforeunload dialog. These block the ' +
      'page and every other tool will time out while one is open, so if calls suddenly start ' +
      'timing out, check here. Set a handler with action "auto" before triggering something that ' +
      'may prompt.',
    inputSchema: {
      type: 'object',
      properties: {
        action: enom(['accept', 'dismiss', 'auto', 'off', 'peek'], '"accept"/"dismiss" handle the dialog open right now. "auto" installs a standing handler. "off" removes it. "peek" reports what is open without touching it.'),
        promptText: str('Text to enter into a prompt() before accepting.'),
        autoAction: enom(['accept', 'dismiss'], 'What the standing handler should do. Default dismiss, which is the safer choice.'),
        tabId: TAB_ID,
      },
      required: ['action'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    render: 'text',
    needsTab: true,
    needsCdp: true,
  },

  {
    name: 'browser_wait_for',
    title: 'Wait for',
    profile: 'core',
    description:
      'Block until a condition holds: an element appears or disappears, text shows up, the network ' +
      'goes quiet, or a plain delay elapses. Use this instead of retrying in a loop — it is faster, ' +
      'it does not burn turns, and it returns as soon as the condition is met.',
    inputSchema: {
      type: 'object',
      properties: {
        state: enom(['visible', 'hidden', 'attached', 'detached', 'networkidle', 'delay'], 'Condition to wait for.'),
        selector: str('Element to watch. Required except for networkidle and delay.'),
        text: str('Wait for this text to appear anywhere in the page.'),
        timeoutMs: int('Give up after this long and fail with TIMEOUT. Default 10000.', { minimum: 100, maximum: 300000, default: 10000 }),
        delayMs: int('For state "delay": how long to wait.', { minimum: 0, maximum: 60000 }),
        tabId: TAB_ID,
      },
      required: ['state'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    render: 'text',
    needsTab: true,
  },

  {
    name: 'browser_evaluate',
    title: 'Run JavaScript',
    profile: 'core',
    description:
      'Run JavaScript in the page and get the result back. The escape hatch for anything the other ' +
      'tools do not cover. Your code runs in the page\'s own world by default, so it sees the ' +
      'page\'s variables, framework instances and globals. Pass a ref or selector to receive that ' +
      'element as the first argument. Async code and returned promises are awaited. Results are ' +
      'serialised structurally, so DOM nodes come back as descriptions rather than throwing.',
    inputSchema: {
      type: 'object',
      properties: {
        script: str('A JavaScript expression, or a function body, or a function like "(el) => el.textContent". Awaited if it returns a promise.'),
        ...TARGET,
        world: enom(['main', 'isolated'], '"main" (default) shares the page\'s globals. "isolated" is sandboxed from page script — safer against a hostile page, but cannot see its variables.'),
        tabId: TAB_ID,
        timeoutMs: int('Default 10000.', { minimum: 100, maximum: 120000, default: 10000 }),
      },
      required: ['script'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    render: 'json',
    needsTab: true,
  },

  // ────────────────────────────────────────────────────────────── inspect ─────

  {
    name: 'inspect_element',
    title: 'Inspect element',
    profile: 'inspect',
    description:
      'Everything about one element in a single call: box model, computed styles that actually ' +
      'differ from the defaults, attributes, accessible role and name, event listeners, stacking ' +
      'context, and why it might not be clickable. The first thing to reach for when an ' +
      'interaction fails or a layout looks wrong. ' + TARGET_RULE,
    inputSchema: {
      type: 'object',
      properties: {
        ...TARGET,
        tabId: TAB_ID,
        include: {
          type: 'array',
          items: enom(['box', 'styles', 'attributes', 'accessibility', 'listeners', 'interactability'], 'Section to include.'),
          description: 'Sections to return. Omit for all of them.',
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    render: 'json',
    needsTab: true,
  },

  {
    name: 'browser_query',
    title: 'Find elements',
    profile: 'inspect',
    description:
      'Find elements by CSS selector or visible text and get back a compact list with refs, so you ' +
      'can act on them immediately. Use when you know roughly what you are looking for and do not ' +
      'need a whole snapshot. Searches inside open shadow roots and all frames.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: str('CSS selector.'),
        text: str('Visible text, case-insensitive substring.'),
        role: str('ARIA role to filter by, e.g. "button".'),
        limit: int('Maximum results. Default 50.', { minimum: 1, maximum: 1000, default: 50 }),
        attributes: { type: 'array', items: { type: 'string' }, description: 'Also return these attribute values for each match.' },
        tabId: TAB_ID,
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    render: 'table',
    needsTab: true,
  },

  {
    name: 'get_dom',
    title: 'Get DOM',
    profile: 'inspect',
    description:
      'Read the raw DOM as a structural tree or as HTML. Prefer browser_snapshot for deciding what ' +
      'to do — this is for when you need the literal markup, for instance to check what a ' +
      'framework rendered. Always scope it with a selector on a real page; whole-document HTML is ' +
      'usually far larger than it is useful.',
    inputSchema: {
      type: 'object',
      properties: {
        action: enom(['tree', 'html'], '"tree" is a compact nested structure. "html" is literal markup.'),
        selector: str('Root to read from. Defaults to documentElement, which is often too much.'),
        depth: int('For "tree": how deep to descend. Default 6.', { minimum: 1, maximum: 50, default: 6 }),
        outer: bool('For "html": include the root element\'s own tag. Default true.', { default: true }),
        maxBytes: int('Truncate beyond this. Default 200000.', { default: 200000 }),
        tabId: TAB_ID,
      },
      required: ['action'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    render: 'text',
    needsTab: true,
  },

  {
    name: 'get_styles',
    title: 'Get styles',
    profile: 'inspect',
    description:
      'Computed styles for an element, with the cascade behind them: which rule won, what it ' +
      'overrode, and which stylesheet it came from. By default only properties that differ from ' +
      'the browser default are returned, because the full computed set is several hundred ' +
      'properties of noise.',
    inputSchema: {
      type: 'object',
      properties: {
        ...TARGET,
        properties: { type: 'array', items: { type: 'string' }, description: 'Only these properties. Returns them even if they hold default values.' },
        includeDefaults: bool('Return all computed properties, including defaults. Verbose.', { default: false }),
        includeCascade: bool('Include matched rules in priority order and which declarations lost. Default true.', { default: true }),
        tabId: TAB_ID,
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    render: 'json',
    needsTab: true,
  },

  {
    name: 'get_console',
    title: 'Console messages',
    profile: 'inspect',
    description:
      'Console output and uncaught errors from the page, captured at the browser level so it ' +
      'includes messages logged before you attached, messages from every frame, and messages from ' +
      'page scripts rather than only from the extension\'s own sandbox. Each entry carries level, ' +
      'text, source location, stack and timestamp. The place to look first when something on the ' +
      'page is broken.',
    inputSchema: {
      type: 'object',
      properties: {
        level: { type: 'array', items: enom(['log', 'info', 'warn', 'error', 'debug'], 'Level.'), description: 'Only these levels. Omit for all.' },
        contains: str('Only messages containing this substring.'),
        sinceMs: int('Only messages from the last N milliseconds.'),
        limit: int('Most recent N. Default 100.', { minimum: 1, maximum: 2000, default: 100 }),
        clear: bool('Clear the buffer after reading, so the next call only shows what is new. Handy in a fix-and-retest loop.', { default: false }),
        tabId: TAB_ID,
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    render: 'table',
    needsTab: true,
    needsCdp: true,
  },

  {
    name: 'get_network',
    title: 'Network requests',
    profile: 'inspect',
    description:
      'Real network activity: method, url, status, type, timing, sizes, and optionally request and ' +
      'response bodies. Captured from the browser\'s network stack, so unlike a Resource Timing ' +
      'read it knows status codes, failures and headers. Use it to confirm an API call fired, see ' +
      'what came back, or find the request behind a broken page.',
    inputSchema: {
      type: 'object',
      properties: {
        urlContains: str('Only requests whose url contains this.'),
        method: str('Only this HTTP method.'),
        status: str('Status filter: an exact code like "404", a class like "4xx", or "failed".'),
        resourceType: { type: 'array', items: enom(['document', 'stylesheet', 'image', 'font', 'script', 'xhr', 'fetch', 'websocket', 'other'], 'Resource type.'), description: 'Only these types. ["xhr","fetch"] is the usual choice when debugging an API.' },
        includeBodies: bool('Include request and response bodies, truncated. Off by default because bodies are large and often contain credentials.', { default: false }),
        includeHeaders: bool('Include request and response headers.', { default: false }),
        limit: int('Most recent N. Default 50.', { minimum: 1, maximum: 1000, default: 50 }),
        clear: bool('Clear the buffer after reading.', { default: false }),
        tabId: TAB_ID,
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    render: 'table',
    needsTab: true,
    needsCdp: true,
  },

  {
    name: 'get_storage',
    title: 'Storage and cookies',
    profile: 'inspect',
    description:
      'Read localStorage, sessionStorage, cookies and IndexedDB database names for the target tab\'s ' +
      'origin. Values are returned verbatim, so treat the output as sensitive — it commonly ' +
      'contains session tokens.',
    inputSchema: {
      type: 'object',
      properties: {
        type: enom(['local', 'session', 'cookies', 'indexeddb', 'all'], 'Which store. Default all.'),
        keyContains: str('Only keys containing this substring.'),
        redactValues: bool('Return value lengths and types instead of contents. Use when you only need to know a key exists.', { default: false }),
        tabId: TAB_ID,
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    render: 'json',
    needsTab: true,
  },

  {
    name: 'get_page_info',
    title: 'Page info',
    profile: 'inspect',
    description:
      'A quick situational read on the target tab: url, title, readiness, viewport and device pixel ' +
      'ratio, scroll position and extent, document counts, meta tags, and core load and paint ' +
      'timings. Cheap. Good first call to confirm you are where you think you are.',
    inputSchema: {
      type: 'object',
      properties: {
        include: { type: 'array', items: enom(['basic', 'viewport', 'meta', 'performance', 'counts'], 'Section.'), description: 'Sections to return. Omit for all.' },
        tabId: TAB_ID,
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    render: 'json',
    needsTab: true,
  },

  {
    name: 'get_accessibility_tree',
    title: 'Accessibility tree',
    profile: 'inspect',
    description:
      'The browser\'s own computed accessibility tree, as a screen reader would see it. Use it to ' +
      'audit accessibility — missing names, wrong roles, orphaned labels, focus order — rather ' +
      'than to drive interaction, which browser_snapshot does better.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: str('Limit to this subtree.'),
        interestingOnly: bool('Skip nodes with no semantic contribution. Default true.', { default: true }),
        tabId: TAB_ID,
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    render: 'text',
    needsTab: true,
    needsCdp: true,
  },

  // ───────────────────────────────────────────────────────────── diagnose ─────

  {
    name: 'perf_trace',
    title: 'Performance trace',
    profile: 'diagnose',
    description:
      'Record a CPU profile, JS and CSS coverage, or a heap snapshot, then get back a summary plus ' +
      'a path to the full artefact on disk. Start it, exercise the page, stop it. Full traces are ' +
      'far too large to return inline, so the summary names the hot functions or unused bytes and ' +
      'the file holds the rest for loading into DevTools.',
    inputSchema: {
      type: 'object',
      properties: {
        action: enom(['start', 'stop', 'status'], 'Lifecycle. "status" reports what is recording.'),
        kind: enom(['cpu', 'coverage', 'heap'], '"cpu" for slow scripting, "coverage" for unused code, "heap" for leaks. Required for "start"; "heap" is a one-shot and needs no stop.'),
        tabId: TAB_ID,
      },
      required: ['action'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    render: 'json',
    needsTab: true,
    needsCdp: true,
  },

  {
    name: 'cdp_command',
    title: 'Raw CDP command',
    profile: 'diagnose',
    description:
      'Send a raw Chrome DevTools Protocol command to the target tab. The lowest-level escape ' +
      'hatch: anything Chrome can do, whether or not ApexAgent wraps it. Powerful and entirely ' +
      'unguarded — you can crash the tab or change browser state — so reach for a purpose-built ' +
      'tool first and use this when none exists.',
    inputSchema: {
      type: 'object',
      properties: {
        method: str('CDP method, e.g. "Emulation.setDeviceMetricsOverride".'),
        params: { type: 'object', description: 'Method parameters.', additionalProperties: true },
        tabId: TAB_ID,
      },
      required: ['method'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    render: 'json',
    needsTab: true,
    needsCdp: true,
  },

  // ──────────────────────────────────────────────────────────── extension ─────

  {
    name: 'ext_list',
    title: 'List extensions',
    profile: 'extension',
    description:
      'Every extension and app installed in this Chrome: id, name, version, enabled state, install ' +
      'type, permissions, and for unpacked ones the path on disk. Start here for anything ' +
      'extension-related — you need the id for the other ext_ tools, and the disk path is what ' +
      'makes ext_files work.',
    inputSchema: {
      type: 'object',
      properties: {
        includeDisabled: bool('Include disabled extensions. Default true.', { default: true }),
        onlyUnpacked: bool('Only unpacked extensions, i.e. the ones you are developing. Default false.', { default: false }),
        nameContains: str('Filter by name substring.'),
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    render: 'table',
  },

  {
    name: 'ext_control',
    title: 'Control extension',
    profile: 'extension',
    description:
      'Reload, enable or disable an installed extension, or read its full details. "reload" on an ' +
      'unpacked extension picks up your latest source from disk and is the core of the ' +
      'edit-reload-test loop. Pass "self" as the id to act on ApexAgent itself — note that ' +
      'reloading or disabling ApexAgent drops this connection.',
    inputSchema: {
      type: 'object',
      properties: {
        action: enom(['reload', 'enable', 'disable', 'info'], 'What to do.'),
        extensionId: str('Extension id, or "self" for ApexAgent.'),
        confirm: bool('Required to be true for enable or disable of an extension other than the one under development, since it changes the user\'s browser.', { default: false }),
      },
      required: ['action', 'extensionId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    render: 'text',
  },

  {
    name: 'ext_files',
    title: 'Extension source files',
    profile: 'extension',
    description:
      'List, read and search the source of an unpacked extension, straight from disk. Works on any ' +
      'unpacked extension, not just ApexAgent, and returns real file contents with line numbers ' +
      'so you can reason about the code you are debugging. Reads happen on the machine running the ' +
      'ApexAgent server, which is why this succeeds where fetching a chrome-extension:// URL ' +
      'cannot: one extension may not read another\'s files, but Node can read the directory.',
    inputSchema: {
      type: 'object',
      properties: {
        action: enom(['list', 'read', 'search'], '"list" walks the tree, "read" returns one file, "search" greps.'),
        extensionId: str('Extension id from ext_list, or "self".'),
        path: str('Path relative to the extension root. Required for "read"; optional subtree for "list" and "search".'),
        query: str('For "search": a regular expression.'),
        ignoreCase: bool('For "search": case-insensitive. Default true.', { default: true }),
        maxResults: int('For "search": stop after this many matches. Default 100.', { minimum: 1, maximum: 1000, default: 100 }),
        contextLines: int('For "search": lines of context around each match. Default 2.', { minimum: 0, maximum: 20, default: 2 }),
        startLine: int('For "read": first line, 1-based.'),
        endLine: int('For "read": last line, inclusive.'),
      },
      required: ['action', 'extensionId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    render: 'text',
  },

  {
    name: 'ext_debug',
    title: 'Debug extension',
    profile: 'extension',
    description:
      'Inspect a running extension: its manifest as Chrome parsed it, the errors Chrome recorded ' +
      'for it, its service worker state and console, and the contents of its chrome.storage. The ' +
      'counterpart to ext_files — that shows you the code, this shows you what the code is doing.',
    inputSchema: {
      type: 'object',
      properties: {
        action: enom(['manifest', 'errors', 'console', 'storage', 'worker', 'clear_errors'], 'What to inspect. "worker" reports whether the service worker is running and can wake it.'),
        extensionId: str('Extension id, or "self".'),
        storageArea: enom(['local', 'session', 'sync', 'managed'], 'For "storage". Default local.'),
        limit: int('For "errors" and "console": most recent N. Default 50.', { minimum: 1, maximum: 500, default: 50 }),
      },
      required: ['action', 'extensionId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    render: 'json',
  },

  {
    name: 'ext_open',
    title: 'Open extension page',
    profile: 'extension',
    description:
      'Open one of an extension\'s own pages in a tab — its popup, options page, error page or any ' +
      'path inside it — and return the tab id. Once it is open it is an ordinary tab, so every ' +
      'browser_ tool works on it: this is how you snapshot, click through and debug an extension\'s ' +
      'own UI, including a third-party extension whose features you want to drive.',
    inputSchema: {
      type: 'object',
      properties: {
        extensionId: str('Extension id, or "self".'),
        page: enom(['popup', 'options', 'errors', 'custom'], 'Which page. "custom" uses path.'),
        path: str('For "custom": path inside the extension, e.g. "panel/index.html".'),
        active: bool('Open in the foreground. Default true, because extension UIs often need focus to initialise.', { default: true }),
      },
      required: ['extensionId', 'page'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    render: 'text',
  },

  {
    name: 'ext_watch',
    title: 'Watch and auto-reload',
    profile: 'extension',
    description:
      'Watch an unpacked extension\'s directory and reload it automatically when a file changes, ' +
      'optionally reloading matching tabs too. Turns the manual edit-switch-reload-retest cycle ' +
      'into a hot loop. Watching happens in the ApexAgent server process, so it survives the ' +
      'extension being reloaded. Report changes and reloads with action "status".',
    inputSchema: {
      type: 'object',
      properties: {
        action: enom(['start', 'stop', 'status'], 'Lifecycle.'),
        extensionId: str('Extension id, or "self". Required for start and stop.'),
        reloadTabs: str('Also reload tabs whose url matches this substring after each extension reload.'),
        debounceMs: int('Coalesce bursts of file events. Default 300.', { minimum: 50, maximum: 5000, default: 300 }),
      },
      required: ['action'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    render: 'json',
  },
];

// ─────────────────────────────────────────────────────────────── helpers ─────

/** @type {Map<string, ToolDef>} */
const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export function getTool(name) {
  return BY_NAME.get(name) ?? null;
}

/** Tools for the given profiles. `core` is always included. */
export function toolsForProfiles(profiles) {
  if (!profiles || profiles.length === 0) return TOOLS.slice();
  const want = new Set(['core', ...profiles]);
  return TOOLS.filter((t) => want.has(t.profile));
}

/** The MCP `tools/list` shape. Nothing internal (render, needsCdp, profile) leaks out. */
export function toMcpTool(tool) {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: { title: tool.title, ...tool.annotations },
  };
}

/**
 * Validate params against a tool's schema.
 *
 * A deliberately small validator: types, enums, required, ranges, array item types, and
 * additionalProperties. It exists so a bad call fails with BAD_PARAMS naming the field, at the edge,
 * instead of becoming a confusing failure three hops away inside the page. It is not a general
 * JSON Schema implementation and does not try to be.
 *
 * @returns {{ok: true, value: object} | {ok: false, field: string, message: string}}
 */
export function validateParams(tool, rawParams) {
  const schema = tool.inputSchema;
  const params = rawParams ?? {};

  if (typeof params !== 'object' || Array.isArray(params) || params === null) {
    return { ok: false, field: '(root)', message: 'Parameters must be an object.' };
  }

  for (const name of schema.required ?? []) {
    if (params[name] === undefined || params[name] === null) {
      return { ok: false, field: name, message: `Required parameter "${name}" is missing.` };
    }
  }

  if (schema.additionalProperties === false) {
    const allowed = new Set(Object.keys(schema.properties ?? {}));
    for (const key of Object.keys(params)) {
      if (!allowed.has(key)) {
        const known = [...allowed].join(', ');
        return { ok: false, field: key, message: `Unknown parameter "${key}". Accepted parameters are: ${known}.` };
      }
    }
  }

  const out = {};
  for (const [name, spec] of Object.entries(schema.properties ?? {})) {
    const given = params[name];
    if (given === undefined || given === null) {
      if (spec.default !== undefined) out[name] = spec.default;
      continue;
    }
    const problem = checkValue(name, given, spec);
    if (problem) return { ok: false, field: name, message: problem };
    out[name] = given;
  }

  return { ok: true, value: out };
}

function checkValue(path, value, spec) {
  if (spec.enum) {
    if (!spec.enum.includes(value)) {
      return `"${path}" must be one of: ${spec.enum.join(', ')}. Received ${JSON.stringify(value)}.`;
    }
    return null;
  }

  switch (spec.type) {
    case 'string':
      if (typeof value !== 'string') return `"${path}" must be a string, received ${typeOf(value)}.`;
      return null;

    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        return `"${path}" must be an integer, received ${typeOf(value)}.`;
      }
      if (spec.minimum !== undefined && value < spec.minimum) return `"${path}" must be at least ${spec.minimum}.`;
      if (spec.maximum !== undefined && value > spec.maximum) return `"${path}" must be at most ${spec.maximum}.`;
      return null;

    case 'number':
      if (typeof value !== 'number' || Number.isNaN(value)) return `"${path}" must be a number, received ${typeOf(value)}.`;
      if (spec.minimum !== undefined && value < spec.minimum) return `"${path}" must be at least ${spec.minimum}.`;
      if (spec.maximum !== undefined && value > spec.maximum) return `"${path}" must be at most ${spec.maximum}.`;
      return null;

    case 'boolean':
      if (typeof value !== 'boolean') return `"${path}" must be true or false, received ${typeOf(value)}.`;
      return null;

    case 'array': {
      if (!Array.isArray(value)) return `"${path}" must be an array, received ${typeOf(value)}.`;
      if (spec.minItems !== undefined && value.length < spec.minItems) {
        return `"${path}" must have at least ${spec.minItems} item${spec.minItems === 1 ? '' : 's'}.`;
      }
      if (spec.items) {
        for (let i = 0; i < value.length; i++) {
          const problem = checkValue(`${path}[${i}]`, value[i], spec.items);
          if (problem) return problem;
        }
      }
      return null;
    }

    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value) || value === null) {
        return `"${path}" must be an object, received ${typeOf(value)}.`;
      }
      for (const name of spec.required ?? []) {
        if (value[name] === undefined) return `"${path}.${name}" is required.`;
      }
      if (spec.additionalProperties === false && spec.properties) {
        const allowed = new Set(Object.keys(spec.properties));
        for (const key of Object.keys(value)) {
          if (!allowed.has(key)) return `Unknown parameter "${path}.${key}". Accepted: ${[...allowed].join(', ')}.`;
        }
      }
      for (const [name, sub] of Object.entries(spec.properties ?? {})) {
        if (value[name] === undefined) continue;
        const problem = checkValue(`${path}.${name}`, value[name], sub);
        if (problem) return problem;
      }
      return null;
    }

    default:
      return null;
  }
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

/**
 * Exactly-one-of check for the ref/selector/text family, shared by every tool that targets an
 * element so the message is identical everywhere.
 * @returns {{ok:true} | {ok:false, field:string, message:string}}
 */
export function validateTarget(params, { allowNone = false } = {}) {
  const given = ['ref', 'selector', 'text'].filter((k) => params[k] !== undefined && params[k] !== '');
  if (given.length === 1) return { ok: true };
  if (given.length === 0) {
    if (allowNone) return { ok: true };
    return { ok: false, field: 'ref', message: 'Specify the element with exactly one of ref, selector or text. Call browser_snapshot to get refs.' };
  }
  return { ok: false, field: given[1], message: `Specify only one of ref, selector or text; received ${given.join(' and ')}.` };
}

export const TOOL_COUNT = TOOLS.length;
