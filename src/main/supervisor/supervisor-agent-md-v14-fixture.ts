// Frozen fragments for reconstructing the pristine v14 `.dashboard/supervisor/CLAUDE.md`
// from the shipped v15 constant.
//
// v15 teaches the supervisor persona about the continuation handoff it is the
// SUBJECT of (plans/continuation-handoff-feedback.md §4.6). The runtime note
// request still carries the attempt-specific instruction — the scaffold supplies
// the durable capability awareness, so a supervisor knows what
// `save_continuation_brick` is before the request arrives rather than meeting
// the tool for the first time under a 180 s deadline.
//
// Two clean ADDITIONS, so the reconstruction is two deletions:
//
//   1. the `save_continuation_brick` tool bullet, inserted between
//      `get_usage_limits` and `stop_agent`;
//   2. the `<!-- section:continuation-request v1 -->` sentinel block, appended
//      after the planning-surface block.
//
// The migration test undoes exactly these to rebuild v14 and pins the result to
// SUPERVISOR_AGENT_MD_V14_HASH, so drift in either the constant or these
// fragments fails loudly rather than silently `.bak`-ing real workspaces.

/** The whole v15 `save_continuation_brick` bullet line (including its trailing
 *  newline). Absent in v14. */
export const V15_CONTINUATION_BRICK_BULLET =
  '- **save_continuation_brick** — Write your continuation note when the dashboard '
  + 'asks for one (see "Automatic continuation request" below). Called by YOU, about '
  + 'yourself; no agent_id.\n';

/** The v15 continuation-request sentinel block, leading newline included.
 *  Matched as a regex in the test rather than pinned verbatim here — the block
 *  is prose and would be duplicated in two places. This exports only its
 *  delimiters so the test and the constant cannot disagree about them. */
export const V15_CONTINUATION_SECTION_OPEN = '<!-- section:continuation-request v1 -->';
export const V15_CONTINUATION_SECTION_CLOSE = '<!-- /section:continuation-request -->';
