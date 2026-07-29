---
name: foreign-edit-is-a-fact-not-a-bug
description: >-
  Mid-task, a shared file you also edited starts failing to compile with errors naming symbols you never touched.
---
Confirm ownership before reacting: grep the symbol (often it's exported from a sibling and just not imported yet — a half-landed refactor), and re-run your own typecheck filtered to your files. Then leave it alone. "Helpfully" adding the missing import races their next write and can silently revert their design. Verify your slice by other means — your own modules' tests, a leaf-module compile — and state plainly in the summary that the shared file was red on arrival and why. Your green is still provable; their file is not yours to land.
