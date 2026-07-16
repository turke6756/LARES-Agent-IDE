// Production wiring for the A6 ParseManager (wp2b §5). Assembles the non-Electron
// dependency bundle: the real filesystem scanner, an O(1) stat, and a best-effort
// known-skills set (for the slash-command secondary detection path). The Electron
// progress-push sink (`onProgress`) is layered on by the caller (ipc-handlers, where
// `mainWindow` lives) so this module stays free of the Electron surface and testable.
//
// mcp-toolset resolution (design §4.3): the reverse tool_name→toolset map is built
// from the SAME `ToolsetDefsProvider.defsFor(toolset)` that P1 (context-overhead)
// sizes toolsets with, so a logged `mcp__agent-dashboard__<t>` populates
// `behavior_events.mcp_toolset`. Unresolved `mcp__…` names stay NULL ("unknown MCP
// tool"). This feeds the WP2 flagship per-lane orchestration histogram.

import fs from 'fs';
import {
  resolveProjectsDirs,
  listJsonlStreams,
  readNewLines,
  type StreamMeta,
} from './jsonl-scanner';
import { getDb, getWorkspaces } from '../database';
import { resolveWorkspaceForCwd, type WorkspaceLineage } from './workspace-lineage';
import { resolveWindowsHomeSubdir, resolveWslHomeSubdir } from '../supervisor/log-readers/types';
import { buildMcpToolsetReverseMap, type McpToolsetResolver } from './mcp-toolset-map';
import { makePlansAwareDefsProvider } from './plans-toolset-defs';
import { ParseManager, type ManagerDeps } from './parse-manager';
import type { ParseDb } from './parse-runner';

/** Built once from the P1 toolset defs; require()d scripts are module-cached. */
let mcpToolsetResolver: McpToolsetResolver | null = null;
function getMcpToolsetResolver(): McpToolsetResolver {
  if (!mcpToolsetResolver) {
    // L1.1: plans-aware provider so `plans` tool calls resolve to the `plans`
    // toolset instead of NULL (the base provider omits `plans`).
    mcpToolsetResolver = buildMcpToolsetReverseMap(makePlansAwareDefsProvider());
  }
  return mcpToolsetResolver;
}

/** Best-effort skill slugs from the resident skills dirs (dir names under .claude/skills). */
function scanKnownSkills(): Set<string> {
  const out = new Set<string>();
  const dirs = [resolveWindowsHomeSubdir('.claude/skills'), resolveWslHomeSubdir('.claude/skills')];
  for (const dir of dirs) {
    if (!dir) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (ent.isDirectory()) out.add(ent.name);
    }
  }
  return out;
}

/** The non-Electron half of ManagerDeps. Caller adds `onProgress` (renderer broadcast). */
export function createParseManagerDeps(): Omit<ManagerDeps, 'onProgress'> {
  return {
    db: getDb() as unknown as ParseDb,
    listStreams: (): StreamMeta[] => resolveProjectsDirs().flatMap((d) => listJsonlStreams(d)),
    readNewLines,
    statSize: (p: string): number => {
      try {
        return fs.statSync(p).size;
      } catch {
        return 0;
      }
    },
    knownSkills: scanKnownSkills(),
    resolveMcpToolset: (toolName: string): string | null => getMcpToolsetResolver().resolve(toolName),
    // WP-2B — fold a stream's launch cwd → its owning workspace. Reads the workspace
    // registry fresh per fold so a newly-created workspace is visible mid-run (the list
    // is tiny). Workspace-LEVEL only; the shared cwd invariant is honored by
    // resolveWorkspaceForCwd (unique-owner or null, never a per-agent guess).
    resolveWorkspaceLineage: (workingDir: string | null): WorkspaceLineage | null =>
      resolveWorkspaceForCwd(workingDir, getWorkspaces().map((w) => ({ id: w.id, path: w.path }))),
  };
}

// ── Process-wide shared ParseManager ──────────────────────────────────────────────
// A SINGLE instance is shared by BOTH the IPC panel path (ipc-handlers) and the
// MCP/HTTP read route (api-server → runSkillUsageForRequest). The manager guards
// against concurrent backfills via an instance-local `running` flag, so a second
// instance could kick a duplicate first-run backfill — sharing one instance makes
// that impossible. The renderer progress-push sink is layered on via
// `setParseManagerProgressSink` (ipc-handlers, where `mainWindow` lives) so this
// module stays free of the Electron surface.
let sharedParseManager: ParseManager | null = null;
let progressSink: NonNullable<ManagerDeps['onProgress']> | null = null;

/** Register the renderer progress-push sink onto the shared manager (idempotent). */
export function setParseManagerProgressSink(sink: NonNullable<ManagerDeps['onProgress']>): void {
  progressSink = sink;
}

/** The single process-wide ParseManager. Lazily built on first use so the corpus
 *  walk / cursor reads happen only when a panel or MCP read actually asks. */
export function getSharedParseManager(): ParseManager {
  if (!sharedParseManager) {
    sharedParseManager = new ParseManager({
      ...createParseManagerDeps(),
      onProgress: (p) => progressSink?.(p),
    });
  }
  return sharedParseManager;
}
