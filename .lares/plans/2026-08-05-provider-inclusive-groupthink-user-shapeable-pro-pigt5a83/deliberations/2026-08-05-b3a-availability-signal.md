---
plan_artifact_id: plan_pigt5a83
intent_id: int_a7b3c9e2
orchestration_id: 290646e4
kind: deliberation
---

# WP-B3a — Provider-availability signal (hardened)

Harden the availability signal WP-B2's ladder filters through. **Composes with:** WP-B2
(preference ladder = *desire*), WP-B3 (`orchestrationProviderDefaults` on the same route
object), WP-B5 (v4→v5 SKILL — B3a supplies the rule text + the skill-contract tests).
**Scope honored:** no supervisor-lane selection, no writer-ack gate.

## Governing principle

> Static detection defines the baseline and membership. Runtime evidence may downgrade an
> installed provider; later positive recovery evidence may remove that runtime overlay, but
> runtime evidence can never upgrade a statically not-detected provider.

Only **positively classified** evidence produces an observation — a generic writer stall is
never evidence of provider unavailability, and no provider is ever dropped from the array.

## Status semantics (defined before reasons)

- **`available`** — statically detected, no current evidence of impaired execution.
- **`degraded`** — launchable, but a known limitation / near-limit warning makes success less
  reliable.
- **`unavailable`** — do not launch: binary not detected, or a hard blocker is *positively
  observed*.

---

## Decision 1 — Payload shape (public DTO) + internal registry type

Public types in `src/shared/types.ts` (adjacent to `LAUNCHABLE_AGENT_PROVIDERS`, ~line 40):

```ts
export type ProviderAvailabilityStatus = 'available' | 'degraded' | 'unavailable';

export type ProviderAvailabilityReason =
  | 'not-detected'      // static: resolver found no launch binary  ⇒ unavailable
  | 'auth-banner'       // runtime, positively classified: agy sign-in banner ⇒ unavailable
  | 'free-usage-limit'  // runtime, positively classified: grok free-tier limit ⇒ unavailable
  | 'quota-near-limit'  // claude fresh window 95–99%                ⇒ degraded
  | 'quota-exhausted';  // claude fresh window ≥100%                 ⇒ unavailable

/** Deterministic severity order for `reasons`/`evidence` (unavailable-class first). */
export const PROVIDER_AVAILABILITY_REASON_ORDER: ProviderAvailabilityReason[] =
  ['not-detected', 'auth-banner', 'free-usage-limit', 'quota-exhausted', 'quota-near-limit'];

export interface ProviderQuotaNote {
  source: 'claude_statusline' | 'runtime_observation';
  note: string;         // formatter-built, factual — never ad-hoc prose
  observedAt: number;   // epoch-ms this quota fact was captured
  stale?: boolean;
  resetsAt?: number;    // epoch-ms window reset when known (machine-readable; client formats)
}

export interface ProviderAvailabilityEvidence {
  reason: ProviderAvailabilityReason;
  detail: string;
  observedAt: number;                   // per-item, not row-level
  source: 'static' | 'runtime_observation' | 'claude_statusline';
}

export interface ProviderAvailability {
  provider: LaunchableAgentProvider;
  status: ProviderAvailabilityStatus;
  installed: boolean;                        // static floor
  reasons: ProviderAvailabilityReason[];     // sorted by PROVIDER_AVAILABILITY_REASON_ORDER
  evidence: ProviderAvailabilityEvidence[];  // structured, per-reason, same order
  quota?: ProviderQuotaNote;
}
```

**Distinct internal registry type** (never the public DTO as mutable state) — in
`src/main/supervisor/provider-runtime-observations.ts`:

```ts
export interface ProviderRuntimeObservation {
  reason: 'auth-banner' | 'free-usage-limit';   // hard blockers only
  detail: string;
  observedAt: number;
  resetsAt?: number;                              // enables parsed-reset expiry
}
```

The registry stores `ProviderRuntimeObservation`; the pure resolver **projects** it into
public `evidence` and, for `free-usage-limit`, into `quota` (source `runtime_observation`).
Route returns a **length-4 array in canonical `LAUNCHABLE_AGENT_PROVIDERS` order**, always
present.

**Route edit** — `src/main/api-server.ts`, sibling key after `counts` (line 2418):

```ts
availableProviders: await getAvailableProviders({ getUsageLimits: () => this.supervisor.getUsageLimits() }),
```

**MCP** — extend `get_my_context`'s description (`scripts/mcp-tools-observability.js:116-126`)
to name `availableProviders`; proxy at `:352` is pass-through.

---

## Decision 2 — Static detection (honest) + acquisition/resolution split

`probeWindowsProvider` (`provider-resolver.ts:140-150`) proves only that a **launch binary
resolves** — not configuration or authentication. Configuration/auth state is **unknown**
until runtime evidence exists; we never spawn a CLI on a context pull. A resolver miss is
**`not-detected`** (an unreadable path/failed lookup is not conclusive absence).

Targets: claude `provider-resolver.ts:35-66`; codex `:80-95`; grok `:97-102`; agy `:104-107`;
common `:140-150`; projection `runtime-prerequisites.ts:155-194`, `:655-694`.

**Split** — shared module `src/main/provider-availability.ts` (top-level: API server +
supervisor lifecycle both consume it):

```ts
// PURE — no I/O, no clock. Fixture-driven; never spawns where.exe / --version.
export function resolveProviderAvailability(input: {
  prerequisiteReport: RuntimePrerequisiteReport;
  usageLimits: UsageLimitsReading;
  observations: Map<LaunchableAgentProvider, ProviderRuntimeObservation[]>;
  now: number;
}): ProviderAvailability[];

// ACQUISITION — thin, impure. Narrow dependency; no supervisor import, no workspaceDir.
export async function getAvailableProviders(
  deps: { getUsageLimits(): UsageLimitsReading },
): Promise<ProviderAvailability[]>;
```

Availability is **process-global, not workspace-specific**. `getAvailableProviders` calls the
globally TTL-cached `detectRuntimePrerequisites()` **with no workspace option** (so it never
couples this signal to workspace-specific Git probing, and never triggers a WSL probe), plus
`deps.getUsageLimits()` and `getProviderObservations(now)`, then delegates to the pure
resolver. The context route stays workspace-authorized by its `X-Workspace-Id` gate; the
*payload* it carries is global. **Latency decision (deliberate):** reuse the existing cached
report rather than duplicate the resolver's candidate lists (forbidden by the module header);
it is warmed by startup + Sidebar mounts, so pulls are normally warm.

---

## Decision 3 — Evidence table, overlay, and reason-specific clearing

Claude quota is read **live** each pull (self-clearing). Only positively-classified **hard
blockers** are stored observations.

### Evidence table

| Evidence | Signature | Classifier (file:line) | Emission site | Result | Recovery / clearing |
|---|---|---|---|---|---|
| **agy auth-banner** | `welcome to the antigravity cli` + `you are currently not signed in` (strict `sign-in` signature) | `interactive-prompt-detector.ts:133-153` via `classifyPtyPrompt` — reads **`getCurrentScreen()`** (`index.ts:8084-8089`) | **existing** positive site `_deliverAndConfirm` `index.ts:7922-7929` (agy, `prompt.kind==='sign-in'`) → `noteProviderObservation('agy','auth-banner',…)` before the `failed` return | `unavailable` / `auth-banner` | **`clearProviderObservation('agy','auth-banner')`** on a `confirmed` agy outcome in `recordSendOutcome` (`index.ts:8012`) — starting the turn proves the auth screen no longer owns the terminal — or process restart |
| **grok free-usage-limit** | exact exhaustion literal from the **captured artifact** (below) | **NEW** strict `classifyGrokFreeLimit(screen)` in **new** `src/main/supervisor/provider-quota-classifier.ts`; classifies the **current visible screen**, never the append-only ring | **NEW** `StatusMonitor.checkProviderQuotaBlock(agent)` in the monitor tick (beside `checkPtyWaiting`, `status-monitor.ts:988-1009`); grok-only; two-consecutive-poll stability via a **distinct `lastProviderQuotaSig` map**; screen supplied by an **injected `getCurrentScreen(agentId)` accessor** (mirroring the existing `getOutputRingTail` injection) → `noteProviderObservation('grok','free-usage-limit',…,resetsAt?)` | `unavailable` / `free-usage-limit` | **screen-gated Stop-hook clearing (below)**, or a positively-parsed `resetsAt`, or process restart. A `confirmed` send is **never** sufficient (Grok can confirm input then paint its quota screen) |
| **claude near-limit** | fresh window `used_percentage` 95–99 | none (numeric, live) | pure resolver from `getUsageLimits()` | `degraded` / `quota-near-limit` | recomputed live |
| **claude exhausted** | fresh window `≥100` | none | pure resolver | `unavailable` / `quota-exhausted` | recomputed live |

**Grok `free-usage-limit` clearing rule (verbatim):**

> On an applied Grok Stop-hook event occurring after the stored observation, inspect the
> current visible screen. Clear `free-usage-limit` only when
> `classifyGrokFreeLimit(getCurrentScreen(agentId))` no longer matches. If the exhaustion
> screen remains visible, retain the observation.

A Stop hook proves turn completion, **not** quota recovery — the same quota-rejected turn may
emit Stop — so the clear is gated on the exhaustion screen no longer being present. This
clearing runs on the applied Stop-hook idle transition (`AgentSupervisor.forceIdleFromHook`,
caller noted `status-monitor.ts:508`) and, on a match-still-present screen, is a no-op.

**Stability map isolation:** `lastProviderQuotaSig` is separate from `lastPtyPromptSig` so the
two checks cannot erase each other's evidence each tick; it is cleared in agent cleanup
**beside `lastPtyPromptSig.delete(agentId)` at `status-monitor.ts:505`**.

**Current-screen, not the ring:** both classifiers run over `getCurrentScreen()` — the
append-only ring retains erased frames (`index.ts:8081-8088`), so two polls over stale ring
content are not proof the blocker is still visible. The grok emission uses the injected
current-screen accessor; agy already does via `classifyPtyPrompt`.

**No blanket clears:** `recordSendOutcome` only ever calls
`clearProviderObservation(provider, reason)` with an explicit reason; never the blanket form.

**Removed per prior review:** `runtime-stall` and `reattach-quirk`. The generic `STALL:` paths
(`groupthink-v2.ts:205-213`, `:261-332`, `:777-781`) emit nothing.

### Grok classifier is evidence-gated (omit entirely if the artifact is unrecovered)

`classifyGrokFreeLimit` requires **real captured evidence** — grok's benign startup copy
("try it out for free for a limited time", "Upgrade for more usage") is *not* exhaustion and
is an explicit negative fixture. When the artifact **is** recovered, the WP delivers:

- **Positive fixture** `src/main/supervisor/__fixtures__/grok-free-limit-exhausted.txt` —
  sanitized from the actual exhausted-Grok terminal artifact (the live 2026-08-05 DOA
  incident; WP-A6 evidence discipline).
- **Negative fixture** `src/main/supervisor/__fixtures__/grok-startup-promo.txt` — the benign
  promotion.

**If the real exhaustion artifact cannot be recovered:** do not guess the signature and do not
ship dead scaffolding. **Omit** the Grok classifier, the `checkProviderQuotaBlock` monitor
wiring, the positive fixture, and the related lifecycle tests from this implementation
entirely. **Retain only** the payload/registry seam (types, registry, resolver projection),
and document Grok quota as **unsupported best-effort evidence** until the artifact exists. No
permanently inert `checkProviderQuotaBlock` method is committed.

### Registry

`src/main/supervisor/provider-runtime-observations.ts` — session-scoped, in-memory, **not
persisted**, **process-lifetime** (no unconditional TTL). Keyed
**`Map<provider, Map<reason, ProviderRuntimeObservation>>`** to hold simultaneous reasons:

```ts
export function noteProviderObservation(p, reason, detail, observedAt, resetsAt?): void
export function clearProviderObservation(p, reason): void          // reason REQUIRED
export function getProviderObservations(now): Map<provider, ProviderRuntimeObservation[]>
                                                                   // drops only entries past a parsed resetsAt
export function __resetProviderObservationsForTest(): void
```

---

## Decision 4 — Claude mixed-window freshness (precise)

In the pure resolver, for claude only:

1. Consider the two windows (`five_hour`, `seven_day`); keep those that are **non-null and
   `stale === false`**.
2. **Derive status only from fresh windows.** `max(fresh.used_percentage) ≥ 100` →
   `unavailable`/`quota-exhausted`; `95–99` → `degraded`/`quota-near-limit`; `<95` → no reason.
3. **Singular quota note:** choose the **highest-percentage fresh window**; deterministic
   tie-break = **prefer `seven_day`** (the slower-resetting, more consequential window). Build
   via `formatClaudeQuotaNote(window)`: `note = "${label} ${Math.round(used_percentage)}%
   used"`, `observedAt = captured_at`, `resetsAt = resets_at_ms`, `source =
   'claude_statusline'`.
4. **If no fresh window exists but a stale one does:** attach exactly **one stale informational
   note** (`stale: true`) and add **no reason** — status stays `available`.
5. A **stale 100% window must not suppress a fresh 95% window's `degraded`** result (guaranteed
   by steps 1–2 filtering to fresh first).

---

## Decision 5 — Fallback order: DEFER (no reserved-field comment); v5 rule text

Defer user-supplied fallback order; **no schema comment** (a phantom contract) — deferral
recorded only here. Substitution is by task fit/judgment, not a canonical scan (which would
silently make Claude the permanent fallback).

**Exact v5 text** WP-B5 inserts into `SUPERVISOR_RUN_ORCHESTRATION_SKILL`
(`src/shared/constants.ts`; version 4→5 at `src/main/supervisor/index.ts:3275`, `4:` hash
added to `previousHashes`):

> Resolve the desired lead and reviewer independently using explicit run argument → workspace
> default → built-in default. Then consult `availableProviders`. Keep a desired provider when
> it is `available`; keep a `degraded` desired provider only after stating its caveat in the
> preflight confirmation. When a desired provider is `unavailable`, propose a substitute from
> providers marked `available`, using task fit and the reported reasons; if no provider is
> `available`, a `degraded` provider may be proposed with its caveat. State the desired
> provider, preference source, substitute, and reason before spend. Never call
> `run_orchestration` until the user confirms the complete effective pair. If every provider is
> `unavailable`, do not launch and report the reasons. Same-provider pairs remain valid. No
> persisted fallback order exists in v5; when one is introduced, it governs substitute ranking.

---

## Decision 6 — Test matrix

**Pure resolver** (`provider-availability.test.ts`, fixture-only — no `where.exe`/`--version`):

- All four rows, canonical order; static `missing`→`unavailable`+`['not-detected']`;
  `available`→`installed:true`.
- **Precedence: static `not-detected` always wins** — `installed:false` + a runtime
  observation still `unavailable` (observation ignored for floor/membership).
- **Multiple simultaneous reasons** → deterministic order per
  `PROVIDER_AVAILABILITY_REASON_ORDER`.
- Claude **95 / 99 / 100 boundaries on both windows**; `max(fresh)` drives status.
- **Stale does not downgrade:** stale 100% + fresh 95% → `degraded` (not `unavailable`);
  stale-only → one informational `quota` note, no reason, `available`; tie-break prefers
  `seven_day`.
- Registry projection: `ProviderRuntimeObservation`→public `evidence`/`quota`;
  `free-usage-limit` carries `resetsAt` into note expiry.

**Classifier / observation lifecycle** (present only when the Grok artifact is recovered; if
omitted, so are these):

- `provider-quota-classifier.test.ts`: positive exhaustion fixture matches; **negative**
  startup-promo fixture does **not**; false-positive prose guard (mirrors
  `interactive-prompt-detector.test.ts` forbidden set).
- Lifecycle: process-lifetime retention; **reason-specific** clearing (agy `auth-banner` on
  `confirmed`; grok `free-usage-limit` never on `confirmed`); parsed-`resetsAt` expiry drops
  only that entry; simultaneous-reason map; distinct `lastProviderQuotaSig` isolation (quota +
  prompt checks don't erase each other; both cleared at cleanup `:505`).
- **Grok Stop-hook screen-gated clearing — both cases:**
  - quota observation → Stop hook while the exhaustion screen **remains visible** →
    observation **retained**;
  - quota observation → later Stop hook with a **non-exhaustion** current screen → observation
    **cleared**.
- Seam tests per chosen sites: `interactive-prompt-detector.test.ts` (agy signature),
  `status-monitor.test.ts` (grok two-poll emission over current-screen; cleanup delete),
  `agent-supervisor.test.ts` (agy emission at `_deliverAndConfirm`; reason-specific clear in
  `recordSendOutcome`; grok screen-gated clear on `forceIdleFromHook`).
- **Generic GroupThink stalls mutate nothing** — assert the `groupthink-v2.ts` STALL paths
  leave the registry empty.

**Route / MCP:**

- `src/main/api-identity.test.ts`: `availableProviders` always present, length 4, canonical
  order, on the real context-route contract.
- `scripts/mcp-tools-observability.test.js`: `get_my_context` pass-through carries the field.

**WP-B5 scaffold-contract tests** (skill behavior — *not* resolver behavior, since the pure
resolver neither launches nor resolves preference sources):

- v5 body contains the availability rule text (substitute-by-judgment; `unavailable`→no
  launch).
- **Only `unavailable` blocks launch**; a `degraded` provider stays eligible as fallback when
  none are `available`.
- **Preference-source surfaced**: explicit, workspace-default, and built-in desired choices
  that are `unavailable` each name their source in preflight.
- **Same-provider pair remains legal** after availability resolution.

**Build:** `tsc` in addition to runners (adds shared types + a new top-level source module).

---

<!-- groupthink_run: 290646e4 (mode=serial) — Lead: claude, Reviewer: codex -->
