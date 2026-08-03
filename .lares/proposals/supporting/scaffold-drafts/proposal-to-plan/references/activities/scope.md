# Activity playbook — `scope`

**Purpose.** The **first hardening step**: hardening **triage**, then **markup**. Scope decides
*what deserves extra effort* — which parts need groupthink deliberation, which would benefit from
online research — and **etches that decision as PLAN-INTENT markup on the flat proposal**, plus a
required dated `## Hardening scope` verdict. **Scope is NOT decomposition** (ruling 27); worker-sized
packaging is the LAST step (`package`), never here.

**Lane. Responsible supervisor only** (marking is a supervisor activity, ruling 29). A non-supervisor
lane that reaches `scope`/mark is **rejected and instructed** to hand off to the responsible
supervisor (see `SKILL.md` lane rules).

**Contracts loaded.** `references/contracts/intent-lifecycle.md` (§R1 — the PLAN-INTENT sentinel and
re-entry rules) and `references/contracts/folder-schema.md` (the *Bare proposal* clause — marking
lands on the flat proposal, before `plan.md` exists).

> **Scope owns marking. There is no standalone `mark` mode** — a separate mark would either
> duplicate `scope` or permit marking that bypasses hardening triage.

---

## Steps

1. **Read the proposal** end to end. Understand the parts and where uncertainty/risk concentrates.
2. **Take a second opinion (recommended, ruling 27).** An **independent** perspective —
   a Codex-lane agent, a worker read, or a **small groupthink used as the scoping vehicle itself**.
   Record **who was consulted, or that none was** (the second-opinion disposition).
3. **Triage each part. BOTH hardening kinds are live options for every part (Edward's rider):**
   - **groupthink deliberation** (`groupthink-serial` / `groupthink-parallel`), and/or
   - **online research** (`research`).
   A part may need one, both, or neither.
4. **Mark** each part that needs hardening with a **PLAN-INTENT** sentinel **on the proposal
   document** (§R1 — valid JSON, fresh `intent_id`, `kind`, `targets`, one-line `reason`). Marking
   predates `plan.md`; the marked proposal migrates into `plan.md` during `promote` (ruling 28).
5. **Write the required `## Hardening scope` verdict section** (below) — always, even when nothing
   needs hardening.

## The `## Hardening scope` verdict (REQUIRED, always)

Absence of intents alone **cannot** distinguish "scope completed, nothing needs hardening" from
"scope never happened." So `scope` **always** records an explicit, low-ceremony, human-readable
verdict as a `## Hardening scope` section in the proposal:

```markdown
## Hardening scope
- **Verdict (dated):** <YYYY-MM-DD> — <what needs hardening, or "nothing needs hardening — package and implement">
- **Second opinion:** <who was consulted (lane/agent), or "none consulted">
- **Marked intents:** <int_ids + one-line each, or "none — trivial proposal">
```

- **"Nothing needs hardening — package and implement" is a legitimate verdict** (ruling 27) and is
  **durably recorded here**, producing **no artificial intent**. `orient` reads this section to tell
  a trivial-scope verdict apart from scope-never-ran.
- This is **prose in an existing document — not a new sentinel.** A machine-parseable verdict would
  be a proposed §R1 amendment (Deferred), not invented here.
- The verdict migrates into `plan.md` and is summarized under `ARC.md → Decisions` during `promote`.

## Rules & acceptance touchpoints

- Marks land on the **flat proposal, before any `plan.md` exists** (Accept 1).
- A **trivial-scope verdict** produces **no artificial intent** and is durably recorded (Accept 2).
- PLAN-INTENT sentinels **parse as valid JSON** (Accept 12); reopening a decision mints a **new
  `intent_id`** carrying `supersedes_intent_id` (§R1) — never silently reuse a sentinel.
- Scope does **not** cut work packages and does **not** scaffold the folder — that is `package` and
  `promote` respectively.

## Hand-off

After the verdict is recorded and any intents are marked, the responsible supervisor runs
**`promote`** (atomic complete-folder scaffold). If the verdict is trivial ("nothing needs
hardening"), promote still runs to create the durable folder, then `package`.
