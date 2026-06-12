# Handoff 2026-06-11 — Embedded browser: WP0 sealed, launch WP1-A ∥ WP1-B next

Torch-pass for the next supervisor continuing the **embedded browser** workstream
(native in-app Chromium pane). Read this top to bottom before launching anything.

## Where the workstream stands

- **Plan docs (all in gitignored `docs/`/`plans/` — on disk, NOT in git):**
  - `docs/EMBEDDED_BROWSER_AND_PLANNING_SURFACE_PLAN.md` — the vision (pane +
    agent CDP tools + MCP-Apps planning surface; Google-OAuth/gws motivating
    workload; Chrome-UA override is load-bearing).
  - `plans/embedded-browser-safety-deepdive.md` — **M1–M16 mitigations. This is
    LAW** (worker convention 7): no implementation choice may weaken one.
  - `plans/embedded-browser-implementation-tasks.md` — **the authoritative work
    breakdown.** WP descriptions, file-ownership, frozen IPC contract,
    [worker]/[human gate] acceptance splits, worker conventions, progress log.
    Launch prompts should QUOTE from it, not paraphrase.
- **WP0 (API hardening) is ✅ SEALED.** Implemented, all tests green, human ran
  G0 post-restart 2026-06-11: unauth `GET /api/agents` → 401 verified live;
  notebooks, supervisor MCP, WSL-side agent tools, media:// all pass.
  Committed in `d3c8596`. Details: `memory/wp0-api-hardening-complete-awaiting-g0.md`.
- **Tree is CLEAN at `a73007d`** (master). The whole backlog was committed
  2026-06-11: `6108604` canvas spike · `ce58f55` reliability fixes · `d3c8596`
  WP0 hardening · `6c705a0` UI/docs batch · `a73007d` memory.
- **The app is RUNNING the post-WP0 build** (restarted 2026-06-11). Every API
  call now needs the bearer token; agents/proxies get it via env injection
  automatically. If an old pre-restart session's tooling 401s, that's why.

## Next action: launch WP1-A ∥ WP1-B (two fresh workers, parallel)

Human has chosen to proceed with the browser pane. Both WPs are specified in
full in `plans/embedded-browser-implementation-tasks.md` §WP1-A / §WP1-B —
build each launch prompt from those sections verbatim, plus the §"Worker
conventions" block (never `.claude/` writes, never `npm run restart`/`start`/
`dev`, no new npm deps, `## Patch summary` final message, security spec is law,
compiled-node tests must not construct Electron objects).

- **WP1-A — pane main-process.** Owns NEW `src/main/browser/`
  (`browser-manager.ts`, `browser-decisions.ts` (pure policy — the test
  surface), `browser-ipc.ts`), NEW `src/main/control-ports.ts`, NEW
  `src/shared/browser.ts`; edits `ws-server.ts` (WS_PORT import swap),
  `index.ts` (UA fallback + manager construction), `preload/index.ts` +
  `shared/types.ts` (browser namespace). **Must not touch `src/renderer/`.**
  Key mechanics: `app.userAgentFallback = buildChromeUA(process.versions.chrome)`
  byte-exact Chrome shape; two partitions `persist:user`/`persist:agent`;
  M2 loopback webRequest filter using the ACTUAL bound API port; M5 deny-all
  permissions; M6 nav scheme gates; M7 downloads denied both partitions
  day-one; M9 debugger only on `persist:agent`; M4 hookup via WP0's
  `setManagedWebContentsCheck` seam (`src/main/security/webcontents-guard.ts`).
- **WP1-B — pane renderer UI.** Owns NEW `src/renderer/components/browser/`
  + `browser-store.ts`; edits `MainContent.tsx` (center-mode branch),
  `dashboard-store.ts` (one `browserOpen`/`showBrowser()` flag mirroring
  fileViewer), entry button. **Must not touch `src/main/` or `src/preload/`** —
  consumes the frozen contract (stub `window.api.browser` in vitest).
  Bounds via ResizeObserver→throttled setBounds; `setVisible(false)` suspension
  for overlays (z-order hazard: WebContentsView paints ABOVE renderer DOM).
- **The IPC contract between them is FROZEN** (quoted in full in the tasks doc
  §WP1-A). Any change requires BOTH workers + a progress-log note.
- Both workers should append to the tasks doc's `## Progress log` (it's outside
  `.claude/`, safe to write) and end with `## Patch summary`.

## Gate G1 — FIRST HOUR after both WP1s merge + human restart

Human-run: in a `persist:user` tab, complete a **real Google sign-in** — no
`403 disallowed_useragent`, no "browser may not be secure"; restart app,
session persists. **Fail ladder:** (1) per-session `ses.setUserAgent`;
(2) CDP `Emulation.setUserAgentOverride` + userAgentMetadata brands;
(3) halt — pane ships, OAuth workload deferred. Also at G1: resize glue,
overlay suspension, permission-prompt silent-deny, webPreferences inspection.

After G1 → WP2-A (CDP driver+policy) ∥ WP2-B (API routes+MCP tools), gate G2 =
gws OAuth end-to-end. Then WP3 (planning surface), gate G3 = clickjack drill.

## Ops cautions (hard-won, do not skip)

1. **EventBridge cross-workspace drain bug (HIGH, unfixed)** —
   `docs/BUG_event-bridge-cross-workspace-drain.md`. With other workspaces
   active, worker idle events can be delivered to the WRONG supervisor. **Pair
   every worker send with a background poll** (`curl /api/agents` loop — now
   needs the token, or just re-check `list_agents` periodically); never trust
   event delivery alone.
2. **Handshake discipline:** read the HANDSHAKE OK/UNCONFIRMED/FAILED result of
   every `send_message_to_agent`/`launch_agent` before ending your turn; on
   FAILED recover in the same turn (read log → `send_keys_to_agent enter` →
   relaunch).
3. **Context management:** don't compact a near-done worker — let it reach its
   gate if under ~90%. Successors get briefed "verify on-disk state, don't
   rewrite" (this saved WP0 twice).
4. **Never run `npm run restart`** yourself — kills the live app + all
   sessions. Human restarts at gates.
5. **Retired agents — do NOT reuse:** all 3 WP0 workers (`27a921af`,
   `5cf2105d`, `9457ad72` — last one holds the WP0 patch summary, idle @28%),
   canvas spike worker `a171b500`, reviewers `5c49d437`/`a5f7c9e1`, planners
   `931c5913`/`917372f7`/`6c90940f`. Launch fresh workers for WP1.
6. **Windows quoting:** multi-word args to node launches via Bash (`bash -lc`),
   never PowerShell `Start-Process -ArgumentList`. Verify with
   `Get-CimInstance Win32_Process` CommandLine.

## Parallel workstream (don't collide)

**Markdown canvas** also passed its gate (human dogfooded the WYSIWYG beta
2026-06-11, "feels great") — its WP1-A ∥ WP1-B (mode model / editor+save) are
launchable per `docs/MARKDOWN_CANVAS_TASKS.md`. Human chose to do the browser
first. If both run concurrently later, watch the shared renderer files:
browser WP1-B owns `MainContent.tsx` + a `dashboard-store.ts` flag; canvas
WP1-A owns `FileContentArea.tsx`/`FileViewerHeader.tsx` + its own
`dashboard-store.ts` mode union — the store file is the collision point;
sequence those two edits or give one worker both diffs.

## Open items carried forward

- `docs/` + `plans/` gitignored → the whole plan paper-trail is uncommitted-
  by-design(?) — flagged to human 2026-06-09, still undecided.
- claude.json corruption mitigation is live but its verification plan
  (V1–V5, 10× relaunch soak etc.) hasn't been formally run — passive watch.
- Loopback-only API bind = deferred defense-in-depth (user kept `0.0.0.0`).
- `api-server.ts` errno allowlist is comment-contract only (no test seam).
- V2 supervisor-dashboard migration (Phases A/A′ ready) is PAUSED behind these
  two feature workstreams — see `memory/handoff-2026-06-09-prep-wave-done.md`.
