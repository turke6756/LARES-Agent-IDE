# Two active plans: Markdown Canvas + Embedded Browser (snapshot 2026-06-11)

Both plans live in `docs/` (NOT `plans/` — and note both `docs/` and `plans/`
are gitignored, so the paper trail is uncommitted-by-design; flagged to human
2026-06-09).

---

## 1. Markdown WYSIWYG Canvas — `docs/MARKDOWN_CANVAS_PLAN.md` (v3.1)

**Idea:** kill the view/edit split for markdown in the file viewer — one
Word-like WYSIWYG surface (Milkdown + Crepe, exact pins `@milkdown/{crepe,kit}@7.21.2`),
markdown stays source of truth on disk, saves are **diff-spliced** so untouched
top-level blocks stay byte-identical (no whole-file normalization diffs).
Future scopes (not v1): live agent-edit streaming as ProseMirror transactions
(Phase 3), comments/canvas loop routed to agents (Phase 4).

**Status:** scope confirmed (v1 only = Phases 0–2). **WP0 spike ✅ COMPLETE
2026-06-11** — Gate 1 GREEN (52 splice tests, full §6.4 fixture matrix),
headless Gate 2 probes done (`WYSIWYG_MAX_BYTES = 200KB` exclusion from the
large-doc probe; KaTeX fonts pass). **Blocked on [human gate]: app restart +
dogfood with the `fileviewer.wysiwygBeta` localStorage toggle.** On pass →
launch fresh WP1-A (mode-model shell) ∥ WP1-B (editor + save path) workers.

**Associated files/folders:**
- `docs/MARKDOWN_CANVAS_PLAN.md` — the plan (v3.1, decision log §10)
- `docs/MARKDOWN_CANVAS_TASKS.md` — worker-assignable work breakdown
  (WP0→WP1-A/B/C→WP2, file-ownership table, worker conventions, progress log)
- `docs/reviews/markdown-canvas-spike-report.md` — spike findings; **§3 has two
  splice design corrections WP1-B's launch prompt must cite**
- `docs/reviews/large-doc-probe-results.md` — Crepe ~17ms/KB headless create
- `plans/reviews/markdown-canvas-plan-v2-review-codex.md` — Codex review of v2
  (refuted "reuse saveTab verbatim" → three-mode state model; narrowed splice
  guarantee)
- Spike deliverables (uncommitted) in `src/renderer/components/fileviewer/`:
  `markdownSplice.ts`(+tests incl. `sniffWysiwygCompatibility`),
  `MilkdownEditor.tsx`(+StrictMode test), `wysiwygBeta.ts`,
  `markdownCanvasLargeDocProbe.test.ts`, plus root `vitest.config.ts` +
  `npm run test:renderer`. npm override `@codemirror/search: 6.5.11` (drop when
  CodeMirror pins upgrade).

---

## 2. Embedded Browser + Planning Surface — `docs/EMBEDDED_BROWSER_AND_PLANNING_SURFACE_PLAN.md`

**Idea:** three capabilities on one foundation: (1) a real tabbed Chromium
browser pane inside the dashboard (Electron *is* Chromium 146); (2) agents
drive it via new dashboard MCP tools (`browser_open_url`, `read_page`, etc.)
backed by `webContents.debugger` CDP — a11y-tree-first, every action returns
new page state; (3) agent-authored HTML rendered as an interactive planning
surface via the **MCP Apps standard (SEP-1865, ratified 2026-01-26)** in a
sandboxed iframe with an allowlisted postMessage vocabulary.

**Motivating workload:** one-click Google OAuth for `gws auth login` — human
stays signed into Google in the pane (`persist:user` partition), agent opens
the consent URL, human clicks Allow, loopback completes. Load-bearing detail:
**user-agent override** to a byte-exact Chrome-146 UA (strip `Electron/` token)
to pass Google's embedded-browser gates; set via `app.userAgentFallback` at
startup (open Electron bug #47979 on WebContentsView overrides).

**Status:** **IMPLEMENTATION-READY as of 2026-06-11** (two GroupThinks complete —
see MEMORY.md entry). Safety spec → `plans/embedded-browser-safety-deepdive.md`
(M1–M16, day-one/defer gating); worker breakdown →
`plans/embedded-browser-implementation-tasks.md` (WP0 API-hardening prereq →
WP1/2/3, file ownership, [worker]/[human gate] splits). **Key reframe:** the
existing dashboard API is already an unauth host-RCE surface (0.0.0.0 + no-auth +
CORS* + RCE routes + globally-disabled localhost protection), so **API hardening
(WP0) is a Phase-1 day-one PREREQUISITE that BLOCKS all pane work.** Next action:
human go to launch WP0 (single worker, ~1 day).
Original build order: Phase 1 browser pane (~1 day; first-hour gate = UA override passes
real Google sign-in) → Phase 2 agent browser tools (~1 day; gws OAuth as first
workload) → Phase 3 planning surface (~1–2 days). Key architecture decisions:
`WebContentsView` per tab (NOT `<webview>`), CDP not `sendInputEvent`, two
session partitions (`persist:user` / `persist:agent`), never attach CDP to the
Google sign-in tab. Day-one security framing: "lethal trifecta" — agent HTML
only ever renders in a sandboxed separate-origin iframe; destructive
confirmations in native chrome.

**Associated files/folders:**
- `docs/EMBEDDED_BROWSER_AND_PLANNING_SURFACE_PLAN.md` — the plan (incl. §12
  source links)
- `experiments/2026-06-09-html-reliability/` — HTML-emission reliability
  benchmark (87/90 pass across claude/codex/gemini) relevant to the planning
  surface's agent-writes-HTML premise (originally run for the V2 plan-surface
  §14.1 gate; results.md + results.json + prompts + score.js)
- Adjacent (the planning-surface idea overlaps the V2 plan-surface workstream):
  `docs/INTERACTIVE_PLAN_SURFACE_PROPOSAL.md`,
  `docs/PLAN_SURFACE_PROVENANCE_REVISION.md`,
  `plans/plan-surface-disclosure-revision-2026-06-08.md`

---

**Relationship/sequencing note:** the two plans are independent workstreams —
canvas is mid-implementation (WP0 done, gated on human dogfood); browser is
pre-implementation awaiting a human go. Both touch the renderer; the browser
plan's Phase 1 is main-process-heavy so they can run in parallel if staffed
with the usual file-ownership discipline.
