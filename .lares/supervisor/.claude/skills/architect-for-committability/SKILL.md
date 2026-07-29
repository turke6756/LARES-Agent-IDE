---
name: architect-for-committability
description: >-
  Your WP touches many files, several of which carry other workstreams' uncommitted edits (or are wholly untracked foreign work), and your policy is "commit only what is cleanly yours."
---
Decide file placement BEFORE coding, not at staging time. Run `git status --porcelain` over every planned target first and split the design: put the new capability's logic + its tests in NEW modules and in files that are CLEAN at HEAD (they commit as wholly-yours diffs), and keep edits to entangled/untracked-foreign files down to thin threading (an import, a field, a call) that stays worktree-only and is LISTED in the summary. This turns "almost nothing is committable" into "the substance is committed, the glue is declared" — and the numstat check (small adds, no whole-file churn) becomes your staging proof.
