// graduation.ts — the `propose_graduation` write path (Memory & Lessons v2
// WP-F2). An agent that discovers a memory entry turned out to be PERMANENT (it
// belongs in the workspace-wide CLAUDE.md / AGENTS.md, not the days-to-weeks
// memory index) proposes graduating it. The proposal is RECORDED only — the
// human-side approve/apply IPC is WP-H3; this never mutates a target file.
//
// Security contract (plans/memory-lessons-v2-implementation.md §WP-F2):
//   1. The target is one of the TWO fixed workspace-root roots — `CLAUDE.md` or
//      `AGENTS.md`. ANY other target, and in particular ANY `.lares/**` path, is
//      rejected BEFORE touching disk (a graduation may never rewrite a managed
//      scaffold or memory file — those are not "always-true" workspace docs).
//   2. Capture `target_hash_at_proposal`: the sha256 of the target file's current
//      bytes, or the explicit `ABSENT` sentinel when the target does not yet
//      exist. WP-H3's apply step CAS-checks this so a proposal authored against a
//      since-changed target is caught.
//   3. `recordGraduation` (WP-B) persists the row `status='pending'` and returns
//      `{ proposal_id, status:'pending' }`.
//
// Workspace isolation is structural: the route resolves `workspaceRoot` SOLELY
// from the authenticated X-Workspace-Id header, so a proposal can only ever name
// a target inside the caller's own workspace root.

import crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { recordGraduation } from './review-store';

/** The explicit sentinel stored in `target_hash_at_proposal` when the target
 *  file does not exist at proposal time (distinct from a real hash so WP-H3 can
 *  tell "propose-to-create" from "propose-to-append"). */
export const ABSENT_TARGET_SENTINEL = 'ABSENT';

/** The only two graduation targets — workspace-root docs that bind everyone,
 *  always. A graduation NEVER targets a `.lares/**` path (managed scaffolds /
 *  memory), so the allow-list is exact and closed. */
export const GRADUATION_TARGETS: readonly string[] = ['CLAUDE.md', 'AGENTS.md'];

export type GraduationErrorCode = 'invalid_target' | 'invalid_text' | 'record_failed';

export interface ProposeGraduationInput {
  target: unknown;
  text: unknown;
  rationale: unknown;
}

export interface ProposeGraduationOk {
  ok: true;
  proposalId: string;
  status: 'pending';
}
export interface ProposeGraduationErr {
  ok: false;
  code: GraduationErrorCode;
  message: string;
}
export type ProposeGraduationResult = ProposeGraduationOk | ProposeGraduationErr;

function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

/**
 * Record a graduation proposal for `ws` under `workspaceRoot`. Never throws —
 * every failure path returns a structured `{ ok:false, code }`. `sourceAgent` is
 * the proposing agent's id (display/provenance only; may be null).
 */
export function proposeGraduation(
  ws: string,
  workspaceRoot: string,
  input: ProposeGraduationInput,
  sourceAgent: string | null,
): ProposeGraduationResult {
  // (1) Target must be EXACTLY one of the two fixed workspace-root roots. Reject
  // any other string BEFORE touching disk — this closes off `.lares/**` targets,
  // `..` traversal, absolute paths, and separators in one exact-match gate.
  const target = input?.target;
  if (typeof target !== 'string' || !GRADUATION_TARGETS.includes(target)) {
    return {
      ok: false,
      code: 'invalid_target',
      message: `graduation target must be one of ${GRADUATION_TARGETS.join(' / ')} (workspace-root docs); got ${String(target)}`,
    };
  }

  const text = input.text;
  const rationale = input.rationale;
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, code: 'invalid_text', message: 'graduation text is required' };
  }
  const rationaleStr = typeof rationale === 'string' ? rationale : '';

  // (2) Capture the target's current hash, or the ABSENT sentinel. The join is
  // safe: `target` is a bare validated basename, so it can only resolve to a file
  // directly under the workspace root.
  const targetPath = path.join(workspaceRoot, target);
  let targetHash: string;
  try {
    targetHash = sha256Hex(fs.readFileSync(targetPath, 'utf8'));
  } catch {
    targetHash = ABSENT_TARGET_SENTINEL;
  }

  // (3) Persist the pending row. A DB failure is surfaced structurally, never
  // thrown, so the MCP caller always gets a clean result envelope.
  const proposalId = `grad-${crypto.randomUUID()}`;
  try {
    const rec = recordGraduation(ws, {
      proposalId,
      target,
      targetHashAtProposal: targetHash,
      text,
      rationale: rationaleStr,
      sourceAgent,
    });
    return { ok: true, proposalId: rec.proposalId, status: 'pending' };
  } catch (err) {
    return {
      ok: false,
      code: 'record_failed',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
