---
name: windows-partial-staging-blob
description: >-
  You must commit only your own change to a shared file that also carries other workstreams' uncommitted hunks, and there is no interactive `git add -p`.
---
Don't stage the whole file and don't try `git apply --cached` with a filtered patch — on a CRLF worktree with autocrlf the patch text is LF and the apply fails "corrupt patch"/"does not apply" for reasons unrelated to your filtering. Instead reconstruct the intended blob in a scratch file: take `git show HEAD:<file>`, replay ONLY your hunks onto it as literal old-to-new string replacements (assert each old block matches exactly once), then `git hash-object -w` it and `git update-index --cacheinfo 100644,<sha>,<path>`. Verify with `git diff --cached -- <file>` before committing. Select hunks by CONTENT (a marker string your change always contains), not by @@ line numbers — offsets shift after every commit and a neighbour's hunk in the same region is easy to swallow. And read git's output as UTF-8 bytes: a naive text-mode read on Windows decodes with the system codepage and mangles every em-dash.
