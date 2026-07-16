import path from 'path';
import { createHash } from 'crypto';
import type { ToolUseEvent } from '../../shared/session-events';
import type { PlanSectionTouchInput } from '../database';
import { parseApplyPatch } from '../supervisor/codex-shell-parser';

/**
 * WP2 provenance spine — transcript-side breadcrumb capture (R2 §2.3).
 *
 * `observeToolUse` runs inside `event-bridge.ts`'s `case 'tool-use':` handler,
 * BEFORE the status-latch call. It persists two kinds of trusted turn evidence:
 *
 *   1. **Read = intent.** Plan read tools (`read_plan_section`, `list_plan_sections`,
 *      `read_plan_projection`) — matched by *suffix* so both Claude's
 *      `mcp__agent-dashboard__…` prefix and Codex's bare name hit.
 *   2. **Native edit targets.** `Edit` / `MultiEdit` / `Write` (Claude) and
 *      `apply_patch` (Codex) — the ONLY capture path for native edits (they never
 *      reach the MCP handler). The anchor is left UNRESOLVED here (a pending
 *      sentinel); mapping the stored `old_string` / hunk material to a real anchor
 *      is a derived attribution done at Stop by the resolver (§2.5).
 *
 * Trust framing (§0): the capture step records only *trusted facts* ("an Edit
 * with this old_string fired"). It is deliberately tolerant — an unknown tool is
 * a no-op and malformed input is skipped; it NEVER throws (mirrors
 * `file-activity-tracker.ts`).
 */

/** Sentinel `section_anchor` for a native edit whose target anchor is not yet
 *  resolved. The Stop-time resolver replaces it by matching `resolve_payload`
 *  against pre-edit section byte ranges (§2.5, WP4). */
export const PENDING_EDIT_ANCHOR = '__pending_edit__';

/** Sentinel `section_anchor` for an orientation read (`list_plan_sections`, or an
 *  anchorless whole-plan read). The resolver ignores these for targeting but they
 *  remain useful history (§2.2). */
export const ORIENTATION_ANCHOR = '*';

const READ_TOOL_SUFFIXES = ['read_plan_section', 'list_plan_sections', 'read_plan_projection'] as const;
type ReadToolName = (typeof READ_TOOL_SUFFIXES)[number];

/** Native edit tool → the `tool` vocabulary value stored on the touch row. */
const CLAUDE_EDIT_TOOLS: Record<string, 'edit' | 'write'> = {
  Edit: 'edit',
  MultiEdit: 'edit',
  Write: 'write',
};

export interface PlanTouchTrackerDeps {
  /** Frozen `agents.plan_id`, or null when the agent has no plan rail. */
  getAgentPlanId(agentId: string): string | null;
  /** Absolute filesystem path of a plan's HTML file (for native-edit path match). */
  getPlanPath(planId: string): string | null;
  /** Record a breadcrumb (deduped in the DB helper). */
  recordPlanSectionTouch(input: PlanSectionTouchInput): string | null;
}

export class PlanTouchTracker {
  constructor(private readonly deps: PlanTouchTrackerDeps) {}

  /** Persist plan-scoped tool calls as trusted turn evidence. Never throws. */
  observeToolUse(agentId: string, ev: ToolUseEvent): void {
    try {
      if (!ev || typeof ev.toolName !== 'string') return;
      const readTool = matchReadTool(ev.toolName);
      if (readTool) {
        this.recordRead(agentId, ev, readTool);
        return;
      }
      this.recordEdit(agentId, ev);
    } catch {
      // Tolerant by contract — a capture failure must never break the status latch.
    }
  }

  // ── Reads (intent) ───────────────────────────────────────────────────────
  private recordRead(agentId: string, ev: ToolUseEvent, tool: ReadToolName): void {
    const input = asObject(ev.input);
    // Malformed (present-but-non-object) input is skipped, not silently recorded
    // as an orientation touch via the plan-id fallback (§0 tolerance contract).
    if (input === null && ev.input != null) return;
    const planId = firstString(input, ['plan_id', 'planId', 'plan']) ?? this.deps.getAgentPlanId(agentId);
    if (!planId) return; // cannot attribute a read with no plan in hand

    // list_plan_sections is always an orientation read; a read_plan_section /
    // read_plan_projection with no anchor is likewise orientation.
    const anchor = firstString(input, ['anchor', 'section_anchor', 'sectionAnchor']);
    const sectionAnchor = tool === 'list_plan_sections' || !anchor ? ORIENTATION_ANCHOR : anchor;
    const blockAnchor = firstString(input, ['block_anchor', 'blockAnchor']);
    const readMode = firstString(input, ['mode', 'read_mode', 'readMode']);

    this.deps.recordPlanSectionTouch({
      agentId,
      planId,
      sectionAnchor,
      blockAnchor: blockAnchor ?? null,
      tool,
      kind: 'read',
      readMode: readMode ?? null,
      source: 'transcript',
      toolUseId: ev.toolUseId ?? null,
    });
  }

  // ── Native edits (edit-target) ───────────────────────────────────────────
  private recordEdit(agentId: string, ev: ToolUseEvent): void {
    const planId = this.deps.getAgentPlanId(agentId);
    if (!planId) return; // no plan rail → nothing to attribute
    const planPath = this.deps.getPlanPath(planId);

    const claudeTool = CLAUDE_EDIT_TOOLS[ev.toolName];
    if (claudeTool) {
      this.recordClaudeEdit(agentId, ev, planId, planPath, claudeTool);
      return;
    }
    if (ev.toolName === 'apply_patch' || ev.toolName.endsWith('apply_patch')) {
      this.recordCodexEdit(agentId, ev, planId, planPath);
    }
  }

  private recordClaudeEdit(
    agentId: string,
    ev: ToolUseEvent,
    planId: string,
    planPath: string | null,
    tool: 'edit' | 'write',
  ): void {
    const input = asObject(ev.input);
    const filePath = firstString(input, ['file_path', 'filePath', 'path']);
    if (!filePath || !isPlanFile(filePath, planPath)) return;

    // Native Edit carries a byte-exact `old_string`; MultiEdit an `edits[]` list;
    // Write a full body. Store enough to resolve to an anchor at Stop (§2.3).
    const editStrings: string[] = [];
    const single = firstString(input, ['old_string', 'oldString']);
    if (single) editStrings.push(single);
    const edits = input?.edits;
    if (Array.isArray(edits)) {
      for (const e of edits) {
        const s = firstString(asObject(e), ['old_string', 'oldString']);
        if (s) editStrings.push(s);
      }
    }
    const content = firstString(input, ['content']); // Write: whole-file body

    const resolvePayload = JSON.stringify({
      provider: 'claude',
      tool: ev.toolName,
      filePath,
      // byte-exact fragments the resolver matches against pre-edit section ranges
      editWindows: editStrings.map(slice),
      contentSample: content ? slice(content) : undefined,
    });

    this.deps.recordPlanSectionTouch({
      agentId,
      planId,
      sectionAnchor: PENDING_EDIT_ANCHOR,
      blockAnchor: null,
      tool,
      kind: 'edit-target',
      source: 'transcript',
      toolUseId: ev.toolUseId ?? null,
      resolvePayload,
    });
  }

  private recordCodexEdit(
    agentId: string,
    ev: ToolUseEvent,
    planId: string,
    planPath: string | null,
  ): void {
    const input = asObject(ev.input);
    const patchText = firstString(input, ['input', 'patch']);
    if (!patchText) return;
    const workdir = firstString(input, ['workdir']) ?? '';

    // parseApplyPatch resolves the patch's target file paths (absolute) + op.
    let targets: { filePath: string; operation: string }[] = [];
    try {
      targets = parseApplyPatch(patchText, workdir);
    } catch {
      targets = [];
    }
    const planTargets = targets.filter((t) => isPlanFile(t.filePath, planPath));
    if (planTargets.length === 0) return;

    for (const t of planTargets) {
      const resolvePayload = JSON.stringify({
        provider: 'codex',
        tool: 'apply_patch',
        filePath: t.filePath,
        // hunk context for byte-range matching at Stop
        hunkContext: extractHunkContext(patchText, t.filePath),
      });
      this.deps.recordPlanSectionTouch({
        agentId,
        planId,
        sectionAnchor: PENDING_EDIT_ANCHOR,
        blockAnchor: null,
        tool: 'apply_patch',
        kind: 'edit-target',
        source: 'transcript',
        toolUseId: ev.toolUseId ?? null,
        resolvePayload,
      });
    }
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function matchReadTool(toolName: string): ReadToolName | null {
  for (const suffix of READ_TOOL_SUFFIXES) {
    if (toolName === suffix || toolName.endsWith(suffix)) return suffix;
  }
  return null;
}

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

function firstString(obj: Record<string, unknown> | null, keys: string[]): string | null {
  if (!obj) return null;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/** True when `filePath` is the dispatched plan file, or otherwise sits under a
 *  `plans/` directory segment (tolerant fallback when the agent edits a plan
 *  other than its dispatched one). */
function isPlanFile(filePath: string, planPath: string | null): boolean {
  const norm = filePath.replace(/\\/g, '/');
  if (planPath && norm === planPath.replace(/\\/g, '/')) return true;
  return /(^|\/)plans\//.test(norm);
}

/** Compact, resolver-friendly fingerprint of an edit fragment: a sha256 plus a
 *  bounded head/tail slice (the resolver matches these against section ranges). */
function slice(s: string): { hash: string; head: string; tail: string; length: number } {
  const N = 200;
  return {
    hash: createHash('sha256').update(s, 'utf8').digest('hex'),
    head: s.slice(0, N),
    tail: s.length > N ? s.slice(-N) : '',
    length: s.length,
  };
}

/** Pull the hunk-context lines for a given target out of an apply_patch envelope.
 *  Best-effort: returns the lines of the file's patch block (from its header to
 *  the next `*** ` header or EOF). */
function extractHunkContext(patchText: string, filePath: string): string {
  const base = path.basename(filePath);
  const lines = patchText.split('\n');
  const out: string[] = [];
  let capturing = false;
  for (const line of lines) {
    if (/^\*\*\*\s+(Update|Add|Delete) File:/.test(line)) {
      capturing = line.includes(base);
      continue;
    }
    if (capturing) out.push(line);
  }
  return out.join('\n').slice(0, 4000);
}
