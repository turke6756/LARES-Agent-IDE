# Supervisor "24% at /clear" — Context Overhead Investigation

**Investigator:** Supervisor agent `431e517b` (self-analysis — I am a freshly-cleared
supervisor sitting at exactly the 24% the user asked about).
**Date:** 2026-07-19
**Method:** Dashboard-native context-optimizer tools (`get_context_stats`,
`get_context_optimizer_proposals`, `get_context_optimizer_analyzability`,
`get_context_optimizer_proposal[_evidence]`, `get_mcp_tool_usage`,
`get_skill_usage`) + direct byte measurement of the CLAUDE.md files.

> **STATUS: v1 findings below were adversarially reviewed by a parallel GroupThink
> run (runId 8f6edad8). Three of my claims were corrected against source code. The
> corrected conclusions are in this banner; the worker-ready plan is at
> `plans/context-overhead-review.md`. Read the corrections FIRST — the v1 body is
> kept for provenance but is superseded where they conflict.**
>
> **CORRECTION 1 — the baseline number.** The true fresh-clear startup prompt is
> **~46,353 tokens** (first assistant `usage`: `cache_creation 20,403 + cache_read
> 25,948 + input 2`), gauge ≈47,197 ≈ 24%. The `47,275 cache_read` I cited was
> sampled several turns later and had absorbed my own conversation — wrong
> component. Correct startup metric = `input + cache_creation + cache_read` from the
> **first** assistant usage record, output excluded. Outcome unchanged (~24%), method
> was wrong.
>
> **CORRECTION 2 — drop the "83% immovable floor" framing.** That 39k was a
> *residual* (subtraction), never a measurement, and it wrongly filed *controllable*
> things (skill-ad metadata; possibly native built-in tool schemas) as "immovable."
> Replace with THREE honestly-separated buckets, with the split between (b) and (c)
> **not yet measured**: (a) directly-controllable text = the two CLAUDE.md files +
> local skill ads; (b) Lares-configurable harness surface = native `--tools` grant,
> MCP toolset grants, global-MCP inheritance, shipped skills; (c) genuinely-fixed
> Claude Code remainder = only what survives controlled `--tools`/MCP-isolation
> experiments. `chars/4` also *undercounts* this tool-name-dense markdown (~3.6–3.9
> chars/tok), so the controllable slice is a bit larger than my 17%.
>
> **CORRECTION 3 — the real proof of deadness is GRANT, not behavior, and the cut is
> bigger.** `toolsetsForLane('supervisor')` (`src/main/supervisor/mcp-config-builder.ts:52`)
> grants only `orchestration, comms, observability-core, observability-analytics,
> plans, browser-present`. **Teams and Notebooks toolsets were deliberately removed;
> full `browser` is researcher-only.** So the persona's entire **Teams (~978 tok),
> Notebooks (~571 tok), and full-Browser (~829 tok) sections document tools the
> supervisor CANNOT CALL** — provably dead, delete-not-compress. The behavior-only
> optimizer couldn't see this (no events for an ungranted tool is indistinguishable
> from capture-missing) — the grant-topology cross-check is the missing lever, and a
> `supervisor-persona-capability-parity.test.ts` should enforce it going forward.
>
> **CORRECTION 4 — mechanism.** The supervisor `CLAUDE.md` is a GENERATED scaffold
> from `SUPERVISOR_AGENT_MD` (`src/shared/constants.ts:312`), written with a
> version/hash silent-upgrade map (`index.ts:2165`, v11). Editing the `.md` directly
> is void — fixes must edit the constant, bump the scaffold version, and register the
> prior hash. `MEMORY.md` is seed-once / `autoMemoryEnabled:false` — NOT resident
> startup context; don't count its bytes.
>
> **CORRECTED BOTTOM LINE:** Tier-1 deletions (ungranted Teams/Notebooks/Browser +
> obsolete PowerShell + defer orchestration detail to its skill) take the persona
> ~6.8k → ~3.7k, saving ~3.0–3.3k tokens → **visible baseline ~24% → ~22%.** Sub-22%
> is NOT reachable by prose editing — it depends on the untested native-`--tools`
> schema-residency experiment, which is the only lever that could beat the rewrite
> and should be measured first.

---

## 1. The headline number is real and I reproduced it on myself

`get_context_stats` for this freshly-cleared supervisor:

- `cacheReadTokens = 47,275` — this is the **fixed cached prefix** replayed every
  turn = the baseline overhead.
- 47,275 / 200,000 ≈ **23.6% ≈ the "24%" the user sees.**
- A `/clear` starts a new session under the same dashboard agent id but rebuilds
  this identical prefix, so every cleared supervisor re-lands at ~24%. Confirmed:
  it is NOT leftover conversation — it is the static prompt prefix.

## 2. What the 47k baseline is actually made of

Measured directly (chars/4 ≈ tokens):

| Component | Bytes | ~Tokens | Share of 47k | Controllable? |
|---|---|---|---|---|
| **Supervisor CLAUDE.md** | 27,302 | **~6,800** | ~14% | **YES (repo)** |
| **Workspace CLAUDE.md** (Lares) | 4,150 | ~1,040 | ~2% | YES (repo) |
| Supervisor MEMORY.md | 329 | ~85 | <1% | YES (repo) |
| **Project instructions subtotal** | | **~7,900** | **~17%** | **YES** |
| **Platform floor** (Claude Code system prompt + built-in tool schemas + skill advertisements + deferred-tool registry + system reminders) | | **~39,350** | **~83%** | **NO (Claude Code)** |

**The single most important finding for the user:** the CLAUDE.md files are **NOT**
the bulk of the 24%. The two CLAUDE.md files together are only ~7.9k tokens (~4% of
the 200k window). The other **~39k tokens (~20% of the window) is an immovable
Claude Code platform floor** — the harness system prompt plus the built-in tool
schemas (Bash/PowerShell, Workflow, Artifact, Agent/Task, AskUserQuestion are each
individually multi-thousand-token descriptions), the ~40-skill advertisement block,
and the deferred-tool name registry. None of that lives in this repo; it ships with
the CLI. So **no amount of CLAUDE.md editing can take the baseline much below ~21%.**

Note on MCP tools: in THIS harness build, the dashboard's ~60 MCP tools are
**deferred** (surfaced on demand via ToolSearch), so they are NOT all sitting in
the baseline — only their names in the registry. On older Claude Code builds where
all MCP schemas load up front, the MCP contribution to baseline would be far larger.
This is worth flagging: the same supervisor on a non-deferred build would start
much higher than 24%.

## 3. The controllable slice — supervisor CLAUDE.md (~6,800 tokens)

This is the only meaningful lever the user owns. The optimizer gives concrete,
evidence-backed "dead guidance" verdicts — sections that shaped **zero observed
behavior** across thousands of supervisor turns:

### Evidence-backed dead sections (optimizer `occurrence: never`, `observed`):

1. **"Platform notes (Windows + PowerShell 5.1)"** (line 166, ~260 tokens)
   - Matcher `command-family: powershell`, **0 occurrences** in the numerator across
     **280 streams / 5,027 exposure turns**. Supervisors never actually run the
     PowerShell-quoting launch pattern this section warns about. `tokenTurnsWeight`
     = 1,307,020 (the highest-weighted subtract in the whole workspace).
   - Verification state: `unverified` / `requiresDerivationGate` (candidate — the
     gate hasn't formally certified it, but the raw evidence is a clean 0/5027).

2. **"Notebooks (live kernel) > Gotchas"** (~111 tokens) — `occurrence: never`,
   observed. Never fired for the supervisor lane.

3. **Browser-tools grant-mismatch** (line 220, ~91 tokens, `observed-safe`,
   `actionable`) — the persona documents the `browser` automation toolset
   (`browser_click`, `browser_read_page`) but the supervisor lane is **not granted
   it**. Pure dead weight. (Nuance: `browser_open_url` IS available and maps
   ambiguously to two toolsets, so only the full-automation docs are dead — verify
   before cutting the whole Browser section.)

4. **Unused skill advertisements** injected into the persona:
   - `create-persona` (~109 tokens) — `usageCoveragePct 22%`, never used by this lane.
   - `orchestration-spike` (~49 tokens) — never used.

Directly-flagged safe cuts total **~620 tokens**. Small vs. 6,800 — because most of
the file is `pure-prose` the classifier **cannot mechanically prove dead** (189
not-analyzable sections, reason `pure-prose`). That is a blind spot, not a
clean bill of health.

### The larger opportunity (judgment, not machine-verified)

The supervisor CLAUDE.md is ~6.8k tokens of heavily verbose prose. Big blocks —
**Teams** (create_team/disband/add_channel/... full tool catalog), **Multi-agent
orchestration two-paths**, **Notebooks kernel-tools catalog**, **Browser tools**,
**Platform notes** — read like reference documentation, not just-in-time operating
guidance. Much of this duplicates what the MCP tool schemas themselves already say
when a tool is actually invoked. Realistic compression target: **~6,800 → ~3,500
tokens** (cut dead sections + move tool-catalog prose into the tools' own
descriptions / a skill that loads on demand).

## 4. Realistic ceiling on improvement

- Aggressive-but-safe supervisor CLAUDE.md rewrite: save **~3,000–3,300 tokens**.
- Trim workspace CLAUDE.md a little: save ~300–500.
- **Net baseline: 24% → ~21–22%.** The floor stays ~20% no matter what.

So the honest answer to "can we get it lower": **yes, by ~2–3 points, not to zero.**
The context-overhead tool did its job — it proved the waste is small relative to a
fixed platform floor, and it named the exact dead sections worth cutting.

## 5. Concrete recommendations (for review)

- **R1.** Cut the PowerShell "Platform notes" section (0/5027 evidence) — highest
  weight, cleanest evidence. Keep a one-line pointer if desired.
- **R2.** Cut the Notebooks "Gotchas" subsection for the supervisor lane.
- **R3.** Remove/verify the Browser automation section given the grant-mismatch.
- **R4.** Drop the `create-persona` and `orchestration-spike` skill advertisements
  from the supervisor persona (keep `run-orchestration`, `read-comments`).
- **R5.** Compress the Teams + Multi-agent + Notebook tool-catalog prose ~50%; rely
  on the live MCP tool schemas for the argument-level detail.
- **R6.** Bigger structural idea: move rarely-needed reference blocks (notebooks,
  browser, platform quoting) OUT of always-resident CLAUDE.md and INTO an on-demand
  skill the supervisor loads only when the task needs it. This is the only way to
  meaningfully shrink resident overhead without losing the knowledge.
- **R7.** Confirm whether target deployments run a deferred-MCP build; if any run
  all-MCP-loaded, that is the real overhead lever (dwarfs CLAUDE.md).

## 6. Open questions for the reviewers

- Is my ~39k "platform floor" estimate right, or is some of it actually trimmable
  (e.g., are all built-in tools like Workflow/Artifact truly needed for a supervisor
  whose job is orchestration, or could a slimmer tool grant cut baseline)?
- Is halving the supervisor CLAUDE.md safe, or does the verbose prose carry behavior
  that the behavior-only classifier can't see (it admits 189 pure-prose blind spots)?
- Should the fix be "edit CLAUDE.md" or "restructure into on-demand skills"?
- Does the deferred-tool design mean the 24% is already near-optimal for this build?
