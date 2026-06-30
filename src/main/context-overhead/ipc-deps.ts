// Context-Overhead Analyzer — impure dependency wiring (plan §2.5).
//
// The ONLY impure place for the analyzer: builds the synchronous FileReader (fs
// for windows / wsl.exe for WSL), the js-tiktoken cl100k encoder (once), the
// dashboard ToolsetDefsProvider (require()s the CommonJS scripts/), the global
// MCP provider (reads ~/.claude.json), resolves personas + the managed-policy
// path, and runs the pure analyzer. The IPC handler is a thin try/catch around
// runOverheadScan().

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import type { OverheadModel, PathType } from '../../shared/types';
import { getScriptPath } from '../supervisor/paths';
import { scanPersonas } from '../persona-scanner';
import { getWorkspace } from '../database';
import { TokenEstimator } from './token-estimator';
import { buildMcpInventory, type GlobalMcpProvider, type ToolsetDefsProvider } from './mcp-tool-inventory';
import { analyzeOverhead, type FileReader } from './context-overhead-analyzer';

const READ_CAP = 1024 * 1024; // 1MB per file — overhead files are small
const WSL_TIMEOUT = 8000;

// ── encoder ───────────────────────────────────────────────────────────────────

/** Build the cl100k_base encoder once. Returns undefined when js-tiktoken can't
 *  load → the estimator falls back to the chars-heuristic. */
function buildEncoder(): ((t: string) => number) | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getEncoding } = require('js-tiktoken');
    const enc = getEncoding('cl100k_base');
    return (t: string) => enc.encode(t).length;
  } catch (err) {
    console.error('[context-overhead] js-tiktoken unavailable, using chars-heuristic:', err instanceof Error ? err.message : err);
    return undefined;
  }
}

// ── WSL helpers ─────────────────────────────────────────────────────────────--

function wslExec(args: string, opts: { maxBuffer?: number } = {}): string | null {
  try {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.ELECTRON_RUN_AS_NODE;
    const out = execFileSync('wsl.exe', ['bash', '-lc', args], {
      encoding: 'utf-8',
      timeout: WSL_TIMEOUT,
      maxBuffer: opts.maxBuffer ?? READ_CAP + 4096,
      env,
    });
    return typeof out === 'string' ? out : String(out);
  } catch {
    return null;
  }
}

// Allow `*` (needed for globs) but reject shell metacharacters.
const SHELL_UNSAFE = /[$`;&|<>()]/;
function wslSafe(p: string): boolean {
  return !SHELL_UNSAFE.test(p);
}

// ── windows glob (single-level `*` per segment) ───────────────────────────────

function expandGlobWindows(pattern: string): string[] {
  const parts = pattern.replace(/\\/g, '/').split('/');
  let results = [parts[0] || '/'];
  for (let i = 1; i < parts.length; i++) {
    const seg = parts[i];
    if (seg === '') continue;
    const next: string[] = [];
    for (const base of results) {
      const dir = /^[a-zA-Z]:$/.test(base) ? `${base}/` : base;
      if (seg.includes('*')) {
        const re = new RegExp(
          '^' + seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
        );
        try {
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (re.test(e.name)) next.push(`${base}/${e.name}`);
          }
        } catch { /* dir missing */ }
      } else {
        next.push(`${base}/${seg}`);
      }
    }
    results = next;
  }
  return results.filter((p) => {
    try { return fs.existsSync(p); } catch { return false; }
  });
}

// ── FileReader ─────────────────────────────────────────────────────────────---

function makeFileReader(pathType: PathType): FileReader {
  const cache = new Map<string, { content: string; bytes: number } | null>();

  if (pathType === 'wsl') {
    return {
      read(absPath) {
        if (cache.has(absPath)) return cache.get(absPath)!;
        let result: { content: string; bytes: number } | null = null;
        if (wslSafe(absPath)) {
          const out = wslExec(`cat '${absPath}' 2>/dev/null`);
          if (out !== null && out.length > 0) {
            result = { content: out, bytes: Buffer.byteLength(out, 'utf8') };
          } else if (out !== null && this.exists(absPath)) {
            result = { content: '', bytes: 0 }; // empty but present
          }
        }
        cache.set(absPath, result);
        return result;
      },
      exists(absPath) {
        if (!wslSafe(absPath)) return false;
        return wslExec(`test -e '${absPath}' && echo y || true`)?.trim() === 'y';
      },
      listFiles(dirGlob) {
        if (!wslSafe(dirGlob)) return [];
        const out = wslExec(`bash -c 'shopt -s nullglob; for f in ${dirGlob}; do echo "$f"; done'`);
        return out ? out.split('\n').map((l) => l.trim()).filter(Boolean) : [];
      },
    };
  }

  // windows
  return {
    read(absPath) {
      if (cache.has(absPath)) return cache.get(absPath)!;
      let result: { content: string; bytes: number } | null = null;
      try {
        const stat = fs.statSync(absPath);
        if (stat.isFile() && stat.size <= READ_CAP) {
          const content = fs.readFileSync(absPath, 'utf-8');
          result = { content, bytes: Buffer.byteLength(content, 'utf8') };
        }
      } catch { /* missing/unreadable */ }
      cache.set(absPath, result);
      return result;
    },
    exists(absPath) {
      try { return fs.existsSync(absPath); } catch { return false; }
    },
    listFiles(dirGlob) {
      return expandGlobWindows(dirGlob);
    },
  };
}

// ── ToolsetDefsProvider (require CommonJS scripts/) ─────────────────────────--

const TOOLSET_SCRIPT_MAP: Record<string, { script: string; fn: string }> = {
  orchestration: { script: 'mcp-tools-orchestration.js', fn: 'getOrchestrationToolDefinitions' },
  teams: { script: 'mcp-tools-teams.js', fn: 'getTeamsToolDefinitions' },
  comms: { script: 'mcp-tools-comms.js', fn: 'getCommsToolDefinitions' },
  observability: { script: 'mcp-tools-observability.js', fn: 'getObservabilityToolDefinitions' },
  notebooks: { script: 'mcp-tools-notebooks.js', fn: 'getNotebooksToolDefinitions' },
  browser: { script: 'mcp-browser-tools.js', fn: 'getBrowserToolDefinitions' },
  'browser-present': { script: 'mcp-browser-present-tools.js', fn: 'getBrowserPresentToolDefinitions' },
};

function makeToolsetDefsProvider(): ToolsetDefsProvider {
  return {
    defsFor(toolset) {
      const entry = TOOLSET_SCRIPT_MAP[toolset];
      if (!entry) return null;
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require(getScriptPath(entry.script));
        const defs = mod[entry.fn]?.();
        if (!Array.isArray(defs)) return null;
        return defs.map((d: { name: string; description?: string; inputSchema?: unknown }) => ({
          name: d.name,
          description: d.description ?? '',
          inputSchema: d.inputSchema ?? {},
        }));
      } catch (err) {
        console.error(`[context-overhead] failed to load toolset '${toolset}':`, err instanceof Error ? err.message : err);
        return null;
      }
    },
    scriptPathFor(toolset) {
      const entry = TOOLSET_SCRIPT_MAP[toolset];
      return entry ? getScriptPath(entry.script) : null;
    },
  };
}

// ── GlobalMcpProvider (~/.claude.json) ────────────────────────────────────────

function resolveUserHome(pathType: PathType): string {
  if (pathType === 'wsl') {
    return wslExec('echo "$HOME"')?.trim() || '/root';
  }
  return process.env.USERPROFILE || process.env.HOME || '';
}

function makeGlobalMcpProvider(pathType: PathType, userHome: string): GlobalMcpProvider {
  return {
    list() {
      let raw: string | null = null;
      let configPath: string;
      if (pathType === 'wsl') {
        configPath = `${userHome}/.claude.json`;
        raw = wslExec('cat "$HOME/.claude.json" 2>/dev/null || true', { maxBuffer: 64 * 1024 * 1024 });
      } else {
        configPath = path.join(userHome, '.claude.json');
        try { raw = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf-8') : null; } catch { raw = null; }
      }
      if (!raw || !raw.trim()) return [];
      try {
        const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
        const servers = parsed.mcpServers ?? {};
        return Object.keys(servers).map((name) => ({ name, configPath }));
      } catch {
        return [];
      }
    },
  };
}

function managedPolicyPathFor(pathType: PathType): string | null {
  return pathType === 'wsl'
    ? '/etc/claude-code/CLAUDE.md'
    : 'C:\\Program Files\\ClaudeCode\\CLAUDE.md';
}

// ── public entry ──────────────────────────────────────────────────────────────

/** Resolve the workspace, assemble deps, run the pure analyzer, stamp
 *  generatedAt. Throws on a missing workspace (the handler turns it into the
 *  error variant of the discriminated result). */
export function runOverheadScan(workspaceId: string): OverheadModel {
  const ws = getWorkspace(workspaceId);
  if (!ws) throw new Error(`Workspace not found: ${workspaceId}`);
  const pathType = ws.pathType;
  const workspaceRoot = ws.path;

  const reader = makeFileReader(pathType);
  const estimator = new TokenEstimator({ encoder: buildEncoder() });
  const userHome = resolveUserHome(pathType);
  const mcpInventory = buildMcpInventory(estimator, makeToolsetDefsProvider(), makeGlobalMcpProvider(pathType, userHome));
  const personas = scanPersonas(workspaceRoot, pathType);

  const model = analyzeOverhead(workspaceId, workspaceRoot, pathType, {
    reader,
    estimator,
    mcpInventory,
    personas,
    env: process.env,
    userHome,
    managedPolicyPath: managedPolicyPathFor(pathType),
    additionalDirs: undefined, // workspace --add-dir is already an ancestor (deduped)
  });

  return { ...model, generatedAt: new Date().toISOString() };
}
