# File Activity Tracker — Architectural Tour

How a worker's disk write becomes a `Files touched:` line in the supervisor's `[DASHBOARD EVENT]`.

## Flow

- **PTY-scrape origin (Claude only).** `AgentSupervisor.setupFileTracker` (`src/main/supervisor/index.ts:986`) constructs one `FileActivityTracker` per agent and bails out for non-claude providers — their structured JSONL goes through `ContextStatsMonitor` instead. There is no fs-watcher and no IPC from the worker; the supervisor inspects what Claude Code prints to its TUI.
- **Runner feeds raw frames.** The runner's `'data'` handler pipes every PTY chunk into `tracker.processData(data)` (`src/main/supervisor/index.ts:1113` for Windows, `:1453` for WSL). `processData` strips ANSI/OSC escapes, line-buffers partials, and regex-matches each completed line against `Read(...)`, `Edit(...)`, `Write(...)`, and bullet-prefixed plain-text variants (`file-activity-tracker.ts:17-27`).
- **Path resolution + plausibility gate.** `resolvePath` (`file-activity-tracker.ts:66`) expands `~`/`~\`, leaves absolute paths alone, joins relatives against the agent cwd, and special-cases WSL (`/`-prefix join). `isPlausibleFileActivityPath` (`file-activity-tracker.ts:109`) rejects Claude status summaries like "3 files, listed 1 directory" — the path must look path-shaped (sep, abs, or `name.ext`).
- **Persistence + dedup.** Each surviving hit lands via `addFileActivity` (`src/main/database.ts:496`), which skips inserts of the same `(agent, path, operation)` triple inside a 5-second window and otherwise writes a row to `file_activities` keyed on `agent_id`. The tracker emits `'activity'`; the supervisor re-emits as `'fileActivity'` (`index.ts:993`).
- **Event-bridge pre-fetch.** When an agent enters a terminal status (`idle | done | crashed`), the bridge calls `fetchFileActivities(agentId)` (`event-bridge.ts:121-123, 466`), which delegates to `getFileActivities` (`database.ts:518`, ordered `timestamp DESC`) and caps at `FILE_ACTIVITY_FETCH_CAP = 20` (`event-bridge.ts:77`). Failures swallow to `undefined` so the section is simply omitted.
- **Payload rendering.** `buildEventPayload` (`event-payload-builder.ts:175`) appends the result via `formatFilesTouched` (`:101`) under `outputBlock`, truncated to 10 entries with `> path (operation)` lines plus `> … (N more)` overflow.

## Key types and contracts

- **`FileActivityTracker`** (`file-activity-tracker.ts:11`) — owns per-agent line-buffering + regex parsing. Keyed by `agentId`, also stores `workingDirectory` for relative-path resolution. Pure side-effect: writes a DB row and emits one `'activity'`.
- **`addFileActivity` / `getFileActivities`** (`database.ts:496, 518`) — the only persistent store. 5-second dedup window is the sole "recency" filter; rows live until `deleteAgent` (`:531`) clears them.
- **`SupervisorEvent.filesTouched`** (`event-payload-builder.ts:42`) — `Array<{filePath, operation}>` carried from bridge to formatter. Absent → no section.
- **`EventBridgeDeps.getFileActivities`** (`event-bridge.ts:60`) — DI seam over the DB call; integration tests inject a Map (`event-bridge.integration.test.ts:163`).
- **`setupFileTracker` provider gate** (`index.ts:986-996`) — contract that non-claude providers never get a PTY scraper.

## Suspicions

- **"Recency" is unbounded.** The tracker only dedups inside 5s, but `getFileActivities` returns every row ever inserted for an agent (newest-first). After a long-running agent, the bridge's 20-row cap + payload's 10-line slice will only ever show the most recent activity — but the DB grows without bound until `deleteAgent`. No prune.
- **Read/Write operations are conflated by Claude's regex map.** `Edit(...)` → `'write'`, `Write(...)` → `'create'` (`file-activity-tracker.ts:20-21`). A supervisor reading `(write)` cannot distinguish an in-place edit from a freshly created file without inspecting disk.
- **Tracker fires on every PTY frame.** Same path written and edited repeatedly inside the 5s window will be silently dropped from the event log — supervisor will see "1 file touched" even if 50 writes occurred.
- No TODO/FIXME markers in either file.

## Notes for the supervisor

- A `Files touched:` block only appears when the agent enters `idle | done | crashed` — busy/running events never carry one, even mid-turn.
- The list is **cumulative for the agent's lifetime**, not per-turn. A `(write)` entry may be from 30 turns ago. Don't infer "the agent just wrote this" from presence alone — cross-check the assistant message or timestamps via `read_agent_files_touched`.
- Non-claude workers (codex, etc.) will never produce this section at all — the tracker is skipped for them. Absence is not evidence of a read-only turn.

Wrote tour to C:\Users\turke\Projects\AgentDashboard\.dashboard\supervisor\claude-test-file-activity-tour.md.
