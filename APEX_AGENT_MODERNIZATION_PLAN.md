# Apex Agent — Deep Dive & Modernization Plan

**Audited version:** extension `1.9.1` / mcp-server `1.0.0`
**Audit date:** 2026-08-30
**Scope:** full read of `mcp-server/index.js` (403 lines), `extension/background.js` (2831 lines), `extension/content/content.js` (1666 lines), `extension/popup/*`, `extension/sidebar/*`, `extension/getting-started.*`, manifest, and all docs.

**Decisions this plan is written against:** target clients are Cursor, Claude Code, and Codex CLI; the goal is a Chrome Web Store listing; priorities are reliability/compatibility first, then new automation capability.

---

## 1. Verdict

The architecture is sound and the ambition is right. A local WebSocket bridge between an MCP stdio server and an MV3 extension is exactly how you get an agent into a *real, logged-in* browser session, and the extension-developer tooling (reload, error capture, popup interaction) is a genuine differentiator that Playwright MCP and Chrome DevTools MCP structurally cannot match, because they drive a throwaway automation profile rather than your actual Chrome.

What has decayed is not the idea. It is that the project grew to 73 advertised tools without a correctness harness, so roughly a quarter of the surface now returns `{success: true}` while doing nothing, the element-reference system the whole snapshot workflow depends on was never actually implemented, and the transport can only ever serve one AI client at a time. Those three facts together explain most of the "it used to work fine" feeling: the parts you exercised by hand still work, and everything else quietly rotted.

The single most important framing: **this codebase does not fail loudly.** Errors are converted to empty successes in at least a dozen places (`result?.field || []`), so the agent driving it cannot distinguish "nothing happened" from "nothing went wrong." For a human that is a nuisance. For an LLM it is fatal — it will confidently build on a false premise and you will blame the model.

There is also a hard strategic conflict you need to resolve early: **as built, this extension cannot pass Chrome Web Store review.** See section 7. That is not a small patch; it changes the shape of the product, so it belongs at the front of the plan rather than the end.

---

## 2. What I could not verify in this session

Web search and web fetch were unavailable, and the Linux VM failed to start, so I could not check current documentation or run anything. Everything below is from reading your source directly, which is solid ground, plus my own knowledge with a mid-2025 cutoff — which is over a year stale for a fast-moving spec.

Treat every item in this table as **verify before you code**, consistent with your standing rule about checking third-party APIs against real installed sources rather than guessing.

| Claim to verify | Why it matters | Where to check |
|---|---|---|
| Current MCP protocol revision(s) and which your clients accept | You currently echo the client's `protocolVersion` back verbatim (`index.js:151`), which is wrong under any revision | `modelcontextprotocol.io/specification` |
| Whether Codex CLI supports Streamable HTTP MCP, or stdio only | Decides whether the multi-client fix can be "one HTTP endpoint" or needs stdio shims | Codex docs / `~/.codex/config.toml` schema |
| Exact config file + format per client (Cursor JSON, Claude Code `.mcp.json`, Codex TOML) | Your installer command and docs depend on it; Codex uses TOML, not JSON | Each vendor's MCP docs |
| Practical tool-count limits per client | Drives how aggressively you must consolidate 73 tools | Client docs / release notes |
| Current CWS policy text on `debugger`, `management`, and remote code | Section 7 is my read of policy as of 2025; the wording moves | Chrome Web Store program policies |
| Whether `chrome.debugger` still blocks when DevTools is open on the same tab | Affects the CDP-first recommendation | Chrome extension docs |
| Live model IDs for the sidebar's four providers | Every one of the 14 hardcoded IDs is stale or invalid | Each provider's model list |

---

## 3. How it actually works today

The extension is the WebSocket **client**; the MCP server is the WebSocket **server** on `127.0.0.1:3052`. An AI editor spawns `node mcp-server/index.js`, which speaks line-delimited JSON-RPC on stdio and simultaneously listens on the WS port. The extension's service worker auto-connects a second after startup (`background.js:68-81`), sends `{type:'register'}`, and then serially processes `{type:'tool_call'}` frames off a queue, replying `{type:'tool_result'}`.

Tool execution splits two ways. DOM-level work is forwarded to the content script via `forwardAgentAction` (`background.js:910-945`) with a hard 10-second timeout. Everything else runs in the service worker directly, using `chrome.scripting`, `chrome.management`, `chrome.tabs`, or `chrome.debugger`.

That split is the origin of most of the incoherence, and it is worth naming as its own problem — see root cause R4.

---

## 4. Five root causes

Rather than hand you 60 disconnected bugs, here is the diagnosis. Each root cause maps to a phase in section 8.

### R1 — The MCP protocol layer is hand-rolled and non-compliant

`mcp-server/index.js` implements JSON-RPC by hand in about 70 lines. It works with Cursor because Cursor is lenient. It will misbehave with stricter clients.

The concrete defects: it echoes the client's `protocolVersion` back instead of negotiating to a version it actually supports (`:151`); it replies to *unknown notifications* with an error response carrying `id: undefined` (`:206`), which is an illegal JSON-RPC frame and exactly the kind of thing a strict client rejects the whole session over; it never handles the spec's `ping` request, `notifications/cancelled`, or progress; tool failures come back as ordinary text results without `isError`, so the client cannot tell a failure from a successful answer that happens to start with the word "Error"; and `readline` is constructed with `output: process.stdout` (`:109`), which puts a writer on the exact stream the protocol lives on.

Two more that directly waste your money and context. Screenshots are returned as `JSON.stringify` of a base64 data URL (`:181`) rather than an MCP image content block, so the model receives tens of thousands of tokens of unreadable base64 instead of a picture it can actually see. And the fallback formatter's `catch` block runs the identical `JSON.stringify` call that just threw (`:183-186`), so it cannot ever help; when the result is `undefined` — which happens whenever a content-script handler returns without responding — it emits `{type:'text', text: undefined}`, an invalid payload.

Fix direction: **stop hand-rolling it.** Rebuild on the official `@modelcontextprotocol/sdk`. You get version negotiation, notification handling, cancellation, progress, correct error objects, and both stdio and Streamable HTTP transports for free, and you stop owning a class of bug that has no upside.

### R2 — Only one AI client can ever work at a time

This is the direct answer to "make it work with Cursor, Claude Code, and Codex." Right now it cannot work with two of them simultaneously, and the failure is silent.

`startWsServer` (`:211`) probes port 3052. If the port is free, this process becomes the WS server and owns the extension. If the port is busy, it calls `connectAsClient()` (`:296`) and sets `chromeClient` to a socket pointing at *the other Node process*. It then sends `tool_call` frames down that socket — and the first process's connection handler only understands `register`, `ping`, and `tool_result` (`:242-263`). `tool_call` is parsed and dropped on the floor. The second client waits out its full 30-second timeout on every single call, with no error explaining why.

So: whichever editor you launch first works. Every other editor appears connected and hangs forever. There is no relay, no request multiplexing, and no per-client request namespace.

Compounding it, there is no notion of *which tab* a client is working on. Every tool resolves the target by `chrome.tabs.query({active: true, currentWindow: true})` — and does it **twice per call**, once in `executeToolCall` (`:363`) and again inside `forwardAgentAction` (`:912`), so if you switch tabs mid-call the two halves of one tool hit two different tabs. `navigateTab(url, tabId)` and `executeScript(tabId, …)` already accept a target, but no tool schema exposes `tabId` and the callers drop it (`:374`). The agent physically cannot act on an unfocused tab.

Fix direction: a **single long-lived local hub** that owns the extension connection and multiplexes many MCP clients, each with its own request-ID space and its own attached-tab binding. Thin stdio shims per editor, plus a Streamable HTTP endpoint for clients that support it.

### R3 — Silent success: ~20 of 73 tools are stubs or reliably broken

Every one of the 73 advertised tools has a `case` in the dispatch switch, so nothing 404s. The rot is entirely in handlers that return success while producing nothing. That is worse than a missing tool, because the agent believes it.

**Hard stubs — architecturally incapable of returning data:**

| Tool | Location | Why it can never work |
|---|---|---|
| `take_heap_snapshot` | `background.js:2500` | `chunks` array is declared, never filled, never returned. `HeapProfiler.addHeapSnapshotChunk` isn't in the event sink. A code comment admits it. |
| `get_layer_tree` | `:2667` | `LayerTree.getLayers` is not a CDP method. The rejection is swallowed by `?.layers \|\| []`. |
| `get_animations` | `:2678` | Enables the domain then immediately reads the buffer. Events can only arrive after enable, and there is no monitor-start tool. Always `[]`. |
| `get_cdp_console_logs` | `:2615` | Same enable-then-read-immediately shape. Always `[]` on first call. |
| `watch_extension` | `:1804` | Advertised as continuous monitoring. Calls a capture function *once* which then detaches and closes the tab. `watchedExtensions` is declared and never referenced. |
| `extension_health_check` | `:1751` | Performs no check. Reports counts already in memory; unmonitored extensions come back `errorCount: 0, health: 'unknown'` — reads as healthy. |
| `get_network_requests` | `:2472` | No attach check, no domain enable, no error if the monitor was never started. |

**The extension source-reading family is broken by design.** `read_extension_file` (`:2058`), `list_extension_files` (`:2114`), and `search_extension_code` (`:2172`) all try to `fetch('chrome-extension://<other-id>/…')`. That is blocked unless the *target* extension lists the path in its own `web_accessible_resources` — which no extension does for its source. `list_extension_files` isn't even a listing; it probes a hardcoded 27-filename guess list, so it returns empty for essentially every real extension, and `search_extension_code` therefore searches zero files and always reports `matchCount: 0`. `get_extension_manifest` (`:1840`) fails the same way for anything but its own ID. `fix_extension_error` (`:2222`), advertised as AI-assisted, is a nine-entry static regex table that reads no source and proposes no diff.

This one has a clean fix that is worth calling out early: **read the files in Node, not in the browser.** `chrome.management.getAll()` already gives you the unpacked extension's directory path, and the MCP server has full filesystem access. Move file reading, listing, and searching to the server side and this entire family goes from permanently broken to genuinely good — and it becomes the backbone of the extension-development workflow you actually want.

**Handlers that error or mis-execute in practice:**

| Tool | Location | Defect |
|---|---|---|
| `get_accessibility_tree` | `:2640` | The `selector` branch computes a `nodeId` and never uses it, so the selector is silently ignored. Also passes `max_depth`, a stale pre-1.3 param name; unknown params make CDP reject, and the rejection is swallowed to `{tree: []}`. |
| `start_css_coverage` | `:2571` | Enables `CSS` without `DOM.enable` first, so it fails with "DOM agent is not enabled" — swallowed into `{success: true}`. |
| `inject_debug_helper` | `:1967` | Schema requires only `extensionId`, but the handler hard-fails without `tabId` and ignores `extensionId` entirely. |
| `browser_execute_safe` | `:541` | Uses `world:'ISOLATED'` + `new Function()`. The isolated world inherits the *extension's* MV3 CSP, which bans `unsafe-eval`, so the "CSP-safe" tool is the one guaranteed to throw. |
| `browser_evaluate` | `:419` | Uses `world:'MAIN'` + `eval()`, governed by the *page's* CSP — so it throws on any CSP-hardened site, the opposite of the "bypass CSP" comment above it. |
| `capture_extension_errors` | `:1352`, `:1357` | Hardcodes `/popup.html`, ignoring the manifest's real `action.default_popup`, so it misses the very common `popup/popup.html` layout. The `background` page path targets `_generated_background_page.html`, an MV2-only artifact that exists for no MV3 extension. |
| `trigger_extension_action` | `:1219` | `chrome.action.openPopup()` can only open *this* extension's popup; `extensionId` is never used. It is a duplicate of `open_extension_popup`. |
| `get_extension_storage` | `:1696` | Interpolates `storageArea` unescaped into a CDP `Runtime.evaluate` string — arbitrary JS in a privileged extension context. No cleanup in `finally`. |
| `get_page_info` | `:452` | Sent via `forwardAgentAction`, which wraps it as an `AGENT_ACTION`. The content script's `handleAgentAction` has no such case, and the handler that would serve it sits on the outer switch, unreachable. Always errors. |

Four tools — `browser_hover`, `browser_wait`, `get_page_info`, `get_element_info` — are fully implemented in both halves but absent from the `TOOLS` array, so no client can call them.

The cross-cutting fix is a policy, not a patch: **every tool must return real data or an explicit error, never an empty success.** Then add a contract test that fails CI when a tool returns a bare `{success: true}` with no payload. That single test would have caught all seven hard stubs.

### R4 — The "two brains" problem

Nearly every capability is implemented twice, once in the content script with synthetic DOM events and once in the service worker over CDP, and the tool surface exposes an inconsistent mixture of both.

The results are incoherent in ways that are hard to debug. `get_console_logs` runs the content script's `console` patch — which lives in the **isolated world** and therefore captures only the content script's own logs, never the page's, so it returns near-empty on every real site (`content.js:953-970`). Meanwhile `get_cdp_console_logs` would capture the real thing but needs a monitor that no tool starts. `browser_snapshot` builds its own heuristic element list from twelve CSS selectors while `get_accessibility_tree` returns an unrelated CDP tree — two answers to the same question, neither cross-referenced. `browser_evaluate` routes around the content script's `EVALUATE` handler entirely, leaving three dead `eval`/`new Function` call sites shipped in a content script (`content.js:902, 1420, 1443`) that are simultaneously unreachable, CSP-blocked where they matter, and a store-review liability.

**Recommendation: make CDP the primary execution engine and demote the content script to overlay, recording, and accessible-name computation.** CDP gives you trusted input events via `Input.dispatchMouseEvent` and `Input.insertText`, real page console capture via `Runtime.consoleAPICalled`, real network data with status codes and headers via the `Network` domain, cross-origin iframe access, and no CSP problems — and it is what both Playwright MCP and Chrome DevTools MCP do, because it is the approach that works.

The honest tradeoff: `chrome.debugger` shows the yellow "started debugging this browser" infobar, which cannot be suppressed, and it conflicts with having DevTools open on the same tab (**verify** whether that's still true). So the design should attach per-session with a clear UI affordance, and keep a synthetic fallback mode for users who won't accept the banner. Right now the banner problem is worse than that anyway: `takeScreenshot({fullPage: true})` attaches and never detaches (`background.js:824-862`), so one screenshot leaves the infobar on your tab permanently.

### R5 — There is no trust boundary

This is the one that blocks a store listing and, more importantly, is a real risk to you personally today.

**The WebSocket has no authentication in either direction.** The extension connects to `ws://localhost:3052` and processes `tool_call` frames unconditionally; the `registered` reply is merely logged and is not required before dispatch (`background.js:289-292`). The server sets no `verifyClient` and no `Origin` check. Two consequences follow. Any local process that wins the port race can drive your browser — arbitrary JS in every page, cookies, localStorage, screenshots, keystroke injection, debugger attach, and enable/disable of any installed extension. And because WebSocket is exempt from CORS, **any website you visit can open `ws://127.0.0.1:3052`**, and since `chromeClient` is reassigned to the newest connection, a hostile page can hijack the channel away from Cursor and start receiving the tool results meant for it.

**`externally_connectable` is wider still.** The manifest declares `{ids: ["*"], matches: ["http://localhost:*/*", "ws://localhost:*/*"]}` and `onConnectExternal` (`:2778`) forwards straight into `handleMessage` without inspecting `port.sender` at all. So any other installed extension, and any page on any localhost port — the default for every dev server you run — can post `{type:'SIDEBAR_TOOL_CALL', tool:'browser_evaluate', …}` and drive the whole tool surface. It can also send `SET_AGENT_ENABLED` to grant itself permissions first. Separately, `ws://` is not a legal scheme in a match pattern and will draw a manifest warning.

**The permission UI is largely decorative.** Of the eight flags the popup ships, only `navigation`, `screenshot`, and `scripts` are ever read, at three sites. `mouse`, `keyboard`, `showCursor`, `highlightTarget`, and `showTooltips` are stored, transmitted, defaulted — and never consulted, so unchecking "Mouse Control" or "Keyboard Input" changes nothing. The three enforcement guards are also written `if (!agentPermissions.navigation && agentEnabled)`, which *skips* the permission check when the master switch is off. And the master switch itself is bypassable: `noAgentRequired` (`:340-347`) exempts `cdp_command`, so with the agent "disabled" a peer can still issue `Runtime.evaluate` for arbitrary code, or `disable_extension` on your security extensions.

Worst of all, **permission state does not survive a service-worker teardown.** `agentEnabled` and `agentPermissions` live only in module scope and default to `true` / all-true, and the startup hydration only reads `mcpPort`, `mcpHost`, and `autoReconnect`. So every time Chrome recycles the worker, a user's opt-out silently reverts to fully permissive — while the popup faithfully reports "enabled," because both sides are wrong in the same direction.

**Finally, a stored XSS in the sidebar that can steal API keys.** `addMessageToUI` assigns model output straight to `innerHTML` with no escaping (`sidebar.js:320`), and `formatMessage` only does markdown-ish regex substitution. The same sink renders *tool results* (`:333`), so untrusted page content — a snapshot, a console dump, an inspected element — flows from an attacker-controlled page into the side panel's privileged origin. A page containing `<img src=x onerror=…>` in text the model echoes back gets script execution with full `chrome.*` access, enough to read `aiApiKey` from `chrome.storage.local` and POST it anywhere. Because chat history is persisted (`:369`) and re-rendered on load, the payload survives restarts. The popup does this correctly via `escapeHtml`; the sidebar does not.

---

## 5. Agent-reliability findings (the part that decides whether it feels good)

These are separate from correctness bugs. They are the reasons an agent flails even when tools "work."

### The element `ref` system does not exist

This is the most consequential single finding in the audit. `getPageSnapshot` (`content.js:848`) emits `ref: 'e' + index`. That value is **never stored anywhere** — no `Map`, no `WeakMap`, no `data-*` attribute — and nothing in the codebase ever reads `action.ref` to resolve it back to an element. Meanwhile the MCP layer formats snapshots for the model as `[e3] <button> Submit` (`index.js:178`), actively teaching the model to use refs, and the background accepts them via `selector: params.selector || params.ref` (`:379`) and passes them to `document.querySelector('e3')` — a valid type selector matching a nonexistent `<e3>` element, so it returns null and you get "Element not found: e3."

The agent can never click any ref, from any snapshot, ever. The indices aren't even contiguous, because invisible and zero-area elements `return` early inside the same `forEach` that generates them. The advertised snapshot-then-act workflow is broken end to end, and the model's only working handle is a CSS selector — which brings us to:

### `getUniqueSelector` returns selectors that are not unique

It walks up at most five levels and breaks (`content.js:1574`) without ever anchoring at `document.body` or an ID, so on any real page it emits an unanchored relative chain like `div.card:nth-child(2) > span:nth-child(1)`. Passed to `querySelector`, that matches the *first* such chain anywhere in the document — frequently a different element. The click then reports `success: true`. Silent wrong-element clicks are the worst failure mode an automation tool can have.

It also short-circuits on `#id` without verifying uniqueness, takes the first two class names (content-hashed and unstable under CSS Modules, Emotion, or styled-components), lowercases tag names — which breaks every camelCase SVG element like `clipPath` and `foreignObject` — produces unresolvable paths for anything inside a shadow root, and throws a `TypeError` on `Text` nodes because there is no `nodeType` guard.

That last one is not theoretical. The mutation observer calls it on `characterData` targets, so **on any page with a clock, a live counter, or a typing user, recording throws continuously** — including on the extension's own tooltip, whose text node passes right through the `isAgentUIElement` filter.

### Typing does not work in React

`typeText` (`content.js:647`) does `element.value += char` and dispatches `input`. React 16+ installs an instance-level value tracker; assigning `.value` directly updates that tracker as a side effect, so React's own listener sees no delta and **skips `onChange` entirely**. The DOM shows your text, React's state stays empty, and the form submits nothing. The required native-setter workaround — `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v)` — appears nowhere in the file. Vue and Angular happen to work because they use plain listeners.

`contenteditable` is worse than broken. The guard `element.textContent !== undefined` is *always* true for elements, so contenteditable falls into the `textContent +=` branch, which **replaces the entire child node tree with a single text node on every keystroke** — destroying formatting, nested nodes, mentions, and embeds. Against Slate, ProseMirror, Lexical, Quill, or TipTap that is data loss, not typing. There is also no `beforeinput`, no composition events, and no `change`/`blur` at the end, so anything validating on blur never commits.

### Clicks lie

`click` (`content.js:602`) samples `getBoundingClientRect` once and dispatches `mousedown`/`mouseup`/`click`. There is no `scrollIntoView`, so for a below-the-fold element the coordinates are outside the viewport and libraries that validate them reject the event. There is no `elementFromPoint` hit-test anywhere in the file, so clicking an element buried under a cookie banner or modal backdrop dispatches directly on the target — the page's real handler at that coordinate never runs — and the function returns `{success: true, element, position}`. There is no check for `disabled`, `aria-disabled`, `readOnly`, `inert`, or `pointer-events: none`.

No Pointer Events are dispatched at all, which means MUI ripples, Radix menus, dnd-kit drag handles, and every canvas app never see the interaction. No `mousemove`/`mouseover` precedes the click, so hover-gated dropdowns never open and their contents are never reachable. `button: 2` never produces a `contextmenu` event, so right-click is a no-op. Native `<select>` cannot be operated at all — there is no `SELECT_OPTION` action and dispatching `click` does not open a native dropdown.

Because every event is synthetic and `isTrusted === false`, everything gated on user activation silently fails: `window.open`, clipboard, fullscreen, file pickers, WebAuthn. Enter does not submit a form. Tab does not move focus. This is the strongest argument for the CDP-first recommendation in R4 — `Input.dispatchMouseEvent` produces genuinely trusted events and all of this simply works.

### Structural blind spots

**iframes are invisible.** The manifest omits `all_frames`, which defaults to false, so the content script runs only in the top frame. Stripe checkout, reCAPTCHA, embedded OAuth — all unreachable, with no error explaining why. The agent gets "Element not found" and loops.

**Shadow DOM is invisible.** `document.querySelectorAll` does not traverse shadow roots and there is no recursion anywhere in the file. Any Web Component UI — Salesforce Lightning, Ionic, Vaadin, most design systems, YouTube's own chrome — enumerates as empty.

**Canvas has no path at all.** Not in the selector list, and there is no coordinate-click action, so Figma-style apps, maps, charts, and Flutter Web are entirely inaccessible.

**Virtualised lists are structurally wrong.** `nth-child` indices refer to positions within the current render window, so after any scroll the same selector resolves to a different row. Compounding it, `scroll` uses `behavior: 'smooth'` and returns before the scroll completes, so an immediately following snapshot captures the pre-scroll window.

### Capture is empty or misleading

Console capture returns nothing from the page, as covered in R4. Network capture reads `performance.getEntriesByType('resource')`, which means **no status codes, no headers, no bodies, no method, no failure reason** — unusable for the primary debugging use case. Worse, the Resource Timing buffer saturates at the browser default of 250 entries and stops recording, and `setResourceTimingBufferSize` is never called, so on a heavy page `.slice(-30)` returns entries 220–250 — the *oldest* requests from page load — while the agent believes it is seeing the most recent 30. That is actively misleading rather than merely absent.

`getComputedStyles` filters out any value equal to `none`, `normal`, `auto`, `0px`, or transparent (`:1135`). So an element with `display: none` simply has no `display` key, indistinguishable from "not queried" — making "why is this invisible" impossible to answer with the tool built to answer it.

### The overlay contaminates its own observations

Three `<div>`s are appended to `document.body` on every page at init, whether or not the agent is connected. They are excluded from `getDOMTree` but **not** from `queryAll`, `getElementHTML`, `findByText`, or `clickByText` — so `query_all('div')` returns the extension's own UI, and the XPath text search can match the tooltip, meaning **the agent can end up clicking its own tooltip**. `wait({text})` checks `document.body.textContent`, and `showActionTooltip` puts the text you just typed into the DOM, so "wait for the text I typed" self-satisfies immediately.

Screenshots include the overlay, because nothing hides it before capture and the highlight lingers 800ms and the tooltip 1200ms *after* the action's promise resolves. Any screenshot taken right after a click reliably contains a blue box and a black tooltip, contaminating exactly the vision-based reasoning it was meant to enable. The tooltip and recording indicator also lack `pointer-events: none` at `z-index: 2147483647`, so they swallow real user clicks in the corners of every page you visit.

There is no teardown path. If an SPA replaces `document.body.innerHTML` — routine — the nodes detach, the module references keep them alive, and all visual feedback silently stops working forever while `highlightElement` keeps writing styles to detached nodes with no error.

### Result size is ungoverned

Nothing in the pipeline enforces a byte budget. `getElementHTML('body')` has no cap and returns the entire document; it even computes `length` and doesn't use it. `getAttributes` has no value-length cap, so one inline `data-json` or base64 `src` floods the response. `getPageSnapshot` has no element cap — a search page yields thousands of entries, all transferred, of which the MCP layer prints the first 30 with **no indication of the total**, so the agent reasons on a silently truncated view as if it were complete. `stop_cpu_profile`, both coverage tools, and raw `cdp_command` passthrough are unbounded by construction. And `browser_screenshot({fullPage: true})` clips at 16384×16384 as a base64 data URL — hundreds of megabytes, which exceeds `ws`'s default 100MiB `maxPayload`, so the frame is rejected, the socket closes with code 1009, the result is lost, and a reconnect storm begins.

Downstream, the fallback formatter uses `JSON.stringify(result, null, 2)` — two-space indentation on everything, roughly doubling token cost for no benefit.

### MV3 durability

Every stateful start/stop pair in the product is unreliable by design, because all of it lives in module-scope variables that vanish when Chrome recycles the worker: `networkRequests`, `consoleLogs`, `animations`, `extensionErrorStore` (all captured errors for all extensions), `extensionStateSnapshots` (the `compare_extension_state` baseline), `debuggerAttached` (so CDP bookkeeping desyncs from reality), and `messageQueue` — meaning **in-flight tool calls are dropped with no result ever sent**, and the MCP server burns its full 30-second timeout. Nothing touches `chrome.storage`.

The keepalive is also confused. A 10-second WS ping is the real mechanism and is correct for Chrome 116+. But `chrome.alarms.create` is called with `periodInMinutes: 0.25`, which is below Chrome's 30-second floor and gets silently clamped to exactly the idle-timeout window — a race rather than a safeguard. That alarm path also ignores `MAX_RECONNECT_ATTEMPTS`, so the ten-attempt cap is meaningless.

Reconnection is worse than absent. `mcpWebSocket` is overwritten without closing the previous socket, and three independent paths call `startMCPServer`, so the keepalive can create a new socket while the old one's `onclose` schedules another — sockets accumulate, `register` is sent repeatedly, and one `tool_call` can be processed by two live sockets. The connect-timeout check reads the *module* variable rather than the socket its promise was created for, so after re-entry it kills the newest healthy socket.

---

## 6. Onboarding, docs, and repo hygiene

The onboarding path is broken at its first step. `getting-started.html` — the page the `?` button actually opens — tells the user to download the release zip, extract it, and configure `node .../index.js`. It never mentions `npm install`. Since `index.js` imports `ws` as an external dependency, `node index.js` dies with `ERR_MODULE_NOT_FOUND` before the MCP handshake even begins. The README does document `npm install`; the guide your users are pointed at does not. This alone probably accounts for a meaningful share of "it doesn't connect."

The port setting is also broken end to end. The popup writes `env: {PORT: port}` into the config it generates, but the static snippet displayed in the popup and all three snippets in the getting-started guide omit `env` entirely — so a user who changes the port gets a server on 3052 and an extension dialling elsewhere, with no diagnostic. Four of the six config snippets across the docs also omit the `"mcpServers"` wrapper, making them unusable as pasted.

Version numbers have drifted everywhere: the manifest says 1.9.1, the popup says 1.7.0 in two places, the README badge says 1.8.0, and `mcp-server/package.json` has never left 1.0.0 while still carrying the pre-rename name `chrome-debug-hand-mcp`. Git tags are missing for 1.4.0, 1.5.0, and 1.8.0 despite release notes existing for 1.8.0, and there are no release notes at all for the shipped 1.9.x.

Documentation accuracy matters more than usual here because it feeds the store listing. The README's security section claims "No data is sent to external servers" twenty lines after advertising a sidebar that POSTs to four LLM providers. The README's permission list omits `management`, `debugger`, and `sidePanel` — the three most invasive ones. `PRIVACY.md` covers those but omits `alarms`, and **neither document mentions `externally_connectable` or `web_accessible_resources`**, which are the two riskiest surfaces in the extension. Submitting that privacy policy to a store review is asking for a rejection on disclosure grounds alone. The README also documents about 29 tools out of 73, with every CDP, coverage, profiling, and extension-error tool undocumented.

On hygiene: there are no tests, no CI, no `.github` directory at all, no linter or formatter config, no build step, and no root `package.json`. For a project whose entire job is a 73-tool RPC bridge, nothing is covered — which is precisely why a quarter of the surface could rot without anyone noticing. The release zip that the guide tells users to download is assembled by hand and is not reproducible.

One correction to a common assumption: **`node_modules` is *not* committed.** `.gitignore` handles it correctly and the git index contains zero matches. The real `.gitignore` problem is the opposite — `package-lock.json` is ignored, which for a Node server that end users execute directly forfeits reproducible installs and supply-chain pinning. That file should be committed.

The sidebar deserves its own note, because it is the weakest component and the one most likely to cause you problems. There is **no agent loop**: `sendMessage` calls the model once, executes any tools it requested, and stops. Tool results are rendered for display and never appended to history, so the model never sees them and multi-step tasks silently do one step — despite the system prompt promising "you can use multiple tools in sequence." No provider gets native tool calling; the tool list is stringified into the prompt with **prose parameter descriptions instead of JSON Schema**, and calls are recovered with a regex over fenced code blocks, so any prose containing that fence gets executed. There are five independent hand-maintained tool inventories across the codebase, already drifted: the sidebar exposes 12 of 73, its own system prompt recommends a tool absent from its own list, and the popup displays eight names that match no real tool. Every one of the 14 hardcoded model IDs is superseded, deprecated, or outright invalid — `gemini-pro` is retired and 404s, and the OpenRouter Claude slug carries an Anthropic-native date suffix that OpenRouter rejects. Switching provider in the popup doesn't update the model, so the next send posts `gpt-4o` to `api.anthropic.com`.

The extension UI also has blocking accessibility problems worth fixing before a store listing: `display: none` on every checkbox and the master toggle removes them from the tab order and the accessibility tree entirely, so all thirteen settings **and the Agent Control kill switch** are mouse-only and invisible to screen readers. Collapsible section headers are `<div>`s with click handlers and no `role`, `tabindex`, or `aria-expanded`, so five settings sections cannot be opened by keyboard. Every stylesheet sets `:focus { outline: none }` with no `:focus-visible` replacement. `html { font-size: 13px }` overrides the user's browser font preference and, because everything is sized in `rem`, enlarging default text does nothing — while `--text-muted: #666` on near-black at 8.5px fails WCAG AA contrast by a wide margin.

---

## 7. The Chrome Web Store reality check

You said you want to publish. I need to be direct: **as built, this extension will not pass review**, and the reasons are structural rather than cosmetic. This is the decision that has to be made before any of the engineering work, because it changes what you build.

Please verify the current policy wording — my reading is as of mid-2025 and the text moves — but the shape of the problem is stable.

| Blocker | What triggers it | Severity |
|---|---|---|
| **Remote code execution** | The extension receives arbitrary JavaScript strings over a WebSocket and executes them via `eval()` and `new Function()` in page and extension contexts. MV3 prohibits executing code not contained in the package. That localhost is the source does not change the analysis — reviewers see script text arriving at runtime from outside the bundle. | Hard rejection |
| **`management` permission used to enable/disable other extensions** | An extension that can silently disable your ad blocker or password manager is treated as high-risk regardless of intent. | Hard rejection or indefinite review |
| **`debugger` permission** | Permitted for some categories but heavily scrutinised, and it must be justified as necessary for the single stated purpose. Combined with the above it reads as a browser-takeover toolkit. | High scrutiny, weeks of review |
| **`externally_connectable: {ids: ["*"]}`** | Allows any installed extension to drive your tool surface. Reviewers flag wildcard external connectivity. | Rejection |
| **`<all_urls>` host permissions plus a content script on every page at `document_start`** | Requires a narrowest-permission justification you currently cannot make, since most tools work on the active tab only. | In-depth review |
| **Single purpose policy** | The package currently contains an MCP bridge, an interaction recorder, a BYO-key multi-provider AI chat sidebar, and an extension-developer debugging suite. That is defensibly four products. | Rejection |
| **Disclosure gaps** | The privacy policy omits `externally_connectable`, `web_accessible_resources`, and `alarms`; the README asserts no external data transmission while the sidebar POSTs to four providers. | Rejection |

There is also a plain security argument independent of policy. Shipping a no-auth localhost WebSocket listener to strangers hands a browser-takeover primitive to any local process and, because WebSocket is CORS-exempt, to any website they visit. You should not publish that to end users under any circumstances, and fixing it is required whether or not you go to the store.

**Recommended resolution: split into two builds from one source tree.**

*Track A — `apex-agent-dev`, self-distributed.* Keeps the full power: `debugger`, `management`, arbitrary evaluation, extension source reading, hot reload. Distributed as an unpacked folder or a GitHub release for developer-mode loading, which is what you do today and is the correct channel for a tool this privileged. Note that self-hosting a `.crx` with an `update_url` is not a real option for normal users on Windows or macOS, since Chrome only permits store-hosted installs outside developer mode and enterprise policy. For your own machines and a team, `ExtensionInstallForcelist` via policy is a clean path.

*Track B — `apex-agent`, Chrome Web Store.* A deliberate diet: drop `management` entirely, move `debugger` and broad host access to `optional_permissions` requested on demand with a clear rationale, remove all string-evaluation tools in favour of a fixed catalogue of parameterised operations, drop the AI sidebar (which resolves the single-purpose objection, removes the API-key storage liability, and eliminates the stored XSS surface in one move), and state the single purpose as browser automation and inspection for a locally-running AI assistant.

My honest recommendation on the sidebar specifically: **cut it.** It is the least differentiated part of the product, it is the source of your worst security finding, its model list is entirely stale, its agent loop doesn't loop, and it is the most likely single-purpose objection. Anyone using this via Cursor, Claude Code, or Codex already has a better chat interface than you can maintain. If you want to keep it, ship it as a separate optional extension rather than in the same package.

If you would rather not maintain two builds, the alternative is to accept that Track A is the product and skip the store. That is a legitimate choice — Chrome DevTools MCP and Playwright MCP are both distributed outside the store — and it would save you a substantial amount of work.

---

## 8. Phased plan

Phases are ordered by dependency, not by appeal. Phase 0 items are things you should do this week regardless of everything else.

### Phase 0 — Stop the bleeding, then build a net

Four security fixes are live risks on your own machine right now and are small enough to do immediately, before any refactor. Add a shared-secret handshake to the WebSocket: generate a token on extension install, surface it in the popup, have the MCP server read it from an env var or a config file in the user profile, and refuse all `tool_call` frames until the handshake completes in both directions. Add `verifyClient` plus an `Origin` check on the server so web pages cannot connect. Replace `externally_connectable: {ids: ["*"]}` with an explicit allowlist or remove the key entirely, and validate `port.sender` in `onConnectExternal` before forwarding anything. Persist `agentEnabled` and `agentPermissions` and rehydrate them on worker start, so a teardown stops silently re-granting permissions. And escape model output and tool results in the sidebar — reuse the popup's existing `escapeHtml`, or render markdown through a sanitising library — because that path can currently exfiltrate your API keys from a hostile page.

Then build the correctness harness, because without it the rest of this plan will silently rot the same way. Three pieces. A **contract test** that asserts every entry in `TOOLS` has a dispatch handler, that every tool has a schema with parameter descriptions, and that no tool returns a bare `{success: true}` with an empty payload — that last assertion alone catches all seven hard stubs. An **end-to-end integration test** that launches real Chrome with the unpacked extension, starts the MCP server, and exercises every tool against a local fixture page containing a React controlled input, a shadow-DOM component, an iframe, a canvas, an overlay that occludes a button, and an SVG link — the six things that currently break silently. And **CI** on GitHub Actions running ESLint, manifest validation, and both test suites.

Finish the phase with hygiene that prevents the drift you already have: a single source of truth for the version with a sync script, a real `CHANGELOG.md` replacing the three ad-hoc release-notes files, a committed `package-lock.json`, `engines: {node: ">=20"}`, and deletion of the unused `@anthropic-ai/sdk` dependency.

### Phase 1 — Protocol and transport: make three clients work at once

Rebuild `mcp-server/index.js` on the official `@modelcontextprotocol/sdk` rather than hand-rolled JSON-RPC. This is the highest leverage change in the plan and it deletes an entire category of bug.

Then restructure the transport into a **hub and shims**. One long-lived local daemon owns the WebSocket endpoint the extension connects to, holds the request registry, and multiplexes many MCP clients — each with its own request-ID namespace so replies cannot cross. Each editor runs a thin stdio shim that speaks MCP on stdio and relays to the hub, auto-spawning the hub as a detached singleton via a lockfile if it isn't running. Expose a Streamable HTTP endpoint alongside it for clients that support it, so users can skip the shim entirely (verify Codex's transport support before you rely on this).

With multiplexing in place, add **explicit tab targeting**. Give every relevant tool an optional `tabId`, add `list_tabs` / `select_tab` / `new_tab`, and give each connected MCP client its own attached-tab binding so Cursor and Claude Code can work on different tabs without fighting. Resolve the target exactly once per call and thread it through, fixing the current double-query race.

Fix result handling while you are in here. Return screenshots as MCP **image content blocks** rather than base64 in JSON — this is a large immediate win in both usability and token cost. Set `isError` on failures. Handle `ping` and `notifications/cancelled`, and never emit a response to a notification. Implement a **size governor**: a hard per-result character budget with an explicit truncation notice that states the true total, cursor-based pagination for list results, and a spill-to-disk escape hatch for genuinely large artefacts — heap snapshots, coverage reports, full-page screenshots — where you write the file and return its path so the agent can open it with its own file tools. Drop the two-space `JSON.stringify` indentation. Replace the flat 30-second timeout with per-tool timeouts that exceed each tool's own internal wait, so `browser_wait_for_element` with a 20-second timeout stops being killed by its own transport at 10.

Package the server properly: publish to npm with a `bin` entry so configuration becomes `npx -y apex-agent-mcp@latest` and the missing-`npm install` onboarding break disappears permanently. Add two subcommands that will save you enormous support pain — `apex-agent install --client cursor|claude-code|codex`, which writes the correct config file in the correct format and location for each, and `apex-agent doctor`, which checks whether the hub is running, whether the extension is connected, whether the token matches, whether the port is in conflict, and prints the exact fix for each failure.

### Phase 2 — Truthfulness: no more empty successes

Go through the seven hard stubs and either implement them properly or **delete them from `TOOLS`**. Deleting is usually the better answer — a tool that does not exist is infinitely more useful to an agent than one that lies. For the CDP capture tools, the underlying pattern error is enable-then-read-immediately; fix it with explicit monitor start/stop pairs, event sinks that actually subscribe to the right CDP events, and storage-backed ring buffers that survive a worker teardown.

Move the extension source-reading family — `read_extension_file`, `list_extension_files`, `search_extension_code`, `get_extension_manifest` — **out of the browser and into Node**. `chrome.management.getAll()` gives you the unpacked directory path, the MCP server has filesystem access, and `fetch('chrome-extension://…')` was never going to work. This converts four permanently broken tools into the foundation of your differentiating feature, and it is one of the cheapest high-value changes available.

Fix the `get_page_info` envelope mismatch, and either expose or delete the four orphaned tools that have handlers but no schema.

Then **consolidate the tool surface**. Seventy-three tools is too many: schemas are re-sent on every turn so they are a permanent context tax, and several clients degrade sharply past a few dozen tools (verify current limits). Target roughly twenty-five to thirty. The twenty extension-debugging tools collapse to about four with an `action` parameter. The profiling and coverage tools collapse into one `perf_trace(kind)`. Put the extension-developer surface behind a profile flag — `--profile=extension-dev` versus `--profile=web` — so users who only want browser automation don't pay for tools they never call. Add tool `title`s and annotations (`readOnlyHint`, `destructiveHint`, `openWorldHint`) so clients can present and gate them sensibly, and add `outputSchema` with structured content where the shape is stable.

### Phase 3 — Agent reliability

This is what converts "it technically works" into "it feels good," and it is where the new-capability priority you chose gets spent.

Start with the **ref system**, because everything else depends on it. On snapshot, stamp each element with a `data-apex-ref` attribute and hold a generation-stamped `Map<string, WeakRef<Element>>`; resolve refs in `click`, `type`, `hover`, and `press_key`; and return an explicit staleness error when a ref belongs to an older generation or its element has detached, rather than falling through to a selector guess. Make ref numbering contiguous over the elements you actually emit.

Replace the snapshot itself with an **accessibility-tree-based view**: role, properly computed accessible name (honouring `aria-labelledby`, `label[for]`, `alt`, `title`, and `placeholder`, none of which are consulted today), and interaction state — `disabled`, `checked`, `selected`, `expanded`, `readonly`. Add the missing roles, particularly `menuitem`, `option`, `switch`, `combobox`, `textbox`, `slider`, `contenteditable`, and `summary`/`details`. Deduplicate nested matches. Include a cap with an honest total count.

Rewrite `getUniqueSelector` to anchor at an ID or `document.body`, verify uniqueness by re-querying before returning, use `CSS.escape`, preserve SVG tag-name casing, and guard `nodeType` so it stops throwing on `Text` nodes and crashing the mutation observer.

Then switch interaction to **CDP-first**. Use `Input.dispatchMouseEvent` and `Input.insertText` for trusted events when the debugger is attached, keeping the synthetic path as an explicit fallback mode. This single change fixes form submission on Enter, focus movement on Tab, right-click, native `<select>`, clipboard, file pickers, and every user-activation-gated API at once. For the synthetic fallback, add the React native-setter dispatch, a full pointer-event sequence, a hover pre-sequence, `beforeinput`/`change`/`blur`, and `execCommand('insertText')` or `beforeinput` with Range manipulation for contenteditable instead of the current textContent replacement that destroys editor state.

Add a **click preflight** that scrolls into view, waits for rect stability, hit-tests with `elementFromPoint`, and refuses with a descriptive error when the target is occluded, disabled, `inert`, or `pointer-events: none`. Silent false-positive clicks should become impossible.

Close the structural blind spots. Set `all_frames: true` and add frame routing with a `frameId` so iframes stop being invisible. Add recursive traversal through open shadow roots. Add a coordinate-based click and drag for canvas apps. Make `scroll` await completion instead of returning mid-animation.

Fix capture properly. Move console capture to the MAIN world or CDP `Runtime.consoleAPICalled` so it records the *page's* logs, and add `window.onerror` and `unhandledrejection`. Replace the Resource Timing sampling with the CDP `Network` domain so you get status codes, headers, methods, failure reasons, and optional size-capped bodies — and call `setResourceTimingBufferSize` if you keep any fallback, since the current path silently returns the oldest 30 entries while claiming to return the newest. Stop filtering `none` and `auto` out of computed styles.

Finally, decontaminate the overlay: move it into a closed shadow root on a single dedicated host, exclude it from every query path rather than just `getDOMTree`, add `pointer-events: none` to the tooltip and indicator, hide it before any screenshot and await a frame, add a teardown and re-creation path for SPA body replacement, and cancel overlapping timers. Fix the `SVGAnimatedString` structured-clone failure that currently makes `browser_snapshot` fail outright on any page with an inline SVG link, and cap the mutation buffer with a max-age flush so it stops retaining detached DOM indefinitely.

### Phase 4 — MV3 durability and real permission enforcement

Persist everything that currently dies with the worker to `chrome.storage.session` and rehydrate on start: the error stores, state snapshots, CDP bookkeeping, capture buffers, and the message queue. When the worker wakes with orphaned in-flight requests, send explicit failure frames instead of letting the client burn its timeout.

Make reconnection single-flight: close the previous socket before replacing it, capture the socket in the closure rather than reading the module variable, use exponential backoff with jitter, and apply one attempt cap consistently across all three entry paths. Drop `periodInMinutes: 0.25` to a legal value and stop relying on it as a keepalive.

Reference-count CDP attachments and detach in `finally` everywhere — particularly the full-page screenshot path that currently leaves the debugging infobar on your tab forever. Surface attachment state in the popup so the banner is never a mystery.

Then make the permission model real. Either enforce all eight flags or delete the five that do nothing, because a security checkbox that has no effect is worse than no checkbox. Fix the inverted `&& agentEnabled` guards so disabling the agent tightens rather than bypasses the check, and close the `noAgentRequired` hole that lets `cdp_command` run arbitrary code while the master switch reads "off." Remove the illegal `ws://` match pattern, trim `web_accessible_resources` so the sidebar and content script are no longer fetchable and fingerprintable by every site, and add an explicit `content_security_policy.extension_pages` with a tight `connect-src` allowlist so a compromised extension page cannot POST anywhere it likes.

### Phase 5 — Store packaging

Split the build as described in section 7, write the single-purpose narrative, rewrite `PRIVACY.md` to actually disclose `externally_connectable`, `web_accessible_resources`, and `alarms`, and remove the README's false "no data sent to external servers" claim. Fix the blocking accessibility problems — the `display: none` checkboxes, the non-focusable collapsible headers, the missing focus indicators, the pinned root font size, and the sub-AA contrast on muted text — since these are both the right thing to do and cheap review insurance.

---

## 9. Quality-of-life ideas worth building

A few of these are, in my view, more valuable than anything in the backlog above once the foundation is fixed.

**The extension-development hot loop.** You already have reload, error capture, and popup interaction. Wire them into one watcher: the MCP server watches the unpacked extension's directory, and on change it reloads the extension, reopens the target page, captures errors and console output, and pushes a compact diff of what changed since the last run. Combined with moving file reads to Node, that becomes a genuine "AI builds a Chrome extension" loop that nothing else on the market offers, because everything else drives a disposable profile.

**Record and export.** You have an interaction recorder that currently writes to a log nobody consumes. Make it emit a replayable script, and add an export to a Playwright test. "Do this by hand once, get a regression test" is a feature people will adopt the extension for.

**Snapshot diffing.** Expose "what changed after that action" as a first-class result — added and removed elements, changed text, new console errors, new network failures. Agents waste enormous numbers of turns re-snapshotting whole pages to answer this, and it is cheap for you to compute.

**MCP resources and prompts, not just tools.** Expose the current snapshot, console buffer, and network log as MCP resources so clients can pull them without spending a tool call, and ship prompts like "debug why this page is broken" and "smoke-test my extension" that encode the correct tool sequence. Most MCP servers skip both and lose the ergonomics.

**Auto-detect the extension under development.** If the working directory matches an unpacked extension path from `chrome.management.getAll()`, bind to it automatically so the agent never has to be told an extension ID.

**A per-action trace bundle.** Optional mode where every action returns a compact bundle — screenshot, new console entries, new network failures, DOM diff. Expensive in tokens, so keep it off by default, but it turns hard debugging sessions into single round trips.

**An auditable session log.** A local, user-readable log of every tool call and result, exposed both in the popup and as a tool. It helps you debug, it helps users trust the thing, and it is exactly the artefact a store reviewer wants to see.

---

## 10. If you only do five things

1. **Build the hub with per-client multiplexing and tab binding.** Until then Claude Code and Codex will connect, hang for thirty seconds per call, and tell you nothing about why. This is the direct answer to your original question.
2. **Implement real element refs and an accessibility-tree snapshot.** The advertised snapshot-then-click workflow has never worked, and no amount of protocol polish compensates for an agent that cannot reliably click a button.
3. **Close the trust boundary** — WebSocket token handshake, `Origin` check, no wildcard `externally_connectable`, persisted permissions, escaped sidebar output. This is a live risk on your machine today, not just a store problem.
4. **Make failures loud.** Delete or fix the seven hard stubs, stop converting CDP errors into empty successes, add the size governor, and return screenshots as images. Then add the contract test so it cannot regress.
5. **Move extension file reading into Node.** Cheapest large win available, and it unlocks the hot loop that makes this project genuinely differentiated.

---

## 11. Open decisions for you

Four things I could not decide on your behalf.

**Store or no store.** Section 7 is the fork in the road. Two builds is real ongoing work; skipping the store keeps all the power and costs you discoverability. I lean toward shipping Track A well and treating the store as a later, separate product — but you know what you want from it.

**The sidebar's fate.** I recommend cutting it. If you disagree, it needs a real agent loop, provider-native tool calling, a generated tool list rather than a fifth hand-maintained copy, current model IDs, and the XSS fix — call it a week of work on a component your target clients make redundant.

**CDP-first or synthetic-first.** CDP fixes trusted input, console, network, and iframes in one move, at the cost of a yellow infobar you cannot hide and a possible conflict with open DevTools. I recommend CDP-first with a synthetic fallback, but the banner is a real UX cost and it is your call.

**How aggressively to cut tools.** I suggest 73 down to roughly 25–30 with profiles. That means deleting or merging things you built, which is never fun, but tool schemas are a per-turn context tax and a smaller surface you can actually test is worth more than a large one you cannot.

