---
name: checkpoint-forensics
description: Forensic use of AgentDashboard turn checkpoints and per-agent file activities. Use when asked to gate, verify, or audit a worker turn; check whether the worker stayed in its briefed scope; recover overwritten, lost, or never-committed work; determine which agent changed a file before any commit exists; check checkpoint capture health or diagnose a capture outage; detect two agents editing the same file; reconstruct what happened after a context reset; or list, diff, restore, revert, or prune a dashboard checkpoint. Do NOT use for ordinary Git history (git log/blame on committed work), routine code review, generic file search, or undo/backup questions unrelated to AgentDashboard turns and checkpoints.
---

# Checkpoint forensics

Checkpoint evidence **supplements** worker testimony and Git — it never replaces
them. A turn checkpoint proves *server-observed tool activity*: which paths the
dashboard witnessed a turn touch, and (where the git-native engine is live) the
before/after bytes it snapshotted. It does **not** prove intent, correctness, or
sole authorship. Use it to corroborate or contradict a worker's own account and to
recover work — never as a lie detector.

## Evidence model

Three records of different reach, weakest-claim first:

1. **Raw git checkpoints** — the before/after snapshots. They give you a diff and
   recovery **only when both edges are ready and their refs still resolve**
   (retained, not pruned). A dead or pruned ref makes the diff unavailable; it does
   not prove nothing changed.
2. **`read_agent_files_touched`** — tool-call-derived app-DB activity, always on,
   but **agent/session-scoped, not turn-scoped**. Paths arrive in mixed
   absolute/relative forms and slash directions — **normalize to workspace-relative
   POSIX before any comparison**, or you get false misses and false dupes.
3. **`witnessedPaths`** — the per-turn join that `diff_turn.witnessed` scopes to.

`witnessed` is server-observed tool attribution, **not** an intent claim. A
shell-mediated change (a script that writes files) can appear **only** in `window`,
never in `witnessed`. And checkpoint history is *retained* history, not permanent —
retention and pruning bound how far back you can see.

| Field | Values | Read as |
|---|---|---|
| `beforeReady` / `afterReady` | bool | Both true + `failureReason==null` ⇒ usable pair. Either false ⇒ incomplete evidence. |
| `beforeQuality` | `guaranteed` \| `late` \| `degraded` \| `reconciled` | `late`/`reconciled` = weaker baseline timing even when ready; `degraded` = before-edge capture failed. |
| `afterQuality` | `hook` \| `terminal` \| `session-log` \| `idle-fallback` \| `none` \| `reconciled` | `none` = no usable completion edge (capture-off); `idle-fallback` = lower-fidelity completion, not capture-off by itself. |
| `failureReason` | string \| null | Non-null ⇒ capture incomplete for that turn; `oversized` ⇒ workspace scope exceeded the 256 MiB cap and capture was skipped. |

## Tool map

- **`list_checkpoints`** — paths-only, cheap. Filters `agent_id`, `file`, exclusive
  `since` (a `turnSeq` cursor), `sinceTime`, `limit` (1–200). Returns a **newest-N
  window ordered by `turnSeq` desc**; sort and compare on the `turnSeq` field, never
  on row position. `file:` is evaluated across retained matching rows and is the only
  older-history lens — still bounded by `limit` and retention.
- **`diff_turn`** — expensive full patch; two sections: `witnessed` (attributed to
  the turn) + `window` (raw `beforeOid..afterOid`, all paths, **unattributed**).
- **`read_agent_files_touched`** — cheap independent corroboration; `operation`
  filter (`write`/`create`/`read`), `current_only` = **session** scope, not turn scope.
- **`restore_paths`** — **immediate mutation**; restores the selected turn's
  **before-edge** bytes for a witnessed path subset. Returns `{ok, completedPaths,
  rejectedPaths, failures, contention, preRef}`. **A call that returns a *preview*
  instead of a completed result is a refusal, not a success** — the engine could not
  mint an anti-TOCTOU token (contention or stale state) and did **not** mutate. Never
  report a restore as done without checking `completedPaths`.
- **`revert_turn`** — **immediate mutation** over the whole witnessed set; same
  return shape as `restore_paths`.
- **`prune_checkpoints`** — irreversible deletion of recovery refs; **never** health
  maintenance.

## Cheap-to-expensive escalation

| Level | Action | Escalate when |
|---|---|---|
| 0 | Dispatch brief/event + `read_agent_chat(id, role:'assistant', limit:1)` | Claimed outcome unclear. |
| 1 | Tightly filtered `list_checkpoints`; read metadata, readiness, `failureReason`, paths | Identity ambiguous, paths unexpected, capture incomplete, or content matters. |
| 2 | Bounded `read_agent_files_touched` + read-only `git status --short` / `git diff --stat` | Git capture unavailable, or attribution needs corroboration. |
| 3 | `diff_turn` on ONE selected turn | Content correctness, lost lines, an unexpected path, window-only activity, or recovery is at issue. |
| 4 | `diff_turn` additional candidates, one at a time | The first candidate is demonstrably wrong/incomplete. |
| — mutate — | `restore_paths` / `revert_turn` | User authorized recovery **and** every target path is quiescent (see rollback recipe). |
| — delete — | `prune_checkpoints` | Explicit request only, with confirmation history becomes unrecoverable. |

Hard rule: **the prohibition is broad speculative patch retrieval — never `diff_turn`
every row of a broad list, never `limit:200` just because it's allowed. "One list +
one diff" is the default, but recovery may legitimately diff two or three *carefully
selected* candidates.** Stop at paths-only when the question is scope-compliance and
the row is healthy and unambiguous.

## Recipe A — Gate a worker turn

1. Best: capture a cursor *before* dispatch — `list_checkpoints({limit:1})`, save the
   top `turnSeq`; after the idle event, `list_checkpoints({agent_id, since:<seq>, limit:20})`.
2. No cursor: `agent_id` + conservative `sinceTime` + small `limit`; match on agent id,
   task label, timing, terminal status, expected paths. **Task label alone is
   insufficient** (labels repeat / can be null).
3. Require `beforeReady && afterReady && failureReason==null` before calling the pair
   complete. Report `beforeQuality`/`afterQuality` as timing/provenance modifiers when
   weaker (`late`, `idle-fallback`, `reconciled`).
4. Compare `witnessedPaths` to the brief: in-scope only ⇒ path gate passes; unexpected
   paths ⇒ `diff_turn` that turn only; expected edits but empty witnessed ⇒ **do not
   accuse** — check health, app-DB writes/creates, then `window`.
5. `diff_turn` only when content correctness is in scope or the path gate found an anomaly.
6. Return one verdict: `PASS — checkpoint-backed` · `PASS WITH ATTRIBUTION GAP —
   fallback evidence only` · `NEEDS CORRECTION — concrete scope/content defect` ·
   `INCONCLUSIVE — evidence unavailable/ambiguous`. A summary is testimony; conflicting
   evidence warrants investigation, not accusations of lying.

## Recipe B — Recover lost / overwritten never-committed content

1. Canonicalize the target to workspace-relative POSIX.
2. `list_checkpoints({file:"src/…", limit:50})` — the only older-history lens; a
   full/`truncated:false` result is **not** proof no older rows exist beyond the window.
3. Select candidates by time/agent/task/health before diffing.
4. **Restore semantics matter:** `restore_paths` restores the selected turn's
   **before-state**. To recover content an overwrite destroyed, select the **overwriting**
   turn and restore *its* before-edge (the good pre-overwrite bytes) — OR read the
   earlier authoring turn's `diff_turn.witnessed` and reconstruct the additions manually.
   Restoring the *earlier* turn would give an even older version.
5. Prefer non-mutating recovery: extract the lost lines from the patch and hand them
   (with the exact target path) to a corrective worker, or return them to the user.
6. Only on explicit restore request: run the rollback safety gate (Recipe F), then
   `restore_paths` with the **exact single path**. Never `revert_turn` to recover one file.
7. After mutation, inspect `completedPaths`, `rejectedPaths`, `failures`, `contention`,
   `preRef`. If the write was never witnessed, a known turn's `window` may still hold it.
   If neither turn nor file is findable because history predates the window, report the
   **API limitation** — do not claim the content never existed.

## Recipe C — Attribute a pre-commit change

1. `list_checkpoints({file:"src/…", limit:50})`; for each plausible row compare agent
   id, task, interval; diff only the strongest candidate.
2. Evidence grades: witnessed path + witnessed hunk ⇒ attributed to that turn; app-DB
   write/create ⇒ agent/session corroboration (not turn-specific); hunk **only in
   `window`** ⇒ unattributed, name no author; current git diff/blame ⇒ repo state, not
   pre-commit attribution.
3. Corroborate with `read_agent_files_touched` (`operation:'write'` then `'create'`,
   bounded `limit`); normalize paths before joining.
4. Report "server witnessed agent X's turn write path Y," never "X authored every byte"
   or "X intended this." **Never assume one-agent-per-cwd** — many agents share one
   working directory and one Claude slug by design; attribution comes from the witnessed
   set + activity rows, never from "there's only one agent here."

## Recipe D — Check capture health

- Per turn, complete = `beforeReady && afterReady && failureReason==null`, qualities
  interpreted not ignored. An `open` turn with `afterReady:false` is merely unfinished.
- Workspace scan: read a small recent page across agents; inspect consecutive terminal
  rows for readiness, quality, repeated `failureReason`. Consecutive `oversized`
  failures ⇒ capture is workspace-wide OFF (256 MiB scope cap; classic cause: a large
  tree moved *out* from under a `.gitignore` rule — the 2026-07-27 `release/` →
  `release.stale-*` rename that moved 1.3 GiB and disabled capture ~9.5 h; the only
  trace was `failureReason`).
- Do **not** call the workspace healthy because an older row succeeded — recovery is a
  *later* completed both-edges row. Do **not** launch a token-burning probe turn just to
  test health; use the next natural turn. An empty `witnessedPaths` is never itself a
  health result. Root-causing the scope blowout is out of the supervisor's lane — surface
  it to the human or a worker.

## Recipe E — Detect contention

1. Bounded recent query (`sinceTime`) or `file:` for a known contested path.
2. Normalize paths, intersect `witnessedPaths` across **different** agents.
3. Overlap test: `A.startedAt <= B.endedAt-or-now && B.startedAt <= A.endedAt-or-now`.
   Same canonical path + different agents + overlapping intervals ⇒ witnessed
   contention. Same path, non-overlapping ⇒ sequencing/handoff, not contention.
4. For active agents corroborate with `list_agents` + bounded current-session activity.
   `restore_paths`/`revert_turn` also **return** `contention` (auto-detected from open
   turns) — read it, but **never call a mutation just to probe contention** (it mutates).
5. A worker file appearing only in another turn's `window` is *possible* unresolved
   contention, not attribution — search `file:`-filtered rows for other witnessed writers.
6. Resolution is serialize (brief one, hold the other), **not** rollback.

## Recipe F — Roll back safely (the destructive path)

1. Rollback is last resort — a corrective follow-up turn almost always beats it and
   never destroys a peer's uncommitted work.
2. Gate is **path-specific, not "no live agents":** for each target path require no open
   or overlapping turn AND no newer witnessed turn; inspect current file/`git` state for
   uncommitted divergence. (No live agents does **not** protect newer dirty work left by
   a finished agent or the human; an unrelated agent editing other files does **not**
   block a one-path restore.)
3. Use the **smallest exact path subset**. Prefer `restore_paths` (named paths) over
   `revert_turn` (whole witnessed set — a much higher bar).
4. Treat the call as immediate; after it, inspect `ok/completedPaths/rejectedPaths/
   failures/contention/preRef`. **A returned *preview* means the restore was refused and
   did NOT happen** (no anti-TOCTOU token could be minted — contention or stale state);
   it is not a success, so re-establish quiescence and retry rather than reporting the
   path restored.

## Do not infer

- Empty witnessed ≠ dishonesty (nothing-touched OR capture-off).
- `window` additions ≠ the selected agent's by default.
- One unfiltered page ≠ oldest history / absence; `since` cannot page backward.
- `file:` is exact canonical-path matching, still retention/limit-bound;
  `truncated:false` addresses MCP byte truncation, not undisclosed older SQL rows.
- Repeated/null task labels can't identify a turn alone.
- App-DB activity is agent/session evidence, not exact turn attribution; mixed path
  spellings cause false misses/dupes — normalize.
- Interval overlap suggests contention, not proven harmful interference.
- A pruned/dead ref makes a diff unavailable without proving no change occurred.
- A checkpoint is not a commit; git blame cannot solve uncommitted attribution.
- Patches may be large/sensitive — never fetch speculatively or reproduce unrelated hunks.
- `restore_paths` can overwrite newer uncommitted work on a path; `revert_turn` is unsafe
  when any witnessed file has later/concurrent work; `prune_checkpoints` is never outage
  remediation and is irreversible.
