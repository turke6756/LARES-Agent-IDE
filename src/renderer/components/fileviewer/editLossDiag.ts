/**
 * DIAG(edit-loss): shared diagnostic helper for the markdown-editor edit-loss
 * investigation (plans/markdown-editor-edit-loss-implementation.md §0.1,
 * plans/markdown-editor-edit-loss-diagnosis.md §5.5).
 *
 * Phase 0 instrumentation only — no behavior. Call sites across
 * MilkdownEditor / FileContentArea / useFileContentCache / dashboard-store are
 * tagged `// DIAG(edit-loss):` so Phase 5 can find and prune them.
 *
 * Logging rules (normative):
 *  - content is NEVER logged raw — always `diagHash(...)` (contentHash);
 *  - paths are logged as basename only (`diagBasename`);
 *  - every line carries one global monotonic `seq` (renderer-wide ordering)
 *    plus `Date.now()` for correlating with main-process logs.
 */
import { contentHash } from './markdownSplice';

// Single module-level monotonic sequence counter — global ordering across all
// DIAG call sites in this renderer.
let seq = 0;

// Per-mount generation counter for editor mounts (lives here so remounts are
// globally numbered even across different tabs/components).
let mountGeneration = 0;

/** Next editor mount generation — called once per MilkdownEditor mount effect. */
export function nextEditorMountGeneration(): number {
  mountGeneration += 1;
  return mountGeneration;
}

function diagEnabled(): boolean {
  // Dev builds always log; production only with the opt-in flag so a user can
  // arm the diagnostics (`localStorage.setItem('diagEditLoss', '1')`) while
  // chasing a live repro.
  try {
    if (import.meta.env?.DEV) return true;
  } catch {
    // no vite env (plain node) — fall through to the localStorage gate
  }
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem('diagEditLoss') !== null;
  } catch {
    return false;
  }
}

/** Hash-for-logging: content never appears raw in a DIAG line. */
export function diagHash(content: string | null | undefined): string | null {
  if (content === null || content === undefined) return null;
  return contentHash(content);
}

/** Basename-for-logging: full paths never appear in a DIAG line. */
export function diagBasename(p: string | null | undefined): string | null {
  if (!p) return p ?? null;
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
}

/**
 * Emit one DIAG line. No-op unless dev build or the `diagEditLoss`
 * localStorage flag is set.
 */
export function diag(tag: string, fields: Record<string, unknown>): void {
  if (!diagEnabled()) return;
  seq += 1;
  console.warn('[DIAG(edit-loss)]', seq, Date.now(), tag, fields);
}
