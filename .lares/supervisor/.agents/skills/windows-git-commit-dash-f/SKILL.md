---
name: windows-git-commit-dash-f
description: >-
  You're on Windows reaching for a multi-line `git commit -m` in the Bash tool, tempted to wrap the message in a PowerShell @'...'@ here-string.
---
The Bash tool is Git Bash (POSIX sh), not PowerShell — @'...'@ is not bash syntax. Bash parses -m @'...'@ as @ + a single-quoted string + a trailing @, silently injecting a literal @ as the subject's first char and another at the body's end. Instead write the message to a file and `git commit -F <file>` (or a real bash heredoc). If it already landed, `git commit --amend -F <file>` fixes it cleanly (safe pre-push). Verify the subject with `git log -1 --format=%s` before moving on.
