---
name: commit-prepared-index-not-pathspec
description: >-
  You built a partial-stage index (git update-index / hash-object blob) to commit only your hunks of a shared foreign-dirty file, and you are about to run the commit — or your carefully staged blob was mysteriously replaced by the full dirty worktree content in the resulting commit.
---
After constructing a partial index for a foreign-dirty file (windows-partial-staging-blob: hash-object -w your clean version, update-index --cacheinfo), commit the PREPARED INDEX directly: `git commit -m <msg-file>` with NO pathspec for that file.

Never run `git commit -- <path>` (or `git commit --only <path>`) on the partially-staged file — a pathspec-limited commit makes Git refresh that path FROM THE DIRTY WORKTREE, silently replacing your prepared blob with the worktree bytes (yours + everyone's foreign hunks).

Verify afterward, both directions:
- `git rev-parse HEAD:<path>` equals the blob OID you staged, and
- `git hash-object <path>` (worktree) is unchanged from before the commit — foreign hunks survived.

Discovered independently by two Save-card Stage-4 workers (commits a428908, 5205575) on AgentDashboard, Windows; applies to any partial-stage commit on any platform.
