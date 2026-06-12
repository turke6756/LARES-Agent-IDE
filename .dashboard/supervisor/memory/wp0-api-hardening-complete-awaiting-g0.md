# WP0 (embedded-browser API hardening): ✅ SEALED — G0 PASSED 2026-06-11

**Status: G0 PASSED (2026-06-11, post-restart).** Human restarted the app and
all 5 checklist points verified: (1) notebooks run ✅ (renderer token path), (2)
supervisor MCP works ✅ (supervisor verified: unauth `GET /api/agents` → 401,
authed MCP call → data), (3) WSL-side agent used dashboard tools fine ✅ (token
crosses WSL boundary, 0.0.0.0 gateway bind serves), (4) media:// renders ✅,
(5) port-collision check skipped (optional). **WP0 is sealed; WP1-A ∥ WP1-B are
the next launch.** Code still UNCOMMITTED on `54519bf` as of seal time.

## What WP0 is
The Phase-1 day-one prerequisite from
`plans/embedded-browser-implementation-tasks.md` — closes the pre-existing
**unauthenticated host-RCE** surface (`0.0.0.0:24678`, no auth, CORS `*`,
kernel-exec/PTY/agent-launch routes) before any browser-pane code lands.
Implements safety-spec mitigations **M1 (API auth), M8 (CORS allowlist +
media:// confinement), M4 (webContents guard seam)** from
`plans/embedded-browser-safety-deepdive.md`. Those mitigations are LAW — the run
weakened none of them.

## How it was run (3 workers, 2 compactions — all same task, no work lost)
- `27a921af` "WP0 — API hardening" — created api-auth.ts + path-confinement.ts +
  webcontents-guard.ts, started api-server.ts/file-writer.ts. Compacted at 82%.
- `5cf2105d` "WP0 — API hardening (cont.)" — finished all wiring + token
  plumbing + tests; got the 35 new tests green; began fixing a pre-existing
  test broken by the auth gate. Compacted at 90%/93%.
- `9457ad72` "WP0 — verify + G0 summary" — ran full verification, found
  everything green (no fallout to fix on its run), wrote the G0 summary. Idle at
  28%. **This is the worker holding the authoritative summary** (read its last
  assistant chat for full detail).

Lesson reinforced: each stopped worker had progressed *further than the
files-touched snapshot showed at compaction time* — successors were briefed
"verify on-disk state, don't rewrite" and self-healed. Compacting a near-done
worker mid-build is wasteful; let it reach the gate if it has headroom (I held
one at 80% deliberately, only compacted when it crossed 90%).

## Verification (all green)
- `build:main` ✅ clean · `build:renderer` ✅ (pre-existing chunk-size warning only)
- `test:supervisor` ✅ ~36 suites / ~535 assertions / 0 fail — incl. **35 new**
  (13 api-auth incl. EADDRINUSE-retry-resolves-incremented-port; 22
  path-confinement incl. junction/symlink escape)
- `test:renderer` ✅ 52 passed, 1 pre-existing skip

## Files (for diff review)
- **Security core (new):** `src/main/security/api-auth.ts` (token mint + pure
  admission policy), `path-confinement.ts` (realpath root confinement, Win+WSL),
  `webcontents-guard.ts` (M4 seam, default predicate `()=>false` until WP1-A
  registers the browser manager). Refactored `src/main/file-writer.ts` to use it.
- **Wiring:** `src/main/api-server.ts` (admission gate before `route()`, CORS
  echo, promise-based `start()` resolving the actually-bound port),
  `src/main/index.ts` (M4 global `web-contents-created` guard + media://
  default-session-only registration).
- **Token plumbing:** `src/main/supervisor/index.ts` (7
  `AGENT_DASHBOARD_API_TOKEN` env sites ~lines 1900–2180); all 5 proxies
  (`scripts/mcp-supervisor.js`, `mcp-team.js`, `groupthink-v1.js`,
  `groupthink-v2.js`, `orchestration-spike.js` — each fails closed if the env
  var is absent); renderer chain (`ipc-handlers.ts` `system:get-api-token` →
  `preload/index.ts` → `shared/types.ts` → `useNotebookActions.ts` cached
  token-promise on fetch headers).
- **Tests (new):** `src/main/api-auth.test.ts`, `src/main/security/`
  path-confinement test, wired into `test:supervisor` in `package.json`.
- **Heads-up:** `src/main/supervisor/dashboard-host-injection.test.ts` (a
  *pre-existing* test) was touched by `5cf2105d` mid-run — legit auth-token
  update, not a regression; expect it in the diff alongside the new files.

## Key mechanics
- **Token (M1):** lazy crypto-random 32-byte base64url, stable per process,
  one instance shared by all distribution paths. `timingSafeEqual`, fail-closed
  (missing/wrong scheme/wrong length/mismatch → 401 on every route).
- **CORS (M8):** allowlist = `'null'` (file:// prod renderer) +
  localhost:5173/5174/5175 (Vite). Order: OPTIONS preflight → origin gate (403,
  beats token) → bearer (401). Origin echoed per-request, never `*`, never with
  credentials. Headless Node clients (no Origin) skip CORS, still need the token.
- **media:// (M8):** default session only; decoded paths through
  `resolveConfined()` vs open workspace roots (realpath kills `..` + symlink +
  junction escape → 404). No bypassCSP. WSL roots via cached `wslpath`.
- **start()/EADDRINUSE:** returns `Promise<number>` resolving the bound port read
  from `server.address()` after `'listening'` — no stale pre-retry port.
- **Bind:** `0.0.0.0` retained per user decision (WSL reaches via Windows
  gateway IP; token is the gate). Loopback-only is the deferred defense-in-depth
  upgrade the user explicitly chose NOT to pull into WP0.

## Documented residual gap (not a G0 blocker)
`api-server.ts:109` — the inline error serializer's errno-leak allowlist
(`API_ERROR_CODES`) is enforced by code-comment contract only, no unit-test seam.

## NEXT ACTIONS
1. **Human runs G0** (`npm run restart`, then): (1) open .ipynb + run a cell —
   output = renderer token path OK, 401 on `/api/kernel/...` = regression; (2)
   supervisor MCP tool call returns data (else proxy startup FATAL on missing
   token); (3) WSL-side agent uses a dashboard tool — proves token crosses the
   WSL boundary AND `0.0.0.0` gateway bind still serves; (4) media:// image/video
   renders; (5) optional: occupy 24678, confirm roll to 24679.
2. **On G0 pass → WP0 sealed.** Next go is **WP1-A (pane main-process) ∥ WP1-B
   (pane renderer UI)** — parallel after WP0, frozen IPC contract
   (`window.api.browser.createTab/closeTab/navigate/setActiveTab/setBounds/setVisible/onTabState/onOpenRequest`).
   First-hour G1 check: UA override passes a real Google sign-in.
3. **On G0 fail** → diagnose via the failing check's failure-mode (above), relaunch
   a fix worker scoped to that seam.
