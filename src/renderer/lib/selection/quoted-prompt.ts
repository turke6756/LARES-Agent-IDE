// Re-export of the canonical [SELECTION COMMENT] prompt builder. The
// implementation was hoisted to src/shared/selection-prompt.ts (WP-P5-A) so
// the main-process `comments:send` path can build prompts next to the DB;
// this module exists only to keep renderer import paths stable.
export * from '../../../shared/selection-prompt';
