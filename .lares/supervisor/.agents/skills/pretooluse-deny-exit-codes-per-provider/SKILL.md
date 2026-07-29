---
name: pretooluse-deny-exit-codes-per-provider
description: >-
  When writing, reviewing, or debugging a PreToolUse hook script that must BLOCK a tool call (a deny/guard hook) for Claude Code or Codex — especially one shared by both providers, or when a deny hook "looks healthy" (emits correct deny JSON) but the command still runs.
---
# Deny hooks need per-provider exit codes

**The trap:** a PreToolUse deny hook can emit a perfectly correct
`{"hookSpecificOutput":{"permissionDecision":"deny"}}` JSON object and still block
NOTHING — because the two harnesses read opposite signals:

- **Claude Code (verified on 2.1.220):** does NOT honor an exit-0 JSON deny for a
  Bash PreToolUse hook — in any session type (interactive, headless `-p`,
  child-session). **Only exit code 2 blocks.** The JSON shape is irrelevant to
  enforcement; top-level `decision:"deny"` doesn't rescue it either.
- **Codex CLI:** the opposite — it strictly validates hook output and **fails OPEN
  on any nonzero exit**. A codex deny must be **exit 0 + the bare
  `hookSpecificOutput` deny object** on stdout.

**Do this:** in a shared hook script, detect the calling harness from the stdin
payload (codex payloads are distinguishable — see `isCodexPayload` in
AgentDashboard's `GUARD_GIT_DISCARD_MJS`) and end the deny path with
`process.exit(codex ? 0 : 2)`, keeping the JSON emission for both.

**Verify by observation, not by config:** "we wrote the deny JSON" is not
acceptance. Run the guarded command in each lane and watch it actually get
blocked (and the protected content survive). A guard that silently stopped
enforcing looks identical to a healthy one from the outside — this exact failure
disarmed a git-discard guard on the Claude lane for days while every status
surface looked green.
