---
name: acceptance-divergence-assert-truth
description: >-
  You're writing an env-gated acceptance test against live data and the prompt's expected result — a specific proposal, a named rediscovery — does not surface when you run it.
---
Before touching the assertion, instrument the pipeline end-to-end to find the EXACT reason (a sibling workstream already applied the fix; a guard/gate downgraded it; the data is cross-workspace; the input compiled to unmatchable). Then assert what is actually true-and-correct over the current code+corpus, and surface the divergence loudly (console + summary) with the query/paths that prove it. That is not "weakening to pass" — weakening lowers a threshold to hide a real defect; this corrects a stale expectation with evidence. Prefer shape assertions (>0, exec>=skill, ==0) over magic counts so the test survives corpus drift.
