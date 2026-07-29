---
name: grep-emitted-strings-not-helper-name
description: >-
  You're gating, removing, or renaming diagnostic/log output (a debug flag, a console.warn helper, a metric line) and you grep tests for the helper symbol to check nothing depends on it.
---
Also grep for the PAYLOAD strings the instrumentation emits (tag names, message fragments). A test can assert on a spied console.warn's arguments without ever importing or naming the helper — a symbol-only grep reports "no coverage" while a content grep finds the assertion. If a test relied on an implicit auto-arm (dev-mode flag, env var), fix it by arming the gate explicitly in that test, not by weakening the assertion.
