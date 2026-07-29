---
name: run-sibling-suite-not-just-named
description: >-
  Your task names a few specific test files, and your change (or the prior worker's) adds something to a shared surface — a new control in the same pane, a new global, a new event subscription.
---
After the named suites pass, run the whole sibling directory too — not just the listed files. A pre-existing test that scans broadly (a pane-wide role="radio" / querySelectorAll, a global spy, a shared store) can silently break when a new element lands next to it. The faithful fix is usually to SCOPE the old test (query within the labelled subtree) rather than loosen the new code. The narrow run looks green and hides the regression.
