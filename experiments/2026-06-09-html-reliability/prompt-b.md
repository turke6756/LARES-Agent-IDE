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

---

## Worked example (a different plan, same schema)

The following is a complete valid document for an unrelated plan ("Auth
middleware rewrite"). Use it as the reference for what valid output looks
like — structure, attributes, and nesting. Your document is for the
feature-flag brief above, not this one.

```html
<!DOCTYPE html>
<html lang="en"
      data-plan-id="plan-2026-05-13-auth-rewrite"
      data-plan-name="Auth middleware rewrite"
      data-run-state="drafting"
      data-schema-version="2"
      data-created-at="2026-05-13T18:42:00Z">
<head>
  <meta charset="utf-8">
  <title>Auth middleware rewrite</title>
  <link rel="stylesheet" href="../.dashboard/plan-styles/plan.css">
</head>
<body>

  <header data-role="plan-header">
    <h1>Auth middleware rewrite</h1>
    <p>Replace session-token middleware with the compliance-approved JWT path.
       Driven by legal/compliance, not tech-debt cleanup.</p>
    <aside data-role="supervisor-attendance">
      <!-- Per §9.4. Appended on each meaningful supervisor action on this plan. -->
    </aside>
  </header>

  <nav data-role="tabs">
    <button data-tab-target="framing" data-active="true">Framing</button>
    <button data-tab-target="implementation">Plan</button>
    <button data-tab-target="decisions">Decisions</button>
    <button data-tab-target="risks">Risks</button>
    <button data-tab-target="research">Research</button>
    <button data-tab-target="experiments">Experiments</button>
    <button data-tab-target="reviews">Reviews</button>
    <button data-tab-target="execution-log">Execution</button>
    <button data-tab-target="retrospective">Retrospective</button>
  </nav>

  <!-- ─── Framing tab (lift-level scope, success, constraints, assumptions) ─── -->
  <!-- Soft-gated on drafting → convinced: empty zones surface as advisories  -->
  <!-- in the compilation report (§7.3), but nothing blocks the transition.   -->
  <section data-tab="framing" data-active="true">

    <section data-role="zone" data-zone="success-criteria">
      <h3>Success criteria</h3>
      <!-- Testable conditions for "the lift achieved its goal."
           Distinct from per-task acceptance criteria. -->
    </section>

    <section data-role="zone" data-zone="scope">
      <h3>Scope</h3>
      <!-- In scope / out of scope / explicitly deferred. -->
    </section>

    <section data-role="zone" data-zone="constraints">
      <h3>Constraints</h3>
      <!-- Time, compute budget, blast-radius limits, reversibility window. -->
    </section>

    <section data-role="zone" data-zone="assumptions">
      <h3>Assumptions</h3>
      <!--
      <article data-role="assumption"
               data-assumption-id="a1"
               data-status="open"
               data-resolved-by=""
               data-invalidates-if="compliance changes JWT lifetime policy">
        <p>JWT lifetime of 15 minutes will satisfy compliance.</p>
      </article>
      -->
    </section>
  </section>

  <!-- ─── Implementation plan tab ─── -->
  <section data-tab="implementation" hidden>

    <section data-role="phase" data-phase-id="p1">
      <h2>Phase 1: Provision the new JWT issuer</h2>
      <p>Free-form prose for humans: what this phase is, what's in scope.</p>

      <section data-role="zone" data-zone="phase-goal">
        <h3>Phase goal</h3>
        <!-- One-paragraph statement of what this phase delivers. -->
      </section>

      <section data-role="zone" data-zone="alternatives-considered">
        <h3>Alternatives considered</h3>
        <!-- "We considered X, Y, Z; chose X because ___." Distinct from  -->
        <!-- the lift-level Decisions tab — these are the phase-internal  -->
        <!-- design trade-offs that fed into the chosen approach.          -->
      </section>

      <section data-role="zone" data-zone="recommendations">
        <h3>Recommendations</h3>
        <!-- GroupThink-on-phase-1 output lands here. Proposals, not commitments. -->
      </section>

      <section data-role="zone" data-zone="open-questions">
        <h3>Open questions</h3>
        <!--
        <article data-role="open-question"
                 data-question-id="q3"
                 data-status="open"
                 data-resolved-by="">
          <p>What rotation interval do we use?</p>
        </article>
        -->
      </section>

      <article data-role="task"
               data-task-id="t1.1"
               data-reversibility="high"
               data-blast-radius="low">
        <h3>Add JWT issuer Terraform module</h3>
        <p>Stand up the issuer service. Module follows the pattern from
           <code>infra/oauth-issuer/</code>. Exposes <code>issuer_url</code>.</p>
      </article>

      <article data-role="task"
               data-task-id="t1.2"
               data-reversibility="medium"
               data-blast-radius="low">
        <h3>Wire issuer secret into KMS</h3>
        <p>Depends on t1.1.</p>
      </article>
    </section>

    <section data-role="phase" data-phase-id="p2">
      <h2>Phase 2: Migrate the middleware</h2>
      <section data-role="zone" data-zone="phase-goal"></section>
      <section data-role="zone" data-zone="alternatives-considered"></section>
      <section data-role="zone" data-zone="recommendations"></section>
      <section data-role="zone" data-zone="open-questions"></section>
      <!-- tasks... -->
    </section>

  </section>

  <!-- ─── Decisions tab (committed choices with rationale, separate from recs) ─── -->
  <!-- Recommendations are proposals (plural, conflicting, cheap to generate). -->
  <!-- Decisions are commitments (singular per locked tradeoff, auditable).    -->
  <section data-tab="decisions" hidden>
    <!--
    <article data-role="decision"
             data-decision-id="d1"
             data-decided-at="2026-05-15T10:30:00Z"
             data-decided-by="user"
             data-supersedes="">
      <h3>Chose JWT issuer service over edge-rewriter</h3>
      <p>Rationale: matches compliance's preferred path. Trades higher infra
         cost for lower review burden.</p>
      <p data-role="rationale-against">
        Edge-rewriter ships faster but adds compliance review surface.
      </p>
    </article>
    -->
  </section>

  <!-- ─── Risks tab (with resolution lifecycle via convention) ─── -->
  <section data-tab="risks" hidden>
    <!--
    <article data-role="risk"
             data-risk-id="r1"
             data-status="open"
             data-resolved-by="">
      <h3>JWT issuer downtime → full auth outage</h3>
      <p>Mitigation: …</p>
    </article>
    -->
  </section>

  <!-- ─── Research tab ─── -->
  <section data-tab="research" hidden>
    <p>Findings from research agents land here, attached to the question they answer.</p>
    <!--
    <article data-role="research-finding"
             data-finding-id="rf1"
             data-question-id="q3"
             data-author="deep-research-claude"
             data-emitted-at="2026-05-13T20:14:00Z">
      <h3>JWT rotation interval — industry norms</h3>
      <p>Free-form prose. Summary, sources, recommendation.</p>
    </article>
    -->
  </section>

  <!-- ─── Experiments tab ─── -->
  <section data-tab="experiments" hidden>
    <!--
    <article data-role="experiment-result"
             data-experiment-id="x1"
             data-author="experimenter-codex"
             data-emitted-at="2026-05-13T21:02:00Z">
      <h3>JWT issuance throughput benchmark</h3>
      <p>Method, results, implications.</p>
    </article>
    -->
  </section>

  <!-- ─── Reviews tab ─── -->
  <section data-tab="reviews" hidden>
    <!--
    <aside data-role="review"
           data-review-id="rv1"
           data-reviewer-kind="security"
           data-author="security-reviewer-claude"
           data-emitted-at="2026-05-13T19:01:00Z"
           data-status="open"
           data-resolved-by="">
      <h3>Security review — first pass</h3>
      <p>Concerns, mitigations.</p>
    </aside>
    -->
  </section>

  <!-- ─── Execution log tab ─── -->
  <section data-tab="execution-log" hidden>
    <ol data-role="execution-events">
      <!-- Executor appends entries here as it runs. -->
      <!--
      <li data-role="execution-event"
          data-task-id="t1.1"
          data-attempt="1"
          data-status="ok"
          data-emitted-at="2026-05-13T22:18:00Z">
        <p>Worker reported ok. files_changed: ... acceptance_met: ...</p>
      </li>
      -->
    </ol>
  </section>

  <!-- ─── Retrospective tab (filled post-execution; documents what shipped) ─── -->
  <section data-tab="retrospective" hidden>
    <section data-role="zone" data-zone="what-shipped">
      <h3>What shipped</h3>
    </section>
    <section data-role="zone" data-zone="deviations-from-plan">
      <h3>Deviations from plan</h3>
    </section>
    <section data-role="zone" data-zone="what-we-learned">
      <h3>What we learned</h3>
    </section>
    <section data-role="zone" data-zone="followup-plans">
      <h3>Follow-up plans</h3>
    </section>
  </section>

</body>
</html>
```

