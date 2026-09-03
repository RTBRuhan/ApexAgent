# Changelog

All notable changes to Apex Agent are documented here.

## [2.0.0] — 2026-08-31

### ⚠️ Breaking Changes
- **Sidebar removed** — the AI chat sidebar has been completely removed. All AI interaction now happens through your code editor's MCP integration. Any stored API keys from v1 are automatically deleted on upgrade.
- **Tool consolidation** — 73 tools reduced to 33. Tools that differed only by an argument have been merged (e.g., `get_dom_tree` + `get_element_html` → `browser_dom` with an `action` parameter).
- **Wire protocol** — the internal WebSocket protocol has changed completely. v1 MCP server processes are not compatible with v2 extensions and vice versa.
- **`externally_connectable` removed** — extensions and pages can no longer connect directly. All communication goes through the hub.

### Added
- **Hub architecture** — a persistent WebSocket hub multiplexes multiple editors to one extension connection. Three editors can drive three different tabs simultaneously.
- **Pairing security** — 6-digit code handshake on first connection. Token-based auth after approval. Origin validation blocks web pages from connecting.
- **Element refs** — `browser_snapshot` returns stable `e7-12` handles. `browser_click`, `browser_type`, and all interaction tools accept refs. No more fragile selectors.
- **Accessibility-tree snapshots** — `browser_snapshot` returns ARIA roles, accessible names, and interaction states instead of raw HTML. The AI sees the page like a screen reader.
- **CDP-first input** — clicks and keystrokes use Chrome DevTools Protocol by default, producing trusted events. React, Angular, and all framework inputs work correctly.
- **Permission switches** — 8 capability toggles in the popup: navigation, input, screenshots, JS execution, trusted input, page reading, extension management, extension files.
- **Dialog handling** — `browser_handle_dialog` accepts/dismisses JavaScript alerts, confirms, and prompts.
- **File upload** — `browser_upload_file` sets files on `<input type="file">` elements via CDP.
- **Drag and drop** — `browser_drag` performs CDP-based drag operations.
- **Option selection** — `browser_select_option` for `<select>` elements.
- **Wait conditions** — `browser_wait_for` polls for element visibility, content changes, or network idle.
- **History navigation** — `browser_history` for back, forward, reload.
- **Real console/network capture** — `browser_console` and `browser_network` capture via CDP events, not content script monkey-patching.
- **Extension dev tools** — `ext_list`, `ext_control`, `ext_files`, `ext_debug`, `ext_watch` for developing and debugging extensions.
- **CLI tools** — `apex-agent doctor` (diagnostics), `apex-agent install` (auto-config), `apex-agent pair --reset`.
- **Shadow DOM support** — snapshots and queries traverse open shadow roots.
- **iframe support** — `all_frames: true` with `frameId`-addressed content script communication.
- **Closed shadow root overlay** — visual indicators are invisible to page scripts and screenshots.
- **State persistence** — service worker state survives MV3 suspension via `chrome.storage.session`.
- **Contract tests** — 327 tests validating tool schemas, error codes, and anti-patterns.

### Fixed
- **Refs never worked** — v1 assigned `ref: 'e' + index` but had no resolver. The advertised snapshot-then-click workflow never functioned. v2 refs resolve correctly.
- **Permission checks inverted** — v1 checked `if (!permission && agentEnabled)`, so switching the agent off *skipped* the check. v2 uses a single `isAllowed()` function that fails closed.
- **React input broken** — v1 set `element.value += char` which doesn't trigger React's synthetic events. v2 uses the native property descriptor setter.
- **Console capture captured itself** — v1 monkey-patched `console` in the content script's isolated world, capturing only the extension's own logs. v2 uses CDP `Runtime.consoleAPICalled`.
- **Overlay in screenshots** — v1 appended overlay elements to `document.body`, so they appeared in screenshots and DOM reads. v2 uses a closed shadow root.
- **Silent failures** — ~12 sites in v1 swallowed errors with `result?.elements || []`, causing the AI to think an empty page was successful. v2 returns explicit error codes for every failure.
- **Second editor dropped** — v1 had multiple server processes race for port 3052. The losers connected as peers and sent `tool_call` frames that were silently dropped. v2's hub architecture eliminates this.
- **State lost on worker suspend** — v1 kept all state in module-scope variables that died on MV3 service worker suspension. v2 persists to `chrome.storage.session`.
- **Keepalive didn't work** — v1 used `chrome.alarms` at `periodInMinutes: 0.25`, which is below Chrome's 30s floor. v2 uses hub-initiated WebSocket pings every 20s.
- **XSS in sidebar** — v1 rendered model output via `innerHTML`. Removed entirely.

### Removed
- AI chat sidebar (security vulnerability)
- `sidePanel` permission
- `alarms` permission
- `externally_connectable` wildcard
- 40 redundant/broken tools (see tool consolidation above)
- Direct `chrome.runtime.connectExternal` communication path

## [1.9.1] — Previous version
See RELEASE_NOTES.md for v1 history.
