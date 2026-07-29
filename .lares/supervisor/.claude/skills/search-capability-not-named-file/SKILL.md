---
name: search-capability-not-named-file
description: >-
  A continuation prompt tells you to add missing coverage/behavior and names the file to extend ("the predecessor had not yet written X — extend foo.test").
---
Before writing, search for the CAPABILITY across the tree, not just the named file — the predecessor may have landed it under a sibling/adjacent filename (foo.pdf.test next to foo.test). Run it and read it. Following the instruction literally would duplicate a complete, green trunk and create two divergent suites over one surface. If it already exists, say so and redirect the leg to the coverage that is actually absent. This is the absence-side mirror of building before trusting a breakage claim: the handoff's account of what is missing is as much a hint as its account of what is broken.
