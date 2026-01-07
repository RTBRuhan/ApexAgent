# Chrome MCP

<div align="center">

![Chrome MCP Logo](extension/icons/icon.svg)

**AI-Powered Browser Control & Debugging Extension**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Chrome](https://img.shields.io/badge/Chrome-Extension-green.svg)](https://www.google.com/chrome/)
[![Edge](https://img.shields.io/badge/Edge-Extension-blue.svg)](https://www.microsoft.com/edge)

[Features](#features) • [Installation](#installation) • [Usage](#usage) • [MCP Tools](#mcp-tools) • [Author](#author)

</div>

---

## 🚀 Features

### 🤖 MCP Server Integration
Connect AI assistants like **Cursor**, **Windsurf**, or any MCP-compatible tool to control your browser in real-time.

### 📹 Interaction Recording
Record user interactions including:
- Mouse clicks (single, double, right-click)
- Keyboard input
- Scroll events
- DOM changes with before/after states
- Smart filtering to skip dynamic/automatic changes

### 🕹️ AI Agent Control
Allow AI to fully control your browser:
- Navigate to URLs
- Click elements
- Type text
- Scroll pages
- Execute JavaScript
- Take screenshots

### 🔍 DevTools Inspection
AI-powered debugging capabilities:
- Inspect element properties, styles, and box model
- View DOM tree structure
- Get computed CSS styles
- Query elements by selector or text
- Monitor console logs
- Analyze network requests
- Access localStorage/sessionStorage
- View cookies

### 🎨 Visual Feedback
- AI cursor visualization
- Element highlighting
- Action tooltips
- Connection status badge on extension icon

---

## 📦 Installation

### Extension Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/RTBRuhan/ChromeMCP.git
   cd ChromeMCP
   ```

2. **Load in Chrome/Edge:**
   - Open `chrome://extensions/` or `edge://extensions/`
   - Enable "Developer mode"
   - Click "Load unpacked"
   - Select the `extension` folder

3. **Install MCP Server dependencies:**
   ```bash
   cd mcp-server
   npm install
   ```

### AI Tool Configuration

Add this to your AI tool's MCP settings (e.g., Cursor's `mcp.json`):

```json
{
  "chrome-mcp": {
    "command": "node",
    "args": ["/path/to/ChromeMCP/mcp-server/index.js"]
  }
}
```

> ⚠️ Replace `/path/to/ChromeMCP` with your actual installation path

---

## 🔧 Usage

### Quick Start

1. **Start the MCP Server:**
   ```bash
   cd mcp-server
   npm start
   ```

2. **Connect Extension:**
   - Click the Chrome MCP extension icon
   - Go to **MCP** tab
   - Click **Connect**

3. **Enable Agent Control:**
   - Go to **Agent** tab
   - Toggle **Agent Control** ON
   - Configure permissions as needed

4. **Use with AI:**
   - Your AI assistant can now control the browser!

### Connection Status Badge

| Badge | Status |
|-------|--------|
| ● Green | Connected |
| ◐ Orange | Reconnecting |
| ○ Gray | Disconnected |

---

## 🛠️ MCP Tools

### Browser Control

| Tool | Description |
|------|-------------|
| `browser_navigate` | Navigate to a URL |
| `browser_click` | Click an element by CSS selector |
| `browser_type` | Type text into an element |
| `browser_scroll` | Scroll the page |
| `browser_snapshot` | Get page snapshot with interactive elements |
| `browser_evaluate` | Execute JavaScript code |

### DevTools Inspection

| Tool | Description |
|------|-------------|
| `inspect_element` | Deep inspect - box model, styles, attributes |
| `get_dom_tree` | Get DOM tree structure |
| `get_computed_styles` | Get computed CSS properties |
| `get_element_html` | Get innerHTML/outerHTML |
| `query_all` | Find all elements matching selector |
| `find_by_text` | Find elements containing text |
| `get_attributes` | Get all attributes and data-* properties |

### Page Analysis

| Tool | Description |
|------|-------------|
| `get_page_metrics` | Performance, element counts, memory |
| `get_console_logs` | Captured console messages |
| `get_network_info` | Network requests and timing |
| `get_storage` | localStorage/sessionStorage contents |
| `get_cookies` | Document cookies |

---

## 📁 Project Structure

```
ChromeMCP/
├── extension/
│   ├── manifest.json       # Extension manifest (MV3)
│   ├── background.js       # Service worker
│   ├── popup/
│   │   ├── popup.html      # Extension popup UI
│   │   ├── popup.css       # Styles
│   │   └── popup.js        # Popup logic
│   ├── content/
│   │   ├── content.js      # Content script (DOM interaction)
│   │   └── content.css     # Visual feedback styles
│   └── icons/
│       └── icon.svg        # Extension icon
├── mcp-server/
│   ├── index.js            # MCP server implementation
│   ├── package.json        # Node.js dependencies
│   └── README.md           # Server documentation
└── README.md               # This file
```

---

## ⚙️ Configuration

### Extension Permissions

The extension requests the following permissions:
- `activeTab` - Access to the current tab
- `tabs` - Tab management
- `scripting` - Execute scripts in pages
- `storage` - Save settings
- `webNavigation` - Track navigation events
- `alarms` - Keep service worker alive
- `<all_urls>` - Access to all websites

### Agent Permissions

Configure in the **Agent** tab:
- **Mouse Control** - Allow AI to click and hover
- **Keyboard Input** - Allow AI to type
- **Navigation** - Allow AI to navigate
- **Script Execution** - Allow AI to run JavaScript
- **Screenshots** - Allow AI to capture screenshots

---

## 🔒 Security Notes

- Agent control is **disabled by default**
- All AI actions require explicit permission
- The extension only connects to localhost MCP server
- No data is sent to external servers
- Auto-disconnect on extension close

---

## 🐛 Troubleshooting

### Extension not connecting?
1. Make sure MCP server is running (`npm start`)
2. Check the port (default: 3052)
3. Reload the extension

### AI can't control browser?
1. Enable Agent Control in Agent tab
2. Check permission checkboxes
3. Ensure you're on a regular webpage (not `chrome://` or `edge://`)

### Console showing errors?
- Check DevTools console for detailed error messages
- Reload extension after making changes

---

## 📝 License

MIT License - see [LICENSE](LICENSE) for details.

---

## 👤 Author

**RTBRuhan**

- Website: [rtbruhan.github.io](https://rtbruhan.github.io)
- GitHub: [@RTBRuhan](https://github.com/RTBRuhan)

---

## 🙏 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

---

<div align="center">

**Made with ❤️ for the AI development community**

</div>
