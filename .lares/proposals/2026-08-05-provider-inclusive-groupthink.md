---
artifact_id: prop_pigt5a83
title: Provider-inclusive GroupThink + user-shapeable provider selection
author: "expanding groupthinks to other providers" (workspace supervisor, AgentDashboard)
author_agent_id: e7927835-d0ab-407e-86af-be6de72c2cc1
author_role: supervisor
author_provider: claude
authored_at: 2026-08-05T00:30:00-07:00
amended_at: 2026-08-06
promoted_to: 2026-08-05-provider-inclusive-groupthink-user-shapeable-pro-pigt5a83
promoted_at: 2026-08-05
---

# Proposal: provider-inclusive GroupThink deliberations + a user-facing provider-steering surface

Produced from serial GroupThink run `27d25aa3` (Lead: claude, Reviewer: codex).
Full deliberation with file:line targets and the complete test matrix:
`.lares/proposals/supporting/2026-08-05-provider-inclusive-groupthink-deliberation.md`.
Sibling effort: `.lares/proposals/2026-08-04-multi-provider-supervisors.md`
(who holds the supervisor lane); this proposal governs which providers a
supervisor pairs **inside a GroupThink** and how the user shapes that choice.

## Problem

The app now launches four providers (claude, codex, grok, agy), but GroupThink
is claude+codex in practice: the catalog copy asserts "only claude writes
reliably," the MCP params are unvalidated free strings, and there is no
mechanism — config, lesson, or memory — by which the user shapes which
providers a supervisor reaches for.

## Answer to the "lesson vs memory vs config" question

**Config is the right path.** A durable, workspace-scoped preference is exactly
what a settings surface is for:

- **Config (adopted):** deterministic, visible, editable, survives supervisor
  turnover, enforced by the service — not dependent on an agent remembering to
  read anything.
- **Lesson (optional soft layer):** "which pairing when" judgment is
  user-authored guidance, fine as prose/examples, never the enforcement path.
- **Memory (rejected):** memory is workspace *state* with an open-loop
  lifecycle; a standing preference doesn't expire and doesn't belong there.

## Design (normative decisions from the deliberation)

**Preference ladder** — explicit per-run arg → workspace GroupThink default
(persisted settings file) → built-in default (lead=claude, reviewer=codex).
All layers yield only `{claude, codex, grok, agy}`; `gemini` is 422-rejected on
every explicit path.

**Availability is a filter over preference (added 2026-08-05 per Edward).** The
ladder above chooses the *desired* provider; a separate runtime signal reports
which providers are actually usable right now, and the supervisor reconciles the
two. Preference is honored when the provider is available; when it is not, the
supervisor substitutes an available provider and states why. This is not
optional polish — a preference naming an unavailable provider otherwise stalls
the whole run. Observed live 2026-08-05: a grok worker hit its free usage limit
and was dead on arrival, and agy has previously latched a sign-in banner; both
are exactly the "named but unusable" case this layer must catch.

- **Availability signal.** The dashboard already knows which providers are
  installed + configured (statically launchable). Extend `get_my_context` (and
  the `/api/supervisor/context` payload) with an `availableProviders` list
  carrying a per-provider status: `available` / `degraded` (e.g. known
  auth-banner or reattach quirk) / `unavailable` (not installed/configured), and
  where knowable a quota note (Claude via `get_usage_limits`; others best-effort,
  since grok/agy quota is not exposed until a call fails). Runtime failures the
  supervisor observes (the grok limit we just hit) refine the picture within a
  session but are not a substitute for the static list.
- **Resolution rule.** effective = (preference ladder result) **if available**,
  else the supervisor picks an available provider — respecting any user-supplied
  fallback order if we add one, otherwise its own judgment — and reports the
  substitution in the preflight confirmation before spend. Availability never
  *silently* overrides an explicit user choice; it surfaces the conflict.
- **User preference stays authoritative when it can be satisfied.** The user
  sets what they want; the supervisor only deviates when the wanted provider
  cannot run. This is the "user sets preferences, supervisor adapts when they're
  unavailable" behavior Edward asked for.

**Inclusion is unconditional.** Any of the four providers may fill either slot.
Writer reliability is settled by recorded live evidence (the runner already
fails closed on a non-writing writer via `STALL:`), never by product policy
that permanently rejects a provider.

**Read-recovery ≠ write-validation.** A corrupted settings file sanitizes
per-field to defaults on load (never crash a launch); an explicit update with
an invalid provider is strictly rejected (422/typed IPC error) leaving prior
settings untouched.

## Work packages (summary — details in the supporting doc)

- **A1** Canonical `LAUNCHABLE_AGENT_PROVIDERS` const + guard in
  `src/shared/types.ts`; parity test against the JS MCP enums (which stay
  literal duplicates).
- **A2** Positive provider validation in
  `src/main/orchestration/service.ts` (replaces gemini-only checks).
- **A3** Enum `lead_provider`/`reviewer_provider` in
  `scripts/mcp-tools-orchestration.js`.
- **A4** Reframe catalog copy: describe the writer slot's job, drop the
  claude-only claim.
- **A5** Resume runs 409 on provider mutation (never silently switch).
- **A6** **Manual acceptance WP** (requires explicit user approval — up to 16
  live runs): writer-capability matrix, 4 execution shapes × codex/grok/agy +
  claude controls → `supporting/provider-writer-capability.md`.
- **B1** New workspace-scoped settings module
  `orchestration-provider-settings.ts` (namespaced
  `groupthink.defaultLeadProvider/defaultReviewerProvider`, atomic save,
  per-workspace cache).
- **B2** Service coalesces workspace defaults as ladder layer 2.
- **B3** Preflight visibility: defaults exposed via `/api/supervisor/context`
  → `get_my_context`, so the supervisor confirms the effective pairing with
  the user **before** spend.
<!--PLAN-INTENT
{ "intent_id": "int_a7b3c9e2", "part": "b3a-availability-signal",
  "kind": "groupthink-serial",
  "targets": [ { "provider": "anthropic", "model": "claude-opus-4-8" },
               { "provider": "codex", "model": "gpt-5.1-codex" } ],
  "reason": "B3a was added after GroupThink run 27d25aa3 and lacks the file:line design + test-matrix hardening the rest of the proposal carries (availableProviders payload shape, degraded-status taxonomy, quota best-effort semantics, fallback-order question)" }
-->
- **B3a** Provider-availability signal: add `availableProviders` (status +
  best-effort quota) to `get_my_context` / `/api/supervisor/context`, and teach
  the run-orchestration skill flow to filter the preference ladder through it —
  honor preference when available, substitute + report when not. This is the
  "supervisor knows what's available and adapts" requirement.
- **B4** Renderer control: dedicated "GroupThink Providers" Tools tab
  (lead/reviewer selects, Save, Reset), workspace-scoped transport keyed
  exclusively off the authenticated `X-Workspace-Id`.
- **B5** `run-orchestration` skill scaffold constant v4→v5 (preflight flow +
  inherit/override semantics), hash-before-edit migration discipline.
- **C** Test matrix: enum parity, per-slot validation incl. same-provider
  pairs, read-recovery vs write-validation, precedence, resume-409,
  preflight, transport scoping, renderer workspace-switch races, scaffold
  migration, plus sibling suites.

## Scope boundaries

No supervisor-lane provider selection (sibling proposal owns it — the settings
namespace leaves room). No per-mode granularity. No runtime writer-ack gate.
`start_run`'s `{runId}` contract unchanged.

## Hardening scope
- **Verdict (dated):** 2026-08-05 — Parts A, B (except B3a), and C are already hardened: the proposal was produced by serial GroupThink run 27d25aa3 with complete file:line targets and test matrix in the supporting deliberation doc; they need no further deliberation — package and implement. B3a (provider-availability signal) postdates that deliberation (added per Edward 2026-08-05) and needs one serial GroupThink to harden its payload shape, status taxonomy, quota semantics, and fallback-order question to the same file:line standard.
- **Second opinion:** codex reviewer lane inside GroupThink run 27d25aa3 (the deliberation that produced Parts A/B/C); no second opinion yet on B3a — which is exactly why it carries the marked intent.
- **Marked intents:** int_a7b3c9e2 — harden B3a availability-signal design via groupthink-serial.

## Status

Proposal captured 2026-08-05; not yet scoped/promoted. Natural sequencing:
Part A + B are ordinary dispatchable WPs (codex workers per standing
directive); A6 waits for Edward's explicit go-ahead since it burns live
deliberation tokens.
