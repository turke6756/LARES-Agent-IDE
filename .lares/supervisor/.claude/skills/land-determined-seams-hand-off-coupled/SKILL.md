---
name: land-determined-seams-hand-off-coupled
description: >-
  A handoff hands you a large end-to-end wiring task that plainly exceeds one context, part of which is self-contained fully-specified leaf pieces while the rest is a tightly-coupled assembly depending on live/impure state.
---
Land the fully-determined leaf pieces first and prove them — for DB helpers, unit-test the SQL against the REAL schema (a build/tsc pass can't catch a wrong column name; a sql.js + initDatabase stand-in can). Then STOP and hand off the coupled remainder with the exact contract, rather than starting the big module and leaving it half-compiling for the next worker to untangle. A green, tested slice the remainder will directly consume beats a larger incoherent one. Verify the load-bearing acceptance mechanic BEFORE coding against it, and if it turns on a subtle precondition (e.g. "the candidate must still be resident on disk, not already trimmed"), confirm it holds in the real source and state it plainly in the handoff.
