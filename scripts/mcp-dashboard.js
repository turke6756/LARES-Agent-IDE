#!/usr/bin/env node

/**
 * Parameterized MCP server for AgentDashboard.
 *
 * This runs as a stdio MCP server and exposes only the tool modules named in
 * DASHBOARD_MCP_TOOLSETS. Keep stdout reserved for MCP protocol; use stderr
 * for diagnostics.
 */

const http = require('http');
const fs = require('fs');
const readline = require('readline');

const API_PORT = parseInt(process.env.AGENT_DASHBOARD_API_PORT || '24678', 10);

function detectApiHost() {
  if (process.env.AGENT_DASHBOARD_API_HOST) return process.env.AGENT_DASHBOARD_API_HOST;
  // Detect WSL2 by checking for /proc/version containing Microsoft/WSL
  try {
    const procVersion = fs.readFileSync('/proc/version', 'utf-8');
    if (/microsoft|wsl/i.test(procVersion)) {
      const resolv = fs.readFileSync('/etc/resolv.conf', 'utf-8');
      const match = resolv.match(/nameserver\s+(\d+\.\d+\.\d+\.\d+)/);
      if (match) {
        console.error(`[mcp-dashboard] WSL detected, using Windows host IP: ${match[1]}`);
        return match[1];
      }
    }
  } catch { /* not WSL or can't read - fall through */ }
  return '127.0.0.1';
}

const API_HOST = detectApiHost();
const API_BASE = `http://${API_HOST}:${API_PORT}`;

function requireApiToken() {
  const token = process.env.AGENT_DASHBOARD_API_TOKEN;
  if (!token) {
    console.error('[mcp-dashboard] FATAL: AGENT_DASHBOARD_API_TOKEN env var is required (set by the dashboard at launch)');
    process.exit(1);
  }
  return token;
}

function createApiRequest(apiToken) {
  return function apiRequest(method, path, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, API_BASE);
      const opts = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiToken}`,
        },
      };

      const req = http.request(opts, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode >= 400) {
              reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
            } else {
              resolve(parsed);
            }
          } catch {
            reject(new Error(`Invalid JSON from API: ${data.substring(0, 200)}`));
          }
        });
      });

      req.on('error', (err) => {
        reject(new Error(`Dashboard API unreachable (${API_BASE}): ${err.message}`));
      });

      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  };
}

const TOOLSET_REGISTRY = {
  orchestration: () => {
    const mod = require('./mcp-tools-orchestration');
    return {
      getToolDefinitions: mod.getOrchestrationToolDefinitions,
      handleToolCall: mod.handleOrchestrationToolCall,
    };
  },
  teams: () => {
    const mod = require('./mcp-tools-teams');
    return {
      getToolDefinitions: mod.getTeamsToolDefinitions,
      handleToolCall: mod.handleTeamsToolCall,
    };
  },
  comms: () => {
    const mod = require('./mcp-tools-comms');
    return {
      getToolDefinitions: mod.getCommsToolDefinitions,
      handleToolCall: mod.handleCommsToolCall,
    };
  },
  observability: () => {
    const mod = require('./mcp-tools-observability');
    return {
      getToolDefinitions: mod.getObservabilityToolDefinitions,
      handleToolCall: mod.handleObservabilityToolCall,
    };
  },
  notebooks: () => {
    const mod = require('./mcp-tools-notebooks');
    return {
      getToolDefinitions: mod.getNotebooksToolDefinitions,
      handleToolCall: mod.handleNotebooksToolCall,
    };
  },
  browser: () => {
    const mod = require('./mcp-browser-tools');
    return {
      getToolDefinitions: mod.getBrowserToolDefinitions,
      handleToolCall: mod.handleBrowserToolCall,
    };
  },
  // Open-only "pull up a page for the human" toolset for the supervisor +
  // worker lanes — a single forHuman open tool, no readback, no act tools.
  'browser-present': () => {
    const mod = require('./mcp-browser-present-tools');
    return {
      getToolDefinitions: mod.getBrowserPresentToolDefinitions,
      handleToolCall: mod.handleBrowserPresentToolCall,
    };
  },
};

let grantedModules;

function getGrantedToolsetNames() {
  return (process.env.DASHBOARD_MCP_TOOLSETS || '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
}

function getGrantedModules() {
  if (grantedModules) return grantedModules;
  grantedModules = [];
  for (const name of getGrantedToolsetNames()) {
    const load = TOOLSET_REGISTRY[name];
    if (!load) {
      console.error(`[mcp-dashboard] Unknown DASHBOARD_MCP_TOOLSETS entry ignored: ${name}`);
      continue;
    }
    grantedModules.push({ name, ...load() });
  }
  return grantedModules;
}

function getToolDefinitions() {
  return getGrantedModules().flatMap((mod) => mod.getToolDefinitions());
}

async function handleToolCall(name, args, apiRequest) {
  for (const mod of getGrantedModules()) {
    const result = await mod.handleToolCall(name, args, apiRequest);
    if (result !== null) return result;
  }
  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
}

function sendResponse(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function sendResult(id, result) {
  sendResponse({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  sendResponse({ jsonrpc: '2.0', id, error: { code, message } });
}

function startMcpServer() {
  const apiRequest = createApiRequest(requireApiToken());
  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });

  rl.on('line', (line) => {
    if (!line.trim()) return;
    handleMessage(line, apiRequest);
  });

  console.error(`[mcp-dashboard] Started, API target: ${API_BASE}, toolsets: ${getGrantedToolsetNames().join(',') || '(none)'}`);
}

async function handleMessage(raw, apiRequest) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    console.error('[mcp] Failed to parse:', raw.substring(0, 100));
    return;
  }

  const { id, method, params } = msg;

  try {
    switch (method) {
      case 'initialize':
        sendResult(id, {
          protocolVersion: (params && params.protocolVersion) || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'agent-dashboard', version: '1.0.0' },
        });
        break;

      case 'notifications/initialized':
        // No response needed
        break;

      case 'tools/list':
        sendResult(id, { tools: getToolDefinitions() });
        break;

      case 'tools/call':
        try {
          const result = await handleToolCall(params.name, params.arguments || {}, apiRequest);
          sendResult(id, result);
        } catch (err) {
          sendResult(id, {
            content: [{ type: 'text', text: `Error: ${err.message}` }],
            isError: true,
          });
        }
        break;

      case 'ping':
        sendResult(id, {});
        break;

      default:
        if (id !== undefined) {
          sendError(id, -32601, `Method not found: ${method}`);
        }
    }
  } catch (err) {
    console.error(`[mcp] Error handling ${method}:`, err.message);
    if (id !== undefined) {
      sendError(id, -32603, err.message);
    }
  }
}

if (!process.env.DASHBOARD_MCP_NO_START) {
  startMcpServer();
}

module.exports = {
  getToolDefinitions,
  handleToolCall,
  getGrantedToolsetNames,
  getGrantedModules,
  createApiRequest,
};
