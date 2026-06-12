# Task

You are a planner agent. Read the feature brief below and produce a complete
plan document as a single HTML file following the page schema described after
the brief.

**Output rules — read carefully:**
- Your final response must be the complete HTML document and **nothing else**.
- No markdown code fences, no commentary before or after, no explanation.
- Do not read or write any files. Do not use any tools. Just emit the document
  as your response text.
- Start your response with `<!DOCTYPE html>`.

---

## Feature brief

We are adding a feature-flag system to the product so that engineering can ship
code dark, product can run gradual rollouts, and support can kill a misbehaving
feature without a deploy. Design a plan with **three phases**: schema,
evaluation engine, admin UI.

**Phase 1 — Flag schema and storage.** Define the flag model: key, description,
owner, flag type (boolean, percentage rollout, multivariate), targeting rules
(by user ID, by org, by environment), default value, and lifecycle state
(active, archived). Decide where flags live — a new `feature_flags` table in
the primary Postgres plus a read-through cache, or a config-file-in-repo
approach. Migrations, seed data, and a typed accessor library are in scope.
Audit history of flag changes is in scope; a full approval workflow is not.

**Phase 2 — Evaluation engine.** A small library (and/or sidecar service) that
answers `evaluate(flagKey, context) -> variant` in under a millisecond at p99.
Deterministic bucketing for percentage rollouts (hash of user ID + flag salt),
rule ordering semantics, environment inheritance (staging defaults from
production), and a local in-memory cache with a push-or-poll invalidation
story. SDK surface for the two backend languages in the monorepo plus a
JSON-over-HTTP endpoint for everything else. Telemetry: every evaluation emits
a sampled event for later analysis.

**Phase 3 — Admin UI.** A dashboard page to create, edit, search, and archive
flags; per-environment overrides; a percentage-rollout slider with live
preview of bucketing; an audit-history view; and role-based access (only flag
owners and admins can edit production values). Out of scope: A/B-test stats,
scheduled rollouts, and mobile SDKs.

Constraints: no new external SaaS dependencies; the evaluation path must not
add a network hop to request handling; everything behind the existing auth
middleware. Assume a team of three engineers and roughly six weeks.

---

## Page schema (follow exactly)

The plan is one self-contained HTML document. Machine-readable structure is
carried entirely by `data-*` attributes; inside structural elements you may
write free-form HTML prose.

**Document root.** The `<html>` element must carry:
- `data-plan-id` — a stable unique ID for the plan (e.g. `plan-2026-06-09-feature-flags`)
- `data-plan-name` — human-readable plan name
- `data-run-state` — the lifecycle state; for a fresh plan use `drafting`
- `data-schema-version` — the literal value `2`
- `data-created-at` — an ISO-8601 timestamp

The `<head>` holds `<meta charset="utf-8">` and a `<title>`.

**Header.** The `<body>` starts with a `<header data-role="plan-header">`
containing an `<h1>` with the plan name, a short paragraph describing the
lift, and an empty `<aside data-role="supervisor-attendance">`.

**Tabs.** After the header comes a `<nav data-role="tabs">` containing one
`<button data-tab-target="...">` per tab, in this order: `framing`,
`implementation`, `decisions`, `risks`, `research`, `experiments`, `reviews`,
`execution-log`, `retrospective`. The framing button also carries
`data-active="true"`.

Each tab is then a top-level `<section data-tab="<name>">` in the body, one
per tab name above. The framing section carries `data-active="true"`; every
other tab section carries the bare `hidden` attribute.

**Zones.** A zone is `<section data-role="zone" data-zone="<name>">` — an
agent-writeable target. Each zone contains an `<h3>` heading; its content may
be empty for now.
- The **framing** tab contains exactly these four lift-level zones:
  `success-criteria`, `scope`, `constraints`, `assumptions`.
- The **retrospective** tab contains exactly these four lift-level zones:
  `what-shipped`, `deviations-from-plan`, `what-we-learned`, `followup-plans`.
  Leave their bodies empty — they are filled after execution.

**Phases.** The `implementation` tab contains one
`<section data-role="phase" data-phase-id="...">` per phase. Each phase has a
unique, stable `data-phase-id` (e.g. `p1`, `p2`, `p3` — never reuse an ID).
Inside each phase, in addition to an `<h2>` title and free-form prose, every
phase must contain these four per-phase zones (empty is fine, but they must
exist): `phase-goal`, `alternatives-considered`, `recommendations`,
`open-questions`.

**Tasks.** Inside a phase, each task is
`<article data-role="task" data-task-id="...">` with a unique stable
`data-task-id` (e.g. `t1.1`, `t1.2`, `t2.1` — unique across the whole
document, never index-based in a way that would be reused). Tasks may
optionally carry `data-reversibility` (`high` | `medium` | `low`) and
`data-blast-radius` (`low` | `medium` | `high`). A task contains an `<h3>`
title and free-form prose describing the work.

**Accessory items.** Other tabs hold flat lists of items rather than zones:
- `decisions` tab: `<article data-role="decision" data-decision-id="..."
  data-decided-at="..." data-decided-by="...">` with free-form rationale, and
  optionally a `<p data-role="rationale-against">`.
- `risks` tab: `<article data-role="risk" data-risk-id="..."
  data-status="open" data-resolved-by="">`.
- `research` tab: `<article data-role="research-finding"
  data-finding-id="..." data-question-id="..." data-author="..."
  data-emitted-at="...">`.
- `experiments` tab: `<article data-role="experiment-result"
  data-experiment-id="..." data-author="..." data-emitted-at="...">`.
- `reviews` tab: `<aside data-role="review" data-review-id="..."
  data-reviewer-kind="..." data-author="..." data-emitted-at="..."
  data-status="open" data-resolved-by="">`.
- `execution-log` tab: a single `<ol data-role="execution-events">` that
  starts empty.
- Open questions inside a phase's `open-questions` zone are
  `<article data-role="open-question" data-question-id="..."
  data-status="open" data-resolved-by="">`.
- Assumptions inside the framing `assumptions` zone are
  `<article data-role="assumption" data-assumption-id="..."
  data-status="open" data-resolved-by="" data-invalidates-if="...">`.

**ID rules.** Every phase, task, decision, risk, open-question, assumption,
review, research finding, and experiment result has a stable unique ID in its
`data-*-id` attribute. No duplicates anywhere in the document.

**What to fill in.** Produce a substantive plan for the brief: populate the
framing zones (success criteria, scope, constraints, and at least two
assumptions), three phases each with a filled phase-goal, at least one entry
in alternatives-considered, at least one open question, and 3–6 tasks per
phase with real descriptions. Add at least two risks and at least one
decision. Leave research, experiments, reviews, execution-log, and
retrospective empty-but-scaffolded as described above. All free-form prose
must be well-formed HTML (balanced tags) and stay inside its containing
section.
