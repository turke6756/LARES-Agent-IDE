---
plan_artifact_id: plan_65e665d7
intent_id: int_7b3ce2a4
kind: deliberation
---

# Auditor execution design

## Decision

Use exactly **three agents**:

1. **Lead Auditor — Codex, fresh agent**
2. **Agent-Evidence Collector — Codex, fresh agent**
3. **Surface-Evidence Collector — AGY, fresh agent**

Claude is excluded from every audit role because the rubric, calibration labels,
and audited-run supervision originated with Claude supervisor
`ae889b24-df67-4b77-904b-2ee8db0b00cb`. No agent that authored the rubric,
scoped or promoted this plan, participated in the audited run, dispatched its
workers, gated its results, or supplied calibration claims may audit any part of
the run.

The collectors gather standardized evidence but do not score, assign moral
labels, rank findings, or construct Part C. The Lead Auditor alone owns evidence-
tier application, temporal normalization, the A/B scorecard, all Part C exhibits,
the verdict, and recommendations. This is the cheapest split that adds context
headroom without fragmenting C1 or C4; more collectors add reconciliation cost,
while one auditor spends too much context establishing the population before
reaching the cross-cutting analysis.

## Agent briefs

### Agent-Evidence Collector

Collect the human/agent register:

- Establish all participating agent and session IDs, including renewed sessions
  of the case-study agent.
- Read `get_orchestration_run` for membership, relay structure, timing, and stalls.
- Read every participant's launching `user` brief.
- Read every dispatched worker's final `assistant` message and corresponding
  supervisor gate turn.
- Read complete structured chat for every case-study-agent renewal and every
  crash, uncommitted stop, re-dispatch, contradiction, or apparent tier conflict.
- Use `read_agent_files_touched` to locate evidence, never to measure effort.
- Establish checkpoint capture health before relying on witnessed activity.
- Use `read_agent_log` only for a specific forensic question left unresolved by
  structured chat.

Write only
`.lares/research/inbox/packet-agent-evidence.md`. Do not consult the sealed
calibration set and do not propose scores.

### Surface-Evidence Collector

Collect the machine register:

- Enumerate plan folders under `.lares/plans/` and the `.dashboard/plans/`
  fallback when present. Separately enumerate legacy workspace-root
  `plans/*.html` and `plans/*.md`.
- Enumerate `.lares/proposals/` and `.lares/proposals/supporting/`.
- Read from every relevant plan folder: `plan.md`, `plan.json`, `ARC.md`, and
  relevant files under `supplements/`, `deliberations/`, and `research/`.
  Read `OVERVIEW.md` only when present.
- Parse proposal frontmatter for identity checks; do not grep for the string
  `artifact_id`.
- Inspect linked commits with read-only git operations. Record the comparison
  remote and branch before describing a commit as pushed.
- Use `list_checkpoints` first for paths and capture health, then `diff_turn`
  only for implicated turns, capped at 300 diff lines per call.
- Record PLAN-INTENT and PLAN-INTEGRATION linkage, assignment history, active
  returned outputs, work-package linkage, gates, commits, and freshness evidence.
- Identify candidate trace breaks and silent failures without ranking or scoring.

Write only
`.lares/research/inbox/packet-surface-evidence.md`. Do not consult the sealed
calibration set.

### Lead Auditor

Collector assertions are leads, not evidence. To avoid repeating collection, the
lead's required first-hand re-read is strictly bounded to:

- primary artifacts for every hop in the selected C1 trace;
- the primary citation anchoring each A1–A8 and B1–B9 score;
- primary context surrounding each C4 candidate;
- primary text for every collector-reported anomaly or tier conflict;
- capture-health records for checkpoint-dependent conclusions.

The lead also reads the rubric without the sealed appendix and the case-study
plan's `plan.md`, `plan.json`, and `ARC.md`. It must not cite a packet as a
substitute for the underlying source. The lead alone constructs C1 and C4 and
writes only `.lares/research/inbox/planning-surface-audit-report.md`.

## Standard evidence-packet schema

Each packet begins with:

```yaml
packet_version: 1
collector_role: agent-evidence | surface-evidence
collector_agent_id: <id>
collector_provider: codex | agy
audited_run_participant: false
rubric_or_calibration_author: false
calibration_accessed: false
collection_started_at: <ISO-8601>
collection_ended_at: <ISO-8601>
retrieved_token_estimate: <integer>
working_turns: <integer>
raw_log_tokens: <integer>
budget_exceptions: []
```

The body contains:

1. **Population:** agent, session, orchestration, plan, proposal, package, and
   commit IDs, including how renewed sessions were associated.
2. **Coverage ledger:** source ID, type, evidence tier, inclusion state and
   reason, and retrieved bytes or estimated tokens.
3. **Sampling ledger:** every brief and final/gate pair, every full transcript,
   every omitted transcript, the deterministic selection rule, and budget cutoff.
4. **Evidence rows:** stable local ID, neutral factual claim, implicated rubric
   dimensions, tier, exact locator, observation time, time described by the
   source, capture health, corroborating/conflicting IDs, and limitations.
5. **Candidate anomalies:** possible trace break, stale claim, scope drift,
   capture gap, or silent failure, plus what the lead must read to resolve it.
6. **Budget report:** limits reached, raw-log/diff escalations, and mandatory
   evidence not collected.

Packets contain no scores, moral labels, verdicts, recommendations, or completed
C1/C4 exhibits.

## Context and turn budgets

Each collector receives one working turn, at most 40,000 retrieved-source tokens,
and at most 5,000 output tokens. The Agent-Evidence Collector may retrieve at
most 4,000 tokens from `read_agent_log` across no more than two escalations. The
Surface-Evidence Collector uses no raw log unless the agent packet identifies a
specific unresolved need; any such use shares the same 4,000-token/two-escalation
cap. Estimate tokens as `ceil(characters / 4)` when tools do not report them.

The lead receives:

- one independent turn with at most 80,000 retrieved-source tokens;
- one resumed calibration turn with at most 20,000 additional retrieved tokens;
- at most 12,000 output tokens for the final report;
- at most 6,000 raw-log tokens across no more than three escalations.

The total ceiling is four agent turns and approximately 180,000 retrieved-source
tokens. If mandatory coverage exceeds a ceiling, stop discretionary reading,
record the shortfall, and return the partial packet or report; never silently
truncate the population.

## Sampling rule and disclosure

Mandatory coverage comes first:

1. Every participant's launching brief.
2. Every worker's final assistant message and corresponding supervisor gate.
3. Every case-study-agent session, including renewals.
4. Every outlier: crash, uncommitted stop, re-dispatch, contradiction, capture
   gap, or claim conflicting with a higher tier.
5. Every hop in C1.
6. Every source used for a C4 entry.

For remaining middle transcript material, order sessions by start time within
`(provider, package)` strata. Include the first and last session per stratum,
then every `ceil(remaining_sessions / remaining_slots)`th session until the
budget is exhausted. Record the divisor and selected session IDs.

Always use `read_agent_chat` before `read_agent_log`, and `list_checkpoints`
paths-only before `diff_turn`. Cap each `diff_turn` result at 300 diff lines.

The report's Method and Coverage section states the total population, mandatory
items read, full transcripts and reasons, deterministic calculation, all skipped
or partial sources, ceilings reached, log/diff escalations, and capture-health
gaps.

## Independence and sealed calibration

Before dispatch:

1. Move the appendix claims verbatim from `plan.md` to
   `supplements/audit-calibration-set.md`.
2. Replace the appendix body in `plan.md` with a notice that the set is withheld
   until the independent baseline is locked.
3. Record the calibration file's SHA-256.
4. Exclude that path from both collectors and the lead's independent-phase tool
   boundary.

At the end of the independent phase, the orchestration captures and hashes the
lead's provisional scorecard, findings, C1, and C4. It then unseals the supplement
for the resumed lead turn. Calibration claims are hypotheses, not answer keys.
A mismatch alone cannot change a score. Any investigation or score modification
triggered by unsealing is labeled `[post-calibration lead]` and explains why it
was absent from the independent pass.

Before dispatch, compare every proposed auditor ID against
`get_orchestration_run`, participant/terminal listings, plan assignment and gate
events, artifact author metadata, and calibration authorship. Any match is
disqualifying.

The final report includes a Conflict of Interest section naming the rubric and
calibration author, that author's audited-run role, every auditor ID/provider and
eligibility result, calibration seal/unseal timestamps and hash, baseline hash,
and any prior exposure to expected findings.

If participation is discovered after collection begins, mark the affected packet
compromised and replace it. If the workspace owner explicitly accepts an
unavoidable exception, the Verdict begins `NON-INDEPENDENT SELF-AUDIT`, identifies
the conflicting roles and sections, treats that material as participant testimony
rather than independent corroboration, and requires an independent rerun.

## Mechanical read-only enforcement

Prompt instructions are not enforcement. Dispatch every auditor through a
restricted audit profile with four layers:

1. **Tool boundary:** allow file reads, listing/glob/search, read-only git,
   `read_agent_chat`, `read_agent_log`, `read_agent_files_touched`,
   `list_checkpoints`, `diff_turn`, `get_orchestration_run`, and agent listing.
   Allow writing only to the agent's exact designated outbox path.
2. **Explicit denials:** deny all other file writes/edits; plan
   create/update/delete; planning-event recording; checkpoint prune/revert;
   restore/revert operations; agent dispatch; orchestration launch; messaging;
   browser actions; notebook mutation; and network access. Do not expose retired
   plan-section routes.
3. **Snapshot and credentials:** run against a timestamped, read-only full copy
   of repository and `.lares` evidence. Keep outboxes outside the snapshot. Give
   MCP readers a read-only credential or proxy exposing only the named reads;
   never give auditors the original API bearer token.
4. **Integrity checks:** record the snapshot manifest and source commit; test
   before dispatch that a forbidden file write, plan update, checkpoint revert,
   and message/dispatch call fail; after completion compare the manifest and live
   source/DB mutation ledger with the pre-run state. Any unauthorized mutation
   invalidates the audit and is itself reported.

## Required rubric corrections

### Replace retired plan reads in §§2.9 and 3.3

`read_plan_projection` and `read_plan_section` are retired and must not appear in
the dispatch. Replace them with this order:

1. Enumerate `.lares/plans/`, then `.dashboard/plans/` when present.
2. Read `plan.md`, `plan.json`, and `ARC.md` directly from disk.
3. Read linked `supplements/`, `deliberations/`, and `research/` files.
4. Read `OVERVIEW.md` only when present; absence is not itself a defect.
5. Use `read_agent_chat` before `read_agent_log`.
6. Use `read_agent_files_touched` to locate evidence.
7. Use `get_orchestration_run` for membership, timing, and relay structure.
8. Use capture-health-validated `list_checkpoints`, then bounded `diff_turn` for
   implicated turns.

The implementation cites the empty read definitions at
`scripts/mcp-tools-plans.js:23` and `:100`, the registered plan operations at
`src/main/api-server.ts:3655`, and the retired-route 404 test at
`src/main/api-server-plans.test.ts:259`.

### Replace A8

#### A8. Durable lifecycle and handoff discipline

*Did plan-bound work leave a reconstructable trail through supported surfaces
while respecting ownership boundaries?*

Probes:

- Did `plan.json` record assignment and lifecycle through the manifest helper?
- Do PLAN-INTENT and PLAN-INTEGRATION markers link active decisions to outputs?
- Did workers return evidence without mutating supervisor-owned plan state?
- Did the responsible supervisor perform integration and ARC freshness updates?
- Can worker turns and gates connect to packages and commits through supported,
  server-witnessed records?
- Were ownership conflicts refused or system-enforced?

Anchors:

- **0:** Ownership or lifecycle state is missing or misleading, and the work
  cannot be connected to its plan without participant explanation.
- **2:** The chain is reconstructable, but some handoffs, integrations, or
  freshness signals require inference.
- **4:** Assignment, intent, returned output, integration, gate, and commit
  linkage are explicit for every applicable hop; ownership boundaries are
  respected; gaps are visibly signaled.

Do not score PLAN-EVENT emission, `writeCounts`, `sec_exectr`, generated Execution
Trail lines, or per-turn checkmarks. These belong to the retired section surface,
and live worker instructions are tested to omit the sentinel at
`src/main/supervisor/scaffold-version-migration.test.ts:3649`.

### Make clean runs scoreable

Add this rule before Parts A and B:

> Incident-dependent examples are corroborating evidence, not prerequisites for
> a 4. Score observed opportunities and inspectable, load-bearing mechanisms. A
> 4 means every applicable observed opportunity was handled correctly and the
> controlling mechanism is independently verifiable. If the triggering condition
> never occurred and no mechanism is inspectable, record `N/O`, explain why, and
> exclude the row from the numeric denominator. Do not award or deny points for
> an incident the run never had.

Use:

```text
Adjusted percentage = points earned / (4 × (total rows - N/O rows)) × 100
```

The scorecard displays points earned, maximum applicable points, `N/O` count, and
adjusted percentage. Incident-dependent anchors are rewritten so, for example,
A3 rewards re-derivation wherever inherited values occur rather than requiring a
stale value, while A6 is `N/O` when neither a blocked turn nor an inspectable
recovery mechanism exists.

## Implementation instructions

1. Edit
   `.lares/plans/2026-08-07-planning-surface-audit-rubric-and-method-for-an--65e665d7/plan.md`:
   replace §§2.9 and 3.3; replace §3.4 with the bounded sampling rule; add the
   topology, budgets, independence and read-only rules; replace A8; add clean-run
   scoring; and require conflict/calibration disclosure in §7.
2. Create
   `.lares/plans/2026-08-07-planning-surface-audit-rubric-and-method-for-an--65e665d7/supplements/audit-calibration-set.md`
   with the appendix claims verbatim and their existing warning.
3. Replace the appendix claims in `plan.md` with the sealed-calibration protocol
   and a link unavailable to auditors until baseline lock.
4. Configure and verify the restricted audit profile, exact outbox paths,
   read-only snapshot, and read-only API proxy before dispatch.
5. Dispatch both collectors concurrently. After both packets return, dispatch
   the lead's independent turn, lock and hash its baseline, unseal calibration,
   and resume the lead once.
6. Accept the report only if packet schemas validate, eligibility passes,
   calibration remained sealed, budgets and sampling are disclosed, and post-run
   integrity checks show no audit-caused mutation.



<!-- groupthink_run: 085f680a (mode=serial) -->
