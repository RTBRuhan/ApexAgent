#!/usr/bin/env node
/**
 * apex-agent CLI — utility commands for managing the ApexAgent MCP bridge.
 *
 * Subcommands:
 *   doctor   — diagnose connection problems
 *   install  — write the MCP config for your editor
 *   pair     — manage pairing (--reset to re-pair)
 */

import { readFile, access, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { connect } from 'node:net';
import { constants } from 'node:fs';

const APEX_DIR = join(homedir(), '.apex-agent');
const TOKEN_PATH = join(APEX_DIR, 'token');
const LOCK_PATH = join(APEX_DIR, 'hub.lock');
const PORT = Number(process.env.APEX_PORT) || 3052;

const EDITORS = {
  cursor: {
    name: 'Cursor',
    path: join(homedir(), '.cursor', 'mcp.json'),
    format: 'json',
  },
  'claude-code': {
    name: 'Claude Code',
    path: join(process.cwd(), '.mcp.json'),
    format: 'json',
  },
  codex: {
    name: 'Codex CLI',
    path: join(homedir(), '.codex', 'config.toml'),
    format: 'toml',
  },
};

const MCP_JSON = `{
  "mcpServers": {
    "apex-agent": {
      "command": "npx",
      "args": ["-y", "apex-agent-mcp"]
    }
  }
}`;

const MCP_TOML = `[mcp_servers.apex-agent]
command = "npx"
args = ["-y", "apex-agent-mcp"]`;

// ─── Helpers ───

function ok(msg) { console.log(`  ✓ ${msg}`); }
function fail(msg) { console.log(`  ✗ ${msg}`); }
function info(msg) { console.log(`  ℹ ${msg}`); }

async function fileExists(path) {
  try { await access(path, constants.R_OK); return true; } catch { return false; }
}

function portOpen(port) {
  return new Promise((resolve) => {
    const sock = connect({ host: '127.0.0.1', port }, () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
    sock.setTimeout(2000, () => { sock.destroy(); resolve(false); });
  });
}

// ─── doctor ───

async function doctor() {
  console.log('\nApex Agent Doctor\n');
  let issues = 0;

  // 1. Check token file
  if (await fileExists(TOKEN_PATH)) {
    ok('Token file exists at ' + TOKEN_PATH);
  } else {
    fail('No token file at ' + TOKEN_PATH);
    info('The hub creates this on first run. Start the hub or your editor.');
    issues++;
  }

  // 2. Check hub lockfile
  if (await fileExists(LOCK_PATH)) {
    try {
      const pid = parseInt(await readFile(LOCK_PATH, 'utf8'), 10);
      ok(`Hub lockfile exists (PID ${pid})`);
      // Try to check if process is alive
      try { process.kill(pid, 0); ok('Hub process is alive'); }
      catch { fail('Hub lockfile exists but process is dead (stale lock)'); info('Delete ' + LOCK_PATH + ' and restart.'); issues++; }
    } catch {
      fail('Hub lockfile exists but is unreadable');
      issues++;
    }
  } else {
    fail('Hub is not running (no lockfile)');
    info('Start your editor or run: npx apex-agent-mcp');
    issues++;
  }

  // 3. Check port
  if (await portOpen(PORT)) {
    ok(`Port ${PORT} is responding`);
  } else {
    fail(`Nothing is listening on port ${PORT}`);
    info('The hub listens on this port. Start it first.');
    issues++;
  }

  // 4. Check editor configs
  console.log('\n  Editor configurations:');
  for (const [id, editor] of Object.entries(EDITORS)) {
    if (await fileExists(editor.path)) {
      try {
        const content = await readFile(editor.path, 'utf8');
        if (content.includes('apex-agent')) {
          ok(`${editor.name}: configured at ${editor.path}`);
        } else {
          info(`${editor.name}: file exists but no apex-agent entry (${editor.path})`);
        }
      } catch {
        info(`${editor.name}: file exists but unreadable (${editor.path})`);
      }
    } else {
      info(`${editor.name}: no config at ${editor.path}`);
    }
  }

  console.log(`\n${issues === 0 ? '  All checks passed.' : `  ${issues} issue(s) found.`}\n`);
  process.exit(issues > 0 ? 1 : 0);
}

// ─── install ───

async function install(clientId) {
  if (!clientId || !EDITORS[clientId]) {
    console.log('\nUsage: apex-agent install <client>\n');
    console.log('Available clients:');
    for (const [id, e] of Object.entries(EDITORS)) {
      console.log(`  ${id.padEnd(14)} → ${e.path}`);
    }
    console.log('');
    process.exit(1);
  }

  const editor = EDITORS[clientId];
  const snippet = editor.format === 'toml' ? MCP_TOML : MCP_JSON;

  if (await fileExists(editor.path)) {
    const content = await readFile(editor.path, 'utf8');
    if (content.includes('apex-agent')) {
      ok(`${editor.name} is already configured at ${editor.path}`);
      process.exit(0);
    }
    // For TOML, we can append. For JSON, we need to merge.
    if (editor.format === 'toml') {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(editor.path, content.trimEnd() + '\n\n' + snippet + '\n');
      ok(`Appended apex-agent config to ${editor.path}`);
    } else {
      console.log(`\n  ${editor.name} config exists at ${editor.path}`);
      console.log('  Add this to the file manually:\n');
      console.log(snippet);
      console.log('');
    }
  } else {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(editor.path), { recursive: true });
    await writeFile(editor.path, snippet + '\n');
    ok(`Created ${editor.path} with apex-agent config`);
  }
}

// ─── pair ───

async function pair(args) {
  if (args.includes('--reset')) {
    if (await fileExists(TOKEN_PATH)) {
      await unlink(TOKEN_PATH);
      ok('Token file deleted. Restart your editor to re-pair.');
    } else {
      info('No token file to delete.');
    }
    return;
  }
  console.log('\nUsage: apex-agent pair --reset\n');
  info('Removes the auth token so the extension must re-approve on next connection.');
}

// ─── Main ───

const [,, cmd, ...args] = process.argv;

switch (cmd) {
  case 'doctor': await doctor(); break;
  case 'install': await install(args[0]); break;
  case 'pair': await pair(args); break;
  default:
    console.log(`
Apex Agent CLI v2.0.0

Usage: apex-agent <command>

Commands:
  doctor              Check hub, extension, and editor connectivity
  install <client>    Write MCP config (cursor | claude-code | codex)
  pair --reset        Delete auth token to force re-pairing
`);
    process.exit(cmd ? 1 : 0);
}
