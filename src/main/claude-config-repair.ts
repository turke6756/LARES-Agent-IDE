// Startup validate + repair of ~/.claude.json — the universal backstop for
// the shared-config corruption documented in
// plans/claude-json-corruption-mitigation-v2.md (Task 3). Covers hard kills
// (`taskkill /F`, `concurrently -k` in `npm run dev`) and collisions from
// Claude sessions the dashboard doesn't manage — paths the shutdown drain
// (Task 5) can never reach. Runs in app.whenReady before AgentSupervisor is
// constructed, i.e. before anything can spawn claude.exe.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { getActiveAgents } from './database';
import { windowsToWslPath } from './path-utils';

export interface RepairResult {
  action: 'valid' | 'truncated' | 'grafted' | 'restored' | 'unrepairable';
  content?: string;   // canonical repaired JSON when action is a repair
  detail?: string;    // human-readable note for logging
}

function tryParse(s: string): boolean {
  try { JSON.parse(s); return true; } catch { return false; }
}

/** Pull the byte offset out of a V8 JSON.parse error message
 *  ("... in JSON at position N (line L column C)"). Some message shapes
 *  ("Unexpected token 'x', ... is not valid JSON") carry no position —
 *  callers must handle null. */
function extractErrorPosition(s: string): number | null {
  try {
    JSON.parse(s);
    return null;
  } catch (err) {
    const m = String(err instanceof Error ? err.message : err).match(/at position (\d+)/);
    return m ? Number(m[1]) : null;
  }
}

/** JSON.parse accepts duplicate keys last-wins, so every repair re-serializes
 *  through parse→stringify: the output is guaranteed duplicate-free even when
 *  a graft lands the same key in both prefix and tail. A material length
 *  shrink vs. the pre-canonical text is the telltale that duplicates (not
 *  just whitespace) were dropped — surface it in `detail` for the log. */
const CANONICAL_DELTA_TELLTALE_BYTES = 64;

function makeRepair(
  action: 'truncated' | 'grafted' | 'restored',
  text: string,
  detail: string,
): RepairResult {
  const canonical = JSON.stringify(JSON.parse(text));
  const delta = text.length - canonical.length;
  if (Math.abs(delta) > CANONICAL_DELTA_TELLTALE_BYTES) {
    detail += `; canonicalization changed length by ${-delta} bytes (duplicate-key telltale)`;
  }
  return { action, content: canonical, detail };
}

/** `backups` newest-first; each entry is raw file text (may be invalid —
 *  non-parsing entries are skipped). Pure — no fs access; see
 *  validateAndRepairClaudeJson for the I/O wrapper. */
export function repairClaudeJsonContent(s: string, backups: string[]): RepairResult {
  // 1. Already valid.
  if (tryParse(s)) return { action: 'valid' };

  const errPos = extractErrorPosition(s);

  // 2. Trailing garbage: a valid document followed by junk (the tail of an
  //    older, longer file that a shorter rewrite failed to truncate).
  if (errPos !== null) {
    const prefix = s.slice(0, errPos).trim();
    if (prefix.length > 0 && tryParse(prefix)) {
      return makeRepair('truncated', prefix, `truncated trailing garbage at position ${errPos} (dropped ${s.length - errPos} bytes)`);
    }
  } else {
    // No position in the error message: scan backwards for the last `}` whose
    // prefix parses, bounded to ~200 candidates.
    let idx = s.lastIndexOf('}');
    for (let i = 0; i < 200 && idx !== -1; i++, idx = s.lastIndexOf('}', idx - 1)) {
      const prefix = s.slice(0, idx + 1).trim();
      if (tryParse(prefix)) {
        return makeRepair('truncated', prefix, `truncated at last parseable '}' (offset ${idx}, dropped ${s.length - idx - 1} bytes)`);
      }
    }
  }

  const validBackups = backups.filter(tryParse);

  // 3. Splice graft: keep the newest prefix of the corrupted file up to a
  //    top-of-key boundary at/before the error position, and complete it with
  //    the same key's tail from the newest valid backup. Candidate keys are
  //    tried last-first (bounded) because the error position is sometimes
  //    unavailable and a single candidate can produce a non-parsing merge.
  const keyRe = /"[^"\\]+"\s*:/g;
  const bound = errPos ?? s.length;
  const candidates: { start: number; name: string }[] = [];
  for (let m = keyRe.exec(s); m !== null; m = keyRe.exec(s)) {
    if (m.index > bound) break;
    candidates.push({ start: m.index, name: m[0].slice(1, m[0].lastIndexOf('"')) });
  }
  let attempts = 0;
  for (let c = candidates.length - 1; c >= 0 && attempts < 50; c--) {
    const { start, name } = candidates[c];
    for (const backup of validBackups) {
      if (attempts++ >= 50) break;
      const backupKeyRe = new RegExp(`"${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:`, 'g');
      let backupKeyIdx = -1;
      for (let bm = backupKeyRe.exec(backup); bm !== null; bm = backupKeyRe.exec(backup)) {
        backupKeyIdx = bm.index;
      }
      if (backupKeyIdx === -1) continue;
      const merged = s.slice(0, start) + backup.slice(backupKeyIdx);
      if (tryParse(merged)) {
        return makeRepair('grafted', merged, `grafted backup tail at key "${name}" (kept ${start} prefix bytes)`);
      }
    }
  }

  // 4. Wholesale restore from the newest valid backup.
  if (validBackups.length > 0) {
    return makeRepair('restored', validBackups[0], 'restored newest valid backup wholesale');
  }

  // 5. Nothing to restore from.
  return { action: 'unrepairable', detail: 'no repair mode succeeded and no valid backup available' };
}

// ── I/O wrapper ──────────────────────────────────────────────────────────────

/** Synchronous sleep — this runs once at startup, before any agent can spawn,
 *  and only blocks when the config is already invalid. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Newest-first raw texts of parseable backups, read lazily: stop after
 *  `want` valid ones (graft fallback rarely needs more), cap total reads. */
function readValidBackups(backupsDir: string, want = 3, maxReads = 20): string[] {
  const out: string[] = [];
  let files: { p: string; mtime: number }[];
  try {
    files = fs.readdirSync(backupsDir)
      .filter(f => f.startsWith('.claude.json.backup.'))
      .map(f => {
        const p = path.join(backupsDir, f);
        return { p, mtime: fs.statSync(p).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return out;
  }
  for (const { p } of files.slice(0, maxReads)) {
    try {
      const text = fs.readFileSync(p, 'utf-8');
      if (tryParse(text)) out.push(text);
      if (out.length >= want) break;
    } catch { /* unreadable backup — skip */ }
  }
  return out;
}

export function validateAndRepairClaudeJson(): void {
  // A repair bug must never block app startup.
  try {
    const home = process.env.USERPROFILE || process.env.HOME || '';
    const claudeJsonPath = path.join(home, '.claude.json');
    if (!fs.existsSync(claudeJsonPath)) return; // fresh install; Claude creates it

    let text = fs.readFileSync(claudeJsonPath, 'utf-8');
    if (tryParse(text)) return;

    // Read-stability check: an external claude.exe may be mid-flush. Repair
    // only when two reads 500 ms apart are still invalid AND byte-identical;
    // if the bytes are churning, re-check once, then log and skip (Claude's
    // own corrupted-config flow is the status-quo fallback).
    sleepSync(500);
    let reread = fs.readFileSync(claudeJsonPath, 'utf-8');
    if (tryParse(reread)) {
      console.log('[config-repair] ~/.claude.json was invalid but an external writer fixed it — skipping');
      return;
    }
    if (reread !== text) {
      sleepSync(500);
      const third = fs.readFileSync(claudeJsonPath, 'utf-8');
      if (tryParse(third)) {
        console.log('[config-repair] ~/.claude.json was invalid but an external writer fixed it — skipping');
        return;
      }
      if (third !== reread) {
        console.warn('[config-repair] ~/.claude.json is invalid but still being written by an external process — skipping repair');
        return;
      }
      reread = third;
    }
    text = reread;

    const backupsDir = path.join(home, '.claude', 'backups');
    const result = repairClaudeJsonContent(text, readValidBackups(backupsDir));

    if (result.action === 'valid') return; // re-read parsed after all
    if (result.action === 'unrepairable' || result.content === undefined) {
      console.error(`[config-repair] ~/.claude.json is corrupted and UNREPAIRABLE: ${result.detail ?? 'no detail'} — leaving file untouched`);
      return;
    }

    // Stash the corrupted original before overwriting.
    fs.mkdirSync(backupsDir, { recursive: true });
    const stash = path.join(backupsDir, `.claude.json.corrupted.dashboard.${Date.now()}`);
    fs.copyFileSync(claudeJsonPath, stash);

    // Atomic replace — same tmp+rename pattern as ensureClaudeProjectTrust.
    const tmp = `${claudeJsonPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, result.content);
    fs.renameSync(tmp, claudeJsonPath);
    console.log(`[config-repair] ~/.claude.json repaired (${result.action}): ${result.detail ?? ''} — original stashed at ${stash}`);
  } catch (err) {
    console.error('[config-repair] repair attempt failed (startup continues):', err);
  }
}

/** WSL variant — thin, restore-only (no graft mode). The distro keeps its own
 *  ~/.claude.json; only relevant when WSL agents exist. */
export function validateAndRepairWslClaudeJson(): void {
  try {
    if (!getActiveAgents().some(a => a.tmuxSessionName)) return;

    const text = execFileSync(
      'wsl.exe',
      ['bash', '-lc', 'cat "$HOME/.claude.json" 2>/dev/null || true'],
      { encoding: 'utf-8', timeout: 8000, maxBuffer: 64 * 1024 * 1024 },
    );
    if (text.trim().length === 0) return; // missing — fresh distro
    if (tryParse(text)) return;

    // Stash the corrupted original in-distro before touching it.
    const stamp = Date.now();
    execFileSync(
      'wsl.exe',
      ['bash', '-lc', `mkdir -p "$HOME/.claude/backups" && cp "$HOME/.claude.json" "$HOME/.claude/backups/.claude.json.corrupted.dashboard.${stamp}"`],
      { timeout: 8000 },
    );

    const listing = execFileSync(
      'wsl.exe',
      ['bash', '-lc', 'ls -t "$HOME/.claude/backups/".claude.json.backup.* 2>/dev/null || true'],
      { encoding: 'utf-8', timeout: 8000 },
    );
    const backupPaths = listing.split('\n').map(l => l.trim()).filter(Boolean);

    for (const backupPath of backupPaths.slice(0, 20)) {
      const backupText = execFileSync(
        'wsl.exe',
        ['bash', '-lc', `cat '${backupPath}' 2>/dev/null || true`],
        { encoding: 'utf-8', timeout: 8000, maxBuffer: 64 * 1024 * 1024 },
      );
      if (!tryParse(backupText)) continue;
      // Canonical re-serialization (duplicate-key scrub), then write via a
      // Windows stage file + in-distro atomic mv — the Task 1 pattern.
      const canonical = JSON.stringify(JSON.parse(backupText));
      const stage = path.join(os.tmpdir(), `.claude-repair-stage-${process.pid}.json`);
      fs.writeFileSync(stage, canonical);
      try {
        const stageWsl = windowsToWslPath(stage);
        execFileSync(
          'wsl.exe',
          ['bash', '-lc', `cat '${stageWsl}' > "$HOME/.claude.json.tmp-$$" && mv "$HOME/.claude.json.tmp-$$" "$HOME/.claude.json"`],
          { timeout: 8000 },
        );
      } finally {
        try { fs.unlinkSync(stage); } catch { /* best effort */ }
      }
      console.log(`[config-repair] WSL ~/.claude.json restored from ${backupPath} — original stashed in-distro (.corrupted.dashboard.${stamp})`);
      return;
    }
    console.error('[config-repair] WSL ~/.claude.json is corrupted and UNREPAIRABLE: no valid backup in distro — leaving file untouched');
  } catch (err) {
    console.error('[config-repair] WSL repair attempt failed (startup continues):', err);
  }
}

// ── Runtime repair watcher (v3) ──────────────────────────────────────────────
// validateAndRepairClaudeJson() above runs ONCE at startup (sync, BLOCKING
// sleepSync gate, pre-supervisor) — it cannot be re-driven on a timer without
// freezing the main loop, and it structurally cannot heal corruption the
// reconcile() herd manufactures ~1 min into the SAME session. This section adds
// an app-lifetime, reentrant variant with a NON-BLOCKING wait/gate (the rare
// repair disk I/O — backup reads, stash, atomic write — remains SYNC and
// bounded, running only after stable-invalid detection). Reuses the same pure
// repairClaudeJsonContent() + readValidBackups(). See
// plans/claude-json-corruption-v3-runtime-repair-IMPL.md.

/** Env-validated integer ms — rejects NaN / below-min so a bad override can't
 *  feed 0/NaN into setInterval. */
function envMs(name: string, fallback: number, min: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

const RUNTIME_POLL_MS = envMs('DASHBOARD_CLAUDE_REPAIR_POLL_MS', 30_000, 5_000);
const RUNTIME_FSWATCH_DEBOUNCE_MS = 2_000;   // fixed
const RUNTIME_REPAIR_COOLDOWN_MS = 10_000;   // fixed (≥ claude's observed multi-second write window)
const RUNTIME_STABILITY_GATE_MS = 500;       // fixed (matches the proven startup gate)

export type RuntimeStepOutcome =
  | 'inflight' | 'cooldown' | 'missing' | 'healthy'
  | 'healed-externally' | 'churning' | 'unrepairable' | 'repaired';

export interface RuntimeRepairState { inFlight: boolean; lastRepairAt: number; }
export interface RuntimeRepairConfig { cooldownMs: number; gateMs: number; }

/** Injected I/O so the gate/cooldown/reentrancy logic is unit-testable without
 *  a real ~/.claude.json. read() returns null when the file is missing/unreadable. */
export interface RuntimeRepairIO {
  read(): Promise<string | null>;
  sleep(ms: number): Promise<void>;
  loadBackups(): string[];
  /** stash the EXACT bytes passed as corruptedText, then atomic-write content */
  applyRepair(corruptedText: string, content: string, stamp: number): void;
  now(): number;
}

/** One reentrant validate+repair pass. Non-blocking wait/gate; all side effects
 *  go through `io`. Returns a discriminated outcome for tests. */
export async function runtimeRepairStep(
  io: RuntimeRepairIO,
  state: RuntimeRepairState,
  cfg: RuntimeRepairConfig,
): Promise<RuntimeStepOutcome> {
  if (state.inFlight) return 'inflight';                                   // poll vs fs.watch overlap
  if (io.now() - state.lastRepairAt < cfg.cooldownMs) return 'cooldown';   // post-repair backoff
  state.inFlight = true;
  try {
    const text = await io.read();
    if (text === null) return 'missing';
    if (tryParse(text)) return 'healthy';            // common path: no write, no log

    // Non-blocking read-stability gate.
    await io.sleep(cfg.gateMs);
    let reread = await io.read();
    if (reread === null) return 'missing';
    if (tryParse(reread)) return 'healed-externally';
    if (reread !== text) {
      await io.sleep(cfg.gateMs);                     // bytes moved → a writer is mid-flush; one more settle
      const third = await io.read();
      if (third === null) return 'missing';
      if (tryParse(third)) return 'healed-externally';
      if (third !== reread) return 'churning';        // still being written → skip, try next tick
      reread = third;
    }

    // `reread` is invalid and was byte-stable across the last gate interval.
    const result = repairClaudeJsonContent(reread, io.loadBackups());
    if (result.action === 'valid') return 'healthy';  // re-parse coincidence
    if (result.action === 'unrepairable' || result.content === undefined) {
      console.error(`[config-repair] runtime: ~/.claude.json corrupted and UNREPAIRABLE: ${result.detail ?? 'no detail'}`);
      return 'unrepairable';
    }

    // FINAL compare-before-write gate — closes the TOCTOU window between the
    // stable read and the replace. Re-read immediately; only overwrite if the
    // bytes are STILL the exact invalid `reread` we computed the repair from.
    // If a writer resumed (now valid, or changed), stand down.
    const latest = await io.read();
    if (latest === null) return 'missing';
    if (tryParse(latest)) return 'healed-externally';
    if (latest !== reread) return 'churning';

    const stamp = io.now();
    io.applyRepair(latest, result.content, stamp);   // stash + write the EXACT gated bytes
    state.lastRepairAt = stamp;
    console.log(`[config-repair] runtime: ~/.claude.json repaired (${result.action}): ${result.detail ?? ''}`);
    return 'repaired';
  } finally {
    state.inFlight = false;
  }
}

let runtimeWatcher: {
  poll: NodeJS.Timeout;
  fsw?: fs.FSWatcher;
  timers: { debounce?: NodeJS.Timeout };
  state: RuntimeRepairState;
} | null = null;

/** Start the app-lifetime runtime repair watcher (Windows-first scope). The
 *  poll is the GUARANTEED backstop (heals any corruption within one interval);
 *  a PARENT-DIRECTORY fs.watch is the ~2 s accelerator (survives atomic
 *  replace / delete / recreate of the file, unlike a direct file watch).
 *  Idempotent. MUST be called before supervisor.reconcile() can respawn the
 *  herd. */
export function startClaudeJsonRuntimeWatcher(): void {
  if (process.platform !== 'win32') return;   // WSL is restore-only; Windows is the failure site
  if (runtimeWatcher) return;
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const claudeJsonPath = path.join(home, '.claude.json');
  const backupsDir = path.join(home, '.claude', 'backups');
  const state: RuntimeRepairState = { inFlight: false, lastRepairAt: 0 };
  const io: RuntimeRepairIO = {
    read: () => fs.promises.readFile(claudeJsonPath, 'utf-8').catch(() => null),
    sleep: (ms) => new Promise(r => setTimeout(r, ms)),
    loadBackups: () => readValidBackups(backupsDir),
    applyRepair: (corruptedText, content, stamp) => {
      fs.mkdirSync(backupsDir, { recursive: true });
      const stash = path.join(backupsDir, `.claude.json.corrupted.dashboard.${stamp}`);
      try { fs.writeFileSync(stash, corruptedText, 'utf-8'); } catch { /* best effort stash */ }
      const tmp = `${claudeJsonPath}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, content, 'utf-8');
      fs.renameSync(tmp, claudeJsonPath);            // atomic replace
    },
    now: () => Date.now(),
  };
  const cfg: RuntimeRepairConfig = { cooldownMs: RUNTIME_REPAIR_COOLDOWN_MS, gateMs: RUNTIME_STABILITY_GATE_MS };
  const timers: { debounce?: NodeJS.Timeout } = {};
  const run = () => void runtimeRepairStep(io, state, cfg)
    .catch(err => console.error('[config-repair] runtime step failed:', err));

  const poll = setInterval(run, RUNTIME_POLL_MS);

  // Parent-directory watch, filtered to .claude.json. Survives the file being
  // atomically replaced / deleted / recreated, which a direct file watch does
  // not on Windows. Poll remains the guaranteed correctness backstop.
  let fsw: fs.FSWatcher | undefined;
  try {
    fsw = fs.watch(home, (_event, filename) => {
      if (filename?.toString() !== '.claude.json') return;   // null/Buffer-safe; ignore other home churn
      if (timers.debounce) clearTimeout(timers.debounce);
      timers.debounce = setTimeout(run, RUNTIME_FSWATCH_DEBOUNCE_MS);
    });
    fsw.on('error', () => { /* lost the dir watch — poll backstop continues */ });
  } catch { /* fs.watch unsupported — poll-only */ }

  runtimeWatcher = { poll, fsw, timers, state };
  run(); // immediate kick: catch corruption between startup repair and watcher start
}

export function stopClaudeJsonRuntimeWatcher(): void {
  if (!runtimeWatcher) return;
  clearInterval(runtimeWatcher.poll);
  if (runtimeWatcher.timers.debounce) clearTimeout(runtimeWatcher.timers.debounce);
  try { runtimeWatcher.fsw?.close(); } catch { /* ignore */ }
  runtimeWatcher = null;
}
