# Fixed core vs workflow policy

Derived from `OrchestrationScriptStructure.md` §4. The boundary keeps simple
scripts simple: fixed core is the minimum that prevents silent breakage; policy
may choose values but may **not** bypass the lifecycle order or attribution rules.

## Fixed core (invariant — every script)

- Credential loading + authenticated headers; fail-closed on-behalf.
- Explicit workspace + owner attribution; the four-concern separation (§1.2).
- Role-lane payload construction (§1.4).
- Order: launch → `waitReady` → `seedHighwater` → confirmed `kickoff`.
- `waitReceiverReady`, bounded 409 handling, `confirmedSend`.
- Message-based `waitTurnComplete` with **composite** highwater; status ≠ success.
- Bounded soft + hard timeouts and classified stalls.
- Explicit success predicate + independent deliverable verification.
- Eager member-id capture; terminal-state-specific cleanup; resume without
  reseeding a valid highwater.
- One-writer-per-artifact/plan-section; never assume one-agent-per-cwd.

## Workflow policy (user-customizable — the `# user policy` / `// user policy` slots)

- Triggers, schedules, quotas, watched state, selection rules.
- Topology and concurrency; number / provider / lane of members.
- Titles, role descriptions.
- Kickoff and relay prompt text.
- Tokens, consensus language, artifact paths, verifier functions.
- Soft/hard timeout values (within bounds); retry budgets; escalation thresholds.
- `notify_owner` verbosity; retire vs keep successful members.
- **Durable run-state mechanism** (file / sentinel / db): persisting is core, the
  mechanism is policy (required for scheduler & resumable deliberations).

## Per-template boundary markers

Each template header lists its **Invoked core subset**. Policy markers appear
**only** on declared extension points — a policy marker inside a fixed-core helper
body is a validation failure (`--static`). Workflow hardening (dispatcher strict
completion, scheduler duplicate-supervisor guard) is marked `# hardening`.
