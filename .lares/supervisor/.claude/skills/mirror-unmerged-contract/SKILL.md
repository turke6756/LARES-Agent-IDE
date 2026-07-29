---
name: mirror-unmerged-contract
description: >-
  You must call names (API methods, payload fields) that a parallel worker owns in files you're forbidden to touch, and those names don't exist yet at your build time.
---
Don't block or hand-wave. Mirror the contract in a file you own and reach it through a null-tolerant accessor that structurally probes the runtime surface (cast via unknown), returning null until the other side merges — the caller renders an inert/degraded control instead of crashing. Read absent payload fields through a tolerant cast ((x as { f?: T }).f ?? default) so the same source compiles both before and after the field lands. Your build stays green regardless of merge order and wires up automatically once the counterpart merges. State in the handoff whether you compiled against the real counterpart or the mirror.
