/*
  The MCP config snippets live here rather than in either page that shows them, because the popup
  and the getting-started guide showing *different* config was one of the concrete onboarding
  failures in version 1: four of six snippets in the old docs were missing the "mcpServers"
  wrapper, so pasting them produced an editor that silently loaded nothing. One definition, two
  consumers, no drift.

  `npx -y apex-agent-mcp` is the published route and needs no clone, no path editing and no
  `npm install`. The cloned-repo route is documented in the guide instead of here, because it is a
  contributor path and putting it in the popup would double the number of decisions a first-time
  user has to make.
*/

export const MCP_JSON_SNIPPET = `{
  "mcpServers": {
    "apex-agent": {
      "command": "npx",
      "args": ["-y", "apex-agent-mcp"]
    }
  }
}`;

export const MCP_TOML_SNIPPET = `[mcp_servers.apex-agent]
command = "npx"
args = ["-y", "apex-agent-mcp"]`;

export const EDITOR_TARGETS = [
  {
    id: 'cursor',
    label: 'Cursor',
    path: '~/.cursor/mcp.json',
    note: 'For one project only, use .cursor/mcp.json inside that project instead.',
    snippet: MCP_JSON_SNIPPET,
    language: 'json'
  },
  {
    id: 'claude',
    label: 'Claude Code',
    path: '.mcp.json in your project root',
    note: 'Claude Desktop uses the same JSON in claude_desktop_config.json.',
    snippet: MCP_JSON_SNIPPET,
    language: 'json'
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    path: '~/.codex/config.toml',
    note: 'Codex uses TOML, not JSON. Append this to the end of the file.',
    snippet: MCP_TOML_SNIPPET,
    language: 'toml'
  }
];

export function findEditorTarget(id) {
  return EDITOR_TARGETS.find((target) => target.id === id) || EDITOR_TARGETS[0];
}
