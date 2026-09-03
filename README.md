# Apex Agent

> Connect your AI code editor to your real Chrome browser via MCP.

Apex Agent is a Chrome extension + MCP server that lets **Cursor**, **Claude Code**, **Codex CLI**, and any other MCP-compatible AI assistant control, inspect, and automate your real browser — with trusted input events, an accessibility-tree-based page model, and granular permission controls.

## What It Does

Your AI assistant gets 33 tools across 4 profiles to:

| Profile | Tools | What They Do |
|:---|:---|:---|
| **Core** | 16 | Navigate, snapshot pages, click, type, scroll, upload, handle dialogs, evaluate JS |
| **Inspect** | 9 | Read DOM, styles, console logs, network traffic, storage, accessibility tree |
| **Diagnose** | 2 | Performance profiling, raw CDP commands |
| **Extension** | 5 | List/reload/debug extensions, read extension source files, watch for changes |

### Key Features

- **CDP-first input** — clicks and keystrokes go through Chrome DevTools Protocol, producing trusted events indistinguishable from human input. Works with React, Angular, and all frameworks.
- **Accessibility-tree snapshots** — the AI sees the page the way a screen reader does: roles, names, states. Not a raw DOM dump.
- **Element refs** — snapshot returns stable `e7-12` handles that survive re-renders. No more fragile CSS selectors.
- **Multi-editor support** — three editors can connect simultaneously, each driving a different tab.
- **Permission switches** — 8 capability toggles (navigation, input, screenshots, JS execution, etc.) that the user controls from the popup.
- **Pairing security** — a 6-digit code handshake prevents unauthorized connections. Token-based auth after first pairing.
- **Extension dev tools** — reload, inspect, read source files, and watch for changes on any installed extension.

## Quick Start

### 1. Install the Extension

```bash
# Clone or download this repo
git clone https://github.com/RTBRuhan/ApexAgent.git

# In Chrome: chrome://extensions → Developer mode → Load unpacked → select extension/
```

### 2. Configure Your Editor

**Cursor** — add to `~/.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "apex-agent": {
      "command": "npx",
      "args": ["-y", "apex-agent-mcp"]
    }
  }
}
```

**Claude Code** — add to `.mcp.json` in your project root:
```json
{
  "mcpServers": {
    "apex-agent": {
      "command": "npx",
      "args": ["-y", "apex-agent-mcp"]
    }
  }
}
```

**Codex CLI** — add to `~/.codex/config.toml`:
```toml
[mcp_servers.apex-agent]
command = "npx"
args = ["-y", "apex-agent-mcp"]
```

Or use the CLI installer:
```bash
npx apex-agent-mcp install cursor
npx apex-agent-mcp install claude-code
npx apex-agent-mcp install codex
```

### 3. Approve the Connection

When your editor first connects, the Apex Agent popup shows a 6-digit pairing code. Compare it with the code in your editor's MCP log and click **Approve**. After that, connections are automatic.

### 4. Use It

Ask your AI assistant to do things in the browser:

> "Navigate to https://example.com and take a screenshot"
> "Click the Login button and type my email"
> "Read the console logs and find the error"
> "List all installed extensions and reload the one I'm working on"

## Architecture

```
Editor → stdio → Shim → WebSocket → Hub → WebSocket → Extension → Content Script
                                   127.0.0.1:3052
```

- **Shim** (`index.js`) — thin MCP-to-WebSocket relay, one per editor
- **Hub** (`lib/hub.js`) — singleton daemon that multiplexes editors to one extension connection
- **Extension** (`background.js`) — MV3 service worker that dispatches tool calls
- **Content Script** (`content/content.js`) — reads the DOM, builds snapshots, dispatches synthetic fallback events

## Permissions

The extension requests these permissions:

| Permission | Why |
|:---|:---|
| `activeTab` | Access the current tab when the user clicks the extension icon |
| `tabs` | List and manage tabs for multi-tab workflows |
| `scripting` | Inject content scripts dynamically when needed |
| `storage` | Persist policy settings and auth tokens |
| `webNavigation` | Detect page loads and iframe navigation |
| `management` | List, reload, and inspect other extensions (dev tooling) |
| `debugger` | CDP access for trusted input events and deep inspection |
| `<all_urls>` | Content script runs on all pages (required for browser automation) |

All capabilities are individually toggleable in the popup. The default policy enables navigation, input, screenshots, and page reading. JS execution, trusted input, extension management, and file access are off by default.

## CLI Tools

```bash
# Check connectivity
npx apex-agent-mcp doctor

# Auto-configure an editor
npx apex-agent-mcp install cursor

# Reset pairing (re-approve on next connect)
npx apex-agent-mcp pair --reset
```

## Security

- **No remote server** — everything runs on `127.0.0.1`. No data leaves your machine.
- **Token auth** — shims authenticate with a file-based token (`~/.apex-agent/token`, mode 0600).
- **Origin validation** — WebSocket connections from web pages are blocked at the HTTP upgrade.
- **Pairing** — the extension requires human approval via a 6-digit code on first connection.
- **No `innerHTML`** — the popup and all UI use `textContent` exclusively. No XSS vectors.
- **CSP** — `script-src 'self'; object-src 'none'; connect-src 'self' ws://127.0.0.1:*`

## Development

```bash
cd mcp-server
npm install
npm test          # Run contract tests (327 tests)
node index.js     # Start the MCP server
node lib/hub.js   # Start the hub standalone
```

## License

MIT
