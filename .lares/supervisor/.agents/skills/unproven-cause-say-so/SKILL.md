---
name: unproven-cause-say-so
description: >-
  Diagnosing a bug where a symptom or a code read contradicts your clean root-cause story — something your theory cannot mechanically produce.
---
Treat the contradiction as evidence, not noise. Trace the mechanism in code before asserting a cause; if you cannot construct a concrete code-to-symptom path, say "I can't explain this yet" rather than stretching one theory to cover everything. Keep three buckets distinct: proven-from-code, plausible-hypothesis, and can't-yet-explain. When a bug self-healed and won't reproduce, the deliverable is the minimal instrumentation to catch it next time — not a fix against an unproven cause.
