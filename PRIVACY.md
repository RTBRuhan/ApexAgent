# Privacy Policy — Apex Agent

**Last updated:** 2026-08-31

## What Apex Agent Does

Apex Agent connects AI code editors (Cursor, Claude Code, Codex) to your Chrome browser via a local MCP (Model Context Protocol) server. It lets your AI assistant navigate pages, click elements, read content, and automate browser tasks.

## Data Collection

**Apex Agent collects no data.** Specifically:

- ❌ No analytics or telemetry
- ❌ No data sent to any remote server
- ❌ No browsing history recording
- ❌ No user accounts or registration
- ❌ No cookies or tracking pixels

## Data Flow

All communication stays on your local machine:

```
Your editor ←→ localhost:3052 ←→ Your Chrome browser
```

- The MCP server runs on `127.0.0.1` (localhost only)
- WebSocket connections are restricted to `127.0.0.1`
- No network requests are made to external servers
- Page content is read only when your AI assistant requests it via a tool call

## What the Extension Can Access

When **you** grant permission via the popup switches:

| Capability | What It Accesses | Default |
|:---|:---|:---|
| Navigation | Page URLs, tab list | ON |
| Input | Clicks, keystrokes on page elements | ON |
| Screenshots | Viewport pixel capture | ON |
| Read Page | DOM content, text, element attributes | ON |
| JavaScript | Execute arbitrary JS in the page context | OFF |
| Trusted Input | Chrome DevTools Protocol for trusted events | OFF |
| Extension Management | List, reload, inspect other extensions | OFF |
| Extension Files | Read source files of other extensions | OFF |

Each capability can be toggled independently. When a capability is OFF, tool calls requiring it are refused with an explicit error — they are not silently dropped.

## Stored Data

The extension stores the following in `chrome.storage.local`:

- **Policy settings** — your permission toggle states
- **Auth token** — the pairing token for hub authentication (local only)
- **Migration records** — which data migrations have been applied

The hub stores in `~/.apex-agent/`:

- **token** — bearer token for WebSocket authentication (file mode 0600)
- **hub.lock** — PID lockfile for singleton enforcement

No API keys, passwords, browsing history, or page content is persisted.

## Third-Party Services

Apex Agent uses **no third-party services**. The only external dependency is the npm package registry when you run `npx apex-agent-mcp` (which downloads the server code to your machine).

## Changes from v1

Version 2 removed the AI chat sidebar, which stored API keys and rendered model output via `innerHTML`. The migration automatically deletes any stored API keys from v1. No user data from the sidebar feature is retained.

## Contact

For questions about this privacy policy, open an issue on the project repository.
