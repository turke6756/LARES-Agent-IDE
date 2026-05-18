# MCP Context / Outputs Tools — Investigation

**Status:** investigation only, no code changes. Decision document for the supervisor.
**Date:** 2026-05-17

## TL;DR

- The **Context** and **Outputs** tabs are derived views of the same `file_activities` SQLite table. Context = `operation='read'`, Outputs = `operation IN ('write','create')`. **Neither tab shows tool output content** — only the *paths the agent touched*, with a timestamp and operation badge.
- The data is **not** currently behind any HTTP endpoint. The renderer talks directly to the main process over IPC (`agent:get-file-activities`), which calls `getFileActivities()` in `database.ts`. The MCP supervisor script has no way to reach this.
- The user-stated use case ("has this agent already read the file I'm about to ask the next worker to read?") maps cleanly to `file_activities` filtered to `read`. That is a 1:1 fit with the Context tab. Payload is cheap (~200 bytes per row; ~8K tokens for the heaviest agent we've seen, far less after de-duping by path).
- The user's secondary assumption — that the Outputs tab shows tool output / artifacts — is wrong. It's a list of files the agent wrote or created, same schema as Context. If the supervisor actually wants tool-result payloads (the *content* a `Read` returned, the stdout of a shell), that's a different source entirely: the SessionLogReader's cached `ToolUseEvent` / `ToolResultEvent` ring. That data exists today; `AgentChatService.getMessages()` deliberately filters it out.
- **Recommendation: Option C (hybrid).** Add one new MCP tool that exposes `file_activities` (the cheap, structured "files touched" view that powers both tabs). Extend `read_agent_chat` separately *if and when* the supervisor decides it also wants the larger tool-use/tool-result event stream — that's a heavier surface and a different conversation.

---

## 1. What the Context tab actually shows

**Component:** `src/renderer/components/detail/DetailPaneContext.tsx:10-35`

```tsx
const data = await window.api.agents.getFileActivities(agentId, 'read');
setActivities(data);
// ...
return <FileActivityList activities={activities} ... />;
```

It fetches all `FileActivity` rows for the agent where `operation = 'read'`, polls every 5 s, and listens for `onFileActivity` IPC pushes. The list is rendered by `FileActivityList` (`src/renderer/components/detail/FileActivityList.tsx`), which **groups by `(filePath, operation)`** and shows the most-recent timestamp + a duplicate count badge (e.g. `×3`).

### Row schema (`src/shared/types.ts:71-77`)

```ts
export type FileOperation = 'read' | 'write' | 'create';

export interface FileActivity {
  id: number;          // SQLite rowid
  agentId: string;
  filePath: string;    // absolute or workspace-relative, as observed
  operation: FileOperation;
  timestamp: string;   // SQLite datetime('now'), UTC, no Z suffix
}
```

### Example payload (5 rows pulled from live DB, agent `be04c8ed…`)

```json
[
  {"id":1507,"agentId":"be04c8ed-721a-43db-90e2-d64f792dc125",
   "filePath":"C:\\Users\\turke\\Projects\\AgentDashboard\\plans\\agent-lifecycle-hardening-plan.md",
   "operation":"write","timestamp":"2026-05-17 22:41:25"},
  {"id":1506,"agentId":"be04c8ed-721a-43db-90e2-d64f792dc125",
   "filePath":"C:\\Users\\turke\\Projects\\AgentDashboard\\plans\\agent-lifecycle-hardening-plan.md",
   "operation":"read","timestamp":"2026-05-17 22:41:25"},
  {"id":1505,"agentId":"be04c8ed-721a-43db-90e2-d64f792dc125",
   "filePath":"C:\\Users\\turke\\Projects\\AgentDashboard\\CLAUDE.md",
   "operation":"write","timestamp":"2026-05-17 22:41:25"},
  {"id":1504,"agentId":"be04c8ed-721a-43db-90e2-d64f792dc125",
   "filePath":"C:\\Users\\turke\\Projects\\AgentDashboard\\package.json",
   "operation":"write","timestamp":"2026-05-17 22:41:25"},
  {"id":1503,"agentId":"be04c8ed-721a-43db-90e2-d64f792dc125",
   "filePath":"C:\\Users\\turke\\Projects\\AgentDashboard\\package.json",
   "operation":"read","timestamp":"2026-05-17 22:41:25"}
]
```

### Important: paths are not normalized

The same logical file can appear twice with different `filePath` strings:

```
src/main                                                            → read
src/renderer/components/layout/DetailPanel.tsx                      → read
C:\Users\turke\Projects\AgentDashboard\src\renderer\...\DetailPanel.tsx → read
```

This happens because the activity emitter writes whatever string the tool's `input.file_path` contained — relative for some Read calls, absolute for others, and PTY-parsed for legacy Codex shell commands. The renderer's `groupByFile()` keys on `(filePath, operation)` literally, so the UI shows three rows; an MCP consumer that wants "unique files read" needs to do its own normalization.

## 2. What the Outputs tab actually shows

**Component:** `src/renderer/components/detail/DetailPaneProducts.tsx:10-71`

Same data source, different filter — `operation IN ('write', 'create')`. Split into two visual sections by the renderer: "Created" (operation=create) and "Modified" (operation=write). No tool output content. No artifact content. **Just paths the agent wrote or created**, identical shape to the Context tab.

The tab is labeled **"Outputs"** in `DetailPanel.tsx:13-17`, which is what likely led to the supervisor's mental model that it contains tool output. It does not.

If the supervisor genuinely wants tool output (the bytes a `Read` returned, the stdout of a `Bash`, the `tool_result` JSON), that is *not what either tab exposes today*. The closest available source is the SessionLogReader's in-memory event ring — see §4.

## 3. Current data path (end-to-end)

| Layer | File:line | Notes |
|---|---|---|
| UI tab | `src/renderer/components/layout/DetailPanel.tsx:318-319` | Mounts `DetailPaneContext` and `DetailPaneProducts` based on `detailPane` state. |
| Tab labels | `src/renderer/components/layout/DetailPanel.tsx:13-17` | `TABS = [{label:'Context'}, {label:'Outputs'}, {label:'Chat'}]`. |
| Tab-count badges | `src/renderer/components/layout/DetailPanel.tsx:73-95` | Polls `getFileActivities` every 5 s, dedups by `filePath` for the badge number. |
| React fetch | `DetailPaneContext.tsx:13-32`, `DetailPaneProducts.tsx:13-33` | `window.api.agents.getFileActivities(agentId, operation?)` + `onFileActivity` push. |
| Preload bridge | `src/preload/index.ts:20` | `ipcRenderer.invoke('agent:get-file-activities', agentId, operation)`. |
| IPC handler | `src/main/ipc-handlers.ts:48` | `ipcMain.handle('agent:get-file-activities', (_e, agentId, operation) => getFileActivities(agentId, operation))`. |
| DB query | `src/main/database.ts:518-529` | `SELECT * FROM file_activities WHERE agent_id=? [AND operation=?] ORDER BY timestamp DESC`. |
| DB schema | `src/main/database.ts:64-72` | `(id, agent_id, file_path, operation, timestamp)`. |
| Writer (dedup) | `src/main/database.ts:496-516` | Skips inserts when `(agent, path, op)` already wrote in the last 5 s. |

### Where activities come from

Two producers feed `addFileActivity` today:

1. **JSONL-parsed (primary, reliable).** `ContextStatsMonitor` listens to `SessionLogReader` `tool-use` events and emits `fileActivity`. The supervisor's main loop catches that and calls `addFileActivity` (`src/main/supervisor/index.ts:332-338`). The reader covers Claude (Read/Edit/Write/Glob/Grep), Gemini (read_file/write_file/replace), and Codex (shell_command + apply_patch parsed via `codex-shell-parser`).
2. **PTY-parsed (legacy).** `FileActivityTracker` (`src/main/supervisor/file-activity-tracker.ts`) regex-matches tool-call headers in PTY output. Largely superseded by (1); the DB has Phase-4a purge code for legacy PTY-tracker rows (`database.ts:203-227`).

The supervisor's tab uses *whatever made it into the table*. There is no separate Claude-only or Codex-only path on the read side.

## 4. Reachability from MCP

**The data is not currently behind any HTTP endpoint.** I grep'd `src/main/api-server.ts` for `file_activit|fileActivit|FileActivit` — no matches.

The HTTP API surface (rooted at `http://localhost:24678`, routes inventoried in `src/main/api-server.ts`) exposes today:
- `GET  /api/agents` — list
- `GET  /api/agents/:id` — single
- `GET  /api/agents/:id/log` — raw PTY log
- `GET  /api/agents/:id/context-stats` — token usage
- `GET  /api/agents/:id/messages` — structured chat from `AgentChatService` (assistant + user text only — tool-use/tool-result events are filtered out at `agent-chat-service.ts:55-87`)
- `POST /api/agents/:id/input`, `POST /api/agents/:id/keys`, `POST /api/agents/:id`, `DELETE /api/agents/:id`, `POST /api/agents/:id/fork`
- Team routes, notebook routes, persona/template routes

The MCP supervisor script (`scripts/mcp-supervisor.js`) is a thin shim over those routes. `read_agent_chat` (line 630-638) just `GET`s `/api/agents/:id/messages` and serializes the result.

To wire Context/Outputs through MCP we have two viable wiring paths:

| Path | What to add | Effort |
|---|---|---|
| **A.** Reuse `file_activities` table | New GET endpoint in `api-server.ts` that wraps `getFileActivities(agentId, operation?)`. New MCP tool in `mcp-supervisor.js`. | ~30 LOC. |
| **B.** Reuse cached SessionEvent ring | New endpoint that pulls `tool-use` + `tool-result` events from `SessionLogReader.getCachedEvents(agentId)`. New MCP tool, possibly added as a `view` mode on `read_agent_chat`. | ~60-80 LOC + a small addition to `AgentChatService` to expose tool events. |

Path A serves the UI's exact view at low cost. Path B is heavier but gives the supervisor full tool args + results (with the existing ~20KB-per-result truncation already enforced by the reader, per `session-events.ts:74`).

## 5. Comparison to `read_agent_chat`'s data path

| | `read_agent_chat` | Proposed `read_agent_files_touched` (Path A) |
|---|---|---|
| Data source | `SessionLogReader` ring buffer → `AgentChatService.getMessages()` | `file_activities` SQLite table |
| Filter | Excludes tool-use, tool-result, thinking, usage | None / by operation |
| Payload per item | Full assistant-text content (can be multiple KB) | ~150-250 bytes (path + op + timestamp) |
| Typical token cost @ 50 items | 2,000-15,000 tokens | <500 tokens after dedup |
| Liveness | Force-polls before answer | Indexed query; 5-s dedup window on the writer |
| Cross-provider | Works for Claude/Codex/Gemini via per-provider readers | Already provider-agnostic — Codex/Gemini activities land in the same table |

The chat tool and the proposed tool are *not* substitutes — they answer different questions. The chat tool can't be filtered into "files this agent has read" because that information was stripped before the rows ever reach it.

## 6. Token cost estimate

Pulled from the live DB on this machine:

- Top-5 heaviest agents by row count: 165, 112, 90, 83, 60.
- The 165-row agent serialized as un-grouped JSON: **34,359 bytes (~8.5K tokens)**.
- After de-duping by `(filePath, operation)` (what the UI does in `FileActivityList.groupByFile`): typically 30-60% of the rows for an active agent, so **roughly 3-5K tokens** for the heaviest agent and **<1K tokens** for a typical worker.
- The same agent's `read_agent_chat?limit=50` payload is much larger — assistant turns include full text and can run 2-15K tokens *per turn*.

For a supervisor that wants to call this often (per-launch staging, "has agent X read Y?", etc.), Path A is roughly **10-30× cheaper** than `read_agent_chat`.

## 7. Recommended design

**Option C (hybrid), but only the first half right now.** Add one new MCP tool backed by `file_activities`. Defer extending `read_agent_chat` until the supervisor demonstrates it needs the heavier event stream.

Specifically:

1. **Now:** `read_agent_files_touched` (one tool, `operation` filter optional). Wraps `getFileActivities` 1:1. Matches the Context tab when `operation='read'`, matches the Outputs tab when `operation IN ('write','create')`. Cheap.
2. **Maybe later:** a `view='tool_events'` mode on `read_agent_chat` (or a new `read_agent_tool_events`) that surfaces `ToolUseEvent` + `ToolResultEvent` from the SessionLogReader cache. Defer until there's a concrete use case beyond "supervisor wants to know what files the agent touched" — which (1) already covers.

### Why not Option A (extend `read_agent_chat`)?

The data source is different — `file_activities` is a SQL table, not a `SessionEvent` cache — so any `view` parameter would need to internally branch to a different code path anyway. The "extension" would be cosmetic. A separate tool is also more discoverable in MCP's `tools/list`.

### Why not Option B with two tools (`read_agent_context` + `read_agent_output`)?

The two tabs share a schema and only differ by operation filter. Two tools is duplication. One tool with an `operation` parameter is the cleaner shape and matches the underlying `getFileActivities(agentId, operation?)` signature.

## 8. Implementation sketch (for the recommended option)

Three files to change. Estimated total: **~40 LOC, <1 hour** including a smoke test against a live agent.

### `src/main/api-server.ts` — new GET route

Add after the `messages` route (~line 158):

```ts
// GET /api/agents/:id/file-activities — recent file reads/writes/creates
const filesMatch = path.match(/^\/api\/agents\/([^/]+)\/file-activities$/);
if (method === 'GET' && filesMatch) {
  const agentId = filesMatch[1];
  const op = url.searchParams.get('operation');
  const operation = (op === 'read' || op === 'write' || op === 'create') ? op : undefined;
  const limit = parseInt(url.searchParams.get('limit') || '200', 10);
  const activities = getFileActivities(agentId, operation).slice(0, limit);
  return { agentId, operation: operation || null, activities };
}
```

Add `getFileActivities` to the import block at the top.

### `scripts/mcp-supervisor.js` — new tool

In the `tools` array (after `read_agent_chat` at ~line 298):

```js
{
  name: 'read_agent_files_touched',
  description:
    'List files an agent has read, written, or created (paths only — the same data that powers the Context and Outputs tabs in the dashboard). ' +
    'Use this before launching a follow-up worker to check whether the previous agent has already touched a file you were about to ask the new agent to read. ' +
    'Far cheaper than read_agent_chat for this question.',
  inputSchema: {
    type: 'object',
    properties: {
      agent_id: { type: 'string' },
      operation: { type: 'string', enum: ['read', 'write', 'create'],
                   description: 'Filter to one operation. Omit to get all three.' },
      limit:     { type: 'number', description: 'Max rows, newest first (default 200).' },
      unique:    { type: 'boolean',
                   description: 'When true, dedup by (filePath, operation) and return one row per pair with a count. Matches the dashboard tab view. Default false.' },
    },
    required: ['agent_id'],
  },
},
```

Plus a handler in the `switch` (~line 638):

```js
case 'read_agent_files_touched': {
  let p = `/api/agents/${args.agent_id}/file-activities`;
  const q = [];
  if (args.operation) q.push(`operation=${args.operation}`);
  if (args.limit)     q.push(`limit=${args.limit}`);
  if (q.length) p += '?' + q.join('&');
  const result = await apiRequest('GET', p);
  let rows = result.activities;
  if (args.unique) {
    const seen = new Map();
    for (const r of rows) {
      const key = `${r.filePath}|${r.operation}`;
      const prev = seen.get(key);
      if (prev) prev.count++;
      else seen.set(key, { ...r, count: 1 });
    }
    rows = Array.from(seen.values());
  }
  return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
}
```

### `.dashboard/supervisor/CLAUDE.md` (optional, doc-only)

Add a line under the tools list pointing supervisors at the new tool for "has agent X already read file Y?" questions. **Do not edit during the patch session** — see §9.

## 9. Risks / open questions

1. **`.claude/` permission hang.** Anything in `.dashboard/supervisor/` is generated from `src/shared/constants.ts` (`SUPERVISOR_AGENT_MD`) on first scaffold. If we want the new tool documented in supervisors going forward, the *constant* needs to be edited and the rebuild + remove-folder dance from CLAUDE.md needs to run. The supervisor should decide whether to update the doc in the same PR or punt to a follow-up.

2. **Path normalization.** The same logical file appears under multiple `filePath` strings (relative + absolute, forward-slash + backslash). A supervisor asking "did agent X read `src/main/database.ts`?" against a row stored as `C:\Users\turke\Projects\AgentDashboard\src\main\database.ts` will miss it on a literal compare. Options: (a) do nothing, document the caveat, push normalization to the caller; (b) normalize at insert time (riskier — touches the hot path and the dedup window); (c) add a `normalized_path` column. Recommendation: (a) for now, add a note to the tool description. The supervisor can do `String.includes(path)` matching against the JSON payload.

3. **Outputs tab semantics drift.** The tab is named "Outputs" and the user/supervisor reasonably assumed it shows artifact *content*. If we ship a tool named `read_agent_files_touched` we should also state clearly in its description that it does not return file *contents*. If the supervisor wants contents, they can `Read` the path themselves (it's a normal filesystem path).

4. **Codex `shell_command` coverage.** Activities from Codex are parsed at tool-use time by `parseShellCommand` / `parseApplyPatch` and only emitted on a successful `tool-result`. Coverage of shell idioms (`cat`, `>`, `sed -i`, `cp`, etc.) depends on what `codex-shell-parser.ts` recognizes. The supervisor should treat the tool's output as "best-effort observed activity" rather than ground truth — agents can touch files via shell calls that the parser doesn't recognize.

5. **5-second insert dedup.** `addFileActivity` (`database.ts:496-509`) silently drops inserts when `(agent, path, op)` repeated within the last 5 s. If an agent reads the same file rapidly in a tight loop, the activity tab will only show one entry. This is rarely a problem in practice but worth documenting if the supervisor uses the count for diagnostic purposes.

6. **Cross-workspace agent IDs.** `agent_id` is a UUID — the supervisor must supply it. The tool can't be called like "files for the worker in workspace X" without first calling `list_agents` to resolve the ID. Existing pattern; not a regression.

7. **No "before time T" filter.** The query is `ORDER BY timestamp DESC LIMIT N`. If the supervisor wants "files the agent touched *before* it received my last instruction", they have to slice on timestamp client-side. Could add a `since` parameter later if it matters.

8. **No "tool output content" path.** If the supervisor *does* want what a tool returned (e.g., "what did `Bash` print?"), this tool doesn't help. That's the deferred half of Option C — extending `read_agent_chat` (or a new `read_agent_tool_events` tool) with the SessionLogReader's `tool-use` / `tool-result` events. Roughly: ~50 LOC change to `AgentChatService` to expose a `getToolEvents(agentId)` method, ~20 LOC route, ~30 LOC MCP tool. Defer until needed.
