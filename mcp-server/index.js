#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { TOOLS, toMcpTool, validateParams } from './lib/tools.js';

const HUB_PORT = 3052;
const HUB_WS_URL_BASE = `ws://127.0.0.1:${HUB_PORT}/client`;
const TOKEN_PATH = path.join(os.homedir(), '.apex-agent', 'token');

function readToken() {
  try {
    return fs.readFileSync(TOKEN_PATH, 'utf8').trim();
  } catch (err) {
    return null;
  }
}

import { fileURLToPath } from 'node:url';

function spawnHub() {
  const hubPath = fileURLToPath(new URL('./lib/hub.js', import.meta.url));
  const child = spawn(process.execPath, [hubPath], {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
}

const server = new Server(
  { name: 'apex-agent', version: '2.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler('tools/list', async () => {
  return {
    tools: TOOLS.map(t => toMcpTool(t))
  };
});

let ws;
let isShuttingDown = false;
let nextRid = 1;
const pendingCalls = new Map();

function connectHub(attempt = 1) {
  if (isShuttingDown) return;

  const token = readToken();
  if (!token) {
    if (attempt === 1) {
      console.error('No token found, spawning hub to create it...');
      spawnHub();
    }
    if (attempt <= 3) {
      setTimeout(() => connectHub(attempt + 1), 1000 * Math.pow(2, attempt));
      return;
    }
    console.error('Failed to get token after 3 attempts.');
    return;
  }

  const url = `${HUB_WS_URL_BASE}?token=${encodeURIComponent(token)}`;
  ws = new WebSocket(url);

  let pingInterval;

  ws.on('open', () => {
    console.error(`Connected to hub at ${HUB_PORT}`);
    
    // Send hello frame
    ws.send(JSON.stringify({
      v: 1,
      type: 'hello',
      clientName: 'mcp-client',
      clientVersion: '2.0.0',
      pid: process.pid
    }));

    pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ v: 1, type: 'ping' }));
      }
    }, 20000);
  });

  ws.on('message', (data) => {
    try {
      const frame = JSON.parse(data.toString());
      if (frame.type === 'welcome') {
        console.error('Received welcome from hub:', frame);
      } else if (frame.type === 'result') {
        const pending = pendingCalls.get(frame.rid);
        if (pending) {
          clearTimeout(pending.timeout);
          pendingCalls.delete(frame.rid);
          if (frame.ok) {
            pending.resolve(frame);
          } else {
            pending.reject(frame);
          }
        }
      } else if (frame.type === 'event') {
        console.error('Event from hub:', frame.event, frame.data);
      } else if (frame.type === 'error') {
        console.error('Error from hub:', frame);
      }
    } catch (err) {
      console.error('Failed to parse message from hub:', err);
    }
  });

  ws.on('error', (err) => {
    console.error(`Hub connection error (attempt ${attempt}):`, err.message);
  });

  ws.on('close', () => {
    clearInterval(pingInterval);
    if (!isShuttingDown) {
      if (attempt === 1) {
        console.error('Hub disconnected. Spawning hub and reconnecting...');
        spawnHub();
      }
      if (attempt <= 3) {
        const backoff = 1000 * Math.pow(2, attempt);
        console.error(`Reconnecting in ${backoff}ms...`);
        setTimeout(() => connectHub(attempt + 1), backoff);
      } else {
        console.error('Max reconnection attempts reached.');
      }
    }
  });
}

function formatResult(data) {
  if (data && typeof data === 'object' && data.type === 'image') {
    return [{
      type: 'image',
      data: data.data,
      mimeType: data.mimeType || 'image/png'
    }];
  }

  const jsonStr = data === undefined ? 'null' : JSON.stringify(data);
  let text = jsonStr;
  
  if (text.length > 102400) { // 100KB governor
    text = text.substring(0, 102400) + '\n\n...[Truncated: Result exceeded 100KB]';
  }

  return [{
    type: 'text',
    text: text
  }];
}

server.setRequestHandler('tools/call', async (request) => {
  const { name, arguments: args } = request.params;
  
  const tool = TOOLS.find(t => t.name === name);
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }

  // validateParams should throw on invalid arguments
  if (typeof validateParams === 'function') {
    try {
      validateParams(tool, args);
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Bad params: ${err.message}` }]
      };
    }
  }

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return {
      isError: true,
      content: [{ type: 'text', text: 'Not connected to ApexAgent hub' }]
    };
  }

  const rid = nextRid++;
  const timeoutMs = args.timeoutMs || 30000;

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingCalls.delete(rid);
      ws.send(JSON.stringify({ v: 1, type: 'cancel', rid }));
      resolve({
        isError: true,
        content: [{ type: 'text', text: 'Tool call timed out' }]
      });
    }, timeoutMs);

    pendingCalls.set(rid, {
      timeout,
      resolve: (frame) => {
        resolve({
          content: formatResult(frame.data)
        });
      },
      reject: (frame) => {
        resolve({
          isError: true,
          content: [{
            type: 'text',
            text: JSON.stringify(frame.error || frame)
          }]
        });
      }
    });

    ws.send(JSON.stringify({
      v: 1,
      type: 'call',
      rid,
      tool: name,
      params: args,
      timeoutMs
    }));
  });
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('MCP server started on stdio');
  
  connectHub(1);

  process.stdin.on('close', () => {
    console.error('Stdin closed, shutting down...');
    isShuttingDown = true;
    if (ws) {
      ws.close();
    }
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
