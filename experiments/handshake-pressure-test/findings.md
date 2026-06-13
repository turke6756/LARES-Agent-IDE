# Handshake pressure-test findings log

Append-only. One entry per scenario executed, newest at the bottom. Mirrors the
template used by `experiments/groupthink-pressure-test/findings.md`. The
handshake pressure harness lives at `src/main/supervisor/handshake-pressure.test.ts`;
its header explains the INVARIANT/PROBE convention and points here for recording
any PROBE→INVARIANT flip.

```markdown
## YYYY-MM-DD — <scenario id: PROBE-Hn / INVARIANT-Hn> — <one-line headline>

- **Agent:** <your agent id / title>
- **Tier:** 1|2|3 (Tier 3: approved by <who>)
- **Classification:** confirmed-known | fixed-confirmed | new-failure-mode |
  recipe-validated | recipe-failed | inconclusive
- **Expected:** <what the catalog/probe predicted>
- **Observed:** <what actually happened>
- **Evidence:** build result, suite tally, exact error/log, code refs
- **Hardening implication:** <which backlog item this strengthens/weakens>
```

---

## 2026-06-13 — PROBE-H4 → INVARIANT — unconfirmed supervisor delivery now durable

- **Agent:** worker (implementing orchestration-durability-hardening-2026-06-13.md)
- **Tier:** 1
- **Classification:** fixed-confirmed
- **Expected:** after the hardening, `deliverToSupervisor` should stop counting an
  UNCONFIRMED send as success; the probe should flip to an INVARIANT.
- **Observed:** flipped and passes as an INVARIANT;
  `node dist/main/main/supervisor/handshake-pressure.test.js` → **6 passed, 0
  failed** (H1/H2/H3 deliberately left PROBEs — out of scope).
  - **H4 (`supervisor/index.ts`):** `deliverToSupervisor` now reads the
    `sendInputConfirmed` result. A `confirmed === false` resolution (bytes
    delivered but no turn-start proof, e.g. `mode:'unconfirmed'` from a dropped
    Enter on the non-contract supervisor pane) is treated as a retryable failure
    inside the existing retry loop; on exhaustion it returns `{ ok: false }` so
    the `OrchestrationService.relay` writes a durable `delivery_failed` event row
    instead of silently dropping a terminal groupthink completion/stall event.
    INVARIANT-H4 stubs `sendInputConfirmed` → `{ delivered:true, confirmed:false,
    mode:'unconfirmed' }`, calls with `{ maxAttempts: 2, intervalMs: 1 }`, and
    asserts the send retried to exhaustion (`confirmedResults.length === 2`) and
    `res` deep-equals `{ ok: false }`.
  - **Accepted trade-offs (per plan):** a supervisor that received the event but
    whose status never flipped within the confirm window now yields a (possibly
    false) `delivery_failed` row — a durable, queryable, retryable row beats a
    vanished terminal event; and a retried unconfirmed send may post the same
    `[DASHBOARD EVENT]` twice — cosmetic at the message layer since durable
    orchestration state is keyed by `runId`.
- **Evidence:** build `npm run build:main` clean; suite tally 6/0; the
  intentional `[orchestration] deliverToSupervisor: unconfirmed (mode=unconfirmed)
  after 2 attempts` warn line confirms the new exhaustion path. Regression guard
  `handoff-handshake.test.js` 13/0; INVARIANT-H5/H6 unaffected.
- **Hardening implication:** the H4 backlog item is closed (fix pinned by an
  INVARIANT). H1 (status-poll baseline gap), H2 (post-exhaustion hook
  reconciliation) and H3 (composer un-poison) remain open PROBEs — out of scope
  for this pass. Confidence in H4's status-flip assumption is bounded by the
  out-of-scope H1 gap, as the plan notes.
