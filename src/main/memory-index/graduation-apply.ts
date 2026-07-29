// graduation-apply.ts — the ONLY graduation applier (Memory & Lessons v2 WP-H3).
//
// A graduation proposal (recorded by WP-F2's agent-callable `propose_graduation`)
// promotes a memory entry into a workspace-root doc — `CLAUDE.md` / `AGENTS.md`.
// Applying it is a HUMAN-ONLY act: it runs behind WP-H3's renderer-only IPC
// (`memory:graduationApprove`), which appears in NO MCP toolset and NO api-server
// route, so no agent can ever reach this write path.
//
// The apply contract (plans/memory-lessons-v2-implementation.md §WP-H3), executed
// under the workspace lock so concurrent proposals serialize:
//   1. Read the target and compare-and-swap on `target_hash_at_proposal`. A
//      mismatch (the doc changed since the proposal) → set the proposal
//      `needs-reapproval` with the new current hash surfaced, and DO NOT write.
//   2. Detect encoding: UTF-8 with an OPTIONAL BOM only, preserving the detected
//      LF/CRLF newline exactly. ANY other encoding → reject without writing.
//   3. Append `text` INSIDE the explicit managed markers
//      `<!-- lares:graduated-notes:start -->` … `<!-- lares:graduated-notes:end -->`.
//      An existing `## Graduated notes` heading WITHOUT the markers is user-owned
//      → conflict, no write. An ABSENT target (the proposal captured the ABSENT
//      sentinel) → create the file with ONLY the marked section. A symlink/ancestor
//      escape on the target → reject. Idempotent on an equal line.
//
//   npm run build:main
//   node dist/main/main/memory-index/graduation-apply.test.js

import crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { acquireWorkspaceLock } from '../scaffold-writer';
import {
  getGraduation,
  markGraduationNeedsReapproval,
  setGraduationStatus,
  type GraduationRow,
} from './review-store';
import { ABSENT_TARGET_SENTINEL, GRADUATION_TARGETS } from './graduation';

/** The managed markers the applier appends inside. Text between them is Lares-
 *  owned (append-only); anything else in the file is the human's. */
export const GRADUATED_NOTES_START = '<!-- lares:graduated-notes:start -->';
export const GRADUATED_NOTES_END = '<!-- lares:graduated-notes:end -->';
/** The section heading the applier writes ABOVE the markers when it creates the
 *  managed block. A file that carries this heading but NOT the markers is treated
 *  as user-owned (they hand-authored a "Graduated notes" section) → conflict. */
export const GRADUATED_NOTES_HEADING = '## Graduated notes';

export type GraduationApplyCode =
  | 'not_found' // unknown proposal id / workspace mismatch
  | 'not_applicable' // proposal already applied / rejected
  | 'invalid_target' // target is not one of the two fixed roots
  | 'needs_reapproval' // CAS mismatch — the live doc changed since the proposal
  | 'bad_encoding' // target is not UTF-8 (± BOM)
  | 'conflict' // an unmarked `## Graduated notes` heading is user-owned
  | 'symlink' // the target is a symlink
  | 'escape' // the target resolves outside the workspace root
  | 'write_error';

export interface GraduationApplyOk {
  ok: true;
  proposalId: string;
  target: string;
  /** false when the text was already present inside the managed block (idempotent
   *  no-op). true when a write occurred. */
  applied: boolean;
}
export interface GraduationApplyErr {
  ok: false;
  code: GraduationApplyCode;
  message: string;
  /** the current on-disk hash, surfaced on a `needs_reapproval` CAS mismatch. */
  currentHash?: string;
}
export type GraduationApplyResult = GraduationApplyOk | GraduationApplyErr;

/** The filesystem seam — real node fs in production, faked in tests so the
 *  symlink / escape / encoding reject paths are deterministic without needing OS
 *  symlink privileges. `readRaw` returns the RAW bytes (encoding detection needs
 *  them); `writeRaw` writes bytes verbatim (BOM/CRLF already baked in). */
export interface GraduationApplyFs {
  /** true iff the path exists AND is a symlink; false if it does not exist. */
  lstatIsSymlink(p: string): boolean;
  /** canonical real path; throws if the path does not exist. */
  realpath(p: string): string;
  /** raw file bytes, or null when the file does not exist. */
  readRaw(p: string): Buffer | null;
  /** overwrite the file with `bytes` (atomic tmp+rename). */
  writeRaw(p: string, bytes: Buffer): void;
}

export const nodeGraduationFs: GraduationApplyFs = {
  lstatIsSymlink(p) {
    try {
      return fs.lstatSync(p).isSymbolicLink();
    } catch {
      return false;
    }
  },
  realpath(p) {
    return fs.realpathSync(p);
  },
  readRaw(p) {
    try {
      return fs.readFileSync(p);
    } catch {
      return null;
    }
  },
  writeRaw(p, bytes) {
    const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, bytes);
    try {
      fs.renameSync(tmp, p);
    } catch {
      // Windows can refuse to rename over an open file — fall back to copy+unlink.
      fs.copyFileSync(tmp, p);
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* best-effort */
      }
    }
  },
};

function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

/** A buffer is valid UTF-8 (optionally BOM-prefixed) iff decoding it as UTF-8 and
 *  re-encoding round-trips to the identical bytes — Node substitutes U+FFFD for
 *  any invalid sequence, so a non-UTF-8 file (UTF-16, Latin-1 with high bytes,
 *  …) fails the round-trip and is rejected. A BOM decodes to U+FEFF and
 *  re-encodes to the same EF BB BF, so it round-trips and is preserved. */
export function isValidUtf8(buf: Buffer): boolean {
  return Buffer.from(buf.toString('utf8'), 'utf8').equals(buf);
}

/** Detected newline of `s` — CRLF if any `\r\n` is present, else LF. */
function detectNewline(s: string): '\r\n' | '\n' {
  return s.includes('\r\n') ? '\r\n' : '\n';
}

/** True iff `s` carries a `## Graduated notes` heading on its own line. */
function hasGraduatedHeading(s: string): boolean {
  return /^## Graduated notes[ \t]*$/m.test(s);
}

/**
 * Compute the new file content that appends `payload` inside the managed markers,
 * preserving the BOM (carried in `current`) and the detected newline. Returns the
 * new string, or `{ conflict: true }` when an unmarked `## Graduated notes`
 * heading makes the file user-owned, or `{ idempotent: true }` when `payload` is
 * already present inside the managed block. `current` is null for an absent
 * target (create-from-sentinel). PURE — no I/O — so it is unit-testable directly.
 */
export function composeGraduatedContent(
  current: string | null,
  payload: string,
):
  | { content: string; applied: true }
  | { idempotent: true }
  | { conflict: true } {
  const body = payload.replace(/^\r?\n+/, '').replace(/[ \t\r\n]+$/, '');

  // Absent target → create with ONLY the marked section (LF; nothing to detect).
  if (current === null) {
    const nl = '\n';
    const content = `${GRADUATED_NOTES_HEADING}${nl}${GRADUATED_NOTES_START}${nl}${body}${nl}${GRADUATED_NOTES_END}${nl}`;
    return { content, applied: true };
  }

  const nl = detectNewline(current);
  const startIdx = current.indexOf(GRADUATED_NOTES_START);
  const endIdx = current.indexOf(GRADUATED_NOTES_END);

  // Markers present → append inside them (idempotent on an equal line).
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const inner = current.slice(startIdx + GRADUATED_NOTES_START.length, endIdx);
    if (inner.includes(body)) return { idempotent: true };
    let before = current.slice(0, endIdx);
    if (!before.endsWith(nl)) before += nl;
    const content = `${before}${body}${nl}${current.slice(endIdx)}`;
    return { content, applied: true };
  }

  // A `## Graduated notes` heading with NO markers is user-owned → conflict.
  if (hasGraduatedHeading(current)) return { conflict: true };

  // Neither markers nor heading → append a fresh marked section at the end.
  let base = current;
  if (base.length > 0 && !base.endsWith(nl)) base += nl;
  const section = `${nl}${GRADUATED_NOTES_HEADING}${nl}${GRADUATED_NOTES_START}${nl}${body}${nl}${GRADUATED_NOTES_END}${nl}`;
  return { content: base + section, applied: true };
}

/** Reject a target that is a symlink, or whose parent resolves outside the
 *  workspace root (ancestor escape). Returns null when contained. Exported so the
 *  guard can be mutation-tested in isolation. */
export function containmentError(
  fsx: GraduationApplyFs,
  workDir: string,
  targetPath: string,
): 'symlink' | 'escape' | null {
  let realRoot: string;
  try {
    realRoot = fsx.realpath(workDir);
  } catch {
    return 'escape';
  }
  if (fsx.lstatIsSymlink(targetPath)) return 'symlink';
  let realParent: string;
  try {
    realParent = fsx.realpath(path.dirname(targetPath));
  } catch {
    return 'escape';
  }
  if (path.resolve(realParent) !== path.resolve(realRoot)) return 'escape';
  return null;
}

/** Statuses from which a proposal may still be applied (approved via the human
 *  IPC). `applied`/`rejected` are terminal; anything else is treated as pending. */
function isApplicable(status: string): boolean {
  return status !== 'applied' && status !== 'rejected';
}

/**
 * Apply an approved graduation proposal — the ONLY graduation write path. Never
 * throws; every failure returns a structured `{ ok:false, code }`. Runs the whole
 * read → CAS → encode-detect → marked-append under the workspace lock so
 * concurrent proposals serialize (the second re-approves against the first's
 * resulting hash). `workDir`/`pathType` are the workspace on-disk root + its write
 * dialect; `fsx` defaults to real node fs (tests inject a fake).
 */
export function applyGraduation(
  ws: string,
  workDir: string,
  pathType: string,
  proposalId: string,
  fsx: GraduationApplyFs = nodeGraduationFs,
  store: {
    getGraduation: (id: string) => GraduationRow | null;
    markGraduationNeedsReapproval: (id: string, hash: string) => void;
    setGraduationStatus: (id: string, status: string) => void;
  } = { getGraduation, markGraduationNeedsReapproval, setGraduationStatus },
): GraduationApplyResult {
  const proposal = store.getGraduation(proposalId);
  if (!proposal || proposal.workspaceId !== ws) {
    return { ok: false, code: 'not_found', message: `no graduation proposal ${proposalId} for this workspace` };
  }
  if (!isApplicable(proposal.status)) {
    return { ok: false, code: 'not_applicable', message: `proposal ${proposalId} is ${proposal.status}` };
  }
  // Defense in depth: the target must be EXACTLY one of the two fixed roots (the
  // propose path already enforced this; re-check before any path construction).
  if (!GRADUATION_TARGETS.includes(proposal.target)) {
    return { ok: false, code: 'invalid_target', message: `graduation target ${proposal.target} is not a workspace-root doc` };
  }
  if (typeof proposal.text !== 'string' || proposal.text.trim() === '') {
    return { ok: false, code: 'not_applicable', message: `proposal ${proposalId} has no text` };
  }

  const targetPath = path.join(workDir, proposal.target);
  const release = acquireWorkspaceLock(workDir, pathType);
  try {
    // (1) Symlink / ancestor-escape guard.
    const contain = containmentError(fsx, workDir, targetPath);
    if (contain) {
      return { ok: false, code: contain, message: `graduation target ${proposal.target} rejected: ${contain}` };
    }

    // (2) Read the current target + detect encoding. The CAS hash is computed the
    // SAME way `propose_graduation` captured it (sha256 of the UTF-8 decode) so
    // the two are directly comparable.
    const raw = fsx.readRaw(targetPath);
    let current: string | null;
    let currentHash: string;
    if (raw === null) {
      current = null;
      currentHash = ABSENT_TARGET_SENTINEL;
    } else {
      if (!isValidUtf8(raw)) {
        return { ok: false, code: 'bad_encoding', message: `graduation target ${proposal.target} is not UTF-8` };
      }
      current = raw.toString('utf8');
      currentHash = sha256Hex(current);
    }

    // (3) CAS on target_hash_at_proposal. A mismatch surfaces the new hash and
    // flips the proposal to needs-reapproval WITHOUT writing.
    if (currentHash !== proposal.targetHashAtProposal) {
      store.markGraduationNeedsReapproval(proposalId, currentHash);
      return {
        ok: false,
        code: 'needs_reapproval',
        message: `graduation target ${proposal.target} changed since the proposal; re-approval required`,
        currentHash,
      };
    }

    // (4) Compose the marked append (conflict / idempotent / write).
    const composed = composeGraduatedContent(current, proposal.text);
    if ('conflict' in composed) {
      return {
        ok: false,
        code: 'conflict',
        message: `${proposal.target} has a "## Graduated notes" heading without the managed markers (user-owned); refusing to write`,
      };
    }
    if ('idempotent' in composed) {
      store.setGraduationStatus(proposalId, 'applied');
      return { ok: true, proposalId, target: proposal.target, applied: false };
    }

    fsx.writeRaw(targetPath, Buffer.from(composed.content, 'utf8'));
    store.setGraduationStatus(proposalId, 'applied');
    return { ok: true, proposalId, target: proposal.target, applied: true };
  } catch (err) {
    return { ok: false, code: 'write_error', message: err instanceof Error ? err.message : String(err) };
  } finally {
    release();
  }
}
