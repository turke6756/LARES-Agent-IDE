# The Planning Surface — a plain-language walkthrough

*Written 2026-08-02 for Edward. This is not a spec — the specs live in the implementation plans.
This is the "close your eyes and imagine using it" version. Everything here reflects the settled
design including all your rulings through 2026-08-02.*

---

## 1. The problem it solves

Today, when we plan something big, the thinking is real but the artifacts are homeless. A proposal
is a markdown file somewhere. The deliberations that hardened it are other markdown files somewhere
else. The research is in a third place. When you want to revisit a plan two weeks later, you are
hunting through folders trying to remember what belongs to what — and the app, which orchestrates
all the agents doing the actual work, knows nothing about any of it.

The planning surface makes plans **first-class citizens of the app**: one home per plan, a screen
where you browse them, a button that turns an idea into a real plan, and eventually a live view
where you watch agents working through a plan's checklist in real time.

Two principles run through the whole design:

- **The filesystem is the truth; the database is an index.** A plan is a folder of ordinary
  files you can read, edit, and commit to git. The app *watches* those folders and keeps a fast
  index so the UI is snappy — but if the database vanished tomorrow, every plan would still be
  fully intact on disk.
- **Evidence over narration.** What shows up on the surface about "who did what" comes from what
  the app *witnessed* agents actually do (files touched, turns run), not from what an agent
  claims in prose.

---

## 2. The anatomy — what the pieces physically are

### A proposal

Just a markdown file: `.lares/proposals/2026-08-02-my-idea.md`, with a small ID stamp in its
header so the app can track it across renames. That's it. Writing one costs nothing, and a
proposal is allowed to remain a humble markdown forever — most ideas should die cheaply. Detail
and deliberation documents that support proposals live next door in
`.lares/proposals/supporting/`.

### A plan folder

When a proposal graduates, it becomes a **folder** — one folder per plan, under
`.lares/plans/`:

```
.lares/plans/2026-08-02-my-idea-a1b2c3d4/
  plan.json          ← small machine-readable card: the plan's identity, which proposal
                        it came from, and the history of which supervisor is responsible
  plan.md            ← THE plan: the hardened document with the work packages
  ARC.md             ← one-page running summary: decisions made, package status, who did what
  deliberations/     ← the groupthink outputs that shaped it
  research/          ← research findings gathered for it
  supplements/       ← anything else the planning work produced
```

Everything about one plan lives in that one folder. Per your ruling: **nobody picks which
documents belong to a plan — the documents the planning work produces and puts in the folder ARE
the plan's documents.** The folder is the answer to "what's in this plan?"

`plan.json` is guarded by a **lock file** (the mechanism you approved): any process that wants to
edit it — the app or an agent's helper script — takes the lock first, keeps a heartbeat while
working, and releases it. If a holder crashes, the lock goes stale and someone else can safely
reclaim it. Two writers can never corrupt the manifest.

### The intent markers

Inside `plan.md`, important intentions are marked with small machine-readable sentinels — "this
part needs deliberation," "this package targets a Codex worker," and so on. The app reads these
markers and can tell you, mechanically, how *hardened* each part of a plan is: just an idea →
marked → deliberated → integrated → packaged. That "rung ladder" is how the UI later shows plan
maturity without trusting anyone's prose.

### ARC.md

The cheapest read in the system. One page that always answers: what was decided, what are the
work packages and their states, what deliberations happened, who did what (with references to
real evidence). Any agent opening a plan cold reads this first and is oriented in seconds.
**It is written and maintained by the plan's responsible supervisor** — created at promotion,
refreshed on orient and integrate — and that ownership is stated in the supervisor's own
orientation files (CLAUDE.md) and in the skill, so no supervisor has to guess it's their job.

---

## 3. The skill — how planning actually gets done

All planning is driven by the `proposal-to-plan` journey, shipped (your 2026-08-02 ruling on
GroupThink 2850dad1's recommendation) as **one skill with seven entry modes** — capture, scope,
promote, deliberate, integrate, package, orient — where each activity is its own playbook file
inside the skill, loaded on demand and extraction-ready if we later want a real workflow. The
journey's hardening steps:

**Capture.** "I have an idea." The agent writes a properly-stamped proposal markdown into
`.lares/proposals/`. Ten seconds of ceremony, no more. The old ritual (special HTML templates,
sentinel comments every turn, one-writer locks) is deleted — that ceremony is why the old plan
surface got used twice and died.

**Promote / scaffold.** "This idea is worth a real plan." The agent builds the complete plan
folder in a temporary directory and drops it into place in one atomic move — so the app never
sees a half-made plan. Then it runs the hardening journey on the plan document:

1. *Scope* — the hardening triage: the supervisor, with an **independent second opinion**
   (a Codex-lane agent, or even a small groupthink), reads the proposal and decides what
   deserves extra effort — which parts need deliberation, which would benefit from research.
   The scoping agents are briefed on the hardening process itself; their output is the
   **marked-up proposal**. "Nothing needs hardening — package and implement" is always a
   legitimate verdict for a simple proposal;
2. *Mark* — the supervisor stamps the intent markers **on the proposal itself** — the markup
   is the supervisor's strategy for getting proposal → plan, made before `plan.md` exists;
3. *Deliberate* — run groupthinks on the hard parts, outputs filed into `deliberations/`;
4. *Integrate* — the supervisor folds the deliberation results back into the plan document;
5. *Package* — last of all, the supervisor cuts the defensible plan into concrete work
   packages a worker can execute.

The journey is interruptible — an agent can stop halfway and any later agent can resume, because
the state is all in the folder.

**Orient / resume.** The rule for opening an *existing* plan folder: read `plan.json`, `ARC.md`,
and the intent markers, and report where every part stands **before doing anything new**. This is
what makes plans immortal across agent lifetimes.

The skill ships with the **helper script** that does all `plan.json` edits (taking the lock).
Agents never hand-edit the manifest.

And critically: the app itself tells every agent where all this lives — the CLAUDE.md/AGENTS.md
files the app installs carry a "where planning artifacts live" section. No agent ever guesses
paths.

---

## 4. The UI — what you see and click

Imagine a **Plans** area in the main view (peer of Dashboard / Files / the Save button):

**The gallery (front door).** Every proposal and plan in the workspace as cards: title, state
(bare proposal / promoted / hardening / ready / executing / done), owner chip showing the
responsible supervisor, maturity at a glance. Click any card to read it. This is the front door
the old surface never had.

**The reader.** Click a plan and its folder renders as a **tabbed document** — never one giant
scroll. Tabs like Plan / Decisions / Deliberations / Research, each opening with a plain-language
overview before the detail. The source proposal renders right there too. You can leave
**comments anywhere at any stage** — plans stay conversational, never locked — and your comments
route to the responsible supervisor, who answers on the surface. (Exactly like the selection
comments you and I use today, made a first-class plan feature.)

**The Promote button.** On any proposal card. Click it, pick which supervisor should own the
plan, confirm. That's the whole dialog — no document checklists (your ruling). Behind the scenes
the app launches a planning agent that runs the skill's promote journey; the card flips to
"promoting…", then becomes a real plan folder with the supervisor durably subscribed — recorded
in the database *and* in the folder's own history, so it survives restarts, crashes, and
supervisor handoffs. If the app dies mid-promotion, it picks up exactly where it left off on next
boot — never two folders, never two workers.

**The Implement trigger.** A hardened plan just *sits there* — indefinitely — until **you**
explicitly pull the trigger. Promotion never starts execution; planning and doing are separate
acts, and the second one is always yours. When you hit Implement, workers are dispatched onto the
plan's work packages, and every dispatch is stamped so the trail below works.

**The live mission board.** The payoff screen. Each work package is a card: cards **light up
while their agent is working**, witnessed file-touches tick in real time, click through to the
actual diffs, checkmarks appear when packages complete — with completion determined by evidence,
not by an agent saying "done." Contention warnings appear if two agents drift onto the same
files. Committing stays a **separate step** (your 2026-08-02 ruling): the board shows what's
done, and you go to the Save card yourself, which bundles and commits by its own logic — the
two surfaces stay decoupled for now, and any deeper joining is a later, explicit decision.

**Evidence surfaces.** From any file, ask "which plan caused this change?" and walk file → turn →
work package → plan. Blame-to-intent.

---

## 5. The build order — phases, waves, and gates

The work is cut so each phase is useful on its own, and we can stop cheaply if it turns out
nobody uses it.

**Phase P0 — the skill and the homes.** Build the `proposal-to-plan` skill, the helper script,
delete the old ceremony, and deploy the updated agent orientation files (where things live).
Also plant a tiny usage counter. *After this: agents plan the new way, folders appear on disk —
no UI yet.*

**Phase P1 — the tiny reader.** Bare-bones browsing: list proposals and plan folders, click to
read, hardened against all the path-safety nasties. Instrument how often it actually gets used.
*After this: you can finally SEE plans in the app.*

**★ Gate K — the honesty checkpoint.** We pause and let the counters run. You set the
thresholds (the N/M/K numbers): roughly "was the reader opened N times, and did promotion get
wanted M times, over some weeks?" If real demand shows up, we keep building. If not, we fold the
useful evidence bits into existing panels and stop — no monument-building. **These numbers are
still yours to set, but not until P1 exists.**

**Phase P2 — the registry and gallery.** The database index, the folder watcher (which also
creates the folder homes), the gallery pane with cards, and the intent ledger that reads the
markers and computes each plan's maturity rung. *After this: the front door exists.*

**Phase P3 — Promote.** The button, the supervisor picker, and the crash-safe machinery that
launches the planning worker and durably subscribes the supervisor. This is the stage your two
rulings just unblocked. *After this: idea → real plan is one click.*

**Phase P4 — the document home.** The tabbed reader, plain-language tab overviews, and comments
routed to the responsible supervisor. *After this: plans are pleasant to read and talk to.*

**Phase P5 — lifecycle + Implement.** Plan states (hardening → ready → executing → done) and the
explicit Implement trigger with stamped execution dispatches.

**Phase P6 — the live mission board.** The real-time board described above.

**Phase P7 — evidence surfaces.** Blame-to-intent lookups and richer per-package evidence.

**Phase P8 — cleanup.** Import the two legacy HTML plans, then delete the old bespoke plan
machinery the new engine replaces.

**How this interleaves with the Save card:** P5–P7 need Save-card Stage ③ (finalization — the
formal "this package is said-and-done" freeze) as completion *evidence*. The commit-checkbox
integration is **deferred** per the decoupling ruling, so Stage ④ is no longer a planning-surface
dependency unless the surfaces are later re-joined. The Save card is currently mid-Stage-③-prep,
so by the time the planning surface reaches P5, its dependency should be waiting for it.

**If you say GO,** the first wave is **P0 + P1** — the skill, the homes, the reader, the
counters. Modest, mostly parallel worker packages, all landing as local commits you review after
an app restart, same rhythm as the Save-card work. Then we sit at Gate K until the numbers (and
you) say continue.

---

## 6. What's decided vs. still open

**Decided (your rulings, folded into the specs):** folders not HTML; the folder is the document
set (no promote-time document picking); supervisors durably subscribed via DB + on-disk history;
lockfile protocol for the manifest; you are always the committer; Implement is an explicit human
trigger; tabbed reader with overviews; plans stay conversational; the live board is a core
requirement, not a nice-to-have; Save button styled as a save card in the top bar. And from your
2026-08-02 guide review: scope = hardening triage with an independent second opinion; marking
happens on the proposal; mark/integrate/package and ARC.md are the supervisor's, stated in its
orientation files; orient-first on plan pickup; a visible "ready for implementation" badge gates
Implement; planning surface and Save card stay separate for now (commit checkbox deferred).

**Open:** your GO for Wave 1 (P0+P1) — fully dispatchable now that the hybrid shape is ruled ·
the Gate-K thresholds (after P1) · push authorization (everything so far is local commits) ·
Save-card Stage ③ go, after you review the 1L.2 attribution fix.
