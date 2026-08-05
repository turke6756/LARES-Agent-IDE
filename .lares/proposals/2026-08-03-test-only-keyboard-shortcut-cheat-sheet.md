---
artifact_id: prop_e3a91c4f
title: "TEST-ONLY: keyboard shortcut cheat-sheet overlay"
author_role: supervisor
authored_at: 2026-08-03T00:00:00Z
---

# TEST-ONLY: add a keyboard shortcut cheat-sheet overlay to the dashboard

> **This is a throwaway proposal created by the planning-surface Wave-1 fresh-agent
> test script (`supporting/2026-08-03-planning-surface-fresh-agent-test-script.md`).
> It is not a real feature request. Safe to delete after inspection.**

## Idea

Add a keyboard shortcut cheat-sheet overlay to the dashboard: pressing `?` (or a
help-menu entry) opens a dismissable overlay listing the app's keyboard shortcuts,
grouped by surface (global, terminal, browser, plans). The overlay is read-only
and closes on `Esc` or click-away.

## Motivation

Shortcuts exist but are undiscoverable; a standard cheat-sheet overlay is the
lowest-friction discoverability fix.

## Sketch

- A static shortcut registry in the renderer.
- An overlay component toggled by `?` when no input is focused.
- No main-process changes.

<!--PLAN-INTENT
{ "intent_id": "int_7b2f9c1a", "part": "shortcut-registry-inventory",
  "kind": "research",
  "targets": [ { "provider": "anthropic", "model": "claude-fable-5" } ],
  "reason": "inventory existing keyboard shortcuts across dashboard surfaces before designing the overlay registry" }
-->

## Hardening scope
- **Verdict (dated):** 2026-08-03 — one part needs hardening: the shortcut-registry
  inventory (online/repo research to enumerate existing shortcuts per surface).
  The overlay component itself is trivial and needs no deliberation.
- **Second opinion:** none consulted (throwaway test proposal per the Wave-1
  fresh-agent test script; second opinion deliberately skipped)
- **Marked intents:** int_7b2f9c1a — research pass to inventory existing
  keyboard shortcuts across dashboard surfaces.
