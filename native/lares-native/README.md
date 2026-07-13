# lares-native

Native N-API foundation for the memory-exhaustion remediation (incident
`2026-07-11`, plan §5 step 0). Windows-only; on other platforms it loads as a
graceful no-op (`supported: false`, every op throws a catchable error).

Built in-family with the repo's other native modules (`better-sqlite3`,
`node-pty`): `node-gyp` against the **Electron** headers, Spectre mitigation
disabled in the generated vcxproj. Build with:

```
node native/lares-native/build.js          # Electron ABI (default, the real target)
LARES_NATIVE_TARGET=node node native/lares-native/build.js   # Node ABI (experiments only)
```

Run anything that loads it under the Electron ABI, e.g.
`ELECTRON_RUN_AS_NODE=1 electron <script>`.

**ABI portability:** this is a pure **Node-API** module (`NAPI_VERSION=8`), so a
single compiled binary loads unchanged under both Node (ABI 137 here) and
Electron (ABI 145) — unlike `better-sqlite3`/`node-pty`, which use V8 internals
and require per-ABI rebuilds. The header it is built against is therefore not
load-critical; `build.js` targets the Electron headers only to stay in-family
with the repo's other native builds. `test/run.js` runs under plain `node` and
transparently relaunches under Electron only if the binary somehow fails to load.

## Surface

| Fn | Purpose |
|---|---|
| `createNamedJob(name)` | Create a named Job Object (no `KILL_ON_JOB_CLOSE`; breakaway denied → descendants stay in the job). Idempotent. |
| `openNamedJob(name)` | Reopen a named job **while a handle to it is open somewhere**; `null` if absent. |
| `assignPid(job, pid)` | Assign a process to the job. |
| `listJobPids(job)` | PIDs currently in the job (incl. descendants). |
| `terminateJob(job)` | Terminate all processes in the job. |
| `pidCreationTime(pid)` | FILETIME (decimal string) for PID-reuse-safe identity; `null` if gone. |
| `getCommitStatus()` | `GlobalMemoryStatusEx`: commit limit / available / charge + physical. |

Naming convention: `Local\Lares.agent.<agentId>.<instanceEpoch>` (see `jobName()`).

## ⚠ Spike finding — named jobs are NOT a durable cross-death handle

The spike gate (plan §5 step 0) surfaced a **load-bearing correctness problem
with the plan's D4 premise**, verified empirically on Windows 11 (build 26200),
Electron 41 / ABI 145:

> A Windows Job Object's name/existence is tied to open **handles**, not to
> member processes. When the last handle closes (e.g. the Electron main process
> is force-killed), the job object is destroyed and its name released **even
> while member processes keep running** — those members simply become job-less.

Measured: with a handle held, `openNamedJob` reopens the job and `listJobPids`
shows the member; after the sole handle-holder is force-killed, the member
survives but `openNamedJob` returns `null`. This **contradicts** the plan's
statement that "a named job remains alive (and reopenable via `OpenJobObject`)
while any member process runs, even after all prior handles close — this is the
durable cross-instance handle."

**Consequence:** named jobs work perfectly as a *live-instance* mechanism
(capture-with-breakaway-denied, `listJobPids`, atomic `terminateJob`) but cannot
by themselves serve as the durable, reopen-after-crash ownership handle D4 needs.
The cross-death durability must come from the DB ownership record
(`rootPid` + `pidCreationTime` + `instanceEpoch`) plus a creation-time-verified
tree walk — i.e. the plan's *fallback* path becomes the *primary* cross-instance
path. Wave 2 (D4) owns that decision; this module's surface is unchanged either
way, but `openNamedJob`'s architectural role is "same-instance reopen," not
"survives a forced main-process death."
