# Feature brief: Feature-flag system

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
