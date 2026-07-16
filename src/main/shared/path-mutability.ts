// Path-mutability classifier (base plan §3.1).
//
// Answers one question for a file path: how safe is it to propose editing this
// file? Consumed by Deliverable 1 (mutability badges on overhead source rows)
// and Deliverable 4 (capstone safety — never patch generated/scaffolded files).
// Pure: string-only, no fs, no Electron, no DB. Windows + POSIX paths.

export type MutabilityClass = 'user-owned' | 'scaffold-managed' | 'generated-vendor';

// A `.dashboard/**/.claude/skills/` tree: skill dirs the dashboard scaffolds
// from constants (SUPERVISOR_*_SKILL, worker templates) and re-writes on launch
// with content-hash migration. Editing one in place is not durable → managed.
const SCAFFOLD_SKILLS = /\/\.dashboard\/.*\/\.claude\/skills(\/|$)/;

// Plugin + cache + vendored trees are regenerated, never hand-authored. Checked
// BEFORE the user-owned catch-all so `~/.claude/plugins/**` classifies as vendor
// rather than falling through to the `~/.claude/**` → user-owned rule.
const GENERATED_VENDOR = /(^|\/)(node_modules|\.cache|caches)(\/|$)|\/plugins\//;

/** Classify how mutable (safe-to-edit) an absolute path is.
 *  - `scaffold-managed` — dashboard-scaffolded skill dirs under `.dashboard`.
 *  - `generated-vendor` — plugin/cache/vendored trees; propose editing the source, not the file.
 *  - `user-owned` — workspace `CLAUDE.md`, `~/.claude/**`, and anything else the user authored.
 *  Case-insensitive; tolerant of both `\\` and `/` separators. */
export function classifyPathMutability(absPath: string): MutabilityClass {
  const norm = absPath.replace(/\\/g, '/').toLowerCase();
  if (SCAFFOLD_SKILLS.test(norm)) return 'scaffold-managed';
  if (GENERATED_VENDOR.test(norm)) return 'generated-vendor';
  return 'user-owned';
}
