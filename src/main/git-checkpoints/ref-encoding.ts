// ref-encoding.ts — deterministic ref names for the Lares checkpoint + recovery
// namespaces (Git-Native WP-G1.3a). MAIN-PROCESS ONLY, but pure — no git exec,
// no fs (the one git touch, `check-ref-format`, is an injected seam).
//
// Two namespaces share one encoding scheme:
//
//   checkpoint  refs/lares/checkpoints/<enc(ws)>/<enc(agent)>/<enc(turn)>/{before|after}
//   recovery    refs/lares/recovery/<enc(ws)>/<enc(op)>/pre
//
// Each EXTERNAL id component (workspaceId / agentId / turnId / operationId) is
// encoded with **base64url** before assembly. base64url's alphabet (A–Z a–z 0–9
// `-` `_`, no padding) is entirely ref-safe: it can never introduce a `/`, a
// `..`, a `.lock` suffix, an `@{`, whitespace, or an ASCII control — the shapes
// `git check-ref-format` rejects. Encoding is a pure function of the ids, so a
// ref round-trips (encode→decode) and reconciliation (WP-G1.8) can regenerate
// the exact same name from the same ids.
//
// `<agentId>` MUST come from launch identity, never a cwd/slug (invariant #4 —
// many agents share one working directory); this module just encodes whatever
// id it is handed.

const CHECKPOINTS_PREFIX = 'refs/lares/checkpoints';
const RECOVERY_PREFIX = 'refs/lares/recovery';

export type CheckpointEdge = 'before' | 'after';

export interface CheckpointRefParts {
  workspaceId: string;
  agentId: string;
  turnId: string;
  edge: CheckpointEdge;
}

export interface RecoveryRefParts {
  workspaceId: string;
  operationId: string;
}

/** base64url-encode one id component (UTF-8 bytes, no padding). */
export function encodeIdComponent(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url');
}

/** Inverse of {@link encodeIdComponent}. Returns null if the token is not
 *  syntactically base64url (defensive — a hand-mangled ref never throws). */
export function decodeIdComponent(token: string): string | null {
  // base64url alphabet only; reject anything else rather than let Buffer coerce.
  if (token.length === 0 || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    // Round-trip guard: a token that does not re-encode to itself was not a
    // canonical base64url encoding of its bytes (e.g. trailing junk bits).
    if (encodeIdComponent(decoded) !== token) return null;
    return decoded;
  } catch {
    return null;
  }
}

/** Assemble the checkpoint ref for a turn edge. Pure + deterministic. */
export function checkpointRef(parts: CheckpointRefParts): string {
  const ws = encodeIdComponent(parts.workspaceId);
  const agent = encodeIdComponent(parts.agentId);
  const turn = encodeIdComponent(parts.turnId);
  return `${CHECKPOINTS_PREFIX}/${ws}/${agent}/${turn}/${parts.edge}`;
}

/** Assemble the recovery `pre` ref for an operation. Pure + deterministic. */
export function recoveryRef(parts: RecoveryRefParts): string {
  const ws = encodeIdComponent(parts.workspaceId);
  const op = encodeIdComponent(parts.operationId);
  return `${RECOVERY_PREFIX}/${ws}/${op}/pre`;
}

/** Decode a checkpoint ref back to its ids, or null if it is not one. */
export function parseCheckpointRef(ref: string): CheckpointRefParts | null {
  if (!ref.startsWith(`${CHECKPOINTS_PREFIX}/`)) return null;
  const rest = ref.slice(CHECKPOINTS_PREFIX.length + 1).split('/');
  if (rest.length !== 4) return null;
  const [wsTok, agentTok, turnTok, edge] = rest;
  if (edge !== 'before' && edge !== 'after') return null;
  const workspaceId = decodeIdComponent(wsTok);
  const agentId = decodeIdComponent(agentTok);
  const turnId = decodeIdComponent(turnTok);
  if (workspaceId === null || agentId === null || turnId === null) return null;
  return { workspaceId, agentId, turnId, edge };
}

/** Decode a recovery `pre` ref back to its ids, or null if it is not one. */
export function parseRecoveryRef(ref: string): RecoveryRefParts | null {
  if (!ref.startsWith(`${RECOVERY_PREFIX}/`)) return null;
  const rest = ref.slice(RECOVERY_PREFIX.length + 1).split('/');
  if (rest.length !== 3) return null;
  const [wsTok, opTok, tail] = rest;
  if (tail !== 'pre') return null;
  const workspaceId = decodeIdComponent(wsTok);
  const operationId = decodeIdComponent(opTok);
  if (workspaceId === null || operationId === null) return null;
  return { workspaceId, operationId };
}

/** The minimal shape of a git runner this validator needs — the injectable
 *  seam. Callers bind it to `runGit(cwd, args, { allowNonzero, gitExe, … })`;
 *  tests pass a fake. Only stdout/code/stderr are consulted. */
export type RefFormatRunner = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface RefFormatResult {
  valid: boolean;
  /** The canonical form git printed on stdout (trimmed) when valid, else null. */
  normalized: string | null;
}

/**
 * Validate a COMPLETE assembled ref with `git check-ref-format --normalize`.
 * Exit 0 → valid, stdout carries the normalized name; any non-zero → invalid.
 * The runner MUST tolerate a non-zero exit (bind runGit with `allowNonzero`),
 * since an invalid ref is a normal, non-throwing outcome here.
 */
export async function validateRefFormat(ref: string, run: RefFormatRunner): Promise<RefFormatResult> {
  const res = await run(['check-ref-format', '--normalize', ref]);
  if (res.code === 0) {
    return { valid: true, normalized: res.stdout.trim() };
  }
  return { valid: false, normalized: null };
}
