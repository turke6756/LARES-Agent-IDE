---
name: background-run-notification-is-truth
description: >-
  You backgrounded a long command whose output runs through a pipe (… | tail -N), the interim output file is empty, and a process listing doesn't find it, so you conclude it died.
---
Don't relaunch. A pipe like tail buffers everything until exit (empty file = still running, not dead), and a Windows CommandLine -match process check can miss the real child (wrapper shells, different image name). The harness sends a completion notification for every tracked background task — absence of that notification means IT IS STILL RUNNING. If you must re-run, TaskStop the original first; otherwise you pay for two suites and risk interleaved writes. Avoid the trap at launch: redirect to a file (> log 2>&1) instead of piping through tail, so interim reads show real progress.
