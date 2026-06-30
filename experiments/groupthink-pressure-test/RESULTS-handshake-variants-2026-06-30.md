# GroupThink dropped-submit recovery — variant × fault results (2026-06-30)

Branch: `exp/gt-handshake-pressure`. Zero model tokens — every agent is a scripted
`DashboardClient` fake (`groupthink-pressure.test.ts`). This run settles the one
real design disagreement in `plans/groupthink-handshake-fix.md`: on an
**unrecoverable-unconfirmed** send, should the runner **THROW a fast STALL (V2)**
or **FALL THROUGH to the lag-tolerant `waitTurnComplete` (V1)**?

## The bug under test

`groupthink-v2.ts` delivers every kickoff/relay via `client.sendInput` (raw). The
dashboard's synchronous confirm-and-retry (`_doSendInput`, `index.ts:4630`) only
runs when `usesSubmitConfirmation(agent)` is true, and for **codex turn-1 that is
false** (`hasObservedStartHook` is false — no UserPromptSubmit hook has fired for
that launch yet; `index.ts:4237`). So when the kitty/VK_RETURN Enter drops, the
codex kickoff prompt sits typed-but-unsubmitted and `waitTurnComplete` polls to
`turnTimeoutMs` → STALL with no re-press. **PROBE-V0 pins this reproduction.**

## Variants (`OrchestrationRun.submitRecoveryPolicy`)

| Var | policy | behavior |
|-----|--------|----------|
| V0 | `raw` | current/baseline — `client.sendInput`, no handshake, no recovery. Reproduces the bug. |
| V1 | `recover-fallthrough` | `confirmedSend` + evidence-gated re-press (`submitTookEffect`). On exhaustion **do NOT throw** — fall through to `waitTurnComplete`. Kickoff relaunch allowed. |
| V2 | `recover-throw` | same recovery, but **THROW** a `STALL:`-prefixed delivery error on relay exhaustion. Kickoff relaunch. |

## Fault matrix

- **F-A** kickoff dropped-Enter, recovers on first re-press
- **F-B** kickoff dropped-Enter, never recovers (dead re-press)
- **F-C** kickoff hard delivery-failure (`code: 'delivery-failed'`)
- **F-D** relay dropped-Enter, recovers on re-press
- **F-E** relay dropped-Enter, never recovers (dead re-press)
- **F-F** HEALTHY-but-slow codex kickoff: Enter landed, turn arms after delay **D** real ms — **THE regression probe**
- **F-G** claude happy path (confirmed instantly)

Outcome vocabulary: `recovered` (in-place, no relaunch) · `relaunched` (fresh
member, L2) · `rode-out` (F-F healthy turn completed, no false stall) ·
`fast-stall` (threw `STALL:` ≪ turnTimeout, genuinely dead) · `slow-stall` (rode
to the turn-timeout) · `FALSE-STALL` (threw `STALL:` on a turn that was actually
healthy — the harm) · `crash(delivery)`. Cell = `outcome / wall-clock ms /
rp<spurious-re-presses>[ / L<launches> ]`.

## Variant × fault matrix (scaled window — crossover ≈150 ms, turnTimeout 600 ms)

```
variant | F-A                  | F-B                  | F-C                   | F-D                  | F-E                  | F-G                | F-F (D=400ms)
V0      | slow-stall/646ms/rp0 | slow-stall/648ms/rp0 | crash(delivery)/42ms  | slow-stall/658ms/rp0 | slow-stall/638ms/rp0 | recovered/18ms/rp0 | rode-out/25ms/rp0
V1      | recovered/20ms/rp1   | slow-stall/760ms/rp3 | relaunched/60ms/rp0/L2 | recovered/31ms/rp1   | slow-stall/756ms/rp3 | recovered/38ms/rp0 | rode-out/438ms/rp3
V2      | recovered/70ms/rp1   | fast-stall/343ms/rp6/L2 | relaunched/67ms/rp0/L2 | recovered/44ms/rp1 | fast-stall/175ms/rp3 | recovered/21ms/rp0 | FALSE-STALL/415ms/rp6/L2
```

(Per-millisecond figures vary run-to-run; outcomes are deterministic. The
millisecond window is a fast proxy — the real-time sweep below uses the
production constants.)

### F-F delay sweep — scaled window (crossover ≈150 ms)

```
D(ms) | V1 (recover-fallthrough)   | V2 (recover-throw)
10    | rode-out (rp0, 51ms)       | rode-out (rp0, 48ms)
60    | rode-out (rp1, 108ms)      | rode-out (rp1, 95ms)
100   | rode-out (rp2, 133ms)      | rode-out (rp2, 144ms)
400   | rode-out (rp3, 448ms)      | FALSE-STALL (rp6, 399ms, L2)
600   | rode-out (rp3, 674ms)      | FALSE-STALL (rp6, 372ms, L2)
```

### F-F delay sweep — **PRODUCTION window, REAL wall-clock** (`GT_FF_REALTIME=1`)

Production recovery window from the plan §4a: `SUBMIT_RESEND_ATTEMPTS=3 ×
SUBMIT_RESEND_RECHECK_MS=10 000` ⇒ ≈30 s of genuine re-press watching, plus a ~2 s
confirm window ⇒ **crossover ≈32 s**. `turnTimeoutMs=600 000`. Delay D swept in
real elapsed seconds:

```
D    | V1 (recover-fallthrough)   | V2 (recover-throw)
5s   | rode-out (rp1, 5.0s)       | rode-out (rp1, 5.0s)
20s  | rode-out (rp2, 20.0s)      | rode-out (rp2, 20.0s)
40s  | rode-out (rp3, 40.0s)      | FALSE-STALL (rp6, 64.1s, L2)
60s  | rode-out (rp3, 60.0s)      | FALSE-STALL (rp6, 64.1s, L2)
```

**F-F crossover ≈ 32 s** = handshake (~2 s) + 3 re-press attempts × 10 s recheck.
Below it (D≤20 s) both variants ride the healthy-slow turn out. Above it (D≥40 s)
V2 throws a `STALL:` on a perfectly healthy run, then relaunches once (L2) into the
*same* slow condition — which is also slow, so it false-stalls again and exhausts
the relaunch budget (~64 s, double the single-instance window). V1 rides every
healthy-slow turn out to completion regardless of D.

## Answers to the experiment questions

### Q1 — do V1 & V2 both recover F-A (kickoff drop) and F-D (relay drop)?

**Yes, identically.** Both reach `recovered`, fire exactly one evidence-gated
re-press (`rp1`), and do **not** relaunch (one member, no L2). The *recovery
machinery* — `confirmedSend` + `submitTookEffect`-gated `resubmitEnter` — is what
fixes the real bug; it is shared by V1 and V2 and is independent of the terminal
policy. V0 has no recovery and `slow-stall`s both (the reproduced bug).
Pinned by `INVARIANT-K1` (F-A) and `INVARIANT-K1b` (F-D).

### Q2 — at what delay D does V2 begin FALSE-STALLING healthy-slow codex turns that V1 rides out, and does evidence-gating prevent stray re-presses in BOTH?

**Crossover D ≈ the recovery window (≈32 s in production; ≈150 ms scaled).** For
D below it, both variants ride out; for D above it, **only V2 false-stalls** — V1
rides out at every D tested (5/20/40/60 s). The crossover is exactly
`handshake + attempts × recheckMs`, so it is fully tunable via
`SUBMIT_RESEND_RECHECK_MS`.

**Evidence-gating — two regimes, and the distinction matters:**

- When the healthy turn becomes **observable within the handshake window**
  (a status flip or any new assistant message, even pre-`turnComplete`), the gate
  fires **zero** re-presses in BOTH variants — `INVARIANT-F-F-gate` (D < handshake
  ⇒ `rp0`) and the happy path `INVARIANT-F-G-clean` (`rp0`, all three variants).
  This is the gate's core safety property and it holds.
- When the turn is **genuinely in-flight but not yet observable** (codex's status
  lag — the prompt was accepted and the model is silently reasoning), the gate
  *cannot* see it, so BOTH variants fire bounded re-presses (`rp1…rp3`) into it.
  Those re-presses are **harmless** — they are submit-only keystrokes into an
  already-empty composer (modeled as a no-op when a turn is already armed; in
  production a bare Enter on a consumed composer injects no content). So
  evidence-gating prevents *content-injecting* stray submits in both variants, but
  it does **not** stop V2 from eventually **throwing** on a turn that was healthy
  all along. The stray-re-press harm is equal (and benign) across V1/V2; the
  asymmetric harm is V2's terminal FALSE-STALL.

### Q3 — F-B / F-E (dead prompt): how much faster does V2 fail vs V1, and do both reach the same resumable end-state?

**V2 fails fast; V1 rides to the turn-timeout; both land in the same resumable
`stalled` state.** On a genuinely dead prompt V2 throws `STALL: … input delivery
unconfirmed …` at the end of the recovery window (~32–45 s production; `175–343 ms`
scaled) — far under `turnTimeoutMs`. V1 falls through to `waitTurnComplete` and
burns the **full `turnTimeoutMs`** (default 600 s) before throwing `Timeout`. Both
messages route through `service.ts` to **`stalled` + a resume hint** (the service
string-matches `STALL`/`Timeout` → `stalled`), so the end-state is identical and
resumable — V2 just reaches it faster with a more actionable message. Pinned by
`INVARIANT-K3` (V2 `fast-stall` ≪ `turnTimeoutMs`; V1 `slow-stall`; both → stalled;
`v2.elapsedMs < v1.elapsedMs`).

## Recommendation — **V1 (`recover-fallthrough`)** as the default fix

Both variants fix the actual bug equally (Q1). The choice is purely about the
terminal policy on exhaustion, and the F-F crossover decides it.

**The crossover (~32 s) sits squarely inside normal codex turn-1 behavior.** A
codex kickoff routinely accepts the prompt and then reasons silently — no streamed
output, lagging PTY status — for tens of seconds on a large turn-1 prompt. That is
*exactly* the F-F healthy-slow profile, and it is not a rare tail. V2 converts
those healthy runs into FALSE-STALLs (and wastes a relaunch into the same slow
condition before giving up). V1 never does — it rides every healthy-slow turn to
completion.

The regression-risk asymmetry is decisive, and "lowest-regression-risk" was the
explicit selection criterion:

- **V2's only advantage** over V1 is *latency on an already-broken run*: on a
  genuinely dead prompt (F-B/F-E) it reaches the **same** resumable `stalled` +
  resume-hint state ~32–45 s sooner than V1's 600 s. A faster path to an identical
  failure state.
- **V2's cost is failure-class:** it turns a **healthy** run into a stalled one
  whenever codex thinks longer than the recovery window — a far more damaging and
  harder-to-diagnose outcome than "a dead prompt took 10 min to be declared dead."

V1 can **never** convert a healthy run into a failure; its worst case is a bounded
delay to the same resumable end-state on an *already* dead prompt. That is the
strictly safer asymmetry.

**If the team still wants V2's fast-fail on dead prompts**, the safe form is V2
with `SUBMIT_RESEND_RECHECK_MS` widened so the crossover sits beyond the p99 codex
turn-1 silent-think time — but that requires live latency data we do not have here.
The plan (§ "Why throw on exhaustion", line 399) pre-committed to V2 and explicitly
flagged this FALSE-STALL as an accepted residual risk; this experiment shows the
crossover is close enough to real codex think-time that the risk is **not**
acceptable as a default. Absent the tuning data, **ship V1**; the recovery
machinery (shared) is the real fix, and fall-through is the conservative terminal.

A reasonable hybrid for a follow-up: V1's fall-through terminal **plus** a
dead-prompt hint — when `confirmedSend` exhausts, emit the existing
`delivery_failed` event (already additive, no status side-effect) so an operator
sees the actionable "submit unconfirmed after N re-presses" signal *immediately*,
while `waitTurnComplete` still rides out a genuinely-slow turn. That captures V2's
diagnostic benefit without its FALSE-STALL.

## Test inventory & tallies

- `groupthink-pressure.test.js` — **16 passed, 0 failed** (default fast suite);
  **17 passed, 0 failed** with `GT_FF_REALTIME=1` (adds `PROBE-F-F-realtime`).
- `groupthink-v2.test.js` — **6 passed, 0 failed**.
- `orchestration-service.test.js` — **6 passed, 0 failed**.

Key cases: `PROBE-V0` (bug repro), `INVARIANT-K1`/`K1b` (Q1), `INVARIANT-K2`
(F-C relaunch), `INVARIANT-K3` (Q3), `PROBE-F-F` + `INVARIANT-F-F-gate` +
`PROBE-F-F-realtime` (Q2), `INVARIANT-F-G-clean` (happy path), and the
informational `MATRIX` printer.

Reproduce:
```
npm run build:main
node dist/main/main/orchestration/groupthink-pressure.test.js           # 16/16 + tables
GT_FF_REALTIME=1 node dist/main/main/orchestration/groupthink-pressure.test.js   # +real-time sweep (~4 min)
node dist/main/main/orchestration/groupthink-v2.test.js                 # 6/6
node dist/main/main/orchestration/orchestration-service.test.js         # 6/6
```
