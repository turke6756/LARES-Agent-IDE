---
plan_artifact_id: plan_0e1425af
intent_id: int_6781b552
kind: deliberation
---

# Deliberation — promotion-prompt design (prop_0e1425af Part 1b + open questions 1–2)

## What this deliberation decides

Three coupled design calls for converting `proposal-to-plan`'s promotion arc from an
agent-self-service skill into a **human-gestured saved prompt**, landing on the *existing*
`PromoteToPlanPanel` wire and composing with prop_e0001372 C1's "one promote story":

1. **Where the saved promotion prompt lives** — constant vs state-dir template.
2. **Promote-gesture targeting** — always workspace supervisor vs a picker with a default.
3. **How this composes** with prop_e0001372 C1's single-promote-story on the existing wire.

## Grounding: what the code already does (verified against source)

- The promote gesture is **already mounted and already dispatches**. `ProposalCardGallery.tsx:127`
  renders `PromoteToPlanPanel`; the panel already contains a **supervisor picker** — search box,
  live-supervisor list, a "New supervisor" option with editable title (`selectedId` defaults to
  `NEW_SUPERVISOR_ID`, `newTitle` defaults to `'Planning supervisor'`).
- On dispatch it calls `dispatchProposalPromotion` (`promotion-dispatch.ts:46`), sending the string
  from **`buildProposalToPlanInstruction(proposalFilePath)`** (`promotion-dispatch.ts:6–13`) — today a
  hardcoded 4-line renderer string that says *"Run the `proposal-to-plan` skill … carry it through
  capture/scope/promote as applicable."* It is compiled into the renderer bundle — not a scaffold
  constant, not a state-dir file.
- The structural workspace supervisor is retrievable client-side:
  **`window.api.agents.getSupervisor(workspaceId): Promise<Agent | null>`** (`preload/index.ts:72`,
  `types.ts:2633`), backed by `getSupervisorAgent`.
- `deriveProposalCardMetadata` (`proposal-card-metadata.ts:95`) already parses proposal frontmatter
  into `fields`, so `fields.artifact_id` is in hand at card-build time but is not surfaced on
  `ProposalCardMetadata` or passed to the panel.
- The `PromoteDialog`/server-saga path (`promote-proposal.ts`, `promotion-reconciler.ts`, the
  `database.ts:8003-8065` enrich saga) remains partly startup-wired — the second-writer problem
  prop_e0001372 C1 exists to resolve.

**Consequence:** OQ2 ("picker vs always-workspace-supervisor") is resolved *structurally* — a picker
exists. The live surface is narrower than the proposal framed: **what default the picker carries**,
**where the prompt text lives**, and **what that text now says** (it must stop naming `capture` as a
step and must bind a validated `artifact_id`).

---

## Decision 1 — Storage: a template **constant in `src/shared/constants.ts`**

**Decision: constant.** Move the instruction body out of the inline `buildProposalToPlanInstruction`
function into a named constant **`PROPOSAL_PROMOTION_PROMPT_TEMPLATE`** in `src/shared/constants.ts`,
with `{{proposalPath}}` and `{{artifactId}}` placeholders; `buildProposalToPlanInstruction`
interpolates them.

**Why constant, not state-dir template:**
- The string is renderer-consumed from the compiled bundle, not provisioned into the workspace state
  dir. A state-dir editable template is a genuine feature; OQ1's own lean is "constant first —
  user-editable templates are a feature, not a prerequisite."
- **Scaffold-version-bump does NOT apply to this constant.** `PROPOSAL_PROMOTION_PROMPT_TEMPLATE` is
  not a `GUARD_*/WORKER_*/SUPERVISOR_*/RESEARCHER_*` provisioned scaffold body deployed into `.lares/`;
  it ships in the renderer bundle. The worker must not bump a scaffold version for *this* constant.
  **This is explicitly distinct from the skill-provisioning edits in prop_0e1425af Part 1a/1c**
  (`write-proposal`, `read-planning-surface`, the `proposal-to-plan` trigger rewrite) — *those* deploy
  into the state dir and **do** require a scaffold-version bump. Different change, different rule;
  do not conflate them.
- Keeps the proposal's **"pointer, not payload"** property: a few short paragraphs binding
  {proposal path, artifact_id} and pointing at the on-disk method; never inlining the playbooks.

**Deferred (out of scope, recorded for a future proposal):** a state-dir `promotion-prompt.md`
template with per-workspace override + version bump. Not built now.

---

## Decision 2 — Targeting: keep the picker; **default to the structural workspace supervisor**

**Decision:** Keep the mounted picker. Default its selection to
**`window.api.agents.getSupervisor(workspace.id)`**, falling back to New supervisor only when that
API returns `null` or an ineligible agent. This matches the proposal's explicit lean while preserving
the proven dedicated-planning-supervisor option (still one click away in the picker).

**Correction from an earlier draft:** the "'the workspace supervisor' is undefined" claim was wrong.
The multi-supervisor invariant forbids *inferring* a supervisor from the working directory, but the
product already exposes its **chosen structural** supervisor via `getSupervisor`/`getSupervisorAgent`.
Defaulting to that resolved agent is legitimate; it is not directory inference.

**Implementation contract (in `PromoteToPlanPanel.tsx`):**
- Initialize `selectedId` to `NEW_SUPERVISOR_ID` (safe synchronous default).
- On mount, a `useEffect` calls `window.api.agents.getSupervisor(workspace.id)` **asynchronously**.
- Guard against races with a `hasUserSelectedRef` (a `useRef(false)` set to `true` on **every** explicit
  user interaction with the target choice — each picker row `onClick`, the New-supervisor row `onClick`,
  **and the New-supervisor title `onChange`** (beginning to name a New supervisor is an explicit choice).
  The async resolver sets `selectedId` to the resolved supervisor's id **only if
  `hasUserSelectedRef.current === false`** — a late API response must never overwrite a manual choice.
- **Eligibility:** the resolved agent must be non-null, `isSupervisor`, and `workspaceId === workspace.id`.
  A **terminal** (`done`/`crashed`) resolved supervisor is still eligible as the default — dispatch
  routes it through the existing revive path (`TERMINAL_AGENT_STATUSES` → `deps.revive`). If ineligible
  or null, leave the New-supervisor default.
- **Visible selection (no silent default).** The resolved supervisor may be absent from the store-backed
  `supervisors` list (e.g. terminal, or not yet loaded). Hold it in local state (`resolvedDefault`) and
  **merge it into the rendered picker options with id-deduplication** so the defaulted agent shows as a
  visibly selected row — never dispatch to an agent that has no highlighted row. (Equivalently, await
  `loadAgents(workspace.id)` before applying the default; the merge approach is preferred because it
  also covers terminal supervisors the live filter omits.) Include `resolvedDefault` in the
  `selectedAgent` resolution so the concrete Agent is available at dispatch.

**Tests (add to `PromoteToPlanPanel.test.tsx`):**
- resolved workspace supervisor is selected by default once `getSupervisor` resolves;
- an API-resolved supervisor **absent from the store** is **visibly selected** (its row is rendered and
  marked selected), not silently defaulted;
- `getSupervisor` → `null` falls back to New supervisor;
- a user picker selection made before resolution is **not** overwritten by the late resolution;
- **editing the New-supervisor title before resolution is not overwritten by the late resolution**;
- a terminal default supervisor dispatches via the revive path.

---

## Decision 3 — `artifact_id` is required and validated at both boundaries

**Decision:** Part 1b requires the injected prompt to name the proposal's `artifact_id`, and promotion
identity derives from it — so an ambiguous `artifact_id` dispatch is **rejected**, not softened, and
the rejection is enforced at **both** the panel (UX) and the exported dispatch boundary (safety).

- **Shared validator.** Add and export `isValidProposalArtifactId(value: string | null | undefined): boolean`
  (regex `/^prop_[0-9a-f]{8}$/` on the trimmed value) from `promotion-dispatch.ts`. Use it in **both**
  the panel and `dispatchProposalPromotion` — one source of truth, no divergent regexes.
- **Panel (UX gate).** Surface `artifactId` on the card metadata (WP2), thread it to the panel
  (WP3/WP4). When invalid: render an actionable error (e.g. *"This proposal has no valid `artifact_id`
  (expected `prop_########`). Fix the proposal frontmatter before promoting."*) and **disable Dispatch**
  (extend the existing `disabled=` predicate).
- **Dispatch (boundary safety).** `dispatchProposalPromotion` is an exported boundary reachable from
  tests or future callers. It **must throw before any `launch`/`sendInput`/`revive` side effect** when
  `isValidProposalArtifactId(input.proposalArtifactId)` is false.
- Because both gates enforce validity, the template's `{{artifactId}}` always receives a well-formed
  value — no fallback substitution, no "read it from frontmatter" hedge.

**Tests:** metadata test for `artifactId` extraction (valid / missing); panel tests for valid id
(Dispatch enabled, id reaches the instruction), missing id (error + Dispatch disabled), malformed id
(error + Dispatch disabled); **dispatch-level test that an invalid id throws with no side effects**
(assert none of the `launch`/`sendInput`/`revive` deps were called).

---

## Decision 4 — Composition with prop_e0001372 C1: division of responsibility + a hard dependency boundary

**The three surfaces, stated explicitly:**
- **`PromoteToPlanPanel` (this wire) is the authoritative human command surface** — the single place
  the human issues the promote gesture and picks the target supervisor.
- **The supervisor-driven `proposal-to-plan` method is the disk writer** — it produces the plan folder
  (plan.json, ARC.md, supplements) as resumable ground truth.
- **The prop_e0001372 B-series reconciler is the disk → SQLite projection** — it reads what the method
  wrote on disk and materializes the DB state the UI reads. No promotion writes go directly to SQLite
  from the command surface.

This deliberation **selects the mounted panel wire** as that single command surface and rewrites what
it injects (Decision 5 / WP1, WP5). It does **not** delete saga code.

**Dependency boundary recorded for `int_9e5d0c47` (C1):** the saga is **not** uniformly dead — C1 itself
established that parts remain startup-wired (the IPC service and the pending-request reconciliation that
run at startup). Before deleting command-side saga code, `int_9e5d0c47` **must** (a) inventory and
migrate any **pending promotion requests**, and (b) account for **startup reconciliation**, so no
in-flight promotion is stranded. This plan chooses the mounted wire without claiming that all saga
machinery is safely deletable; that inventory + migration is C1's work, not this deliberation's.

---

## Decision 5 — Prompt wording: authorized, not blindly synchronous

The injected prompt authorizes continuous progress **without** implying uninterrupted synchronous
execution — deliberation phases can legitimately wait on returned orchestration output. Wording:

- Do **not** seek human permission between phases.
- When an authorized **asynchronous run is pending** (e.g. a GroupThink deliberation), **wait for or
  resume from its returned event, then continue** — do not poll, and do not package before all active
  outputs are folded in.
- The **method library remains authoritative** for intent-rung and packaging gates; the single mandated
  human stop is after `package`, presenting the plain-language overview and awaiting the explicit
  implementation trigger (prop_e0001372 A2).
- Do **not** run `capture` (authoring is complete — the proposal already exists).

---

## Concrete edits (executable work packages)

**WP1 — Add the template constant.** `src/shared/constants.ts`
Add near the other agent-facing message constants:

```ts
// Injected by the Promote-to-plan gesture (renderer-consumed from the bundle; NOT a
// provisioned scaffold — no scaffold-version bump for THIS constant). Pointer-not-payload:
// binds the proposal and points at the on-disk method library.
export const PROPOSAL_PROMOTION_PROMPT_TEMPLATE = [
  'Promote this proposal into a plan. This message is the human promote gesture —',
  'you are authorized to proceed through the lifecycle without asking permission between phases.',
  '',
  'Proposal path: {{proposalPath}}',
  'Proposal artifact_id: {{artifactId}}',
  '',
  'Load the promotion method from the installed `proposal-to-plan` skill (follow its references)',
  'and carry this proposal through, in order: scope -> promote -> deliberate -> integrate -> package.',
  'Do NOT run capture — authoring is complete; this proposal already exists.',
  '',
  'Do not seek human permission between phases. When an authorized asynchronous run is pending',
  '(e.g. a GroupThink deliberation), wait for or resume from its returned event, then continue;',
  'do not poll, and do not package before all active outputs are folded in. The method library',
  'remains authoritative for intent-rung and packaging gates. The one mandated stop is AFTER',
  'package, where you present the plain-language human overview and await the explicit',
  'implementation trigger. You are the responsible supervisor for the resulting plan folder.',
].join('\n');
```

(ASCII `->` is used inside the template string deliberately, so the injected prompt carries no
non-ASCII arrow into agent input.)

**WP2 — Surface `artifactId` on card metadata.** `src/renderer/components/plan/proposal-card-metadata.ts`
- Add `artifactId: string | null;` to the `ProposalCardMetadata` interface.
- In `deriveProposalCardMetadata`'s return object add: `artifactId: fields.artifact_id?.trim() || null,`.

**WP3 — Thread it through the gallery.** `src/renderer/components/plan/ProposalCardGallery.tsx`
- At the `<PromoteToPlanPanel .../>` call site (~line 127) add prop `proposalArtifactId={selected.artifactId}`.

**WP4 — Accept, validate, forward in the panel.** `src/renderer/components/plan/PromoteToPlanPanel.tsx`
- Add `proposalArtifactId?: string | null;` to `Props`.
- Import `isValidProposalArtifactId` from `./promotion-dispatch`; normalize and validate once so the
  value passed to dispatch is a definite `string` (narrowing `string | null | undefined` → `string`):
  ```ts
  const normalizedArtifactId = proposalArtifactId?.trim() ?? '';
  const artifactIdValid = isValidProposalArtifactId(normalizedArtifactId);
  ```
- When `!artifactIdValid`, render an actionable error and add `|| !artifactIdValid` to the Dispatch
  button's `disabled=` predicate.
- Default-selection wiring per Decision 2 (async `getSupervisor`, `hasUserSelectedRef` guard set on
  every picker `onClick` **and the New-supervisor title `onChange`**, `resolvedDefault` state merged
  into the visible picker options with id-dedup, eligibility check, terminal→revive).
- Pass `proposalArtifactId: normalizedArtifactId` into `dispatchProposalPromotion({ … })`.

**WP5 — Add the shared validator + rewrite the builder/dispatch.** `src/renderer/components/plan/promotion-dispatch.ts`
- Add and export:
  ```ts
  export function isValidProposalArtifactId(value: string | null | undefined): boolean {
    return /^prop_[0-9a-f]{8}$/.test((value ?? '').trim());
  }
  ```
- Import `PROPOSAL_PROMOTION_PROMPT_TEMPLATE` from `../../../shared/constants`.
- Replace the builder:
  ```ts
  export function buildProposalToPlanInstruction(
    proposalFilePath: string,
    proposalArtifactId: string,
  ): string {
    return PROPOSAL_PROMOTION_PROMPT_TEMPLATE
      .replace('{{proposalPath}}', proposalFilePath)
      .replace('{{artifactId}}', proposalArtifactId.trim());
  }
  ```
- Add `proposalArtifactId: string;` to the `dispatchProposalPromotion` input type. At the **top of the
  function body, before constructing `deps` or taking any side effect**, throw when the id is invalid:
  ```ts
  if (!isValidProposalArtifactId(input.proposalArtifactId)) {
    throw new Error('Cannot promote: proposal is missing a valid artifact_id (expected prop_########).');
  }
  ```
- Call `buildProposalToPlanInstruction(input.proposalFilePath, input.proposalArtifactId)`.

**WP6 — Tests.**
- `src/renderer/components/plan/proposal-card-metadata.test.ts`: `artifactId` extracted for a valid
  `prop_########`; `null` when absent.
- `src/renderer/components/plan/promotion-dispatch.test.ts`: exact path/ID binding in the produced
  instruction — assert **absence of the old self-service wording** (`capture/scope/promote as applicable`),
  **presence of the explicit `Do NOT run capture` prohibition**, the `Proposal artifact_id:` line, and
  the `scope -> promote -> deliberate -> integrate -> package` ordering; all three dispatch paths —
  **live** (`sendInput`), **revive** (terminal → `revive`), **new** (`launch`); and an **invalid-id
  call throws with no side effects** (none of the `launch`/`sendInput`/`revive` deps invoked).
- `PromoteToPlanPanel.test.tsx`: default-resolution races (resolved-selects-default;
  API-resolved-supervisor-absent-from-store-is-visibly-selected; null→New;
  manual-picker-choice-not-overwritten-by-late-resolution;
  **title-edit-not-overwritten-by-late-resolution**; terminal-default→revive) **and** id blocking
  (valid enables Dispatch + id reaches instruction; missing → error + Dispatch disabled; malformed →
  error + Dispatch disabled).
- Gallery boundary test (extend `ProposalCardGallery`'s existing test, or add one): the selected card's
  `artifactId` reaches `PromoteToPlanPanel`'s `proposalArtifactId` prop.

**WP7 — Verify.**
- Build both processes: `npm run build`.
- Run the renderer suite: **`npm run test:renderer`** (i.e. `vitest run --config vitest.config.ts`).
  To iterate on just these files: `npx vitest run --config vitest.config.ts src/renderer/components/plan`.
- No scaffold version bump for `PROPOSAL_PROMOTION_PROMPT_TEMPLATE`. No state-dir writes. No saga code
  touched.

---

## Out of scope (sibling intents / already specified, no hardening)

- `write-proposal` skill, `read-planning-surface` skill, authorship contract (prop_0e1425af Parts
  1a/1c/2) — specified, no hardening. **These skill-provisioning edits DO require a scaffold-version
  bump** — distinct from WP1's renderer constant.
- `proposal-to-plan` SKILL.md trigger rewrite (Part 1a/1b skill-side) — sibling WP. This deliberation
  makes the injected prompt self-contained by **pointing at the installed `proposal-to-plan` skill's
  references** (provider-neutral; not a hardcoded filesystem path), so it does not depend on the
  skill's auto-trigger, which is being removed.
- Saga deletion / reconciler single-writer inventory + pending-request/startup-reconciliation
  migration — prop_e0001372 `int_9e5d0c47` (C1). This plan asserts compatibility and records the
  dependency boundary only.
- State-dir editable promotion-prompt template — deferred future feature.


<!-- groupthink_run: 2a15b2d4 (mode=serial) -->
