---
name: announced-action-must-run-in-turn
description: >-
  You are about to end a turn with a sentence describing an action you have not actually performed — "dispatching the next wave now", "reaping those workers and launching X", "kicking off the build", "I'll update the ledger" — especially when orchestrating agents or handing off between phases of work.
---
**Do the thing in the turn, or say plainly that it has not happened yet. Never narrate an action in the present tense and then end your turn.**

A turn ends when you stop emitting tool calls. Prose is not an action: "dispatching now" with no `launch_agent` call in that same turn means nothing was dispatched. Nothing errors, nothing warns — the work simply never happens, and if you are orchestrating, your fleet sits idle until the human speaks again. That idle gap is invisible to you and expensive for them; they may reasonably believe work is in flight for hours.

This is easy to fall into precisely when the turn already went well: you have gated a package, written a good summary, and close with a forward-looking sentence that *feels* like a natural sign-off. That sentence is the trap.

**When you catch yourself writing a present-tense action near the end of a turn:**

1. **Make the tool call now**, before writing the closing text. Dispatch, edit, stop, commit — whatever it is.
2. **Then report it in the past tense, with the evidence the call returned** — agent ids, commit hashes, handshake results. Past tense is only earned after the result comes back.
3. **If it genuinely cannot happen this turn** (a dependency is still running, you need an answer first), say so explicitly and name what unblocks it: "WP-5 is not dispatched — it depends on WP-3, which is still in flight." That is honest and actionable; "dispatching WP-5 now" is neither.

The same applies to ledgers, notes, and status files you own: "updating ARC.md" without the edit means ARC.md is stale and the next agent inherits a lie.

**Rule of thumb:** if a sentence in your final message describes something a tool would have to do, either a tool call for it appears earlier in that same turn, or the sentence is written in the future tense with its blocker named.
