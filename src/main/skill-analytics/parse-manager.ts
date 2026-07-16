// A6 — first-run backfill + `indexing` IPC contract (wp2b §5).
//
// ARCHITECTURE DECISION (§5.1 feasibility gate). The spec offers two drivers for the
// initial full-corpus backfill:
//   (a) a `worker_thread` with its own better-sqlite3 WAL connection, and
//   (b) the documented fallback: cooperative MAIN-THREAD chunking that yields
//       (`setImmediate`) between file batches, using the main connection.
// We SHIP (b). Rationale: better-sqlite3 is a native addon and loading it inside an
// Electron `worker_thread` requires the addon rebuilt for the worker context — a known
// sharp edge the spec explicitly calls out as a fallback trigger. Cooperative chunking
// gives the SAME guarantees this contract actually needs — per-file atomic cursor
// advance (§5.3, owned by parse-runner), single-writer discipline (§5.2 — main is the
// only writer), and the identical push+poll progress surface (§5.4) — while remaining
// fully unit-testable and verifiable without a native rebuild. The chunk core
// (`runIncrementalParse` over a stream slice with `skipStaleFinalize`) is written so a
// future `worker_thread` could drive the exact same call; only the yield mechanism and
// the connection would move. Predecessor #3 added parse-runner's `skipStaleFinalize`
// option FOR this driver: a window still open at a chunk boundary must not be
// prematurely truncated, so every chunk skips the stale pass and the manager runs ONE
// final stale-finalize over all still-open windows at the end.
//
// This module owns NO filesystem policy and NO Electron surface: the caller injects the
// stream list, `readNewLines`, a `statSize`, and an `onProgress` sink. Reads are strictly
// read-only; nothing here writes into ~/.claude/projects.

import {
  runIncrementalParse,
  PARSER_VERSION,
  type ParseDb,
  type ParseDeps,
  type IndexProgress,
} from './parse-runner';
import type { StreamMeta, TailRead } from './jsonl-scanner';

// §5.4 constants (spec-fixed).
export const STEADY_PARSE_MAX_MS = 75;
export const STEADY_PARSE_MAX_NEW_BYTES = 1_000_000;
export const PARSE_DEBOUNCE_MS = 2000;
// §5.1 fallback batch size — ≤ ~5k entries per chunk keeps a single cooperative slice bounded.
export const BATCH_FILES = 25;

// skill_analytics_meta keys (§1.6).
export const BACKFILL_COMPLETE_KEY = 'backfill_complete_at';
export const BACKFILL_VERSION_KEY = 'backfill_parser_version';

// The `indexing` IPC contract shape (§5.4). `ready:false` blocks nothing — the panel
// renders "indexing… N of M files" off `progress` and re-polls / listens for push.
export type IndexStatus =
  | { ready: false; status: 'indexing'; progress: IndexProgress }
  | { ready: true; stale?: boolean; status?: 'indexing' };

export interface ManagerDeps {
  db: ParseDb;
  /** Fresh stream list (dir walk). Re-derived per steady query so new sessions appear. */
  listStreams(): StreamMeta[];
  readNewLines(jsonlPath: string, byteOffset: number): TailRead;
  /** O(1) current byte size of a stream file (stat) for the tail estimate. */
  statSize(jsonlPath: string): number;
  knownSkills: Set<string>;
  resolveMcpToolset?: (toolName: string) => string | null;
  /** WP-2B — folds a launch cwd → its owning workspace (workspace-LEVEL). */
  resolveWorkspaceLineage?: ParseDeps['resolveWorkspaceLineage'];
  /** Push sink for `skill-analytics:index-progress` (renderer broadcast). */
  onProgress?: (p: IndexProgress) => void;
  nowMs?: () => number;               // injectable clock (tests)
  parserVersion?: number;             // override for tests
  /** Yield between chunks; defaults to setImmediate. Tests pass `(fn) => fn()` for sync drive. */
  scheduleYield?: (fn: () => void) => void;
}

function emptyProgress(): IndexProgress {
  return { filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0, rowsAdded: 0, currentFile: '' };
}

export class ParseManager {
  private running = false;
  private lastProgress: IndexProgress | null = null;
  private lastParseAtMs = 0;
  private backfillDone: Promise<void> | null = null;

  constructor(private deps: ManagerDeps) {}

  private now(): number {
    return this.deps.nowMs ? this.deps.nowMs() : Date.now();
  }
  private version(): number {
    return this.deps.parserVersion ?? PARSER_VERSION;
  }

  // ── skill_analytics_meta bookkeeping (§1.6) ──
  private getMeta(k: string): string | null {
    const row = this.deps.db.prepare(`SELECT v FROM skill_analytics_meta WHERE k = ?`).get(k);
    return row ? String(row.v) : null;
  }
  private setMeta(k: string, v: string): void {
    this.deps.db.prepare(`INSERT OR REPLACE INTO skill_analytics_meta (k, v) VALUES (?, ?)`).run(k, v);
  }

  /** Backfill is complete iff the marker is set AT the current parser_version (§5.3 rebuild trigger). */
  isBackfillComplete(): boolean {
    if (this.getMeta(BACKFILL_COMPLETE_KEY) == null) return false;
    return Number(this.getMeta(BACKFILL_VERSION_KEY)) === this.version();
  }

  /** Resolves when any in-flight backfill finishes (tests await this after a sync-yield drive). */
  whenBackfillDone(): Promise<void> {
    return this.backfillDone ?? Promise.resolve();
  }

  isRunning(): boolean {
    return this.running;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // The query entrypoint — every panel query calls this FIRST (§5.4).
  // ─────────────────────────────────────────────────────────────────────────
  ensureIndexed(): IndexStatus {
    if (!this.isBackfillComplete()) {
      this.startBackfill();
      // Immediate return; NO full-corpus parse runs synchronously on this call.
      return { ready: false, status: 'indexing', progress: this.lastProgress ?? emptyProgress() };
    }

    // Steady state. Debounce rapid successive panel queries (§5.4).
    const now = this.now();
    if (now - this.lastParseAtMs < PARSE_DEBOUNCE_MS) return { ready: true };

    const tailBytes = this.estimateTailBytes();
    if (tailBytes > STEADY_PARSE_MAX_NEW_BYTES) {
      // Large tail → offload to the chunked driver; serve the (now stale) index meanwhile.
      this.startBackfill();
      return { ready: true, stale: true, status: 'indexing' };
    }

    // Small tail → parse synchronously on main within budget (§5.5). Stale-finalizes too.
    runIncrementalParse(this.baseDeps(this.deps.listStreams(), /*skipStale*/ false));
    this.lastParseAtMs = this.now();
    return { ready: true };
  }

  /** Pollable status without triggering a parse (mounts mid-backfill; §5.4 poll surface). */
  status(): IndexStatus {
    if (this.isBackfillComplete() && !this.running) return { ready: true };
    return { ready: false, status: 'indexing', progress: this.lastProgress ?? emptyProgress() };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Cooperative chunked backfill (the §5.1 fallback driver)
  // ─────────────────────────────────────────────────────────────────────────
  startBackfill(): void {
    if (this.running) return;
    this.running = true;
    // Swallow rejections at the boundary; a failed/killed backfill leaves cursors partial
    // and resumes on the next query (per-file atomicity, §5.3). whenBackfillDone() must
    // therefore always RESOLVE — callers await readiness, not success.
    this.backfillDone = this.runBackfillChunked()
      .catch(() => undefined)
      .finally(() => {
        this.running = false;
      });
  }

  private yield(): Promise<void> {
    const sched = this.deps.scheduleYield ?? ((fn: () => void) => setImmediate(fn));
    return new Promise<void>((resolve) => sched(resolve));
  }

  private async runBackfillChunked(): Promise<void> {
    // Snapshot the corpus at start (a stable work-list for this pass).
    const streams = this.deps.listStreams();
    const filesTotal = streams.length;
    const bytesTotal = streams.reduce((a, s) => a + this.safeStat(s.jsonlPath), 0);

    // Publish an initial 0-of-N so a panel mounting on this synchronous prefix sees real totals.
    this.lastProgress = { ...emptyProgress(), filesTotal, bytesTotal };
    this.deps.onProgress?.(this.lastProgress);

    let filesBase = 0;
    let bytesBase = 0;
    let rowsBase = 0;

    for (let i = 0; i < streams.length; i += BATCH_FILES) {
      // Yield FIRST so the initiating `ensureIndexed()` returns before any batch runs.
      await this.yield();
      const batch = streams.slice(i, i + BATCH_FILES);
      let batchBytes = 0;
      const res = runIncrementalParse({
        ...this.baseDeps(batch, /*skipStale*/ true),
        onProgress: (p) => {
          batchBytes = p.bytesDone;
          this.lastProgress = {
            filesDone: filesBase + p.filesDone,
            filesTotal,
            bytesDone: bytesBase + p.bytesDone,
            bytesTotal,
            rowsAdded: rowsBase + p.rowsAdded,
            currentFile: p.currentFile,
          };
          this.deps.onProgress?.(this.lastProgress);
        },
      });
      filesBase += batch.length;
      bytesBase += batchBytes;
      rowsBase += res.rowsAdded;
    }

    // ONE final stale-finalize over every still-open window (§5.1 — chunks skipped it).
    runIncrementalParse(this.baseDeps([], /*skipStale*/ false));

    // Mark complete at the current parser_version (kill-resume: never set on a partial run).
    const done = this.now();
    this.setMeta(BACKFILL_COMPLETE_KEY, String(done));
    this.setMeta(BACKFILL_VERSION_KEY, String(this.version()));
    this.lastParseAtMs = done;
    this.lastProgress = {
      filesDone: filesTotal,
      filesTotal,
      bytesDone: bytesTotal,
      bytesTotal,
      rowsAdded: rowsBase,
      currentFile: '',
    };
    this.deps.onProgress?.(this.lastProgress);
  }

  private baseDeps(streams: StreamMeta[], skipStaleFinalize: boolean) {
    return {
      db: this.deps.db,
      streams,
      readNewLines: this.deps.readNewLines,
      knownSkills: this.deps.knownSkills,
      resolveMcpToolset: this.deps.resolveMcpToolset,
      resolveWorkspaceLineage: this.deps.resolveWorkspaceLineage,
      parserVersion: this.version(),
      nowMs: this.deps.nowMs ? this.deps.nowMs() : undefined,
      skipStaleFinalize,
    };
  }

  // ── O(file count) tail estimate — stats only, no line reads (§5.4/§5.5) ──
  private estimateTailBytes(): number {
    const cur = this.deps.db.prepare(`SELECT byte_offset FROM skill_parse_cursors WHERE jsonl_path = ?`);
    let total = 0;
    for (const s of this.deps.listStreams()) {
      const size = this.safeStat(s.jsonlPath);
      const row = cur.get(s.jsonlPath);
      const off = row ? Number(row.byte_offset) : 0;
      if (size > off) total += size - off;
    }
    return total;
  }

  private safeStat(jsonlPath: string): number {
    try {
      return this.deps.statSize(jsonlPath);
    } catch {
      return 0;
    }
  }
}
