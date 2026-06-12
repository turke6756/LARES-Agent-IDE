import { WebSocketServer, WebSocket } from 'ws';
import { AgentSupervisor } from './supervisor';
import { getWorkspaces, getAgentsByWorkspace } from './database';
import { detectPathType, windowsToWslPath, uncToWslPath } from './path-utils';
import { Agent, AgentStatus } from '../shared/types';
import { WS_PORT } from './control-ports';

const PING_INTERVAL_MS = 30_000;

interface ClientInfo {
  workspaceId: string;
  workspacePath: string;
}

interface HelloMessage {
  type: 'hello';
  workspacePath: string;
  extensionVersion: string;
}

interface TerminalClosedMessage {
  type: 'terminal_closed';
  agentId: string;
}

interface PongMessage {
  type: 'pong';
}

type ClientMessage = HelloMessage | TerminalClosedMessage | PongMessage;

function agentToWireFormat(agent: Agent) {
  return {
    id: agent.id,
    name: agent.title,
    status: agent.status,
    platform: detectPathType(agent.workingDirectory),
    tmuxSession: agent.tmuxSessionName || undefined,
  };
}

/**
 * Normalize a path to a comparable WSL-style path for matching.
 * Handles Windows paths (C:\...), UNC WSL paths (\\wsl.localhost\...), and native WSL paths (/...).
 * Also handles VS Code WSL remote paths that arrive with backslashes (e.g. \home\turke\...).
 */
function normalizePath(p: string): string {
  // VS Code WSL remote sends paths like "\home\turke\..." — backslash-mangled WSL paths.
  // Detect these: starts with \home, \root, \tmp, \usr, \var, \etc, \opt, \mnt, \srv
  if (/^\\(?:home|root|tmp|usr|var|etc|opt|mnt|srv)(?:\\|$)/i.test(p)) {
    return p.replace(/\\/g, '/').replace(/\/+$/, '');
  }

  const pathType = detectPathType(p);
  if (pathType === 'wsl') {
    // Could be a UNC path or a native WSL path
    if (p.startsWith('\\\\')) {
      return uncToWslPath(p).replace(/\/+$/, '');
    }
    return p.replace(/\/+$/, '');
  }
  // Windows path -> convert to WSL path for comparison
  return windowsToWslPath(p).replace(/\/+$/, '');
}

export class WsServer {
  private wss: WebSocketServer | null = null;
  private clients = new Map<WebSocket, ClientInfo>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private supervisor: AgentSupervisor;

  // Bound listeners for cleanup
  private onStatusChanged: (data: { agentId: string; status: AgentStatus; agent?: Agent }) => void;
  private onAgentDeleted: (data: { agentId: string }) => void;

  constructor(supervisor: AgentSupervisor) {
    this.supervisor = supervisor;

    this.onStatusChanged = (data) => this.handleStatusChanged(data);
    this.onAgentDeleted = (data) => this.handleAgentDeleted(data);
  }

  start(): void {
    this.wss = new WebSocketServer({ port: WS_PORT, host: '127.0.0.1' });

    this.wss.on('listening', () => {
      console.log(`[ws-server] Listening on ws://127.0.0.1:${WS_PORT}`);
    });

    this.wss.on('error', (err) => {
      console.error('[ws-server] Server error:', err.message);
    });

    this.wss.on('connection', (ws) => {
      console.log('[ws-server] Client connected');

      ws.on('message', (raw) => {
        try {
          const msg: ClientMessage = JSON.parse(raw.toString());
          this.handleMessage(ws, msg);
        } catch (err) {
          console.error('[ws-server] Bad message:', err);
        }
      });

      ws.on('close', () => {
        console.log('[ws-server] Client disconnected');
        this.clients.delete(ws);
      });

      ws.on('error', (err) => {
        console.error('[ws-server] Client error:', err.message);
        this.clients.delete(ws);
      });
    });

    // Ping/pong keepalive
    this.pingTimer = setInterval(() => {
      for (const [ws] of this.clients) {
        if (ws.readyState === WebSocket.OPEN) {
          this.send(ws, { type: 'ping' });
        }
      }
    }, PING_INTERVAL_MS);

    // Subscribe to supervisor events
    this.supervisor.on('statusChanged', this.onStatusChanged);
    this.supervisor.on('agentDeleted', this.onAgentDeleted);
  }

  stop(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }

    this.supervisor.off('statusChanged', this.onStatusChanged);
    this.supervisor.off('agentDeleted', this.onAgentDeleted);

    if (this.wss) {
      for (const [ws] of this.clients) {
        ws.close();
      }
      this.clients.clear();
      this.wss.close();
      this.wss = null;
      console.log('[ws-server] Stopped');
    }
  }

  private send(ws: WebSocket, data: object): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  private handleMessage(ws: WebSocket, msg: ClientMessage): void {
    switch (msg.type) {
      case 'hello':
        this.handleHello(ws, msg);
        break;
      case 'terminal_closed':
        // Client closed a terminal tab - no action needed on server side
        console.log(`[ws-server] Client closed terminal for agent ${msg.agentId}`);
        break;
      case 'pong':
        // Keepalive response, nothing to do
        break;
    }
  }

  private handleHello(ws: WebSocket, msg: HelloMessage): void {
    const normalizedClientPath = normalizePath(msg.workspacePath);
    console.log(`[ws-server] Hello from VS Code: ${msg.workspacePath} (normalized: ${normalizedClientPath})`);

    // Find matching workspace
    const workspaces = getWorkspaces();
    const match = workspaces.find((w) => {
      const normalizedWsPath = normalizePath(w.path);
      return normalizedWsPath === normalizedClientPath;
    });

    if (!match) {
      console.log('[ws-server] No matching workspace found');
      this.send(ws, { type: 'error', message: 'No matching workspace found' });
      return;
    }

    // Register client
    this.clients.set(ws, {
      workspaceId: match.id,
      workspacePath: normalizedClientPath,
    });

    // Send welcome
    this.send(ws, {
      type: 'welcome',
      workspaceId: match.id,
      workspaceTitle: match.title,
    });

    // Send current agents for this workspace
    const agents = getAgentsByWorkspace(match.id);
    const activeAgents = agents.filter(
      (a) => a.status !== 'done' && a.status !== 'crashed'
    );

    this.send(ws, {
      type: 'inject_terminals',
      workspaceId: match.id,
      agents: activeAgents.map(agentToWireFormat),
    });

    console.log(
      `[ws-server] Matched workspace "${match.title}" with ${activeAgents.length} active agents`
    );
  }

  private handleStatusChanged(data: { agentId: string; status: AgentStatus; agent?: Agent }): void {
    // Look up the agent to find its workspace
    const { getAgent } = require('./database');
    const agent: Agent | null = data.agent || getAgent(data.agentId);
    if (!agent) return;

    // Notify connected clients for this workspace
    for (const [ws, info] of this.clients) {
      if (info.workspaceId !== agent.workspaceId) continue;

      if (data.status === 'done' || data.status === 'crashed') {
        // Agent is no longer active
        this.send(ws, {
          type: 'agent_removed',
          agentId: data.agentId,
        });
      } else if (data.status === 'working' || data.status === 'launching') {
        // New or restarted agent - send full info
        this.send(ws, {
          type: 'agent_added',
          agent: agentToWireFormat(agent),
        });
      } else {
        // Status update (idle, waiting, restarting)
        this.send(ws, {
          type: 'agent_status_changed',
          agentId: data.agentId,
          status: data.status,
          name: agent.title,
        });
      }
    }
  }

  private handleAgentDeleted(data: { agentId: string }): void {
    for (const [ws] of this.clients) {
      this.send(ws, {
        type: 'agent_removed',
        agentId: data.agentId,
      });
    }
  }
}
