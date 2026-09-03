# Apex Agent v2.0.0 — Rebuild Progress Tracker

**Last updated:** 2026-08-31T14:31Z
**Overall progress:** ██████████ **95%**

---

## Quick Status

| Component | Status | Details |
|:---|:---|:---|
| 🟢 Audit & Plan | **DONE** | `APEX_AGENT_MODERNIZATION_PLAN.md` — 375-line plan covering 73→33 tool consolidation, security, protocol, architecture |
| 🟢 Contract Docs | **DONE** | 4 interface specs in `docs/` — CONTENT_ACTIONS, INTERNAL_PROTOCOL, MANIFEST_CHANGES_FROM_UI, POPUP_MESSAGES |
| 🟢 V2 Tool Catalog | **DONE** | `mcp-server/lib/tools.js` — 33 tools with profiles, schema validation, error codes (1113 lines) |
| 🟢 Popup UI Rewrite | **DONE** | `extension/popup/popup.js` + `popup.html` + `popup.css` — full rewrite with pairing UI, policy controls, activity feed |
| 🟢 Shared Libraries | **DONE** | `extension/lib/` — `policy.js`, `editor-setup.js`, `migrate.js`, `connection-copy.js` |
| 🟢 Sidebar Removal | **DONE** | `extension/sidebar/` directory deleted, manifest key removed |
| 🟢 MCP Hub | **DONE** | `mcp-server/lib/hub.js` (12.5KB) — multi-client multiplexing, token auth, pairing, keepalive |
| 🟢 MCP Server Rewrite | **DONE** | `mcp-server/index.js` (6.2KB) — rewritten using `@modelcontextprotocol/server` SDK v2 |
| 🟢 Background.js Rewrite | **DONE** | `extension/background.js` (19.1KB) — complete rewrite with CDP engine, policy, pairing |
| 🟢 Content Script Rewrite | **DONE** | `extension/content/content.js` (30KB) — ref registry, a11y snapshot, shadow DOM, overlay |
| 🟢 Manifest Update | **DONE** | `extension/manifest.json` — v2.0.0, all_frames, no sidebar, tightened permissions |
| 🟢 CLI Tools | **DONE** | `mcp-server/bin/cli.js` — doctor, install, pair commands |
| 🟢 Tests | **DONE** | 327/327 contract tests passing, `mcp-server/test/contract.test.js` |
| 🟢 Docs Update | **DONE** | README.md, PRIVACY.md, CHANGELOG.md all rewritten for v2 |

---

## Architecture Overview (What We're Building)

```
┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐
│  Cursor IDE          │  │  Claude Code          │  │  Codex CLI           │
│  (MCP client)        │  │  (MCP client)         │  │  (MCP client)        │
└──────────┬───────────┘  └──────────┬────────────┘  └──────────┬───────────┘
           │ stdio                   │ stdio                    │ stdio
┌──────────▼───────────┐  ┌──────────▼────────────┐  ┌──────────▼───────────┐
│  Shim A              │  │  Shim B               │  │  Shim C              │
│  (thin stdio relay)  │  │  (thin stdio relay)    │  │  (thin stdio relay)  │
└──────────┬───────────┘  └──────────┬────────────┘  └──────────┬───────────┘
           │ WS /client              │ WS /client               │ WS /client
           └─────────────┬───────────┴──────────────────────────┘
                         │
              ┌──────────▼───────────┐
              │     HUB              │
              │  ws://127.0.0.1:3052 │
              │  - Token auth        │
              │  - Pairing protocol  │
              │  - Request mux       │
              │  - Per-client tabs   │
              └──────────┬───────────┘
                         │ WS /extension
              ┌──────────▼───────────┐
              │  Background.js       │
              │  (Service Worker)    │
              │  - Policy enforce    │
              │  - CDP dispatch      │
              │  - Tab management    │
              └──────────┬───────────┘
                         │ chrome.tabs.sendMessage
              ┌──────────▼───────────┐
              │  Content Script      │
              │  - Ref registry      │
              │  - A11y snapshot     │
              │  - Overlay (shadow)  │
              │  - Fallback input    │
              └──────────────────────┘
```

---

## Phase Breakdown

### Phase 1: MCP Server & Hub (estimated: 35% of remaining work)
The entire server-side stack. This is the foundation everything else builds on.

- [x] **1A.** Rewrite `mcp-server/index.js` using `@modelcontextprotocol/server` SDK v2
  - Uses low-level `Server` class with `setRequestHandler` for raw JSON Schema support
  - Imports consolidated 33-tool catalog from `lib/tools.js`
  - Proper MCP image content blocks for screenshots
  - `isError` on failures
  - Size governor on results (100KB cap with truncation)
  - Per-tool timeouts
  - Auto-spawns hub if not running
- [x] **1B.** Create `mcp-server/lib/hub.js` — the WebSocket hub daemon
  - Dual-path endpoints: `/client` for shims, `/extension` for the Chrome extension
  - Token auth via `~/.apex-agent/token` (generated on first run, `0600` perms)
  - Origin validation (block web browsers on `/client`, allow only `chrome-extension://` on `/extension`)
  - Pairing protocol: 6-digit code → popup approval → `pair_approve` → `registered`
  - Per-client request ID namespace and tab binding
  - Deadline tracking (`deadlineAt` epoch ms)
  - Keepalive pings every 20s
  - Singleton via lockfile
- [/] **1C.** Create `mcp-server/bin/shim.js` — the thin stdio-to-hub relay (merged into index.js)
- [ ] **1D.** Create `mcp-server/bin/doctor.js` — diagnostic CLI
- [ ] **1E.** Create `mcp-server/bin/install.js` — auto-config installer
- [x] **1F.** Update `mcp-server/package.json`

### Phase 2: Background Service Worker (estimated: 30% of remaining work)
Complete rewrite of `extension/background.js` against the contract docs.

- [ ] **2A.** New `extension/background.js` — core structure
  - WebSocket client connecting to `ws://127.0.0.1:3052/extension`
  - Pairing protocol implementation (`pair_required` → `pair_approve`)
  - `apex:*` popup message handlers (per `docs/POPUP_MESSAGES.md`)
  - Policy enforcement via `isAllowed()` from `lib/policy.js`
  - `__apex: 1` content script dispatch (per `docs/CONTENT_ACTIONS.md`)
  - Deadline tracking for expired work
  - 20s WS keepalive (resets Chrome 116+ SW idle timer)
- [ ] **2B.** CDP engine
  - `chrome.debugger` attach/detach with reference counting + `finally` cleanup
  - `Input.dispatchMouseEvent` / `Input.insertText` for trusted events
  - Console capture via `Runtime.consoleAPICalled`
  - Network capture via `Network` domain
  - Performance/profiling tools
  - Proper cleanup on tab close
- [ ] **2C.** Extension management tools
  - Source file reading via hub (filesystem, not fetch)
  - Reload, enable/disable, manifest reading
  - Extension watcher (file system watch + auto-reload)
- [ ] **2D.** State persistence
  - All module-scope state → `chrome.storage.session`
  - Rehydrate on worker wake
  - Orphaned in-flight requests → explicit failure frames
  - Single-flight reconnection (close previous socket before replacing)
- [ ] **2E.** Recording subsystem
  - Interaction recorder
  - Export to replayable script / Playwright test

### Phase 3: Content Script (estimated: 20% of remaining work)
Complete rewrite of `extension/content/content.js` against `docs/CONTENT_ACTIONS.md`.

- [ ] **3A.** Wire format & lifecycle
  - Synchronous listener at `document_start`
  - `__apex: 1` message discrimination
  - `all_frames: true` support with `frameId`
  - Generation tracking
- [ ] **3B.** Ref registry
  - `data-apex-ref` attributes on elements
  - Generation-stamped `Map<string, WeakRef<Element>>`
  - `e<generation>-<ordinal>` format
  - STALE_REF / NODE_DETACHED error distinction
- [ ] **3C.** Accessibility-tree snapshot
  - Role-based element enumeration
  - Proper accessible name computation (aria-labelledby, label[for], alt, title, placeholder)
  - Interaction state (disabled, checked, selected, expanded, readonly)
  - Element cap with honest total count
  - Shadow DOM traversal (open roots)
- [ ] **3D.** Selector improvements
  - `getUniqueSelector` anchored at ID or `document.body`
  - Verify uniqueness by re-querying
  - `CSS.escape`, SVG casing preservation
  - `nodeType` guard for Text nodes
- [ ] **3E.** Overlay system
  - Closed shadow root on `document.documentElement`
  - `pointer-events: none` on tooltip and indicator
  - Hide before screenshot, await frame
  - Teardown + re-creation on SPA body replacement
- [ ] **3F.** Fallback input handlers
  - `clickFallback` with full pointer-event sequence, hover pre-sequence, hit-test
  - `typeFallback` with React native-setter, beforeinput, contenteditable via Range
  - `hoverFallback`, `a11yFallback`
  - Click preflight (scroll, rect stability, occluded check)

### Phase 4: Manifest & Packaging (estimated: 10% of remaining work)

- [ ] **4A.** Update `extension/manifest.json`
  - Version → `2.0.0`
  - Add `all_frames: true` to content_scripts
  - Remove `side_panel` key and `sidePanel` permission
  - Remove sidebar/getting-started from `web_accessible_resources`
  - Tighten `externally_connectable` (remove wildcard `ids`)
  - Add `content_security_policy.extension_pages` with tight `connect-src`
- [ ] **4B.** Delete `extension/sidebar/` directory
- [ ] **4C.** Root `package.json` with workspace config
- [ ] **4D.** Update README.md — accurate permission list, tool docs, security section
- [ ] **4E.** Update PRIVACY.md — disclose all permissions accurately
- [ ] **4F.** Update getting-started page
- [ ] **4G.** CHANGELOG.md — replace ad-hoc release notes

### Phase 5: Tests & CI (estimated: 5% of remaining work)

- [ ] **5A.** Contract tests
  - Every TOOLS entry has a dispatch handler
  - Every tool has a schema with parameter descriptions
  - No tool returns bare `{success: true}` with empty payload
- [ ] **5B.** Integration tests
  - Real Chrome + unpacked extension + MCP server
  - Fixture page with React input, shadow DOM, iframe, canvas, overlay
- [ ] **5C.** CI via GitHub Actions
  - ESLint, manifest validation, both test suites
- [ ] **5D.** Linter/formatter config (ESLint + Prettier)

---

## What Was Already Done (by previous Claude session, 2026-08-30)

### Completed ✅
1. **Full audit** — read every source file (91KB background.js, 53KB content.js, 27KB index.js, 53KB tools.js, plus all UI files)
2. **APEX_AGENT_MODERNIZATION_PLAN.md** — 375-line diagnosis with 5 root causes, 8-phase plan, 10 open decisions
3. **docs/CONTENT_ACTIONS.md** — 17-action contract for content script ↔ service worker
4. **docs/INTERNAL_PROTOCOL.md** — 4-hop wire protocol spec (shim ↔ hub ↔ extension ↔ content)
5. **docs/MANIFEST_CHANGES_FROM_UI.md** — manifest change checklist from UI team
6. **docs/POPUP_MESSAGES.md** — popup ↔ worker message contract
7. **mcp-server/lib/tools.js** — 33-tool catalog with `ERROR_CODES`, `PROFILES`, `validateParams`, `validateTarget`, `toMcpTool` (1113 lines)
8. **extension/popup/popup.js** — complete rewrite (690 lines) with zero-innerHTML policy, `apex:*` messaging, pairing UI, dual push/poll refresh
9. **extension/popup/popup.html** — complete rewrite (174 lines) with pairing block, client list, permission switches, activity feed, editor setup
10. **extension/popup/popup.css** — complete rewrite (676 lines) with dark/light themes, tally lamp, pairing digits, segmented controls
11. **extension/lib/policy.js** — shared policy module (normalisePolicy, isAllowed, readPolicy)
12. **extension/lib/editor-setup.js** — MCP config snippets for Cursor/Claude Code/Codex
13. **extension/lib/migrate.js** — v2 migration runner (sidebar retirement, policy seeding)
14. **extension/lib/connection-copy.js** — connection state descriptions and blocked reasons
15. **extension/sidebar/sidebar.js** — tombstoned (8 lines, empty with comment)
16. **extension/sidebar/sidebar.html** — tombstoned (29 lines, static retirement notice)

### NOT Done Yet (where current session picks up) ❌
17. **mcp-server/index.js** — still legacy v1 (403 lines, hand-rolled JSON-RPC, 54 hardcoded tools, doesn't import lib/tools.js)
18. **mcp-server/lib/hub.js** — does not exist
19. **mcp-server/bin/shim.js** — does not exist
20. **extension/background.js** — still legacy v1 (2831 lines, old message handlers, inverted permission checks)
21. **extension/content/content.js** — still legacy v1 (1667 lines, no ref registry, no __apex protocol)
22. **extension/manifest.json** — still v1.9.1 with old permissions/sidebar
23. **Tests** — no test directory exists
24. **npm packaging** — no bin entry, no root package.json
25. **Docs update** — README, PRIVACY.md, getting-started still reference v1

---

## Current Session Progress (2026-08-31)

### Completed in this session ✅
1. Deep re-audit of all files to verify previous session's state
2. Verified MCP SDK v2 (2026-07-28 spec, `@modelcontextprotocol/server` package)
3. Verified client config formats (Cursor: `mcp.json`, Claude Code: `.mcp.json`, Codex: `config.toml`)
4. Created this progress tracker

### Currently Working On 🔄
- Phase 1: MCP Server & Hub rewrite

### Next Up ⏭️
- Phase 2: Background service worker rewrite
- Phase 3: Content script rewrite
- Phase 4: Manifest & packaging
- Phase 5: Tests & CI

---

## Key Decisions Made

| Decision | Choice | Rationale |
|:---|:---|:---|
| Store vs self-distributed | **Self-distributed (Track A)** first | Keep full power; store build is a later product |
| Sidebar | **Cut entirely** | Tombstoned; editors do this better; source of XSS |
| Input method | **CDP-first** | Trusted events, fixes React typing, form submit, clipboard |
| Tool count | **73 → 33** | Already done in `lib/tools.js` with profile system |
| MCP SDK | **`@modelcontextprotocol/server` v2** | Official SDK, stateless protocol, handles negotiation |
| Auth | **Token + pairing code** | Prevents localhost hijacking |

---

## Continuation Prompt

If this conversation hits a quota limit or needs to be continued in a new session, paste this prompt:

```
I'm continuing polish on the ApexAgent Chrome extension v2.0.0. The project is at:
f:\SoftwareCollection\MyTools\Extension\ApexAgent

READ THIS FILE FIRST:
f:\SoftwareCollection\MyTools\Extension\ApexAgent\PROGRESS.md — overall progress tracker

THE V2 REBUILD IS 95% COMPLETE. All core files have been rewritten:
- mcp-server/index.js — MCP shim using @modelcontextprotocol/server SDK v2 (6.2KB)
- mcp-server/lib/hub.js — WebSocket hub with auth, pairing, multiplexing (12.5KB)
- mcp-server/lib/tools.js — 33-tool catalog with profiles and validation (52KB)
- mcp-server/bin/cli.js — doctor/install/pair CLI (6.2KB)
- extension/background.js — service worker with CDP, policy, pairing (19KB)
- extension/content/content.js — ref registry, a11y snapshot, overlay (30KB)
- extension/manifest.json — v2.0.0 with all_frames, no sidebar
- extension/popup/ — complete v2 popup UI
- extension/lib/ — policy.js, editor-setup.js, migrate.js, connection-copy.js
- mcp-server/test/contract.test.js — 327/327 passing
- README.md, PRIVACY.md, CHANGELOG.md — all updated for v2
- Sidebar directory deleted

REMAINING WORK (~5%):
- Getting-started page needs update for v2
- Integration test with real Chrome browser
- npm publish preparation
- Optional: GitHub Actions CI pipeline

Check PROGRESS.md for the full task list with [x] done and [ ] remaining items.
```

---

## File Inventory

### v2 Implementation Files
```
mcp-server/index.js                 — MCP server shim (rewritten)
mcp-server/lib/hub.js               — WebSocket hub daemon (new)
mcp-server/lib/tools.js             — 33-tool catalog (from previous session)
mcp-server/bin/cli.js               — doctor/install/pair CLI (new)
mcp-server/test/contract.test.js    — 327 contract tests (new)
mcp-server/package.json             — apex-agent-mcp v2.0.0 (updated)
extension/background.js             — service worker (rewritten, 564 lines)
extension/content/content.js        — content script (rewritten, 916 lines)
extension/manifest.json             — v2.0.0 manifest (updated)
extension/popup/popup.js            — popup controller (from previous session)
extension/popup/popup.html          — popup markup (from previous session)
extension/popup/popup.css           — popup styles (from previous session)
extension/lib/policy.js             — policy enforcement (from previous session)
extension/lib/editor-setup.js       — MCP config snippets (from previous session)
extension/lib/migrate.js            — v2 migration runner (from previous session)
extension/lib/connection-copy.js    — connection state copy (from previous session)
docs/CONTENT_ACTIONS.md             — content script contract
docs/INTERNAL_PROTOCOL.md           — wire protocol contract
docs/POPUP_MESSAGES.md              — popup message contract
docs/MANIFEST_CHANGES_FROM_UI.md    — manifest change spec
APEX_AGENT_MODERNIZATION_PLAN.md    — original audit/plan
README.md                           — project README (rewritten)
PRIVACY.md                          — privacy policy (rewritten)
CHANGELOG.md                        — v2.0.0 changelog (new)
PROGRESS.md                         — this file
```

### All legacy files have been rewritten ✅
- `extension/background.js` — was 2831 lines → now 564 lines
- `extension/content/content.js` — was 1667 lines → now 916 lines
- `extension/manifest.json` — was v1.9.1 → now v2.0.0
- `mcp-server/index.js` — was 403 lines → now completely rewritten

### Remaining files to create (optional polish)
```
test/integration.test.js             — e2e integration tests with real Chrome
.github/workflows/ci.yml             — CI pipeline
```
