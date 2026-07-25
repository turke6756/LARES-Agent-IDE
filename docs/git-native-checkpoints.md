# Git-native checkpoints: where they live, and how not to leak them

Lares captures per-turn recovery **checkpoints** as ordinary git objects in your
repository, pinned by refs under a private namespace. This keeps recovery local,
fast, and free of a second datastore — but because the data lives in your repo's
object database, a few git operations *can* copy it somewhere you did not intend.
This page documents exactly which operations leak the refs, which do **not**, and
the one-command op that clears them first.

> TL;DR — a normal `git push` does **not** push checkpoint refs. Mirroring
> (`clone --mirror` / `push --mirror`) and wildcard refspecs over `refs/*` or
> `refs/lares/*` **do**. Run the repo-wide purge **before** you mirror or rewrite
> history.

## Where checkpoints are stored

Every checkpoint is a real commit object referenced from a Lares-private ref. There
are two namespaces, each keyed by an **encoded** workspace id:

```
refs/lares/checkpoints/<enc(workspaceId)>/<enc(agentId)>/<enc(turnId)>/{before,after}
refs/lares/recovery/<enc(workspaceId)>/<enc(operationId)>/pre
```

- These refs live **only** in your local repository. Lares never creates a remote,
  never pushes, and never runs `git gc` aggressively on your behalf.
- The commit trees they point at contain **workspace file bytes** (the before/after
  snapshots that make restore possible). Treat them as sensitive: anything that
  copies the refs copies those bytes.
- Because they sit under `refs/lares/*` (not `refs/heads/*` or `refs/tags/*`), they
  are invisible to `git branch`, `git tag`, and `git log` — but **not** to
  everything (see below).

## What leaks the refs, and what does not

| Operation | Copies `refs/lares/*`? | Notes |
|---|---|---|
| `git push` (default) | **No** | Pushes only the refs matched by your configured refspec — normally `refs/heads/*`. Checkpoint refs are never matched by the default. |
| `git push --all` | **No** | `--all` means **all branches** (`refs/heads/*`) — *not* all refs. It does **not** push `refs/lares/*`. |
| `git push --tags` | **No** | Tags only (`refs/tags/*`). |
| `git push --mirror` | **YES** | Mirror pushes **every** ref verbatim, including `refs/lares/*`. |
| `git clone --mirror` | **YES** | A mirror clone copies every ref; the checkpoint refs (and their objects) come along. |
| `git push <remote> 'refs/*:refs/*'` | **YES** | Any explicit/wildcard refspec that covers `refs/*` or `refs/lares/*` pushes the checkpoint refs. |
| `git fetch <remote> 'refs/*:refs/*'` | **YES** (into a peer) | The mirror-shaped fetch pulls them into another repo. |
| `git filter-repo` / `git filter-branch` | see below | May **mangle or orphan** `refs/lares/*` rather than leak them — but you should purge first regardless. |

The rule of thumb: **default pushes stay branch-scoped; mirroring and `refs/*`
wildcards are repo-verbatim.** If you have configured a custom push refspec (for
example in `remote.<name>.push` or `push.default`), check whether it covers
`refs/*` or `refs/lares/*` — if it does, your pushes carry checkpoints.

### GUI clients may render the refs

Graphical git clients (GitKraken, Fork, Sourcetree, the built-in views in some
IDEs) enumerate **all** refs, so they may display `refs/lares/*` in a refs/tags
tree or a "remote/other refs" pane even though the CLI hides them from
`git branch`. This is cosmetic locally, but it means the refs (and their commit
messages/trees) are visible to anyone looking at your repo through such a tool.

## History rewriting: purge **before** you rewrite or mirror

`git filter-repo` and `git filter-branch` rewrite objects across the ref graph.
Against `refs/lares/*` the result is unpredictable — the tools may rewrite the
checkpoint commits into your new history, orphan them, or leave dangling refs that
point at pre-rewrite objects. None of those outcomes is what you want.

**Always run the repo-wide purge first**, then rewrite or mirror on a clean ref
set:

1. Purge every `refs/lares/*` ref in the repo (the one-command op below).
2. *Then* run `git filter-repo` / `git filter-branch`, or take your mirror clone /
   mirror push.

Because the purge only deletes **refs** (not objects), the now-unreferenced
checkpoint objects are cleaned up by normal git maintenance / `git gc` at git's own
discretion — which is exactly what a subsequent `filter-repo` or a fresh mirror
clone will do anyway.

## The two clearing operations

Lares does **not** auto-edit your push refspec and does **not** silently strip refs
before a push — that would be surprising and could mask a real leak. Instead it
gives you two explicit, human-driven ops.

### 1. Prune my workspace's checkpoints (default, scoped)

`prune_checkpoints` (supervisor MCP tool) and the equivalent human action delete
**both encoded namespaces for your workspace only**:

```
refs/lares/checkpoints/<enc(workspaceId)>/*
refs/lares/recovery/<enc(workspaceId)>/*
```

in one atomic `git update-ref --stdin` batch, and report the deleted-ref count. It
is workspace-scoped to your capability: it can never touch another workspace's refs
in a shared repo, and it never touches your branches or tags. Objects are left for
normal git maintenance — no forced prune, no `gc`.

This is the everyday "I'm done, clear my recovery history" op. Note that pruning
makes those turns **unrecoverable** — diff / restore / revert stop working for the
deleted turns.

### 2. Repo-wide purge before mirroring / history-rewriting (human-only)

When you are about to `clone --mirror`, `push --mirror`, or `filter-repo`, a
single-workspace prune is not enough: a shared repository may hold checkpoint refs
for **several** workspaces, and mirroring copies all of them. The repo-wide purge
clears **every** `refs/lares/*` ref in the repository.

Because that is destructive across workspace boundaries, it is a **distinct,
human-only, explicitly-confirmed** action — it is deliberately **not** available as
an agent MCP tool or an HTTP capability route, and there is **no unscoped `--all`**
on the agent surface that could silently delete another workspace's recovery refs.
Before it acts, it **enumerates and names every affected workspace** (including any
whose id is no longer a live workspace) and the total ref count, so you can see the
full blast radius and confirm before anything is deleted.

As with the scoped prune, only refs are deleted; the unreferenced objects are left
to normal git maintenance.

## FAQ

**Does a normal `git push` leak my checkpoints?** No. The default refspec is
branch-scoped. Only mirroring or a `refs/*`-covering refspec does.

**Is `git push --all` dangerous?** No — `--all` is *all branches*, not *all refs*.
It does not push `refs/lares/*`.

**I already mirrored — now what?** The refs (and their objects) are on the remote.
Purge locally, then re-mirror to a fresh remote, or remove the refs on the remote
(`git push <remote> --delete <ref>` per ref, or re-create the remote from a
purged mirror). Rotate anything sensitive that the snapshots may have captured.

**Will pruning break an in-progress restore?** Pruning deletes the refs a restore
would read. Do it when you no longer need those turns recoverable.
