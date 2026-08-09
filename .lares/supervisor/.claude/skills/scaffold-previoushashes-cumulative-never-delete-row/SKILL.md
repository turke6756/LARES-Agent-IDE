---
name: scaffold-previoushashes-cumulative-never-delete-row
description: >-
  When you are editing a `previousHashes` map on an existing versioned scaffold entry, or removing/retiring a scaffold file that already deployed to workspaces (AgentDashboard PROPOSAL_TO_PLAN_TREE / SUPERVISOR_FILES / WORKER_FILES_* in src/main/supervisor/index.ts) — including when you are gating another agent's such change. Complements `scaffold-content-needs-version-bump`, which covers the bump itself; this covers the two ways the bump silently corrupts deployed workspaces.
---
Both failures below are **invisible to every test suite**. They only manifest on a real workspace at restart, so a green run proves nothing about either.

## 1. `previousHashes` is CUMULATIVE — additive only, never replaced

Read "add a `previousHashes` entry for the OLD version" as **ADD, preserving every existing entry, including entry `1`**. Never rebuild the map from a single freshly-derived hash.

Bumping v3→v4 means `{1: V1_HASH, 2: V2_HASH, 3: V3_HASH}` — not `{3: V3_HASH}`.

Why (in `src/main/scaffold-writer.ts`): the update path looks up `previousHashes?.[diskVersion] ?? previousHashes?.[1]`, and the retirement path scans `Object.values(previousHashes)`. Drop older entries and a workspace still sitting on an older version stops matching any known managed body. It is **not** stranded — it is still backed up and upgraded — but every such workspace acquires a spurious `.bak.<ts>`, emits a "differed from known managed content" warning, a genuine user edit becomes indistinguishable from a pristine copy, and `pruneScaffoldBackups` can never reclaim those backups because they no longer match a known shipped body.

Note the map is **per-file**. A "shared version bump" across several files means each file advances its own version and extends its own map — never one global revision number.

## 2. Retire a scaffold file with `removed: true` — NEVER delete its row

To stop shipping a file that already deployed, keep the entry and set:

```ts
{ rel: 'references/activities/capture.md', content: '', removed: true, version: 4,
  previousHashes: { 1: ..._V1_HASH, 2: ..._V2_HASH, 3: ..._V3_HASH } }
```

Bump the version, set `content: ''`, and **extend `previousHashes` with the hash of the last shipped body** so BOTH pristine and hand-edited deployed copies retire cleanly (backed up, then removed).

Delete the row instead and the writer never touches that path again: the deployed file stays on disk in every existing workspace **forever**, orphaned and still openable, while whatever referenced it is gone. `content: ''` **without** `removed: true` is worse — it overwrites the deployed file with an empty one rather than retiring it.

The `ScaffoldFile.removed` doc comment in `scaffold-writer.ts` states this outright. Look for an already-landed retirement in the tree and copy its exact shape.

## When gating someone else's change

Check the map key set per bumped file and confirm entry `1` survived — the diff looking complete is not evidence. If a change claims to use `removed: true`, verify the writer actually branches on that flag rather than assuming the field is honored; an inert flag paired with `content: ''` blanks every deployed copy.
