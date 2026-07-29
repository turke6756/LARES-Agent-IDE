---
name: absence-fixture-from-real-artifact
description: >-
  You're writing or extending a test that asserts an ABSENCE — "no X ever reaches the output": redaction, sanitization, escaping, leak guards.
---
Enumerate the real vectors out of a real output artifact (grep it, group hits by field path) and seed EVERY distinct shape into the fixture. A fixture built from what you imagined the data looks like passes forever while the real vector walks straight through — an absence-assertion over a fixture that never contained the thing is green by construction. Then mutate the fix and watch the assertion fail. Also check that a NEW filter/drop you add doesn't quietly retire an OLD vector from the fixture (an id that now gets dropped is no longer proving it gets redacted); if it does, re-seed that vector somewhere the new filter cannot reach.
