# Playbook: Codex hook trust — what resets it, what doesn't

**Verified live:** 2026-05-29 (installed Codex `openai/0.134.0`, Windows path).

## TL;DR

- **Plain rebuild + same directory, no source change to hook constants → trust does NOT reset.** Safe.
- **New directory → per-workspace persisted trust does NOT carry over, but the dashboard's `--dangerously-bypass-hook-trust` launch flag runs the hooks anyway with no prompt.** Safe for dashboard launches.
- **The ONE real silent re-gate:** editing the hook command or `DASHBOARD_STATUS_SCRIPT_MJS` in `src/shared/constants.ts` AND bumping the scaffold version → command hash changes → stored `trusted_hash` no longer matches → Codex marks it "needs review." (§2.2 risk, confirmed real.)
- **Latent fragility:** the bypass flag is only appended when the launch command is the pristine framework default (`DEFAULT_COMMAND`). A *custom* per-workspace codex command drops the flag → back to needing persisted trust.

## Where Codex stores trust

`~/.codex/config.toml` (Windows: `C:\Users\<user>\.codex\config.toml`), section `[hooks.state]`.
Key format: **`<config-file-absolute-path>:<event>:<pos>`** → `trusted_hash = "sha256:…"` (+ optional `enabled = true`).

- `trusted_hash` is a hash of the **hook command string** (which includes the absolute script path).
- `enabled = true` is added only when the user **persists** trust (presses `t` in the TUI). Invocation-time bypass does NOT write it.
- Trust is **per-workspace** (keyed by that workspace's config.toml path), NOT global. Example seen: AgentDashboard entries had `enabled = true` (user pressed `t`); JobHunt entries had only `trusted_hash`, no `enabled` (never pressed).

## Two config files both register the hooks ("Installed 2" in the TUI)

1. **`~/.codex/dashboard-worker.config.toml`** + `~/.codex/dashboard-status.mjs` — the shared CODEX_HOME profile, loaded via `codex --profile dashboard-worker`.
   - Written by `ensureCodexHookProfile()` (`src/main/supervisor/index.ts` ~1226).
   - **Rewritten once per app restart** (in-memory `codexHookProfileEnsured` guard), **unconditional overwrite** — but from constants, so byte-identical unless source changed → same hash → trust survives.
2. **`<workspace>/.dashboard/workers/codex/.codex/config.toml`** — per-workspace.
   - Written by `ensureWorkerScaffold()` from `WORKER_CODEX_CONFIG_TOML`.
   - **Only (re)written if missing or scaffold version bumped** (sidecar `.dashboard/.scaffold-versions.json`). A plain rebuild does NOT touch it.

Hook command strings (the thing that gets hashed):
- Stop:  `node "<script>"`            → POSTs idle  (hook-stop)
- UserPromptSubmit: `node "<script>" working` → POSTs working (hook-start)
(The trailing ` working` makes the two commands hash differently → independently trust-gated.)

## The launch flag (the safety net)

`src/main/supervisor/index.ts:645` appends, for supervised codex on the framework-default command:
```
--profile dashboard-worker --dangerously-bypass-hook-trust
```
- Flag confirmed present in installed Codex: *"Run enabled hooks without requiring persisted hook trust for this invocation."*
- It bypasses trust **per-invocation**; it does NOT persist trust. So the interactive TUI can still show hooks as "needs review" even while they're running via the bypass — which is why pressing `t` (persisting) is cosmetic for dashboard launches but mandatory for a manual `codex` session.
- Condition gate: only added when `command === defaultCmd` (pristine `DEFAULT_COMMAND = 'claude --dangerously-skip-permissions --chrome'`). Custom workspace command → flag dropped → fragility (see TL;DR).

## How to inspect trust state quickly

- `Read C:\Users\<user>\.codex\config.toml` → look at `[hooks.state.*]` keys for the workspace's `.dashboard/workers/codex/.codex/config.toml` path; `enabled = true` = persisted-trusted.
- `~/.codex/dashboard-worker.config.toml` → the shared profile + its own `[hooks.state]`.
- `codex --help | grep -i trust` → confirm `--dangerously-bypass-hook-trust` exists in the installed version.

## UPDATE 2026-05-29b — profile-path refactor re-gates trust (new finding)

An in-flight refactor (uncommitted: `src/shared/constants.ts` + `src/main/supervisor/index.ts`)
moved supervised-codex hook delivery **off** the per-workspace
`<ws>\.dashboard\workers\codex\.codex\config.toml` and **onto** a shared profile
`~/.codex/dashboard-worker.config.toml`, loaded via `codex --profile dashboard-worker`
(new consts `CODEX_WORKER_PROFILE_TOML` / `CODEX_WORKER_PROFILE_NAME`; launch builder appends
`--profile dashboard-worker --dangerously-bypass-hook-trust` when `command === defaultCmd`).

**Symptom:** after a rebuild+restart, user re-prompted for Codex hook permission even though the
bypass flag is confirmed present on every running process (verified via Win32_Process CommandLine).

**Cause:** Codex keys hook trust by **config-file path** + command hash. `~/.codex/config.toml
[hooks.state]` only had persisted `enabled = true` rows for the OLD per-workspace path. The NEW
profile path (`C:\Users\turke\.codex\dashboard-worker.config.toml:stop:0:0` /
`:user_prompt_submit:0:0`) has **no `[hooks.state]` entry** → first-time/never-seen → prompt.
The `--dangerously-bypass-hook-trust` flag runs *enabled* hooks per-invocation but does NOT make
or persist the **first-time** trust decision on a brand-new config path. So the bypass let the
workers RUN (Codex Test 1–6 launched idle, turns:1) but didn't suppress the initial prompt.

**Fix (chosen 2026-05-29):** user presses `t` once per hook at the prompt → writes trust keyed to
the new profile path → quiet across restarts. Durable code fix (not yet done): seed `[hooks.state]`
for the profile path when writing `dashboard-worker.config.toml`. Candidate owner: worker
`a03ed172` "Hooks for everything".

**General rule:** any change to the hook **config-file path** (not just the command string) is a
silent re-gate, because trust is keyed on that path. Add this to the §2.2 re-gate triggers list
alongside the command-hash change.

## UPDATE 2026-06-02 — CONFIRMED LIVE: the profile rewrite wipes trust every restart (bug B8)

Live canary verify (HOOK_SYSTEM_DESIGN.md §8.3 step 1 / §8.4). Launched throwaway
worker-lane codex `dd68c2f5` on the post-canary build. Result: `hook_status` → **broken**
in the 8 s window, **zero** hook events, agent blocked at the Codex hook-trust review
panel (`⚠ 4 hooks need review`). Two compounding faults, both now confirmed against
running code + on-disk before/after:

1. **`ensureCodexHookProfile()` unconditionally overwrites** `~/.codex/dashboard-worker.config.toml`
   on the FIRST codex launch after each app restart (in-memory `codexHookProfileEnsured`
   Set guard; dist `index.js:1230-1231` — plain `writeFileSync`, no merge, no hash-guard).
   The P0 SessionStart/`[features]` additions changed the body AND the rewrite **dropped the
   `[hooks.state]` `trusted_hash` block** the user had persisted with `t`. Verified: file went
   from `{stop, user_prompt_submit}` *with* trusted_hash → new body with NO `[hooks.state]`.
2. **`--dangerously-bypass-hook-trust` can't cover NEW hooks** — it runs only *already-enabled*
   hooks for the invocation. The new SessionStart hooks are `Active 0 / Review 2`, so the bypass
   skips them and Codex blocks the whole turn on the review panel → even previously-trusted
   Stop/UserPromptSubmit don't fire. Adding SessionStart **regressed** codex workers.

**This is the root cause of the user's recurring "codex keeps asking for hook permission after
restart" complaint.** The canary works correctly (it catches this); the underlying delivery is
the bug. Durable fix = SEED `[hooks.state]` (trusted_hash + `enabled = true`) for every hook the
profile writer installs, AND stop clobbering any existing state (merge / hash-guard). Slot into P0.

Verify tooling added: `scripts/hook-canary-verify.mjs <id>` — prints `hook_status` /
`last_hook_event_at` columns (the SessionStart health ping writes NO event row, so the
events-only `hook-evidence-by-agent.mjs` can't see it).

## UPDATE 2026-06-03 — B8 FIXED in code (pending live-verify after restart)

Worker `3d3cd123` implemented the durable B8 fix in `ensureCodexHookProfile()` (src/main/supervisor/index.ts):
- **Seeds `[hooks.state]` trust** for every hook it installs (Stop / UserPromptSubmit / SessionStart), both Windows + WSL branches, computed at write time from the actual command strings (no hardcoded hashes).
- **Non-clobbering:** skips the write when the on-disk body is identical AND all trust hashes are present → a plain restart no longer wipes trust, and a user's manual `t` survives.
- 4 pure exported helpers: `codexHookTrustHash`, `parseCodexProfileHooks`, `buildCodexHooksStateSection`, `codexProfileTrustIntact`.

**Verified hash recipe (reproduces all 3 §8.4 ground-truth hashes byte-for-byte):**
`trusted_hash = "sha256:" + sha256(compactJSON(recursivelyKeySorted({ event_name, hooks:[{type:"command", command, timeout, async:false}] })))`
— null fields dropped, keys recursively sorted, `timeout=30`, `event_name` lower-snake (`stop`/`user_prompt_submit`/`session_start`), `command` = exact installed string (forward-slash script path on Windows). This matches plan §2.2 Fix A. `npm run build:main` exit 0; `test:supervisor` green.

**Still PENDING:** live-verify after an app restart — delete `[hooks.state]` from `~/.codex/dashboard-worker.config.toml`, restart, launch a fresh-session codex worker, confirm NO trust panel + `hook-canary-verify.mjs` shows healthy with zero manual `t`; then restart again and confirm the trust block survives (non-clobber). Full write-up in docs/HOOK_SYSTEM_DESIGN.md §8.5.

Same session also shipped the **synchronous confirm-and-retry ("re-enter") mechanism** (worker `c9fbbb6b`, plan global-hook-rollout §1/§2.3/§2.4) — Claude-first throwing contract, Codex behind an empirical `hasObservedStartHook` self-test, Gemini/non-hook on reactive fallback; C1 surface = `Agent.lastSendError` via the status endpoint. Built clean, also pending the same restart for live-verify. Note: an untracked orphan test `wsl-runner-stderr.test` fails on a never-existing symbol `buildTmuxFailureLogLines` — pre-existing, not from this session.

## Action items flagged (not yet done)

- Reconcile rollout doc `plans/global-hook-rollout-and-submit-confirmation.md` §2.2 with these confirmed facts (trust keying = per-workspace config path + command hash; bypass flag IS applied; custom-command fragility).
- Consider hardening: always append `--dangerously-bypass-hook-trust` for supervised codex regardless of base command, so a custom workspace command can't silently drop it.
