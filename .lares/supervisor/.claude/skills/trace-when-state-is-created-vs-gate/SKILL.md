---
name: trace-when-state-is-created-vs-gate
description: >-
  Your brief hands you a verified diagnosis plus a fix keyed to a state flag ("when an edit session exists, bypass the check"), and separately demands an invariant the same check must still protect.
---
Before coding, trace the order of operations: if the state is created BEFORE the gate runs on the very path the gate must protect (e.g. the entry click creates the session, then the check fires), the literal fix silently disables the protection the brief says to keep. Refine the condition to the signal that actually distinguishes the two cases (here: a live/dirty draft, not mere session existence), satisfy BOTH stated requirements, and report the refinement as a spec correction — don't silently pick one requirement over the other.
