---
name: codex-hook-deny-output-shape
description: >-
  When authoring, modifying, or debugging a hook script whose output Codex CLI consumes (PreToolUse deny, any hook emitting JSON or a nonzero exit) — or when a Codex hook logs 'PreToolUse Failed' / a security hook silently doesn't enforce while status hooks look healthy.
---
Codex CLI (verified 0.145.0) STRICTLY validates hook output and FAILS OPEN: any output it can't validate makes it log `hook: PreToolUse Failed` and RUN the command anyway.

Verified (2026-07-28/29 git-discard guard incident, isolation + 9-case acceptance matrix):
- ANY unknown top-level JSON key (e.g. a Claude/Grok-style `decision: "deny"` alongside `hookSpecificOutput`) → classified failed → command runs.
- ANY nonzero exit (e.g. legacy exit 2) → classified failed → command runs.
- The ONLY verified-blocking deny shape for Codex: stdout is exactly `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":...}}` (no other top-level keys, no stderr needed) with **exit 0** → Codex logs `PreToolUse Blocked` and the command does not run.
- Claude (verified 2.1.220) blocks on `hookSpecificOutput` at exit 0 AND on exit-2-with-stderr independently; it IGNORES a top-level `decision` key entirely. Grok's documented deny is the top-level `decision` key.

Do: emit per-provider — bare hookSpecificOutput + exit 0 for Codex; add top-level `decision`/stderr only for non-Codex callers. Discriminate by the stdin payload, NOT env vars (env like CLAUDE_* leaks across nested launches): Codex payloads carry a top-level `turn_id` (and `model`); Claude payloads carry `prompt_id`/`effort` and never `turn_id`. See `isCodexPayload()` in GUARD_GIT_DISCARD_MJS (src/shared/constants.ts).

Never assume a hook enforces because it fires: status hooks (plain exit 0, no JSON) pass validation and look healthy while a deny hook in the same lane is silently dead. Test enforcement by attempting the forbidden action and checking the target survived.
