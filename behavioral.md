
## WB-15: On a shared dirty tree, `git add <path>` still sweeps up OTHER workers' edits to that same path — diff each path before staging

**Trigger:** You're told the tree has many uncommitted files from concurrent
workstreams and to commit "explicit paths only," and your change touches a
long-lived shared file (a store, an index, a constants module, a test runner).

**Action:** Explicit-path staging protects you from files you never touched — it
does NOT protect the files you did. If someone else already had uncommitted
edits in that same file, `git add <path>` stages theirs alongside yours and your
"surgical" commit silently absorbs their in-flight work. Before staging, run
`git diff -- <path>` on every path and check the hunks are all yours; compare the
commit's `--stat` against the size of your own edit as a second check. When a
file has foreign hunks, stage only yours: write the diff to a file, keep just
your hunks, and `git apply --cached --recount` it. Nothing is lost either way
(it's committed, not destroyed), but the attribution mess is real and the fix —
a reset — is exactly what you're forbidden to run. Say so in your summary if it
already happened.

**Source:** 2026-07-20 dead-agent-chat task — a 10-path `git add` produced 840
insertions / 237 deletions against a ~250-line change, absorbing other workers'
pending edits to constants.ts, TerminalPanel.tsx, ChatPane.tsx and index.ts. The
follow-up commit used the single-hunk `git apply --cached` route and staged
exactly the intended one line out of eight.

## WB-16: An `unref()`ed timer that an operation is *awaiting* lets Node exit mid-operation

**Trigger:** You add a bounded wait — `Promise.race`/`setTimeout` — inside a
long-lived service (a stop, a drain, a handshake) and reflexively call
`timer.unref?.()` because "a timer must never hold the event loop open at
shutdown."

**Action:** `unref()` is right for *fire-and-forget* timers (a deferred cache
release, a heartbeat). It is WRONG for a timer that is the load-bearing half of
an in-flight `await`: if nothing else keeps the loop alive, Node drains and
exits **cleanly, exit code 0**, while your operation is still suspended. In a
GUI main process there is always another handle, so this hides in production and
only surfaces in a headless test — as a test file that stops printing partway
through and still "passes." If a summary line is missing from a test's output,
suspect a silent event-loop drain before you suspect the assertions.

**Source:** 2026-07-20 idle-agent-lifecycle leg 1 — `stopAgent`'s
runner-exit-vs-timeout race unref'd its timeout; the new test file exited 0
after 15 of 26 tests with no summary. Dropping the `unref()` fixed it.
