# V2 Master Plan — alignment review (2026-06-20)

**What:** GroupThink (parallel, Claude+Codex) alignment audit of the owner's new
simplified index `docs/V2_MASTER_PLAN.md` vs the original detailed V2
multi-supervisor initiative. Driven by me (supervisor `2ca813fb`) on owner request:
"make sure the simplified plan still uses what was solid/pinned-down in the original."

**Artifacts produced (all gitignored docs/plans):**
- 3 evidence packs: `plans/v2-alignment/evidence-L0-L4.md`, `-L1.md`, `-L2-L3.md`
  (one worker per layer slice; each grep/git-verified code claims vs HEAD `be0693b`).
- Consensus report: `plans/v2-master-plan-alignment-review.md` (the authoritative output).

**Verdict:** the master plan is a *structurally sound index, not yet a safe standalone
build driver*. Faithful by its own charter (layer doc wins for spec). Two defect kinds:
(1) silent enumeration drops, (2) stale-status/unreconciled-reality contradictions.
The 3 packs do not materially conflict. Ranking axis = permanent-loss.

**6 remediations (D-1..D-6) + §5 hygiene.** D-1 (slug-as-PK = only IRREVERSIBLE risk:
banner the two unmarked migration-chain docs + harden master §6(a)) is top priority.
D-2 = the owner-edge reconciliation; D-3 = exposure-gate guard already removed at HEAD
(live invariant violation, relabel P1-02 → P1-02r); D-4 = restore full C-2 event set
(dropped `plan.ordering.revised`; C-2 is FIVE, total SIX, `plan.artifact.written` is C-1);
D-5 = quarantine the obsolete Phase3 manifest; D-6 = index-completeness bundle
(L0/L1/L2 label-collision fix, projection scope-classes, emit-channel caveat, §14.1
caution, L4 ledger row, L2 off-ledger status).

**OWNER DECISION (recorded 2026-06-20): ownership edge = `owner_agent_id` CANONICAL;
`agents.supervisor_id` becomes a specialization/alias (report §7 option 2).** Implication
flagged by the synthesizer: `supervisor_id` may be derivable
(`owner_agent_id = X AND X.is_supervisor`), so ticket **P1-01′ may shrink or be deleted**
— surface for confirmation before any B1a schema work; do not silently drop the column.
This unblocks D-2 Stage 2. With it, ALL of D-1..D-6 are worker-executable.

**Key HEAD ground-truths re-confirmed (carry forward):**
- Exposure-gate guard ALREADY removed: `supervisor/index.ts:1188-1190`; `getSupervisorAgent
  … LIMIT 1` at `:1132-1133` still load-bearing; `AGENT_DASHBOARD_SUPERVISOR_ID`/identity
  injection absent from `src/` → multi-supervisor enabled before identity exists.
- Ownership primitive (`owner_agent_id`/`getOwnerForWorker`) BUILT but UNCOMMITTED
  (`M database.ts`); the *renderer* surface (`OwnerContainerBar.tsx`, recursive `AgentGrid`)
  IS committed and already delivers UI-02/03 semantics keyed on `owner_agent_id`.
- `orchestrations`/`_events`/`_members` tables LIVE (`54519bf`, `database.ts:227-268`).
- `run_orchestration` lives in `scripts/mcp-tools-orchestration.js` (NOT `mcp-supervisor.js`).
- `plan_events`/`AGENT_DASHBOARD_PLAN_ID`/`supervisor_bricks` = 0 files in `src/` (all paper).

**Status:** report delivered to owner. Fold NOT yet applied — paused while a new
forward-design decision is pinned down (below). When folding: surgical in-place edits
to `V2_MASTER_PLAN.md` + source-doc banners (no rewrite); no build/restart; must NOT
touch `src/shared/constants.ts` source-of-truth or any `.claude/` path.

## OWNER DECISION (2026-06-20): ownership is MULTI-LEVEL + walk-up — commits the manager role

Superseding the earlier "owner_agent_id canonical, supervisor_id alias" nuance: the owner
ruled we must **anticipate ownership CHAINS** (supervisor → manager → worker → …) and
**fully plan on walking UP the chain**. Consequences:
- Canonical "who is agent X's supervisor" = **walk `owner_agent_id` up to the first
  `is_supervisor` ancestor** (NOT a stored column). `getOwnerForWorker` (`database.ts:896`)
  is ONE-hop only → need a new chain resolver (`getSupervisorForAgent`/`getOwnerChain`).
- **This COMMITS the manager role (Theme C), previously "NOT COMMITTED" everywhere.** You
  only get chains with an intermediary owner tier.
- Ticket **P1-01′ re-scoped** again: from "add `agents.supervisor_id` column" → "build the
  chain-walk resolver"; `supervisor_id` at most a denormalized cache, never source of truth.
- Invariant §7.2 extends: "resolve by edge/FK" → "resolve by **walking** the edge chain";
  retire `getSupervisorAgent … LIMIT 1` as the load-bearing fallback.

**Open forks handed to a GroupThink (parallel) on the chain model → `plans/ownership-chain-design.md`:**
(1) walk-on-demand vs cached supervisor_id (+ invalidation on re-parent); (2) dead-mid-chain
owner policy (skip-and-keep-walking vs broken/re-parent; reconcile with getOwnerForWorker's
null-on-dead); (3) cycle/depth/orphan guards; (4) event bubbling per-hop w/ notify_owner gating
vs direct-to-supervisor (Theme F); (5) resolver API + what replaces the LIMIT-1 fallback.
**Plan: fold the alignment audit AND this chain-design slice into the new master together.**

## FOLD COMPLETE (2026-06-20, worker `1fd82d13`)

Both the alignment audit (D-1..D-6 + §5 hygiene) and the ownership-chain design (§6/§7)
were folded into `docs/V2_MASTER_PLAN.md` + source docs — surgical in-place, doc-only,
nothing committed. 10 files written (all docs/plans, zero src/, verified via
read_agent_files_touched). Spot-verified: §6(g)→RESOLVED (owner_agent_id canonical, no
supervisor_id column, P1-01′→P1-01r), full 5 C-2 events restored, P1-02→P1-02r, slug-PK +
Phase3 banners at line 1. **V2_MASTER_PLAN.md is now the integrated authoritative master.**

Reconciliation applied: audit D-2 ("owner must rule / blocking") was REPLACED by the
chain-design RESOLVED form everywhere (owner ruled via the chain GroupThink). Add-column
P1-01′ steps in the source docs were nullified via prominent SUPERSEDED banners (not ripped
out — preserves history per the master's "for history only" convention).

**NOT yet done (future implementation, separate from the plan fold):**
- The ownership primitive (`owner_agent_id`/`getOwnerForWorker`/`notify_owner`) is still
  UNCOMMITTED on disk — chain design §8 step 1 says COMMIT it first before any P1-01r code.
- P1-01r resolver code (`getOwnerChain`/`getSupervisorForAgent` + per-recipient event queue
  + EventBridge changes) = chain design §9/§10, not executed.
- Manager-role UX (Theme C Q2 live-visibility, Q9 spot-audit) remain OPEN by design.
