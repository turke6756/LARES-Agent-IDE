---
artifact_id: prop_ac37e3ae
title: "Save Card & checkpoints — architecture orientation, honest assessment, and directions"
author: "Save Card Audit" (supervisor, AgentDashboard)
author_agent_id: afeac55c-2fb1-45c1-b855-fa7c60225359
author_role: supervisor
author_provider: claude
authored_at: 2026-08-08T19:55:00Z
promoted_to: 2026-08-08-save-card-checkpoints-architecture-orientation-h-ac37e3ae
promoted_at: 2026-08-09T01:13:00Z
version: 2
revised_at: 2026-08-09T00:20:00Z
revision_note: >
  v2 after GroupThink deliberation (run 3136197f) and deep research. Folds in
  four concessions (D1 tempered, U5 reframed, D3 portability corrected, new
  tree-validity gap), adds intent-first packaging as the headline direction,
  kills D4, and embeds the six human decisions with recommended defaults.
---

# Save Card & checkpoints — architecture orientation, honest assessment, and directions

## In plain terms

This app quietly photographs the project before and after every agent's turn, so
mistakes can be undone. Separately, a "Save" screen lets the human bundle each
agent's finished work and record it permanently in the project's history. The
recording machinery is precise — saving one bundle really does save only that
bundle, not everything else lying around — but the recorded entries are labeled
with meaningless codes instead of descriptions, the screen is very slow, and
changes no agent was seen making (including the human's own edits) demand a
confirmation checkbox *per file*, which recently meant about a hundred
checkboxes. This document explains how it all works, what an audit of the real
history and of competing tools found, the quick fixes that would unblock use
today, and the bigger bets that would make it uniquely valuable.

Status: assessment + direction proposal. Nothing here is implemented or
scheduled; the lifecycle continues only from the Plans pane.

---

## What changed in v2 (deliberation + research outcome)

A GroupThink deliberation (agy lead + codex reviewer, parallel; synthesis at
`plans/2026-08-08-save-card-direction-gameplan.md`) and a deep research pass
(`.lares/research/inbox/save-card-direction-review/2026-08-08-save-card-direction-deep-research.md`)
tested v1. Outcome:

- **Kept unanimously:** the two-layer split (§1), the CAS commit coordinator,
  the shared tree as the collaboration mode, and U1–U4 as urgent unblocks.
- **Conceded and amended:** D1 was overclaimed (now a graduated concurrency
  policy), U5's human-authorship inference was unsafe (now an "Unwitnessed"
  class with explicit gestures), D3's portability claim was hollow (refs don't
  travel; readable content must live in the message).
- **New gap found:** byte-integrity ≠ tree-validity — partial staging can
  commit a tree that never compiled (D6).
- **New headline:** intent-first packaging (D5) — the durable commit unit is
  the delegated intent, not the file-connectivity cluster.
- **Killed:** D4 (auto-commit inversion) — checkpoints already *are* immutable
  per-turn commits; a scratch-ref hierarchy duplicates them. The
  retrospective-curation insight survives inside D5.
- **Six decisions belong to the human** — §6 states each in plain terms with
  evidence and a recommended default. **All six settled 2026-08-09:** Q1–Q2
  ruled by Edward directly (same-intent overlap is silent co-authorship;
  worktree boundary = per planning-surface activity); Q3–Q6 delegated by
  Edward to the recommended defaults, adopted as policy, refinable in the
  planning pipeline. The proposal is direction-complete and ready for
  promotion from the Plans pane.

The synthesis doc's implementation phases are illustrative only and are NOT
part of this proposal; they get re-derived at planning time.

---

## 1. The two layers (do not conflate them)

### Layer A — Checkpoints (recovery; always-on; invisible to normal git)

Real git commit objects in the **real** `.git`, parked on non-branch refs:

```
refs/lares/checkpoints/<workspaceIdB64>/<agentIdB64>/<turnIdB64>/before
refs/lares/checkpoints/<workspaceIdB64>/<agentIdB64>/<turnIdB64>/after
```

- NOT a shadow repo, NOT ephemeral files. They never appear in `git log`
  because they are outside `refs/heads` — which is why casual git usage never
  surfaces them.
- Measured on this repo 2026-08-08: **3,696 lares refs, `.git` total 58 MB
  (53 MB packed)**. Storage cost is a non-issue.
- Retention: dense window ~10 days, then thinning; pins can extend
  (`src/main/git-checkpoints/retention.ts`). After pruning, only what was
  promoted to real history survives.
- Purpose: undo/forensics. Workers deliberately do NOT get restore authority
  (`restore_paths` / `revert_turn` are supervisor-side, immediate, and
  destructive in a shared tree — see the checkpoint-forensics skill).

### Layer B — Save Card (promotion; human-driven; produces branch history)

Not undo. It answers: "the tree is dirty from many actors — turn the coherent
slices into durable, attributed commits."

Pipeline:

1. **Inventory** — `git --no-optional-locks status --porcelain=v2 -z
   --untracked-files=all` (`src/main/commit-candidates/dirty-inventory.ts`).
   The inventory is derived LIVE from git status on every open; there is no
   persisted package list. Consequence: anything committed by any means (CLI,
   an agent, anything) drops out of the card automatically.
2. **Attribution join** — dirty paths are joined against checkpoint turn
   records ("which agent was *witnessed* touching this path"), clustered into
   connected components = "work packages." Paths no turn witnessed fall into
   one **Unattributed changes** pseudo-bundle
   (`src/main/commit-candidates/work-bundle.ts`).
3. **Preview / review** — per-member byte verification, overlap +
   unattributed acknowledgements, editable message, server-derived trailers
   (`src/renderer/components/save/CandidatePreview.tsx`,
   `src/main/commit-candidates/preview-routes.ts`).
4. **Mint → consume** — preview is strictly tokenless/read-only; a dedicated
   mint route issues a single-use token binding the frozen manifest; commit
   consumes it (`save-card-ipc.ts`, `commit-coordinator-ipc.ts`).
5. **Commit** (`src/main/git-checkpoints/commit-coordinator.ts` ~line 560+):
   - re-reads every member's bytes immediately pre-commit; any drift ⇒ clean
     `stale` refusal;
   - builds an **isolated temp index**: `read-tree <pinnedHEAD>` →
     `update-index --index-info` with ONLY the reviewed blob OIDs →
     `write-tree` → verifies the constructed tree matches the reviewed
     effects exactly;
   - `commit-tree` (deliberately no hooks, no signing);
   - `update-ref HEAD <new> <expectedOld>` — an atomic compare-and-swap; a
     concurrent HEAD move is a refusal, never a clobber;
   - reconciles only the selected paths in the real index; all other dirt is
     untouched and stays visibly dirty.

**Answer to "does saving one package commit the whole repo?" — NO.** This is
proven both by code and by history audit (§3): a 2-file commit landed while 13
other modified tracked files sat dirty; none rode along. The partial-staging
machinery is correct. This is the hard part of the problem and it is done well.

### Key files

| Concern | Path |
|---|---|
| Checkpoint engine | `src/main/git-checkpoints/checkpoint-service.ts` (~2000 LOC) |
| Retention/pruning | `src/main/git-checkpoints/retention.ts`, `prune.ts` |
| Commit coordinator (CAS commit) | `src/main/git-checkpoints/commit-coordinator.ts` |
| Dirty inventory | `src/main/commit-candidates/dirty-inventory.ts` |
| Package projection | `src/main/commit-candidates/work-bundle.ts` |
| Preview + candidate build | `src/main/commit-candidates/preview-routes.ts`, `save-card-ipc.ts` |
| Per-member byte verification | `src/main/commit-candidates/commit-representation.ts` |
| Save-all sweep | `src/main/commit-candidates/save-sweep-service.ts` |
| Renderer | `src/renderer/components/save/SaveCard.tsx`, `CandidatePreview.tsx` |
| Default commit message | `save-card-ipc.ts` `deriveDefaultMessageBody()` (~line 601) |
| Trailer derivation | `commit-coordinator.ts` `defaultDeriveTrailers()` (~line 200) |

Total footprint: ~42,600 LOC across the two subsystems (tests included).

---

## 2. History forensics (audited 2026-08-08 on this repo, read-only)

13 save-card commits exist; they are the 13 most recent on master. Linear,
single-parent, real blobs; `show`/`revert`/`blame`/`bisect` all mechanically
work.

Verbatim commit message:

```
Save component:f11c1b20f6fec72ca984f8ad774f72d0d434a24c09ca3d0b86f171f1…

Lares-Candidate: 712384e90fbfefc7a3478fe1f8da8ec14c6b5b6a64696813399d1ba7622a455d
Lares-Turn: 91f2db60-b1c7-47ff-bd12-c34b7d3295b3
Lares-Turn: 9ff5cd06-a3bc-4f57-8122-950253c496fc
```

Findings:

- **Zero human-readable content.** Subject = `Save component:` + hex. The hex
  is **truncated with a literal U+2026 baked into the commit object** — neither
  readable nor a valid key.
- **No identifier resolves inside the repo.** `git grep` finds none of the
  component hash / candidate id / turn UUIDs at HEAD. Trailers point into the
  dashboard's SQLite. On another clone, after a `.lares` prune, or past
  checkpoint retention, provenance is a dead link.
- **Scoping is clean.** Median commit = 1 file. One blemish: `ea6cbb91`
  (13 files, 3,535 insertions) fused two unrelated plan folders + two
  proposals — an attribution-clustering artifact, not tree sweep.
- **`git blame` degrades hard** — blame surfaces the hash subject, explaining
  nothing; `git log --grep` on any topic finds nothing; `--oneline` shows 13
  identical lines.
- **Usage reality:** 11 of 13 save commits contain no source code — plan /
  proposal / skill markdown. Today this is a docs-checkpoint button.
- Save-card is now the **single most common commit shape** in the last 200
  commits (6.5%, and 100% of the last 13). The newest slice of history is the
  least legible slice.

### The "102 checkboxes" incident, decomposed

- `git status --porcelain` = 69 entries, but `-uall` = **103** — untracked
  *directories* explode into per-file entries. ~90 were untracked plan-folder
  files written days ago, outside checkpoint capture.
- `CandidatePreview.tsx:400` renders `Include unattributed change {entryId}` —
  `entryId` is a content hash, not `member.path.displayPath`. Users are asked
  to attest to hashes.
- There is **no acknowledge-all / select-all** anywhere in the save UI
  (verified by grep); every acknowledgement is an individual checkbox atom.
- Design gap underneath: the human's own edits are "unattributed" — the system
  treats human authorship as an anomaly requiring per-file attestation, and
  has no concept of pre-existing backlog vs. fresh agent work.

### Why it takes ~10 minutes

`commit-representation.ts` (~lines 122–200): **per member file** — mkdtemp →
`read-tree HEAD` into a fresh temp index → `git add --pathspec-from-file` →
`ls-files --stage -z` → cleanup. Four+ process spawns per file; the
coordinator's final revalidation loop is **sequential** (`for … await`). 102
files ≈ 400+ serial `git.exe` spawns on Windows (Defender-scanned). For scale:
`git read-tree HEAD` on this repo is 69 ms and the index is 2,796 files — git
is not the bottleneck; spawn count × latency is. Sweeps also run a full
`refreshInventory()` (full status + attribution join) after **every** package.

---

## 3. Prior art (researched 2026-08-08; URLs at end)

### Mechanisms across the field

| Tool | Mechanism | Granularity | Undo restores |
|---|---|---|---|
| Claude Code `/rewind` | Private file snapshots beside transcript (not git); content-shared; 100/session, 30-day | Per user prompt | Code, conversation, or both. Blind to Bash-mediated writes; skips symlinks |
| Cursor | Opaque local state (`state.vscdb`), "separate from Git" | Per request | All modified files; restore reported flaky; users migrate to auto-branches |
| Cline / Roo | **Shadow git** in global storage, `core.worktree` = project; restore = `reset --hard` + `clean` through it | Per tool use | Files and/or task. Known: renames nested `.git`→`.git_disabled` (once hit a project ROOT `.git`, cline#9590); ignore-blind traversal >20 s/checkpoint (#4519); Roo hardcoded 15 s init timeout silently disables on big repos (#7843) |
| Aider | **Real commits in the real repo** | Per AI edit; dirty tree pre-committed separately | `/undo` reverts last aider commit. Conventional-commit messages from a weak model; `(aider)` author suffix |
| Windsurf | Undocumented snapshots | Per step + named snapshots | Revert to step; **irreversible** |
| Zed | Internal checkpoint per message | Per assistant message | Pre-message state; plus per-hunk accept/reject review multibuffer (best curation UI of the set) |
| Copilot coding agent | No checkpoint layer — real commits on `copilot/*` branch, draft PR | Per checklist item | Close/revert the PR |
| Devin | Whole-VM machine snapshots + action replay log | Session | Restart from snapshot |
| OpenHands | Event log; isolation optional (Local/Docker/Remote workspace) | n/a | No undo primitive found |

### The debate that matters

**Granular recovery is wanted; granular history is not.** Aider's auto-commit
is loved for `/undo`, resented for history that "reads like the AI's working
log"; HN users cite *not* auto-committing as a selling point. The convergent
practice: auto-commit during the session, squash/curate at PR time. Lares'
checkpoint-vs-save split already matches the convergent shape — the concept is
right; the interaction charges curation effort at the wrong time (mid-flight,
per package, with ceremony) and then discards it into a hash subject.

**Attribution trailers are politically live.** VS Code shipped an AI co-author
trailer default-ON (2026-04-16), took sustained consent/provenance backlash,
reverted to OFF (2026-05-03). Counter-proposals favor `Assisted-by:` or a
structured `Generated-By:` over `Co-authored-by:` for non-persons. Codex CLI's
attribution is prompt-injected (model-compliance, not enforced). Lesson: ship
provenance trailers opt-out, and structured.

**Multi-agent shared tree: nobody else does it.** The 2026 consensus is
worktree-per-agent + branch-per-agent + merge-time conflict detection; the
stated rationale is exactly the silent-overwrite hazard Lares runs daily.
Lares' server-witnessed per-agent attribution in ONE shared tree appears
genuinely novel — no prior art found. Novelty is only worth keeping if it
delivers what worktrees deliver (detected collisions) — see D1.

**Do not adopt shadow-git.** Its worst failures (root `.git` disabled,
recursive nested `.git` creation, ignore-blind traversal) are inherent to a
second git reaching into a live tree; and `reset --hard` through a shared tree
would destroy a concurrent agent's in-flight work. Lares' real-refs design is
strictly better. Keep it.

**Hunk-level primitives exist.** `git-surgeon` (raine.dev) provides
non-interactive hunk staging/splitting with stable hunk IDs, built because
agents cannot drive `git add -p`. Relevant to D2/D4.

---

## 4. Unblock suggestions (hours each; no architecture change)

U1. **Readable subjects — from INTENT, not filenames.** *(strengthened in v2)*
    Subject from the contributing turn's task brief / plan title — the join
    exists at commit time (`deriveDefaultMessageBody()` already has
    components, finalizations, turn ids in scope). File-list subjects
    (`Save: 3 files in src/renderer`) are the fallback only: readable but
    still useless for `git log --grep`. Full (untruncated) hashes demoted to
    trailers.

U2. **Show paths, not hashes, in acknowledgements.**
    `CandidatePreview.tsx:400`: render `member.path.displayPath`. One line.

U3. **Bulk acknowledgement + directory collapsing.** An acknowledge-all
    control (or one acknowledgement atom per directory subtree for untracked
    dirs). The 56→103 explosion is `--untracked-files=all` semantics; group
    what git itself groups.

U4. **Batch the git work.** One temp index for ALL members of a candidate
    (single `read-tree`, single `--pathspec-from-file` add, single
    `ls-files --stage`), instead of per-member mkdtemp+4 spawns; parallelize
    remaining per-member reads with a bounded pool; make the coordinator's
    revalidation loop concurrent. Expected: minutes → seconds. No semantic
    change — the same OIDs get verified.

U5. **"Unwitnessed" as an honest first-class class + one-gesture adoption.**
    *(amended in v2 — the v1 inference was unsafe)* v1 proposed inferring
    "human-authored" from "no witnessing turn during a human-active window."
    That inference is wrong: formatters, generators, hooks, and
    uninstrumented tools all write unwitnessed. The honest class is
    **Unwitnessed** — never fabricate provenance. The convenience survives as
    three one-gesture actions on an unwitnessed group: **Claim as mine** /
    **Mark as generated** / **Adopt as baseline** (the backlog escape hatch
    for dirt older than checkpoint coverage — one acknowledgement, not
    per-file). Prior art: TOFU-style directory-level trust (research §Q4).

U6. **Operational note for stuck packages (works today):** the inventory is
    live-derived, so committing paths by any external means (CLI or an agent)
    makes the package vanish from the card on its own. There is no DB row to
    clean up.

## 5. Higher-order directions (the bets that create real value)

D1. **Graduated concurrency policy (amended in v2 — v1 overclaimed).**
    v1 called write-time collision detection "strictly superior to
    worktrees." Wrong on two counts: `turnB.before ≠ turnA.after` proves
    *divergence*, not overwrite (B may have started before A finished, may
    have intentionally replaced A's work, ordering may be inverted), and
    detection-after ≠ prevention. The defensible form is a **graduated
    policy**: predict overlap (the advisory `contention-model.ts` already
    exists) → observe divergence from before/after witnesses → classify
    (benign resequencing / intentional replacement / suspected lost-update)
    → act (warn / pause / serialize dispatch / route to isolation). The gap
    today is policy, not detection. Shared tree remains the default
    collaboration mode; **worktree isolation is added as an explicit mode**
    for independent or batch work — matching the research finding that
    worktrees won the industry while our niche (tightly-coupled concurrent
    work with attribution) stays defensible.

D2. **Hunk-level attribution.** File-level packaging cannot be correct when
    two agents touch one file — no file split is right. Witnessed before/after
    content makes per-agent hunk ownership computable; stage exactly those
    hunks (the temp-index machinery already supports arbitrary blob
    composition). This is the differentiator with no competition. See
    git-surgeon for the primitive shape.

D3. **Provenance that survives the repo (amended in v2 — portability
    corrected).** v1 implied a `Lares-Checkpoint:` trailer naming
    `refs/lares/*` would be durable. It is not: custom refs do not travel on
    clone/push. The corrected split: **everything a future reader needs to
    understand the commit lives as readable content in the message body**
    (task/plan names, `Assisted-by:` per the emerging standard); ref-pointer
    trailers are **local audit metadata only**, honest about their scope,
    unless a deliberate transport contract is built later (§6 Q6). Promoted
    commits pin their referenced checkpoint refs past normal retention so the
    local audit trail at least survives pruning. Structured, opt-out-able
    (VS Code backlash lesson; EU AI Act Aug 2026 makes machine-readable
    disclosure compliance-relevant).

D4. **KILLED in v2 — auto-commit inversion.** Checkpoints already *are*
    immutable per-turn commits on refs; a per-agent scratch-ref hierarchy
    would duplicate them while solving neither unwitnessed dirt nor overlap,
    and the human's concurrent edits problem stays unsolved. The valuable
    half survives inside D5: **low-ceremony retrospective curation over the
    checkpoint data we already have** (the field's convergent "auto-capture
    then curate" practice — cf. `jj absorb` / `git absorb`).

D5. **Intent-first packaging (NEW in v2 — the headline direction).** Both
    deliberation planners independently arrived here: connected components of
    touched files are a **safety constraint**, not a commit boundary. The
    durable commit unit should be the **human-delegated intent** — the plan
    item / task / named save-set under which the work was dispatched —
    with attribution topology demoted to evidence and overlap warnings. This
    directly explains the `ea6cbb91` two-plans-fused grab-bag (clustering by
    file adjacency fused unrelated intents), and it out-argues the jj
    challenge: jj's answer is retrospective *reconstruction* of meaning;
    intent-first *preserves* meaning from the moment of dispatch. Save Card
    packages become "the work you asked for," reviewed and committed as such;
    U1's subjects fall out for free.

D6. **Candidate-tree validation (NEW in v2 — gap neither v1 nor forensics
    caught).** Partial staging can commit a tree that never existed as a
    working state: if a saved file depends on an omitted dirty file, HEAD is
    byte-exact and broken. Byte-integrity ≠ tree-validity. Direction:
    configurable, repo-policy-driven validation of the exact candidate tree
    (typecheck/build/test of the constructed tree, not the dirty worktree)
    before the CAS commit — off by default, opt-in per repo.

Suggested order: U1–U4 together (one worker each, small), U5 next, then D1
policy + D5 design as the deliberate plan with design review; D3 and D6 ride
that plan; D2 after D5 (hunk attribution serves intent packaging, not the
other way around).

<!--PLAN-INTENT
{ "intent_id": "int_7d41c9a2", "part": "intent-first-packaging-concurrency-worktree-architecture",
  "kind": "groupthink-parallel",
  "targets": [ { "provider": "claude" }, { "provider": "codex" } ],
  "reason": "D5's task/intent join, D1's graduated concurrency policy, and Q2's worktree-per-plan-activity lifecycle (creation, merge-back, cleanup, failure recovery) determine package identity and downstream schemas — they must be designed as one coherent architecture before their WPs are cut" }
-->

## Hardening scope

- **Verdict (dated):** 2026-08-09 — one design deliberation is needed: D5 +
  D1 + Q2 as a single intent/lifecycle/concurrency architecture (design
  level only; the six §6 rulings are settled and are NOT re-opened). All
  other parts — U1–U5, D3, D6 — are sufficiently specified to package
  directly. No further online research is warranted; remaining uncertainty
  is repository-specific design, not missing prior art.
- **Second opinion:** codex worker a5fdcfb9 ("Scope second opinion —
  save-card proposal triage"), independent read-only triage 2026-08-09;
  concurred per-part with the above, and recommended D2's deliberation be
  deferred until D5's contracts exist.
- **Marked intents:** int_7d41c9a2 — groupthink-parallel design deliberation
  over D5 (intent-first packaging join), D1 (graduated concurrency policy),
  and Q2 (worktree-per-planning-activity mechanics incl. merge-back UX).
  D2 (hunk-level attribution) is deliberately NOT marked: it is sequenced
  after D5 by the proposal itself; a fresh intent will be minted for it
  (§R1) once D5's design contracts exist.

## 6. Decisions for the human — plain language, evidence, recommendation

These six were Edward's to make. Status 2026-08-09: **all six are settled.**
Q1–Q2 Edward ruled directly; **Q3–Q6 Edward delegated to the supervisor's
recommended defaults** ("best practices and judgment — the planning pipeline
will iron things out too"), so the recommendations below are ADOPTED policy,
refinable at planning time. All are reversible; none is a one-way door.

**Q1 — When two agents' work collides, what should the system do by default?**
*(RULED by Edward, 2026-08-09, refining the recommendation.)* Edward's
observations: (i) today the card flags essentially everything as a collision
and blocks saving — that is the bug, not the policy; (ii) two agents writing
the same file **under the same work package / job is not a collision at
all** — it is co-authorship and must be silent; (iii) "resolve" was
undefined — a human cannot be asked to do an unspecified thing.

Ruled policy:
- **Same-intent overlap: automatically fine.** No warning, no
  acknowledgement; the overlapping turns simply co-author the package.
  (Falls directly out of intent-first packaging, D5.)
- **Cross-intent suspected lost-update is the ONLY warning case:** an agent
  on intent X diverging a file that intent Y's agent had finished — the case
  no reviewer of Y's save would otherwise notice.
- **Resolution is a one-gesture attribution picker at save time — never a
  manual merge.** The disk already holds one final state; what is unresolved
  is bookkeeping only. Gestures: *Commit together* (same job after all) /
  *Superseded intentionally* (later work replaced earlier; commit final
  state) / *Work was lost — restore* (diff the checkpointed after-image
  against disk, recover). Agents are never paused mid-flight.

**Q2 — Where is the worktree boundary?**
*(DIRECTION from Edward, 2026-08-09.)* Not per-agent, not per-supervisor —
"overkill; supervisors coordinate and their agents genuinely collaborate."
Edward's boundary: **one worktree per planning-surface activity.** A plan is
already the unit of intent, so its implementation runs in its own tree and
merges back when the plan's work is saved/promoted. Initiation is
system-driven, not a human chore: promoting a plan to implementation creates
the worktree; completing/saving merges back and cleans up. The shared tree
remains the mode for conversational, quick, and cross-cutting work.
Open detail (flagged, undecided): two plans touching the same files moves
their conflict to merge time — no worse than the industry status quo, but
the merge-back UX needs design at planning time. The advisory predictor
(`contention-model.ts`) stays observe-only for now; no auto-routing on
unvalidated predictions.

**Q3 — What is the durable save unit?** What one "Save" gesture commits:
(a) a *plan item*, (b) a *task* (one dispatched brief), (c) a *named
save-set* the human assembles by hand. This defines the whole card.
**Recommendation: the task (dispatched intent) as the default unit, grouped
under its plan item in the UI; named save-sets as the manual fallback for
human/undelegated work.** Task is the level where a brief, a worker, and a
witnessed turn already join; plan items often span many days and would
re-create grab-bags.

**Q4 — Commit hooks and signing: the coordinator currently bypasses both.
Keep the bypass, or make hooks/signing a repo-policy opt-in?** Background:
the CAS commit deliberately uses `commit-tree` (no hooks, no signing) so a
slow or mutating hook can't corrupt the reviewed bytes or stall the
coordinator. But repos that enforce signed commits or pre-commit checks get
silently non-compliant history. **Recommendation: keep the bypass as the
default; add a per-repo policy to (i) run validation against the candidate
tree (D6 — safer than letting hooks mutate the commit) and (ii) sign the
commit when the repo requires it.** Never let a hook rewrite reviewed bytes;
validation may refuse, never modify.

**Q5 — Provenance trailer default: `Assisted-by:` on or off? Agent/model ids
in public history?** Evidence (research §Q4): the VS Code backlash was about
stamping commits the AI didn't touch, default-ON; the `Assisted-by:`
convention (Linux, Fedora, LLVM, Apache adopting variants) says label only
when AI materially shaped the change; EU AI Act enforcement (Aug 2026) makes
machine-readable disclosure compliance-relevant. Lares differs from the
VS Code case in kind: our trailers ride only witnessed agent work — the
attribution is evidence-backed, not guessed. **Recommendation:
`Assisted-by: <provider>:<model>` ON by default for witnessed agent work
only (never on human-claimed or unwitnessed-adopted paths), per-repo
opt-out. Model ids in public history: yes (industry standard). Internal
agent UUIDs: local trailers only, never in the shareable body.**

**Q6 — Checkpoint portability: does recovery evidence stay local, or do
promoted commits carry a transport story?** Refs under `refs/lares/*` don't
travel on clone/push (D3 amendment). Options: (a) local-only — readable
provenance travels in the message, evidence stays in the originating clone;
(b) build a transport contract (push checkpoint refs / bundle evidence) so
promoted commits' evidence survives on other clones. **Recommendation: (a)
now — plus pinning referenced refs past retention locally. (b) is real
engineering with an unclear consumer; defer until someone actually needs
cross-clone forensics.**

## 7. Source pointers

Internal evidence: this repo's `git log` (13 `Save component:*` commits ending
665b1f36), `git for-each-ref refs/lares`, and the files in §1's table.

v2 inputs:
- GroupThink synthesis: `plans/2026-08-08-save-card-direction-gameplan.md`
  (run 3136197f; phases illustrative only — its <500ms target and buried open
  questions are superseded by this document).
- Deep research: `.lares/research/inbox/save-card-direction-review/2026-08-08-save-card-direction-deep-research.md`
  (untrusted tier; jj challenge, worktrees-won-2026, attestation prior art,
  Assisted-by adoption, 61%-no-review study).

External (retrieved 2026-08-08):
- Claude Code checkpointing — code.claude.com/docs/en/checkpointing
- Cursor checkpoints — cursor.com/docs/agent/chat/checkpoints
- Cline checkpoints — docs.cline.bot/core-workflows/checkpoints; issues
  cline#4519, #9590, #4386, #4388; Roo-Code#7843
- Aider git integration — aider.chat/docs/git.html; aider#3600
- Zed agent panel — zed.dev/docs/ai/agent-panel; zed#28676
- Windsurf Cascade — docs.windsurf.com/windsurf/cascade
- Copilot coding agent — docs.github.com/copilot/concepts/agents/coding-agent
- OpenHands SDK — arxiv.org/html/2511.03690v2
- Devin snapshots — docs.devin.ai/onboard-devin/repo-setup
- VS Code AI co-author default reversal — windowsforum.com thread 416417
- `Assisted-by:` proposal — baristalabs.io/blog/ai-assisted-commits-need-provenance-trailer
- git-surgeon / atomic commits for agents — raine.dev/blog/atomic-commits-for-ai-agents
- Worktrees for parallel agents — augmentcode.com/guides/git-worktrees-parallel-ai-agent-execution

Caveats from the research pass: Cursor's on-disk format is community
reverse-engineering; Windsurf's backing store is undocumented; Devin per-turn
code revert unverified; OpenHands "no undo" is absence of evidence.
