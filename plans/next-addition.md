# Plan: Ascertain — Make transcript resolution explicit and testable

**Status:** Approved via GroupThink (Lead Planner + Reviewer), 2026-05-11.
**Scope:** Lift existing per-reader transcript resolution onto the `ChatLogReader` interface and split it into a pure finder, a read-only resolver, and a caching wrapper. Preserve all provider-specific correlation rules.

## Background

The `multi-provider-chat-rendering` branch (commits `62c1fa5`, `8e317dc`) introduced a `ChatLogReader` interface and split out a Claude reader, with Codex and Gemini readers also present. Each reader privately resolves an agent's session to an on-disk transcript using provider-specific rules:

- **Claude** — session-id match under `~/.claude/projects/<slug>/`.
- **Codex** — session-id match first, then cwd-validated newest-rollout fallback against `session_meta.cwd` (`codex-rollout-reader.ts:495`).
- **Gemini** — `.project_root` match plus `startedAt` ordering (`gemini-transcript-reader.ts:478`).

Resolution today is private and side-effecting (writes `resolvedPaths`). It is not directly testable in isolation and cannot be observed by diagnostics without triggering a poll.

## Goal

Expose transcript resolution on `ChatLogReader` as a read-only operation that **never** mutates reader state, while keeping a separate caching wrapper for the poll path. Preserve every existing provider-specific rule. No generic newest-by-mtime fallback.

## Non-goals

- Provider auto-detection from PID.
- Idle / working / awaiting-input status detection.
- A dispatcher-owned transcript-path cache.
- Renaming `SessionLogReader` → `SessionLogDispatcher`.
- A dispatcher pass-through `resolveTranscriptPath(agent)` — deferred until a concrete diagnostic/IPC consumer exists.
- Any change to `agent-chat-service.ts` — it already routes through the dispatcher.

## File-by-file edits

### 1. `src/main/supervisor/log-readers/types.ts`

Extend the `ChatLogReader` interface with:

```ts
/**
 * Returns the on-disk transcript path the reader would currently attach to
 * this session, or null if no candidate exists yet.
 *
 * Read-only: does NOT update offsets, partial-line buffers, or the
 * resolvedPaths cache. Safe to call from diagnostics. Subsequent
 * pollSession calls will re-resolve and update the cache.
 */
resolveTranscriptPath(session: ChatLogReaderSession): string | null;
```

Use the existing `ChatLogReaderSession` type — do not introduce a new `AgentRuntime` shape.

### 2. Per-reader refactor pattern (applies to all three readers below)

Each reader implements the following three-method pattern:

```ts
// PUBLIC — interface method. Read-only. No cache writes.
resolveTranscriptPath(session: ChatLogReaderSession): string | null {
  const cached = this.resolvedPaths.get(session.agentId);
  if (cached && fs.existsSync(cached)) return cached;
  return this.findTranscriptPath(session);
}

// PRIVATE — pure file-system search using provider-specific rules.
// No cache reads, no cache writes, no offset/partial-line state changes.
private findTranscriptPath(session: ChatLogReaderSession): string | null {
  // (lifted from each reader's existing private resolver)
}

// PRIVATE — caching wrapper. Used by pollSession only.
private getOrResolveTranscriptPath(session: ChatLogReaderSession): string | null {
  const found = this.resolveTranscriptPath(session);
  if (found) this.resolvedPaths.set(session.agentId, found);
  return found;
}
```

`pollSession` (and any other internal call site that currently calls the private resolver) MUST switch to `getOrResolveTranscriptPath`. The private finder is the only function that touches the file system for path discovery.

### 3. `src/main/supervisor/log-readers/claude-jsonl-reader.ts`

- Extract the existing private resolver body into `findTranscriptPath(session)`. Preserve the rule: match by Claude session id under `~/.claude/projects/<slug>/`. No newest-by-mtime fallback.
- Add `resolveTranscriptPath` and `getOrResolveTranscriptPath` per the pattern above.
- Update `pollSession` (and any other internal call sites) to call `getOrResolveTranscriptPath`.

### 4. `src/main/supervisor/log-readers/codex-rollout-reader.ts`

- Extract the existing private resolver body (around `codex-rollout-reader.ts:495`) into `findTranscriptPath`. Preserve order: session-id match wins; otherwise newest rollout whose `session_meta.cwd` matches the agent working directory. No global newest fallback.
- Add `resolveTranscriptPath` and `getOrResolveTranscriptPath` per the pattern.
- Update `pollSession` (and other internal call sites) to call `getOrResolveTranscriptPath`.

### 5. `src/main/supervisor/log-readers/gemini-transcript-reader.ts`

- Extract the existing private resolver body (around `gemini-transcript-reader.ts:478`) into `findTranscriptPath`. Preserve `.project_root` match plus `startedAt` ordering. Project-root mismatches are never returned.
- Add `resolveTranscriptPath` and `getOrResolveTranscriptPath` per the pattern.
- Update `pollSession` (and other internal call sites) to call `getOrResolveTranscriptPath`.

### 6. Tests

Add cases to each reader's existing test file. Each new test must hit the public `resolveTranscriptPath` (NOT `findTranscriptPath` directly) and assert that calling it does NOT mutate `resolvedPaths`.

#### `src/main/supervisor/log-readers/claude-jsonl-reader.test.ts`
- (a) Fresh session, no transcript on disk → `resolveTranscriptPath` returns `null`.
- (b) Session id present, single matching `*.jsonl` → returns that path.
- (c) Session id present, no matching file → returns `null` (does NOT fall through to any newest-by-mtime).
- (d) Side-effect assertion: calling `resolveTranscriptPath` twice with no intervening poll does not populate `resolvedPaths`.

#### `src/main/supervisor/log-readers/codex-rollout-reader.test.ts`
- (a) Two rollouts present; one matches session id; session-id match wins even if the other is newer.
- (b) **No session id, two rollouts, only one with matching `session_meta.cwd` → cwd-matching candidate wins.** (Explicitly the case the Reviewer called out.)
- (c) No session id, no cwd match among any rollout → returns `null`.
- (d) Side-effect assertion: calling `resolveTranscriptPath` does not populate `resolvedPaths`.

#### `src/main/supervisor/log-readers/gemini-transcript-reader.test.ts`
- (a) `.project_root` match with a valid `startedAt` candidate → returns that path.
- (b) `.project_root` match exists but no `startedAt` candidate → returns `null`.
- (c) Only candidate has a mismatched project root → returns `null` (project-root mismatches are never returned).
- (d) Side-effect assertion: calling `resolveTranscriptPath` does not populate `resolvedPaths`.

Existing tests for `pollSession` must continue to pass unchanged — they verify the caching path through `getOrResolveTranscriptPath`.

## Acceptance criteria

1. `npm run build:main` succeeds.
2. All existing reader tests pass.
3. The new test cases above pass.
4. `grep`-able: the public `resolveTranscriptPath` exists on `ChatLogReader` in `types.ts` and is implemented by all three readers.
5. `grep`-able: no remaining direct callers of any reader's `findTranscriptPath` outside `getOrResolveTranscriptPath` and the public `resolveTranscriptPath`.
6. No new file under `src/main/supervisor/` other than (optionally) new test fixtures.
7. No changes to `agent-chat-service.ts`, `session-log-dispatcher.ts`, or any renderer code.

## Deferred (explicit follow-ups, not part of this change)

- Dispatcher pass-through `resolveTranscriptPath(agent: AgentRow)` that selects the reader by `agent.provider` and delegates. Land when a concrete diagnostic/IPC consumer materializes.
- Renaming `SessionLogReader` constructor type → `SessionLogDispatcher`.
- Provider auto-detection from PID (would build on this resolver but is a separate workstream).
- Idle/awaiting-input status detection (`docs/AGENT_STATUS_AND_INPUT_DETECTION.md`).

## Worker checklist (executable order)

1. Edit `types.ts` — add `resolveTranscriptPath` to the `ChatLogReader` interface with the docblock above.
2. Edit `claude-jsonl-reader.ts` — refactor into the three-method pattern; switch `pollSession` to `getOrResolveTranscriptPath`.
3. Edit `codex-rollout-reader.ts` — same.
4. Edit `gemini-transcript-reader.ts` — same.
5. Add the new test cases to each of the three `*.test.ts` files.
6. Run `npm run build:main` and the reader test files; iterate until green.
7. Verify acceptance criteria 4 and 5 with `grep`.


<!-- groupthink_members: 5adc2a84-cf27-402d-981e-f1ab300fe563, null -->
