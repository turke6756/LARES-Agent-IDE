# GroupThink pressure-test findings log

Append-only. One entry per scenario executed, newest at the bottom. Use the
template below verbatim. See `PROTOCOL.md` §6 for rules.

```markdown
## YYYY-MM-DD — <scenario id: PROBE-Tn / Hn / Ln> — <one-line headline>

- **Agent:** <your agent id / title>
- **Tier:** 1|2|3 (Tier 3: approved by <who>)
- **Classification:** confirmed-known | fixed-confirmed | new-failure-mode |
  recipe-validated | recipe-failed | inconclusive
- **Catalog row:** F<n> (or "F-next proposed" for new modes)
- **Expected:** <what the catalog/probe predicted>
- **Observed:** <what actually happened>
- **Evidence:** runId=…, members=…, events=…, file mtime vs stall ts=…,
  exact error message=…, log path=…
- **Hardening implication:** <which backlog item this strengthens/weakens, or
  proposed new probe sketch>
```

---

## 2026-06-12 — PROBE-T1..T4 (initial harness run) — four suspected weaknesses confirmed in sim

- **Agent:** worker (protocol author)
- **Tier:** 1
- **Classification:** confirmed-known (×4, first deterministic reproductions)
- **Catalog rows:** F9, F8, F10, F1
- **Expected:** code-reading hypotheses from `groupthink-v2.ts`: (T1) `msg.ts <= hw`
  drops same-ts turns; (T2) pre-existing planPath ends a serial run after lead
  turn-1; (T3) status=`working` resets the stall clock unboundedly; (T4) R3
  turn-complete-before-write throws `no_plan_written` while the file lands later.
- **Observed:** all four probes pass on first run —
  `node dist/main/main/orchestration/groupthink-pressure.test.js` → 7 passed, 0
  failed (4 probes + 3 invariants). Existing suites (`groupthink-v2.test.js` 6/6,
  `orchestration-service.test.js` 6/6) unaffected.
- **Evidence:** harness source `src/main/orchestration/groupthink-pressure.test.ts`;
  each probe's header comment cites the exact runner lines/behavior pinned.
- **Hardening implication:** backlog items 1–4 in PROTOCOL §7 all have
  deterministic reproductions now; F1 additionally needs L4 live grace-window
  measurements before sizing the fix.

## 2026-06-13 — PROBE-T1/T2/T4 → INVARIANT — hardening landed; three probes flipped

- **Agent:** worker (implementing orchestration-durability-hardening-2026-06-13.md)
- **Tier:** 1
- **Classification:** fixed-confirmed (×3)
- **Catalog rows:** F9 (T1), F8 (T2), F10 (T4)
- **Expected:** after applying the GroupThink-approved hardening, the three pinned
  weaknesses should be FIXED and their probes flippable to INVARIANTs.
- **Observed:** all three flipped and pass as INVARIANTs;
  `node dist/main/main/orchestration/groupthink-pressure.test.js` → **7 passed, 0
  failed** (T3 deliberately left a PROBE — out of scope).
  - **T1 (`groupthink-v2.ts`):** `readNextMessage` now uses a composite highwater
    `"<ts><sep><sha1-16>"` packed into the existing `lastRelayedTs` map via
    `markRelayed`/`parseHighwater` (`HW_SEP = String.fromCharCode(1)` — a U+0001
    separator that cannot appear in ISO/`agent#NNNN` timestamps). A same-ts turn
    is dropped only if its content hash also matches → a same-ts reviewer turn-2
    with new content is now relayed instead of filtered into a timeout stall.
    INVARIANT-T1 asserts `runSerial` resolves, `feedbackRelays.length === 2`, and
    the turn-2 content reaches the lead. *Deviation:* the plan's literal recipe
    (write the plan at Reviewer counter===2) would break the serial loop before
    relaying turn-2 (existsSync gate fires before the feedback sendInput),
    contradicting its own `feedbackRelays===2` assertion; the test writes the plan
    at Lead counter===3 (its response to reviewer turn-2) instead, which satisfies
    all three stated assertions and proves the identical fix.
  - **T2 (`groupthink-v2.ts` + `service.ts`):** new exported `archiveStalePlan`
    renames a pre-existing planPath to `${planPath}.stale-<runId>-<ts>.bak` at the
    start of a fresh run (service-level before `insertOrchestration`, plus
    runner-level defensive guards in `runSerial`/`runParallel`, all gated off
    resume). INVARIANT-T2 asserts the reviewer IS launched (deliberation happened),
    the deliverable is the fresh plan, and a `.stale-run-pressure-*.bak` sibling
    holds the original stale content. INVARIANT-T6 (premature turn-1 write) still
    passes — archiving removes only files predating the run.
  - **T4 (`groupthink-v2.ts`):** two defects fixed in `runParallel`. §1 captures &
    marks the synthesizer's R2 (`synthR2`) so its highwater advances past synthR1
    (previously discarded → R3's wait returned the stale R2 turn-complete). §2 adds
    a bounded grace poll `waitForPlanFile(ctx, planPath, PLAN_WRITE_GRACE_MS=30000)`
    replacing the immediate post-R3 `existsSync` throw. INVARIANT-T4 writes the plan
    60ms after the R3 turn-complete and asserts `runParallel` resolves with the
    file present (grace poll detects it well inside the window).
- **Evidence:** build `npm run build:main` clean; suite tally 7/0; pre-impl check
  confirmed `src/main/orchestration/` has only `groupthink-v2.ts` (no stray
  hand-authored `.js` shadowing the build). Regression guards unaffected:
  `handoff-handshake.test.js` 13/0.
- **Hardening implication:** PROTOCOL §7 backlog items 1, 2, 4 are closed (fixes
  pinned by INVARIANTs). Item 3 (T3 working-status unbounded wait) remains an open
  PROBE — out of scope for this pass.

## 2026-06-30 — PROBE-V0 + F-A..F-G variant matrix — codex turn-1 dropped-kickoff repro; V1/V2 recovery raced

- **Agent:** worker (continuing exp/gt-handshake-pressure, commit 62e2568 → follow-on)
- **Tier:** 1
- **Classification:** new-failure-mode (codex turn-1 dropped-kickoff STALL) +
  recipe-validated (V1 `recover-fallthrough`, V2 `recover-throw` both recover the
  bug) + recipe-failed (V2 FALSE-STALLs healthy-slow codex past the recovery window)
- **Catalog row:** F-next proposed — "codex turn-1 kickoff dropped Enter →
  unsubmitted → turnTimeout STALL, no re-press (usesSubmitConfirmation false on
  turn-1)". Variant faults F-A..F-G are recovery-policy probes, not catalog rows.
- **Expected:** (V0) raw codex kickoff with a dropped Enter polls to turnTimeoutMs
  with zero re-presses — the bug from `plans/groupthink-handshake-fix.md`. (V1/V2)
  the confirmed handshake + evidence-gated re-press recovers F-A/F-D in place; the
  disputed terminal policy (throw vs fall-through) only diverges on
  unrecoverable-unconfirmed and on healthy-but-slow turns.
- **Observed:**
  - **PROBE-V0** reproduces deterministically: `raw` + F-A ⇒ `slow-stall`,
    `/Timeout/`, `rp0`, elapsed ≥ turnTimeoutMs. New-failure-mode pinned.
  - **Q1 (F-A/F-D):** V1 & V2 both `recovered`, `rp1`, no relaunch — identical.
    Recovery machinery, not terminal policy, fixes the bug. (INVARIANT-K1/K1b)
  - **Q2 (F-F):** crossover D = recovery window = handshake + attempts×recheck
    (≈150 ms scaled; **≈32 s production**, real-elapsed sweep via `GT_FF_REALTIME=1`).
    Below it both ride out; above it **only V2 FALSE-STALLs** (then relaunches L2
    into the same slow condition, ~64 s). V1 rides out at every D (5/20/40/60 s).
    Evidence-gating fires zero re-presses only when the turn is *observable* within
    the handshake window (INVARIANT-F-F-gate, INVARIANT-F-G-clean); for an
    in-flight-but-unobservable healthy turn both variants fire bounded *harmless*
    (no-op) re-presses — the gate does not stop V2's eventual throw.
  - **Q3 (F-B/F-E):** V2 `fast-stall` (~32–45 s prod) ≪ V1 `slow-stall` (full
    turnTimeoutMs, default 600 s); both route to the same resumable `stalled` +
    resume-hint end-state via service.ts STALL/Timeout matching. (INVARIANT-K3)
  - **F-C** hard delivery-failure: V1/V2 `relaunched` (L2) + recover; V0
    `crash(delivery)` (no relaunch path). (INVARIANT-K2)
- **Evidence:** build `npm run build:main` clean. Tallies: `groupthink-pressure`
  **16/16** (default) / **17/17** (`GT_FF_REALTIME=1`), `groupthink-v2` **6/6**,
  `orchestration-service` **6/6**. Real-time sweep table (production window,
  crossover≈32 s): D=5 s→V1/V2 rode-out; 20 s→V1/V2 rode-out; 40 s→V1 rode-out /
  V2 FALSE-STALL (64.1 s, L2); 60 s→V1 rode-out / V2 FALSE-STALL (64.1 s, L2).
  Full writeup: `experiments/groupthink-pressure-test/RESULTS-handshake-variants-2026-06-30.md`.
- **Hardening implication:** recommend **V1 (`recover-fallthrough`)** as the
  default fix for the codex-kickoff bug. The shared recovery machinery is the real
  fix; the terminal policy is the only disagreement, and the F-F crossover (~32 s)
  overlaps normal codex turn-1 silent-think time, so V2's FALSE-STALL is a live
  regression hazard, not a rare tail. V1 never converts a healthy run into a
  failure; its only cost is a bounded delay to the same resumable state on an
  already-dead prompt. This **weakens** the plan's §"Why throw on exhaustion"
  decision (line 399) — the accepted residual FALSE-STALL risk is too close to
  real behavior to be a safe default. If V2's fast-fail is wanted, widen
  `SUBMIT_RESEND_RECHECK_MS` past p99 codex think-time first (needs live data), or
  adopt the hybrid: V1 fall-through + an immediate `delivery_failed` diagnostic.
