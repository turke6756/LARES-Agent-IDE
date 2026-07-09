---
name: lares
description: Set up, install, or configure Lares for the user by following the setup wizard. Use whenever the user says "set up lares", "install lares", "configure lares", "get lares running", or asks you to install/configure this project from a fresh clone. Walks through Node/npm version checks, npm install, optional integrations/MCP servers, non-secret settings, secrets in a separate terminal, build, launch, and a health check.
---

# Set up Lares

Lares is an alpha desktop app that runs from source. Your job is to get it
installed, configured, built, launched, and verified — following the wizard in
[`guides/setup.md`](guides/setup.md) step by step.

## Rules

- **Never capture secrets in this session.** Lares needs no secrets to run. If any
  optional integration needs one, direct the user to set it in a **separate
  terminal** or in their own editor — do not read it, echo it, or write it here.
- **Do not write into the user's `.claude/`.** Editing files under `.claude/` can
  trigger an interactive permission dialog. The setup wizard writes only project
  files (e.g. `.env`) — never the user's `.claude/` settings.
- **Stop and ask on any hard failure.** If a native-module build fails or a
  prerequisite is missing, surface the exact error and the fix rather than pushing
  past it.

## What to do

Open [`guides/setup.md`](guides/setup.md) and follow it in order. Report progress
at each stage, and finish with the health check so the user knows Lares actually
launches.
