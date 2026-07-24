---
name: context-analytics
description: Analyze context overhead, guidance liveness, and tool/skill usage in this workspace from an exported analytics snapshot (CSV + JSON on disk). Use when asked what is costing context, which guidance or tools are unused, whether an agent's prompt is bloated, what changed between two points in time, or to justify adding/removing a toolset, skill, or CLAUDE.md section. Replaces the retired `observability-analytics` MCP tools — do not look for `get_file_heat`, `get_skill_usage`, `get_context_optimizer_*`, `get_agent_knowledge*`, `get_improvement_*`, or `get_mcp_tool_usage`; emit a snapshot instead.
---

# Context analytics from an exported snapshot

The analysis surfaces that used to be 13 always-resident MCP tools are now emitted
to disk on demand. You run one command, then read CSV and JSON. Nothing is
resident until you ask for it.

The exporter calls **the same DTO builders** the old MCP routes called, drained to
completion. The rows are not a reimplementation — where a field is captured it is
byte-identical to what the tool returned.

## 1. Emit a snapshot

```bash
cd <workspace-root>
npm run analytics:snapshot:fast -- export --json
```

Measured: **~21–26 s**, exit 0, six surfaces `ready`. Writes to
`.lares/analytics/<ISO-timestamp>-<id8>/`. `--json` prints the manifest
summary — read the `blockingCaveats` array it returns before anything else.

- `analytics:snapshot:fast` runs the **existing** `dist/`. Use it when `dist/` is
  current. Use `npm run analytics:snapshot` to rebuild first — but that runs
  `build:main`, so do not use it if another agent is mid-build.
- Runs under Electron (for the `better-sqlite3` native ABI) but builds **no**
  window, supervisor, API server, or watcher. It opens the database **read-only**
  and never writes to it. Verified working from a worker's context with the
  Lares app running. *Not verified with the app closed.*
- Useful flags: `--output-root <path>` (write somewhere other than
  `.lares/analytics/`, e.g. a scratch dir — also avoids pruning existing
  snapshots), `--keep N` / `--no-prune` (retention, default keep 10),
  `--workspace <id-or-path>`, `--allow-cold`.
- Exit codes: `0` complete · `1` usage error or core-surface failure (nothing
  published) · `2` partial, published with ≥1 per-item failure · `4` indexing
  incomplete and `--allow-cold` not given.

If exit is `2`, check `surfaces.*.status` in the JSON before citing anything from
a failed surface. If exit is `4`, the parse index is cold — the numbers would read
as *low usage* rather than as an error.

## 2. The six CSV tables

All live in `<snapshot>/tables/`. **Every table has a trailing `caveat_codes`
column** listing the caveats that apply to that row — read §5 before citing.

| table | one row per | columns you will actually use |
|---|---|---|
| `agents-overhead.csv` | agent/lane (4 rows: supervisor, researcher, worker-claude, worker-codex) | `lane`, `resident_tokens`, `on_demand_tokens`, `total_tokens`, `exactness` |
| `mcp-tool-usage.csv` | MCP tool — **TOP 15 ONLY** | `tool_short`, `toolset`, `calls`, `distinct_streams`, `last_ts_ms` |
| `skill-usage.csv` | skill | `skill`, `invocations`, `avg_effectiveness`, `last_used_ms`, `scored_invocations` |
| `file-heat.csv` | file path | `path_display`, `path_scope`, `lane`, `reads`, `writes`, `executes`, `distinct_streams`, `coverage`, `role`, `guidance_gap` |
| `proposals.csv` | optimizer proposal | `kind`, `lane`, `resident_token_delta`, `token_turns_weight`, `verified`, `verification_state`, `evidence_state` |
| `plans.csv` | plan | `title`, `status`, `section_count`, `section_write_events` |

### `mcp-tool-usage.csv` is capped at 15 rows — this is a trap

The cap is `topTools: 15` (`agent-dto.ts:383`), applied **upstream in the shared
rollup builder**, so the JSON surface (`surfaces/mcpToolUsage.json` →
`data.rollup.byTool`) is capped too. The retired MCP tool had the identical cap.

**A tool absent from this table has UNKNOWN usage, not zero usage.** You cannot
call a tool unused from this file. Say "not in the top 15 of 2,807 attributed
calls" and stop there.

## 3. The joins that matter

### Schema cost per tool → `surfaces/contextOverhead.json`

Per-tool schema cost is **not** in any CSV. It is at:

```
data.agents[] .mcpServers[] .tools[] .estimate.tokens
                                     .descriptionTokens
                                     .inputSchemaTokens
```

Summing `estimate.tokens` per `mcpServers[].displayName` gives the resident cost of
a whole toolset — this is how you price "what would deleting this toolset save".
`grantedToAgent` and `excludedByStrictMode` tell you whether the lane actually
loads it. Cross-check against `data.measuredMcpInventory[]` (`countedTokens`,
`toolCount` per lane).

### Cost against usage

Join `mcpServers[].tools[].name` (short name) to `mcp-tool-usage.csv`'s
`tool_short`. High schema cost + high calls = earning its keep. High cost + absent
from the table = **unknown**, go to §4 before concluding anything.

### Guidance liveness

- `surfaces/agentKnowledge.json` → per-agent `nodes[].behavior.status`, one of
  `observed` / `never-observed` / `insufficient-exposure` / `unobservable`, with
  `occurrences`, `exposureTurns`, `distinctStreams`, `windowDays`. **This is the
  surface that answers "what guidance is unused"** — `never-observed` means
  observable, enough exposure, zero matches.
- `surfaces/optimizer.json` → `data.proposalEvidence[<id>]` gives the raw
  numerator/denominator behind a `subtract-dead-guidance` proposal (e.g.
  `numerator.occurrences: 0` over `denominator.turns: 5178`). Only a few
  proposals carry evidence; the rest are `evidenceState: unavailable`.
- `surfaces/optimizer.json` → `data.analyzability[]` explains **why** a section
  could not be judged: reason codes `pure-prose`, `capture-missing`,
  `exposure-low`, each with `residentTokens` and `trappedCostWeight`.

### `contextOverhead.json` → `workspaceConfigWeight.sections[].weightClass` emits `live`/`dead` — NEVER

`SectionWeightClass` has six values, but the structural classifier **only ever
emits four**: `structurally-broken`, `insufficient-evidence`, `unobservable`,
`not-analyzed`. `live` and `dead` require a behavior corpus that is not wired into
this classifier (`src/shared/types.ts:1806-1808`, stated in the source comment).

So a count of `live: 0, dead: 0` on this surface is an **unimplemented feature, not
a finding**. Do not report it as "no guidance is live". `structurally-broken` on
this surface *is* real and actionable — a reference that provably does not resolve.
For actual liveness use `agentKnowledge` above.

## 4. The recency trap — date before you call anything dead

**Zero or absent usage can mean "created last week", not "abandoned."** This
mistake was made during the analysis that produced this skill.

Before writing that any tool, skill, or section is unused, date it:

```bash
git log -S"<tool_or_skill_name>" --format="%ad %h %s" --date=short --reverse -- scripts/ | head -3
git log --diff-filter=A --format="%ad %h" --date=short -1 -- <path>
```

Worked example: the 13 `observability-analytics` tools (retired in favour of this
skill) showed no usage anywhere in the snapshot. `git log -S get_file_heat` dates
their introduction to **2026-07-15** — they were six days old when that was
measured. Their absence was youth, not death, so the retirement had to be argued
on measured *cost* (≈3.2k resident tokens on the supervisor lane), never on
"nobody called them". Make the same distinction for whatever you are judging.

Compare the age against `windowDays` on the behavior evidence (default 30) and
against `last_used_ms` / `last_ts_ms`. If the thing is younger than the evidence
window, the window has not had a chance to observe it and **no liveness claim is
available at all**.

## 5. The caveat registry — read it before citing any number

`<snapshot>/snapshot.json` → `caveats[]`, machine-readable, 11 entries. Each has
`id`, `severity` (`blocking` | `advisory`), `statement` (full prose), `evidence`
(source file:line), `fields` (JSON pointers to the affected values), `matchedIds`,
and `observed` (whether it actually fired in this snapshot). `SUMMARY.md` renders
the same registry as prose.

**Workflow: for every number you are about to cite, look up the row's
`caveat_codes` and read the matching `statement`.** The registry is deliberately
written to stop you making a specific wrong claim.

### The five blocking caveats and what each forbids

| id | what it forbids |
|---|---|
| `SYSTEM_BASELINE_EXCLUDED` | **Never compute a percentage-of-context.** Totals here are agent-variable only; Claude Code's own base prompt and built-in tool schemas (~29k of a ~46k supervisor startup prompt) are measured by nobody. `data.systemBaseline` is `null` and no code populates it. These totals are a **floor**. Comparing two agent-variable totals to each other is fine; dividing one by "context" is not. |
| `TOKEN_COUNTS_ESTIMATED` | Check `data.estimatorMethod`. `tiktoken-approx` = real cl100k_base BPE, which is a *different tokenizer* than Anthropic's, not a guess. A chars-heuristic fallback is much weaker. Either way, don't cite tokens to the last digit; round and say "estimated". |
| `CROSS_SURFACE_COUNTS_NOT_COMPARABLE` | **Never combine an `mcp-tool-usage` count with an optimizer cluster-exemplar count** in one claim, ratio, or delta. They disagree on the same verb (e.g. `read_agent_chat` 471 vs 576) and neither declares its scope or time window. |
| `DERIVATION_GATE_ALWAYS_UNVERIFIED` | `verified: false` on every proposal is a **wiring state, not a score**. `honestDerivation()` hard-returns false for all lanes. Do not restate it as "low confidence" or "unverified (pending)", and do not read a zero verified-count as "nothing qualifies". |
| `IMPROVISATION_CLUSTER_INCLUDES_ROUTINE_TOOL_USE` | `add-cluster-rollup` proposals fire on **ordinary tool use** (top members were `Bash` ×2554, `Edit` ×1402, `Read` ×1070). Those are baseline activity, not a missing-guidance opportunity. Never let one motivate work; its count is diagnostic only and must not appear in a headline, summary, or percentage. |

Two advisories flip to **blocking** when their condition holds — check
`provenance.indexState`: `INDEX_BACKFILL_SKIPPED_READ_ONLY` if
`epochsBackfilled: false`, `INDEX_INCOMPLETE` if `skillIndexComplete: false`.
Under either, a zero means "not yet parsed" and the subtract classification is
unreliable.

`REDACTION_IS_LOSSY` matters when you want to *act*: paths are scope-prefixed
(`$WORKSPACE/…`, `$DASHBOARD/…`) and Claude project slugs become
`<slug-xxxxxxxx>`. Absolute paths are **not** recoverable from the snapshot — you
must re-expand the prefix yourself from the workspace root you already know. Join
on `path_hash` for identity across snapshots.

## 6. Comparing two points in time

```bash
npm run analytics:snapshot:fast -- diff <before-dir> <after-dir> --format markdown --output <path>
```

Also `--format json`. Verified working on real snapshots: it reports per-agent
resident/on-demand deltas, added/removed/changed keyed rows per surface, and
caveats new in `after`.

**Read the generationId table at the top first.** If a surface reports
`generationId held: no`, the diff prints an explicit warning — the delta on that
surface mixes your change with **organic corpus drift** and cannot be attributed
to a single cause. Two snapshots taken 3.5 minutes apart during ordinary work
already showed a −351-token supervisor delta from unrelated edits.

## 7. Reporting rules

1. Name the snapshot id and capture time for every figure.
2. Attach the row's `caveat_codes` to any number you quote.
3. Never state a percentage of total context (`SYSTEM_BASELINE_EXCLUDED`).
4. Never call something unused without a `git log` date (§4).
5. Absent from a capped table ≠ zero. Say "unknown".
6. If a surface is `partial` or its status is not `ready`, say so instead of
   quoting it.
