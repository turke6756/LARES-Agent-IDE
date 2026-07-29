// janitor-brief.ts — Memory & Lessons v2 janitor dispatch surface (WP-H2).
//
// TWO deterministic building blocks, plus one live adapter:
//   1. `renderJanitorBrief(input)` — a PURE, byte-deterministic markdown brief
//      from the durable review queue (WP-B `memory_review_queue`) + a lesson-firing
//      snapshot. Identical inputs → byte-identical output (stable sort, NO
//      timestamps / randomness in the body), so `memory:generateJanitorBrief`
//      returns the same bytes for the same queue state.
//   2. `classifyLessonFiring(...)` — PURE coverage guard: insufficient coverage
//      (corpus not fully ingested OR no reliable workspace attribution) yields
//      `coverage:'unavailable'` — an HONEST `evidence-unavailable`, NEVER a false
//      absence claim; only sufficient coverage classifies each lesson fired / not.
//   3. `assessLessonFiring(db, …)` — the live adapter: the coverage-guarded firing
//      query over `skill_invocations` via `SkillUsageQueries` (Claude
//      `.claude/projects` attribution only), feeding `classifyLessonFiring`.
//
// The brief is generated ONLY on explicit dispatch (the janitor is the USER's
// lever — plans/memory-lessons-v2-proposal.md §6); nothing here hooks the launch
// path, so a working supervisor is never auto-injected with janitor work.
//
//   npm run build:main
//   node dist/main/main/memory-index/janitor-brief.test.js

import { SkillUsageQueries, type QueryDb } from '../skill-analytics/queries';
import type { LessonRow, ReviewFindingRow } from './review-store';

/** The result of the coverage-guarded lesson-firing check. When
 *  `coverage:'unavailable'`, `fired` is empty and the brief prints an honest
 *  `evidence-unavailable` line rather than claiming any lesson unused. */
export interface LessonFiringResult {
  coverage: 'ok' | 'unavailable';
  /** lesson name → fired at least once (only meaningful when `coverage:'ok'`). */
  fired: Map<string, boolean>;
}

/** The coverage booleans the guard keys off — structurally satisfied by WP-B's
 *  `assessLessonEvidence` (`LessonEvidence`). */
export interface FiringCoverage {
  corpusComplete: boolean;
  attributionReliable: boolean;
}

/**
 * PURE coverage guard. Insufficient coverage → `evidence-unavailable` (no absence
 * claim). Otherwise each requested lesson name is classified fired / not-fired
 * against the observed firing set.
 */
export function classifyLessonFiring(
  lessonNames: string[],
  firedSkillNames: Set<string>,
  coverage: FiringCoverage,
): LessonFiringResult {
  if (!coverage.corpusComplete || !coverage.attributionReliable) {
    return { coverage: 'unavailable', fired: new Map() };
  }
  const fired = new Map<string, boolean>();
  for (const name of lessonNames) fired.set(name, firedSkillNames.has(name));
  return { coverage: 'ok', fired };
}

/**
 * Live firing query. The coverage guard runs FIRST — insufficient coverage skips
 * the DB scan entirely and returns `evidence-unavailable`. When coverage holds,
 * per-skill firing is read from `SkillUsageQueries` under the vetted `strict`
 * agents-join scope (Claude `.claude/projects` attribution only), then classified.
 */
export function assessLessonFiring(
  db: QueryDb,
  ws: string,
  lessonNames: string[],
  coverage: FiringCoverage,
): LessonFiringResult {
  if (!coverage.corpusComplete || !coverage.attributionReliable) {
    return { coverage: 'unavailable', fired: new Map() };
  }
  const res = new SkillUsageQueries(db).run({ workspaceId: ws, scopeMode: 'strict' });
  const firedSkillNames = new Set(res.mostUsed.filter((r) => r.count > 0).map((r) => r.skill));
  return classifyLessonFiring(lessonNames, firedSkillNames, coverage);
}

/** The deterministic inputs to the brief renderer. */
export interface JanitorBriefInput {
  /** The workspace's `pending` review-queue findings (WP-B). */
  pending: ReviewFindingRow[];
  /** The workspace's `active` lessons (for the firing lens). */
  lessons: LessonRow[];
  /** The lesson-firing snapshot (from `assessLessonFiring`). */
  firing: LessonFiringResult;
}

/** The store/query reads the brief generation needs (injected; production wires
 *  the live review-store + `assessLessonFiring`, tests pass fakes). */
export interface JanitorBriefDeps {
  listPending(ws: string): ReviewFindingRow[];
  listActiveLessons(ws: string): LessonRow[];
  assessFiring(ws: string, lessonNames: string[]): LessonFiringResult;
}

/** Honest, no-absence-claim line for insufficient firing coverage. */
export const EVIDENCE_UNAVAILABLE_LINE =
  "Firing evidence is unavailable: no matching invocation observed in Claude's " +
  '`.claude/projects` corpus (the parser ingests only that corpus; attribution and ' +
  'index completeness are not guaranteed). Treat no lesson as unused on this basis.';

// Presentation order for the queue section — a fixed rank so the brief is stable
// regardless of the store's row order. Unknown kinds sort last, then alphabetically.
const KIND_ORDER: Record<string, number> = {
  'hard-invalid': 0,
  'cap-pressure': 1,
  'stale-active': 2,
  'condition-review': 3,
  'never-recalled': 4,
  'never-fired': 5,
  'evidence-unavailable': 6,
};
function kindRank(k: string): number {
  return k in KIND_ORDER ? KIND_ORDER[k] : 100;
}

/**
 * Render the deterministic janitor brief. PURE — no I/O, no clock, no randomness.
 * Identical `input` → byte-identical output: the queue is stably sorted by
 * (kind rank, kind, entryId, findingId) and lessons by name; volatile timestamps
 * are never printed.
 */
export function renderJanitorBrief(input: JanitorBriefInput): string {
  const { pending, lessons, firing } = input;
  const lines: string[] = [];

  lines.push('# Memory index janitor brief');
  lines.push('');
  lines.push("You are dispatched to triage this workspace's memory index. This brief is");
  lines.push('generated from the durable review queue plus a fresh lesson-firing check.');
  lines.push('For every item below, decide **close / graduate / archive**, act, then run the');
  lines.push('validator. Pruning archives — never delete.');
  lines.push('');

  // ── Pending review queue ─────────────────────────────────────────────────
  lines.push(`## Pending review queue (${pending.length})`);
  lines.push('');
  if (pending.length === 0) {
    lines.push('_No pending findings._');
    lines.push('');
  } else {
    const sorted = [...pending].sort(
      (a, b) =>
        kindRank(a.kind) - kindRank(b.kind) ||
        a.kind.localeCompare(b.kind) ||
        (a.entryId ?? '').localeCompare(b.entryId ?? '') ||
        a.findingId.localeCompare(b.findingId),
    );
    let curKind = '';
    for (const f of sorted) {
      if (f.kind !== curKind) {
        curKind = f.kind;
        const n = sorted.filter((x) => x.kind === curKind).length;
        lines.push(`### ${curKind} (${n})`);
      }
      const target = f.entryId ?? '(whole index)';
      lines.push(`- \`${target}\` — ${f.reason ?? '(no reason recorded)'}`);
      if (f.exitCondition) lines.push(`  exit condition: ${f.exitCondition}`);
    }
    lines.push('');
  }

  // ── Lesson firing ────────────────────────────────────────────────────────
  lines.push('## Lesson firing');
  lines.push('');
  if (firing.coverage === 'unavailable') {
    lines.push(EVIDENCE_UNAVAILABLE_LINE);
    lines.push('');
  } else if (lessons.length === 0) {
    lines.push('_No active lessons registered._');
    lines.push('');
  } else {
    const names = [...new Set(lessons.map((l) => l.name))].sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      const fired = firing.fired.get(name) === true;
      lines.push(
        fired
          ? `- \`${name}\` — fired (invocation observed in Claude's \`.claude/projects\` corpus). Keep.`
          : `- \`${name}\` — never fired (no invocation observed in Claude's \`.claude/projects\` corpus; Claude-attributed only). Candidate to retire or graduate.`,
      );
    }
    lines.push('');
  }

  // ── Closing instructions ─────────────────────────────────────────────────
  lines.push('## When you finish');
  lines.push(
    '- Archive resolved loops, graduate anything permanent to CLAUDE.md/AGENTS.md via `propose_graduation`, and publish reusable know-how as a lesson via `publish_lesson`.',
  );
  lines.push('- Re-validate: `node .lares/scripts/memory-index.mjs validate <index>`.');
  lines.push('');

  return lines.join('\n');
}

/** Wire the injected reads into the deterministic renderer. */
export function generateJanitorBrief(deps: JanitorBriefDeps, ws: string): string {
  const pending = deps.listPending(ws);
  const lessons = deps.listActiveLessons(ws);
  const firing = deps.assessFiring(ws, lessons.map((l) => l.name));
  return renderJanitorBrief({ pending, lessons, firing });
}
