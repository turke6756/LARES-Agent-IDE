# Backlog sprint: 14 feature/bug items (started 2026-06-03)

## STATUS: ALL 7 PACKAGES COMPLETE (2026-06-03). Builds pass; NOT runtime-verified, NOT committed. Next: `npm run restart`, manual-verify, commit.

### Runtime-verify checklist before committing
- #15 WSL stale listings: `touch` a file in an expanded WSL /mnt dir → should appear in ~2.5s.
- #12 MCP open_file_in_view: call the new tool → tab opens in user's file view.
- #3/#6 drag interactions (agent→chat, tab reorder) — manual.
- Pre-existing TS errors remain in notebook/Sidebar files (Sidebar, CellShell, NotebookView, useYNotebook) — UNRELATED to this sprint; build:renderer still passes.
- Dead code: src/renderer/components/fileviewer/applyFsEvent.ts now unimported (P3) — safe to delete later.
- shared/types.ts edited by P3 (DirectoryEntry mtime/birthtime) then P7 (OpenFileTabRequest/IpcApi) — sequential, no conflict.
- #3 agent-drop uses bracket token `[dashboard agent "Title" #id]` not `@agent:` — user may want to pick a convention.


User delivered ~14 AgentDashboard feature/bug requests (via voice memo relayed by the "minor fixes" worker). Supervisor scoped into 7 packages across 2 waves, partitioned by FILE OWNERSHIP so concurrent workers never edit the same file.

Workspace_id: `029b5cea-9a4a-4161-8e74-0ba8af5f3580`

## Wave 1 — launched, all file-disjoint
- **P1** Supervisor events (1,2) — agent `ae674834`. Files: src/main/supervisor/event-bridge.ts, event-payload-builder.ts, status-monitor.ts, shared/constants.ts + supervisor tests. (#1 identify sending agent in events; #2 drop launching→idle noise.)
- **P2** Agent cards (3,4,5) — agent `641bf97f`. Files: AgentCard.tsx, AgentGrid.tsx, StatusBadge.tsx, ChatInputBar.tsx. State kept LOCAL (not dashboard-store). (#3 drag card→chat identity; #4 unread blue ring until click; #5 shift-select + right-click delete.)
- **P3** Folder pane + fs watcher (14,15) — agent `2f5c1052`. Files: DirectoryTree.tsx, DirectoryTreeNode.tsx, FileContextMenu.tsx, fs-watcher.ts, file-reader.ts, ipc-handlers.ts, types.ts(dir-entry only). (#14 sort by edited/created + timestamps; #15 stale WSL listings.)
- **P4** Tab bar UX (6,7) — agent `87808408`. Files: FileTabBar.tsx, FileViewerPanel.tsx, dashboard-store.ts (tab slice). (#6 drag-reorder tabs; #7 right-click tab color.)
- **P5** CSV viewer (10,11) — agent `bb7deef2`. File: CsvRenderer.tsx ONLY. (#10 row/col highlight; #11 resizable columns.)

## Wave 2 — HOLD until Wave 1 frees shared files
- **P6** Tab content fidelity (8,9) — blocked by P5 (shares CsvRenderer.tsx). Files: useFileContentCache.ts, scrollMemory.ts, FileContentArea.tsx, FileContentRenderer.tsx, CsvRenderer.tsx, MarkdownRenderer.tsx, PlainTextRenderer.tsx, CodeRenderer.tsx, CodeMirrorEditor.tsx. (#8 live-refresh incl CSV — root cause is renderer useMemo stale in CsvRenderer + useFileContentCache; #9 per-tab scroll for all renderers.) Renderer-only; do NOT touch fs-watcher.ts.
- **P7** Open-file integration (12,13) — blocked by P3 (ipc-handlers), P4 (store openTab), P5/P6 (Csv/Markdown renderers). Files: api-server.ts, scripts/mcp-supervisor.js, ipc-handlers.ts (main→renderer signal + listener), MarkdownRenderer.tsx, CsvRenderer.tsx. (#12 MCP tool open file as tab; #13 ctrl+click path in rendered doc opens file. Reuse dashboard-store openTab().)

## Key architecture facts (from Explore pass)
- Open-tabs state + openTab() live in src/renderer/store/dashboard-store.ts (FileTab type there too).
- #8 CSV-no-refresh root cause is RENDERER (CsvRenderer stale useMemo / FileContentRenderer re-render), NOT the main watcher — fs-watcher already emits change events on the parent dir. So #8 is renderer-only.
- #1 agent identity: event-payload-builder.ts already carries agentTitle/agentId in the struct — P1 must verify the rendered human text actually names the sender (and team-message relay path).
- MCP tools registered in scripts/mcp-supervisor.js (stdio proxy → HTTP api-server.ts on :24678). Main→renderer signal pattern: mainWindow.webContents.send(...) in ipc-handlers.ts.

## Task tracker: dashboard tasks #1–#7 map to P1–P7.
## Note: a "minor fixes" worker (d8855227) is also in this workspace; had not touched source as of launch.
