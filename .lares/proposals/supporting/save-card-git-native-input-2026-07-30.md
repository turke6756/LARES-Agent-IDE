# Save-card: technical input from the checkpoint-engine lane (2026-07-30)

Author: supervisor "Git Native Work" (5d94254d). Grounded in a fresh source read of
`src/main/git-checkpoints/` (checkpoint-service.ts, retention.ts, witness-recorder.ts,
ref-encoding.ts) plus lived incidents from building and operating the engine.
Feeds Edward's Save-card proposal. No code was changed.

## (a) Feasibility on the current engine

Verdict: **feasible, and mostly a read-side + one new write-side module.** The engine
already stores everything the card needs to *display*; the genuinely new machinery is
the commit composer.

Reused as-is:
- `turn_records` — per-turn agentId, status, startedAt/endedAt, taskLabel, witnessed
  `touched[]` (repo-relative POSIX paths, write/create only), before/after snapshot
  OIDs + readiness flags, failureReason. Plan stamps (plan_id/plan_item_id, strategy
  §S1.B) slot straight in as one more grouping key.
- `refs/lares/checkpoints/<ws>/<agent>/<turn>/{before|after}` — byte-exact trees
  (raw `hash-object --no-filters` blobs) for any per-turn content reconstruction.
- `retention.ts decidePruneEdges(row, now, retentionMs)` — **pure**. Call it with a
  *future* `now` and you have the expiry forecaster for free (see d).
- The witnessed-vs-window diff machinery behind `diff_turn`.
- `file_activities` — the always-on fallback when checkpoint capture was off.
- GitInitConsent flow (G3.4) for the no-repo escalation rung.

Genuinely new:
1. **Bundle assembler** (pure, main-process): turn rows + plan stamps + ownership
   edges → units {owner/plan, turns, path-set, expiry horizon, attribution gaps}.
2. **Commit composer** — the first component EVER allowed to touch the real index.
   Everything in the engine is built around the invariant "never touch HEAD, the real
   index, or branch refs" (checkpoint-service.ts header, invariant #1). The composer
   deliberately breaks that invariant on the user's behalf; it must be a new module
   with its own safety review, not a mode of checkpoint-service.
3. Expiry forecaster + card IPC/renderer surface.

## (b) The hard problems (in honesty order)

**1. Overlapping paths across bundles is THE problem — not commit mechanics.**
On this shared tree, concurrent agents' witnessed sets intersect constantly
(constants.ts is a standing contention point; we had a live incident where a
concurrent workstream injected hunks into database.ts mid-commit-split). A file's
*current worktree bytes* are the superposition of every agent that touched it. Two
consequences:
- If bundle A and bundle B both witnessed `constants.ts`, committing A "from the
  worktree" ships B's hunks too. Hunk-level splitting is NOT safely automatable —
  when we did the 4-commit split it required deliberate blob surgery by a briefed
  worker, per file, with a byte-exact union check at the end.
- Recommendation: **bundle granularity = whole paths.** When path-sets overlap,
  either merge the bundles or make the user pick one bundle to carry the shared
  file (with an explicit "includes changes from N other agents" flag). Do not
  promise per-agent hunk attribution in commit CONTENT; put attribution in the
  commit MESSAGE (turn ids, agents, plan items).

**2. Worktree-bytes vs checkpoint-reconstruction — pick worktree, say why.**
Two possible sources for the committed content: (i) current worktree bytes of the
bundle's paths, or (ii) content reconstructed from the bundle turns' AFTER trees.
(ii) sounds more "faithful" but produces a commit whose tree matches no state the
user can see, interacts horribly with later turns' edits to the same file, and on
this engine after-trees are per-TURN, so a multi-turn bundle already needs a merge
across its own snapshots. **Commit what the user sees (worktree bytes), scoped to
the bundle's paths.** Checkpoints remain the audit trail, not the commit source.
(Exception worth keeping in the back pocket: reconstruct-from-checkpoint as a
recovery flow when the worktree has since regressed — that's `restore_paths`, which
already exists; the card can link to it rather than reimplement it.)

**3. The witnessed-vs-window gap will silently drop files from bundles.**
Witnessed = observed Edit/Write tool calls, normalized, write/create only
(witness-recorder.ts). Anything an agent produced via Bash — generated files,
`npm install` artifacts, script output, git operations — is NOT witnessed. A
witnessed-only bundle will omit real work. The card needs the window as a safety
net: per bundle, show "N changed paths in the tree are unattributed to any bundle"
and offer an explicit "unattributed changes" pseudo-bundle the user can inspect
and commit. Never pretend the witnessed union covers the tree — an empty witnessed
set means "we didn't see it," not "nothing changed" (capture can be off; see 6).

**4. Real-index safety.** The composer must handle:
- **Pre-existing staged content.** The user (or a foreign lane) may have things in
  the index already. Refuse to compose over a non-empty index, or snapshot it
  (`git stash create`-free: write the current index tree with `write-tree` to a
  recovery ref under `refs/lares/recovery/` first — the pattern already exists).
- **index.lock contention** with the user's own editor/git tooling. Bounded retry,
  loud failure, never delete a lock file.
- **Serialization with the engine.** Captures use a temp GIT_INDEX_FILE so they
  don't collide with the composer, but `restore_paths`/`revert_turn` MUTATE the
  worktree. A compose racing a restore is corruption. Run the composer through the
  existing per-object-db `CheckpointQueue` key so compose/capture/restore serialize.
- **Windows/CRLF (learned the hard way):** to stage bytes that must land exactly,
  never `git apply --cached`, never pipe `git show` (it smudges to CRLF). The
  working recipe in this repo: `hash-object -w` + `update-index --cacheinfo`, or
  `update-index -z --index-info` batches — with argv chunked to Windows
  command-line limits (checkpoint-service.ts step 4/5 already has this pattern
  ready to lift). For worktree-bytes commits this mostly disappears (plain
  `git add -- <paths>` respects the repo's own filters, which is correct), but any
  checkpoint-sourced staging MUST use the plumbing recipe.
- **User is the committer:** composer stages + drafts the message ONLY. The commit
  action fires from an explicit user click, with the user's git identity, standard
  hooks un-bypassed. Never auto-commit on a timer or on expiry.

**5. HEAD moves under you.** Foreign lanes commit while you're composing (happened
to us mid-split: base moved ba8b1a6 → 9f7af25). Capture the HEAD OID when the card
opens; before commit, re-verify; if moved, recompute the bundle diff rather than
committing a stale package. Never cache "ahead-of-origin" counts or diffs.

**6. Bundles must be honest about capture quality.** Turns with
`beforeReady:false / afterReady:false` (e.g. the 9.5-hour oversized outage) have
witnessed rows but no snapshots. Their work still exists in the tree and in
file_activities. The card should show these as "unverified" units — committable
(worktree bytes are still real) but flagged that no restore point backs them.

## (c) What "uncommitted work" should precisely mean

**`git status --porcelain -z` vs HEAD, at card-open time, scoped to the checkpoint
workspace scope: tracked modifications + untracked-non-ignored files. Not "vs last
user commit"** — on this tree agents also commit (when authorized), and HEAD is the
only boundary git itself enforces; anything fancier drifts. Ignored files never
appear (they're outside checkpoint scope too — same `enumerateScope` rules, which
keeps card and engine consistent). Bundle membership = witnessed paths ∩ dirty
paths; dirty paths matched by no bundle land in the "unattributed" pseudo-bundle.
A witnessed path that is no longer dirty (already committed or reverted) drops out
of the bundle display but keeps its checkpoints.

## (d) Expiry warnings — key off retention.ts reality

Facts to build on (verified in source today):
- Dense window: `RETENTION_DENSE_WINDOW_MS` = **10 days, provisional** (constants.ts:5057).
- After the window, `decidePruneEdges`: accepted turns keep ONLY the after edge;
  every other terminal turn loses BOTH edges. Open turns never prune.
- **Distill-before-prune:** `diff_stats` + a ≤100 KB `compact_diff` are persisted
  BEFORE any ref deletion. So expiry does not erase all evidence — it erases
  byte-exact RESTORE-ability. Word the warning accordingly: "restore points
  expire," not "your work is deleted."
- The pass runs per-turn, best-effort, on a schedule; eligibility is pure age+status.

Forecast: for each bundle turn, remaining = `(endedAt ?? startedAt) + retentionMs − now`;
bundle expiry = min over member turns whose paths are STILL dirty vs HEAD (once a
path is committed, its restore points going away is no longer a loss worth an
alarm). Warn at a threshold (48h feels right for a 10-day window), escalate per the
P1 ladder already filed in plans/checkpoint-surface-proposals.md: no repo → offer
git init; repo + dirty → "commit to make permanent"; committed, no remote → gentle
nudge only. Compute the forecast with `decidePruneEdges(row, now + horizon,
retentionMs)` — reusing the exact production predicate means the warning can never
disagree with what retention will actually do.

## (e) Architecture sketch + build order

New modules (all under src/main/git-checkpoints/ or a sibling save-card/):
1. `bundle-assembler.ts` — pure. Inputs: turn rows, dirty-path set, plan stamps,
   ownership edges. Output: bundles + overlap report + unattributed set + expiry
   horizons. 100% unit-testable, zero git.
2. `commit-composer.ts` — the only real-index writer. Precondition checks (clean
   index or recovery-ref snapshot, HEAD pin, no restore in flight), stage via
   `git add -- <paths>` (chunked), draft message from turn/plan metadata, expose
   `composeStatus` for the UI. Runs under CheckpointQueue.
3. `save-card-ipc.ts` — mirror checkpoint-ipc.ts patterns; renderer card is a peer
   of the Plans pane.

Build order (each stage shippable alone):
- **Stage 1 (read-only card):** assembler + IPC + renderer list of bundles with
  dirty paths, capture quality, overlap flags. Zero risk, immediately useful, and
  it forces the bundle semantics to get real before any index writes exist.
- **Stage 2:** expiry forecaster + warnings (still read-only) — this IS proposal P1,
  subsumed.
- **Stage 3:** composer (stage + user-click commit), single-bundle only, refuse on
  overlap.
- **Stage 4:** overlap resolution UX + plan_id grouping once S1.B stamps exist.

## (f) Traps for a naive implementer

- `git show`/`git apply --cached` CRLF smudge on Windows — use the blob-plumbing
  recipe (see b4). This destroyed an early commit-split attempt here.
- Empty witnessed set ≠ "agent did nothing" — capture may have been off (oversized
  outage) or work was shell-mediated. Gate on beforeReady/afterReady/failureReason.
- `list_checkpoints`-style unfiltered reads return the newest window only; bundle
  assembly must page deliberately or query by file — positional reads lie.
- Retention keeps the AFTER edge of accepted turns only — a bundle UI that promises
  "restore any member turn" is wrong the day a bundle crosses the 10-day line.
- Foreign commits mid-compose (b5) — pin and re-verify HEAD; never trust a
  remembered base.
- The repo root currently contains untracked junk dirs with invalid-char names
  (`agentdash-codex-wsl-*`) — enumeration/status code must tolerate paths that
  Windows APIs choke on.
- Don't reach for `git checkout/restore/clean/stash` anywhere in the composer's
  failure paths — the workspace has a whole guard-hook workstream because exactly
  that class of "cleanup" destroyed uncommitted work once already. Corrective
  staging only.
- Scaffold docs: if the card changes what supervisors should tell workers about
  committing, that guidance ships via constants.ts version bumps, not local edits
  (local persona edits get clobbered by scaffold refresh).
