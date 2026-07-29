// skill-provisioning.ts — the ONE source of the lane/provider skill roots a
// `remember`-authored lesson (and the `remember` skill itself) is provisioned to
// (Memory & Lessons v2 WP-F1). The location set is WP-R's verified verdict
// (.lares/research/inbox/codex-agents-skills-discovery/2026-07-28.md): the
// PER-CWD set — Claude + Codex, supervisor + worker — because the shared
// workspace-root `.agents/skills/` only works when the workspace root is a git
// repo, so it is NOT relied on. Codex uses `.agents/skills/` (its discovery
// contract); Claude uses `.claude/skills/`.
//
// The publisher (publisher.ts) and the scaffold-map `remember` entries
// (supervisor/index.ts) both consume THESE constants so the two write paths can
// never target different locations.

/** The four verified lesson-skill roots (workspace-relative, trailing slash),
 *  one per lane/provider. WP-R proved preload + invocation for each. */
export const LESSON_SKILL_ROOTS: readonly string[] = [
  '.lares/supervisor/.claude/skills/',      // Claude supervisor lane
  '.lares/workers/claude/.claude/skills/',  // Claude worker lane
  '.lares/supervisor/.agents/skills/',      // Codex supervisor lane (provider='codex')
  '.lares/workers/codex/.agents/skills/',   // Codex worker lane
];

/** The workspace-relative `SKILL.md` paths a lesson/skill named `name` occupies
 *  across every provisioned root, in a stable order (LESSON_SKILL_ROOTS order).
 *  The slug MUST already be validated (LESSON_SLUG_GRAMMAR) by the caller — this
 *  does no validation and simply composes paths. */
export function lessonTargetRelPaths(name: string): string[] {
  return LESSON_SKILL_ROOTS.map((root) => `${root}${name}/SKILL.md`);
}

/** Reserved skill names a published lesson may NOT collide with: `remember`
 *  itself plus every skill Lares ships into a native/Codex lane. Publishing a
 *  lesson under one of these names is rejected before any path construction so a
 *  managed scaffold skill can never be shadowed by a dynamic lesson copy. */
export const SHIPPED_SKILL_NAMES: ReadonlySet<string> = new Set([
  'remember',
  'run-orchestration',
  'orchestration-spike',
  'context-analytics',
  'checkpoint-forensics',
  'create-persona',
  'read-comments',
]);

/** True iff `name` collides with a reserved/shipped skill name. */
export function isReservedSkillName(name: string): boolean {
  return SHIPPED_SKILL_NAMES.has(name);
}

/** Render a lesson's canonical `SKILL.md` bytes from its `name`, `description`,
 *  and `body`. The SAME bytes are written to every provisioned copy, so the
 *  canonical hash of this output is the cross-provider drift/repair key. The
 *  description is folded into a YAML block scalar so a multi-line trigger renders
 *  verbatim; the body follows the frontmatter. Deterministic (no timestamps) so
 *  the hash is stable across launches. */
export function buildLessonSkillContent(name: string, description: string, body: string): string {
  const indentedDesc = description
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => (line.length ? `  ${line}` : ''))
    .join('\n');
  const trimmedBody = body.replace(/\r\n/g, '\n').replace(/\s+$/, '');
  return `---\nname: ${name}\ndescription: >-\n${indentedDesc}\n---\n${trimmedBody}\n`;
}
