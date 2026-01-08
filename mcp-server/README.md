# Apex Agent Server

Node.js MCP (Model Context Protocol) server that enables AI tools to control Chrome/Edge browser through the Apex Agent extension.

## Installation

```bash
npm install
```

## Usage

```bash
npm start
```

Or directly:

```bash
node index.js
```

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `PORT` | 3052 | WebSocket server port |

## MCP Configuration

Add to your AI tool's MCP settings:

```json
{
  "apex-agent": {
    "command": "node",
    "args": ["/path/to/mcp-server/index.js"]
  }
}
```

## Available Tools

### Browser Control
- `browser_navigate` - Navigate to URL
- `browser_click` - Click element
- `browser_type` - Type text
- `browser_scroll` - Scroll page
- `browser_snapshot` - Get page elements
- `browser_evaluate` - Run JavaScript

### DevTools Inspection
- `inspect_element` - Deep element inspection
- `get_dom_tree` - DOM tree structure
- `get_computed_styles` - CSS styles
- `get_element_html` - Get HTML
- `query_all` - Find elements
- `find_by_text` - Find by text content
- `get_attributes` - Element attributes

### Page Analysis
- `get_page_metrics` - Performance metrics
- `get_console_logs` - Console messages
- `get_network_info` - Network requests
- `get_storage` - Storage contents
- `get_cookies` - Document cookies

## Architecture

```
AI Tool (Cursor/Windsurf)
    ↓ stdin/stdout (MCP Protocol)
MCP Server (index.js)
    ↓ WebSocket
Apex Agent Extension
    ↓ Chrome APIs
Browser
```

## License

MIT
